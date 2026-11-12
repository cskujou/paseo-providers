import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";

// @types/node@20 predates node:sqlite typings; declare the slice we use.
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint };
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (filePath: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

let cachedSqlite: NodeSqliteModule | null = null;
async function loadSqlite(): Promise<NodeSqliteModule | null> {
  if (cachedSqlite) return cachedSqlite;
  const specifier: string = "node:sqlite";
  try {
    cachedSqlite = (await import(specifier)) as unknown as NodeSqliteModule;
    return cachedSqlite;
  } catch {
    return null;
  }
}

export const RevertTokenSchema = z.object({
  version: z.literal(1),
  messageId: z.string(),
  turnIndex: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  checkpointId: z.string().optional(),
  gitTreeSha: z.string().optional(),
  gitTopLevel: z.string().optional(),
  untrackedFiles: z.array(z.string()).optional(),
});

export type RevertToken = z.infer<typeof RevertTokenSchema>;

interface FileBackupCheckpoint {
  checkpointId: string;
  turnIndex: number;
  files: Map<string, Buffer | null>;
}

export function resolveAntigravityCliDir(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".gemini", "antigravity-cli");
}

export function resolveConversationDbPath(
  nativeSessionId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveAntigravityCliDir(env), "conversations", `${nativeSessionId}.db`);
}

export function resolveTranscriptDir(
  nativeSessionId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(
    resolveAntigravityCliDir(env),
    "brain",
    nativeSessionId,
    ".system_generated",
    "logs",
  );
}

export async function readUserStepIndices(
  nativeSessionId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ userStepIndices: number[]; nextStepIndex: number }> {
  const dbPath = resolveConversationDbPath(nativeSessionId, env);
  if (!existsSync(dbPath)) {
    return { userStepIndices: [], nextStepIndex: 0 };
  }
  const sqlite = await loadSqlite();
  if (!sqlite) {
    return { userStepIndices: [], nextStepIndex: 0 };
  }
  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC")
      .all();
    const userStepIndices = rows
      .map((row) => Number(row["idx"]))
      .filter((idx) => Number.isFinite(idx) && idx >= 0);
    const maxRow = db
      .prepare("SELECT COALESCE(MAX(idx) + 1, 0) AS nextIdx FROM steps")
      .get();
    const nextStepIndex = Number(maxRow?.["nextIdx"] ?? 0);
    return {
      userStepIndices,
      nextStepIndex: Number.isFinite(nextStepIndex) && nextStepIndex >= 0 ? nextStepIndex : 0,
    };
  } catch {
    return { userStepIndices: [], nextStepIndex: 0 };
  } finally {
    db?.close();
  }
}

export class SessionRewindTracker {
  private readonly checkpoints: FileBackupCheckpoint[] = [];

  constructor(
    private readonly cwd: string,
    private readonly env: Record<string, string>,
  ) {}

  async createTurnToken(nativeSessionId: string, messageId: string): Promise<RevertToken> {
    const { userStepIndices, nextStepIndex } = await readUserStepIndices(
      nativeSessionId,
      this.env,
    );
    const turnIndex = userStepIndices.length;
    const checkpointId = randomUUID();
    this.checkpoints.push({
      checkpointId,
      turnIndex,
      files: new Map(),
    });

    const gitSnapshot = await this.captureGitSnapshot();
    return {
      version: 1,
      messageId,
      turnIndex,
      stepIndex: nextStepIndex,
      checkpointId,
      ...(gitSnapshot
        ? {
            gitTreeSha: gitSnapshot.treeSha,
            gitTopLevel: gitSnapshot.topLevel,
            untrackedFiles: gitSnapshot.untrackedFiles,
          }
        : {}),
    };
  }

