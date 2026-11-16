import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  inspectTurnExecutionFailure,
  readBackgroundTurn,
  type BackgroundTask,
} from "./background.js";
import { planFromTool, readPendingPlan, type PlanProposal } from "./plan.js";
import { SubagentTracker } from "./subagents.js";
import {
  AntigravityError,
  providerError,
  logDiagnostic,
  diagnosticDetails,
} from "./diagnostics.js";
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
  readConversationTurnError,
  readUserStepIndices,
  type RevertToken,
} from "./rewind.js";
import {
  readTranscriptCompactionSteps,
  readTranscriptTimeline,
  statTranscriptOffset,
  type TranscriptCompactionStep,
  type TranscriptTimelineItem,
} from "./transcript-history.js";
import {
  acpToolToTimelineItem,
  buildToolDetail,
  extractModifiedFilePaths,
  mergeAcpToolCall,
  type AcpToolCallState,
} from "./timeline.js";

const TERMINATED_ERROR_TEXT = "Agent execution terminated due to error.";
const MAX_PROMPT_EXECUTION_RETRIES = 2;
const INBAND_EXECUTION_ERROR_RE =
  /^(?:⚠\s*)?Agent execution terminated due to error\.?$/u;
const DEFAULT_AUTO_RETRY_MAX = 3;
const DEFAULT_AUTO_RETRY_DELAY_MS = 600;
const TRANSIENT_CONTINUE_PROMPT = "继续";
const LIVE_COMPACTION_POLL_MS = 300;

const READ_ONLY_TOOL_NAMES = new Set([
  "read_file",
  "view_file",
  "list_dir",
  "list_directory",
  "grep_search",
  "find_by_name",
  "search_web",
  "read_url_content",
  "list_resources",
  "read_resource",
]);

const FILE_EDIT_TOOL_NAMES = new Set([
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write_file",
  "write_to_file",
]);

const NON_RETRYABLE_ERROR_PATTERN =
  /\b(unauthenticated|unauthorized|not logged in|sign[- ]?in|log[- ]?in|invalid[_ ]?api[_ ]?key|invalid[_ ]?grant|credits? balance is too low|insufficient[_ ]?(?:credits|funds)|billing|payment required|content safety|safety filters?|policy violation|prohibited content|INVALID_ARGUMENT|NOT_FOUND|PERMISSION_DENIED)\b/i;

const persistenceDataSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    model: z.string().optional(),
    mode: z.string().optional(),
    thinkingOption: z.string().optional(),
    settings: z.record(z.string(), z.string()).optional(),
    resolvedPlanRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
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
  resolvedPlanRevision?: string;
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
    resolvedPlanRevision: parsed.data.resolvedPlanRevision,
  };
}

function isInbandExecutionErrorPrefix(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return (
    ("⚠ Agent execution terminated due to error.".startsWith(trimmed) &&
      (trimmed.startsWith("⚠") ||
        trimmed.startsWith("Agent execution terminated"))) ||
    ("Agent execution terminated due to error.".startsWith(trimmed) &&
      trimmed.startsWith("Agent execution terminated"))
  );
}

interface ActiveTurn {
  id: string;
  attempt: number;
  awaitingPromptResponse: boolean;
  hasUnrevertableTool: boolean;
  hasFileModification: boolean;
  deferredAssistantItems: Map<string, ProviderTimelineItem>;
  compactionMarkerOpen: boolean;
  openCompactionId?: string;
  openCompactionTrigger?: "auto" | "manual";
  emittedCompactionSteps: Set<number>;
  retried: boolean;
  canceled: boolean;
  sawInbandError?: boolean;
  heldErrorChunk?: { id: string; text: string };
  clientMessageId: string;
  promptText: string;
  revertToken: RevertToken;
  userEchoed: boolean;
  userEchoText: string;
  completion: Promise<void>;
  resolve(): void;
  activity: ReturnType<typeof Promise.withResolvers<void>>;
  backgroundPhase?: string;
  backgroundAfterStep?: number;
  backgroundProjectedRevision?: string;
  backgroundTaskToolCalls: Map<string, string>;
  claimedBackgroundToolCalls: Set<string>;
  publishedBackgroundItems: Map<string, string>;
  plan?: PlanProposal;
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
  private readonly askQuestions = new Map<
    string,
    { permissionId: string; questions: AskQuestion[] }
  >();
  private readonly toolCalls = new Map<string, AcpToolCallState>();
  private readonly retiredToolCalls = new Set<string>();
  private readonly messages = new Map<string, string>();
  private readonly fallbackChunkIds = new Map<string, string>();
  private chunkSequence = 0;
  private commands: ProviderCommand[] = [];
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private replayMode: "none" | "replay" | "skip" = "none";
  private replayUserStepIndices: number[] = [];
  private replayUserTurnCount = 0;
  private replayCompactions: TranscriptCompactionStep[] = [];
  private replayCompactionCursor = 0;
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
  private hasDaemonTasks = false;
  private subagents: SubagentTracker | null = null;
  private readonly linkedSubagentCalls = new Set<string>();
  private subagentWatch: Promise<void> | null = null;
  private planApproval: { id: string; plan: PlanProposal } | null = null;
  private resolvedPlanRevision?: string;

