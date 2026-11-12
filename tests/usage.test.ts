import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  it("runs quota collection in the account home rather than inheriting the daemon project", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-quota-home-"));
    dirs.push(home);
    const usage = new AntigravityUsage();
    usage.remember({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./fixtures/quota-cli.mjs", import.meta.url)),
      ],
      env: { HOME: home },
    });
    try {
      const report = await usage.registration().fetch({ home });
      expect(report.status).toBe("available");
      if (report.status !== "available")
        throw new Error("Quota collection failed");
      expect(report.windows.map((window) => window.remainingPct)).toEqual([
        80, 60, 40, 20,
      ]);
      expect(await readFile(path.join(home, "quota-cwd.txt"), "utf8")).toBe(
        home,
      );
      expect(
        await readFile(path.join(home, "quota-input.txt"), "utf8"),
      ).toContain("/usage\r");
    } finally {
      await usage.close();
    }
  });
  it("reports workspace trust as its own failure and does not automatically trust a directory", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-quota-trust-"));
    dirs.push(home);
    const usage = new AntigravityUsage();
    usage.remember({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./fixtures/quota-cli.mjs", import.meta.url)),
      ],
      env: { HOME: home, QUOTA_FIXTURE_TRUST: "1" },
    });
    try {
      const report = await usage.registration().fetch({ home });
      expect(report).toMatchObject({
        status: "error",
        error: expect.stringContaining("trust approval"),
      });
      expect(existsSync(path.join(home, "quota-input.txt"))).toBe(false);
    } finally {
      await usage.close();
    }
  });

  it("reports unknown quota format separately from CLI startup and trust failures", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-quota-format-"));
    dirs.push(home);
    const usage = new AntigravityUsage();
    usage.remember({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./fixtures/quota-cli.mjs", import.meta.url)),
      ],
      env: { HOME: home, QUOTA_FIXTURE_UNKNOWN: "1" },
    });
    try {
      expect(await usage.registration().fetch({ home })).toMatchObject({
        status: "error",
        error: expect.stringContaining("output format may have changed"),
      });
    } finally {
      await usage.close();
    }
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
      expect(await usage.registration().fetch({ home })).toMatchObject({
        status: "error",
        error: expect.stringContaining("did not reach the /usage prompt"),
      });
    } finally {
      await usage.close();
    }
  });
});
