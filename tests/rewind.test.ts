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
  readCompactionSteps,
  readConversationTurnError,
  resolveConversationDbPath,
} from "../providers/antigravity-provider/server/internal/rewind.js";

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  while (remaining >= 0x80n) {
    bytes.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return Buffer.from(bytes);
}

function encodeVarintField(field: number, value: number): Buffer {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
}

function encodeBytesField(field: number, payload: Buffer | string): Buffer {
  const buf = typeof payload === "string" ? Buffer.from(payload) : payload;
  return Buffer.concat([
    encodeVarint((field << 3) | 2),
    encodeVarint(buf.length),
    buf,
  ]);
}

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

  it("extracts terminal step_type 17 errors while ignoring internal retry hints and recovered turns", async () => {
    const { env } = await workspace();
    const dbPath = resolveConversationDbPath("fixture", env);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const internalHint = encodeBytesField(
      24,
      Buffer.concat([
        encodeBytesField(
          3,
          encodeBytesField(
            2,
            "The stream was interrupted. Please continue the task you were working on.",
          ),
        ),
        encodeVarintField(4, 1),
      ]),
    );
    const terminalProxyError = encodeBytesField(
      24,
      Buffer.concat([
        encodeBytesField(
          3,
          Buffer.concat([
            encodeBytesField(1, "Agent execution terminated due to error."),
            encodeBytesField(
              2,
              "FAILED_PRECONDITION (code 400): User location is not supported for the API use.",
            ),
            encodeVarintField(7, 400),
          ]),
        ),
        encodeVarintField(5, 1),
      ]),
    );
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB)",
    );
    const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)");
    insert.run(0, 14, 3, Buffer.alloc(0));
    insert.run(1, 17, 3, internalHint);
    expect(readConversationTurnError("fixture", 0, env)).toBeNull();
    insert.run(2, 17, 3, terminalProxyError);
    expect(readConversationTurnError("fixture", 0, env)).toEqual({
      stepIndex: 2,
      userMessage: "Agent execution terminated due to error.",
      shortError:
        "FAILED_PRECONDITION (code 400): User location is not supported for the API use.",
      httpStatus: 400,
    });
    insert.run(3, 15, 3, Buffer.alloc(0));
    expect(readConversationTurnError("fixture", 0, env)).toBeNull();
    db.close();
  });

  it("decodes compaction step_type 23 status, timestamp and preTokens from SQLite metadata", async () => {
    const { env } = await workspace();
    const dbPath = resolveConversationDbPath("fixture", env);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const metadata = Buffer.concat([
      encodeBytesField(
        1,
        Buffer.concat([
          encodeVarintField(1, 1_760_000_000),
          encodeVarintField(2, 500_000_000),
        ]),
      ),
      encodeBytesField(
        9,
        Buffer.concat([
          encodeVarintField(2, 32_000),
          encodeVarintField(5, 210_500),
        ]),
      ),
    ]);
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, metadata BLOB)",
    );
    const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)");
    insert.run(4, 23, 2, Buffer.alloc(0));
    insert.run(9, 23, 3, metadata);
    db.close();
    expect(readCompactionSteps("fixture", env)).toEqual([
      { stepIndex: 4, status: "loading" },
      {
        stepIndex: 9,
        status: "completed",
        preTokens: 242_500,
        timestamp: new Date(1_760_000_000_500).toISOString(),
      },
    ]);
  });
});
