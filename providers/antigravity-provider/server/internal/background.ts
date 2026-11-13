import { createHash } from "node:crypto";
import {
  readConversationRecords,
  readConversationRecordsFromOffset,
  parseSubagentResult,
  matchesToolResult,
  type TranscriptOffset,
  type TranscriptRecord,
} from "./transcript-history.js";

export interface BackgroundTask {
  id: string;
  toolName?: string;
  command: string;
  prompt?: string;
  daemon: boolean;
  timerCondition?: string;
  remainingRuns?: number;
  output: string;
  completed: boolean;
  kind?: "command" | "subagent";
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
  const calls: NonNullable<TranscriptRecord["tool_calls"]> = [];
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
      calls.length = 0;
      revision = createHash("sha256");
      continuationStep = undefined;
      continuationStarted = false;
      failure = undefined;
      final = false;
    }
    lastStep = record.step_index ?? lastStep;
    if (record.type === "PLANNER_RESPONSE") {
      calls.length = 0;
      calls.push(...(record.tool_calls ?? []));
      if (continuationStep !== undefined) continuationStarted = true;
      final = record.status === "DONE" && !record.tool_calls?.length;
    } else if (
      record.type !== "CHECKPOINT" &&
      record.type !== "CONVERSATION_HISTORY"
    )
      final = false;

    const text = record.content ?? "";
    const backgroundMatch =
      record.type === "GENERIC" && record.status === "RUNNING"
        ? /Tool is running as a background task with task id:\s*([\w-]+\/task-\d+)/.exec(
            text,
          )
        : null;
    const description = backgroundMatch
      ? /Task Description:\s*([^\n]+)/.exec(text)?.[1]
      : undefined;
    const resultIndex =
      backgroundMatch && description
        ? calls.findIndex(
            (call) =>
              call.name ===
              (/^(Timer|Cron):/.test(description.trim())
                ? "schedule"
                : "run_command"),
          )
        : calls.findIndex((call) =>
            matchesToolResult(call.name ?? "", record.type ?? ""),
          );
    const call = resultIndex < 0 ? undefined : calls.splice(resultIndex, 1)[0];
    if (
      backgroundMatch &&
      backgroundMatch[1]!.startsWith(conversationId + "/")
    ) {
      const args = call?.args;
      const toolName =
        call?.name ??
        (/^(Timer|Cron):/.test(description?.trim() ?? "")
          ? "schedule"
          : "run_command");
      const prompt = typeof args?.Prompt === "string" ? args.Prompt : undefined;
      const command =
        typeof args?.CommandLine === "string"
          ? args.CommandLine
          : (prompt ?? description ?? "");
      const isCron =
        toolName === "schedule" &&
        typeof args?.CronExpression === "string" &&
        args.CronExpression.length > 0;
      const maxIterations =
        typeof args?.MaxIterations === "number"
          ? args.MaxIterations
          : typeof args?.MaxIterations === "string"
            ? Number(args.MaxIterations)
            : undefined;
      tasks.set(backgroundMatch[1]!, {
        id: backgroundMatch[1]!,
        toolName,
        command,
        prompt,
        daemon: args?.IsDaemon === true || args?.IsDaemon === "true",
        timerCondition:
          typeof args?.TimerCondition === "string"
            ? args.TimerCondition
            : undefined,
        remainingRuns: isCron
          ? Number.isFinite(maxIterations) && maxIterations! > 0
            ? maxIterations
            : Number.POSITIVE_INFINITY
          : 1,
        output: text,
        completed: false,
        kind: "command",
      });
    }
    if (
      record.type === "GENERIC" &&
      record.status === "DONE" &&
      call?.name === "invoke_subagent"
    ) {
      const child = parseSubagentResult(text);
      if (child)
        tasks.set(child.conversationId, {
          id: child.conversationId,
          command: "",
          daemon: false,
          output: text,
          completed: false,
          kind: "subagent",
        });
    }
    if (
      record.status === "DONE" &&
      call?.name === "manage_task" &&
      call.args?.Action === "kill" &&
      typeof call.args.TaskId === "string"
    ) {
      const task = tasks.get(call.args.TaskId);
      if (task) {
        task.completed = true;
        continuationStep ??= record.step_index;
        continuationStarted = false;
      }
    }
    if (record.type === "SYSTEM_MESSAGE") {
      const finishMatch =
        /Task id "([\w-]+\/task-\d+)" finished with result:/.exec(text);
      const messageMatch =
        /\[Message\]\s+timestamp=\S+\s+sender=([\w/-]+)\b/.exec(text);
      const childSender = /sender=([\w-]+)\s/.exec(text);
      const senderId =
        finishMatch?.[1] ?? messageMatch?.[1] ?? childSender?.[1];
      const task = senderId ? tasks.get(senderId) : undefined;
      if (task) {
        if (finishMatch || task.kind === "subagent") task.completed = true;
        else {
          task.remainingRuns = (task.remainingRuns ?? 1) - 1;
          if (task.remainingRuns <= 0) task.completed = true;
        }
        task.output = text;
        const exit = /Command exited with code (-?\d+)/.exec(text);
        if (exit) task.exitCode = Number(exit[1]);
        continuationStep ??= record.step_index;
        continuationStarted = false;
      }
      if (senderId && senderId !== "system") {
        for (const other of tasks.values()) {
          if (
            other.id !== senderId &&
            !other.completed &&
            (other.timerCondition === "any" ||
              other.timerCondition === senderId)
          ) {
            other.completed = true;
            continuationStep ??= record.step_index;
            continuationStarted = false;
          }
        }
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

export interface TurnExecutionInspection {
  failed: boolean;
  message?: string;
  details?: unknown;
}

export async function inspectTurnExecutionFailure(
  conversationId: string,
  env: Record<string, string>,
  before: TranscriptOffset | null,
  sawInbandError: boolean,
): Promise<TurnExecutionInspection> {
  const { hasTranscript, records } = await readConversationRecordsFromOffset(
    conversationId,
    env,
    before,
  );
  if (!hasTranscript) {
    return sawInbandError
      ? { failed: true, message: "Agent execution terminated due to error." }
      : { failed: false };
  }
  let hasBackgroundTasks = false;
  let plannerDone = false;
  let failure: BackgroundFailure | undefined;
  for (const record of records) {
    if (record.type === "USER_INPUT") {
      plannerDone = false;
      failure = undefined;
      hasBackgroundTasks = false;
    }
    if (record.type === "PLANNER_RESPONSE") {
      plannerDone = record.status === "DONE" && !record.tool_calls?.length;
    } else if (
      record.type !== "CHECKPOINT" &&
      record.type !== "CONVERSATION_HISTORY"
    ) {
      plannerDone = false;
    }
    const text = record.content ?? "";
    if (
      record.type === "GENERIC" &&
      record.status === "RUNNING" &&
      /Tool is running as a background task with task id:\s*([\w-]+\/task-\d+)/.test(
        text,
      )
    ) {
      hasBackgroundTasks = true;
    }
    if (
      record.type === "GENERIC" &&
      record.status === "DONE" &&
      parseSubagentResult(text)
    ) {
      hasBackgroundTasks = true;
    }
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
        message: text.trim() || "Agent execution terminated due to error.",
        details: record.error_details,
      };
    }
  }
  if (hasBackgroundTasks && !sawInbandError) {
    return { failed: false };
  }
  if (failure) {
    return {
      failed: true,
      message: failure.message,
      details: failure.details,
    };
  }
  if (sawInbandError && !plannerDone) {
    return {
      failed: true,
      message: "Agent execution terminated due to error.",
    };
  }
  return { failed: false };
}