  async createReplayToken(
    nativeSessionId: string,
    messageId: string,
    turnIndex: number,
    preloadedUserStepIndices?: readonly number[],
  ): Promise<RevertToken> {
    const indices =
      preloadedUserStepIndices ??
      (await readUserStepIndices(nativeSessionId, this.env)).userStepIndices;
    const stepIndex = indices[turnIndex] ?? 0;
    return {
      version: 1,
      messageId,
      turnIndex,
      stepIndex,
    };
  }

  async recordFileBeforeModification(rawFilePath: string): Promise<void> {
    if (!rawFilePath || this.checkpoints.length === 0) return;
    const resolved = path.isAbsolute(rawFilePath)
      ? rawFilePath
      : path.resolve(this.cwd, rawFilePath);

    let needsRead = false;
    for (const cp of this.checkpoints) {
      if (!cp.files.has(resolved)) {
        needsRead = true;
        break;
      }
    }
    if (!needsRead) return;

    let content: Buffer | null = null;
    try {
      const info = await stat(resolved);
      if (info.isFile() && info.size <= 10 * 1024 * 1024) {
        content = await readFile(resolved);
      }
    } catch {
      content = null;
    }

    for (const cp of this.checkpoints) {
      if (!cp.files.has(resolved)) {
        cp.files.set(resolved, content);
      }
    }
  }

  async revertFiles(token: RevertToken): Promise<void> {
    const matchingIndex = this.checkpoints.findIndex(
      (cp) =>
        (token.checkpointId && cp.checkpointId === token.checkpointId) ||
        cp.turnIndex >= token.turnIndex,
    );
    let restoredViaBackup = false;
    if (matchingIndex !== -1) {
      const targetCheckpoint = this.checkpoints[matchingIndex]!;
      for (const [filePath, originalBytes] of targetCheckpoint.files.entries()) {
        try {
          if (originalBytes === null) {
            await unlink(filePath).catch(() => undefined);
          } else {
            await mkdir(path.dirname(filePath), { recursive: true });
            await writeFile(filePath, originalBytes);
          }
          restoredViaBackup = true;
        } catch {
          // Continue restoring remaining files
        }
      }
      this.checkpoints.splice(matchingIndex);
    }

    if (token.gitTreeSha && token.gitTopLevel) {
      await this.restoreGitSnapshot(
        token.gitTopLevel,
        token.gitTreeSha,
        token.untrackedFiles ?? [],
      );
      return;
    }

    if (!restoredViaBackup && !token.gitTreeSha) {
      return;
    }
  }

