import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { resolveTranscriptDir } from "./rewind.js";

export interface BackgroundTask {
  id: string;
  command: string;
  output: string;
  completed: boolean;
  exitCode?: number;
}
export interface BackgroundTurn {
  tasks: BackgroundTask[];
  continuationStep?: number;
  settled: boolean;
}

// AGY 1.5.6 persists autonomous turns but stops forwarding ACP updates after the
// foreground prompt response. Read only the latest user's task notifications.
export async function readBackgroundTurn(
  conversationId: string,
  env: Record<string, string>,
): Promise<BackgroundTurn | null> {
  const directory = resolveTranscriptDir(conversationId, env);
  let file: string | undefined;
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const candidate = path.join(directory, name);
    try {
      if ((await stat(candidate)).size > 0) {
        file = candidate;
        break;
      }
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }
  if (!file) return null;
  let tasks = new Map<string, BackgroundTask>();
  let command = "";
  let continuationStep: number | undefined;
  let final = false;
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (record.type === "USER_INPUT") {
        tasks = new Map();
        continuationStep = undefined;
        final = false;
      }
      if (record.type === "PLANNER_RESPONSE") {
        final =
          record.status === "DONE" &&
          typeof record.content === "string" &&
          record.content.trim().length > 0 &&
          (!Array.isArray(record.tool_calls) || record.tool_calls.length === 0);
        if (Array.isArray(record.tool_calls))
          for (const call of record.tool_calls) {
            if (
              call?.name === "run_command" &&
              typeof call.args?.CommandLine === "string"
            )
              command = call.args.CommandLine;
          }
      } else if (
        record.type !== "CHECKPOINT" &&
        record.type !== "CONVERSATION_HISTORY"
      )
        final = false;
      const text = typeof record.content === "string" ? record.content : "";
      if (record.type === "GENERIC" && record.status === "RUNNING") {
        const match =
          /Tool is running as a background task with task id:\s*([\w-]+\/task-\d+)/.exec(
            text,
          );
        if (match && match[1]!.startsWith(conversationId + "/"))
          tasks.set(match[1]!, {
            id: match[1]!,
            command: /Task Description:\s*([^\n]+)/.exec(text)?.[1] ?? command,
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
          if (typeof record.step_index === "number")
            continuationStep ??= record.step_index;
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!tasks.size) return null;
  return {
    tasks: [...tasks.values()],
    continuationStep,
    settled:
      continuationStep !== undefined &&
      final &&
      [...tasks.values()].every((task) => task.completed),
  };
}
