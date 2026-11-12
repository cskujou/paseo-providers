import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AntigravityUsage,
  parsePtyUsageOutput,
} from "../providers/antigravity-provider/server/usage.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const quota =
  "GEMINI MODELS\nFive Hour Limit\nRemaining: 80% (Refreshes in 1h 30m)\nWeekly Limit\nRemaining: 60%\nCLAUDE AND GPT MODELS\nFive Hour Limit\nRemaining: 40%\nWeekly Limit\nRemaining: 20%\n";
describe("Antigravity quota", () => {
  it("parses all four quota windows and reset timestamps", () => {
    const parsed = parsePtyUsageOutput(quota, Date.UTC(2026, 0, 1));
    expect(
      parsed.windows.map((window) => [window.id, window.remainingPct]),
    ).toEqual([
      ["gemini:five_hour", 80],
      ["gemini:weekly", 60],
      ["claude_gpt:five_hour", 40],
      ["claude_gpt:weekly", 20],
    ]);
    expect(parsed.windows[0]?.resetsAt).toBe("2026-01-01T01:30:00.000Z");
  });
  it("reports a failed probe rather than serving old quota as available", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-usage-test-"));
    dirs.push(home);
    const directory = path.join(home, ".gemini", "antigravity-cli");
    await mkdir(directory, { recursive: true });
    const cached = {
      tierName: "fixture",
      observedAtMs: Date.now() - 86400000,
      windows: parsePtyUsageOutput(quota).windows,
    };
    await writeFile(
      path.join(directory, "paseo-usage-cache.json"),
      JSON.stringify(cached),
    );
    const usage = new AntigravityUsage();
    usage.remember({
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      env: { HOME: home },
    });
    try {
      expect((await usage.registration().fetch({ home })).status).toBe("error");
    } finally {
      await usage.close();
    }
  });
});