  constructor(private readonly options: SessionOptions) {
    const saved = parsePersistenceConversationId(options.persistence);
    this.conversationId = saved.conversationId;
    this.resolvedPlanRevision = saved.resolvedPlanRevision;
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
    await this.subagentTracker().refresh();
    if (this.subagents?.running) this.watchSubagents();
    if (this.config.mode === "plan" && this.conversationId) {
      const plan = await readPendingPlan(this.conversationId, this.mergedEnv);
      if (plan) this.publishPlanApproval(plan);
    }

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
      !this.hasDaemonTasks &&
      !this.subagents?.running &&
      this.pendingPermissions.size === 0 &&
      this.planApproval === null
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
    this.dismissPlanApproval("canceled", true);
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
      const manualCompact =
        (prompt.input.type === "command" && prompt.input.name === "compact") ||
        /^\/compact(?:\s|$)/i.test(displayText.trim());
      const previousBackground = await readBackgroundTurn(
        this.conversationId,
        this.mergedEnv,
      );
      let transcriptBefore = await statTranscriptOffset(
        this.conversationId,
        this.mergedEnv,
      );
      let revertToken: RevertToken = await this.rewindTracker.createTurnToken(
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
        attempt: 0,
        awaitingPromptResponse: false,
        hasUnrevertableTool: false,
        hasFileModification: false,
        deferredAssistantItems: new Map(),
        compactionMarkerOpen: false,
        emittedCompactionSteps: new Set(),
        retried: false,
        canceled: false,
        clientMessageId: prompt.clientMessageId,
        promptText: displayText,
        revertToken,
        userEchoed: false,
        userEchoText: "",
        completion: completion.promise,
        resolve: completion.resolve,
        activity: Promise.withResolvers<void>(),
        backgroundAfterStep: previousBackground?.lastStep,
        backgroundTaskToolCalls: new Map(),
        claimedBackgroundToolCalls: new Set(),
        publishedBackgroundItems: new Map(),
      };
      this.activeTurn = turn;
      logDiagnostic("turn.started", {
        sessionId: this.options.id,
        conversationId: this.conversationId,
        turnId: turn.id,
        model: this.config.model,
        mode: this.config.mode,
      });
      this.resetAttemptState(turn);
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
      let completed = false;
      const maxRetries = this.autoRetryMax();
      const baseRetryDelayMs = this.autoRetryDelayMs();
      let promptBlocks = acpPrompt;
      try {
        let canceled = false;
        while (true) {
          if (manualCompact && !turn.compactionMarkerOpen) {
            this.openCompactionMarker(
              turn,
              this.turnScope(turn) + ":compaction:manual",
              "manual",
            );
          }
          let stopCompactionWatch = false;
          const compactionWatch = this.watchLiveCompactions(
            turn,
            revertToken.stepIndex,
            manualCompact,
            () => stopCompactionWatch,
          );
          turn.awaitingPromptResponse = true;
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
                  { sessionId: this.conversationId, prompt: promptBlocks },
                  null,
                ),
              );
            turn.awaitingPromptResponse = false;
            stopCompactionWatch = true;
            turn.activity.resolve();
            await compactionWatch;
            if (this.activeTurn === turn) {
              turn.activity = Promise.withResolvers<void>();
            }
            if (this.activeTurn !== turn) return;
            await this.syncLiveCompactions(
              turn,
              revertToken.stepIndex,
              manualCompact,
            );
            logDiagnostic("turn.prompt_response", {
              sessionId: this.options.id,
              conversationId: this.conversationId,
              turnId: turn.id,
              attempt: turn.attempt,
              stopReason: response.stopReason,
              runningTools: [...this.toolCalls.values()].filter(
                (t) => t.status === "pending" || t.status === "in_progress",
              ).length,
            });
            canceled = turn.canceled || response.stopReason === "cancelled";
            if (!canceled && response.stopReason !== "end_turn")
              throw new AntigravityError(
                "Antigravity stopped: " + response.stopReason,
                "TURN_LIMIT",
              );
            if (!canceled) {
              const silentError = this.detectSilentTurnError(
                revertToken.stepIndex,
              );
              if (silentError) throw silentError;
              if (this.conversationId && response.stopReason === "end_turn") {
                const inspection = await inspectTurnExecutionFailure(
                  this.conversationId,
                  this.mergedEnv,
                  transcriptBefore,
                  Boolean(turn.sawInbandError),
                );
                if (this.activeTurn !== turn) return;
                if (inspection.failed) {
                  turn.heldErrorChunk = undefined;
                  turn.sawInbandError = false;
                  const canRetry =
                    !turn.canceled &&
                    !this.closed &&
                    this.toolCalls.size === 0 &&
                    this.messages.size === 0 &&
                    turn.attempt < MAX_PROMPT_EXECUTION_RETRIES;
                  if (!this.hasDaemonTasks) {
                    await this.recycleClientForRetry(client);
                  }
                  if (this.activeTurn !== turn) return;
                  if (turn.canceled || this.closed) {
                    canceled = true;
                    this.closeOpenCompactionMarker(turn);
                    break;
                  }
                  if (canRetry && !this.hasDaemonTasks) {
                    logDiagnostic("turn.retrying_execution_error", {
                      sessionId: this.options.id,
                      conversationId: this.conversationId,
                      turnId: turn.id,
                      attempt: turn.attempt + 1,
                    });
                    const reverted = await this.rewindTracker
                      .revertConversation(this.conversationId, revertToken)
                      .then(() => true)
                      .catch(() => false);
                    if (reverted && this.conversationId) {
                      revertToken = await this.rewindTracker.createTurnToken(
                        this.conversationId,
                        prompt.clientMessageId,
                      );
                      turn.revertToken = revertToken;
                      turn.userEchoed = false;
                      turn.userEchoText = "";
                    }
                    this.fallbackChunkIds.clear();
                    turn.attempt += 1;
                    this.resetAttemptState(turn);
                    client = await this.ensureClient();
                    if (!this.conversationId || this.activeTurn !== turn)
                      return;
                    transcriptBefore = await statTranscriptOffset(
                      this.conversationId,
                      this.mergedEnv,
                    );
                    if (this.activeTurn !== turn) return;
                    continue;
                  }
                  this.closeOpenCompactionMarker(turn);
                  throw new AntigravityError(
                    inspection.message ??
                      "Agent execution terminated due to error.",
                    "AGENT_EXECUTION_ERROR",
                    diagnosticDetails(inspection.details),
                  );
                }
              }
              this.flushHeldErrorChunk(turn);
              this.flushDeferredAssistantItems(turn);
              this.closeOpenCompactionMarker(turn);
              this.ensurePromptEcho(turn);
              await this.waitForBackgroundTurn(turn);
              await this.waitForTurnTools(turn);
              await this.waitForSubagents(turn);
            } else {
              this.closeOpenCompactionMarker(turn);
            }
            this.ensurePromptEcho(turn);
            break;
          } catch (attemptError) {
            turn.awaitingPromptResponse = false;
            stopCompactionWatch = true;
            turn.activity.resolve();
            await compactionWatch;
            if (this.activeTurn === turn) {
              turn.activity = Promise.withResolvers<void>();
            }
            if (this.activeTurn !== turn) return;
            if (
              !this.canAutoRetryAttempt(attemptError, turn, maxRetries)
            ) {
              this.flushNonErrorDeferredAssistantItems(turn);
              this.closeOpenCompactionMarker(turn);
              throw attemptError;
            }
            const nextAttempt = turn.attempt + 1;
            turn.retried = true;
            this.closeOpenCompactionMarker(turn);
            this.finishRunningTools("canceled");
            turn.deferredAssistantItems.clear();
            const retrySummary = this.describeRetryReason(attemptError);
            logDiagnostic(
              "turn.auto_retry",
              {
                sessionId: this.options.id,
                conversationId: this.conversationId,
                turnId: turn.id,
                attempt: nextAttempt,
                maxRetries,
                hadFileModification: turn.hasFileModification,
              },
              attemptError,
            );
            this.emit({
              type: "session.notice",
              sessionId: this.options.id,
              notice: {
                id: "auto-retry:" + turn.id,
                severity: "warning",
                title: `Transient Antigravity error; continuing (${nextAttempt}/${maxRetries})`,
                description: retrySummary,
              },
            });
            if (this.activeTurn !== turn) return;
            if (turn.canceled || this.closed) {
              canceled = true;
              break;
            }
            const waitMs = baseRetryDelayMs * 2 ** (nextAttempt - 1);
            if (waitMs > 0) {
              turn.activity = Promise.withResolvers<void>();
              await Promise.race([delay(waitMs), turn.activity.promise]);
            }
            if (this.activeTurn !== turn) return;
            if (turn.canceled || this.closed) {
              canceled = true;
              break;
            }
            promptBlocks = [{ type: "text", text: TRANSIENT_CONTINUE_PROMPT }];
            turn.clientMessageId = `${prompt.clientMessageId}:continue:${nextAttempt}`;
            turn.promptText = TRANSIENT_CONTINUE_PROMPT;
            turn.userEchoed = false;
            turn.userEchoText = "";
            turn.attempt = nextAttempt;
            this.resetAttemptState(turn);
            if (this.activeTurn !== turn) return;
            if (turn.canceled || this.closed) {
              canceled = true;
              break;
            }
          }
        }
        if (this.activeTurn !== turn) return;
        if (turn.canceled || canceled) {
          await this.stopCanceledClient(client);
          if (this.activeTurn !== turn) return;
          this.finishRunningTools("canceled");
        }
        if (!turn.canceled && !canceled && this.config.mode === "plan")
          turn.plan ??=
            (await readPendingPlan(this.conversationId, this.mergedEnv)) ??
            undefined;
        completed = !turn.canceled && !canceled;
        logDiagnostic("turn.settled", {
          sessionId: this.options.id,
          conversationId: this.conversationId,
          turnId: turn.id,
          attempts: turn.attempt + 1,
          state: turn.canceled || canceled ? "canceled" : "completed",
        });
        this.emit({
          type: "session.turn",
          sessionId: this.options.id,
          turnId: turn.id,
          state: turn.canceled || canceled ? "canceled" : "completed",
        });
      } catch (error) {
        if (this.activeTurn !== turn) return;
        this.closeOpenCompactionMarker(turn);
        this.finishRunningTools(turn.canceled ? "canceled" : "failed");
        logDiagnostic(
          "turn.failed",
          {
            sessionId: this.options.id,
            conversationId: this.conversationId,
            turnId: turn.id,
            attempts: turn.attempt + 1,
            canceled: turn.canceled,
          },
          error,
        );
        this.ensurePromptEcho(turn);
        this.emit({
          type: "session.turn",
          sessionId: this.options.id,
          turnId: turn.id,
          state: turn.canceled ? "canceled" : "failed",
          ...(turn.canceled ? {} : { error: providerError(error) }),
        });
      } finally {
        if (!turn.sawInbandError) this.flushHeldErrorChunk(turn);
        turn.heldErrorChunk = undefined;
        if (this.activeTurn === turn) this.activeTurn = null;
        this.cancelPendingPermissions();
        this.fallbackChunkIds.clear();
        if (turn.retried) {
          this.emit({
            type: "session.notice",
            sessionId: this.options.id,
            notice: {
              id: "auto-retry:" + turn.id,
              severity: "info",
              title: "Antigravity auto-retry finished",
              dismissed: true,
            },
          });
        }
        if (turn.canceled && turn.backgroundPhase)
          this.emit({
            type: "session.notice",
            sessionId: this.options.id,
            notice: {
              id: "background:" + turn.id,
              severity: "info",
              title: "Background waiting canceled",
              dismissed: true,
            },
          });
        turn.activity.resolve();
        turn.resolve();
        if (
          completed &&
          turn.plan &&
          this.config.mode === "plan" &&
          !this.closed
        )
          this.publishPlanApproval(turn.plan);
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
    if (
      !snapshot ||
      (turn.backgroundAfterStep !== undefined &&
        (snapshot.userStep === undefined ||
          snapshot.userStep <= turn.backgroundAfterStep))
    )
      return false;
    const published = turn.publishedBackgroundItems;
    let observation: string | undefined;
    let transcriptAvailable = true;
    const noticeId = "background:" + turn.id;
    while (this.activeTurn === turn && !turn.canceled) {
      this.hasDaemonTasks ||= snapshot.tasks.some(
        (task) => task.daemon && !task.completed,
      );
      const running = snapshot.tasks.filter(
        (task) => !task.daemon && !task.completed,
      ).length;
      let phase = "awaiting_continuation";
      if (snapshot.failure) phase = "continuation_failed";
      else if (snapshot.settled) phase = "completed";
      else if (running) phase = "task_running";
      else if (snapshot.continuationStarted) phase = "continuation_running";
      const changed = JSON.stringify([
        phase,
        snapshot.lastStep,
        snapshot.tasks.map((task) => [task.id, task.completed, task.exitCode]),
      ]);
      if (changed !== observation) {
        observation = changed;
        logDiagnostic("background.observed", {
          sessionId: this.options.id,
          conversationId: this.conversationId,
          turnId: turn.id,
          phase,
          runningTasks: running,
          completedTasks: snapshot.tasks.filter((task) => task.completed)
            .length,
          lastStep: snapshot.lastStep,
        });
      }
      if (turn.backgroundPhase !== phase) {
        turn.backgroundPhase = phase;
        const titles: Record<string, string> = {
          task_running: "Background task is running",
          awaiting_continuation:
            "Background task finished; waiting for AGY automatic continuation",
          continuation_running: "AGY automatic continuation is running",
          completed: "Background task and automatic continuation finished",
          continuation_failed: "AGY automatic continuation failed",
        };
        this.emit({
          type: "session.notice",
          sessionId: this.options.id,
          notice: {
            id: noticeId,
            severity: snapshot.failure ? "error" : "info",
            title: titles[phase]!,
          },
        });
      }
      this.bindBackgroundTaskToolCalls(turn, snapshot.tasks);
      for (const task of snapshot.tasks) {
        if (task.kind === "subagent" || (!task.completed && !task.daemon))
          continue;
        const id = turn.backgroundTaskToolCalls.get(task.id);
        if (!id) continue;
        const state = this.toolCalls.get(id);
        if (!state) continue;
        const next = {
          ...state,
          status:
            task.exitCode !== undefined && task.exitCode !== 0
              ? ("failed" as const)
              : ("completed" as const),
          rawOutput: task.output,
        };
        const item = acpToolToTimelineItem(next);
        if (item.detail.type === "shell")
          item.detail = { ...item.detail, exitCode: task.exitCode };
        const fingerprint = JSON.stringify(item);
        if (published.get("acp:" + id) !== fingerprint) {
          published.set("acp:" + id, fingerprint);
          this.toolCalls.set(id, next);
          this.emitItem(item);
        }
      }
      // ACP can go silent after its foreground response while AGY continues.
      // Send new and changed transcript items immediately, not only at final settlement.
      if (
        snapshot.continuationStep !== undefined &&
        snapshot.continuationRevision !== turn.backgroundProjectedRevision
      ) {
        const items = await readTranscriptTimeline(
          this.conversationId,
          this.mergedEnv,
          true,
        );
        if (this.activeTurn !== turn || turn.canceled) return true;
        turn.backgroundProjectedRevision = snapshot.continuationRevision;
        let updated = 0;
        for (const item of items) {
          const step = /^history:(\d+):/.exec(item.id);
          const stepIndex = step ? Number(step[1]) : Number.NaN;
          if (!step || stepIndex < snapshot.continuationStep) continue;
          if (
            item.type === "compaction" &&
            turn.emittedCompactionSteps.has(stepIndex)
          )
            continue;
          const fingerprint = JSON.stringify(item);
          if (published.get(item.id) === fingerprint) continue;
          published.set(item.id, fingerprint);
          if (item.type === "compaction" && item.status === "completed")
            turn.emittedCompactionSteps.add(stepIndex);
          this.emitItem(item);
          if (item.type === "tool_call")
            logDiagnostic("background.tool", {
              sessionId: this.options.id,
              conversationId: this.conversationId,
              turnId: turn.id,
              toolId: item.id,
              name: item.name,
              status: item.status,
            });
          updated++;
        }
        if (updated)
          logDiagnostic("background.forwarded", {
            sessionId: this.options.id,
            conversationId: this.conversationId,
            turnId: turn.id,
            items: updated,
            lastStep: snapshot.lastStep,
          });
      }
      if (snapshot.failure)
        throw new AntigravityError(
          snapshot.failure.message,
          "BACKGROUND_CONTINUATION_FAILED",
          diagnosticDetails({
            stage: "automatic_continuation",
            step: snapshot.lastStep,
            details: snapshot.failure.details,
          }),
          snapshot.failure.details,
        );
      if (snapshot.settled) {
        this.emit({
          type: "session.notice",
          sessionId: this.options.id,
          notice: {
            id: noticeId,
            severity: "info",
            title: "Background work finished",
            dismissed: true,
          },
        });
        return true;
      }
      await Promise.race([delay(250), turn.activity.promise]);
      if (this.activeTurn !== turn || turn.canceled) return true;
      turn.activity = Promise.withResolvers<void>();
      const updated = await readBackgroundTurn(
        this.conversationId,
        this.mergedEnv,
      );
      if (this.activeTurn !== turn || turn.canceled) return true;
      if (updated) {
        snapshot = updated;
        if (!transcriptAvailable)
          logDiagnostic("background.transcript_restored", {
            sessionId: this.options.id,
            conversationId: this.conversationId,
            turnId: turn.id,
          });
        transcriptAvailable = true;
      } else if (transcriptAvailable) {
        transcriptAvailable = false;
        logDiagnostic("background.transcript_unavailable", {
          sessionId: this.options.id,
          conversationId: this.conversationId,
          turnId: turn.id,
        });
      }
    }
    return true;
  }

  private bindBackgroundTaskToolCalls(
    turn: ActiveTurn,
    tasks: BackgroundTask[],
  ): void {
    const commandTasks = tasks.filter((task) => task.kind !== "subagent");
    for (const task of commandTasks) {
      if (turn.backgroundTaskToolCalls.has(task.id)) continue;
      for (const [id, state] of this.toolCalls) {
        if (turn.claimedBackgroundToolCalls.has(id)) continue;
        if (!matchesBackgroundTaskTool(task, state)) continue;
        if (extractBackgroundTaskId(state) === task.id) {
          turn.backgroundTaskToolCalls.set(task.id, id);
          turn.claimedBackgroundToolCalls.add(id);
          break;
        }
      }
    }
    for (const task of commandTasks) {
      if (turn.backgroundTaskToolCalls.has(task.id)) continue;
      for (const [id, state] of this.toolCalls) {
        if (turn.claimedBackgroundToolCalls.has(id)) continue;
        if (state.status !== "pending" && state.status !== "in_progress")
          continue;
        const explicitTaskId = extractBackgroundTaskId(state);
        if (explicitTaskId && explicitTaskId !== task.id) continue;
        if (!matchesBackgroundTaskTool(task, state)) continue;
        turn.backgroundTaskToolCalls.set(task.id, id);
        turn.claimedBackgroundToolCalls.add(id);
        break;
      }
    }
  }

  private subagentTracker(): SubagentTracker {
    if (this.subagents) return this.subagents;
    if (!this.conversationId)
      throw new AntigravityError(
        "Missing conversation for subagent history",
        "NO_CONVERSATION",
      );
    this.subagents = new SubagentTracker({
      id: this.options.id,
      conversationId: this.conversationId,
      cwd: this.config.cwd,
      env: this.mergedEnv,
      emit: (event) => this.emit(event),
      resolveCallId: (callId, args) => {
        const state = [...this.toolCalls.values()].find(
          (tool) =>
            tool.name === "invoke_subagent" &&
            !this.linkedSubagentCalls.has(tool.toolCallId) &&
            isDeepStrictEqual(tool.rawInput, args),
        );
        if (!state || !this.activeTurn) return callId;
        this.linkedSubagentCalls.add(state.toolCallId);
        const scoped = this.turnScope(this.activeTurn) + ":" + state.toolCallId;
        return scoped;
      },
    });
    return this.subagents;
  }

  private watchSubagents(): void {
    if (this.subagentWatch) return;
    const tracker = this.subagentTracker();
    this.subagentWatch = (async () => {
      while (
        !this.closed &&
        !this.restarting &&
        this.subagents === tracker &&
        this.client &&
        (this.activeTurn || tracker.running)
      ) {
        await tracker.refresh();
        await delay(250);
      }
    })()
      .catch((error) => {
        logDiagnostic(
          "subagent.history_failed",
          { sessionId: this.options.id, conversationId: this.conversationId },
          error,
        );
        this.emit({
          type: "session.notice",
          sessionId: this.options.id,
          notice: {
            id: "subagent-history",
            severity: "error",
            title: "Could not refresh Antigravity subagent history",
            description: providerError(error).message,
          },
        });
      })
      .finally(() => {
        this.subagentWatch = null;
      });
  }

  private async waitForSubagents(turn: ActiveTurn): Promise<void> {
    const tracker = this.subagentTracker();
    await tracker.refresh();
    while (this.activeTurn === turn && !turn.canceled && tracker.running) {
      await Promise.race([delay(250), turn.activity.promise]);
      if (this.activeTurn !== turn || turn.canceled) return;
      turn.activity = Promise.withResolvers<void>();
      await tracker.refresh();
    }
  }

  private async waitForTurnTools(turn: ActiveTurn): Promise<void> {
    while (
      this.activeTurn === turn &&
      !turn.canceled &&
      this.hasRunningTools()
    ) {
      turn.activity = Promise.withResolvers<void>();
      await Promise.race([delay(250), turn.activity.promise]);
      if (this.activeTurn === turn && !turn.canceled)
        await this.waitForBackgroundTurn(turn);
    }
  }

  private hasRunningTools(): boolean {
    return [...this.toolCalls.values()].some(
      (tool) => tool.status === "pending" || tool.status === "in_progress",
    );
  }

  private async stopCanceledClient(client: AcpClient): Promise<void> {
    // Canceling after the ACP prompt response must also stop its background work.
    await client.close();
    this.subagents?.finish("canceled");
    if (this.client === client) {
      this.client = null;
      this.hasDaemonTasks = false;
    }
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
      if (
        this.client === client &&
        client.skipPermissions !== selection.autoApproveAll &&
        !this.activeTurn &&
        !this.hasRunningTools() &&
        !this.hasDaemonTasks &&
        !this.subagents?.running &&
        this.pendingPermissions.size === 0
      ) {
        await this.restartClientForPermissions(client);
      }
    } finally {
      // A multi-option ACP change can partially commit before a later option fails.
      this.publishConfig();
      this.publishPersistence();
    }
  }

  private publishPlanApproval(plan: PlanProposal): void {
    const revision = createHash("sha256").update(plan.text).digest("hex");
    if (
      revision === this.resolvedPlanRevision ||
      this.planApproval?.plan.text === plan.text
    )
      return;
    this.dismissPlanApproval();
    const id = "plan-approval:" + randomUUID();
    this.planApproval = { id, plan };
    this.emitItem({
      type: "tool_call",
      id,
      callId: id,
      name: "plan_approval",
      status: "running",
      error: null,
      detail: { type: "plan", text: plan.text },
    });
    this.emit({
      type: "session.permission",
      sessionId: this.options.id,
      request: {
        id,
        name: "AntigravityPlanApproval",
        kind: "plan",
        title: "Implementation plan",
        description: plan.summary,
        input: { plan: plan.text },
        detail: { type: "plan", text: plan.text },
        metadata: {
          planText: plan.text,
          source: "antigravity_artifact_feedback",
        },
        actions: [
          {
            id: "implement",
            label: "Approve and implement",
            behavior: "allow",
            variant: "primary",
            intent: "implement",
          },
          {
            id: "dismiss",
            label: "Keep planning",
            behavior: "deny",
            variant: "secondary",
            intent: "dismiss",
          },
        ],
      },
    });
  }

  private dismissPlanApproval(
    status: "completed" | "canceled" = "canceled",
    resolved = false,
  ): void {
    const approval = this.planApproval;
    if (!approval) return;
    this.planApproval = null;
    if (resolved) {
      this.resolvedPlanRevision = createHash("sha256")
        .update(approval.plan.text)
        .digest("hex");
      this.publishPersistence();
    }
    this.emitItem({
      type: "tool_call",
      id: approval.id,
      callId: approval.id,
      name: "plan_approval",
      status,
      error: null,
      detail: { type: "plan", text: approval.plan.text },
    });
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.options.id,
      permissionId: approval.id,
    });
  }

  async answerPermission(
    permissionId: string,
    response: ProviderPermissionResponse,
  ): Promise<void> {
    const asked = [...this.askQuestions.entries()].find(
      ([, question]) => question.permissionId === permissionId,
    );
    if (asked) {
      const [toolCallId, question] = asked;
      this.askQuestions.delete(toolCallId);
      this.emit({
        type: "session.permission_resolved",
        sessionId: this.options.id,
        permissionId,
      });
      const text = askAnswerText(response, question.questions);
      if (!text) return;
      const turn = this.activeTurn;
      void (turn ? turn.completion : Promise.resolve())
        .then(() => {
          if (this.closed) return;
          return this.prompt({
            clientMessageId: randomUUID(),
            delivery: "auto",
            input: {
              type: "message",
              content: [{ type: "text", text }],
            },
          });
        })
        .catch((error: unknown) => {
          logDiagnostic(
            "ask_question.answer_failed",
            { sessionId: this.options.id, conversationId: this.conversationId },
            error,
          );
          this.emit({
            type: "session.runtime_failed",
            sessionId: this.options.id,
            error: providerError(error),
          });
        });
      return;
    }
    const approval = this.planApproval;
    if (approval?.id === permissionId) {
      const expected = response.behavior === "allow" ? "implement" : "dismiss";
      if (response.selectedActionId && response.selectedActionId !== expected)
        throw new AntigravityError(
          "Invalid plan approval action",
          "INVALID_PERMISSION_ACTION",
        );
      if (response.behavior === "deny") {
        this.dismissPlanApproval("canceled", true);
        return;
      }
      // Do not publish approval success until the native session accepts leaving plan mode.
      await this.configure({ mode: "default" });
      if (this.planApproval !== approval || this.closed)
        throw new AntigravityError(
          "Plan approval was superseded",
          "PLAN_SUPERSEDED",
        );
      this.dismissPlanApproval("completed", true);
      const prompt: ProviderPrompt = {
        clientMessageId: randomUUID(),
        delivery: "auto",
        input: {
          type: "message",
          content: [
            {
              type: "text",
              text:
                "The user approved this implementation plan. Implement it and run its verification steps.\n\n" +
                approval.plan.text,
            },
          ],
        },
      };
      void this.prompt(prompt).catch((error) => {
        logDiagnostic(
          "plan.implementation_failed",
          { sessionId: this.options.id, conversationId: this.conversationId },
          error,
        );
        this.emit({
          type: "session.runtime_failed",
          sessionId: this.options.id,
          error: providerError(error),
        });
      });
      return;
    }
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
    this.dismissPlanApproval();
    this.restarting = true;
    this.subagents?.finish("canceled");
    this.subagents = null;
    try {
      await this.subagentWatch;
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
          this.hasDaemonTasks = false;
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
    if (!turn || !this.conversationId) return;
    logDiagnostic("turn.interrupt_requested", {
      sessionId: this.options.id,
      conversationId: this.conversationId,
      turnId: turn.id,
      backgroundPhase: turn.backgroundPhase,
    });
    turn.canceled = true;
    turn.activity.resolve();
    this.cancelPendingPermissions();
    if (!client) {
      await turn.completion;
      return;
    }
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
    this.dismissPlanApproval();
    this.subagents?.finish("canceled");
    this.closed = true;
    logDiagnostic("session.close_requested", {
      sessionId: this.options.id,
      conversationId: this.conversationId,
      turnId: this.activeTurn?.id,
    });
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

  private shouldSkipPermissions(
    config: ProviderSessionConfig = this.config,
  ): boolean {
    return normalizeSelection(config, this.sessionCatalog).autoApproveAll;
  }

  private async restartClientForPermissions(client: AcpClient): Promise<void> {
    if (this.client !== client) return;
    this.restarting = true;
    try {
      await this.recycleClientForRetry(client);
      await this.startAcpClient("skip");
    } finally {
      this.restarting = false;
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
      skipPermissions: this.shouldSkipPermissions(),
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
          const [{ userStepIndices }, compactions] = await Promise.all([
            readUserStepIndices(this.conversationId, this.mergedEnv),
            readTranscriptCompactionSteps(
              this.conversationId,
              this.mergedEnv,
            ).catch(() => []),
          ]);
          this.replayUserStepIndices = userStepIndices;
          this.replayUserTurnCount = 0;
          this.replayCompactions = compactions.filter(
            (step) => step.status === "completed",
          );
          this.replayCompactionCursor = 0;
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
          if (historyMode === "replay") {
            if (this.bufferedReplayItems.length === 0) {
              await this.replayTranscriptHistory();
            } else {
              this.flushReplayCompactionsBefore(Number.POSITIVE_INFINITY);
            }
          }
        } finally {
          this.replayMode = "none";
          this.replayCompactions = [];
          this.replayCompactionCursor = 0;
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
      await this.subagentWatch;
      await this.subagents?.resume();
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
        this.echoLiveUserChunk(update);
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
      if (kind === "agent_thought_chunk" && this.activeTurn) {
        if (this.replayMode === "none" && this.activeTurn.heldErrorChunk) {
          this.flushHeldErrorChunk(this.activeTurn);
        }
        this.flushDeferredAssistantItems(this.activeTurn);
      }
      const msgId =
        typeof update.messageId === "string" ? update.messageId : undefined;
      const id = this.resolveChunkId(kind, msgId);
      if (
        kind === "agent_message_chunk" &&
        this.replayMode === "none" &&
        this.activeTurn
      ) {
        if (
          this.activeTurn.heldErrorChunk &&
          this.activeTurn.heldErrorChunk.id !== id
        ) {
          this.flushHeldErrorChunk(this.activeTurn);
        }
        const existingText = this.messages.get(id);
        const heldBase =
          this.activeTurn.heldErrorChunk?.id === id
            ? this.activeTurn.heldErrorChunk.text
            : (existingText ?? "");
        const candidate = `${heldBase}${content.text}`;
        if (existingText === undefined) {
          if (INBAND_EXECUTION_ERROR_RE.test(candidate.trim())) {
            this.activeTurn.heldErrorChunk = { id, text: candidate };
            this.activeTurn.sawInbandError = true;
            return;
          }
          if (isInbandExecutionErrorPrefix(candidate)) {
            this.activeTurn.heldErrorChunk = { id, text: candidate };
            return;
          }
        } else if (INBAND_EXECUTION_ERROR_RE.test(content.text.trim())) {
          this.activeTurn.heldErrorChunk = { id, text: candidate };
          this.activeTurn.sawInbandError = true;
          return;
        }
        if (this.activeTurn.heldErrorChunk) {
          this.flushHeldErrorChunk(this.activeTurn);
        }
      }
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
      if (
        kind === "agent_message_chunk" &&
        this.replayMode === "none" &&
        this.activeTurn
      ) {
        if (isPotentialTerminatedBanner(text)) {
          this.activeTurn.deferredAssistantItems.set(id, item);
          return;
        }
        this.activeTurn.deferredAssistantItems.delete(id);
      }
      this.recordOrEmitTimelineItem(item);
      return;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      if (this.replayMode === "none" && this.activeTurn?.heldErrorChunk) {
        this.flushHeldErrorChunk(this.activeTurn);
      }
      if (this.activeTurn) {
        this.flushDeferredAssistantItems(this.activeTurn);
      }
      if (kind === "tool_call") {
        this.fallbackChunkIds.clear();
      }
      const toolCallId =
        typeof update.toolCallId === "string" ? update.toolCallId : "tool";
      const current = this.toolCalls.get(toolCallId);
      if (kind === "tool_call") this.retiredToolCalls.delete(toolCallId);
      if (
        kind === "tool_call_update" &&
        !current &&
        this.retiredToolCalls.has(toolCallId)
      )
        return;
      // A delayed update must not reopen an already terminal tool in this turn.
      if (
        kind === "tool_call_update" &&
        current &&
        (current.status === "completed" || current.status === "failed") &&
        (update.status === "pending" || update.status === "in_progress")
      )
        return;
      const merged = mergeAcpToolCall(update, current);
      if (merged.kind === "execute" || merged.name === "run_command")
        await this.rewindTracker.recordShellOperation();
      if (this.replayMode === "none" && this.activeTurn) {
        this.classifyAttemptTool(this.activeTurn, merged);
      }
      this.toolCalls.set(merged.toolCallId, merged);
      if (
        merged.name === "ask_question" &&
        this.replayMode === "none" &&
        this.activeTurn
      )
        this.openAskQuestion(merged);
      if (this.activeTurn && this.config.mode === "plan" && this.conversationId)
        this.activeTurn.plan =
          planFromTool(merged, this.conversationId, this.mergedEnv) ??
          this.activeTurn.plan;
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
      if (
        merged.name === "invoke_subagent" &&
        this.opened &&
        this.replayMode === "none"
      )
        this.watchSubagents();
      return;
    }

    if (kind === "compaction_update") {
      const rawId =
        typeof update.compactionId === "string" && update.compactionId
          ? update.compactionId
          : "acp-compaction";
      const rawStatus =
        typeof update.status === "string" ? update.status : "completed";
      if (
        rawStatus === "failed" ||
        rawStatus === "error" ||
        rawStatus === "cancelled" ||
        rawStatus === "canceled"
      ) {
        if (this.activeTurn) this.closeOpenCompactionMarker(this.activeTurn);
        return;
      }
      const status =
        rawStatus === "in_progress" ||
        rawStatus === "pending" ||
        rawStatus === "running" ||
        rawStatus === "loading"
          ? "loading"
          : "completed";
      const meta =
        typeof update._meta === "object" && update._meta !== null
          ? (update._meta as Record<string, unknown>)
          : {};
      const trigger =
        meta.trigger === "manual" || update.trigger === "manual"
          ? "manual"
          : "auto";
      const preTokens =
        typeof update.preTokens === "number"
          ? update.preTokens
          : typeof meta.preTokens === "number"
            ? meta.preTokens
            : undefined;
      const scopedId = this.activeTurn
        ? `${this.turnScope(this.activeTurn)}:compaction:${rawId}`
        : `history:compaction:${rawId}`;
      if (status === "loading") {
        if (this.replayMode === "replay") return;
        if (this.activeTurn) {
          this.openCompactionMarker(this.activeTurn, scopedId, trigger);
        }
        return;
      }
      if (this.activeTurn) {
        this.activeTurn.compactionMarkerOpen = false;
        this.activeTurn.openCompactionId = undefined;
        this.activeTurn.openCompactionTrigger = undefined;
      }
      this.recordOrEmitTimelineItem({
        type: "compaction",
        id: scopedId,
        status: "completed",
        trigger,
        ...(preTokens !== undefined ? { preTokens } : {}),
      });
      return;
    }

    if (kind === "plan") {
      if (this.activeTurn) {
        this.flushDeferredAssistantItems(this.activeTurn);
      }
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
    const userStep = this.replayUserStepIndices[turnIndex];
    if (userStep !== undefined) {
      this.flushReplayCompactionsBefore(userStep);
    }
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
    if (userStep !== undefined) {
      const isManualCompact = /^\/compact(?:\s|$)/i.test(text.trim());
      this.flushReplayCompactionsBefore(
        userStep + 2,
        isManualCompact ? "manual" : undefined,
      );
    }
  }

  private flushReplayCompactionsBefore(
    exclusiveStepIndex: number,
    overrideTrigger?: "auto" | "manual",
  ): void {
    while (this.replayCompactionCursor < this.replayCompactions.length) {
      const compaction = this.replayCompactions[this.replayCompactionCursor]!;
      if (compaction.stepIndex >= exclusiveStepIndex) break;
      this.replayCompactionCursor++;
      this.bufferedReplayItems.push({
        type: "compaction",
        id: `history:${compaction.stepIndex}:compaction`,
        status: "completed",
        trigger: overrideTrigger ?? compaction.trigger,
        ...(compaction.preTokens !== undefined
          ? { preTokens: compaction.preTokens }
          : {}),
        timestamp: compaction.timestamp,
      });
    }
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
    logDiagnostic(
      "session.runtime_failed",
      {
        sessionId: this.options.id,
        conversationId: this.conversationId,
        turnId: this.activeTurn?.id,
      },
      error,
    );
    this.client = null;
    this.hasDaemonTasks = false;
    this.cancelPendingPermissions();
    if (this.activeTurn?.awaitingPromptResponse) {
      // Let Session.prompt() handle the rejected session/prompt RPC so transient
      // crashes can auto-rewind and retry before settling the turn.
      this.activeTurn.activity.resolve();
      return;
    }
    this.subagents?.finish("failed");
    if (this.activeTurn) {
      const turnId = this.activeTurn.id;
      this.closeOpenCompactionMarker(this.activeTurn);
      this.activeTurn.activity.resolve();
      this.activeTurn.resolve();
      this.activeTurn = null;
      this.finishRunningTools("failed");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId,
        state: "failed",
        error: providerError(error),
      });
    } else {
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.options.id,
        error: providerError(error),
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

  private ensurePromptEcho(turn: ActiveTurn): void {
    if (turn.userEchoed || !turn.promptText) return;
    this.emitPromptEcho(turn, turn.promptText);
  }

  private emitPromptEcho(turn: ActiveTurn, text: string): void {
    if (!text) return;
    turn.userEchoed = true;
    turn.userEchoText = text;
    this.emitItem({
      type: "user_message",
      id: turn.clientMessageId,
      messageId: turn.clientMessageId,
      clientMessageId: turn.clientMessageId,
      text,
      revertToken: turn.revertToken,
    });
  }

  private echoLiveUserChunk(update: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn || this.replayMode === "replay") return;
    const content =
      typeof update.content === "object" && update.content !== null
        ? (update.content as Record<string, unknown>)
        : {};
    if (content.type !== "text" || typeof content.text !== "string") return;
    this.emitPromptEcho(turn, `${turn.userEchoText}${content.text}`);
  }

  private openAskQuestion(tool: AcpToolCallState): void {
    if (this.askQuestions.has(tool.toolCallId)) return;
    const questions = parseAskQuestions(tool.rawInput);
    if (!questions.length) return;
    const permissionId = "ask:" + tool.toolCallId;
    this.askQuestions.set(tool.toolCallId, { permissionId, questions });
    this.emit({
      type: "session.permission",
      sessionId: this.options.id,
      request: {
        id: permissionId,
        name: "ask_question",
        kind: "question",
        title: questions.length === 1 ? questions[0]!.question : "Question",
        input: {
          questions: questions.map((question, index) => ({
            question: question.question,
            header:
              questions.length === 1 ? "Response" : `Question ${index + 1}`,
            options: question.options.map((label) => ({ label })),
            multiSelect: question.isMultiSelect,
          })),
        },
      },
    });
  }

  private resolveChunkId(kind: string, messageId?: string): string {
    const scope = this.activeTurn ? this.turnScope(this.activeTurn) : "history";
    if (messageId) {
      this.fallbackChunkIds.delete(kind);
      return `${scope}:${kind}:${messageId}`;
    }
    let id = this.fallbackChunkIds.get(kind);
    if (!id) {
      id = `${scope}:${kind}:${++this.chunkSequence}`;
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
        ...(this.resolvedPlanRevision
          ? { resolvedPlanRevision: this.resolvedPlanRevision }
          : {}),
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
      const scope = this.turnScope(this.activeTurn);
      timelineItem.id = scope + ":" + timelineItem.id;
      timelineItem.callId = scope + ":" + timelineItem.callId;
    }
    this.emit({
      type: "timeline.item",
      sessionId: this.options.id,
      item: timelineItem,
      timestamp,
    });
  }

  private turnScope(turn: ActiveTurn): string {
    return turn.attempt > 0 ? `${turn.id}:r${turn.attempt}` : turn.id;
  }

  private resetAttemptState(turn: ActiveTurn): void {
    turn.hasUnrevertableTool = false;
    turn.hasFileModification = false;
    turn.heldErrorChunk = undefined;
    turn.sawInbandError = false;
    turn.deferredAssistantItems.clear();
    turn.backgroundProjectedRevision = undefined;
    turn.backgroundTaskToolCalls.clear();
    turn.claimedBackgroundToolCalls.clear();
    turn.publishedBackgroundItems.clear();
    turn.plan = undefined;
    this.messages.clear();
    for (const id of this.toolCalls.keys()) this.retiredToolCalls.add(id);
    this.toolCalls.clear();
    this.linkedSubagentCalls.clear();
    this.fallbackChunkIds.clear();
  }

  private autoRetryMax(): number {
    const raw = this.mergedEnv.PASEO_AGY_AUTO_RETRY_MAX;
    if (raw === undefined || raw.trim() === "") return DEFAULT_AUTO_RETRY_MAX;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AUTO_RETRY_MAX;
    return Math.min(Math.trunc(parsed), 10);
  }

  private autoRetryDelayMs(): number {
    const raw = this.mergedEnv.PASEO_AGY_AUTO_RETRY_DELAY_MS;
    if (raw === undefined || raw.trim() === "")
      return DEFAULT_AUTO_RETRY_DELAY_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0)
      return DEFAULT_AUTO_RETRY_DELAY_MS;
    return Math.min(Math.trunc(parsed), 30000);
  }

  private detectSilentTurnError(
    attemptStartStepIndex: number,
  ): AntigravityError | null {
    if (!this.conversationId) return null;
    const dbTurnError = readConversationTurnError(
      this.conversationId,
      attemptStartStepIndex,
      this.mergedEnv,
    );
    if (dbTurnError) {
      return new AntigravityError(
        dbTurnError.userMessage,
        "EXECUTION_TERMINATED",
        diagnosticDetails({
          step: dbTurnError.stepIndex,
          shortError: dbTurnError.shortError,
          httpStatus: dbTurnError.httpStatus,
          details: dbTurnError.details,
          fullError: dbTurnError.fullError,
        }),
        dbTurnError,
      );
    }
    const assistantTexts = [...this.messages.entries()]
      .filter(([key]) => key.includes(":agent_message_chunk:"))
      .map(([, value]) => value.trim())
      .filter((value) => value.length > 0);
    if (
      this.toolCalls.size === 0 &&
      assistantTexts.length > 0 &&
      assistantTexts.every((value) => value === TERMINATED_ERROR_TEXT)
    ) {
      return new AntigravityError(
        TERMINATED_ERROR_TEXT,
        "EXECUTION_TERMINATED",
      );
    }
    return null;
  }

  private canAutoRetryAttempt(
    error: unknown,
    turn: ActiveTurn,
    maxRetries: number,
  ): boolean {
    if (this.closed || turn.canceled || !this.conversationId) return false;
    if (turn.attempt >= maxRetries) return false;
    return (
      error instanceof AntigravityError &&
      error.code === "EXECUTION_TERMINATED" &&
      isTransientRetryableError(error)
    );
  }

  private describeRetryReason(error: unknown): string {
    if (
      error instanceof AntigravityError &&
      error.data &&
      typeof error.data === "object" &&
      "shortError" in error.data &&
      typeof error.data.shortError === "string" &&
      error.data.shortError.trim()
    ) {
      return providerError(
        new AntigravityError(error.data.shortError, error.code),
      ).message;
    }
    return providerError(error).message;
  }

  private async recycleClientForRetry(client: AcpClient): Promise<void> {
    if (this.client === client) {
      this.client = null;
      this.hasDaemonTasks = false;
    }
    if (this.conversationId) {
      await client
        .request("session/close", { sessionId: this.conversationId }, 1000)
        .catch(() => undefined);
    }
    await client.close().catch(() => undefined);
  }

  private classifyAttemptTool(turn: ActiveTurn, tool: AcpToolCallState): void {
    const name = tool.name ?? "";
    const rawInput =
      tool.rawInput &&
      typeof tool.rawInput === "object" &&
      !Array.isArray(tool.rawInput)
        ? tool.rawInput
        : null;
    const action =
      rawInput && typeof rawInput.Action === "string" ? rawInput.Action : "";
    const isReadOnlyTaskQuery =
      (name === "manage_task" && (action === "list" || action === "status")) ||
      (name === "manage_subagents" && action === "list");
    if (
      tool.kind === "read" ||
      tool.kind === "search" ||
      tool.kind === "think" ||
      READ_ONLY_TOOL_NAMES.has(name) ||
      isReadOnlyTaskQuery
    ) {
      return;
    }
    const modifiedPaths = extractModifiedFilePaths(tool);
    if (
      (tool.kind === "edit" || FILE_EDIT_TOOL_NAMES.has(name)) &&
      modifiedPaths.length > 0
    ) {
      turn.hasFileModification = true;
      return;
    }
    turn.hasUnrevertableTool = true;
  }

  private flushHeldErrorChunk(turn: ActiveTurn | null = this.activeTurn): void {
    const held = turn?.heldErrorChunk;
    if (!held || !turn) return;
    turn.heldErrorChunk = undefined;
    turn.sawInbandError = false;
    this.messages.set(held.id, held.text);
    this.recordOrEmitTimelineItem({
      type: "assistant_message",
      id: held.id,
      messageId: held.id,
      text: held.text,
    });
  }

  private flushDeferredAssistantItems(turn: ActiveTurn): void {
    for (const item of turn.deferredAssistantItems.values()) {
      this.recordOrEmitTimelineItem(item);
    }
    turn.deferredAssistantItems.clear();
  }

  private flushNonErrorDeferredAssistantItems(turn: ActiveTurn): void {
    for (const item of turn.deferredAssistantItems.values()) {
      if (
        item.type === "assistant_message" &&
        item.text.trim() === TERMINATED_ERROR_TEXT
      ) {
        continue;
      }
      this.recordOrEmitTimelineItem(item);
    }
    turn.deferredAssistantItems.clear();
  }

  private openCompactionMarker(
    turn: ActiveTurn,
    id: string,
    trigger: "auto" | "manual",
  ): void {
    if (turn.compactionMarkerOpen) return;
    turn.compactionMarkerOpen = true;
    turn.openCompactionId = id;
    turn.openCompactionTrigger = trigger;
    this.emitItem({
      type: "compaction",
      id,
      status: "loading",
      trigger,
    });
  }

  private closeOpenCompactionMarker(turn: ActiveTurn): void {
    if (!turn.compactionMarkerOpen) return;
    const id =
      turn.openCompactionId ?? `${this.turnScope(turn)}:compaction:resolved`;
    const trigger = turn.openCompactionTrigger ?? "auto";
    turn.compactionMarkerOpen = false;
    turn.openCompactionId = undefined;
    turn.openCompactionTrigger = undefined;
    this.emitItem({
      type: "compaction",
      id,
      status: "completed",
      trigger,
    });
  }

  private async watchLiveCompactions(
    turn: ActiveTurn,
    minStepIndex: number,
    manualCompact: boolean,
    shouldStop: () => boolean,
  ): Promise<void> {
    while (
      !shouldStop() &&
      !this.closed &&
      this.activeTurn === turn &&
      !turn.canceled
    ) {
      await this.syncLiveCompactions(turn, minStepIndex, manualCompact);
      if (shouldStop() || this.activeTurn !== turn || turn.canceled) return;
      const activity = turn.activity.promise;
      await Promise.race([delay(LIVE_COMPACTION_POLL_MS), activity]);
      if (this.activeTurn === turn && turn.activity.promise === activity) {
        turn.activity = Promise.withResolvers<void>();
      }
    }
  }

  private async syncLiveCompactions(
    turn: ActiveTurn,
    minStepIndex: number,
    manualCompact: boolean,
  ): Promise<void> {
    if (!this.conversationId || this.activeTurn !== turn) return;
    let steps: TranscriptCompactionStep[];
    try {
      steps = await readTranscriptCompactionSteps(
        this.conversationId,
        this.mergedEnv,
        minStepIndex,
      );
    } catch {
      return;
    }
    if (this.activeTurn !== turn) return;
    for (const step of steps) {
      if (turn.emittedCompactionSteps.has(step.stepIndex)) continue;
      const id = `history:${step.stepIndex}:compaction`;
      const trigger = manualCompact ? "manual" : step.trigger;
      if (step.status === "loading") {
        this.openCompactionMarker(turn, id, trigger);
        continue;
      }
      turn.emittedCompactionSteps.add(step.stepIndex);
      turn.compactionMarkerOpen = false;
      turn.openCompactionId = undefined;
      turn.openCompactionTrigger = undefined;
      this.emitItem({
        type: "compaction",
        id,
        status: "completed",
        trigger,
        ...(step.preTokens !== undefined ? { preTokens: step.preTokens } : {}),
        timestamp: step.timestamp,
      });
    }
  }

  private emit(event: ProviderEvent): void {
    if (!this.closed) this.options.emit(event);
  }
}

