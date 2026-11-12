import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

export interface AcpToolCallState {
  toolCallId: string;
  name?: string;
  title: string;
  kind?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  rawInput: JsonValue;
  rawOutput: JsonValue;
  locations: string[];
  diff?: {
    path?: string;
    oldText?: string | null;
    newText?: string;
  };
  textContent?: string;
}

function asRecord(val: unknown): Record<string, unknown> {
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

function asString(val: unknown): string | undefined {
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

export function mergeAcpToolCall(
  update: Record<string, unknown>,
  previous?: AcpToolCallState,
): AcpToolCallState {
  const toolCallId =
    asString(update.toolCallId) ?? previous?.toolCallId ?? "tool";
  const name = asString(update.name) ?? previous?.name;
  const title =
    asString(update.title) ?? previous?.title ?? name ?? "Antigravity tool";
  const kind = asString(update.kind) ?? previous?.kind;
  const rawStatus =
    asString(update.status) ?? previous?.status ?? "in_progress";
  const status: AcpToolCallState["status"] =
    rawStatus === "pending" ||
    rawStatus === "in_progress" ||
    rawStatus === "completed" ||
    rawStatus === "failed"
      ? rawStatus
      : "in_progress";

  const rawInput = (
    update.rawInput !== undefined
      ? update.rawInput
      : (previous?.rawInput ?? null)
  ) as JsonValue;
  const rawOutput = (
    update.rawOutput !== undefined
      ? update.rawOutput
      : (previous?.rawOutput ?? null)
  ) as JsonValue;

  let locations = previous?.locations ?? [];
  if (Array.isArray(update.locations)) {
    locations = update.locations
      .map((loc) => asString(asRecord(loc).path))
      .filter((p): p is string => Boolean(p));
  }

  let diff = previous?.diff;
  let textContent = previous?.textContent;
  if (Array.isArray(update.content)) {
    const texts: string[] = [];
    for (const entry of update.content) {
      const rec = asRecord(entry);
      if (rec.type === "diff") {
        diff = {
          path: asString(rec.path) ?? diff?.path,
          oldText:
            typeof rec.oldText === "string" || rec.oldText === null
              ? rec.oldText
              : diff?.oldText,
          newText:
            typeof rec.newText === "string" ? rec.newText : diff?.newText,
        };
      } else if (rec.type === "content") {
        const inner = asRecord(rec.content);
        if (inner.type === "text" && typeof inner.text === "string") {
          texts.push(inner.text);
        }
      } else if (rec.type === "text" && typeof rec.text === "string") {
        texts.push(rec.text);
      }
    }
    if (texts.length > 0) {
      textContent = texts.join("\n");
    }
  }

  return {
    toolCallId,
    name,
    title,
    kind,
    status,
    rawInput,
    rawOutput,
    locations,
    diff,
    textContent,
  };
}

export function extractModifiedFilePaths(state: AcpToolCallState): string[] {
  const paths = new Set<string>();
  const lowerName = (state.name ?? state.title).toLowerCase();
  const modifiesFiles =
    ["edit", "delete", "move"].includes(state.kind ?? "") ||
    /edit|write|replace|delete|move/.test(lowerName);
  if (!modifiesFiles && !state.diff) return [];
  const input = asRecord(state.rawInput);
  for (const key of [
    "Path",
    "AbsolutePath",
    "TargetFile",
    "filePath",
    "path",
  ]) {
    const val = asString(input[key]);
    if (val) paths.add(val);
  }
  if (state.diff?.path) paths.add(state.diff.path);
  if (
    state.kind === "edit" ||
    lowerName.includes("edit") ||
    lowerName.includes("write") ||
    lowerName.includes("replace")
  ) {
    for (const loc of state.locations) {
      paths.add(loc);
    }
  }
  return [...paths];
}

export function acpToolToTimelineItem(
  state: AcpToolCallState,
): Extract<ProviderTimelineItem, { type: "tool_call" }> {
  const detail = buildToolDetail(state);
  const name = state.name ?? state.title ?? "Antigravity tool";
  const status =
    state.status === "pending" || state.status === "in_progress"
      ? "running"
      : state.status;

  const base = {
    type: "tool_call" as const,
    id: state.toolCallId,
    callId: state.toolCallId,
    name,
    detail,
  };

  if (status === "failed") {
    return {
      ...base,
      status: "failed",
      error: state.rawOutput ?? state.textContent ?? "Antigravity tool failed",
    };
  }
  return {
    ...base,
    status,
    error: null,
  };
}

export function buildToolDetail(
  state: AcpToolCallState,
): ProviderToolCallDetail {
  const input = asRecord(state.rawInput);
  const outputStr =
    typeof state.rawOutput === "string"
      ? state.rawOutput
      : (state.textContent ??
        (state.rawOutput !== null && state.rawOutput !== undefined
          ? JSON.stringify(state.rawOutput)
          : undefined));

  const filePath =
    asString(input.Path) ??
    asString(input.AbsolutePath) ??
    asString(input.TargetFile) ??
    asString(input.filePath) ??
    asString(input.path) ??
    state.diff?.path ??
    state.locations[0];

  const lowerName = (state.name ?? state.title).toLowerCase();

  const command =
    asString(input.CommandLine) ??
    asString(input.command) ??
    (state.kind === "execute" ? state.title : undefined);
  if (state.kind === "execute" || lowerName === "run_command" || command) {
    return {
      type: "shell",
      command: command ?? state.title,
      cwd: asString(input.Cwd) ?? asString(input.cwd),
      output: outputStr,
    };
  }

  if (
    state.diff ||
    state.kind === "edit" ||
    lowerName === "edit_file" ||
    lowerName === "replace_file_content" ||
    lowerName === "multi_replace_file_content"
  ) {
    if (filePath) {
      return {
        type: "edit",
        filePath,
        oldString:
          state.diff?.oldText ??
          asString(input.Target) ??
          asString(input.TargetContent),
        newString:
          state.diff?.newText ??
          asString(input.Replacement) ??
          asString(input.ReplacementContent),
      };
    }
  }

  if (lowerName === "write_file" || lowerName === "write_to_file") {
    if (filePath) {
      return {
        type: "write",
        filePath,
        content: asString(input.Content) ?? asString(input.CodeContent),
      };
    }
  }

  if (
    state.kind === "read" ||
    lowerName === "read_file" ||
    lowerName === "view_file"
  ) {
    if (filePath) {
      return {
        type: "read",
        filePath,
        content: outputStr,
      };
    }
  }

  if (lowerName === "search_web") {
    const query = asString(input.query) ?? state.title;
    return {
      type: "search",
      toolName: "web_search",
      query,
      content: outputStr,
    };
  }

  if (
    state.kind === "search" ||
    lowerName === "grep_search" ||
    lowerName === "find_by_name"
  ) {
    const query =
      asString(input.Query) ??
      asString(input.Pattern) ??
      asString(input.query) ??
      state.title;
    return {
      type: "search",
      query,
    };
  }

  if (lowerName === "invoke_subagent" || lowerName.includes("subagent")) {
    return {
      type: "sub_agent",
      subAgentType:
        asString(input.TypeName) ?? asString(input.Role) ?? "subagent",
      description:
        asString(input.Prompt) ?? asString(input.Role) ?? state.title,
      log: outputStr ?? "",
    };
  }

  return {
    type: "unknown",
    input: state.rawInput,
    output: state.rawOutput ?? (state.textContent ? state.textContent : null),
  };
}
