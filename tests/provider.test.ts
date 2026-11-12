import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { createAntigravityProvider } from "../providers/antigravity-provider/server/provider.js";
import { catalogFromModelOutput } from "../providers/antigravity-provider/server/internal/catalog.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function harness(env: Record<string, string> = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-provider-test-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const provider = createAntigravityProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: [
      "prompt.message",
      "prompt.command",
      "prompt.image",
      "prompt.steer",
      "permission",
      "session.configure",
      "session.list",
      "session.persistence",
      "session.revert.both",
      "session.revert.files",
      "session.revert.conversation",
      "session.can_stop_runtime",
    ],
    launch: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/agy.mjs", import.meta.url))],
      env: { HOME: cwd, ...env },
    },
  });
  cleanups.push(() => connection.close());
  const events: ProviderEvent[] = [];
  const waiters = new Set<(event: ProviderEvent) => void>();
  connection.onEvent((event) => {
    events.push(event);
    for (const waiter of waiters) waiter(event);
  });
  function wait<T extends ProviderEvent["type"]>(
    type: T,
    predicate: (event: Extract<ProviderEvent, { type: T }>) => boolean = () =>
      true,
  ): Promise<Extract<ProviderEvent, { type: T }>> {
    const matches = (
      event: ProviderEvent,
    ): event is Extract<ProviderEvent, { type: T }> =>
      event.type === type &&
      predicate(event as Extract<ProviderEvent, { type: T }>);
    const existing = events.find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(receive);
        reject(new Error("Missing event: " + type));
      }, 2000);
      function receive(event: ProviderEvent) {
        if (matches(event)) {
          clearTimeout(timer);
          waiters.delete(receive);
          resolve(event);
        }
      }
      waiters.add(receive);
    });
  }
  async function open(
    extra: Partial<Extract<ProviderInput, { type: "session.open" }>> = {},
  ) {
    await connection.send({
      type: "session.open",
      requestId: "open",
      sessionId: "s",
      history: "skip",
      config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: false },
      ...extra,
    });
    await wait("session.ready");
  }
  function prompt(id: string, text: string) {
    return connection.send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: id,
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text }] },
      },
    });
  }
  return { connection, events, wait, open, prompt, cwd };
}

