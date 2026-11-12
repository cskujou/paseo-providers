import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readBackgroundTurn } from "./background.js";
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
  ProviderInput,
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
  catalogFromResponse,
  configChoices,
  findConfigOption,
  sessionResponseSchema,
  type AcpConfigOption,
} from "./catalog.js";
import {
  RevertTokenSchema,
  SessionRewindTracker,
  readUserStepIndices,
} from "./rewind.js";
import {
  readTranscriptTimeline,
  type TranscriptTimelineItem,
} from "./transcript-history.js";
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
    settings: z.record(z.string(), z.string()).optional(),
  })
  .refine((d) => Boolean(d.conversationId || d.sessionId), {
    message: "Expected conversationId or sessionId in Antigravity persistence",
  });

export function parsePersistenceConversationId(
  persistence?: ProviderPersistence,
): {
  conversationId: string | null;
  model?: string;
  mode?: string;
  thinkingOption?: string;
  settings?: Record<string, string>;
} {
  if (!persistence) return { conversationId: null };
  if (persistence.version !== 1)
    throw new AntigravityError(
      "Unsupported Antigravity persistence version",
      "INVALID_PERSISTENCE",
    );
  const parsed = persistenceDataSchema.safeParse(persistence.data);
  if (!parsed.success) {
    throw new AntigravityError(
      "Invalid Antigravity persistence payload",
      "INVALID_PERSISTENCE",
    );
  }
  return {
    conversationId: parsed.data.conversationId ?? parsed.data.sessionId ?? null,
    model: parsed.data.model,
    mode: parsed.data.mode,
    thinkingOption: parsed.data.thinkingOption,
    settings: parsed.data.settings,
  };
}

interface ActiveTurn {
  id: string;
  canceled: boolean;
  completion: Promise<void>;
  resolve(): void;
  activity: ReturnType<typeof Promise.withResolvers<void>>;
}

type ProviderRevertScope = Extract<
  ProviderInput,
  { type: "session.revert" }
