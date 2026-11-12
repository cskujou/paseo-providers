import os from "node:os";
import { execCommand } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderListedSession,
  type ProviderRegistration,
  type ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { AcpClient, AntigravityError, formatDiagnostic } from "./internal/acp-client.js";
import { fallbackCatalog } from "./internal/catalog.js";
import { Session } from "./internal/session.js";
import type { AntigravityUsage } from "./usage.js";

const capabilities = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.can_stop_runtime",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.revert.both",
  "session.revert.conversation",
  "session.revert.files",
  "permission",
] as const;

export function createAntigravityProvider(usage?: AntigravityUsage): ProviderRegistration {
  return {
    id: "antigravity",
    label: "Antigravity",
    description:
      "Google Antigravity agent powered by ACP (Modes, Thinking Levels, Interactive Permissions, Rewind & Quota)",
    icon: "icon.svg",
    command: ["agy"],
    async getCatalogCacheKey({ launch }) {
      if (!launch) return "agy-acp-v2";
      usage?.remember(launch);
      return `${launch.command}:${launch.args.join("\0")}:acp-v2`;
    },
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic: "Install the Antigravity CLI and ensure `agy` is on PATH.",
        };
      }
      usage?.remember(launch);
      return checkStatus(launch);
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new AntigravityError(
          "Provider protocol version 1 is required",
          "UNSUPPORTED_PROTOCOL",
        );
      }
      if (!request.launch) {
        throw new AntigravityError(
          "Antigravity requires a daemon-resolved executable",
          "MISSING_LAUNCH",
        );
      }
      usage?.remember(request.launch);
      const negotiated = negotiateProviderCapabilities(request.capabilities, capabilities);
      return createConnection(request.launch, negotiated, usage);
    },
  };
}

async function checkStatus(launch: ProviderLaunch): Promise<ProviderStatus> {
  try {
    const { stdout } = await execCommand(launch.command, [...launch.args, "--version"], {
      env: launch.env,
      timeout: 5000,
    });
    if (!/\b\d+\.\d+\.\d+\b/.test(stdout)) {
      return {
        available: false,
        diagnostic: "Antigravity CLI returned an unrecognized version output.",
      };
    }
    return { available: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, diagnostic: formatDiagnostic(message) };
  }
}

async function listAcpSessions(
  launch: ProviderLaunch,
  input: Extract<ProviderInput, { type: "sessions" }>,
): Promise<ProviderListedSession[]> {
  const cwd = input.cwd ?? os.homedir();
  const client = new AcpClient({
    launch,
    cwd,
    startupTimeoutMs: 10000,
  });
  try {
    await client.initialize();
    const res = await client.request<Record<string, unknown>>(
      "session/list",
      { cwd },
      15000,
    );
    const rawSessions = Array.isArray(res.sessions) ? res.sessions : [];
    const mapped: ProviderListedSession[] = [];
    for (const entry of rawSessions) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
      if (!sessionId) continue;
      const sessionCwd = typeof rec.cwd === "string" ? rec.cwd : cwd;
      const title = typeof rec.title === "string" ? rec.title : undefined;
      const updatedAt = typeof rec.updatedAt === "string" ? rec.updatedAt : undefined;
      if (
        input.query &&
        title &&
        !title.toLowerCase().includes(input.query.toLowerCase()) &&
        !sessionId.toLowerCase().includes(input.query.toLowerCase())
      ) {
        continue;
      }
      mapped.push({
        persistence: {
          version: 1,
          data: { conversationId: sessionId, sessionId },
        },
        cwd: sessionCwd,
        title,
        updatedAt,
      });
    }
    return input.limit ? mapped.slice(0, input.limit) : mapped;
  } catch {
    return [];
  } finally {
    await client.close().catch(() => undefined);
  }
}

function createConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
  usage?: AntigravityUsage,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  const currentCatalog: ProviderCatalog = fallbackCatalog();
  let closed = false;

  const usageFallback =
    usage ??
    ({
      recordTier() {},
      remember() {
        return { home: os.homedir() };
      },
    } as unknown as AntigravityUsage);

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) {
      listener(event);
    }
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    if (input.type === "catalog") {
      emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: currentCatalog,
      });
      return;
    }

    if (input.type === "sessions") {
      const listed = await listAcpSessions(launch, input);
      emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: listed,
      });
      return;
    }

    if (input.type === "session.open") {
      if (sessions.has(input.sessionId)) {
        throw new AntigravityError("Antigravity session is already open", "SESSION_EXISTS");
      }
      const session = new Session({
        id: input.sessionId,
        config: input.config,
        launch,
        catalog: () => currentCatalog,
        persistence: input.persistence,
        history: input.history,
        usage: usageFallback,
        emit,
      });
      sessions.set(input.sessionId, session);
      try {
        await session.open(input.requestId, negotiated);
      } catch (error) {
        sessions.delete(input.sessionId);
        await session.close();
        throw error;
      }
      return;
    }

    if (!("sessionId" in input)) {
      throw new AntigravityError(
        `Antigravity does not support ${input.type}`,
        "UNSUPPORTED_INPUT",
      );
    }

    const session = sessions.get(input.sessionId);
    if (!session) {
      throw new AntigravityError("Antigravity session is not open", "UNKNOWN_SESSION");
    }

    switch (input.type) {
      case "session.prompt":
        await session.prompt(input.prompt);
        return;
      case "session.configure":
        await session.configure(input.changes);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.permission":
        session.answerPermission(input.permissionId, input.response);
        return;
      case "session.revert":
        await session.revert(input.token, input.scope);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.can_stop_runtime":
        emit({
          type: "session.can_stop_runtime",
          requestId: input.requestId,
          sessionId: input.sessionId,
          canStop: session.canStopRuntime(),
        });
        return;
      case "session.interrupt":
        await session.interrupt();
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.close":
        sessions.delete(input.sessionId);
        await session.close();
        emit({ type: "session.closed", sessionId: input.sessionId });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      default:
        throw new AntigravityError(
          `Antigravity does not support ${input.type}`,
          "UNSUPPORTED_INPUT",
        );
    }
  }

  function handleDispatchError(input: ProviderInput, failure: unknown): void {
    const rawMessage = failure instanceof Error ? failure.message : String(failure);
    const code = failure instanceof AntigravityError ? failure.code : "ANTIGRAVITY_ERROR";
    const error = { message: formatDiagnostic(rawMessage), code };

    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error },
      });
    } else if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error });
    } else if ("sessionId" in input) {
      emit({ type: "session.runtime_failed", sessionId: input.sessionId, error });
    }
  }

  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) {
        throw new AntigravityError("Antigravity connection is closed", "CONNECTION_CLOSED");
      }
      requireProviderCapabilities(negotiated, input);
      queueMicrotask(() => {
        if (!closed) {
          void dispatch(input).catch((err: unknown) => handleDispatchError(input, err));
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const openSessions = [...sessions.values()];
      sessions.clear();
      await Promise.all(openSessions.map((s) => s.close()));
      listeners.clear();
    },
  };
}