interface AskQuestion {
  question: string;
  options: string[];
  isMultiSelect: boolean;
}

function parseAskQuestions(raw: JsonValue): AskQuestion[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const list = raw.questions;
  if (!Array.isArray(list)) return [];
  const questions: AskQuestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const question = item.question;
    const options = item.options;
    if (
      typeof question !== "string" ||
      !question.trim() ||
      !Array.isArray(options)
    )
      continue;
    const labels = options.filter(
      (option): option is string =>
        typeof option === "string" && option.length > 0,
    );
    if (labels.length < 2) continue;
    questions.push({
      question: question.trim(),
      options: labels,
      isMultiSelect: item.is_multi_select === true,
    });
  }
  return questions;
}

function askAnswerText(
  response: ProviderPermissionResponse,
  questions: AskQuestion[],
): string | null {
  if (response.behavior !== "allow") return null;
  const answers = response.updatedInput?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers))
    return null;
  const parts = questions
    .map((question, index) => {
      const header =
        questions.length === 1 ? "Response" : `Question ${index + 1}`;
      const value = answers[header];
      if (typeof value === "string") return value.trim();
      if (Array.isArray(value))
        return value
          .filter((entry): entry is string => typeof entry === "string")
          .join(", ");
      return "";
    })
    .filter((part) => part.length > 0);
  return parts.length ? parts.join("\n") : null;
}