>["scope"];

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
  usage: Pick<AntigravityUsage, "recordTier">;
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
  private readonly bufferedReplayItems: TranscriptTimelineItem[] = [];
  private restarting = false;
  private closed = false;
  private opened = false;
  private starting: Promise<AcpClient> | null = null;
  private pendingPrompt: AbortController | null = null;
  private replayMessageId: string | null = null;
  private sessionCatalog: ProviderCatalog;
  private configOptions: AcpConfigOption[] = [];
  private configuring = false;

  constructor(private readonly options: SessionOptions) {
    const saved = parsePersistenceConversationId(options.persistence);
    this.conversationId = saved.conversationId;
    this.sessionCatalog = options.catalog();
    this.config = {
      ...options.config,
      model:
        options.config.model ??
        saved.model ??
        (saved.conversationId ? undefined : this.sessionCatalog.defaultModel),
      mode:
        options.config.mode ??
        saved.mode ??
        (saved.conversationId ? undefined : "auto"),
      settings: { ...saved.settings, ...options.config.settings },
      thinkingOption: options.config.thinkingOption ?? saved.thinkingOption,
    };
    validateSelection(this.config, options.catalog());

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({
      ...options.launch.env,
      ...options.config.env,
    })) {
      if (typeof v === "string") env[k] = v;
    }
    this.mergedEnv = env;
    this.rewindTracker = new SessionRewindTracker(
      this.config.cwd,
      this.mergedEnv,
    );
  }

  async open(
    requestId: string,
    capabilities: readonly string[],
  ): Promise<void> {
    const client = await this.startAcpClient(this.options.history);
    this.client = client;
    if (this.closed)
      throw new AntigravityError(
        "Antigravity session was closed during startup",
        "SESSION_CLOSED",
      );
    this.opened = true;

    const promptCapabilities = z
      .object({ image: z.boolean().optional() })
      .parse(client.agentCapabilities.promptCapabilities ?? {});
    const sessionCapabilities = capabilities.filter(
      (capability) =>
        capability !== "prompt.image" || promptCapabilities.image === true,
    );
    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.options.id,
      capabilities: sessionCapabilities,
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
      this.pendingPrompt === null &&
      this.starting === null &&
      !this.configuring &&
      !this.hasRunningTools() &&
      this.pendingPermissions.size === 0
    );
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closed)
      throw new AntigravityError(
        "Antigravity session is closed",
        "SESSION_CLOSED",
      );
    if (this.restarting || this.configuring)
      throw new AntigravityError(
        "Antigravity session is rewinding",
        "SESSION_BUSY",
      );
    if (this.activeTurn || this.pendingPrompt) {
      throw new AntigravityError(
        "Antigravity already has an active turn",
        "TURN_ACTIVE",
      );
    }
    if (prompt.delivery === "steer") {
      throw new AntigravityError(
        "Antigravity ACP has no acknowledged steer operation",
        "STEER_UNSUPPORTED",
      );
    }
    const admission = new AbortController();
    this.pendingPrompt = admission;
    let turn: ActiveTurn;
    let client: AcpClient;
    try {
      client = await this.ensureClient();
      if (!this.conversationId)
        throw new AntigravityError(
          "Antigravity session has no conversation ID",
          "NO_CONVERSATION",
        );
      const { acpPrompt, displayText } = this.encodePrompt(prompt);
      const revertToken = await this.rewindTracker.createTurnToken(
        this.conversationId,
        prompt.clientMessageId,
      );
      if (admission.signal.aborted || this.closed)
        throw new AntigravityError(
          "Antigravity prompt was canceled before starting",
          "PROMPT_CANCELED",
        );
      const completion = Promise.withResolvers<void>();
      turn = {
        id: randomUUID(),
        canceled: false,
        completion: completion.promise,
        resolve: completion.resolve,
        activity: Promise.withResolvers<void>(),
      };
      this.activeTurn = turn;
      this.messages.clear();
      this.toolCalls.clear();
      this.fallbackChunkIds.clear();
      this.pendingPrompt = null;
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
        const response = z
          .object({
            stopReason: z.enum([
              "end_turn",
              "cancelled",
              "max_tokens",
              "max_turn_requests",
              "refusal",
            ]),
          })
          .parse(
            await client.request(
              "session/prompt",
              { sessionId: this.conversationId, prompt: acpPrompt },
              null,
            ),
          );
        if (this.activeTurn !== turn) return;
        const canceled = turn.canceled || response.stopReason === "cancelled";
        if (!canceled && response.stopReason !== "end_turn")
          throw new AntigravityError(
            "Antigravity stopped: " + response.stopReason,
            "TURN_LIMIT",
          );
        if (!canceled) {
          const background = await this.waitForBackgroundTurn(turn);
          if (!background) await this.waitForTurnTools(turn);
        }
        if (this.activeTurn !== turn) return;
        await this.retireTurnClient(client);
        if (this.activeTurn !== turn) return;
        if (turn.canceled || canceled) this.finishRunningTools("canceled");
        else if (this.hasRunningTools())
          throw new AntigravityError(
            "Antigravity started an unfinished tool after end_turn",
            "INVALID_TURN_BOUNDARY",
          );
        this.emit({
          type: "session.turn",
          sessionId: this.options.id,
          turnId: turn.id,
          state: turn.canceled || canceled ? "canceled" : "completed",
        });
      } catch (error) {
        if (this.activeTurn !== turn) return;
        let failure = error;
        try {
          await this.retireTurnClient(client);
        } catch (closeError) {
          failure = new AggregateError(
            [error, closeError],
            "Antigravity turn and runtime teardown failed",
          );
        }
        if (this.activeTurn !== turn) return;
        this.finishRunningTools(turn.canceled ? "canceled" : "failed");
        const message =
          failure instanceof Error ? failure.message : String(failure);
        this.emit({
          type: "session.turn",
          sessionId: this.options.id,
          turnId: turn.id,
          state: turn.canceled ? "canceled" : "failed",
          ...(turn.canceled
            ? {}
            : { error: { message: formatDiagnostic(message) } }),
        });
      } finally {
        if (this.activeTurn === turn) this.activeTurn = null;
        this.cancelPendingPermissions();
        this.fallbackChunkIds.clear();
        turn.activity.resolve();
        turn.resolve();
      }
    } finally {
      if (this.pendingPrompt === admission) this.pendingPrompt = null;
    }
  }

  private async waitForBackgroundTurn(turn: ActiveTurn): Promise<boolean> {
    if (!this.conversationId) return false;
    let snapshot = await readBackgroundTurn(
      this.conversationId,
      this.mergedEnv,
    );
    if (!snapshot) return false;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (this.activeTurn === turn && !turn.canceled && !snapshot.settled) {
      if (Date.now() >= deadline)
        throw new AntigravityError(
          "Antigravity background task did not finish its automatic continuation",
          "BACKGROUND_TIMEOUT",
        );
      await Promise.race([delay(250), turn.activity.promise]);
      if (this.activeTurn !== turn || turn.canceled) return true;
      turn.activity = Promise.withResolvers<void>();
      snapshot = await readBackgroundTurn(this.conversationId, this.mergedEnv);
      if (!snapshot)
        throw new AntigravityError(
          "Antigravity background transcript became unavailable",
          "BACKGROUND_STATE_LOST",
        );
    }
    if (this.activeTurn !== turn || turn.canceled) return true;
    for (const task of snapshot.tasks) {
      for (const [id, state] of this.toolCalls) {
        const input = state.rawInput;
        if (
          state.name !== "run_command" ||
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          input.CommandLine !== task.command
        )
          continue;
        const next = {
          ...state,
          status:
            task.exitCode !== undefined && task.exitCode !== 0
              ? ("failed" as const)
              : ("completed" as const),
          rawOutput: task.output,
        };
        this.toolCalls.set(id, next);
        const item = acpToolToTimelineItem(next);
        if (item.detail.type === "shell")
          item.detail = { ...item.detail, exitCode: task.exitCode };
        this.emitItem(item);
      }
    }
    // Only publish the autonomous continuation, not the already streamed foreground.
    for (const item of await readTranscriptTimeline(
      this.conversationId,
      this.mergedEnv,
    )) {
      const step = /^history:(\d+):/.exec(item.id);
      if (step && Number(step[1]) >= snapshot.continuationStep!)
        this.emitItem(item);
    }
    return true;
  }

  private async waitForTurnTools(turn: ActiveTurn): Promise<void> {
    const deadline = AbortSignal.timeout(30000);
    while (
      this.activeTurn === turn &&
      !turn.canceled &&
      this.hasRunningTools()
    ) {
      turn.activity = Promise.withResolvers<void>();
      await new Promise<void>((resolve, reject) => {
        const abort = () =>
          reject(
            new AntigravityError(
              "Antigravity returned end_turn before its tools settled",
              "TURN_DRAIN_TIMEOUT",
            ),
          );
        deadline.addEventListener("abort", abort, { once: true });
        if (deadline.aborted) abort();
        void turn.activity.promise.then(() => {
          deadline.removeEventListener("abort", abort);
          resolve();
        });
      });
    }
  }

  private hasRunningTools(): boolean {
    return [...this.toolCalls.values()].some(
      (tool) => tool.status === "pending" || tool.status === "in_progress",
    );
  }

  private async retireTurnClient(client: AcpClient): Promise<void> {
    // ACP updates identify a session, not a turn. EOF closes the old stream before
    // publishing completion, so an unlabelled late update cannot belong to the next prompt.
    await client.close();
    if (this.client === client) this.client = null;
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (this.configuring)
      throw new AntigravityError(
        "Antigravity configuration is already changing",
        "SESSION_BUSY",
      );
    this.configuring = true;
    try {
      await this.applyConfiguration(changes);
    } finally {
      this.configuring = false;
    }
  }

  private async applyConfiguration(
    changes: ProviderConfigChanges,
  ): Promise<void> {
    if (this.closed || this.restarting || this.pendingPrompt)
      throw new AntigravityError(
        "Antigravity session is not ready for configuration",
        "SESSION_BUSY",
      );
    const client = await this.ensureClient();
    if (!this.conversationId)
      throw new AntigravityError(
        "Antigravity session has no conversation ID",
        "NO_CONVERSATION",
      );
    const changingModel =
      changes.model !== undefined && changes.model !== this.config.model;
    const nextConfig = {
      ...this.config,
      model:
        changes.model === null
          ? this.sessionCatalog.defaultModel
          : (changes.model ?? this.config.model),
      mode: changes.mode === null ? "auto" : (changes.mode ?? this.config.mode),
      thinkingOption:
        changes.thinkingOption === null || changingModel
          ? undefined
          : (changes.thinkingOption ?? this.config.thinkingOption),
    };
    if (changes.thinkingOption !== undefined && changes.thinkingOption !== null)
      nextConfig.thinkingOption = changes.thinkingOption;
    const selection = validateSelection(nextConfig, this.sessionCatalog);
    for (const [id, value] of Object.entries(changes.settings ?? {})) {
      const option = this.configOptions.find(
        (entry) =>
          entry.id === id &&
          !["model", "mode", "thought_level"].includes(
            entry.category ?? entry.id,
          ),
      );
      if (
        !option ||
        typeof value !== "string" ||
        !configChoices(option).some((choice) => choice.value === value)
      )
        throw new AntigravityError(
          "Unsupported Antigravity setting: " + id,
          "INVALID_SETTING",
        );
    }
    try {
      await this.applySelectionToAcp(client, this.conversationId, selection);
      for (const [id, value] of Object.entries(changes.settings ?? {}))
        await this.setConfigOption(
          client,
          this.conversationId,
          id,
          String(value),
        );
    } finally {
      // A multi-option ACP change can partially commit before a later option fails.
      this.publishConfig();
      this.publishPersistence();
    }
  }

  answerPermission(
    permissionId: string,
    response: ProviderPermissionResponse,
  ): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new AntigravityError(
        `Permission request ${permissionId} is no longer pending`,
      );
    }
    const options = pending.request.options;
    if (
      response.selectedActionId !== undefined &&
      !options.some(
        (option) =>
          option.optionId === response.selectedActionId &&
          option.kind.startsWith(
            response.behavior === "allow" ? "allow" : "reject",
          ),
      )
    )
      throw new AntigravityError(
        "Permission selection does not match the requested behavior",
        "INVALID_PERMISSION_ACTION",
      );
    const sameBehavior = options.filter((option) =>
      option.kind.startsWith(
        response.behavior === "allow" ? "allow" : "reject",
      ),
    );
    if (
      response.selectedActionId === undefined &&
      response.behavior === "allow" &&
      sameBehavior.some(
        (option) =>
          sameBehavior.filter((choice) => choice.kind === option.kind).length >
          1,
      )
    )
      throw new AntigravityError(
        "Choose an exact permission action",
        "PERMISSION_CHOICE_REQUIRED",
      );
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
    if (!this.conversationId)
      throw new AntigravityError(
        "Cannot rewind session without a conversation",
        "NO_CONVERSATION",
      );
    if (
      this.closed ||
      this.restarting ||
      this.configuring ||
      this.pendingPrompt
    )
      throw new AntigravityError(
        "Antigravity session is not ready for rewind",
        "SESSION_BUSY",
      );
    const token = RevertTokenSchema.parse(rawToken);
    if (token.conversationId !== this.conversationId)
      throw new AntigravityError(
        "Rewind token belongs to another conversation",
        "INVALID_REVERT_TOKEN",
      );
    if (scope !== "conversation")
      await this.rewindTracker.assertFileCheckpoint(token);
    this.restarting = true;
    try {
      if (this.activeTurn) await this.interrupt();
      if (this.client) {
        const client = this.client;
        this.client = null;
        try {
          await client.request(
            "session/close",
            { sessionId: this.conversationId },
            1500,
          );
        } finally {
          await client.close();
        }
      }
      if (scope !== "conversation") await this.rewindTracker.revertFiles(token);
      if (scope !== "files") {
        await this.rewindTracker.revertConversation(this.conversationId, token);
        this.messages.clear();
        this.toolCalls.clear();
        this.fallbackChunkIds.clear();
      }
      await this.startAcpClient("skip");
      this.publishConfig();
      this.publishPersistence();
    } finally {
      this.restarting = false;
    }
  }

  async interrupt(): Promise<void> {
    this.pendingPrompt?.abort();
    const turn = this.activeTurn;
    const client = this.client;
    if (!turn || !client || !this.conversationId) return;
    turn.canceled = true;
    turn.activity.resolve();
    this.cancelPendingPermissions();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await client.notify("session/cancel", { sessionId: this.conversationId });
      await Promise.race([
        turn.completion,
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () =>
              reject(
                new AntigravityError(
                  "Antigravity did not settle the canceled turn",
                  "CANCEL_TIMEOUT",
                ),
              ),
            { once: true },
          ),
        ),
      ]);
    } catch (error) {
      await client.close();
      if (this.client === client) this.client = null;
      await turn.completion;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pendingPrompt?.abort();
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
      this.activeTurn.activity.resolve();
      this.activeTurn.resolve();
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
    if (this.starting) return this.starting;
    if (this.client) return this.client;
    return this.startAcpClient("skip");
  }

  private async startAcpClient(
    historyMode: "replay" | "skip",
  ): Promise<AcpClient> {
    if (this.closed)
      throw new AntigravityError(
        "Antigravity session is closed",
        "SESSION_CLOSED",
      );
    if (this.starting) return this.starting;
    const starting = this.createAcpClient(historyMode);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async createAcpClient(
    historyMode: "replay" | "skip",
  ): Promise<AcpClient> {
    const client: AcpClient = new AcpClient({
      launch: this.options.launch,
      cwd: this.config.cwd,
      env: this.mergedEnv,
      onSessionUpdate: (params) => {
        if (this.client === client) return this.handleSessionUpdate(params);
      },
      onPermissionRequest: (params) =>
        this.client === client
          ? this.handlePermissionRequest(params)
          : Promise.resolve({ outcome: { outcome: "cancelled" } }),
      onExit: (error) => {
        if (this.client === client) this.handleUnexpectedExit(error);
      },
    });
    this.client = client;

    try {
      const requestedConfig = { ...this.config };
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
            } catch (error) {
              if (
                !(error instanceof AntigravityError) ||
                error.code !== "RPC_-32601"
              )
                throw error;
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
          if (
            historyMode === "replay" &&
            this.bufferedReplayItems.length === 0
          ) {
            await this.replayTranscriptHistory();
          }
        } finally {
          this.replayMode = "none";
        }
      } else {
        const meta = this.config.systemPrompt
          ? {
              antigravity: {
                systemPrompt: { append: this.config.systemPrompt },
              },
            }
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
          typeof sessionResponse.sessionId === "string"
            ? sessionResponse.sessionId
            : null;
        if (!newId) {
          throw new AntigravityError(
            "Antigravity ACP did not return a sessionId",
          );
        }
        this.conversationId = newId;
      }

      this.recordTierFromSessionResponse(sessionResponse);
      this.absorbConfigResponse(sessionResponse);
      const selection = validateSelection(
        {
          ...requestedConfig,
          model: requestedConfig.model ?? this.config.model,
          mode: requestedConfig.mode ?? this.config.mode,
          thinkingOption:
            requestedConfig.thinkingOption ??
            (requestedConfig.model &&
            requestedConfig.model !== this.config.model
              ? undefined
              : this.config.thinkingOption),
        },
        this.sessionCatalog,
      );
      await this.applySelectionToAcp(client, this.conversationId, selection);
      for (const [id, value] of Object.entries(requestedConfig.settings)) {
        const option = this.configOptions.find((entry) => entry.id === id);
        if (
          !option ||
          typeof value !== "string" ||
          !configChoices(option).some((choice) => choice.value === value)
        )
          throw new AntigravityError(
            "Unsupported Antigravity setting: " + id,
            "INVALID_SETTING",
          );
        await this.setConfigOption(client, this.conversationId, id, value);
      }
      if (this.closed)
        throw new AntigravityError(
          "Antigravity session closed during startup",
          "SESSION_CLOSED",
        );
      return client;
    } catch (error) {
      await client.close();
      if (this.client === client) this.client = null;
      throw error;
    }
  }

  private recordTierFromSessionResponse(
    response: Record<string, unknown>,
  ): void {
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

  private absorbConfigResponse(rawResponse: unknown): void {
    const response = sessionResponseSchema.parse(rawResponse);
    if (response.configOptions) this.configOptions = response.configOptions;
    this.sessionCatalog = catalogFromResponse(response, this.sessionCatalog);
    const model = findConfigOption(this.configOptions, "model");
    const thinking = findConfigOption(this.configOptions, "thought_level");
    const mode = findConfigOption(this.configOptions, "mode");
    const nativeMode = mode?.currentValue ?? response.modes?.currentModeId;
    this.config = {
      ...this.config,
      model:
        model?.currentValue ??
        response.models?.currentModelId ??
        this.config.model,
      thinkingOption: thinking?.currentValue,
      settings: Object.fromEntries(
        this.configOptions
          .filter(
            (option) =>
              !["model", "mode", "thought_level"].includes(
                option.category ?? option.id,
              ),
          )
          .map((option) => [option.id, option.currentValue]),
      ),
      mode:
        nativeMode === "default" && this.config.mode === "full-access"
          ? "full-access"
          : (nativeMode ?? this.config.mode),
    };
  }

  private async setConfigOption(
    client: AcpClient,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const response = await client.request(
      "session/set_config_option",
      { sessionId, configId, value },
      8000,
    );
    const parsed = sessionResponseSchema.parse(response);
    if (!parsed.configOptions)
      throw new AntigravityError(
        "Antigravity omitted the committed config options",
        "INVALID_CONFIG_RESPONSE",
      );
    this.absorbConfigResponse(parsed);
  }

  private async applySelectionToAcp(
    client: AcpClient,
    sessionId: string,
    selection: ReturnType<typeof normalizeSelection>,
  ): Promise<void> {
    const model = findConfigOption(this.configOptions, "model");
    if (this.config.model !== selection.baseModel) {
      if (model)
        await this.setConfigOption(
          client,
          sessionId,
          model.id,
          selection.baseModel,
        );
      else {
        this.absorbConfigResponse(
          await client.request(
            "session/set_model",
            { sessionId, modelId: selection.baseModel },
            8000,
          ),
        );
        this.config = { ...this.config, model: selection.baseModel };
      }
    }
    const thinking = findConfigOption(this.configOptions, "thought_level");
    if (
      selection.thinkingOption &&
      selection.thinkingOption !== this.config.thinkingOption
    ) {
      if (
        !thinking ||
        !configChoices(thinking).some(
          (choice) => choice.value === selection.thinkingOption,
        )
      )
        throw new AntigravityError(
          "This model does not support the requested thinking level",
          "INVALID_THINKING_LEVEL",
        );
      await this.setConfigOption(
        client,
        sessionId,
        thinking.id,
        selection.thinkingOption,
      );
    }
    const nativeMode =
      this.config.mode === "full-access" ? "default" : this.config.mode;
    if (nativeMode !== selection.acpMode) {
      const mode = findConfigOption(this.configOptions, "mode");
      if (mode)
        await this.setConfigOption(
          client,
          sessionId,
          mode.id,
          selection.acpMode,
        );
      else {
        this.absorbConfigResponse(
          await client.request(
            "session/set_mode",
            { sessionId, modeId: selection.acpMode },
            8000,
          ),
        );
        this.config = { ...this.config, mode: selection.acpMode };
      }
    }
    this.config = { ...this.config, mode: selection.mode };
  }

  private publishPersistence(): void {
    if (this.config.persist && this.conversationId)
      this.emit({
        type: "session.persistence",
        sessionId: this.options.id,
        persistence: this.persistence(),
      });
  }

  private async handleSessionUpdate(
    params: AcpSessionUpdateParams,
  ): Promise<void> {
    if (this.closed) return;
    if (
      this.conversationId &&
      params.sessionId &&
      params.sessionId !== this.conversationId
    ) {
      return;
    }
    if (
      this.replayMode === "skip" ||
      (this.replayMode === "none" && !this.activeTurn)
    ) {
      this.handleMetaSessionUpdate(params.update);
      return;
    }

    const update = params.update;
    const kind =
      typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

    if (
      this.replayMode === "replay" &&
      kind !== "user_message_chunk" &&
      this.replayMessageId !== null
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
      const msgId =
        typeof update.messageId === "string" ? update.messageId : undefined;
      if (
        msgId &&
        this.replayMessageId &&
        this.replayMessageId !== "history:user_message_chunk:" + msgId
      )
        await this.flushReplayUserChunk();
      const id = this.resolveChunkId("user_message_chunk", msgId);
      this.replayMessageId = id;
      const prev = this.messages.get(id) ?? "";
      this.messages.set(id, prev + content.text);
      return;
    }

    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      this.fallbackChunkIds.delete(
        kind === "agent_message_chunk"
          ? "agent_thought_chunk"
          : "agent_message_chunk",
      );
      const content =
        typeof update.content === "object" && update.content !== null
          ? (update.content as Record<string, unknown>)
          : {};
      if (content.type !== "text" || typeof content.text !== "string") return;
      const msgId =
        typeof update.messageId === "string" ? update.messageId : undefined;
      const id = this.resolveChunkId(kind, msgId);
      const text = `${this.messages.get(id) ?? ""}${content.text}`;
      this.messages.set(id, text);

      const item: ProviderTimelineItem =
        kind === "agent_message_chunk"
          ? {
              type: "assistant_message",
              id,
              messageId: id,
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
      const toolCallId =
        typeof update.toolCallId === "string" ? update.toolCallId : "tool";
      const current = this.toolCalls.get(toolCallId);
      const merged = mergeAcpToolCall(update, current);
      if (merged.kind === "execute" || merged.name === "run_command")
        await this.rewindTracker.recordShellOperation();
      this.toolCalls.set(merged.toolCallId, merged);
      this.activeTurn?.activity.resolve();

      if (merged.status === "pending" || merged.status === "in_progress") {
        for (const filePath of extractModifiedFilePaths(merged)) {
          await this.rewindTracker.recordFileBeforeModification(
            filePath,
            merged.diff?.path === filePath ? merged.diff.oldText : undefined,
          );
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
          const status =
            typeof rec.status === "string" ? rec.status : "pending";
          return {
            id: String(idx),
            text: typeof rec.content === "string" ? rec.content : "",
            completed: status === "completed",
            status:
              status === "completed" ||
              status === "in_progress" ||
              status === "pending"
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

  private async replayTranscriptHistory(): Promise<void> {
    if (!this.conversationId) return;
    let items: TranscriptTimelineItem[] = [];
    try {
      items = await readTranscriptTimeline(this.conversationId, this.mergedEnv);
    } catch {
      return;
    }
    for (const item of items) {
      if (item.type === "user_message") {
        const turnIndex = this.replayUserTurnCount++;
        item.revertToken = await this.rewindTracker.createReplayToken(
          this.conversationId,
          item.id,
          turnIndex,
          this.replayUserStepIndices,
        );
      }
      this.bufferedReplayItems.push(item);
    }
  }

  private async flushReplayUserChunk(): Promise<void> {
    const id = this.replayMessageId;
    if (!id) return;
    this.replayMessageId = null;
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
    const kind =
      typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "config_option_update") {
      this.absorbConfigResponse(update);
      if (this.opened) {
        this.publishConfig();
        this.publishPersistence();
      }
      return;
    }
    if (
      kind === "available_commands_update" &&
      Array.isArray(update.availableCommands)
    ) {
      this.commands = update.availableCommands
        .map((cmd): ProviderCommand | null => {
          const rec =
            typeof cmd === "object" && cmd !== null
              ? (cmd as Record<string, unknown>)
              : {};
          const name = typeof rec.name === "string" ? rec.name : "";
          if (!name) return null;
          const description =
            typeof rec.description === "string" ? rec.description : "";
          const inputRec =
            typeof rec.input === "object" && rec.input !== null
              ? (rec.input as Record<string, unknown>)
              : {};
          const argumentHint =
            typeof inputRec.hint === "string" ? inputRec.hint : undefined;
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

    if (
      kind === "current_mode_update" &&
      typeof update.currentModeId === "string"
    ) {
      if (
        this.config.mode !== "full-access" ||
        update.currentModeId !== "auto"
      ) {
        this.config = { ...this.config, mode: update.currentModeId };
        if (this.opened) {
          this.publishConfig();
          this.publishPersistence();
        }
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
    if (
      this.closed ||
      this.restarting ||
      request.sessionId !== this.conversationId ||
      this.activeTurn?.canceled
    )
      return { outcome: { outcome: "cancelled" } };
    const permissionClient = this.client;
    const permissionTurn = this.activeTurn;
    if (!permissionClient) return { outcome: { outcome: "cancelled" } };
    const toolState = mergeAcpToolCall(request.toolCall);
    if (toolState.kind === "execute" || toolState.name === "run_command")
      await this.rewindTracker.recordShellOperation();
    for (const filePath of extractModifiedFilePaths(toolState)) {
      await this.rewindTracker.recordFileBeforeModification(
        filePath,
        toolState.diff?.path === filePath ? toolState.diff.oldText : undefined,
      );
    }

    const selection = normalizeSelection(this.config, this.sessionCatalog);
    if (
      this.closed ||
      this.restarting ||
      this.activeTurn?.canceled ||
      this.client !== permissionClient ||
      this.activeTurn !== permissionTurn
    )
      return { outcome: { outcome: "cancelled" } };
    const isChooser = request.options.some(
      (option) =>
        option.kind.startsWith("allow") &&
        request.options.filter((choice) => choice.kind === option.kind).length >
          1,
    );
    if (selection.autoApproveAll && !isChooser) {
      const allowOpt =
        request.options.find((opt) => opt.kind === "allow_always") ??
        request.options.find((opt) => opt.kind.startsWith("allow"));
      if (allowOpt) {
        return {
          outcome: { outcome: "selected", optionId: allowOpt.optionId },
        };
      }
    }

    const toolCallId =
      typeof request.toolCall.toolCallId === "string"
        ? request.toolCall.toolCallId
        : randomUUID();
    const permissionId = `permission:${toolCallId}:${randomUUID()}`;

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
      this.activeTurn.activity.resolve();
      this.activeTurn.resolve();
      this.activeTurn = null;
      this.finishRunningTools("failed");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId,
        state: "failed",
        error: {
          message: error.message,
          code: error.code,
          diagnostic: error.diagnostic,
        },
      });
    } else {
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.options.id,
        error: {
          message: error.message,
          code: error.code,
          diagnostic: error.diagnostic,
        },
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

  private finishRunningTools(status: "failed" | "canceled"): void {
    for (const [id, state] of this.toolCalls.entries()) {
      if (state.status !== "pending" && state.status !== "in_progress")
        continue;
      this.toolCalls.set(id, { ...state, status: "failed" });
      const item = acpToolToTimelineItem(state);
      if (status === "failed") {
        this.emitItem({
          ...item,
          status: "failed",
          error: "Antigravity turn failed",
        });
      } else {
        this.emitItem({ ...item, status, error: null });
      }
    }
  }

  private resolveChunkId(kind: string, messageId?: string): string {
    if (messageId) {
      this.fallbackChunkIds.delete(kind);
      return `${this.activeTurn?.id ?? "history"}:${kind}:${messageId}`;
    }
    let id = this.fallbackChunkIds.get(kind);
    if (!id) {
      id = `${this.activeTurn?.id ?? "history"}:${kind}:${++this.chunkSequence}`;
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
        const promptCapabilities =
          this.client?.agentCapabilities.promptCapabilities;
        if (
          !promptCapabilities ||
          typeof promptCapabilities !== "object" ||
          !("image" in promptCapabilities) ||
          promptCapabilities.image !== true
        )
          throw new AntigravityError(
            "This Antigravity ACP agent does not support images",
            "IMAGE_UNSUPPORTED",
          );
        textParts.push("[Image: " + part.mimeType + "]");
        acpPrompt.push({
          type: "image",
          data: part.data,
          mimeType: part.mimeType,
        });
      } else if (part.type === "uploaded_file") {
        const text = "Attached file: " + part.fileName + "\nPath: " + part.path;
        acpPrompt.push({ type: "text", text });
        textParts.push(text);
      } else {
        const text = JSON.stringify(part);
        acpPrompt.push({ type: "text", text });
        textParts.push(text);
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
    const selection = normalizeSelection(this.config, this.sessionCatalog);
    return {
      version: 1,
      data: {
        conversationId: this.conversationId,
        sessionId: this.conversationId,
        model: selection.baseModel,
        mode: selection.mode,
        settings: Object.fromEntries(
          this.configOptions
            .filter(
              (option) =>
                !["model", "mode", "thought_level"].includes(
                  option.category ?? option.id,
                ),
            )
            .map((option) => [option.id, option.currentValue]),
        ),
        ...(selection.thinkingOption
          ? { thinkingOption: selection.thinkingOption }
          : {}),
      },
    };
  }

  private publishConfig(): void {
    const catalog = this.sessionCatalog;
    const selection = normalizeSelection(this.config, catalog);
    const modelDescriptor =
      catalog.models.find((m) => m.id === selection.baseModel) ??
      DEFAULT_MODELS.find((m) => m.id === selection.baseModel);
    const thinkingOptions =
      modelDescriptor?.thinkingOptions ?? THINKING_OPTIONS;

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
        settings: this.configOptions
          .filter(
            (option) =>
              !["model", "mode", "thought_level"].includes(
                option.category ?? option.id,
              ),
          )
          .map((option) => ({
            type: "select",
            id: option.id,
            label: option.name,
            value: option.currentValue,
            options: configChoices(option).map((choice) => ({
              label: choice.name,
              value: choice.value,
            })),
          })),
      },
    });
  }

  private recordOrEmitTimelineItem(item: ProviderTimelineItem): void {
    if (this.replayMode === "replay") {
      const idx = this.bufferedReplayItems.findIndex(
        (existing) => existing.id === item.id,
      );
      if (idx !== -1) {
        this.bufferedReplayItems[idx] = item;
      } else {
        this.bufferedReplayItems.push(item);
      }
      return;
    }
    this.emitItem(item);
  }

  private emitItem(item: TranscriptTimelineItem): void {
    const { timestamp, ...timelineItem } = item;
    if (timelineItem.type === "tool_call" && this.activeTurn) {
      timelineItem.id = this.activeTurn.id + ":" + timelineItem.id;
      timelineItem.callId = this.activeTurn.id + ":" + timelineItem.callId;
    }
    this.emit({
      type: "timeline.item",
      sessionId: this.options.id,
      item: timelineItem,
      timestamp,
    });
  }

  private emit(event: ProviderEvent): void {
    if (!this.closed) this.options.emit(event);
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
        env: Object.entries(server.env ?? {}).map(([k, v]) => ({
          name: k,
          value: v,
        })),
      };
    }
    return {
      type: server.type,
      name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([k, v]) => ({
        name: k,
        value: v,
      })),
    };
  });
}
