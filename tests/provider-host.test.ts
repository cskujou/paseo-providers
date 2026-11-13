import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/paseo-host.mjs", import.meta.url),
);
async function run(mode: string): Promise<unknown> {
  const { stdout } = await exec(process.execPath, [fixture, mode], {
    timeout: 20000,
  });
  const result = stdout
    .trim()
    .split("\n")
    .filter((line) => !line.startsWith("[antigravity]"))
    .at(-1);
  if (!result) throw new Error("Host fixture did not return a result");
  return JSON.parse(result);
}

describe("compiled provider through the real Paseo host", () => {
  it("preserves import-sheet summaries through schema validation, listing and import", async () => {
    expect(await run("summaries")).toEqual({
      listed: [
        {
          title: "matching title",
          firstPromptPreview: "First request",
          lastPromptPreview: "Latest request needle",
          hasActivity: true,
        },
      ],
      timeline: [
        {
          type: "user_message",
          text: "First\nrequest",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "tool_call",
          timestamp: "2026-01-01T00:00:01.000Z",
          status: "completed",
          detail: {
            type: "shell",
            command: "npm test",
            output: "passed",
            exitCode: 0,
          },
        },
        {
          type: "user_message",
          text: "Latest request needle",
          timestamp: "2026-01-01T00:00:03.000Z",
        },
        {
          type: "assistant_message",
          text: "answer",
          timestamp: "2026-01-01T00:00:04.000Z",
        },
      ],
      hasPersistence: true,
    });
  }, 20000);
  it("keeps settings, runtime info, prompt settlement and idle safety in sync with the native agent", async () => {
    expect(await run("contract")).toEqual({
      modelCount: 2,
      info: {
        model: "claude-opus-5-5",
        modeId: "auto",
        thinkingOptionId: "high",
      },
      rejectedMode: "plan rejected",
      drainOrder: [
        "turn_started",
        "running",
        "reasoning",
        "completed",
        "turn_completed",
      ],
      features: [{ id: "agent", value: "review" }],
      turns: ["turn_started", "turn_completed"],
      idle: true,
      busy: false,
      idleAfterInterrupt: true,
      restoredInfo: { model: "claude-opus-5-5" },
    });
  }, 20000);
  it("preserves upstream failures and safe diagnostic details in the actual host event", async () => {
    expect(await run("diagnostics")).toMatchObject({
      message: "Agent execution terminated due to error.",
      code: "RPC_-32603",
      diagnostic: expect.stringContaining("service temporarily unavailable"),
      followUpSucceeded: true,
    });
  }, 20000);

  it("publishes automatic tools before ending the foreground host run", async () => {
    expect(await run("background-stream")).toEqual({
      endedBeforeTools: false,
      finalText: "STREAM_DONE",
      readStatuses: ["running", "completed"],
      turns: ["turn_started", "turn_completed"],
    });
  }, 20000);

  it("renders the plan approval and starts implementation after native mode commit", async () => {
    expect(await run("plan-approval")).toEqual({
      planKind: "plan",
      planText: "# Implementation plan\nCreate output.txt and verify it.",
      mode: "default",
      turns: [
        "turn_started",
        "turn_completed",
        "turn_started",
        "turn_completed",
      ],
      planCards: ["running", "completed"],
    });
  }, 20000);
  it("preserves child graph, history, linked tool and parent automatic reply", async () => {
    const result = await run("subagent-lifecycle");
    if (
      !result ||
      typeof result !== "object" ||
      !("updates" in result) ||
      !Array.isArray(result.updates)
    )
      throw new Error("Missing child updates");
    expect(result.updates[0]).toEqual({
      id: "agy-child:12345678-1234-4123-8123-123456789abc",
      parent: null,
      status: "running",
      hasToolLink: true,
    });
    expect(result.updates.at(-1)).toEqual({
      id: "agy-child:12345678-1234-4123-8123-123456789abc",
      status: "completed",
      hasToolLink: false,
    });
    expect(
      result.updates.filter((update) => update.status === "completed"),
    ).toHaveLength(1);
    expect(
      result.updates.every(
        (update) =>
          update.id === "agy-child:12345678-1234-4123-8123-123456789abc" &&
          ["running", "completed"].includes(update.status),
      ),
    ).toBe(true);
    expect(result).toMatchObject({
      childTimeline: [
        "reasoning",
        "tool_call",
        "tool_call",
        "assistant_message",
      ],
      hasLinkedCard: true,
      historyEvents: 6,
      parentFinalText: "PARENT_DONE",
    });
  }, 20000);
  it("auto-rewinds transient execution errors and forwards compaction timeline events through the host", async () => {
    expect(await run("retry-and-compaction")).toEqual({
      retryFinalText: "RECOVERED_AFTER_REWIND(stepsBefore=0)",
      autoFinalText: "Auto compact turn complete.",
      manualFinalText: "Manual compact complete.",
      assistantLeakedError: false,
      turns: [
        "turn_started",
        "turn_completed",
        "turn_started",
        "turn_completed",
        "turn_started",
        "turn_completed",
      ],
      liveCompactions: [
        { status: "loading", trigger: "auto", preTokens: null },
        { status: "completed", trigger: "auto", preTokens: 245_000 },
        { status: "loading", trigger: "manual", preTokens: null },
        { status: "completed", trigger: "manual", preTokens: 120_000 },
      ],
      importedTimeline: [
        { type: "user_message", text: "long task" },
        { type: "compaction", status: "completed", trigger: "auto" },
        { type: "assistant_message", text: "done" },
      ],
    });
  }, 20000);
  it("compiles the client bundle and renders Antigravity thinking expanded inline while keeping other providers collapsed", async () => {
    expect(await run("inline-thinking")).toEqual({
      queryItemType: "reasoning",
      emptySkipped: true,
      kind: "antigravity-inline-thinking",
      agyRootExpanded: true,
      agyRootText: "Checking build graph...",
      agyRootPhase: "streaming",
      agyRootAfterCollapse: false,
      agyChildExpanded: true,
      agyArchivedExpanded: true,
      codexDefaultExpanded: false,
      codexAfterExpand: true,
    });
  }, 20000);
  it("keeps description-only previews working for other plugin providers", async () => {
    expect(await run("legacy")).toEqual([
      { firstPromptPreview: null, lastPromptPreview: "old-style preview" },
    ]);
  }, 20000);
});
