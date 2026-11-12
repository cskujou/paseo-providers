import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
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