function isPotentialTerminatedBanner(text: string): boolean {
  const trimmedStart = text.trimStart();
  if (trimmedStart.length === 0) return true;
  if (TERMINATED_ERROR_TEXT.startsWith(trimmedStart)) return true;
  return trimmedStart.trimEnd() === TERMINATED_ERROR_TEXT;
}

function isTransientRetryableError(error: unknown): boolean {
  if (!(error instanceof AntigravityError)) return false;
  const retryableCode =
    error.code === "EXECUTION_TERMINATED" ||
    error.code === "PROCESS_EXITED" ||
    error.code === "TRANSPORT_ERROR" ||
    error.code === "RPC_-32603" ||
    error.code === "RPC_-32000";
  if (!retryableCode) return false;
  const haystack = [error.message, error.diagnostic ?? ""].join("\n");
  if (NON_RETRYABLE_ERROR_PATTERN.test(haystack)) return false;
  return true;
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

function extractBackgroundTaskId(state: AcpToolCallState): string | undefined {
  for (const candidate of [state.rawOutput, state.textContent]) {
    if (typeof candidate !== "string") continue;
    const match =
      /Tool is running as a background task with task id:\s*([\w-]+\/task-\d+)/.exec(
        candidate,
      );
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function matchesBackgroundTaskTool(
  task: BackgroundTask,
  state: AcpToolCallState,
): boolean {
  const input = state.rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  if (task.toolName === "schedule") {
    return (
      state.name === "schedule" &&
      (input.Prompt === task.prompt || input.Prompt === task.command)
    );
  }
  return state.name === "run_command" && input.CommandLine === task.command;
}
