import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { resolveTranscriptDir } from "./rewind.js";
import { acpToolToTimelineItem, type AcpToolCallState } from "./timeline.js";

const MAX_TEXT_UNITS = 64 * 1024;
const transcriptRecordSchema = z.object({
  step_index: z.number().int().nonnegative().optional(),
  created_at: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  content: z.string().optional(),
  thinking: z.string().optional(),
  exit_code: z.number().int().optional(),
  tool_calls: z
    .array(
      z.object({
        name: z.string().optional(),
        args: z.record(z.string(), z.json()).optional(),
      }),
    )
    .optional(),
});
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

export async function readTranscriptTimeline(
  conversationId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<TranscriptTimelineItem[]> {
  const file = await resolveTranscriptFile(conversationId, env);
  if (!file) return [];
  const items: TranscriptTimelineItem[] = [];
  const pending: PendingTool[] = [];
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
      const text = displayUserText(record.content ?? "");
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
    if (type === "PLANNER_RESPONSE") {
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
    const toolIndex =
      type === "GENERIC"
        ? 0
        : pending.findIndex((tool) =>
            matchesToolResult(tool.state.name!, type),
          );
    if (toolIndex < 0 || pending.length === 0) continue;
    const tool = pending.splice(toolIndex, 1)[0]!;
    tool.state.rawOutput = boundText(record.content ?? "");
    const item = toolItem(tool.state, toolOutcome(record.status));
    if (item.detail.type === "shell" && record.exit_code !== undefined)
      item.detail = { ...item.detail, exitCode: record.exit_code };
    items[tool.index] = {
      ...item,
      timestamp: items[tool.index]?.timestamp ?? timestamp,
    };
  }
  flushPending(items, pending);
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

async function* readTranscriptRecords(filePath: string) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
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

function matchesToolResult(name: string, type: string): boolean {
  if (
    name.toUpperCase() === type ||
    (name === "list_dir" && type === "LIST_DIRECTORY")
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
