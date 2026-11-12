import path from "node:path";
import { z } from "zod";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { resolveAntigravityCliDir } from "./rewind.js";
import {
  readConversationRecords,
  matchesToolResult,
} from "./transcript-history.js";
import type { AcpToolCallState } from "./timeline.js";

export interface PlanProposal {
  text: string;
  summary?: string;
  path: string;
}
const inputSchema = z.object({
  Path: z.string().optional(),
  TargetFile: z.string().optional(),
  Content: z.string().optional(),
  CodeContent: z.string().optional(),
  ArtifactMetadata: z
    .object({
      RequestFeedback: z.boolean().optional(),
      UserFacing: z.boolean().optional(),
      Summary: z.string().optional(),
    })
    .optional(),
});

// Plan approvals are provider-owned UX: AGY requests artifact feedback, not an
// ACP request_permission. Only explicit feedback on this conversation's plan qualifies.
export function planFromTool(
  state: AcpToolCallState,
  conversationId: string,
  env: Record<string, string>,
): PlanProposal | null {
  if (
    state.status !== "completed" ||
    !["write_file", "write_to_file"].includes(state.name ?? "")
  )
    return null;
  const parsed = inputSchema.safeParse(state.rawInput);
  if (!parsed.success) return null;
  const input = parsed.data;
  const file = input.Path ?? input.TargetFile;
  const expected = path.join(
    resolveAntigravityCliDir(env),
    "brain",
    conversationId,
    "implementation_plan.md",
  );
  const text = input.Content ?? input.CodeContent ?? state.diff?.newText;
  if (
    !file ||
    path.resolve(file) !== expected ||
    input.ArtifactMetadata?.RequestFeedback !== true ||
    input.ArtifactMetadata.UserFacing !== true ||
    !text?.trim()
  )
    return null;
  return { text, summary: input.ArtifactMetadata.Summary, path: expected };
}

export async function readPendingPlan(
  conversationId: string,
  env: Record<string, string>,
): Promise<PlanProposal | null> {
  let plan: PlanProposal | null = null;
  const pending: Array<{ name: string; args: JsonValue }> = [];
  for await (const record of readConversationRecords(conversationId, env)) {
    if (record.type === "USER_INPUT") {
      plan = null;
      pending.length = 0;
    }
    if (record.type === "PLANNER_RESPONSE") pending.length = 0;
    if (record.type === "PLANNER_RESPONSE")
      for (const call of record.tool_calls ?? [])
        pending.push({ name: call.name ?? "", args: call.args ?? null });
    const index = pending.findIndex((call) =>
      matchesToolResult(call.name, record.type ?? ""),
    );
    if (index < 0) continue;
    const call = pending.splice(index, 1)[0];
    if (!call || record.status !== "DONE") continue;
    plan =
      planFromTool(
        {
          toolCallId: "plan",
          name: call.name,
          title: "Plan",
          status: "completed",
          rawInput: call.args,
          rawOutput: null,
          locations: [],
        },
        conversationId,
        env,
      ) ?? plan;
  }
  return plan;
}
