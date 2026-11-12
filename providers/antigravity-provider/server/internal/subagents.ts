import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import {
  readConversationRecords,
  parseSubagentResult,
  matchesToolResult,
  readTranscriptTimeline,
  type TranscriptTimelineItem,
} from "./transcript-history.js";
import { readBackgroundTurn } from "./background.js";
import { providerError, AntigravityError } from "./diagnostics.js";

interface ChildDescriptor {
  conversationId: string;
  parentId: string;
  callId: string;
  title: string;
  description?: string;
  args: JsonValue;
}
interface ChildState {
  descriptor: ChildDescriptor;
  status: "running" | "completed" | "failed" | "canceled";
  snapshots: Map<string, string>;
  linkFingerprint?: string;
  items: TranscriptTimelineItem[];
}
interface TrackerOptions {
  id: string;
  conversationId: string;
  cwd: string;
  env: Record<string, string>;
  emit(event: ProviderEvent): void;
  resolveCallId(callId: string, args: JsonValue): string;
}

// The child id comes from AGY's launch result, not the tool's description or an
// invented local process. Never follow logAbsoluteUri supplied by a tool result.
function valueString(value: JsonValue, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const text = value[key];
  if (typeof text !== "string") return undefined;
  if (text.startsWith('"')) {
    try {
      const decoded = JSON.parse(text);
      if (typeof decoded === "string") return decoded;
    } catch {
      /* Keep literal tool input. */
    }
  }
  return text;
}

export class SubagentTracker {
  private readonly children = new Map<string, ChildState>();
  private syncing: Promise<void> | null = null;
  private stopped = false;
  constructor(private readonly options: TrackerOptions) {}
  get running(): boolean {
    return [...this.children.values()].some(
      (child) => child.status === "running",
    );
  }