describe("Antigravity provider public contract", () => {
  it("does not resurrect a session closed during initialization", async () => {
    const h = await harness();
    await h.connection.send({
      type: "session.open",
      requestId: "open",
      sessionId: "s",
      history: "skip",
      config: {
        cwd: h.cwd,
        env: {},
        mcpServers: {},
        settings: {},
        persist: false,
      },
    });
    await h.connection.send({
      type: "session.close",
      requestId: "close",
      sessionId: "s",
    });
    await h.wait("request.failed", (event) => event.requestId === "open");
    await h.wait("session.closed");
    expect(h.events.filter((event) => event.type === "session.ready")).toEqual(
      [],
    );
  });
  it("admits only one concurrent prompt and settles that turn", async () => {
    const h = await harness();
    await h.open();
    await Promise.all([h.prompt("first", "one"), h.prompt("second", "two")]);
    const result = await h.wait(
      "session.prompt_result",
      (event) => event.clientMessageId === "second",
    );
    expect(result.result.type).toBe("failed");
    await h.wait("session.turn", (event) => event.state === "completed");
    expect(
      h.events
        .filter((event) => event.type === "session.turn")
        .map((event) => event.state),
    ).toEqual(["started", "completed"]);
  });
  for (const explicitIds of [false, true]) {
    it(
      "replays distinct user and assistant messages in order (explicit IDs: " +
        explicitIds +
        ")",
      async () => {
        const h = await harness({
          FIXTURE_MESSAGE_IDS: explicitIds ? "1" : "0",
        });
        await h.open({
          history: "replay",
          persistence: { version: 1, data: { conversationId: "fixture" } },
        });
        expect(
          h.events
            .filter((event) => event.type === "timeline.item")
            .map((event) =>
              event.item.type === "user_message" ||
              event.item.type === "assistant_message"
                ? event.item.text
                : event.item.type,
            ),
        ).toEqual(["u1", "a1", "u2", "a2"]);
      },
    );
  }
  it("reports a rejected configuration without publishing the requested mode", async () => {
    const h = await harness({ FIXTURE_REJECT_PLAN: "1" });
    await h.open();
    await h.connection.send({
      type: "session.configure",
      requestId: "config",
      sessionId: "s",
      changes: { mode: "plan" },
    });
    const failure = await h.wait(
      "request.failed",
      (event) => event.requestId === "config",
    );
    expect(failure.error.message).toBe("plan rejected");
    expect(
      h.events.filter((event) => event.type === "session.config").at(-1)?.config
        .mode,
    ).toBe("auto");
  });
  it("applies category-discovered thinking options and custom agent settings", async () => {
    const h = await harness();
    await h.open();
    await h.connection.send({
      type: "session.configure",
      requestId: "config",
      sessionId: "s",
      changes: { thinkingOption: "high", settings: { agent: "review" } },
    });
    await h.wait("request.completed", (event) => event.requestId === "config");
    const config = h.events
      .filter((event) => event.type === "session.config")
      .at(-1)!.config;
    expect(config.thinkingOption).toBe("high");
    expect(
      config.settings.find((setting) => setting.id === "agent")?.value,
    ).toBe("review");
  });
  it("resets a thinking level to the catalog default rather than the last selection", async () => {
    const h = await harness();
    await h.open();
    await h.connection.send({
      type: "session.configure",
      requestId: "high",
      sessionId: "s",
      changes: { thinkingOption: "high" },
    });
    await h.wait("request.completed", (event) => event.requestId === "high");
    await h.connection.send({
      type: "session.configure",
      requestId: "reset",
      sessionId: "s",
      changes: { thinkingOption: null },
    });
    await h.wait("request.completed", (event) => event.requestId === "reset");
    expect(
      h.events.filter((event) => event.type === "session.config").at(-1)?.config
        .thinkingOption,
    ).toBe("medium");
  });
  it("cancels an active prompt and permits the next turn", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("first", "hold");
    await h.wait("session.turn", (event) => event.state === "started");
    await h.connection.send({
      type: "session.interrupt",
      requestId: "interrupt",
      sessionId: "s",
    });
    await h.wait(
      "request.completed",
      (event) => event.requestId === "interrupt",
    );
    await h.wait("session.turn", (event) => event.state === "canceled");
    await h.prompt("next", "next");
    await h.wait("session.turn", (event) => event.state === "completed");
    expect(
      h.events
        .filter((event) => event.type === "session.turn")
        .map((event) => event.state),
    ).toEqual(["started", "canceled", "started", "completed"]);
  });
  it("rejects unsupported structured output and exact MCP preapproval instead of ignoring them", async () => {
    const h = await harness();
    await h.open();
    await expect(
      h.connection.send({
        type: "session.prompt",
        sessionId: "s",
        prompt: {
          clientMessageId: "schema",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "test" }] },
          outputSchema: { type: "object" },
        },
      }),
    ).rejects.toThrow("prompt.output_schema");
    await expect(
      h.connection.send({
        type: "session.open",
        sessionId: "policy",
        requestId: "policy",
        history: "skip",
        config: {
          cwd: h.cwd,
          env: {},
          mcpServers: {},
          settings: {},
          persist: false,
          toolPolicy: {
            preapproved: [{ kind: "mcp", server: "fixture", tool: "tool" }],
          },
        },
      }),
    ).rejects.toThrow("permission.tool_policy");
    expect(h.events.filter((event) => event.type === "session.turn")).toEqual(
      [],
    );
  });

  it("waits for a running tool after early end_turn instead of inventing completion", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("first", "early-end");
    await h.wait(
      "timeline.item",
      (event) =>
        event.item.type === "tool_call" && event.item.status === "running",
    );
    await h.connection.send({
      type: "session.can_stop_runtime",
      sessionId: "s",
      requestId: "busy",
    });
    expect(
      (
        await h.wait(
          "session.can_stop_runtime",
          (event) => event.requestId === "busy",
        )
      ).canStop,
    ).toBe(false);
    await h.prompt("blocked", "next");
    expect(
      (
        await h.wait(
          "session.prompt_result",
          (event) => event.clientMessageId === "blocked",
        )
      ).result.type,
    ).toBe("failed");
    await h.wait("session.turn", (event) => event.state === "completed");
    const order = h.events.filter(
      (event) =>
        event.type === "timeline.item" || event.type === "session.turn",
    );
    const thought = order.findIndex(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "reasoning" &&
        event.item.text === "old-turn-thought",
    );
    const toolDone = order.findIndex(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed",
    );
    const ended = order.findIndex(
      (event) => event.type === "session.turn" && event.state === "completed",
    );
    expect(thought).toBeGreaterThan(-1);
    expect(toolDone).toBeGreaterThan(thought);
    expect(ended).toBeGreaterThan(toolDone);
    expect(
      h.events
        .filter((event) => event.type === "timeline.item")
        .filter((event) => event.item.type === "tool_call")
        .map((event) =>
          event.item.type === "tool_call" ? event.item.status : "",
        ),
    ).toEqual(["running", "completed"]);
    await h.prompt("second", "reuse-identities");
    await h.wait(
      "session.turn",
      (event) =>
        event.state === "completed" &&
        event.turnId !==
          h.events.find((event) => event.type === "session.turn")?.turnId,
    );
    const ids = h.events
      .filter((event) => event.type === "timeline.item")
      .filter((event) => event.item.type === "tool_call")
      .map((event) => event.item.id);
    expect(ids.at(-1)).not.toBe(ids[0]);
  });

  it("settles a tool-draining turn once if its ACP process exits", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("first", "early-end-exit");
    await h.wait("session.turn", (event) => event.state === "failed");
    expect(
      h.events
        .filter((event) => event.type === "session.turn")
        .map((event) => event.state),
    ).toEqual(["started", "failed"]);
    await h.prompt("second", "next");
    await h.wait("session.turn", (event) => event.state === "completed");
    expect(
      h.events
        .filter((event) => event.type === "session.turn")
        .map((event) => event.state),
    ).toEqual(["started", "failed", "started", "completed"]);
  });

  it("fails a bounded tool drain instead of reporting unfinished work as completed", async () => {
    const h = await harness();
    await h.open();
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    try {
      await h.prompt("first", "early-end-hold");
      await h.wait(
        "timeline.item",
        (event) =>
          event.item.type === "tool_call" && event.item.status === "running",
      );
      // A control round-trip proves the early response was read and its drain started.
      await h.connection.send({
        type: "session.can_stop_runtime",
        sessionId: "s",
        requestId: "draining",
      });
      await h.wait(
        "session.can_stop_runtime",
        (event) => event.requestId === "draining",
      );
      controller.abort();
      const failed = await h.wait(
        "session.turn",
        (event) => event.state === "failed",
      );
      expect(failed.error?.message).toContain("before its tools settled");
      expect(
        h.events
          .filter((event) => event.type === "session.turn")
          .map((event) => event.state),
      ).toEqual(["started", "failed"]);
      expect(
        h.events
          .filter((event) => event.type === "timeline.item")
          .filter((event) => event.item.type === "tool_call")
          .map((event) =>
            event.item.type === "tool_call" ? event.item.status : "",
          ),
      ).toEqual(["running", "failed"]);
    } finally {
      timeout.mockRestore();
    }
    await h.prompt("second", "next");
    await h.wait("session.turn", (event) => event.state === "completed");
  });

  it("cancels a tool drain even when the prompt response already returned", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("first", "early-end-hold");
    await h.wait(
      "timeline.item",
      (event) =>
        event.item.type === "tool_call" && event.item.status === "running",
    );
    await h.connection.send({
      type: "session.interrupt",
      sessionId: "s",
      requestId: "cancel-drain",
    });
    await h.wait(
      "request.completed",
      (event) => event.requestId === "cancel-drain",
    );
    await h.wait("session.turn", (event) => event.state === "canceled");
    expect(
      h.events
        .filter((event) => event.type === "timeline.item")
        .filter((event) => event.item.type === "tool_call")
        .map((event) =>
          event.item.type === "tool_call" ? event.item.status : "",
        ),
    ).toEqual(["running", "canceled"]);
    await h.prompt("second", "next");
    await h.wait("session.turn", (event) => event.state === "completed");
  });

  it("retires the previous ACP stream and isolates reused message IDs before admitting the next turn", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("first", "late-after-end");
    const first = await h.wait(
      "session.turn",
      (event) => event.state === "completed",
    );
    await h.prompt("second", "reuse-identities");
    await h.wait(
      "session.turn",
      (event) => event.state === "completed" && event.turnId !== first.turnId,
    );
    const assistant = h.events
      .filter((event) => event.type === "timeline.item")
      .filter((event) => event.item.type === "assistant_message");
    expect(
      assistant.map((event) =>
        event.item.type === "assistant_message" ? event.item.text : "",
      ),
    ).toEqual(["first answer", "new answer"]);
    expect(assistant[0]?.item.id).not.toBe(assistant[1]?.item.id);
    const messageIds = assistant.map((event) =>
      event.item.type === "assistant_message"
        ? event.item.messageId
        : undefined,
    );
    expect(messageIds[0]).not.toBe(messageIds[1]);
    expect(
      h.events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "reasoning" &&
          event.item.text === "late-old-thought",
      ),
    ).toBe(false);
    expect(
      h.events
        .filter((event) => event.type === "timeline.item")
        .filter((event) => event.item.type === "tool_call")
        .map((event) =>
          event.item.type === "tool_call" ? event.item.status : "",
        ),
    ).toEqual(["completed"]);
  });

  it("does not advertise steering without a native acknowledgement", async () => {
    const h = await harness();
    expect(h.connection.capabilities.includes("prompt.steer")).toBe(false);
  });
  it("answers the exact permission choice and does not auto-answer choosers", async () => {
    const h = await harness();
    await h.open();
    await h.connection.send({
      type: "session.configure",
      requestId: "config",
      sessionId: "s",
      changes: { mode: "full-access" },
    });
    await h.wait("request.completed", (event) => event.requestId === "config");
    await h.prompt("question", "chooser");
    const permission = await h.wait("session.permission");
    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: permission.request.id,
      response: { behavior: "allow", selectedActionId: "other" },
    });
    await h.wait("session.turn", (event) => event.state === "completed");
    const output = h.events
      .filter((event) => event.type === "timeline.item")
      .filter((event) => event.item.type === "assistant_message")
      .at(-1);
    expect(
      output?.item.type === "assistant_message" ? output.item.text : "",
    ).toContain('"optionId":"other"');
  });
  it("reports process exit as a failed turn and reconnects for a new prompt", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("first", "fail-process");
    await h.wait("session.turn", (event) => event.state === "failed");
    await h.prompt("next", "next");
    await h.wait("session.turn", (event) => event.state === "completed");
    expect(
      h.events
        .filter((event) => event.type === "session.turn")
        .map((event) => event.state),
    ).toEqual(["started", "failed", "started", "completed"]);
  });
  it("does not call token-limit exhaustion a completed turn", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("first", "max_tokens");
    const failed = await h.wait(
      "session.turn",
      (event) => event.state === "failed",
    );
    expect(failed.error?.message).toContain("max_tokens");
  });
  it("paginates filtered session lists, including untitled sessions", async () => {
    const h = await harness();
    await h.connection.send({
      type: "sessions",
      requestId: "list",
      query: "matching",
      limit: 1,
    });
    const listed = await h.wait("sessions");
    expect(listed.sessions.map((session) => session.title)).toEqual([
      "matching title",
    ]);
  });
  it("uses the first prompt as an untitled session's title", async () => {
    const h = await harness();
    const logs = path.join(
      h.cwd,
      ".gemini",
      "antigravity-cli",
      "brain",
      "unrelated",
      ".system_generated",
      "logs",
    );
    await mkdir(logs, { recursive: true });
    await writeFile(
      path.join(logs, "transcript_full.jsonl"),
      JSON.stringify({ type: "USER_INPUT", content: "Untitled prompt" }),
    );
    await h.connection.send({
      type: "sessions",
      requestId: "list",
      query: "Untitled prompt",
      limit: 1,
    });
    const listed = await h.wait("sessions");
    expect(listed.sessions[0]).toMatchObject({
      title: "Untitled prompt",
      description: "Untitled prompt",
      firstPromptPreview: "Untitled prompt",
      lastPromptPreview: "Untitled prompt",
    });
  });

  it("searches local prompt summaries before applying the session-list limit", async () => {
    const h = await harness();
    const logs = path.join(
      h.cwd,
      ".gemini",
      "antigravity-cli",
      "brain",
      "matching",
      ".system_generated",
      "logs",
    );
    await mkdir(logs, { recursive: true });
    await writeFile(
      path.join(logs, "transcript_full.jsonl"),
      [
        JSON.stringify({
          type: "USER_INPUT",
          content:
            "<USER_REQUEST> First request </USER_REQUEST><ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>",
        }),
        JSON.stringify({ type: "PLANNER_RESPONSE", content: "not a preview" }),
        JSON.stringify({
          type: "USER_INPUT",
          content: "latest\nrequest needle",
        }),
      ].join("\n"),
    );
    await h.connection.send({
      type: "sessions",
      requestId: "list",
      query: "needle",
      limit: 1,
    });
    const listed = await h.wait("sessions");
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      title: "matching title",
      description: "latest request needle",
      firstPromptPreview: "First request",
      lastPromptPreview: "latest request needle",
      updatedAt: expect.any(String),
    });
  });

  it("reports session-list errors instead of returning an empty success", async () => {
    const h = await harness({ FIXTURE_FAIL_LIST: "1" });
    await h.connection.send({ type: "sessions", requestId: "list" });
    expect((await h.wait("request.failed")).error.message).toBe("list failed");
  });
  it("keeps the imported session's native model when no override was requested", async () => {
    const h = await harness({ FIXTURE_MODEL: "claude-opus-5-5" });
    await h.open({
      persistence: { version: 1, data: { conversationId: "fixture" } },
    });
    expect(
      h.events.filter((event) => event.type === "session.config").at(-1)?.config
        .model,
    ).toBe("claude-opus-5-5");
  });
  it("preserves persisted custom settings on reopen", async () => {
    const h = await harness();
    await h.open({
      persistence: {
        version: 1,
        data: { conversationId: "fixture", settings: { agent: "review" } },
      },
      config: {
        cwd: h.cwd,
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
      },
    });
    const persistence = h.events
      .filter((event) => event.type === "session.persistence")
      .at(-1)?.persistence.data;
    expect(persistence).toMatchObject({ settings: { agent: "review" } });
  });
  it("preserves images, text attachments, and uploaded file references", async () => {
    const h = await harness();
    await h.open();
    await h.connection.send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "attachments",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "image", mimeType: "image/png", data: "AA==" },
            { type: "text", mimeType: "text/plain", text: "context" },
            {
              type: "uploaded_file",
              id: "upload",
              fileName: "notes.txt",
              mimeType: "text/plain",
              size: 10,
              path: "/tmp/notes.txt",
            },
          ],
        },
      },
    });
    await h.wait("session.turn", (event) => event.state === "completed");
    const output = h.events
      .filter((event) => event.type === "timeline.item")
      .filter((event) => event.item.type === "assistant_message")
      .at(-1)!;
    expect(
      output.item.type === "assistant_message" ? output.item.text : "",
    ).toContain("notes.txt");
    expect(
      output.item.type === "assistant_message" ? output.item.text : "",
    ).toContain("context");
    expect(
      output.item.type === "assistant_message" ? output.item.text : "",
    ).toContain('"type":"image"');
  });
  it("replays a persisted transcript when ACP load has no history notifications", async () => {
    const h = await harness({ FIXTURE_EMPTY_LOAD: "1" });
    const logs = path.join(
      h.cwd,
      ".gemini",
      "antigravity-cli",
      "brain",
      "fixture",
      ".system_generated",
      "logs",
    );
    await mkdir(logs, { recursive: true });
    await writeFile(
      path.join(logs, "transcript_full.jsonl"),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "u1" }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          content: "a1",
          thinking: "reasoning",
        }),
      ].join("\n"),
    );
    await h.open({
      history: "replay",
      persistence: { version: 1, data: { conversationId: "fixture" } },
    });
    expect(
      h.events
        .filter((event) => event.type === "timeline.item")
        .map((event) =>
          event.item.type === "user_message" ||
          event.item.type === "assistant_message" ||
          event.item.type === "reasoning"
            ? event.item.text
            : event.item.type,
        ),
    ).toEqual(["u1", "reasoning", "a1"]);
  });
  it("stops and reloads the runtime around file rewind", async () => {
    const h = await harness();
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    const file = path.join(h.cwd, "file.txt");
    await writeFile(file, "before");
    execFileSync("git", ["add", "file.txt"], { cwd: h.cwd });
    await h.open();
    await h.prompt("first", "first");
    await h.wait("session.turn", (event) => event.state === "completed");
    const user = h.events
      .filter((event) => event.type === "timeline.item")
      .find((event) => event.item.type === "user_message")!;
    await writeFile(file, "after");
    await h.connection.send({
      type: "session.revert",
      sessionId: "s",
      requestId: "revert",
      scope: "files",
      token: user.item.revertToken!,
    });
    await h.wait("request.completed", (event) => event.requestId === "revert");
    expect(await readFile(file, "utf8")).toBe("before");
    await h.prompt("next", "next");
    await h.wait(
      "session.prompt_result",
      (event) => event.clientMessageId === "next",
    );
  });
  it("parses the tab-separated catalog the CLI writes outside a TTY", () => {
    const catalog = catalogFromModelOutput(
      "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)\ngemini-4-carbon-high\tGemini 4 Carbon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n",
    );
    expect(
      catalog.models.map((model) => [
        model.id,
        model.thinkingOptions?.map((option) => option.id),
      ]),
    ).toEqual([
      ["gemini-4-carbon", ["medium", "high"]],
      ["claude-opus-5-5", ["low"]],
    ]);
  });
  it("discovers the model catalog from the resolved CLI", async () => {
    const h = await harness();
    await h.connection.send({ type: "catalog", requestId: "catalog" });
    const catalog = (await h.wait("catalog")).catalog;
    expect(catalog.models.map((model) => model.id)).toEqual([
      "gemini-4-carbon",
      "claude-opus-5-5",
    ]);
    expect(
      catalog.models[0]?.thinkingOptions?.map((option) => option.id),
    ).toEqual(["medium", "high"]);
  });
});
