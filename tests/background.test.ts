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
    records.push({
      type: "PLANNER_RESPONSE",
      step_index: 5,
      status: "ERROR",
      content: "Agent execution terminated due to error.",
      error_details: { reason: "upstream failed" },
    });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      continuationStarted: true,
      failure: {
        message: "Agent execution terminated due to error.",
        details: { reason: "upstream failed" },
      },
    });
    records.push({ type: "USER_INPUT" });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toBe(null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("waits for a real subagent result and the parent's automatic continuation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-child-background-"));
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
  const child = "12345678-1234-4123-8123-123456789abc";
  const output =
    "Created the following subagent:\n" +
    JSON.stringify({ conversationId: child }, null, 2);
  const records: object[] = [
    { type: "USER_INPUT", step_index: 0 },
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      status: "DONE",
      tool_calls: [
        { name: "read_file", args: { Path: "input.txt" } },
        { name: "invoke_subagent", args: { TypeName: "research" } },
      ],
    },
    { type: "VIEW_FILE", step_index: 2, status: "DONE", content: output },
    { type: "GENERIC", step_index: 3, status: "DONE", content: output },
    {
      type: "PLANNER_RESPONSE",
      step_index: 4,
      status: "DONE",
      content: "waiting",
    },
  ];
  const save = () =>
    writeFile(file, records.map((r) => JSON.stringify(r)).join("\n"));
  try {
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      tasks: [{ id: child, kind: "subagent", completed: false }],
    });
    records.push({
      type: "SYSTEM_MESSAGE",
      step_index: 5,
      status: "DONE",
      content: "<SYSTEM_MESSAGE> sender=" + child + "\nresult</SYSTEM_MESSAGE>",
    });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      tasks: [{ completed: true }],
      continuationStep: 5,
    });
    records.push({
      type: "PLANNER_RESPONSE",
      step_index: 6,
      status: "DONE",
      content: "parent answer",
    });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: true,
      continuationStarted: true,
    });
    records.splice(1, 1, {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      status: "DONE",
      tool_calls: [
        { name: "read_file", args: { Path: "input.txt" } },
        { name: "read_file", args: { Path: "other.txt" } },
      ],
    });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toBe(null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("recognizes schedule timer wakeups, chained timers, and TimerCondition early cancellation", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "agy-schedule-background-"),
  );
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
    { type: "USER_INPUT", step_index: 1 },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      tool_calls: [
        {
          name: "schedule",
          args: {
            DurationSeconds: 60,
            Prompt: "Check 1-minute progress",
            TimerCondition: "any",
          },
        },
      ],
    },
    {
      type: "GENERIC",
      step_index: 3,
      status: "RUNNING",
      content:
        "Tool is running as a background task with task id: fixture/task-3\nTask Description: Timer: 1m, Prompt: Check 1-minute progress",
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 4,
      status: "DONE",
      content: "Started 1-minute timer",
    },
  ];
  const save = () =>
    writeFile(file, records.map((r) => JSON.stringify(r)).join("\n"));
  try {
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      tasks: [
        {
          id: "fixture/task-3",
          toolName: "schedule",
          prompt: "Check 1-minute progress",
          completed: false,
        },
      ],
    });
    records.push({
      type: "SYSTEM_MESSAGE",
      step_index: 5,
      status: "DONE",
      content:
        "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-12T15:13:58Z sender=fixture/task-3 priority=MESSAGE_PRIORITY_HIGH content=Check 1-minute progress\n</SYSTEM_MESSAGE>",
    });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      continuationStep: 5,
      continuationStarted: false,
      tasks: [{ id: "fixture/task-3", completed: true }],
    });
    // Planner wakes up, schedules a second timer AND a background command, then reports progress 1
    records.push(
      {
        type: "PLANNER_RESPONSE",
        step_index: 6,
        status: "DONE",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "echo done" } },
          {
            name: "schedule",
            args: {
              DurationSeconds: 60,
              Prompt: "Check 2-minute progress",
              TimerCondition: "any",
            },
          },
        ],
      },
      {
        type: "GENERIC",
        step_index: 7,
        status: "RUNNING",
        content:
          "Tool is running as a background task with task id: fixture/task-7",
      },
      {
        type: "GENERIC",
        step_index: 8,
        status: "RUNNING",
        content:
          "Tool is running as a background task with task id: fixture/task-8\nTask Description: Timer: 1m, Prompt: Check 2-minute progress",
      },
      {
        type: "PLANNER_RESPONSE",
        step_index: 9,
        status: "DONE",
        content: "Minute 1 report",
      },
    );
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      continuationStep: 5,
      continuationStarted: true,
    });
    // When task-7 (run_command) finishes, task-8 (schedule with TimerCondition: "any") is also cancelled early
    records.push({
      type: "SYSTEM_MESSAGE",
      step_index: 10,
      status: "DONE",
      content:
        'Task id "fixture/task-7" finished with result:\nCommand exited with code 0.',
    });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      continuationStarted: false,
      tasks: [
        { id: "fixture/task-3", completed: true },
        { id: "fixture/task-7", completed: true, exitCode: 0 },
        { id: "fixture/task-8", completed: true },
      ],
    });
    records.push({
      type: "PLANNER_RESPONSE",
      step_index: 11,
      status: "DONE",
      content: "Final report",
    });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: true,
      continuationStarted: true,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("tracks finite cron wakeups and settles a successfully killed schedule, not a failed kill", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-cron-background-"));
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
    { type: "USER_INPUT", step_index: 0 },
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      tool_calls: [
        {
          name: "schedule",
          args: {
            Prompt: "Check progress",
            CronExpression: "* * * * *",
            MaxIterations: "2",
          },
        },
      ],
    },
    {
      type: "GENERIC",
      step_index: 2,
      status: "RUNNING",
      content:
        "Tool is running as a background task with task id: fixture/task-2\nTask Description: Cron: * * * * *",
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      status: "DONE",
      content: "waiting",
    },
  ];
  const save = () =>
    writeFile(file, records.map((r) => JSON.stringify(r)).join("\n"));
  const wake = (step: number) => ({
    type: "SYSTEM_MESSAGE",
    step_index: step,
    status: "DONE",
    content:
      "[Message] timestamp=2026-11-12T15:13:58Z sender=fixture/task-2 priority=MESSAGE_PRIORITY_HIGH content=Check progress",
  });
  try {
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      tasks: [{ remainingRuns: 2, completed: false }],
    });
    records.push(wake(4), {
      type: "PLANNER_RESPONSE",
      step_index: 5,
      status: "DONE",
      content: "first report",
    });
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      tasks: [{ remainingRuns: 1, completed: false }],
    });
    records.push(wake(6));
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      continuationStarted: false,
      tasks: [{ remainingRuns: 0, completed: true }],
    });
    records.push({
      type: "PLANNER_RESPONSE",
      step_index: 7,
      status: "DONE",
      content: "final report",
    });
    await save();
    expect((await readBackgroundTurn("fixture", { HOME: home }))?.settled).toBe(
      true,
    );
    records.length = 4;
    records.push(
      {
        type: "PLANNER_RESPONSE",
        step_index: 4,
        tool_calls: [
          {
            name: "manage_task",
            args: { Action: "kill", TaskId: "fixture/task-2" },
          },
        ],
      },
      {
        type: "GENERIC",
        step_index: 5,
        status: "ERROR",
        content: "kill failed",
      },
      {
        type: "PLANNER_RESPONSE",
        step_index: 6,
        status: "DONE",
        content: "could not stop",
      },
    );
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: false,
      tasks: [{ completed: false }],
    });
    records[5] = {
      type: "GENERIC",
      step_index: 5,
      status: "DONE",
      content: "killed",
    };
    await save();
    expect(await readBackgroundTurn("fixture", { HOME: home })).toMatchObject({
      settled: true,
      tasks: [{ completed: true }],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
