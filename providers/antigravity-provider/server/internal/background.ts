import { createHash } from "node:crypto";
import { readConversationRecords } from "./transcript-history.js";

export interface BackgroundTask {
  id: string;
  command: string;
  daemon: boolean;
  output: string;
  completed: boolean;
  exitCode?: number;
}
export interface BackgroundFailure {
  message: string;
  details?: unknown;
}
export interface BackgroundTurn {
  tasks: BackgroundTask[];
  continuationStep?: number;
  continuationStarted: boolean;
  continuationRevision?: string;
  lastStep?: number;
  userStep?: number;
  failure?: BackgroundFailure;
  settled: boolean;
}

// AGY 1.5.6 persists autonomous turns but can stop forwarding their ACP updates.
// Background completion and planner progress are distinct observations.
export async function readBackgroundTurn(
  conversationId: string,
  env: Record<string, string>,
): Promise<BackgroundTurn | null> {
  let tasks = new Map<string, BackgroundTask>();
  let command = "";
  let daemon = false;
  let continuationStep: number | undefined;
  let continuationStarted = false;
  let lastStep: number | undefined;
  let userStep: number | undefined;
  let failure: BackgroundFailure | undefined;
  let final = false;
  let revision = createHash("sha256");
  for await (const record of readConversationRecords(conversationId, env)) {
    if (record.type === "USER_INPUT") {
      userStep = record.step_index;
      tasks = new Map();
      revision = createHash("sha256");
      command = "";
      daemon = false;
      continuationStep = undefined;
      continuationStarted = false;
      failure = undefined;
      final = false;
    }
    lastStep = record.step_index ?? lastStep;
    if (record.type === "PLANNER_RESPONSE") {
      if (continuationStep !== undefined) continuationStarted = true;
      final =
        record.status === "DONE" &&
        (!record.tool_calls || record.tool_calls.length === 0);
      for (const call of record.tool_calls ?? []) {
        if (
          call.name === "run_command" &&
          typeof call.args?.CommandLine === "string"
        ) {
          command = call.args.CommandLine;
          daemon = call.args.IsDaemon === true;
        }
      }
    } else if (
      record.type !== "CHECKPOINT" &&
      record.type !== "CONVERSATION_HISTORY"
    )
      final = false;
    const text = record.content ?? "";
    if (record.type === "GENERIC" && record.status === "RUNNING") {
      const match =
        /Tool is running as a background task with task id:\s*([\w-]+\/task-\d+)/.exec(
          text,
        );
      if (match && match[1]!.startsWith(conversationId + "/"))
        tasks.set(match[1]!, {
          id: match[1]!,
          command: /Task Description:\s*([^\n]+)/.exec(text)?.[1] ?? command,
          daemon,
          output: text,
          completed: false,
        });
    }
    if (record.type === "SYSTEM_MESSAGE") {
      const match = /Task id "([\w-]+\/task-\d+)" finished with result:/.exec(
        text,
      );
      const task = match ? tasks.get(match[1]!) : undefined;
      if (task) {
        task.completed = true;
        task.output = text;
        const exit = /Command exited with code (-?\d+)/.exec(text);
        if (exit) task.exitCode = Number(exit[1]);
        continuationStep ??= record.step_index;
      }
    }
    if (continuationStep !== undefined) revision.update(JSON.stringify(record));
    const executionRecord = [
      "PLANNER_RESPONSE",
      "SYSTEM_MESSAGE",
      "EXECUTION_ERROR",
      "ERROR",
    ].includes(record.type ?? "");
    if (
      executionRecord &&
      (record.status === "ERROR" ||
        record.status === "FAILED" ||
        record.type === "EXECUTION_ERROR")
    ) {
      failure = {
        message: text.trim() || "Antigravity automatic continuation failed",
        details: record.error_details,
      };
    }
  }
  if (!tasks.size) return null;
  return {
    tasks: [...tasks.values()],
    continuationStep,
    continuationStarted,
    continuationRevision:
      continuationStep === undefined ? undefined : revision.digest("hex"),
    lastStep,
    userStep,
    failure,
    settled:
      !failure &&
      final &&
      [...tasks.values()].every((task) => task.daemon || task.completed) &&
      (continuationStarted || [...tasks.values()].every((task) => task.daemon)),
  };
}
