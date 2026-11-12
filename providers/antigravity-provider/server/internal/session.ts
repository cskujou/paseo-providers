import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ProviderCatalog,
  ProviderCommand,
  ProviderConfigChanges,
  ProviderEvent,
  ProviderLaunch,
  ProviderMcpServerConfig,
  ProviderPermissionAction,
  ProviderPermissionResponse,
  ProviderPersistence,
  ProviderPrompt,
  ProviderRevertScope,
  ProviderSessionConfig,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { AntigravityUsage } from "../usage.js";
import {
  AcpClient,
  AntigravityError,
  formatDiagnostic,
  type AcpPermissionOutcome,
  type AcpPermissionRequestParams,
  type AcpSessionUpdateParams,
} from "./acp-client.js";
import {
  DEFAULT_MODES,
  DEFAULT_MODELS,
  THINKING_OPTIONS,
  normalizeSelection,
  validateSelection,
} from "./catalog.js";
import {
  RevertTokenSchema,
  SessionRewindTracker,
  readUserStepIndices,
} from "./rewind.js";
import {
  acpToolToTimelineItem,
  buildToolDetail,
  extractModifiedFilePaths,
  mergeAcpToolCall,
  type AcpToolCallState,
} from "./timeline.js";

const persistenceDataSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    model: z.string().optional(),
    mode: z.string().optional(),
    thinkingOption: z.string().optional(),
  })
  .refine((d) => Boolean(d.conversationId || d.sessionId), {
    message: "Expected conversationId or sessionId in Antigravity persistence",
  });

export function parsePersistenceConversationId(persistence?: ProviderPersistence): {
  conversationId: string | null;
  model?: string;
  mode?: string;
  thinkingOption?: string;
} {
  if (!persistence) return { conversationId: null };
  const parsed = persistenceDataSchema.safeParse(persistence.data);
  if (!parsed.success) {
    throw new AntigravityError("Invalid Antigravity persistence payload", "INVALID_PERSISTENCE");
  }
  return {
    conversationId: parsed.data.conversationId ?? parsed.data.sessionId ?? null,
    model: parsed.data.model,
    mode: parsed.data.mode,
    thinkingOption: parsed.data.thinkingOption,
  };
}

interface ActiveTurn {
  id: string;
  canceled: boolean;
}

interface PendingPermission {
  request: AcpPermissionRequestParams;
  resolve(outcome: AcpPermissionOutcome): void;
}

export interface SessionOptions {
  id: string;
  config: ProviderSessionConfig;
  launch: ProviderLaunch;
  catalog(): ProviderCatalog;
  persistence?: ProviderPersistence;
  history: "replay" | "skip";
  usage: AntigravityUsage;
  emit(event: ProviderEvent): void;
}

export class Session {
  private client: AcpClient | null = null;
  private config: ProviderSessionConfig;
  private conversationId: string | null;
  private readonly mergedEnv: Record<string, string>;
  private readonly rewindTracker: SessionRewindTracker;
  private activeTurn: ActiveTurn | null = null;
  private readonly toolCalls = new Map<string, AcpToolCallState>();
  private readonly messages = new Map<string, string>();
  private readonly fallbackChunkIds = new Map<string, string>();
  private chunkSequence = 0;
  private commands: ProviderCommand[] = [];
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private replayMode: "none" | "replay" | "skip" = "none";
  private replayUserStepIndices: number[] = [];
  private replayUserTurnCount = 0;
  private readonly bufferedReplayItems: ProviderTimelineItem[] = [];
  private restarting = false;
  private closed = false;

