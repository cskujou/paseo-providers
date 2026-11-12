import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { it, expect } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { SubagentTracker } from "../providers/antigravity-provider/server/internal/subagents.js";
const child = "12345678-1234-4123-8123-123456789abc";
const grandchild = "12345678-1234-4123-8123-123456789abd";
async function writeTranscript(home: string, id: string, records: object[]) {
  const dir = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    id,
    ".system_generated",
    "logs",
  );
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "transcript_full.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n"),
  );
}
function launch(id: string) {
  return [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      status: "DONE",
      tool_calls: [
        {
          name: "invoke_subagent",
          args: { TypeName: "research", Prompt: "Read file", Role: "Reader" },
        },
      ],
    },
    {
      type: "GENERIC",
      step_index: 2,
      status: "DONE",
      content:
        "Created the following subagent:\n" +
        JSON.stringify({ conversationId: id }, null, 2),
    },
  ];
}
it("replays nested child sessions once and preserves their terminal failures", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-child-history-"));
  const events: ProviderEvent[] = [];
  const tracker = new SubagentTracker({
    id: "root",
    conversationId: "fixture",
    cwd: home,
    env: { HOME: home },
    emit: (e) => events.push(e),
    resolveCallId: (id) => id,
  });
  try {
    await writeTranscript(home, "fixture", launch(child));
    await writeTranscript(home, child, launch(grandchild));
    await writeTranscript(home, grandchild, [
      {
        type: "PLANNER_RESPONSE",
        step_index: 0,
        status: "ERROR",
        content: "subagent failed",
      },
    ]);
    await tracker.refresh();
    await tracker.refresh();
    const opened = events.filter((e) => e.type === "session.opened");
    expect(opened.map((e) => e.parentSessionId)).toEqual([
      "root",
      "agy-child:" + child,
    ]);
    expect(
      events
        .filter((e) => e.type === "session.turn")
        .filter((e) => e.sessionId === "agy-child:" + grandchild)
        .map((e) => e.state),
    ).toEqual(["started", "failed"]);
    expect(tracker.running).toBe(true);
    tracker.finish("canceled");
    expect(tracker.running).toBe(false);
    expect(
      events
        .filter((e) => e.type === "session.turn")
        .filter((e) => e.sessionId === "agy-child:" + child)
        .map((e) => e.state),
    ).toEqual(["started", "canceled"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("does not fabricate a child from an invalid or untrusted launch-result id", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-child-invalid-"));
  const events: ProviderEvent[] = [];
  try {
    await writeTranscript(home, "fixture", launch("../../other"));
    const tracker = new SubagentTracker({
      id: "root",
      conversationId: "fixture",
      cwd: home,
      env: { HOME: home },
      emit: (e) => events.push(e),
      resolveCallId: (id) => id,
    });
    await tracker.refresh();
    expect(events).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("matches concrete results ahead of a child launch and never revives canceled children", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-child-mixed-"));
  const events: ProviderEvent[] = [];
  const tracker = new SubagentTracker({
    id: "root",
    conversationId: "fixture",
    cwd: home,
    env: { HOME: home },
    emit: (e) => events.push(e),
    resolveCallId: (id) => id,
  });
  try {
    const records: object[] = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        status: "DONE",
        tool_calls: [
          { name: "read_file", args: { Path: "input.txt" } },
          {
            name: "invoke_subagent",
            args: { TypeName: "research", Prompt: "Read file", Role: "Reader" },
          },
        ],
      },
      { type: "VIEW_FILE", step_index: 2, status: "DONE", content: "text" },
      launch(child)[1]!,
    ];
    await writeTranscript(home, "fixture", records);
    await writeTranscript(home, child, [
      {
        type: "PLANNER_RESPONSE",
        step_index: 0,
        status: "RUNNING",
        thinking: "working",
      },
    ]);
    await tracker.refresh();
    expect(events.filter((e) => e.type === "session.opened")).toHaveLength(1);
    tracker.finish("canceled");
    const count = events.length;
    await writeTranscript(home, child, launch(grandchild));
    await tracker.refresh();
    expect(events).toHaveLength(count);
    expect(tracker.running).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("discovers new children after explicit runtime reconnection without reviving canceled ones", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-child-reconnect-"));
  const events: ProviderEvent[] = [];
  const tracker = new SubagentTracker({
    id: "root",
    conversationId: "fixture",
    cwd: home,
    env: { HOME: home },
    emit: (e) => events.push(e),
    resolveCallId: (id) => id,
  });
  try {
    await writeTranscript(home, "fixture", launch(child));
    await writeTranscript(home, child, [
      { type: "PLANNER_RESPONSE", step_index: 0, status: "RUNNING" },
    ]);
    await tracker.refresh();
    tracker.finish("canceled");
    await writeTranscript(home, "fixture", [
      ...launch(child),
      { type: "USER_INPUT", step_index: 3, content: "next" },
      ...launch(grandchild),
    ]);
    await writeTranscript(home, grandchild, [
      {
        type: "PLANNER_RESPONSE",
        step_index: 0,
        status: "DONE",
        content: "new child",
      },
    ]);
    await tracker.resume();
    await tracker.refresh();
    expect(
      events.filter((e) => e.type === "session.opened").map((e) => e.sessionId),
    ).toEqual(["agy-child:" + child, "agy-child:" + grandchild]);
    expect(
      events
        .filter((e) => e.type === "session.turn")
        .filter((e) => e.sessionId === "agy-child:" + child)
        .map((e) => e.state),
    ).toEqual(["started", "canceled"]);
    expect(
      events
        .filter((e) => e.type === "session.turn")
        .filter((e) => e.sessionId === "agy-child:" + grandchild)
        .map((e) => e.state),
    ).toEqual(["started", "completed"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