  async resume(): Promise<void> {
    await this.syncing;
    this.stopped = false;
  }

  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.syncing) return this.syncing;
    const syncing = this.refreshChildren();
    this.syncing = syncing;
    try {
      await syncing;
    } finally {
      if (this.syncing === syncing) this.syncing = null;
    }
  }

  private async refreshChildren(): Promise<void> {
    const queue = [this.options.conversationId];
    const visited = new Set<string>();
    while (queue.length) {
      const parent = queue.shift()!;
      if (visited.has(parent)) continue;
      visited.add(parent);
      const calls: Array<{ name: string; args: JsonValue; callId: string }> =
        [];
      for await (const record of readConversationRecords(
        parent,
        this.options.env,
      )) {
        if (this.stopped) return;
        if (record.type === "USER_INPUT" || record.type === "PLANNER_RESPONSE")
          calls.length = 0;
        if (record.type === "PLANNER_RESPONSE")
          for (const [index, call] of (record.tool_calls ?? []).entries())
            calls.push({
              name: call.name ?? "",
              args: call.args ?? null,
              callId: "history:" + record.step_index + ":tool:" + index,
            });
        const index = calls.findIndex((call) =>
          matchesToolResult(call.name, record.type ?? ""),
        );
        if (index < 0) continue;
        const call = calls.splice(index, 1)[0]!;
        if (call.name !== "invoke_subagent" || record.status !== "DONE")
          continue;
        const child = parseSubagentResult(record.content ?? "");
        if (!child || visited.has(child.conversationId)) continue;
        if (!this.children.has(child.conversationId)) {
          const parentSession =
            parent === this.options.conversationId
              ? this.options.id
              : "agy-child:" + parent;
          const callId =
            parent === this.options.conversationId
              ? this.options.resolveCallId(call.callId, call.args)
              : call.callId;
          const descriptor: ChildDescriptor = {
            conversationId: child.conversationId,
            parentId: parentSession,
            callId,
            title:
              valueString(call.args, "Role") ??
              valueString(call.args, "TypeName") ??
              "Antigravity subagent",
            description: valueString(call.args, "Prompt"),
            args: call.args,
          };
          const state: ChildState = {
            descriptor,
            status: "running",
            snapshots: new Map(),
            items: [],
          };
          this.children.set(child.conversationId, state);
          this.options.emit({
            type: "session.opened",
            sessionId: "agy-child:" + child.conversationId,
            parentSessionId: parentSession,
            toolCallId: callId,
            capabilities: [],
            restoration: "parent",
            cwd: this.options.cwd,
            title: descriptor.title,
            description: descriptor.description,
          });
          this.options.emit({
            type: "session.turn",
            sessionId: "agy-child:" + child.conversationId,
            turnId: "agy-child-turn:" + child.conversationId,
            state: "started",
          });
        }
        queue.push(child.conversationId);
      }
      if (parent !== this.options.conversationId)
        await this.publishChild(parent);
    }
  }

  private async publishChild(id: string): Promise<void> {
    const child = this.children.get(id)!;
    if (child.status !== "running") return;
    let terminal: "completed" | "failed" | "canceled" | undefined;
    let message: string | undefined;
    for await (const record of readConversationRecords(id, this.options.env)) {
      if (record.type === "PLANNER_RESPONSE") {
        terminal =
          record.status === "DONE" && !record.tool_calls?.length
            ? "completed"
            : undefined;
        if (record.status === "ERROR" || record.status === "FAILED") {
          terminal = "failed";
          message = record.content ?? "Antigravity subagent failed";
        }
        if (record.status === "CANCELED" || record.status === "INTERRUPTED")
          terminal = "canceled";
      } else if (
        record.type !== "CHECKPOINT" &&
        record.type !== "CONVERSATION_HISTORY"
      )
        terminal = undefined;
    }
    const background = await readBackgroundTurn(id, this.options.env);
    if (background && !background.settled && !background.failure)
      terminal = undefined;
    if (background?.failure) {
      terminal = "failed";
      message = background.failure.message;
    }
    const items = await readTranscriptTimeline(id, this.options.env, true);
    if (this.stopped) return;
    child.items = items;
    this.publishLink(child, terminal ?? "running", items);
    for (const item of items) {
      if (
        item.type === "tool_call" &&
        [...this.children.values()].some(
          (nested) =>
            nested.descriptor.parentId === "agy-child:" + id &&
            nested.descriptor.callId === item.callId,
        )
      )
        continue;
      const fingerprint = JSON.stringify(item);
      if (child.snapshots.get(item.id) === fingerprint) continue;
      child.snapshots.set(item.id, fingerprint);
      const { timestamp, ...timeline } = item;
      this.options.emit({
        type: "timeline.item",
        sessionId: "agy-child:" + id,
        item: timeline,
        timestamp,
      });
    }
    if (terminal) {
      child.status = terminal;
      this.options.emit({
        type: "session.turn",
        sessionId: "agy-child:" + id,
        turnId: "agy-child-turn:" + id,
        state: terminal,
        ...(terminal === "failed"
          ? {
              error: providerError(
                new AntigravityError(
                  message ?? "Antigravity subagent failed",
                  "SUBAGENT_FAILED",
                ),
              ),
            }
          : {}),
      });
    }
  }

  private publishLink(
    child: ChildState,
    status: "running" | "completed" | "failed" | "canceled",
    items: TranscriptTimelineItem[],
  ): void {
    const descriptor = child.descriptor;
    const log = items
      .filter((item) => item.type === "assistant_message")
      .map((item) => (item.type === "assistant_message" ? item.text : ""))
      .join("\n");
    const actions = items
      .filter((item) => item.type === "tool_call")
      .map((item, index) => ({
        index: index + 1,
        toolName: item.type === "tool_call" ? item.name : "",
        summary: item.type === "tool_call" ? item.status : undefined,
      }));
    const detail = {
      type: "sub_agent" as const,
      childSessionId: "agy-child:" + descriptor.conversationId,
      subAgentType: valueString(descriptor.args, "TypeName"),
      description: descriptor.description,
      log,
      actions,
    };
    const item = {
      type: "tool_call" as const,
      id: descriptor.callId,
      callId: descriptor.callId,
      name: "invoke_subagent",
      detail,
      status,
      error: status === "failed" ? "Antigravity subagent failed" : null,
    };
    const fingerprint = JSON.stringify(item);
    if (child.linkFingerprint === fingerprint) return;
    child.linkFingerprint = fingerprint;
    if (status === "failed")
      this.options.emit({
        type: "timeline.item",
        sessionId: descriptor.parentId,
        item: {
          ...item,
          status: "failed",
          error: "Antigravity subagent failed",
        },
      });
    else
      this.options.emit({
        type: "timeline.item",
        sessionId: descriptor.parentId,
        item: { ...item, status, error: null },
      });
  }

  finish(status: "failed" | "canceled"): void {
    this.stopped = true;
    for (const [id, child] of this.children) {
      if (child.status !== "running") continue;
      child.status = status;
      this.publishLink(child, status, child.items);
      this.options.emit({
        type: "session.turn",
        sessionId: "agy-child:" + id,
        turnId: "agy-child-turn:" + id,
        state: status,
        ...(status === "failed"
          ? {
              error: {
                message: "Parent Antigravity runtime exited",
                code: "SUBAGENT_RUNTIME_FAILED",
              },
            }
          : {}),
      });
    }
  }
}
