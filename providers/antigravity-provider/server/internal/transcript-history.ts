import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { resolveTranscriptDir } from "./rewind.js";
import { acpToolToTimelineItem, type AcpToolCallState } from "./timeline.js";

/** Matches the daemon timeline content cap used by other history replays. */
const MAX_TEXT_UNITS = 64 * 1024;

interface TranscriptRecord {
  step_index?: number;
  type?: string;
  status?: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
}

interface PendingTool {
  state: AcpToolCallState;
}

/**
 * Rebuild a Paseo timeline from agy's on-disk transcript.
 *
 * `agy acp` session/load finds the conversation and then closes its update
 * stream without emitting past turns. The transcript next to that conversation
 * is the copy that still has them.
 */
export async function readTranscriptTimeline(
  conversationId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderTimelineItem[]> {
  const filePath = await resolveTranscriptFile(conversationId, env);
  if (!filePath) return [];

  const items: ProviderTimelineItem[] = [];
  const pending: PendingTool[] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: TranscriptRecord;
      try {
        record = JSON.parse(trimmed) as TranscriptRecord;
      } catch {
        continue;
      }
      const stepIndex =
        typeof record.step_index === "number"
          ? record.step_index
          : items.length;
      const type = record.type ?? "";
      if (type === "USER_INPUT" || type === "PLANNER_RESPONSE") {
        flushPending(items, pending, "canceled");
      }
      if (type === "USER_INPUT") {
        const text = displayUserText(record.content ?? "");
        if (!text) continue;
        const id = `history:${stepIndex}:user`;
        items.push({
          type: "user_message",
          id,
          messageId: id,
          text,
        });
        continue;
      }
      if (type === "PLANNER_RESPONSE") {
        const thinking = boundText(record.thinking ?? "").trim();
        if (thinking) {
          items.push({
            type: "reasoning",
            id: `history:${stepIndex}:reasoning`,
            text: thinking,
          });
        }
        const content = boundText(record.content ?? "").trim();
        if (content) {
          const id = `history:${stepIndex}:assistant`;
          items.push({
            type: "assistant_message",
            id,
            messageId: id,
            text: content,
          });
        }
        for (const [index, call] of (record.tool_calls ?? []).entries()) {
          const name =
            typeof call.name === "string" && call.name ? call.name : "tool";
          const args = asRecord(boundValue(call.args ?? {}));
          const id = `history:${stepIndex}:tool:${index}`;
          pending.push({
            state: {
              toolCallId: id,
              name,
              title: toolTitle(name, args),
              kind: toolKind(name),
              status: "completed",
              rawInput: args as JsonValue,
              rawOutput: null,
              locations: [],
            },
          });
        }
        continue;
      }
      if (type === "GENERIC") {
        const tool = pending.shift();
        if (!tool) continue;
        const output = boundText(record.content ?? "");
        tool.state.rawOutput = output;
        items.push(toolItem(tool.state, toolOutcome(record.status)));
      }
    }
  } finally {
    lines.close();
  }
  flushPending(items, pending, "canceled");
  return items;
}

async function resolveTranscriptFile(
  conversationId: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const logsDir = resolveTranscriptDir(conversationId, env);
  const full = path.join(logsDir, "transcript_full.jsonl");
  const compact = path.join(logsDir, "transcript.jsonl");
  if (await nonempty(full)) return full;
  if (await nonempty(compact)) return compact;
  return null;
}

async function nonempty(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  try {
    return (await stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

function flushPending(
  items: ProviderTimelineItem[],
  pending: PendingTool[],
  outcome: "canceled",
): void {
  for (const tool of pending.splice(0)) {
    items.push(toolItem(tool.state, outcome));
  }
}

function toolOutcome(
  status: string | undefined,
): "completed" | "failed" | "canceled" {
  if (status === "DONE") return "completed";
  if (status === "ERROR") return "failed";
  return "canceled";
}

function toolItem(
  state: AcpToolCallState,
  outcome: "completed" | "failed" | "canceled",
): ProviderTimelineItem {
  if (outcome === "failed") {
    return acpToolToTimelineItem({ ...state, status: "failed" });
  }
  const completed = acpToolToTimelineItem({ ...state, status: "completed" });
  if (outcome === "canceled") {
    return { ...completed, status: "canceled", error: null };
  }
  return completed;
}

function displayUserText(content: string): string {
  const wrapped = content.match(
    /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/,
  );
  const inner = wrapped ? wrapped[1] : content;
  const visible = inner.split(/<ADDITIONAL_METADATA>/)[0] ?? inner;
  return boundText(visible).trim();
}

function toolTitle(name: string, args: Record<string, unknown>): string {
  const summary = args.toolSummary;
  if (typeof summary === "string" && summary.trim())
    return boundText(summary.trim());
  return name;
}

function toolKind(name: string): string | undefined {
  if (name === "run_command") return "execute";
  if (name === "read_file" || name === "view_file") return "read";
  if (name === "edit_file" || name === "write_file" || name === "write_to_file")
    return "edit";
  return undefined;
}

function boundText(text: string): string {
  if (text.length <= MAX_TEXT_UNITS) return text;
  return `${text.slice(0, MAX_TEXT_UNITS)}\n…[truncated]`;
}

function boundValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return boundText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (depth > 8) return null;
  if (Array.isArray(value))
    return value.slice(0, 200).map((entry) => boundValue(entry, depth + 1));
  if (typeof value === "object" && value) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = boundValue(entry, depth + 1);
    }
    return out;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
