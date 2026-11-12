import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

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
    return "Antigravity authentication failed. Run agy and sign in, then retry.";
  }
  return message;
}

const permissionRequestSchema = z.object({
  sessionId: z.string().min(1),
  toolCall: z.record(z.string(), z.unknown()),
  options: z.array(
    z.object({
      optionId: z.string().min(1),
      name: z.string(),
      kind: z.enum([
        "allow_once",
        "allow_always",
        "reject_once",
        "reject_always",
      ]),
    }),
  ),
});
const sessionUpdateSchema = z.object({
  sessionId: z.string().min(1),
  update: z.record(z.string(), z.unknown()),
});
const frameSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});
export type AcpPermissionRequestParams = z.infer<
  typeof permissionRequestSchema
>;
export type AcpPermissionOption = AcpPermissionRequestParams["options"][number];
export type AcpSessionUpdateParams = z.infer<typeof sessionUpdateSchema>;
export interface AcpPermissionOutcome {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}
interface PendingRpc {
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
  onPermissionRequest?(
    params: AcpPermissionRequestParams,
  ): Promise<AcpPermissionOutcome>;
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
  private updateTail: Promise<void> = Promise.resolve();
  private readonly exited: Promise<void>;
  public agentCapabilities: Record<string, unknown> = {};
  public agentVersion = "";

  constructor(private readonly options: AcpClientOptions) {
    const { launch, cwd, env } = options;
    this.child = spawnProcess(launch.command, [...launch.args, "acp"], {
      env: { ...launch.env, ...env },
      cwd,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // Some CLI versions put diagnostic text on stdout.
        return;
      }
      if (this.closing || this.failure) return;
      try {
        this.handleFrame(frameSchema.parse(value));
      } catch (error) {
        this.fail(new AntigravityError(String(error), "INVALID_FRAME"));
      }
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closing)
        this.fail(new AntigravityError(error.message, "TRANSPORT_ERROR"));
    });
    this.child.on("error", (error) => {
      this.fail(
        new AntigravityError(
          "Failed to spawn agy acp: " + error.message,
          "SPAWN_FAILED",
        ),
      );
    });
    this.exited = new Promise<void>((resolve) => {
      this.child.once("close", (code, signal) => {
        lines.close();
        const detail = this.stderr.trim();
        const message =
          detail ||
          "Antigravity ACP exited (" + (signal ?? code ?? "unknown") + ")";
        const error = new AntigravityError(
          formatDiagnostic(message),
          "PROCESS_EXITED",
          detail || undefined,
        );
        // Apply already-received text before publishing the terminal event.
        void this.updateTail.then(() => this.fail(error));
        resolve();
      });
    });
  }

  async initialize(): Promise<void> {
    const response = await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "paseo", version: "0.14.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      this.options.startupTimeoutMs ?? 15000,
    );
    const parsed = z
      .object({
        protocolVersion: z.literal(1),
        agentCapabilities: z.record(z.string(), z.unknown()).default({}),
        agentInfo: z.object({ version: z.string().optional() }).optional(),
      })
      .parse(response);
    this.agentCapabilities = parsed.agentCapabilities;
    this.agentVersion = parsed.agentInfo?.version ?? "";
  }

  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number | null = 30000,
  ): Promise<T> {
    this.assertOpen();
    const id = ++this.sequence;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs !== null && timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new AntigravityError(
                  "Antigravity ACP " + method + " timed out",
                  "TIMEOUT",
                ),
              );
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ jsonrpc: "2.0", id, method, params }).catch(
        (error: unknown) => {
          this.fail(new AntigravityError(String(error), "TRANSPORT_ERROR"));
        },
      );
    });
    return result as T;
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    this.assertOpen();
    await this.write({ jsonrpc: "2.0", method, params });
  }

  async drainUpdates(): Promise<void> {
    await this.updateTail;
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.rejectPending(
      new AntigravityError("Antigravity ACP closed", "CLOSED"),
    );
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    this.child.stdin.end();
    if (await this.exitsWithin(6000)) {
      await this.terminate("SIGKILL");
      return;
    }
    await this.terminate("SIGTERM");
    if (await this.exitsWithin(1200)) {
      await this.terminate("SIGKILL");
      return;
    }
    await this.terminate("SIGKILL");
    if (!(await this.exitsWithin(1000))) {
      throw new AntigravityError(
        "Antigravity ACP did not close its streams",
        "CLOSE_TIMEOUT",
      );
    }
  }

  private async terminate(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    if (process.platform === "win32") {
      await terminateProcess(this.child, signal);
      return;
    }
    if (this.child.pid === undefined) return;
    try {
      process.kill(-this.child.pid, signal);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ESRCH"
      )
        throw error;
    }
  }

  private async exitsWithin(ms: number): Promise<boolean> {
    const controller = new AbortController();
    try {
      return await Promise.race([
        this.exited.then(() => true),
        delay(ms, false, { signal: controller.signal }),
      ]);
    } finally {
      controller.abort();
    }
  }

  private assertOpen(): void {
    if (this.failure) throw this.failure;
    if (this.closing)
      throw new AntigravityError(
        "Antigravity ACP connection is closing",
        "CLOSED",
      );
  }

  private write(frame: Record<string, unknown>): Promise<void> {
    if (this.closing)
      return Promise.reject(
        new AntigravityError("Antigravity ACP closed", "CLOSED"),
      );
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(frame) + "\n", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private handleFrame(frame: z.infer<typeof frameSchema>): void {
    const id = frame.id;
    const method = frame.method;
    if (method && id !== undefined && id !== null) {
      void this.updateTail
        .then(() => this.handleServerRequest(id, method, frame.params))
        .catch((error: unknown) => {
          if (!this.closing)
            this.fail(
              new AntigravityError(String(error), "CLIENT_REQUEST_FAILED"),
            );
        });
      return;
    }
    if (method) {
      if (method !== "session/update" || !this.options.onSessionUpdate) return;
      const params = sessionUpdateSchema.parse(frame.params);
      this.updateTail = this.updateTail
        .then(async () => {
          if (!this.closing && !this.failure)
            await this.options.onSessionUpdate?.(params);
        })
        .catch((error: unknown) => {
          this.fail(new AntigravityError(String(error), "UPDATE_FAILED"));
        });
      return;
    }
    if (id === undefined || id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    void this.updateTail.then(() => {
      if (!this.pending.delete(id)) return;
      if (this.failure) pending.reject(this.failure);
      else if (frame.error)
        pending.reject(
          new AntigravityError(
            formatDiagnostic(frame.error.message),
            "RPC_" + frame.error.code,
          ),
        );
      else pending.resolve(frame.result);
    });
  }

  private async handleServerRequest(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (this.closing || this.failure) return;
    if (
      method !== "session/request_permission" ||
      !this.options.onPermissionRequest
    ) {
      await this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: "Unsupported client method: " + method,
        },
      });
      return;
    }
    let result: AcpPermissionOutcome;
    try {
      result = await this.options.onPermissionRequest(
        permissionRequestSchema.parse(params),
      );
    } catch {
      result = { outcome: { outcome: "cancelled" } };
    }
    if (!this.closing && !this.failure)
      await this.write({ jsonrpc: "2.0", id, result });
  }

  private rejectPending(error: AntigravityError): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: AntigravityError): void {
    if (this.failure) return;
    this.failure = error;
    this.rejectPending(error);
    if (!this.closing) {
      this.options.onExit?.(error);
      void this.close().catch((closeError: unknown) => {
        this.options.onExit?.(
          new AntigravityError(String(closeError), "CLOSE_FAILED"),
        );
      });
    }
  }
}
