import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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
      "session.subsession",
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

  it("does not time out or kill a tool just because its drain exceeds 30 seconds", async () => {
    const h = await harness();
    await h.open();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await h.prompt("first", "controlled-tool");
    await h.wait(
      "timeline.item",
      (e) => e.item.type === "tool_call" && e.item.status === "running",
    );
    await h.connection.send({
      type: "session.can_stop_runtime",
      sessionId: "s",
      requestId: "before-long-wait",
    });
    await h.wait(
      "session.can_stop_runtime",
      (e) => e.requestId === "before-long-wait",
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(
        h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
      ).toEqual(["started"]);
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      timeout.mockRestore();
    }
    await writeFile(path.join(h.cwd, "finish-tool"), "done");
    await h.connection.send({
      type: "session.configure",
      sessionId: "s",
      requestId: "release-tool",
      changes: { thinkingOption: "high" },
    });
    await h.wait("request.completed", (e) => e.requestId === "release-tool");
    await h.wait("session.turn", (e) => e.state === "completed");
    expect(
      (await readFile(path.join(h.cwd, "fixture-processes.txt"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(1);
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

  it("keeps the ACP process between normal turns and isolates reused message IDs", async () => {
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
    expect(
      (await readFile(path.join(h.cwd, "fixture-processes.txt"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });

  it("keeps the turn alive until a background task's transcript-only automatic reply finishes", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("background", "background-transcript");
    await h.wait(
      "timeline.item",
      (e) => e.item.type === "assistant_message" && e.item.text === "waiting",
    );
    await h.connection.send({
      type: "session.can_stop_runtime",
      sessionId: "s",
      requestId: "background-busy",
    });
    expect(
      (
        await h.wait(
          "session.can_stop_runtime",
          (e) => e.requestId === "background-busy",
        )
      ).canStop,
    ).toBe(false);
    const completed = await h.wait(
      "session.turn",
      (e) => e.state === "completed",
    );
    const answers = h.events
      .filter((e) => e.type === "timeline.item")
      .filter((e) => e.item.type === "assistant_message");
    expect(answers.at(-1)?.item).toMatchObject({ text: "AUTO_WAKE_DONE" });
    expect(h.events.findIndex((e) => e === answers.at(-1))).toBeLessThan(
      h.events.findIndex((e) => e === completed),
    );
    expect(
      h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ).toEqual(["started", "completed"]);
    const tools = h.events
      .filter((e) => e.type === "timeline.item")
      .filter((e) => e.item.type === "tool_call");
    expect(tools.at(-1)?.item).toMatchObject({
      status: "completed",
      detail: { type: "shell", exitCode: 0 },
    });
  });

  it("can cancel while waiting for a transcript-only background task", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("background", "background-transcript");
    await h.wait(
      "timeline.item",
      (e) => e.item.type === "assistant_message" && e.item.text === "waiting",
    );
    await h.connection.send({
      type: "session.interrupt",
      sessionId: "s",
      requestId: "background-cancel",
    });
    await h.wait(
      "request.completed",
      (e) => e.requestId === "background-cancel",
    );
    expect(
      h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ).toEqual(["started", "canceled"]);
  });

  it("keeps long background work alive beyond the old ten-minute deadline", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("background", "background-held");
    await h.wait(
      "timeline.item",
      (e) => e.item.type === "assistant_message" && e.item.text === "waiting",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Advancing wall time must not turn an active task into a failure.
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 60 * 60 * 1000);
    try {
      await new Promise((resolve) => setTimeout(resolve, 550));
      await h.connection.send({
        type: "session.can_stop_runtime",
        sessionId: "s",
        requestId: "still-background-busy",
      });
      expect(
        (
          await h.wait(
            "session.can_stop_runtime",
            (e) => e.requestId === "still-background-busy",
          )
        ).canStop,
      ).toBe(false);
      expect(
        h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
      ).toEqual(["started"]);
      const file = path.join(
        h.cwd,
        ".gemini",
        "antigravity-cli",
        "brain",
        "fixture",
        ".system_generated",
        "logs",
        "transcript_full.jsonl",
      );
      const existing = await readFile(file, "utf8");
      await rm(file);
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect(
        h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
      ).toEqual(["started"]);
      await writeFile(
        file,
        existing +
          [
            {
              type: "SYSTEM_MESSAGE",
              step_index: 4,
              status: "DONE",
              content:
                'Task id "fixture/task-2" finished with result:\nCommand exited with code 0.',
            },
            {
              type: "PLANNER_RESPONSE",
              step_index: 5,
              status: "DONE",
              content: "LONG_TASK_DONE",
            },
          ]
            .map((record) => JSON.stringify(record))
            .join("\n") +
          "\n",
      );
      await h.wait("session.turn", (e) => e.state === "completed");
      expect(
        h.events.filter((e) => e.type === "timeline.item").at(-1)?.item,
      ).toMatchObject({ type: "assistant_message", text: "LONG_TASK_DONE" });
      expect(
        (await readFile(path.join(h.cwd, "fixture-processes.txt"), "utf8"))
          .trim()
          .split("\n"),
      ).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not wait for an intentional daemon to exit or reclaim its process at idle", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("daemon", "background-daemon");
    await h.wait("session.turn", (e) => e.state === "completed");
    await h.connection.send({
      type: "session.can_stop_runtime",
      sessionId: "s",
      requestId: "daemon-idle",
    });
    expect(
      (
        await h.wait(
          "session.can_stop_runtime",
          (e) => e.requestId === "daemon-idle",
        )
      ).canStop,
    ).toBe(false);
    await h.prompt("next", "next");
    await h.wait("session.prompt_result", (e) => e.clientMessageId === "next");
    await h.wait(
      "session.turn",
      (e) =>
        e.state === "completed" &&
        e.turnId !== h.events.find((e) => e.type === "session.turn")?.turnId,
    );
    expect(
      (await readFile(path.join(h.cwd, "fixture-processes.txt"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });

  it("passes upstream code and detail to the failed turn and preserves the process for a follow-up", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("error", "upstream-error");
    const failed = await h.wait("session.turn", (e) => e.state === "failed");
    expect(failed.error).toMatchObject({
      message: "Agent execution terminated due to error.",
      code: "RPC_-32603",
    });
    expect(failed.error?.diagnostic).toContain(
      "service temporarily unavailable",
    );
    expect(failed.error?.diagnostic).not.toContain("private-token");
    expect(failed.error?.diagnostic).not.toContain("do not log task");
    await h.prompt("next", "next");
    await h.wait("session.turn", (e) => e.state === "completed");
    expect(
      (await readFile(path.join(h.cwd, "fixture-processes.txt"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });

  it("does not kill a healthy process when the model reaches a token limit", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("limited", "max_tokens");
    await h.wait("session.turn", (e) => e.state === "failed");
    await h.prompt("next", "next");
    await h.wait("session.turn", (e) => e.state === "completed");
    expect(
      (await readFile(path.join(h.cwd, "fixture-processes.txt"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });

  it("forwards automatic thinking and tools while the background continuation is still running", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("background", "background-held");
    await h.wait(
      "session.notice",
      (e) => e.notice.title === "Background task is running",
    );
    const file = path.join(
      h.cwd,
      ".gemini",
      "antigravity-cli",
      "brain",
      "fixture",
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    );
    let records = await readFile(file, "utf8");
    async function append(record: object) {
      records += JSON.stringify(record) + "\n";
      await writeFile(file, records);
    }
    await append({
      type: "SYSTEM_MESSAGE",
      step_index: 4,
      status: "DONE",
      content:
        'Task id "fixture/task-2" finished with result:\nCommand exited with code 0.',
    });
    await h.wait("session.notice", (e) =>
      e.notice.title.includes("waiting for AGY automatic continuation"),
    );
    expect(
      h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ).toEqual(["started"]);
    await append({
      type: "PLANNER_RESPONSE",
      step_index: 5,
      status: "DONE",
      thinking: "woken up",
      tool_calls: [{ name: "read_file", args: { Path: "/tmp/result.txt" } }],
    });
    await h.wait(
      "timeline.item",
      (e) => e.item.type === "reasoning" && e.item.text === "woken up",
    );
    const started = await h.wait(
      "timeline.item",
      (e) =>
        e.item.type === "tool_call" &&
        e.item.detail.type === "read" &&
        e.item.status === "running",
    );
    await h.wait(
      "session.notice",
      (e) => e.notice.title === "AGY automatic continuation is running",
    );
    await append({
      type: "GENERIC",
      step_index: 6,
      status: "DONE",
      content: "read result",
    });
    await h.wait(
      "timeline.item",
      (e) =>
        e.item.type === "tool_call" &&
        e.item.id === started.item.id &&
        e.item.status === "completed",
    );
    expect(
      h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ).toEqual(["started"]);
    await append({
      type: "PLANNER_RESPONSE",
      step_index: 7,
      status: "DONE",
      content: "CONTINUED_DONE",
    });
    await h.wait("session.turn", (e) => e.state === "completed");
    const readUpdates = h.events
      .filter((e) => e.type === "timeline.item")
      .filter(
        (e) => e.item.type === "tool_call" && e.item.id === started.item.id,
      );
    expect(
      readUpdates.map((e) =>
        e.item.type === "tool_call" ? e.item.status : "",
      ),
    ).toEqual(["running", "completed"]);
    expect(
      h.events
        .filter((e) => e.type === "timeline.item")
        .filter(
          (e) => e.item.type === "reasoning" && e.item.text === "woken up",
        ),
    ).toHaveLength(1);
  });

  it("reports a transcript-only continuation failure before a user needs to ask for progress", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("background", "background-held");
    await h.wait(
      "session.notice",
      (e) => e.notice.title === "Background task is running",
    );
    const file = path.join(
      h.cwd,
      ".gemini",
      "antigravity-cli",
      "brain",
      "fixture",
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    );
    const records = await readFile(file, "utf8");
    await writeFile(
      file,
      records +
        JSON.stringify({
          type: "SYSTEM_MESSAGE",
          step_index: 4,
          status: "DONE",
          content:
            'Task id "fixture/task-2" finished with result:\nCommand exited with code 0.',
        }) +
        "\n",
    );
    await h.wait("session.notice", (e) =>
      e.notice.title.includes("waiting for AGY"),
    );
    await h.prompt("progress", "progress?");
    const admission = await h.wait(
      "session.prompt_result",
      (e) => e.clientMessageId === "progress",
    );
    expect(admission.result).toMatchObject({
      type: "failed",
      error: { code: "TURN_ACTIVE" },
    });
    await writeFile(
      file,
      records +
        [
          {
            type: "SYSTEM_MESSAGE",
            step_index: 4,
            status: "DONE",
            content:
              'Task id "fixture/task-2" finished with result:\nCommand exited with code 0.',
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 5,
            status: "ERROR",
            content: "Agent execution terminated due to error.",
            error_details: { reason: "upstream unavailable", token: "private" },
          },
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") +
        "\n",
    );
    const failed = await h.wait("session.turn", (e) => e.state === "failed");
    expect(failed.error).toMatchObject({
      code: "BACKGROUND_CONTINUATION_FAILED",
      message: "Agent execution terminated due to error.",
    });
    expect(failed.error?.diagnostic).toContain("upstream unavailable");
    expect(failed.error?.diagnostic).not.toContain("private");
    await h.prompt("next", "next");
    await h.wait("session.turn", (e) => e.state === "completed");
  });

  it("keeps error diagnostics when progress replaces a background-waiting turn", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("background", "background-held");
    await h.wait(
      "session.notice",
      (e) => e.notice.title === "Background task is running",
    );
    await h.connection.send({
      type: "session.interrupt",
      sessionId: "s",
      requestId: "replace",
    });
    await h.wait("request.completed", (e) => e.requestId === "replace");
    await h.wait("session.turn", (e) => e.state === "canceled");
    await h.prompt("progress", "upstream-error");
    const failed = await h.wait("session.turn", (e) => e.state === "failed");
    expect(failed.error).toMatchObject({ code: "RPC_-32603" });
    expect(failed.error?.diagnostic).toContain(
      "service temporarily unavailable",
    );
    expect(
      h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ).toEqual(["started", "canceled", "started", "failed"]);
  });

  it("detects background work even when the transcript appears after the prompt response", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("late", "background-late");
    await h.wait(
      "timeline.item",
      (e) => e.item.type === "assistant_message" && e.item.text === "waiting",
    );
    const file = path.join(
      h.cwd,
      ".gemini",
      "antigravity-cli",
      "brain",
      "fixture",
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    );
    await writeFile(
      file,
      [
        { type: "USER_INPUT", step_index: 0, content: "test" },
        {
          type: "PLANNER_RESPONSE",
          step_index: 1,
          tool_calls: [
            { name: "run_command", args: { CommandLine: "sleep 18" } },
          ],
        },
        {
          type: "GENERIC",
          step_index: 2,
          status: "RUNNING",
          content:
            "Tool is running as a background task with task id: fixture/task-2",
        },
        {
          type: "PLANNER_RESPONSE",
          step_index: 3,
          status: "DONE",
          content: "waiting",
        },
        {
          type: "SYSTEM_MESSAGE",
          step_index: 4,
          status: "DONE",
          content:
            'Task id "fixture/task-2" finished with result:\nCommand exited with code 0.',
        },
        {
          type: "PLANNER_RESPONSE",
          step_index: 5,
          status: "DONE",
          content: "LATE_BACKGROUND_DONE",
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    await h.wait("session.turn", (e) => e.state === "completed");
    expect(
      h.events
        .filter((e) => e.type === "timeline.item")
        .filter((e) => e.item.type === "assistant_message")
        .at(-1)?.item,
    ).toMatchObject({ text: "LATE_BACKGROUND_DONE" });
  });

  it("settles a schedule wakeup without leaving the foreground tool-drain deadlocked", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("timer", "schedule-held");
    await h.wait(
      "session.notice",
      (e) => e.notice.title === "Background task is running",
    );
    const file = path.join(
      h.cwd,
      ".gemini",
      "antigravity-cli",
      "brain",
      "fixture",
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    );
    const records = await readFile(file, "utf8");
    const wake =
      records +
      JSON.stringify({
        type: "SYSTEM_MESSAGE",
        step_index: 4,
        status: "DONE",
        content:
          "[Message] timestamp=2026-11-12T15:13:58Z sender=fixture/task-2 priority=MESSAGE_PRIORITY_HIGH content=Check progress",
      }) +
      "\n";
    await writeFile(file, wake);
    await h.wait(
      "timeline.item",
      (e) =>
        e.item.type === "tool_call" &&
        e.item.name === "schedule" &&
        e.item.status === "completed",
    );
    expect(
      h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ).toEqual(["started"]);
    await writeFile(
      file,
      wake +
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 5,
          status: "DONE",
          content: "TIMER_DONE",
        }) +
        "\n",
    );
    await h.wait("session.turn", (e) => e.state === "completed");
    expect(
      h.events
        .filter((e) => e.type === "timeline.item")
        .filter((e) => e.item.type === "assistant_message")
        .at(-1)?.item,
    ).toMatchObject({ text: "TIMER_DONE" });
    await h.prompt("next", "next");
    await h.wait(
      "session.prompt_result",
      (e) => e.clientMessageId === "next" && e.result.type === "turn",
    );
  });
  it("renders a feedback-requested plan and approves implementation through the native mode change", async () => {
    const h = await harness();
    await h.open({
      config: {
        cwd: h.cwd,
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
        mode: "plan",
      },
    });
    await h.prompt("plan", "plan-proposal");
    const first = await h.wait("session.turn", (e) => e.state === "completed");
    const request = await h.wait(
      "session.permission",
      (e) => e.request.kind === "plan",
    );
    expect(request.request).toMatchObject({
      kind: "plan",
      input: { plan: expect.stringContaining("Implementation plan") },
      metadata: { source: "antigravity_artifact_feedback" },
    });
    expect(request.request.actions?.map((a) => a.intent)).toEqual([
      "implement",
      "dismiss",
    ]);
    expect(
      h.events
        .filter((e) => e.type === "timeline.item")
        .some(
          (e) => e.item.type === "tool_call" && e.item.detail.type === "plan",
        ),
    ).toBe(true);
    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: request.request.id,
      response: { behavior: "allow", selectedActionId: "implement" },
    });
    await h.wait(
      "session.permission_resolved",
      (e) => e.permissionId === request.request.id,
    );
    await h.wait(
      "session.turn",
      (e) => e.state === "completed" && e.turnId !== first.turnId,
    );
    expect(
      h.events.filter((e) => e.type === "session.config").at(-1)?.config.mode,
    ).toBe("default");
    expect(
      h.events
        .filter((e) => e.type === "timeline.item")
        .filter((e) => e.item.type === "user_message")
        .at(-1)?.item,
    ).toMatchObject({
      text: expect.stringContaining("user approved this implementation plan"),
    });
  });
  it("denies a plan without starting implementation and dismisses stale proposals on a new prompt", async () => {
    const h = await harness();
    await h.open({
      config: {
        cwd: h.cwd,
        env: {},
        mcpServers: {},
        settings: {},
        persist: false,
        mode: "plan",
      },
    });
    await h.prompt("plan", "plan-proposal");
    const approval = await h.wait(
      "session.permission",
      (e) => e.request.kind === "plan",
    );
    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: approval.request.id,
      response: { behavior: "deny", selectedActionId: "dismiss" },
    });
    await h.wait(
      "session.permission_resolved",
      (e) => e.permissionId === approval.request.id,
    );
    expect(
      h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ).toEqual(["started", "completed"]);
    expect(
      h.events.filter((e) => e.type === "session.config").at(-1)?.config.mode,
    ).toBe("plan");
    await h.prompt("next", "ordinary-artifact");
    await h.wait("session.prompt_result", (e) => e.clientMessageId === "next");
    const prior = h.events
      .filter((e) => e.type === "session.turn")
      .find((e) => e.state === "completed")!;
    await h.wait(
      "session.turn",
      (e) => e.state === "completed" && e.turnId !== prior.turnId,
    );
    expect(
      h.events.filter(
        (e) => e.type === "session.permission" && e.request.kind === "plan",
      ),
    ).toHaveLength(1);
  });
  it("keeps the plan pending when native implementation mode is rejected", async () => {
    const h = await harness({ FIXTURE_REJECT_IMPLEMENT: "1" });
    await h.open({
      config: {
        cwd: h.cwd,
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
        mode: "plan",
      },
    });
    await h.prompt("plan", "plan-proposal");
    const approval = await h.wait(
      "session.permission",
      (e) => e.request.kind === "plan",
    );
    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: approval.request.id,
      response: { behavior: "allow", selectedActionId: "implement" },
    });
    const failure = await h.wait("session.runtime_failed");
    expect(failure.error.message).toBe("implementation mode rejected");
    expect(
      h.events.filter((e) => e.type === "session.permission_resolved"),
    ).toHaveLength(0);
    expect(
      h.events.filter((e) => e.type === "session.config").at(-1)?.config.mode,
    ).toBe("plan");
    expect(
      h.events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ).toEqual(["started", "completed"]);
  });
  it.each([false, true])(
    "restores pending plans but does not reopen rejected plans (rejected=%s)",
    async (rejected) => {
      const h = await harness({ FIXTURE_EMPTY_LOAD: "1" });
      await h.open({
        config: {
          cwd: h.cwd,
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
          mode: "plan",
        },
      });
      await h.prompt("plan", "plan-proposal");
      const approval = await h.wait(
        "session.permission",
        (e) => e.request.kind === "plan",
      );
      if (rejected) {
        await h.connection.send({
          type: "session.permission",
          sessionId: "s",
          permissionId: approval.request.id,
          response: { behavior: "deny", selectedActionId: "dismiss" },
        });
        await h.wait(
          "session.permission_resolved",
          (e) => e.permissionId === approval.request.id,
        );
      }
      const persistence = h.events
        .filter((e) => e.type === "session.persistence")
        .at(-1)!.persistence;
      await h.connection.send({
        type: "session.close",
        sessionId: "s",
        requestId: "close-plan",
      });
      await h.wait("request.completed", (e) => e.requestId === "close-plan");
      await h.connection.send({
        type: "session.open",
        sessionId: "restored-plan",
        requestId: "restore-plan",
        history: "replay",
        persistence,
        config: {
          cwd: h.cwd,
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await h.wait("session.ready", (e) => e.sessionId === "restored-plan");
      const restored = h.events
        .filter((e) => e.type === "session.permission")
        .filter((e) => e.sessionId === "restored-plan");
      expect(restored).toHaveLength(rejected ? 0 : 1);
      if (!rejected) expect(restored[0]?.request.kind).toBe("plan");
    },
  );
  it("publishes real child sessions, tool linkage, independent history and completed lifecycle", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("delegate", "subagent-task");
    const child = await h.wait(
      "session.opened",
      (e) => e.parentSessionId === "s",
    );
    expect(child).toMatchObject({
      sessionId: "agy-child:12345678-1234-4123-8123-123456789abc",
      restoration: "parent",
      capabilities: [],
      title: "File reader",
    });
    const linked = h.events
      .filter((e) => e.type === "timeline.item")
      .find(
        (e) =>
          e.item.type === "tool_call" && e.item.callId === child.toolCallId,
      );
    expect(linked?.item).toMatchObject({
      type: "tool_call",
      name: "invoke_subagent",
    });
    const completed = await h.wait(
      "session.turn",
      (e) => e.sessionId === child.sessionId && e.state === "completed",
    );
    const root = await h.wait(
      "session.turn",
      (e) => e.sessionId === "s" && e.state === "completed",
    );
    expect(h.events.indexOf(completed)).toBeLessThan(h.events.indexOf(root));
    expect(
      h.events
        .filter((e) => e.type === "timeline.item")
        .filter(
          (e) => e.sessionId === "s" && e.item.type === "assistant_message",
        )
        .at(-1)?.item,
    ).toMatchObject({ text: "PARENT_DONE" });
    expect(
      h.events
        .filter((e) => e.type === "timeline.item")
        .filter((e) => e.sessionId === child.sessionId)
        .map((e) => e.item.type),
    ).toEqual(["reasoning", "tool_call", "tool_call", "assistant_message"]);
    expect(
      h.events
        .filter((e) => e.type === "timeline.item")
        .filter(
          (e) =>
            e.item.type === "tool_call" && e.item.detail.type === "sub_agent",
        )
        .at(-1)?.item,
    ).toMatchObject({
      status: "completed",
      detail: {
        childSessionId: child.sessionId,
        log: "CHILD_DONE",
        actions: [{ index: 1, toolName: "read_file", summary: "completed" }],
      },
    });
  });

  it("restores the parent and child histories after importing a local subagent conversation", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("delegate", "subagent-task");
    await h.wait(
      "session.turn",
      (e) => e.sessionId === "s" && e.state === "completed",
    );
    await h.connection.send({
      type: "session.close",
      sessionId: "s",
      requestId: "close",
    });
    await h.wait("request.completed", (e) => e.requestId === "close");
    await h.connection.send({
      type: "session.open",
      sessionId: "restored",
      requestId: "restore",
      history: "replay",
      persistence: { version: 1, data: { conversationId: "fixture" } },
      config: {
        cwd: h.cwd,
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
      },
    });
    await h.wait("session.ready", (e) => e.sessionId === "restored");
    const reopened = h.events
      .filter((e) => e.type === "session.opened")
      .filter((e) => e.parentSessionId === "restored");
    expect(reopened).toHaveLength(1);
    const childEvents = h.events
      .slice(h.events.indexOf(reopened[0]!))
      .filter(
        (e) =>
          e.type === "timeline.item" && e.sessionId === reopened[0]!.sessionId,
      );
    expect(
      childEvents.some(
        (e) =>
          e.type === "timeline.item" &&
          e.item.type === "assistant_message" &&
          e.item.text === "CHILD_DONE",
      ),
    ).toBe(true);
    expect(
      h.events.some(
        (e) => e.type === "session.turn" && e.sessionId === "restored",
      ),
    ).toBe(false);
  });
  it("keeps plan rejection distinct from ordinary file permissions", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("file", "plan-proposal");
    await h.wait("session.turn", (e) => e.state === "completed");
    expect(
      h.events.filter(
        (e) => e.type === "session.permission" && e.request.kind === "plan",
      ),
    ).toEqual([]);
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

  it("passes --dangerously-skip-permissions in full-access mode and restarts when toggling", async () => {
    const h = await harness();
    await h.open({
      config: {
        cwd: h.cwd,
        env: {},
        mcpServers: {},
        settings: {},
        persist: false,
        mode: "full-access",
      },
    });
    await h.connection.send({
      type: "session.configure",
      requestId: "to-default",
      sessionId: "s",
      changes: { mode: "default" },
    });
    await h.wait(
      "request.completed",
      (event) => event.requestId === "to-default",
    );
    await h.connection.send({
      type: "session.configure",
      requestId: "to-full",
      sessionId: "s",
      changes: { mode: "full-access" },
    });
    await h.wait("request.completed", (event) => event.requestId === "to-full");
    const argsLines = (
      await readFile(path.join(h.cwd, "fixture-args.txt"), "utf8")
    )
      .trim()
      .split("\n");
    expect(argsLines).toEqual([
      "acp --dangerously-skip-permissions",
      "acp",
      "acp --dangerously-skip-permissions",
    ]);
  });

  it("retries on a fresh ACP process when agy emits an in-band execution error before any tool call", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("retry-inband", "inband-error-once");
    await h.wait("session.turn", (event) => event.state === "completed");
    const assistantMessages = h.events
      .filter((event) => event.type === "timeline.item")
      .filter((event) => event.item.type === "assistant_message")
      .map((event) =>
        event.item.type === "assistant_message" ? event.item.text : "",
      );
    expect(assistantMessages).toEqual(["RECOVERED_OK"]);
    expect(
      (await readFile(path.join(h.cwd, "fixture-processes.txt"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(2);
  });

  it("fails the turn instead of marking it completed when agy repeatedly emits in-band execution errors", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("fail-inband", "inband-error-always");
    const failed = await h.wait(
      "session.turn",
      (event) => event.state === "failed",
    );
    expect(failed.error).toMatchObject({
      code: "AGENT_EXECUTION_ERROR",
      message: "Agent execution terminated due to error.",
    });
    const assistantMessages = h.events
      .filter((event) => event.type === "timeline.item")
      .filter((event) => event.item.type === "assistant_message");
    expect(assistantMessages).toHaveLength(0);
    expect(
      (await readFile(path.join(h.cwd, "fixture-processes.txt"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(3);
  });

  it("preserves a completed turn when the assistant genuinely outputs the execution error string", async () => {
    const h = await harness();
    await h.open();
    await h.prompt("literal-inband", "inband-error-literal-reply");
    await h.wait("session.turn", (event) => event.state === "completed");
    const assistantMessages = h.events
      .filter((event) => event.type === "timeline.item")
      .filter((event) => event.item.type === "assistant_message")
      .map((event) =>
        event.item.type === "assistant_message" ? event.item.text : "",
      );
    expect(assistantMessages).toEqual([
      "⚠ Agent execution terminated due to error.",
    ]);
    expect(
      (await readFile(path.join(h.cwd, "fixture-processes.txt"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });

  it("automatically rewinds SQLite history, recycles ACP, and retries transient silent errors", async () => {
    const h = await harness({
      FIXTURE_DB: "1",
      PASEO_AGY_AUTO_RETRY_DELAY_MS: "10",
    });
    await h.open();
    await h.prompt("m1", "transient-silent-error");
    await h.wait("session.turn", (event) => event.state === "completed");

    const assistantTexts = h.events
      .filter((event) => event.type === "timeline.item")
      .flatMap((event) =>
        event.item.type === "assistant_message" ? [event.item.text] : [],
      );
    expect(assistantTexts).not.toContain(
      "Agent execution terminated due to error.",
    );
    expect(assistantTexts.at(-1)).toBe("RECOVERED_AFTER_REWIND(stepsBefore=0)");

    const turns = h.events
      .filter((event) => event.type === "session.turn")
      .map((event) => event.state);
    expect(turns).toEqual(["started", "completed"]);

    const retryNotices = h.events
      .filter((event) => event.type === "session.notice")
      .filter((event) => event.notice.id.startsWith("auto-retry:"));
    expect(retryNotices.some((event) => !event.notice.dismissed)).toBe(true);
    expect(retryNotices.at(-1)?.notice.dismissed).toBe(true);

    const pids = (
      await readFile(path.join(h.cwd, "fixture-processes.txt"), "utf8")
    )
      .trim()
      .split("\n");
    expect(pids).toHaveLength(2);
    expect(pids[0]).not.toBe(pids[1]);
  });

  it("reverts tracked file modifications before retrying a failed transient turn", async () => {
    const h = await harness({
      FIXTURE_DB: "1",
      PASEO_AGY_AUTO_RETRY_DELAY_MS: "10",
    });
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    await writeFile(
      path.join(h.cwd, ".git", "info", "exclude"),
      "retry-attempts.txt\n",
    );
    const target = path.join(h.cwd, "edited.txt");
    await writeFile(target, "clean-before");
    execFileSync("git", ["add", "edited.txt"], { cwd: h.cwd });

    await h.open();
    await h.prompt("m1", "edit-then-silent-error");
    await h.wait("session.turn", (event) => event.state === "completed");

    const assistantTexts = h.events
      .filter((event) => event.type === "timeline.item")
      .flatMap((event) =>
        event.item.type === "assistant_message" ? [event.item.text] : [],
      );
    expect(assistantTexts.at(-1)).toBe(
      "RECOVERED_AFTER_REWIND(stepsBefore=0:clean-before)",
    );
    expect(await readFile(target, "utf8")).toBe("clean-before");
  });

  it("does not auto-retry non-transient errors or turns after shell side effects", async () => {
    for (const [promptText, expectedDetail] of [
      ["nonretryable-silent-error", "credits balance is too low"],
      ["shell-then-silent-error", "User location is not supported"],
    ] as const) {
      const h = await harness({
        FIXTURE_DB: "1",
        PASEO_AGY_AUTO_RETRY_DELAY_MS: "10",
      });
      await h.open();
      await h.prompt("m1", promptText);
      const failed = await h.wait(
        "session.turn",
        (event) => event.state === "failed",
      );
      expect(failed.error?.diagnostic).toContain(expectedDetail);
      const attempts = (
        await readFile(path.join(h.cwd, "retry-attempts.txt"), "utf8")
      )
        .trim()
        .split("\n");
      expect(attempts).toHaveLength(1);
    }
  });

  it("emits loading and completed compaction items for manual /compact and auto-compaction turns", async () => {
    const h = await harness({ FIXTURE_DB: "1" });
    await h.open();

    await h.prompt("c1", "/compact");
    await h.wait("session.turn", (event) => event.state === "completed");

    const manualCompactions = h.events
      .filter((event) => event.type === "timeline.item")
      .flatMap((event) =>
        event.item.type === "compaction" ? [event.item] : [],
      );
    expect(manualCompactions.map((item) => item.status)).toEqual([
      "loading",
      "completed",
    ]);
    expect(manualCompactions.at(-1)).toMatchObject({
      type: "compaction",
      status: "completed",
      trigger: "manual",
      preTokens: 120_000,
    });

    const beforeAutoCount = h.events.length;
    await h.connection.send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "c2",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "auto-compact-turn" }],
        },
      },
    });
    await new Promise<void>((resolve, reject) => {
      const check = () =>
        h.events
          .slice(beforeAutoCount)
          .some(
            (event) =>
              event.type === "session.turn" && event.state === "completed",
          );
      if (check()) {
        resolve();
        return;
      }
      const timer = setInterval(() => {
        if (check()) {
          clearInterval(timer);
          clearTimeout(timeout);
          resolve();
        }
      }, 20);
      const timeout = setTimeout(() => {
        clearInterval(timer);
        reject(new Error("Timed out waiting for second turn"));
      }, 2000);
    });

    const autoCompactions = h.events
      .slice(beforeAutoCount)
      .filter((event) => event.type === "timeline.item")
      .flatMap((event) =>
        event.item.type === "compaction" ? [event.item] : [],
      );
    expect(autoCompactions.map((item) => item.status)).toEqual([
      "loading",
      "completed",
    ]);
    expect(autoCompactions.at(-1)).toMatchObject({
      type: "compaction",
      status: "completed",
      trigger: "auto",
      preTokens: 245_000,
    });
  });

  it("interleaves completed compaction items in chronological order during ACP session/load replay", async () => {
    const h = await harness({ FIXTURE_LOAD_COMPACT: "1" });
    const dbDir = path.join(
      h.cwd,
      ".gemini",
      "antigravity-cli",
      "conversations",
    );
    await mkdir(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "fixture.db"));
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)",
    );
    const varint = (v: number): Buffer => {
      const out: number[] = [];
      let n = v;
      while (n >= 0x80) {
        out.push((n & 0x7f) | 0x80);
        n = Math.floor(n / 128);
      }
      out.push(n);
      return Buffer.from(out);
    };
    const metaWithTokens = (tokens: number): Buffer => {
      const usage = Buffer.concat([
        varint(2 << 3),
        varint(10_000),
        varint(5 << 3),
        varint(tokens - 10_000),
      ]);
      return Buffer.concat([varint((9 << 3) | 2), varint(usage.length), usage]);
    };
    const insert = db.prepare("INSERT INTO steps VALUES (?, ?, 3, ?, ?)");
    const empty = Buffer.alloc(0);
    insert.run(0, 14, empty, empty);
    insert.run(1, 15, empty, empty);
    insert.run(2, 23, metaWithTokens(200_000), empty);
    insert.run(3, 14, empty, empty);
    insert.run(4, 23, metaWithTokens(45_000), empty);
    insert.run(5, 15, empty, empty);
    insert.run(6, 14, empty, empty);
    insert.run(7, 15, empty, empty);
    insert.run(8, 23, metaWithTokens(215_000), empty);
    db.close();

    await h.open({
      history: "replay",
      persistence: { version: 1, data: { conversationId: "fixture" } },
    });

    const summary = h.events
      .filter((event) => event.type === "timeline.item")
      .map((event) => {
        const item = event.item;
        if (item.type === "user_message" || item.type === "assistant_message") {
          return `${item.type}:${item.text}`;
        }
        if (item.type === "compaction") {
          return `compaction:${item.trigger}:${item.preTokens}`;
        }
        return item.type;
      });
    expect(summary).toEqual([
      "user_message:u1",
      "assistant_message:a1",
      "compaction:auto:200000",
      "user_message:/compact",
      "compaction:manual:45000",
      "assistant_message:compacted reply",
      "user_message:u3",
      "assistant_message:a3",
      "compaction:auto:215000",
    ]);
  });
});