  async revertConversation(nativeSessionId: string, token: RevertToken): Promise<void> {
    const dbPath = resolveConversationDbPath(nativeSessionId, this.env);
    if (!existsSync(dbPath)) {
      return;
    }
    const sqlite = await loadSqlite();
    if (!sqlite) {
      throw new Error("Node SQLite runtime is required to rewind Antigravity conversation state");
    }

    let cutStepIndex = token.stepIndex;
    let db: SqliteDatabase | undefined;
    try {
      db = new sqlite.DatabaseSync(dbPath);
      const userRows = db
        .prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC")
        .all();
      const userIndices = userRows
        .map((row) => Number(row["idx"]))
        .filter((idx) => Number.isFinite(idx) && idx >= 0);

      if (token.turnIndex >= 0 && token.turnIndex < userIndices.length) {
        cutStepIndex = userIndices[token.turnIndex]!;
      }

      db.exec("BEGIN IMMEDIATE");
      try {
        for (const table of [
          "steps",
          "gen_metadata",
          "executor_metadata",
          "parent_references",
          "battle_mode_infos",
        ]) {
          db.prepare(`DELETE FROM ${table} WHERE idx >= ?`).run(cutStepIndex);
        }
        db.exec("COMMIT");
      } catch (innerError) {
        db.exec("ROLLBACK");
        throw innerError;
      }
    } finally {
      db?.close();
    }

    const logsDir = resolveTranscriptDir(nativeSessionId, this.env);
    for (const fileName of ["transcript.jsonl", "transcript_full.jsonl"]) {
      const transcriptPath = path.join(logsDir, fileName);
      if (!existsSync(transcriptPath)) continue;
      try {
        const raw = await readFile(transcriptPath, "utf8");
        const keptLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { step_index?: number };
            if (typeof parsed.step_index === "number" && parsed.step_index >= cutStepIndex) {
              continue;
            }
            keptLines.push(line);
          } catch {
            keptLines.push(line);
          }
        }
        await writeFile(
          transcriptPath,
          keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "",
          "utf8",
        );
      } catch {
        // Non-fatal if transcript log doesn't exist or isn't writable
      }
    }
  }

  private async captureGitSnapshot(): Promise<{
    topLevel: string;
    treeSha: string;
    untrackedFiles: string[];
  } | null> {
    try {
      const { stdout: topOut } = await execCommand(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd: this.cwd, env: this.env, timeout: 2000 },
      );
      const topLevel = topOut.trim();
      if (!topLevel || !existsSync(topLevel)) return null;

      const { stdout: gitDirOut } = await execCommand(
        "git",
        ["rev-parse", "--git-dir"],
        { cwd: topLevel, env: this.env, timeout: 2000 },
      );
      const gitDir = path.resolve(topLevel, gitDirOut.trim());
      const realIndex = path.join(gitDir, "index");
      const tempIndex = path.join(os.tmpdir(), `paseo-agy-idx-${randomUUID()}`);

      try {
        if (existsSync(realIndex)) {
          await copyFile(realIndex, tempIndex);
        }
        const gitEnv = { ...this.env, GIT_INDEX_FILE: tempIndex };
        await execCommand("git", ["add", "-A"], {
          cwd: topLevel,
          env: gitEnv,
          timeout: 4000,
        });
        const { stdout: treeOut } = await execCommand("git", ["write-tree"], {
          cwd: topLevel,
          env: gitEnv,
          timeout: 3000,
        });
        const treeSha = treeOut.trim();
        if (!/^[0-9a-f]{40}$/i.test(treeSha)) return null;

        const { stdout: untrackedOut } = await execCommand(
          "git",
          ["ls-files", "--others", "--exclude-standard", "-z"],
          { cwd: topLevel, env: this.env, timeout: 3000 },
        );
        const untrackedFiles = untrackedOut
          .split("\0")
          .filter((entry) => entry.length > 0);

        return { topLevel, treeSha, untrackedFiles };
      } finally {
        await rm(tempIndex, { force: true }).catch(() => undefined);
      }
    } catch {
      return null;
    }
  }

  private async restoreGitSnapshot(
    topLevel: string,
    treeSha: string,
    allowedUntrackedFiles: readonly string[],
  ): Promise<void> {
    const tempIndex = path.join(os.tmpdir(), `paseo-agy-restore-${randomUUID()}`);
    try {
      const gitEnv = { ...this.env, GIT_INDEX_FILE: tempIndex };
      await execCommand("git", ["read-tree", treeSha], {
        cwd: topLevel,
        env: gitEnv,
        timeout: 4000,
      });
      await execCommand("git", ["checkout-index", "-a", "-f"], {
        cwd: topLevel,
        env: gitEnv,
        timeout: 5000,
      });

      const allowedSet = new Set(allowedUntrackedFiles);
      const { stdout: currentUntrackedOut } = await execCommand(
        "git",
        ["ls-files", "--others", "--exclude-standard", "-z"],
        { cwd: topLevel, env: this.env, timeout: 3000 },
      );
      const currentUntracked = currentUntrackedOut
        .split("\0")
        .filter((entry) => entry.length > 0);
      for (const relPath of currentUntracked) {
        if (!allowedSet.has(relPath)) {
          const absPath = path.resolve(topLevel, relPath);
          if (absPath.startsWith(topLevel)) {
            await rm(absPath, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }
    } finally {
      await rm(tempIndex, { force: true }).catch(() => undefined);
    }
  }
}
