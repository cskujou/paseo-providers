import { createInterface } from "node:readline";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

if (process.argv.includes("models")) {
  process.stdout.write(
    "gemini-4-carbon-medium    Gemini 4 Carbon (Medium)\ngemini-4-carbon-high      Gemini 4 Carbon (High)\nclaude-opus-5-5-high      Claude Opus 5.5 (High)\n",
  );
  process.exit(0);
}
appendFileSync(
  path.join(process.env.HOME, "fixture-processes.txt"),
  process.pid + "\n",
);
appendFileSync(
  path.join(process.env.HOME, "fixture-args.txt"),
  process.argv.slice(2).join(" ") + "\n",
);
let controlledTool = false;
let model = process.env.FIXTURE_MODEL ?? "gemini-4-carbon";
let thought = "medium";
let mode = "default";
let agent = "default";
let activePrompt;
let permissionPrompt;
const sessionId = "fixture";
function options() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [
        { value: "gemini-4-carbon", name: "Gemini" },
        { value: "claude-opus-5-5", name: "Claude" },
      ],
    },
    {
      id: "reasoning",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: thought,
      options: ["low", "medium", "high"].map((value) => ({
        value,
        name: value,
      })),
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: mode,
      options: ["auto", "default", "plan", "accept-edits"].map((value) => ({
        value,
        name: value,
      })),
    },
    {
      id: "agent",
      name: "Agent",
      category: "_agent",
      type: "select",
      currentValue: agent,
      options: ["default", "review"].map((value) => ({ value, name: value })),
    },
  ];
}
function frame(value) {
  return JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n";
}
function send(value) {
  process.stdout.write(frame(value));
}
function reply(request, result = {}) {
  send({ id: request.id, result });
}
function error(request, message, code = -32602, data) {
  send({ id: request.id, error: { code, message, data } });
}
function update(sessionUpdate, fields) {
  return {
    method: "session/update",
    params: { sessionId, update: { sessionUpdate, ...fields } },
  };
}
function chunk(type, text, id) {
  return update(type, {
    content: { type: "text", text },
    ...(id ? { messageId: id } : {}),
  });
}
function pbVarint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  while (remaining >= 0x80n) {
    bytes.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return Buffer.from(bytes);
}
function pbVarintField(field, value) {
  return Buffer.concat([pbVarint(field << 3), pbVarint(value)]);
}
function pbBytesField(field, payload) {
  const buf = typeof payload === "string" ? Buffer.from(payload) : payload;
  return Buffer.concat([pbVarint((field << 3) | 2), pbVarint(buf.length), buf]);
}
function openFixtureDb() {
  const dbPath = path.join(
    process.env.HOME,
    ".gemini",
    "antigravity-cli",
    "conversations",
    sessionId + ".db",
  );
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 2000 });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)",
  );
  for (const table of [
    "gen_metadata",
    "executor_metadata",
    "parent_references",
    "battle_mode_infos",
  ]) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (idx INTEGER PRIMARY KEY)`);
  }
  return db;
}
function insertDbStep(db, stepType, status, metadata, payload) {
  const row = db
    .prepare("SELECT COALESCE(MAX(idx) + 1, 0) AS nextIdx FROM steps")
    .get();
  const idx = Number(row.nextIdx ?? 0);
  db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?)").run(
    idx,
    stepType,
    status,
    metadata ?? Buffer.alloc(0),
    payload ?? Buffer.alloc(0),
  );
  for (const table of [
    "gen_metadata",
    "executor_metadata",
    "parent_references",
    "battle_mode_infos",
  ]) {
    db.prepare(`INSERT INTO ${table} VALUES (?)`).run(idx);
  }
  return idx;
}
function buildErrorStepPayload(shortError, httpStatus = 400) {
  return pbBytesField(
    24,
    Buffer.concat([
      pbBytesField(
        3,
        Buffer.concat([
          pbBytesField(1, "Agent execution terminated due to error."),
          pbBytesField(2, shortError),
          pbVarintField(7, httpStatus),
        ]),
      ),
      pbVarintField(5, 1),
    ]),
  );
}
function buildCompactionMetadata(preTokens) {
  return Buffer.concat([
    pbBytesField(
      1,
      Buffer.concat([pbVarintField(1, 1_762_992_000), pbVarintField(2, 0)]),
    ),
    pbBytesField(
      9,
      Buffer.concat([
        pbVarintField(2, 10_000),
        pbVarintField(5, preTokens - 10_000),
      ]),
    ),
  ]);
}
if (process.env.FIXTURE_DB === "1") {
  const db = openFixtureDb();
  db.close();
}
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  const f = JSON.parse(line);
  if (!f.method) {
    if (f.id === 100 && permissionPrompt) {
      send(chunk("agent_message_chunk", JSON.stringify(f.result)));
      reply(permissionPrompt, { stopReason: "end_turn" });
      permissionPrompt = undefined;
    }
    return;
  }
  switch (f.method) {
    case "initialize":
      reply(f, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
      });
      break;
    case "session/new":
    case "session/resume":
      reply(f, { sessionId, configOptions: options() });
      break;
    case "session/load": {
      if (process.env.FIXTURE_EMPTY_LOAD === "1") {
        reply(f, { configOptions: options() });
        break;
      }
      if (process.env.FIXTURE_LOAD_COMPACT === "1") {
        const frames = [
          chunk("user_message_chunk", "u1", "u1"),
          chunk("agent_message_chunk", "a1", "a1"),
          chunk("user_message_chunk", "/compact", "u2"),
          chunk("agent_message_chunk", "compacted reply", "a2"),
          chunk("user_message_chunk", "u3", "u3"),
          chunk("agent_message_chunk", "a3", "a3"),
          { id: f.id, result: { configOptions: options() } },
        ];
        process.stdout.write(frames.map(frame).join(""));
        break;
      }
      const ids = process.env.FIXTURE_MESSAGE_IDS === "1";
      const frames = [
        chunk("user_message_chunk", "u1", ids ? "u1" : undefined),
        chunk("agent_message_chunk", "a1", ids ? "a1" : undefined),
        chunk("user_message_chunk", "u2", ids ? "u2" : undefined),
        chunk("agent_message_chunk", "a2", ids ? "a2" : undefined),
        { id: f.id, result: { configOptions: options() } },
      ];
      process.stdout.write(frames.map(frame).join(""));
      break;
    }
    case "session/set_config_option":
      if (
        f.params.value === "plan" &&
        process.env.FIXTURE_REJECT_PLAN === "1"
      ) {
        error(f, "plan rejected");
        break;
      }
      if (
        f.params.configId === "mode" &&
        f.params.value === "default" &&
        process.env.FIXTURE_REJECT_IMPLEMENT === "1"
      ) {
        error(f, "implementation mode rejected");
        break;
      }
      if (f.params.configId === "model") model = f.params.value;
      else if (f.params.configId === "reasoning") thought = f.params.value;
      else if (f.params.configId === "mode") mode = f.params.value;
      else if (f.params.configId === "agent") agent = f.params.value;
      else {
        error(f, "unknown config id");
        break;
      }
      if (
        controlledTool &&
        existsSync(path.join(process.env.HOME, "finish-tool"))
      ) {
        controlledTool = false;
        send(
          update("tool_call_update", {
            toolCallId: "controlled-tool",
            status: "completed",
          }),
        );
      }
      reply(f, { configOptions: options() });
      break;
    case "session/prompt": {
      const text = f.params.prompt[0]?.text;
      if (
        text === "early-end" ||
        text === "early-end-hold" ||
        text === "early-end-exit"
      ) {
        send(
          update("tool_call", {
            toolCallId: "reused-tool",
            title: "unfinished",
            kind: "other",
            status: "in_progress",
          }),
        );
        reply(f, { stopReason: "end_turn" });
        if (text === "early-end-exit") setTimeout(() => process.exit(7), 40);
        if (text === "early-end")
          setTimeout(() => {
            send(
              chunk(
                "agent_thought_chunk",
                "old-turn-thought",
                "reused-message",
              ),
            );
            send(
              update("tool_call_update", {
                toolCallId: "reused-tool",
                status: "completed",
              }),
            );
          }, 40);
        break;
      }
      if (text === "controlled-tool") {
        controlledTool = true;
        send(
          update("tool_call", {
            toolCallId: "controlled-tool",
            title: "long tool",
            kind: "other",
            status: "in_progress",
          }),
        );
        reply(f, { stopReason: "end_turn" });
        break;
      }
      if (text === "late-after-end") {
        send(chunk("agent_message_chunk", "first answer", "reused-message"));
        reply(f, { stopReason: "end_turn" });
        // This old stream must never survive into the next prompt.
        setTimeout(() => {
          send(
            chunk("agent_thought_chunk", "late-old-thought", "reused-message"),
          );
          send(
            update("tool_call_update", {
              toolCallId: "reused-tool",
              status: "in_progress",
            }),
          );
        }, 40);
        break;
      }
      if (text === "reuse-identities") {
        send(chunk("agent_message_chunk", "new answer", "reused-message"));
        send(
          update("tool_call", {
            toolCallId: "reused-tool",
            title: "new tool",
            kind: "other",
            status: "completed",
          }),
        );
        reply(f, { stopReason: "end_turn" });
        break;
      }
      if (
        text === "background-transcript" ||
        text === "background-held" ||
        text === "background-late" ||
        text === "background-daemon" ||
        text === "schedule-held"
      ) {
        const logs = path.join(
          process.env.HOME,
          ".gemini",
          "antigravity-cli",
          "brain",
          "fixture",
          ".system_generated",
          "logs",
        );
        mkdirSync(logs, { recursive: true });
        const file = path.join(logs, "transcript_full.jsonl");
        const toolName = text === "schedule-held" ? "schedule" : "run_command";
        const toolArgs =
          text === "schedule-held"
            ? {
                DurationSeconds: 60,
                Prompt: "Check progress",
                TimerCondition: "any",
              }
            : {
                CommandLine: "sleep 18",
                IsDaemon: text === "background-daemon",
              };
        const taskText =
          "Tool is running as a background task with task id: fixture/task-2" +
          (text === "schedule-held"
            ? "\nTask Description: Timer: 1m, Prompt: Check progress"
            : "");
        const records = [
          {
            type: "USER_INPUT",
            step_index: 0,
            content: "background-transcript",
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 1,
            tool_calls: [
              {
                name: toolName,
                args: toolArgs,
              },
            ],
          },
          {
            type: "GENERIC",
            step_index: 2,
            status: "RUNNING",
            content: taskText,
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 3,
            status: "DONE",
            content: "waiting",
          },
        ];
        if (text !== "background-late")
          writeFileSync(
            file,
            records.map((r) => JSON.stringify(r)).join("\n") + "\n",
          );
        send(
          update("tool_call", {
            toolCallId: "background-call",
            name: toolName,
            kind: "execute",
            status: "in_progress",
            rawInput: toolArgs,
          }),
        );
        send(chunk("agent_message_chunk", "waiting"));
        reply(f, { stopReason: "end_turn" });
        if (text === "background-transcript")
          setTimeout(
            () =>
              appendFileSync(
                file,
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
                    content: "AUTO_WAKE_DONE",
                  },
                ]
                  .map((r) => JSON.stringify(r))
                  .join("\n") + "\n",
              ),
            50,
          );
        break;
      }
      if (text === "background-duplicate-commands") {
        const logs = path.join(
          process.env.HOME,
          ".gemini",
          "antigravity-cli",
          "brain",
          "fixture",
          ".system_generated",
          "logs",
        );
        mkdirSync(logs, { recursive: true });
        const file = path.join(logs, "transcript_full.jsonl");
        const verifyArgs = { CommandLine: "python verify_value.py" };
        const studyArgs = { CommandLine: "python study_layer.py" };
        const schedArgs = {
          DurationSeconds: 60,
          Prompt: "Check progress",
          TimerCondition: "any",
        };
        const records = [
          {
            type: "USER_INPUT",
            step_index: 0,
            content: "background-duplicate-commands",
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 1,
            status: "DONE",
            tool_calls: [{ name: "run_command", args: verifyArgs }],
          },
          {
            type: "GENERIC",
            step_index: 2,
            status: "DONE",
            content: "sync run output",
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 3,
            status: "DONE",
            tool_calls: [{ name: "run_command", args: verifyArgs }],
          },
          {
            type: "GENERIC",
            step_index: 4,
            status: "RUNNING",
            content:
              "Tool is running as a background task with task id: fixture/task-4\nTask Description: python verify_value.py",
          },
          {
            type: "SYSTEM_MESSAGE",
            step_index: 5,
            status: "DONE",
            content:
              'Task id "fixture/task-4" finished with result:\nCommand exited with code 0.\nrun 1 output',
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 6,
            status: "DONE",
            tool_calls: [{ name: "run_command", args: verifyArgs }],
          },
          {
            type: "GENERIC",
            step_index: 7,
            status: "RUNNING",
            content:
              "Tool is running as a background task with task id: fixture/task-7\nTask Description: python verify_value.py",
          },
          {
            type: "SYSTEM_MESSAGE",
            step_index: 8,
            status: "DONE",
            content:
              'Task id "fixture/task-7" finished with result:\nCommand exited with code 1.\nrun 2 failed',
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 9,
            status: "DONE",
            tool_calls: [{ name: "run_command", args: studyArgs }],
          },
          {
            type: "GENERIC",
            step_index: 10,
            status: "RUNNING",
            content:
              "Tool is running as a background task with task id: fixture/task-10\nTask Description: python study_layer.py",
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 11,
            status: "DONE",
            tool_calls: [
              {
                name: "manage_task",
                args: { Action: "kill", TaskId: "fixture/task-10" },
              },
            ],
          },
          {
            type: "GENERIC",
            step_index: 12,
            status: "DONE",
            content: "Killed task fixture/task-10",
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 13,
            status: "DONE",
            tool_calls: [{ name: "schedule", args: schedArgs }],
          },
          {
            type: "GENERIC",
            step_index: 14,
            status: "RUNNING",
            content:
              "Tool is running as a background task with task id: fixture/task-14\nTask Description: Timer: 1m, Prompt: Check progress",
          },
          {
            type: "SYSTEM_MESSAGE",
            step_index: 15,
            status: "DONE",
            content:
              "[Message] timestamp=2026-11-14T10:00:00Z sender=fixture/task-14 priority=MESSAGE_PRIORITY_HIGH content=Check progress (1)",
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 16,
            status: "DONE",
            tool_calls: [
              { name: "run_command", args: studyArgs },
              { name: "schedule", args: schedArgs },
            ],
          },
          {
            type: "GENERIC",
            step_index: 17,
            status: "RUNNING",
            content:
              "Tool is running as a background task with task id: fixture/task-17\nTask Description: python study_layer.py",
          },
          {
            type: "GENERIC",
            step_index: 18,
            status: "RUNNING",
            content:
              "Tool is running as a background task with task id: fixture/task-18\nTask Description: Timer: 1m, Prompt: Check progress",
          },
          {
            type: "PLANNER_RESPONSE",
            step_index: 19,
            status: "DONE",
            content: "waiting on study 2",
          },
        ];
        writeFileSync(
          file,
          records.map((r) => JSON.stringify(r)).join("\n") + "\n",
        );
        send(
          update("tool_call", {
            toolCallId: "call-sync",
            name: "run_command",
            kind: "execute",
            status: "completed",
            rawInput: verifyArgs,
            rawOutput: "sync run output",
          }),
        );
        send(
          update("tool_call", {
            toolCallId: "call-bg-1",
            name: "run_command",
            kind: "execute",
            status: "in_progress",
            rawInput: verifyArgs,
          }),
        );
        send(
          update("tool_call", {
            toolCallId: "call-bg-2",
            name: "run_command",
            kind: "execute",
            status: "in_progress",
            rawInput: verifyArgs,
          }),
        );
        send(
          update("tool_call", {
            toolCallId: "call-study-1",
            name: "run_command",
            kind: "execute",
            status: "in_progress",
            rawInput: studyArgs,
          }),
        );
        send(
          update("tool_call", {
            toolCallId: "call-sched-1",
            name: "schedule",
            kind: "other",
            status: "in_progress",
            rawInput: schedArgs,
          }),
        );
        send(
          update("tool_call", {
            toolCallId: "call-study-2",
            name: "run_command",
            kind: "execute",
            status: "in_progress",
            rawInput: studyArgs,
          }),
        );
        send(
          update("tool_call", {
            toolCallId: "call-sched-2",
            name: "schedule",
            kind: "other",
            status: "in_progress",
            rawInput: schedArgs,
          }),
        );
        send(chunk("agent_message_chunk", "waiting on study 2"));
        reply(f, { stopReason: "end_turn" });
        break;
      }
      if (text === "plan-proposal" || text === "ordinary-artifact") {
        const file = path.join(
          process.env.HOME,
          ".gemini",
          "antigravity-cli",
          "brain",
          "fixture",
          "implementation_plan.md",
        );
        const input = {
          Path: file,
          Content: "# Implementation plan\nCreate output.txt and verify it.",
          ArtifactMetadata: {
            RequestFeedback: text === "plan-proposal",
            UserFacing: true,
            Summary: "Tiny implementation",
          },
        };
        send(
          update("tool_call", {
            toolCallId: "plan-file",
            name: "write_file",
            kind: "edit",
            status: "in_progress",
            rawInput: input,
          }),
        );
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, input.Content);
        const logs = path.join(path.dirname(file), ".system_generated", "logs");
        mkdirSync(logs, { recursive: true });
        writeFileSync(
          path.join(logs, "transcript_full.jsonl"),
          [
            { type: "USER_INPUT", step_index: 0, content: text },
            {
              type: "PLANNER_RESPONSE",
              step_index: 1,
              status: "DONE",
              tool_calls: [{ name: "write_file", args: input }],
            },
            {
              type: "CODE_ACTION",
              step_index: 2,
              status: "DONE",
              content: "written",
            },
            {
              type: "PLANNER_RESPONSE",
              step_index: 3,
              status: "DONE",
              content: "Please review the plan.",
            },
          ]
            .map((r) => JSON.stringify(r))
            .join("\n") + "\n",
        );
        send(
          update("tool_call_update", {
            toolCallId: "plan-file",
            status: "completed",
          }),
        );
        send(chunk("agent_message_chunk", "Please review the plan."));
        reply(f, { stopReason: "end_turn" });
        break;
      }
      if (text === "subagent-task") {
        const root = path.join(
          process.env.HOME,
          ".gemini",
          "antigravity-cli",
          "brain",
        );
        const child = "12345678-1234-4123-8123-123456789abc";
        const parentFile = path.join(
          root,
          "fixture",
          ".system_generated",
          "logs",
          "transcript_full.jsonl",
        );
        const childFile = path.join(
          root,
          child,
          ".system_generated",
          "logs",
          "transcript_full.jsonl",
        );
        const args = {
          Prompt: "Read input.txt",
          Role: "File reader",
          TypeName: "research",
          Model: "flash_lite",
        };
        const output =
          "Created the following subagent:\n" +
          JSON.stringify(
            { conversationId: child, workspaceUris: ["file:///tmp"] },
            null,
            2,
          ) +
          "\nThe subagent will send you a message when it has completed.";
        mkdirSync(path.dirname(parentFile), { recursive: true });
        mkdirSync(path.dirname(childFile), { recursive: true });
        writeFileSync(
          parentFile,
          [
            { type: "USER_INPUT", step_index: 0, content: "delegate" },
            {
              type: "PLANNER_RESPONSE",
              step_index: 1,
              status: "DONE",
              tool_calls: [{ name: "invoke_subagent", args }],
            },
            { type: "GENERIC", step_index: 2, status: "DONE", content: output },
            {
              type: "PLANNER_RESPONSE",
              step_index: 3,
              status: "DONE",
              content: "waiting for subagent",
            },
          ]
            .map((r) => JSON.stringify(r))
            .join("\n") + "\n",
        );
        writeFileSync(
          childFile,
          [
            {
              type: "SYSTEM_MESSAGE",
              step_index: 0,
              status: "DONE",
              content: "child input",
            },
            {
              type: "PLANNER_RESPONSE",
              step_index: 1,
              status: "DONE",
              thinking: "reading",
              tool_calls: [
                { name: "read_file", args: { Path: "/tmp/input.txt" } },
              ],
            },
          ]
            .map((r) => JSON.stringify(r))
            .join("\n") + "\n",
        );
        send(
          update("tool_call", {
            toolCallId: "spawn-child",
            name: "invoke_subagent",
            status: "in_progress",
            rawInput: args,
          }),
        );
        send(
          update("tool_call_update", {
            toolCallId: "spawn-child",
            status: "completed",
            rawOutput: output,
          }),
        );
        send(chunk("agent_message_chunk", "waiting for subagent"));
        reply(f, { stopReason: "end_turn" });
        setTimeout(() => {
          appendFileSync(
            childFile,
            [
              {
                type: "GENERIC",
                step_index: 2,
                status: "DONE",
                content: "alpha beta",
              },
              {
                type: "PLANNER_RESPONSE",
                step_index: 3,
                status: "DONE",
                content: "CHILD_DONE",
              },
            ]
              .map((r) => JSON.stringify(r))
              .join("\n") + "\n",
          );
          appendFileSync(
            parentFile,
            JSON.stringify({
              type: "SYSTEM_MESSAGE",
              step_index: 4,
              status: "DONE",
              content:
                "<SYSTEM_MESSAGE> sender=" +
                child +
                "\nCHILD_DONE</SYSTEM_MESSAGE>",
            }) + "\n",
          );
          setTimeout(
            () =>
              appendFileSync(
                parentFile,
                JSON.stringify({
                  type: "PLANNER_RESPONSE",
                  step_index: 5,
                  status: "DONE",
                  content: "PARENT_DONE",
                }) + "\n",
              ),
            80,
          );
        }, 80);
        break;
      }
      if (text === "继续") {
        const db = openFixtureDb();
        const existingStepCount = Number(
          db.prepare("SELECT COUNT(*) AS count FROM steps").get().count ?? 0,
        );
        insertDbStep(db, 15, 3);
        db.close();
        const editedPath = path.join(process.cwd(), "edited.txt");
        const editedCheck = existsSync(editedPath)
          ? ":" + readFileSync(editedPath, "utf8")
          : "";
        send(
          chunk(
            "agent_message_chunk",
            `RECOVERED_AFTER_CONTINUE(stepsBefore=${existingStepCount}${editedCheck})`,
          ),
        );
        reply(f, { stopReason: "end_turn" });
        break;
      }
      if (
        text === "transient-silent-error" ||
        text === "nonretryable-silent-error" ||
        text === "shell-then-silent-error" ||
        text === "edit-then-silent-error"
      ) {
        const counterFile = path.join(process.env.HOME, "retry-attempts.txt");
        const previousAttempts = existsSync(counterFile)
          ? readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean)
              .length
          : 0;
        appendFileSync(counterFile, `${process.pid}:${previousAttempts + 1}\n`);
        const db = openFixtureDb();
        const existingStepCount = Number(
          db.prepare("SELECT COUNT(*) AS count FROM steps").get().count ?? 0,
        );
        insertDbStep(db, 14, 3);
        if (text === "shell-then-silent-error") {
          send(
            update("tool_call", {
              toolCallId: "shell-1",
              name: "run_command",
              kind: "execute",
              status: "in_progress",
              rawInput: { CommandLine: "echo side-effect" },
            }),
          );
          send(
            update("tool_call_update", {
              toolCallId: "shell-1",
              status: "completed",
              rawOutput: "side-effect",
            }),
          );
        }
        if (text === "edit-then-silent-error" && previousAttempts === 0) {
          const targetFile = path.join(process.cwd(), "edited.txt");
          send(
            update("tool_call", {
              toolCallId: "edit-1",
              name: "write_file",
              kind: "edit",
              status: "in_progress",
              rawInput: { Path: targetFile, Content: "corrupted-partial-edit" },
            }),
          );
          writeFileSync(targetFile, "corrupted-partial-edit");
          send(
            update("tool_call_update", {
              toolCallId: "edit-1",
              status: "completed",
            }),
          );
        }
        if (previousAttempts === 0 || text === "nonretryable-silent-error") {
          const shortError =
            text === "nonretryable-silent-error"
              ? "Your AI credits balance is too low to continue."
              : "FAILED_PRECONDITION (code 400): User location is not supported for the API use.";
          insertDbStep(
            db,
            17,
            3,
            Buffer.alloc(0),
            buildErrorStepPayload(shortError),
          );
          db.close();
          send(
            chunk(
              "agent_message_chunk",
              "Agent execution terminated due to error.",
            ),
          );
          reply(f, { stopReason: "end_turn" });
          break;
        }
        insertDbStep(db, 15, 3);
        db.close();
        const editedCheck =
          text === "edit-then-silent-error"
            ? ":" + readFileSync(path.join(process.cwd(), "edited.txt"), "utf8")
            : "";
        send(
          chunk(
            "agent_message_chunk",
            `RECOVERED_AFTER_CONTINUE(stepsBefore=${existingStepCount}${editedCheck})`,
          ),
        );
        reply(f, { stopReason: "end_turn" });
        break;
      }
      if (text === "/compact" || text === "auto-compact-turn") {
        const db = openFixtureDb();
        insertDbStep(db, 14, 3);
        const preTokens = text === "/compact" ? 120_000 : 245_000;
        const compactStepIdx = insertDbStep(db, 23, 2);
        db.close();
        setTimeout(() => {
          const dbDone = openFixtureDb();
          dbDone
            .prepare("UPDATE steps SET status = 3, metadata = ? WHERE idx = ?")
            .run(buildCompactionMetadata(preTokens), compactStepIdx);
          insertDbStep(dbDone, 15, 3);
          dbDone.close();
          send(
            chunk(
              "agent_message_chunk",
              text === "/compact"
                ? "Manual compact complete."
                : "Auto compact turn complete.",
            ),
          );
          reply(f, { stopReason: "end_turn" });
        }, 320);
        break;
      }
      if (text === "hold") {
        activePrompt = f;
        break;
      }
      if (text === "upstream-error") {
        error(f, "Agent execution terminated due to error.", -32603, {
          detail: "service temporarily unavailable",
          reason: "upstream",
          token: "private-token",
          request: { prompt: "do not log task" },
        });
        break;
      }
      if (text === "inband-error-once") {
        const flag = path.join(process.env.HOME, "inband-error-once.flag");
        if (!existsSync(flag)) {
          writeFileSync(flag, "1");
          send(
            chunk(
              "agent_message_chunk",
              "\n⚠ Agent execution terminated due to error.\n",
            ),
          );
          reply(f, { stopReason: "end_turn" });
          break;
        }
        send(chunk("agent_message_chunk", "RECOVERED_OK"));
        reply(f, { stopReason: "end_turn" });
        break;
      }
      if (text === "inband-error-always") {
        send(
          chunk(
            "agent_message_chunk",
            "\n⚠ Agent execution terminated due to error.\n",
          ),
        );
        reply(f, { stopReason: "end_turn" });
        break;
      }
      if (text === "inband-error-literal-reply") {
        const dir = path.join(
          process.env.HOME,
          ".gemini",
          "antigravity-cli",
          "brain",
          sessionId,
          ".system_generated",
          "logs",
        );
        mkdirSync(dir, { recursive: true });
        appendFileSync(
          path.join(dir, "transcript.jsonl"),
          [
            {
              type: "USER_INPUT",
              step_index: 0,
              status: "DONE",
              content: text,
            },
            {
              type: "PLANNER_RESPONSE",
              step_index: 1,
              status: "DONE",
              content: "⚠ Agent execution terminated due to error.",
            },
          ]
            .map((r) => JSON.stringify(r))
            .join("\n") + "\n",
        );
        send(
          chunk(
            "agent_message_chunk",
            "⚠ Agent execution terminated due to error.",
          ),
        );
        reply(f, { stopReason: "end_turn" });
        break;
      }
      if (text === "fail-process") {
        process.exit(7);
        break;
      }
      if (text === "permission" || text === "chooser") {
        permissionPrompt = f;
        const options = [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ];
        if (text === "chooser")
          options.push({
            optionId: "other",
            name: "Other",
            kind: "allow_once",
          });
        send({
          id: 100,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: {
              toolCallId: "tool",
              kind: "execute",
              title: "Permission",
            },
            options,
          },
        });
        break;
      }
      if (text === "echo-after-config") {
        send(
          update("config_option_update", {
            configOptions: options(),
          }),
        );
        send(chunk("user_message_chunk", text));
        send(chunk("agent_message_chunk", "ECHO_OK"));
        reply(f, { stopReason: "end_turn" });
        break;
      }
      if (text === "ask-color") {
        send(chunk("user_message_chunk", text));
        send(
          update("tool_call", {
            toolCallId: "ask-1",
            name: "ask_question",
            kind: "other",
            title: "Run ask_question",
            status: "pending",
            rawInput: {
              questions: [
                {
                  question: "Pick a color",
                  options: ["Red", "Blue"],
                  is_multi_select: false,
                },
              ],
            },
          }),
        );
        send(
          chunk(
            "agent_message_chunk",
            "\nPick a color\n- [1] Red\n- [2] Blue\n",
          ),
        );
        send(
          update("tool_call_update", {
            toolCallId: "ask-1",
            status: "completed",
          }),
        );
        reply(f, { stopReason: "end_turn" });
        break;
      }
      send(chunk("agent_message_chunk", JSON.stringify(f.params.prompt)));
      reply(f, {
        stopReason: text === "max_tokens" ? "max_tokens" : "end_turn",
      });
      break;
    }
    case "session/cancel":
      if (activePrompt) {
        reply(activePrompt, { stopReason: "cancelled" });
        activePrompt = undefined;
      }
      if (permissionPrompt) {
        reply(permissionPrompt, { stopReason: "cancelled" });
        permissionPrompt = undefined;
      }
      break;
    case "session/close":
      reply(f);
      break;
    case "session/list":
      if (process.env.FIXTURE_FAIL_LIST === "1") {
        error(f, "list failed");
        break;
      }
      if (!f.params.cursor)
        reply(f, {
          sessions: [{ sessionId: "unrelated", cwd: "/tmp" }],
          nextCursor: "second",
        });
      else
        reply(f, {
          sessions: [
            { sessionId: "matching", cwd: "/tmp", title: "matching title" },
          ],
          nextCursor: null,
        });
      break;
    default:
      error(f, "unknown method", -32601);
  }
});
