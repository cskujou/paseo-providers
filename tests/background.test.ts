import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { readBackgroundTurn } from "../providers/antigravity-provider/server/internal/background.js";
it("waits for task completion and the automatic planner reply, not the foreground end", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-background-test-"));
  const dir = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    "fixture",
    ".system_generated",
    "logs",
  );
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "transcript_full.jsonl");
  const records: Record<string, unknown>[] = [
    { type: "USER_INPUT" },
    {
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "sleep 18" } }],
    },
    {
      type: "GENERIC",
      status: "RUNNING",
      content:
        "Tool is running as a background task with task id: fixture/task-2",
    },
    { type: "PLANNER_RESPONSE", status: "DONE", content: "waiting" },
  ];
  const save = () =>
    writeFile(file, records.map((r) => JSON.stringify(r)).join("\n"));
  try {
    await save();
    expect((await readBackgroundTurn("fixture", { HOME: home }))?.settled).toBe(
      false,
    );
    records.push({
      type: "SYSTEM_MESSAGE",
      step_index: 4,
      content:
        'Task id "fixture/task-2" finished with result:\nCommand exited with code 0.',
    });
    await save();
    expect((await readBackgroundTurn("fixture", { HOME: home }))?.settled).toBe(
      false,
    );
    records.push({
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "automatic answer",
    });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: true,
      continuationStep: 4,
      tasks: [{ command: "sleep 18", completed: true, exitCode: 0 }],
    });
    records.push({ type: "USER_INPUT" });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toBe(null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
