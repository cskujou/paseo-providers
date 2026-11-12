import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class AntigravityError extends Error {
  constructor(
    message: string,
    readonly code = "ANTIGRAVITY_ERROR",
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "AntigravityError";
  }
}

export function formatDiagnostic(message: string): string {
  if (/auth|sign.in|log.in|unauthenticated|credential/i.test(message)) {
    return "Antigravity authentication failed. Run `agy` and sign in, then retry.";
  }
  return message;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpPermissionRequestParams {
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: AcpPermissionOption[];
}

export interface AcpPermissionOutcome {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: Record<string, unknown>;
}

interface PendingRpc {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface AcpClientOptions {
  launch: ProviderLaunch;
  cwd?: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  onSessionUpdate?(params: AcpSessionUpdateParams): void | Promise<void>;
  onPermissionRequest?(params: AcpPermissionRequestParams): Promise<AcpPermissionOutcome>;
  onExit?(error: AntigravityError): void;
}

export class AcpClient {
  private readonly child;
  private readonly pending = new Map<string | number, PendingRpc>();
  private sequence = 0;
  private stderr = "";
  private failure: AntigravityError | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly exited: Promise<void>;
  public agentCapabilities: Record<string, unknown> = {};
  public agentVersion = "";

  constructor(private readonly options: AcpClientOptions) {
    const { launch, cwd, env } = options;
    this.child = spawnProcess(launch.command, [...launch.args, "acp"], {
      env: { ...launch.env, ...env },
      cwd,
      stdio: "pipe",
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        this.handleFrame(parsed);
      } catch {
        // Ignore non-JSON diagnostic lines on stdout if any
      }
    });

    this.child.stdin.on("error", () => {
      // Handled by process close
    });

    this.child.on("error", (err) => {
      this.fail(new AntigravityError(`Failed to spawn agy acp: ${err.message}`, "SPAWN_FAILED"));
    });

    this.exited = new Promise<void>((resolve) => {
      this.child.once("close", (code, signal) => {
        lines.close();
        const detail = this.stderr.trim();
        const msg = detail
          ? formatDiagnostic(detail)
          : `Antigravity ACP exited (${signal ?? code ?? "unknown"})`;
        this.fail(new AntigravityError(msg, "PROCESS_EXITED", detail || undefined));
        resolve();
      });
    });
  }

  async initialize(): Promise<void> {
    const res = await this.request<Record<string, unknown>>(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "paseo", version: "0.14.0" },
        capabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          elicitation: { form: {} },
        },
      },
      this.options.startupTimeoutMs ?? 15000,
    );
    if (typeof res.agentCapabilities === "object" && res.agentCapabilities !== null) {
      this.agentCapabilities = res.agentCapabilities as Record<string, unknown>;
    }
    if (typeof res.agentInfo === "object" && res.agentInfo !== null) {
      const info = res.agentInfo as Record<string, unknown>;
      if (typeof info.version === "string") {
        this.agentVersion = info.version;
      }
    }
  }

  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number | null = 30000,
  ): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.closing) throw new AntigravityError("Antigravity ACP connection is closing", "CLOSED");

    const id = ++this.sequence;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs !== null && timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new AntigravityError(`Antigravity ACP ${method} timed out`, "TIMEOUT"));
            }, timeoutMs)
          : null;
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });

    return result as T;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new AntigravityError("Antigravity ACP closed", "CLOSED"));
    }
    this.pending.clear();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    try {
      this.child.stdin.end();
    } catch {
      // Ignore stdin close error
    }
    const drained = await Promise.race([
      this.exited.then(() => true),
      delay(800, undefined, { ref: false }).then(() => false),
    ]);
    if (drained) return;

    await terminateProcess(this.child, "SIGTERM").catch(() => undefined);
    const terminated = await Promise.race([
      this.exited.then(() => true),
      delay(1200, undefined, { ref: false }).then(() => false),
    ]);
    if (terminated) return;

    await terminateProcess(this.child).catch(() => undefined);
    await Promise.race([
      this.exited,
      delay(1000, undefined, { ref: false }),
    ]);
  }

  private write(frame: Record<string, unknown>): void {
    if (this.closing) return;
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // Process exit handles broken pipe
    }
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const method = typeof frame.method === "string" ? frame.method : undefined;
    const hasId = frame.id !== undefined && frame.id !== null;

    if (method && hasId) {
      const requestId = frame.id as string | number;
      const params = (frame.params ?? {}) as Record<string, unknown>;
      void this.handleServerRequest(requestId, method, params);
      return;
    }

    if (method && !hasId) {
      const params = (frame.params ?? {}) as Record<string, unknown>;
      if (method === "session/update" && this.options.onSessionUpdate) {
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
        const update =
          typeof params.update === "object" && params.update !== null
            ? (params.update as Record<string, unknown>)
            : {};
        void Promise.resolve(this.options.onSessionUpdate({ sessionId, update })).catch(() => {
          // Swallow notification handler errors
        });
      }
      return;
    }

    if (hasId) {
      const id = frame.id as string | number;
      const pending = this.pending.get(id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(id);

      if (frame.error && typeof frame.error === "object") {
        const errObj = frame.error as Record<string, unknown>;
        const message =
          typeof errObj.message === "string" ? errObj.message : "Antigravity ACP request failed";
        pending.reject(
          new AntigravityError(formatDiagnostic(message), `RPC_${String(errObj.code ?? "ERROR")}`),
        );
      } else {
        pending.resolve(frame.result);
      }
    }
  }

  private async handleServerRequest(
    requestId: string | number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method === "session/request_permission" && this.options.onPermissionRequest) {
      try {
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
        const toolCall =
          typeof params.toolCall === "object" && params.toolCall !== null
            ? (params.toolCall as Record<string, unknown>)
            : {};
        const rawOptions = Array.isArray(params.options) ? params.options : [];
        const options: AcpPermissionOption[] = rawOptions.map((opt) => {
          const rec = typeof opt === "object" && opt !== null ? (opt as Record<string, unknown>) : {};
          return {
            optionId: typeof rec.optionId === "string" ? rec.optionId : "",
            name: typeof rec.name === "string" ? rec.name : "Allow",
            kind: typeof rec.kind === "string" ? rec.kind : "allow_once",
          };
        });
        const outcome = await this.options.onPermissionRequest({
          sessionId,
          toolCall,
          options,
        });
        this.write({ jsonrpc: "2.0", id: requestId, result: outcome });
      } catch {
        this.write({
          jsonrpc: "2.0",
          id: requestId,
          result: { outcome: { outcome: "cancelled" } },
        });
      }
      return;
    }

    this.write({
      jsonrpc: "2.0",
      id: requestId,
      error: { code: -32601, message: `Unsupported client method: ${method}` },
    });
  }

  private fail(error: AntigravityError): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing && this.options.onExit) {
      this.options.onExit(error);
    }
  }
}
