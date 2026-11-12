import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/paseo-host.mjs", import.meta.url),
);
async function run(mode: string): Promise<unknown> {
  const { stdout } = await exec(process.execPath, [fixture, mode], {
    timeout: 20000,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

describe("compiled provider through the real Paseo 0.14 host", () => {
  it("preserves import-sheet summaries through schema validation, listing and import", async () => {
    expect(await run("summaries")).toEqual({
      listed: [
        {
          title: "matching title",
          firstPromptPreview: "First request",
          lastPromptPreview: "Latest request needle",
          hasActivity: true,
        },
      ],
      timeline: [
        {
          type: "user_message",
          text: "First\nrequest",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "tool_call",
          timestamp: "2026-01-01T00:00:01.000Z",
          status: "completed",
          detail: {
            type: "shell",
            command: "npm test",
            output: "passed",
            exitCode: 0,
          },
        },
        {
          type: "user_message",
          text: "Latest request needle",
          timestamp: "2026-01-01T00:00:03.000Z",
        },
        {
          type: "assistant_message",
          text: "answer",
          timestamp: "2026-01-01T00:00:04.000Z",
        },
      ],
      hasPersistence: true,
    });
  }, 20000);
  it("keeps settings, runtime info, prompt settlement and idle safety in sync with the native agent", async () => {
    expect(await run("contract")).toEqual({
      modelCount: 2,
      info: {
        model: "claude-opus-5-5",
        modeId: "auto",
        thinkingOptionId: "high",
      },
      rejectedMode: "plan rejected",
      drainOrder: [
        "turn_started",
        "running",
        "reasoning",
        "completed",
        "turn_completed",
      ],
      features: [{ id: "agent", value: "review" }],
      turns: ["turn_started", "turn_completed"],
      idle: true,
      busy: false,
      idleAfterInterrupt: true,
      restoredInfo: { model: "claude-opus-5-5" },
    });
  }, 20000);
  it("keeps description-only previews working for other plugin providers", async () => {
    expect(await run("legacy")).toEqual([
      { firstPromptPreview: null, lastPromptPreview: "old-style preview" },
    ]);
  }, 20000);
});