  constructor(private readonly options: SessionOptions) {
    const saved = parsePersistenceConversationId(options.persistence);
    this.conversationId = saved.conversationId;
    this.config = {
      ...options.config,
      model: options.config.model ?? saved.model ?? "gemini-4-carbon",
      mode: options.config.mode ?? saved.mode ?? "auto",
      thinkingOption: options.config.thinkingOption ?? saved.thinkingOption ?? "medium",
    };
    validateSelection(this.config, options.catalog());

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...options.launch.env, ...options.config.env })) {
      if (typeof v === "string") env[k] = v;
    }
    this.mergedEnv = env;
    this.rewindTracker = new SessionRewindTracker(this.config.cwd, this.mergedEnv);
  }

  async open(requestId: string, capabilities: readonly string[]): Promise<void> {
    const client = await this.startAcpClient(this.options.history);
    this.client = client;

    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.options.id,
      capabilities,
      restoration: "core",
      persistence: this.config.persist ? this.persistence() : undefined,
      cwd: this.config.cwd,
      title: this.config.title,
    });

    for (const item of this.bufferedReplayItems) {
      this.emitItem(item);
    }
    this.bufferedReplayItems.length = 0;

    if (this.config.persist && this.conversationId) {
      this.emit({
        type: "session.persistence",
        sessionId: this.options.id,
        persistence: this.persistence(),
      });
    }

    this.publishConfig();
    this.emit({
      type: "session.commands",
      sessionId: this.options.id,
      commands: this.commands,
    });
    this.emit({
      type: "session.ready",
      requestId,
      sessionId: this.options.id,
    });
  }

  canStopRuntime(): boolean {
    return (
      !this.closed &&
      !this.restarting &&
      this.activeTurn === null &&
      this.pendingPermissions.size === 0
    );
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closed) {
      throw new AntigravityError("Antigravity session is closed", "SESSION_CLOSED");
    }
    const client = await this.ensureClient();
    if (!this.conversationId) {
      throw new AntigravityError("Antigravity session has no conversation ID", "NO_CONVERSATION");
    }

    const { acpPrompt, displayText } = this.encodePrompt(prompt);

    if (this.activeTurn !== null) {
      if (prompt.delivery === "steer") {
        if (prompt.clearPendingPermissions) {
          this.cancelPendingPermissions();
        }
        const steerTurnId = this.activeTurn.id;
        this.emit({
          type: "session.prompt_result",
          sessionId: this.options.id,
          clientMessageId: prompt.clientMessageId,
          result: { type: "steer", turnId: steerTurnId },
        });
        void client
          .request(
            "session/prompt",
            {
              sessionId: this.conversationId,
              prompt: acpPrompt,
            },
            null,
          )
          .catch(() => {
            // Active turn handles final settlement
          });
        return;
      }
      throw new AntigravityError(
        "Antigravity already has an active turn; wait for it to finish or steer it",
        "TURN_ACTIVE",
      );
    }

    const revertToken = await this.rewindTracker.createTurnToken(
      this.conversationId,
      prompt.clientMessageId,
    );

    const turn: ActiveTurn = {
      id: randomUUID(),
      canceled: false,
    };
    this.activeTurn = turn;
    this.fallbackChunkIds.clear();

    this.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId: turn.id },
    });
    this.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: turn.id,
      state: "started",
    });
    this.emitItem({
      type: "user_message",
      id: prompt.clientMessageId,
      messageId: prompt.clientMessageId,
      clientMessageId: prompt.clientMessageId,
      text: displayText,
      revertToken,
    });

    try {
      const response = await client.request<Record<string, unknown>>(
        "session/prompt",
        {
          sessionId: this.conversationId,
          prompt: acpPrompt,
        },
        null,
      );
      if (this.activeTurn?.id !== turn.id) return;
      this.activeTurn = null;
      this.fallbackChunkIds.clear();
      const canceled = turn.canceled || response?.stopReason === "cancelled";
      this.finishRunningTools(canceled ? "canceled" : "completed");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.id,
        state: canceled ? "canceled" : "completed",
      });
    } catch (error) {
      if (this.activeTurn?.id !== turn.id) return;
      this.activeTurn = null;
      this.fallbackChunkIds.clear();
      const message = error instanceof Error ? error.message : String(error);
      const canceled = turn.canceled || /cancel|interrupt/i.test(message);
      this.finishRunningTools(canceled ? "canceled" : "failed");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.id,
        state: canceled ? "canceled" : "failed",
        ...(canceled ? {} : { error: { message: formatDiagnostic(message) } }),
      });
    }
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (changes.settings && Object.keys(changes.settings).length > 0) {
      throw new AntigravityError("Antigravity has no additional custom settings");
    }
    const nextConfig: ProviderSessionConfig = {
      ...this.config,
      model: changes.model === null ? "gemini-4-carbon" : (changes.model ?? this.config.model),
      mode: changes.mode === null ? "auto" : (changes.mode ?? this.config.mode),
      thinkingOption:
        changes.thinkingOption === null
          ? undefined
          : (changes.thinkingOption ?? this.config.thinkingOption),
    };
    const selection = validateSelection(nextConfig, this.options.catalog());
    this.config = {
      ...nextConfig,
      model: selection.baseModel,
      mode: selection.mode,
      thinkingOption: selection.thinkingOption,
    };

    if (this.client && this.conversationId) {
      await this.applySelectionToAcp(this.client, this.conversationId, selection);
    }

    this.publishConfig();
    if (this.config.persist && this.conversationId) {
      this.emit({
        type: "session.persistence",
        sessionId: this.options.id,
        persistence: this.persistence(),
      });
    }
  }

  answerPermission(permissionId: string, response: ProviderPermissionResponse): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new AntigravityError(`Permission request ${permissionId} is no longer pending`);
    }
    const options = pending.request.options;
    let selected =
      response.selectedActionId !== undefined
        ? options.find((opt) => opt.optionId === response.selectedActionId)
        : undefined;

    if (!selected) {
      selected = options.find((opt) =>
        response.behavior === "allow"
          ? opt.kind.startsWith("allow")
          : opt.kind.startsWith("reject") || !opt.kind.startsWith("allow"),
      );
    }

    this.pendingPermissions.delete(permissionId);
    pending.resolve({
      outcome: selected
        ? { outcome: "selected", optionId: selected.optionId }
        : { outcome: "cancelled" },
    });
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.options.id,
      permissionId,
    });
  }

  async revert(rawToken: JsonValue, scope: ProviderRevertScope): Promise<void> {
    if (!this.conversationId) {
      throw new AntigravityError("Cannot rewind session without an active conversation");
    }
    const parsedToken = RevertTokenSchema.parse(rawToken);

    if (this.activeTurn) {
      await this.interrupt();
    }

    if (scope === "files") {
      await this.rewindTracker.revertFiles(parsedToken);
      return;
    }

    this.restarting = true;
    try {
      if (this.client) {
        const oldClient = this.client;
        this.client = null;
        if (this.conversationId) {
          await oldClient
            .request("session/close", { sessionId: this.conversationId }, 1500)
            .catch(() => undefined);
        }
        await oldClient.close();
      }

      if (scope === "both") {
        await this.rewindTracker.revertFiles(parsedToken);
      }

      await this.rewindTracker.revertConversation(this.conversationId, parsedToken);

      this.client = await this.startAcpClient("skip");
    } finally {
      this.restarting = false;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurn || !this.client || !this.conversationId) return;
    this.activeTurn.canceled = true;
    this.cancelPendingPermissions();
    await this.client
      .request("session/cancel", { sessionId: this.conversationId }, 5000)
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelPendingPermissions();
    const client = this.client;
    this.client = null;
    if (client) {
      if (this.conversationId) {
        await client
          .request("session/close", { sessionId: this.conversationId }, 1000)
          .catch(() => undefined);
      }
      await client.close().catch(() => undefined);
    }
    if (this.activeTurn) {
      const turnId = this.activeTurn.id;
      this.activeTurn = null;
      this.finishRunningTools("canceled");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId,
        state: "canceled",
      });
    }
  }

  private async ensureClient(): Promise<AcpClient> {
    if (this.client) return this.client;
    this.client = await this.startAcpClient("skip");
    return this.client;
  }

  private async startAcpClient(historyMode: "replay" | "skip"): Promise<AcpClient> {
    const client = new AcpClient({
      launch: this.options.launch,
      cwd: this.config.cwd,
      env: this.mergedEnv,
      onSessionUpdate: (params) => this.handleSessionUpdate(params),
      onPermissionRequest: (params) => this.handlePermissionRequest(params),
      onExit: (error) => this.handleUnexpectedExit(error),
    });

    try {
      await client.initialize();
      const mcpServers = toAcpMcpServers(this.config.mcpServers);
      let sessionResponse: Record<string, unknown>;

      if (this.conversationId) {
        if (historyMode === "replay") {
          const { userStepIndices } = await readUserStepIndices(
            this.conversationId,
            this.mergedEnv,
          );
          this.replayUserStepIndices = userStepIndices;
          this.replayUserTurnCount = 0;
          this.bufferedReplayItems.length = 0;
        }
        this.replayMode = historyMode;
        try {
          if (historyMode === "skip") {
            try {
              sessionResponse = await client.request<Record<string, unknown>>(
                "session/resume",
                {
                  sessionId: this.conversationId,
                  cwd: this.config.cwd,
                  mcpServers,
                },
                20000,
              );
            } catch {
              sessionResponse = await client.request<Record<string, unknown>>(
                "session/load",
                {
                  sessionId: this.conversationId,
                  cwd: this.config.cwd,
                  mcpServers,
                },
                20000,
              );
            }
          } else {
            sessionResponse = await client.request<Record<string, unknown>>(
              "session/load",
              {
                sessionId: this.conversationId,
                cwd: this.config.cwd,
                mcpServers,
              },
              20000,
            );
          }
          await this.flushReplayUserChunk();
        } finally {
          this.replayMode = "none";
        }
      } else {
        const meta = this.config.systemPrompt
          ? { antigravity: { systemPrompt: { append: this.config.systemPrompt } } }
          : undefined;
        sessionResponse = await client.request<Record<string, unknown>>(
          "session/new",
          {
            cwd: this.config.cwd,
            mcpServers,
            ...(meta ? { _meta: meta } : {}),
          },
          20000,
        );
        const newId =
          typeof sessionResponse.sessionId === "string" ? sessionResponse.sessionId : null;
        if (!newId) {
          throw new AntigravityError("Antigravity ACP did not return a sessionId");
        }
        this.conversationId = newId;
      }

      this.recordTierFromSessionResponse(sessionResponse);
      const selection = normalizeSelection(this.config, this.options.catalog());
      await this.applySelectionToAcp(client, this.conversationId, selection);
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private recordTierFromSessionResponse(response: Record<string, unknown>): void {
    const meta =
      typeof response._meta === "object" && response._meta !== null
        ? (response._meta as Record<string, unknown>)
        : undefined;
    const agy =
      meta && typeof meta.antigravity === "object" && meta.antigravity !== null
        ? (meta.antigravity as Record<string, unknown>)
        : undefined;
    const tier =
      agy && typeof agy.tier === "object" && agy.tier !== null
        ? (agy.tier as Record<string, unknown>)
        : undefined;
    if (tier && typeof tier.name === "string") {
      this.options.usage.recordTier(
        this.mergedEnv,
        tier.name,
        typeof tier.id === "string" ? tier.id : undefined,
      );
    }
  }

  private async applySelectionToAcp(
    client: AcpClient,
    sessionId: string,
    selection: ReturnType<typeof normalizeSelection>,
  ): Promise<void> {
    await client
      .request(
        "session/set_config_option",
        {
          sessionId,
          configId: "model",
          value: selection.baseModel,
        },
        8000,
      )
      .catch(() => undefined);

    if (selection.thinkingOption) {
      await client
        .request(
          "session/set_config_option",
          {
            sessionId,
            configId: "thought_level",
            value: selection.thinkingOption,
          },
          8000,
        )
        .catch(() => undefined);
    }

    await client
      .request(
        "session/set_mode",
        {
          sessionId,
          modeId: selection.acpMode,
        },
        8000,
      )
      .catch(() => undefined);
  }

  private async handleSessionUpdate(params: AcpSessionUpdateParams): Promise<void> {
    if (this.conversationId && params.sessionId && params.sessionId !== this.conversationId) {
      return;
    }
    if (this.replayMode === "skip") {
      this.handleMetaSessionUpdate(params.update);
      return;
    }

    const update = params.update;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

    if (
      this.replayMode === "replay" &&
      kind !== "user_message_chunk" &&
      this.fallbackChunkIds.has("user_message_chunk")
    ) {
      await this.flushReplayUserChunk();
    }

    if (kind === "user_message_chunk") {
      if (this.replayMode !== "replay") {
        this.fallbackChunkIds.clear();
        return;
      }
      this.fallbackChunkIds.delete("agent_message_chunk");
      this.fallbackChunkIds.delete("agent_thought_chunk");
      const content =
        typeof update.content === "object" && update.content !== null
          ? (update.content as Record<string, unknown>)
          : {};
      if (content.type !== "text" || typeof content.text !== "string") return;
      const msgId = typeof update.messageId === "string" ? update.messageId : undefined;
      const id = this.resolveChunkId("user_message_chunk", msgId);
      const prev = this.messages.get(id) ?? "";
      this.messages.set(id, prev + content.text);
      return;
    }

    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      this.fallbackChunkIds.delete(
        kind === "agent_message_chunk" ? "agent_thought_chunk" : "agent_message_chunk",
      );
      const content =
        typeof update.content === "object" && update.content !== null
          ? (update.content as Record<string, unknown>)
          : {};
      if (content.type !== "text" || typeof content.text !== "string") return;
      const msgId = typeof update.messageId === "string" ? update.messageId : undefined;
      const id = this.resolveChunkId(kind, msgId);
      const text = `${this.messages.get(id) ?? ""}${content.text}`;
      this.messages.set(id, text);

      const item: ProviderTimelineItem =
        kind === "agent_message_chunk"
          ? {
              type: "assistant_message",
              id,
              messageId: msgId ?? id,
              text,
            }
          : {
              type: "reasoning",
              id,
              text,
            };
      this.recordOrEmitTimelineItem(item);
      return;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      if (kind === "tool_call") {
        this.fallbackChunkIds.clear();
      }
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "tool";
      const current = this.toolCalls.get(toolCallId);
      const merged = mergeAcpToolCall(update, current);
      this.toolCalls.set(merged.toolCallId, merged);

      if (merged.status === "pending" || merged.status === "in_progress") {
        for (const filePath of extractModifiedFilePaths(merged)) {
          await this.rewindTracker.recordFileBeforeModification(filePath);
        }
      }

      const item = acpToolToTimelineItem(merged);
      this.recordOrEmitTimelineItem(item);
      return;
    }

    if (kind === "plan") {
      this.fallbackChunkIds.clear();
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const item: ProviderTimelineItem = {
        type: "todo",
        id: "antigravity-plan",
        items: entries.map((entry, idx) => {
          const rec =
            typeof entry === "object" && entry !== null
              ? (entry as Record<string, unknown>)
              : {};
          const status = typeof rec.status === "string" ? rec.status : "pending";
          return {
            id: String(idx),
            text: typeof rec.content === "string" ? rec.content : "",
            completed: status === "completed",
            status:
              status === "completed" || status === "in_progress" || status === "pending"
                ? status
                : "pending",
          };
        }),
      };
      this.recordOrEmitTimelineItem(item);
      return;
    }

    this.handleMetaSessionUpdate(update);
  }

  private async flushReplayUserChunk(): Promise<void> {
    const id = this.fallbackChunkIds.get("user_message_chunk");
    if (!id) return;
    this.fallbackChunkIds.delete("user_message_chunk");
    const text = this.messages.get(id);
    if (!text || !this.conversationId) return;
    const turnIndex = this.replayUserTurnCount++;
    const revertToken = await this.rewindTracker.createReplayToken(
      this.conversationId,
      id,
      turnIndex,
      this.replayUserStepIndices,
    );
    this.bufferedReplayItems.push({
      type: "user_message",
      id,
      messageId: id,
      text,
      revertToken,
    });
  }

  private handleMetaSessionUpdate(update: Record<string, unknown>): void {
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "available_commands_update" && Array.isArray(update.availableCommands)) {
      this.commands = update.availableCommands
        .map((cmd): ProviderCommand | null => {
          const rec =
            typeof cmd === "object" && cmd !== null ? (cmd as Record<string, unknown>) : {};
          const name = typeof rec.name === "string" ? rec.name : "";
          if (!name) return null;
          const description = typeof rec.description === "string" ? rec.description : undefined;
          const inputRec =
            typeof rec.input === "object" && rec.input !== null
              ? (rec.input as Record<string, unknown>)
              : {};
          const argumentHint = typeof inputRec.hint === "string" ? inputRec.hint : undefined;
          return { name, description, argumentHint };
        })
        .filter((c): c is ProviderCommand => c !== null);
      this.emit({
        type: "session.commands",
        sessionId: this.options.id,
        commands: this.commands,
      });
      return;
    }

    if (kind === "current_mode_update" && typeof update.currentModeId === "string") {
      if (this.config.mode !== "full-access") {
        this.config = { ...this.config, mode: update.currentModeId };
        this.publishConfig();
      }
      return;
    }

    if (kind === "usage_update") {
      const used = typeof update.used === "number" ? update.used : undefined;
      const size = typeof update.size === "number" ? update.size : undefined;
      if (used !== undefined || size !== undefined) {
        this.emit({
          type: "session.usage",
          sessionId: this.options.id,
          turnId: this.activeTurn?.id,
          usage: {
            contextWindowUsedTokens: used,
            contextWindowMaxTokens: size,
          },
        });
      }
    }
  }

  private async handlePermissionRequest(
    request: AcpPermissionRequestParams,
  ): Promise<AcpPermissionOutcome> {
    const toolState = mergeAcpToolCall(request.toolCall);
    for (const filePath of extractModifiedFilePaths(toolState)) {
      await this.rewindTracker.recordFileBeforeModification(filePath);
    }

    const selection = normalizeSelection(this.config, this.options.catalog());
    if (selection.autoApproveAll) {
      const allowOpt =
        request.options.find((opt) => opt.kind === "allow_always") ??
        request.options.find((opt) => opt.kind.startsWith("allow")) ??
        request.options[0];
      if (allowOpt) {
        return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
      }
    }

    const toolCallId =
      typeof request.toolCall.toolCallId === "string"
        ? request.toolCall.toolCallId
        : randomUUID();
    const permissionId = `permission:${toolCallId}`;

    const actions: ProviderPermissionAction[] = request.options.map((opt) => ({
      id: opt.optionId,
      label: opt.name,
      behavior: opt.kind.startsWith("allow") ? "allow" : "deny",
    }));

    return await new Promise<AcpPermissionOutcome>((resolve) => {
      this.pendingPermissions.set(permissionId, { request, resolve });
      this.emit({
        type: "session.permission",
        sessionId: this.options.id,
        request: {
          id: permissionId,
          name: toolState.name ?? toolState.title ?? "Antigravity tool",
          kind: "tool",
          title: toolState.title,
          detail: buildToolDetail(toolState),
          actions,
        },
      });
    });
  }

  private handleUnexpectedExit(error: AntigravityError): void {
    if (this.closed || this.restarting) return;
    this.client = null;
    this.cancelPendingPermissions();
    if (this.activeTurn) {
      const turnId = this.activeTurn.id;
      this.activeTurn = null;
      this.finishRunningTools("failed");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId,
        state: "failed",
        error: { message: error.message, code: error.code, diagnostic: error.diagnostic },
      });
    } else {
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.options.id,
        error: { message: error.message, code: error.code, diagnostic: error.diagnostic },
      });
    }
  }

  private cancelPendingPermissions(): void {
    for (const [permissionId, pending] of this.pendingPermissions.entries()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.emit({
        type: "session.permission_resolved",
        sessionId: this.options.id,
        permissionId,
      });
    }
    this.pendingPermissions.clear();
  }

  private finishRunningTools(status: "completed" | "failed" | "canceled"): void {
    for (const [id, state] of this.toolCalls.entries()) {
      if (state.status !== "pending" && state.status !== "in_progress") continue;
      const nextStatus = status === "completed" ? "completed" : "failed";
      this.toolCalls.set(id, { ...state, status: nextStatus });
      const item = acpToolToTimelineItem(state);
      if (status === "failed") {
        this.emitItem({ ...item, status: "failed", error: "Antigravity turn failed" });
      } else {
        this.emitItem({ ...item, status, error: null });
      }
    }
  }

  private resolveChunkId(kind: string, messageId?: string): string {
    if (messageId) {
      this.fallbackChunkIds.delete(kind);
      return `${kind}:${messageId}`;
    }
    let id = this.fallbackChunkIds.get(kind);
    if (!id) {
      id = `${kind}:${++this.chunkSequence}`;
      this.fallbackChunkIds.set(kind, id);
    }
    return id;
  }

  private encodePrompt(prompt: ProviderPrompt): {
    acpPrompt: Record<string, unknown>[];
    displayText: string;
  } {
    if (prompt.input.type === "command") {
      const cmdText = `/${prompt.input.name}${prompt.input.arguments ? ` ${prompt.input.arguments}` : ""}`;
      return {
        acpPrompt: [{ type: "text", text: cmdText }],
        displayText: cmdText,
      };
    }

    const acpPrompt: Record<string, unknown>[] = [];
    const textParts: string[] = [];

    for (const part of prompt.input.content) {
      if (part.type === "text") {
        acpPrompt.push({ type: "text", text: part.text });
        textParts.push(part.text);
      } else if (part.type === "image") {
        acpPrompt.push({
          type: "image",
          data: part.data,
          mimeType: part.mimeType,
        });
      }
    }

    return {
      acpPrompt,
      displayText: textParts.join("\n"),
    };
  }

  private persistence(): ProviderPersistence {
    if (!this.conversationId) {
      throw new AntigravityError("Antigravity has no active conversation");
    }
    const selection = normalizeSelection(this.config, this.options.catalog());
    return {
      version: 1,
      data: {
        conversationId: this.conversationId,
        sessionId: this.conversationId,
        model: selection.baseModel,
        mode: selection.mode,
        ...(selection.thinkingOption ? { thinkingOption: selection.thinkingOption } : {}),
      },
    };
  }

  private publishConfig(): void {
    const catalog = this.options.catalog();
    const selection = normalizeSelection(this.config, catalog);
    const modelDescriptor =
      catalog.models.find((m) => m.id === selection.baseModel) ??
      DEFAULT_MODELS.find((m) => m.id === selection.baseModel);
    const thinkingOptions = modelDescriptor?.thinkingOptions ?? THINKING_OPTIONS;

    this.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        model: selection.baseModel,
        mode: selection.mode,
        thinkingOption: selection.thinkingOption,
        models: catalog.models.length > 0 ? catalog.models : DEFAULT_MODELS,
        modes: catalog.modes.length > 0 ? catalog.modes : DEFAULT_MODES,
        thinkingOptions,
        settings: [],
      },
    });
  }

  private recordOrEmitTimelineItem(item: ProviderTimelineItem): void {
    if (this.replayMode === "replay") {
      const idx = this.bufferedReplayItems.findIndex((existing) => existing.id === item.id);
      if (idx !== -1) {
        this.bufferedReplayItems[idx] = item;
      } else {
        this.bufferedReplayItems.push(item);
      }
      return;
    }
    this.emitItem(item);
  }

  private emitItem(item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId: this.options.id, item });
  }

  private emit(event: ProviderEvent): void {
    this.options.emit(event);
  }
}

function toAcpMcpServers(
  mcpServers: Readonly<Record<string, ProviderMcpServerConfig>>,
): Record<string, unknown>[] {
  return Object.entries(mcpServers).map(([name, server]) => {
    if (server.type === "stdio") {
      return {
        name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([k, v]) => ({ name: k, value: v })),
      };
    }
    return {
      type: server.type,
      name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([k, v]) => ({ name: k, value: v })),
    };
  });
}
