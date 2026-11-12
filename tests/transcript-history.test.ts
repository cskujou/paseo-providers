import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTranscriptTimeline,
  readTranscriptSummary,
} from "../providers/antigravity-provider/server/internal/transcript-history.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function transcript(records: object[], name = "transcript_full.jsonl") {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-transcript-test-"));
  directories.push(home);
  const logs = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    "fixture",
    ".system_generated",
    "logs",
  );
  await mkdir(logs, { recursive: true });
  await writeFile(
    path.join(logs, name),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  return { env: { HOME: home }, logs };
}

describe("local transcript metadata and replay", () => {
  it("extracts first and latest user prompts without model text or injected metadata", async () => {
    const { env } = await transcript([
      {
        step_index: 0,
        type: "USER_INPUT",
        content:
          "<USER_REQUEST> First\n  prompt </USER_REQUEST>\n<ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>",
      },
      { step_index: 1, type: "PLANNER_RESPONSE", content: "not a user prompt" },
      { step_index: 2, type: "USER_INPUT", content: "Latest\n\trequest" },
    ]);
    expect(await readTranscriptSummary("fixture", env)).toMatchObject({
      firstPromptPreview: "First prompt",
      lastPromptPreview: "Latest request",
    });
  });
  it("caps each preview at 160 characters and falls back to the compact transcript", async () => {
    const { env, logs } = await transcript(
      [{ type: "USER_INPUT", content: "x".repeat(1000) }],
      "transcript.jsonl",
    );
    await writeFile(path.join(logs, "transcript_full.jsonl"), "");
    expect(await readTranscriptSummary("fixture", env)).toMatchObject({
      firstPromptPreview: "x".repeat(160),
      lastPromptPreview: "x".repeat(160),
    });
  });
  it("keeps missing prompts absent instead of inventing an empty conversation summary", async () => {
    const { env } = await transcript([
      { type: "USER_INPUT", content: " " },
      { type: "PLANNER_RESPONSE", content: "only assistant" },
    ]);
    const summary = await readTranscriptSummary("fixture", env);
    expect([summary.firstPromptPreview, summary.lastPromptPreview]).toEqual([
      undefined,
      undefined,
    ]);
    expect(await readTranscriptSummary("absent", env)).toEqual({});
  });
  it("matches concrete tool-result types instead of canceling every non-GENERIC tool", async () => {
    const { env } = await transcript([
      { step_index: 0, type: "USER_INPUT", content: "run the test" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "npm test" } },
          { name: "view_file", args: { AbsolutePath: "/tmp/file.ts" } },
        ],
      },
      {
        step_index: 2,
        type: "CHECKPOINT",
        status: "DONE",
        content: "checkpoint is not a tool result",
      },
      {
        step_index: 3,
        type: "VIEW_FILE",
        status: "DONE",
        content: "file contents",
      },
      {
        step_index: 4,
        type: "RUN_COMMAND",
        status: "ERROR",
        exit_code: 1,
        content: "test failure",
      },
      { step_index: 5, type: "PLANNER_RESPONSE", content: "done" },
    ]);
    const items = await readTranscriptTimeline("fixture", env);
    const tools = items.filter((item) => item.type === "tool_call");
    expect(tools.map((tool) => [tool.name, tool.status])).toEqual([
      ["run_command", "failed"],
      ["view_file", "completed"],
    ]);
    expect(tools[0]?.detail).toMatchObject({
      type: "shell",
      command: "npm test",
      output: "test failure",
      exitCode: 1,
    });
    expect(tools[1]?.detail).toMatchObject({
      type: "read",
      filePath: "/tmp/file.ts",
      content: "file contents",
    });
    expect(items.at(-1)).toMatchObject({
      type: "assistant_message",
      text: "done",
    });
  });
  it("replays list_dir aliases and renders write_to_file as a write rather than an empty edit", async () => {
    const { env } = await transcript([
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          { name: "list_dir", args: { DirectoryPath: "/tmp" } },
          {
            name: "write_to_file",
            args: { TargetFile: "/tmp/empty.txt", CodeContent: "" },
          },
        ],
      },
      {
        step_index: 1,
        type: "LIST_DIRECTORY",
        status: "DONE",
        content: "files",
      },
      {
        step_index: 2,
        type: "CODE_ACTION",
        status: "DONE",
        content: "written",
      },
    ]);
    const tools = (await readTranscriptTimeline("fixture", env)).filter(
      (item) => item.type === "tool_call",
    );
    expect(tools.map((tool) => tool.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(tools[1]?.detail).toEqual({
      type: "write",
      filePath: "/tmp/empty.txt",
      content: "",
    });
  });

  it("never follows a conversation id outside the transcript root", async () => {
    const { env } = await transcript([]);
    await expect(readTranscriptSummary("../outside", env)).rejects.toThrow(
      /conversation ID/,
    );
  });
});
