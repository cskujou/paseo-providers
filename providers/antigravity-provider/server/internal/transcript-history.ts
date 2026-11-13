import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import {
  readCompactionSteps,
  resolveTranscriptDir,
  type CompactionStepInfo,
} from "./rewind.js";
import { acpToolToTimelineItem, type AcpToolCallState } from "./timeline.js";

const childSchema = z.object({
  conversationId: z.string().uuid(),
  workspaceUris: z.array(z.string()).optional(),
});
export function parseSubagentResult(
  text: string,
): z.infer<typeof childSchema> | null {
  const marker = text.indexOf("Created the following subagent:");
  if (marker < 0) return null;
  const body = text.slice(marker);
  const start = body.indexOf("{");
  const end = body.indexOf("\n}", start);
  if (start < 0 || end < 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(body.slice(start, end + 2));
  } catch {
    return null;
  }
  const parsed = childSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const MAX_TEXT_UNITS = 64 * 1024;
const transcriptRecordSchema = z.object({
  step_index: z.number().int().nonnegative().optional(),
  created_at: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  content: z.string().optional(),
  thinking: z.string().optional(),
  exit_code: z.number().int().optional(),
  error_details: z.json().optional(),
  tool_calls: z
    .array(
      z.object({
        name: z.string().optional(),
        args: z.record(z.string(), z.json()).optional(),
      }),
    )
    .optional(),
});
export type TranscriptRecord = z.infer<typeof transcriptRecordSchema>;

export type TranscriptTimelineItem = ProviderTimelineItem & {
  timestamp?: string;
};

interface PendingTool {
  state: AcpToolCallState;
  index: number;
}
export interface TranscriptSummary {
  firstPromptPreview?: string;
  lastPromptPreview?: string;
  updatedAt?: string;
}

// Listing metadata must not allocate an entire timeline or run session/load per row.
export async function readTranscriptSummary(
  conversationId: string,
  env: Record<string, string | undefined>,
): Promise<TranscriptSummary> {
  const file = await resolveTranscriptFile(conversationId, env);
  if (!file) return {};
  const summary: TranscriptSummary = { updatedAt: file.updatedAt };
  for await (const record of readTranscriptRecords(file.path)) {
    if (record.type !== "USER_INPUT" || !record.content) continue;
    const text = displayUserText(record.content)
      .replace(/\s+/g, " ")
      .slice(0, 160);
    if (!text) continue;
    summary.firstPromptPreview ??= text;
    summary.lastPromptPreview = text;
  }
  return summary;
}

export interface TranscriptCompactionStep extends CompactionStepInfo {
  trigger: "auto" | "manual";
}

export async function readTranscriptCompactionSteps(
  conversationId: string,
  env: Record<string, string | undefined> = process.env,
  minStepIndex = 0,
): Promise<TranscriptCompactionStep[]> {
  const dbSteps = readCompactionSteps(conversationId, env, minStepIndex);
  const byStep = new Map<number, TranscriptCompactionStep>(
    dbSteps.map((step) => [step.stepIndex, { ...step, trigger: "auto" }]),
  );
  const file = await resolveTranscriptFile(conversationId, env);
  if (file) {
    let lastUserWasCompact = false;
    let syntheticIndex = 0;
    for await (const record of readTranscriptRecords(file.path)) {
      const stepIndex = record.step_index ?? syntheticIndex++;
      const type = record.type ?? "";
      if (type === "USER_INPUT") {
        const text = displayUserText(record.content ?? "");
        lastUserWasCompact = /^\/compact(?:\s|$)/i.test(text.trim());
        continue;
      }
      if (type !== "CHECKPOINT" || stepIndex < minStepIndex) continue;
      if (
        record.status === "ERROR" ||
        record.status === "FAILED" ||
        record.status === "CANCELED"
      )
        continue;
      const timestamp =
        record.created_at && Number.isFinite(Date.parse(record.created_at))
          ? new Date(record.created_at).toISOString()
          : undefined;
      const existing = byStep.get(stepIndex);
      const running =
        record.status === "RUNNING" || record.status === "PENDING";
      byStep.set(stepIndex, {
        stepIndex,
        status:
          existing?.status === "completed"
            ? "completed"
            : running
              ? "loading"
              : (existing?.status ?? "completed"),
        trigger: lastUserWasCompact ? "manual" : (existing?.trigger ?? "auto"),
        ...(existing?.preTokens !== undefined
          ? { preTokens: existing.preTokens }
          : {}),
        ...(timestamp || existing?.timestamp
          ? { timestamp: timestamp ?? existing?.timestamp }
          : {}),
      });
    }
  }
  return [...byStep.values()].sort(
    (left, right) => left.stepIndex - right.stepIndex,
  );
}

export async function readTranscriptTimeline(
  conversationId: string,
  env: Record<string, string | undefined> = process.env,
  live = false,
): Promise<TranscriptTimelineItem[]> {
  const file = await resolveTranscriptFile(conversationId, env);
  if (!file) return [];
  const compactionByStep = new Map(
    readCompactionSteps(conversationId, env).map((step) => [
      step.stepIndex,
      step,
    ]),
  );
  const items: TranscriptTimelineItem[] = [];
  const pending: PendingTool[] = [];
  const backgroundTools = new Map<string, PendingTool>();
  let lastUserWasCompact = false;
  for await (const record of readTranscriptRecords(file.path)) {
    const stepIndex = record.step_index ?? items.length;
    const timestamp =
      record.created_at && Number.isFinite(Date.parse(record.created_at))
        ? new Date(record.created_at).toISOString()
        : undefined;
    const type = record.type ?? "";
    if (type === "USER_INPUT" || type === "PLANNER_RESPONSE")
      flushPending(items, pending);
    if (type === "USER_INPUT") {
      backgroundTools.clear();
      const text = displayUserText(record.content ?? "");
      lastUserWasCompact = /^\/compact(?:\s|$)/i.test(text.trim());
      if (!text) continue;
      const id = "history:" + stepIndex + ":user";
      items.push({
        type: "user_message",
        id,
        messageId: id,
        text: boundText(text),
        timestamp,
      });
      continue;
    }
    if (type === "CHECKPOINT") {
      if (
        record.status === "ERROR" ||
        record.status === "FAILED" ||
        record.status === "CANCELED"
      )
        continue;
      const running =
        record.status === "RUNNING" || record.status === "PENDING";
      const dbStep = compactionByStep.get(stepIndex);
      items.push({
        type: "compaction",
        id: "history:" + stepIndex + ":compaction",
        status: live && running ? "loading" : "completed",
        trigger: lastUserWasCompact ? "manual" : "auto",
        ...(dbStep?.preTokens !== undefined
          ? { preTokens: dbStep.preTokens }
          : {}),
        timestamp: timestamp ?? dbStep?.timestamp,
      });
      continue;
    }
    if (type === "PLANNER_RESPONSE") {
      if (record.status === "ERROR" || record.status === "FAILED") continue;
      const thinking = boundText(record.thinking ?? "").trim();
      if (thinking)
        items.push({
          type: "reasoning",
          id: "history:" + stepIndex + ":reasoning",
          text: thinking,
          timestamp,
        });
      const content = boundText(record.content ?? "").trim();
      if (content) {
        const id = "history:" + stepIndex + ":assistant";
        items.push({
          type: "assistant_message",
          id,
          messageId: id,
          text: content,
          timestamp,
        });
      }
      for (const [index, call] of (record.tool_calls ?? []).entries()) {
        const name = call.name || "tool";
        const args = boundValue(call.args ?? {});
        const id = "history:" + stepIndex + ":tool:" + index;
        const state: AcpToolCallState = {
          toolCallId: id,
          name,
          title: toolTitle(name, args),
          kind: toolKind(name),
          status: "in_progress",
          rawInput: args,
          rawOutput: null,
          locations: [],
        };
        // Keep call order even when tools finish in a different order.
        pending.push({ state, index: items.length });
        items.push({ ...acpToolToTimelineItem(state), timestamp });
      }
      continue;
    }
    if (type === "SYSTEM_MESSAGE") {
      const text = record.content ?? "";
      const finishMatch =
        /Task id "([\w-]+\/task-\d+)" finished with result:/.exec(text);
      const messageMatch =
        /\[Message\]\s+timestamp=\S+\s+sender=([\w/-]+)\b/.exec(text);
      const senderId = finishMatch?.[1] ?? messageMatch?.[1];
      const bg = senderId ? backgroundTools.get(senderId) : undefined;
      if (bg) {
        bg.state.rawOutput = boundText(text);
        const exit = /Command exited with code (-?\d+)/.exec(text);
        const exitCode = exit ? Number(exit[1]) : undefined;
        const item = toolItem(
          bg.state,
          exitCode !== undefined && exitCode !== 0 ? "failed" : "completed",
        );
        if (item.detail.type === "shell" && exitCode !== undefined)
          item.detail = { ...item.detail, exitCode };
        items[bg.index] = {
          ...item,
          timestamp: items[bg.index]?.timestamp ?? timestamp,
        };
      }
      continue;
    }
    const toolIndex =
      type === "GENERIC"
        ? 0
        : pending.findIndex((tool) =>
            matchesToolResult(tool.state.name!, type),
          );
    if (toolIndex < 0 || pending.length === 0) continue;
    const tool = pending.splice(toolIndex, 1)[0]!;
    const rawText = record.content ?? "";
    tool.state.rawOutput = boundText(rawText);
    const running = record.status === "RUNNING" || record.status === "PENDING";
    if (running) {
      const bgMatch =
        /Tool is running as a background task with task id:\s*([\w-]+\/task-\d+)/.exec(
          rawText,
        );
      if (bgMatch) backgroundTools.set(bgMatch[1]!, tool);
    }
    const item =
      live && running
        ? acpToolToTimelineItem(tool.state)
        : toolItem(tool.state, toolOutcome(record.status));
    if (item.detail.type === "shell" && record.exit_code !== undefined)
      item.detail = { ...item.detail, exitCode: record.exit_code };
    items[tool.index] = {
      ...item,
      timestamp: items[tool.index]?.timestamp ?? timestamp,
    };
  }
  if (!live) flushPending(items, pending);
  return items;
}

async function resolveTranscriptFile(
  conversationId: string,
  env: Record<string, string | undefined>,
): Promise<{ path: string; updatedAt: string } | null> {
  const logsDir = resolveTranscriptDir(conversationId, env);
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const filePath = path.join(logsDir, name);
    try {
      const info = await stat(filePath);
      if (info.isFile() && info.size > 0)
        return { path: filePath, updatedAt: info.mtime.toISOString() };
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
  return null;
}

export interface TranscriptOffset {
  path: string;
  size: number;
}

export async function statTranscriptOffset(
  conversationId: string,
  env: Record<string, string | undefined>,
): Promise<TranscriptOffset | null> {
  const logsDir = resolveTranscriptDir(conversationId, env);
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const filePath = path.join(logsDir, name);
    try {
      const info = await stat(filePath);
      if (info.isFile()) return { path: filePath, size: info.size };
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
  return null;
}

export async function readConversationRecordsFromOffset(
  conversationId: string,
  env: Record<string, string>,
  before: TranscriptOffset | null,
): Promise<{ hasTranscript: boolean; records: TranscriptRecord[] }> {
  const current = await statTranscriptOffset(conversationId, env);
  if (!current || current.size === 0) {
    return { hasTranscript: Boolean(current), records: [] };
  }
  const start =
    before && before.path === current.path && before.size <= current.size
      ? before.size
      : 0;
  if (start >= current.size) {
    return { hasTranscript: true, records: [] };
  }
  const records: TranscriptRecord[] = [];
  for await (const record of readTranscriptRecords(current.path, start)) {
    records.push(record);
  }
  return { hasTranscript: true, records };
}

export async function* readConversationRecords(
  conversationId: string,
  env: Record<string, string>,
): AsyncGenerator<TranscriptRecord> {
  const file = await resolveTranscriptFile(conversationId, env);
  if (file) yield* readTranscriptRecords(file.path);
}

async function* readTranscriptRecords(filePath: string, start = 0) {
  const stream = createReadStream(filePath, {
    encoding: "utf8",
    ...(start > 0 ? { start } : {}),
  });
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // A running session can leave a partially written JSONL record at the end.
        continue;
      }
      yield transcriptRecordSchema.parse(value);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export function matchesToolResult(name: string, type: string): boolean {
  if (type === "GENERIC") return true;
  if (
    name.toUpperCase() === type ||
    (name === "list_dir" && type === "LIST_DIRECTORY") ||
    (name === "read_file" && type === "VIEW_FILE")
  )
    return true;
  return (
    type === "CODE_ACTION" &&
    [
      "edit_file",
      "replace_file_content",
      "multi_replace_file_content",
      "write_file",
      "write_to_file",
    ].includes(name)
  );
}
function flushPending(
  items: TranscriptTimelineItem[],
  pending: PendingTool[],
): void {
  for (const tool of pending.splice(0))
    items[tool.index] = {
      ...toolItem(tool.state, "canceled"),
      timestamp: items[tool.index]?.timestamp,
    };
}
function toolOutcome(status?: string): "completed" | "failed" | "canceled" {
  if (status === "DONE") return "completed";
  if (status === "ERROR") return "failed";
  return "canceled";
}
function toolItem(
  state: AcpToolCallState,
  outcome: "completed" | "failed" | "canceled",
): Extract<ProviderTimelineItem, { type: "tool_call" }> {
  const item = acpToolToTimelineItem({
    ...state,
    status: outcome === "failed" ? "failed" : "completed",
  });
  return outcome === "canceled"
    ? { ...item, status: "canceled", error: null }
    : item;
}
function displayUserText(content: string): string {
  const wrapped = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(
    content,
  );
  const inner = wrapped ? wrapped[1]! : content;
  return inner.split(/<ADDITIONAL_METADATA>/)[0]!.trim();
}
function toolTitle(name: string, args: JsonValue): string {
  if (
    args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    typeof args.toolSummary === "string" &&
    args.toolSummary.trim()
  )
    return boundText(args.toolSummary.trim());
  return name;
}
function toolKind(name: string): string | undefined {
  if (name === "run_command") return "execute";
  if (["read_file", "view_file", "list_directory"].includes(name))
    return "read";
  if (
    [
      "edit_file",
      "replace_file_content",
      "multi_replace_file_content",
      "write_file",
      "write_to_file",
    ].includes(name)
  )
    return "edit";
  return undefined;
}
function boundText(text: string): string {
  return text.length > MAX_TEXT_UNITS
    ? text.slice(0, MAX_TEXT_UNITS) + "\n…[truncated]"
    : text;
}
function boundValue(value: JsonValue, depth = 0): JsonValue {
  if (typeof value === "string") return boundText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return null;
  if (Array.isArray(value))
    return value.slice(0, 200).map((entry) => boundValue(entry, depth + 1));
  const bounded: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value))
    bounded[key] = boundValue(entry, depth + 1);
  return bounded;
}
