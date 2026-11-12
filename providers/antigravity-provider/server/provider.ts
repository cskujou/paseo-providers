import os from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderSessionSummary,
  type ProviderRegistration,
  type ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import {
  AcpClient,
  AntigravityError,
  formatDiagnostic,
} from "./internal/acp-client.js";
import { catalogFromModelOutput, fallbackCatalog } from "./internal/catalog.js";
import { Session } from "./internal/session.js";
import type { AntigravityUsage } from "./usage.js";

const capabilities = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "session.can_stop_runtime",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.revert.both",
  "session.revert.conversation",
  "session.revert.files",
  "permission",
] as const;

export function createAntigravityProvider(
  usage?: AntigravityUsage,
): ProviderRegistration {
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
      const environment = Object.entries(launch.env).sort(([left], [right]) =>
        left.localeCompare(right),
      );
      return createHash("sha256")
        .update(
          JSON.stringify([launch.command, launch.args, environment, "acp-v3"]),
        )
        .digest("hex");
    },
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic:
            "Install the Antigravity CLI and ensure `agy` is on PATH.",
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
      const negotiated = negotiateProviderCapabilities(
        request.capabilities,
        capabilities,
      );
      return createConnection(request.launch, negotiated, usage);
    },
  };
}

async function checkStatus(launch: ProviderLaunch): Promise<ProviderStatus> {
  try {
    const { stdout } = await execCommand(
      launch.command,
      [...launch.args, "--version"],
      {
        env: launch.env,
        timeout: 5000,
      },
    );
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
): Promise<ProviderSessionSummary[]> {
  const client = new AcpClient({
    launch,
    cwd: input.cwd ?? os.homedir(),
    startupTimeoutMs: 10000,
  });
  const pageSchema = z.object({
    sessions: z.array(
      z.object({
        sessionId: z.string().min(1),
        cwd: z.string(),
        title: z.string().optional(),
        updatedAt: z.string().optional(),
      }),
    ),
    nextCursor: z.string().nullable().optional(),
  });
  try {
    await client.initialize();
    const mapped: ProviderSessionSummary[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    const query = input.query?.toLowerCase();
    do {
      const page = pageSchema.parse(
        await client.request(
          "session/list",
          {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(cursor ? { cursor } : {}),
          },
          15000,
        ),
      );
      for (const session of page.sessions) {
        if (
          query &&
          ![session.title ?? "", session.sessionId].some((value) =>
            value.toLowerCase().includes(query),
          )
        )
          continue;
        mapped.push({
          persistence: {
            version: 1,
            data: {
              conversationId: session.sessionId,
              sessionId: session.sessionId,
            },
          },
          cwd: session.cwd,
          title: session.title,
          updatedAt: session.updatedAt,
        });
        if (input.limit !== undefined && mapped.length >= input.limit)
          return mapped.slice(0, input.limit);
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor))
        throw new AntigravityError(
          "Antigravity repeated a session-list cursor",
          "INVALID_SESSION_PAGE",
        );
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return mapped;
  } finally {
    await client.close();
  }
}

function createConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
  usage?: AntigravityUsage,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  let currentCatalog: ProviderCatalog = fallbackCatalog();
  let closed = false;

  const usageFallback = usage ?? { recordTier() {} };

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) {
      listener(event);
    }
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    if (input.type === "catalog") {
      const { stdout } = await execCommand(
        launch.command,
        [...launch.args, "models"],
        { env: launch.env, cwd: input.cwd, timeout: 15000 },
      );
      currentCatalog = catalogFromModelOutput(stdout);
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
        throw new AntigravityError(
          "Antigravity session is already open",
          "SESSION_EXISTS",
        );
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
        if (sessions.get(input.sessionId) === session)
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
      throw new AntigravityError(
        "Antigravity session is not open",
        "UNKNOWN_SESSION",
      );
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
          "Antigravity does not support this input",
          "UNSUPPORTED_INPUT",
        );
    }
  }

  function handleDispatchError(input: ProviderInput, failure: unknown): void {
    const rawMessage =
      failure instanceof Error ? failure.message : String(failure);
    const code =
      failure instanceof AntigravityError ? failure.code : "ANTIGRAVITY_ERROR";
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
      emit({
        type: "session.runtime_failed",
        sessionId: input.sessionId,
        error,
      });
    }
  }

  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) {
        throw new AntigravityError(
          "Antigravity connection is closed",
          "CONNECTION_CLOSED",
        );
      }
      requireProviderCapabilities(negotiated, input);
      queueMicrotask(() => {
        if (!closed) {
          void dispatch(input).catch((err: unknown) =>
            handleDispatchError(input, err),
          );
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
      const results = await Promise.allSettled(
        openSessions.map((session) => session.close()),
      );
      listeners.clear();
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length)
        throw new AggregateError(
          failures,
          "Some Antigravity sessions did not close",
        );
    },
  };
}
