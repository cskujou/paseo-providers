import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  SessionRewindTracker,
  resolveConversationDbPath,
} from "../providers/antigravity-provider/server/internal/rewind.js";

const directories: string[] = [];
async function workspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-rewind-test-"));
  directories.push(cwd);
  return { cwd, env: { HOME: cwd } };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("file rewind", () => {
  it("never deletes an existing file that exceeds the backup limit", async () => {
    const { cwd, env } = await workspace();
    const tracker = new SessionRewindTracker(cwd, env);
    const token = await tracker.createTurnToken("fixture", "u1");
    const file = path.join(cwd, "large.bin");
    await writeFile(file, Buffer.alloc(11 * 1024 * 1024));
    await tracker.recordFileBeforeModification(file);
    await writeFile(file, "changed");
    await expect(tracker.revertFiles(token)).rejects.toThrow(
      /backup|snapshot/i,
    );
    expect(await readFile(file, "utf8")).toBe("changed");
  });
  it("restores file checkpoints across tracker restarts", async () => {
    const { cwd, env } = await workspace();
    const file = path.join(cwd, "file.txt");
    await writeFile(file, "before");
    const first = new SessionRewindTracker(cwd, env);
    const token = await first.createTurnToken("fixture", "u1");
    await first.recordFileBeforeModification(file);
    await writeFile(file, "after");
    const restored = new SessionRewindTracker(cwd, env);
    const replay = await restored.createReplayToken(
      "fixture",
      "replayed-user",
      0,
      [0],
    );
    expect(replay?.checkpointId).toBe(token.checkpointId);
    await restored.revertFiles(replay!);
    expect(await readFile(file, "utf8")).toBe("before");
  });
  it("rejects file rewind without a persisted checkpoint", async () => {
    const { cwd, env } = await workspace();
    const tracker = new SessionRewindTracker(cwd, env);
    const token = await tracker.createReplayToken(
      "fixture",
      "old-user",
      0,
      [0],
    );
    await expect(tracker.revertFiles(token!)).rejects.toThrow(
      /checkpoint|snapshot/i,
    );
  });
  it("removes new staged files that are absent from the git snapshot", async () => {
    const { cwd, env } = await workspace();
    function git(...args: string[]) {
      return execFileSync("git", args, { cwd, encoding: "utf8" });
    }
    git("init", "-q");
    await writeFile(path.join(cwd, "base.txt"), "base");
    git("add", "base.txt");
    const tracker = new SessionRewindTracker(cwd, env);
    const token = await tracker.createTurnToken("fixture", "u1");
    await writeFile(path.join(cwd, "new.txt"), "new");
    git("add", "new.txt");
    await tracker.revertFiles(token);
    expect(existsSync(path.join(cwd, "new.txt"))).toBe(false);
    expect(await readFile(path.join(cwd, "base.txt"), "utf8")).toBe("base");
  });
  it("restores ACP oldText even if the edit reached disk before its notification", async () => {
    const { cwd, env } = await workspace();
    const tracker = new SessionRewindTracker(cwd, env);
    const token = await tracker.createTurnToken("fixture", "u1");
    const file = path.join(cwd, "file.txt");
    await writeFile(file, "already edited");
    await tracker.recordFileBeforeModification(file, "original");
    await tracker.revertFiles(token);
    expect(await readFile(file, "utf8")).toBe("original");
  });
  it("replaces a post-edit symlink without writing to its target", async () => {
    const { cwd, env } = await workspace();
    const file = path.join(cwd, "file.txt");
    const outside = path.join(cwd, "outside.txt");
    await writeFile(file, "before");
    await writeFile(outside, "untouched");
    const tracker = new SessionRewindTracker(cwd, env);
    const token = await tracker.createTurnToken("fixture", "u1");
    await tracker.recordFileBeforeModification(file);
    await rm(file);
    await symlink(outside, file);
    await tracker.revertFiles(token);
    expect(await readFile(file, "utf8")).toBe("before");
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });
  it("backs up and transactionally truncates a valid conversation", async () => {
    const { cwd, env } = await workspace();
    const dbPath = resolveConversationDbPath("fixture", env);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE steps (idx INTEGER, step_type INTEGER); INSERT INTO steps VALUES (0,14),(1,1),(2,14),(3,1)",
    );
    for (const table of [
      "gen_metadata",
      "executor_metadata",
      "parent_references",
      "battle_mode_infos",
    ])
      db.exec(
        "CREATE TABLE " +
          table +
          " (idx INTEGER); INSERT INTO " +
          table +
          " VALUES (0),(1),(2),(3)",
      );
    db.close();
    const tracker = new SessionRewindTracker(cwd, env);
    const token = await tracker.createReplayToken("fixture", "u2", 1, [0, 2]);
    await tracker.revertConversation("fixture", token!);
    const restored = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        restored.prepare("SELECT idx FROM steps ORDER BY idx").all(),
      ).toEqual([{ idx: 0 }, { idx: 1 }]);
    } finally {
      restored.close();
    }
    const backupDir = path.join(
      env.HOME,
      ".gemini",
      "antigravity-cli",
      "paseo-rewind",
      "fixture",
    );
    const files = await readdir(backupDir);
    expect(files.filter((file) => file.endsWith(".db"))).toHaveLength(1);
  });
  it("refuses a token from another conversation", async () => {
    const { cwd, env } = await workspace();
    const tracker = new SessionRewindTracker(cwd, env);
    const token = await tracker.createTurnToken("fixture", "u1");
    await expect(tracker.revertConversation("other", token)).rejects.toThrow(
      /conversation/i,
    );
  });
});
