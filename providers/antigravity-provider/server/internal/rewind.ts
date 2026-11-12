import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import { AntigravityError } from "./acp-client.js";

export const RevertTokenSchema = z.object({
  version: z.literal(1),
  messageId: z.string(),
  turnIndex: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  conversationId: z
    .string()
    .regex(/^[\w-]+$/)
    .optional(),
  checkpointId: z.string().uuid().optional(),
  gitTreeSha: z.string().optional(),
  gitTopLevel: z.string().optional(),
  untrackedFiles: z.array(z.string()).optional(),
});

export type RevertToken = z.infer<typeof RevertTokenSchema>;

interface FileBackupCheckpoint {
  checkpointId: string;
  turnIndex: number;
  files: Map<string, Buffer | null>;
  modes: Map<string, number>;
  token: RevertToken;
  nativeSessionId: string;
  invalidReason: string | null;
}

const checkpointSchema = z.object({
  token: RevertTokenSchema,
  nativeSessionId: z.string().regex(/^[\w-]+$/),
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string().nullable(),
      mode: z.number().optional(),
    }),
  ),
  invalidReason: z.string().nullable(),
});

export function resolveAntigravityCliDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".gemini", "antigravity-cli");
}

export function resolveConversationDbPath(
  nativeSessionId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!/^[\w-]+$/.test(nativeSessionId))
    throw new AntigravityError(
      "Invalid Antigravity conversation ID",
      "INVALID_CONVERSATION_ID",
    );
  return path.join(
    resolveAntigravityCliDir(env),
    "conversations",
    `${nativeSessionId}.db`,
  );
}

export function resolveTranscriptDir(
  nativeSessionId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  resolveConversationDbPath(nativeSessionId, env);
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
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
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
      nextStepIndex:
        Number.isFinite(nextStepIndex) && nextStepIndex >= 0
          ? nextStepIndex
          : 0,
    };
  } finally {
    db?.close();
  }
}

async function assertSafeParent(filePath: string): Promise<void> {
  let parent = path.dirname(filePath);
  while (true) {
    try {
      if ((await realpath(parent)) !== parent)
        throw new AntigravityError(
          "File snapshot parent changed to a symlink: " + parent,
          "UNSAFE_REWIND_PATH",
        );
      return;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      const ancestor = path.dirname(parent);
      if (ancestor === parent) throw error;
      parent = ancestor;
    }
  }
}

export class SessionRewindTracker {
  private readonly checkpoints: FileBackupCheckpoint[] = [];
  private nativeSessionId: string | null = null;

  constructor(
    private readonly cwd: string,
    private readonly env: Record<string, string>,
  ) {}

  async createTurnToken(
    nativeSessionId: string,
    messageId: string,
  ): Promise<RevertToken> {
    const { userStepIndices, nextStepIndex } = await readUserStepIndices(
      nativeSessionId,
      this.env,
    );
    await this.loadCheckpoints(nativeSessionId);
    const turnIndex = Math.max(
      userStepIndices.length,
      ...this.checkpoints.map((checkpoint) => checkpoint.turnIndex + 1),
      0,
    );
    const checkpointId = randomUUID();

    const gitSnapshot = await this.captureGitSnapshot(checkpointId);
    const token: RevertToken = {
      version: 1,
      conversationId: nativeSessionId,
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
    const checkpoint: FileBackupCheckpoint = {
      checkpointId,
      turnIndex,
      files: new Map(),
      modes: new Map(),
      token,
      nativeSessionId,
      invalidReason: null,
    };
    this.checkpoints.push(checkpoint);
    await this.saveCheckpoint(checkpoint);
    return token;
  }

  async createReplayToken(
    nativeSessionId: string,
    messageId: string,
    turnIndex: number,
    preloadedUserStepIndices?: readonly number[],
  ): Promise<RevertToken | undefined> {
    await this.loadCheckpoints(nativeSessionId);
    const checkpoint = this.checkpoints.find(
      (entry) => entry.turnIndex === turnIndex,
    );
    if (checkpoint) return { ...checkpoint.token, messageId };
    const indices =
      preloadedUserStepIndices ??
      (await readUserStepIndices(nativeSessionId, this.env)).userStepIndices;
    const stepIndex = indices[turnIndex];
    if (stepIndex === undefined) return undefined;
    return {
      conversationId: nativeSessionId,
      version: 1,
      messageId,
      turnIndex,
      stepIndex,
    };
  }

  async recordFileBeforeModification(
    rawFilePath: string,
    before?: string | null,
  ): Promise<void> {
    if (!rawFilePath || this.checkpoints.length === 0) return;
    let resolved = path.isAbsolute(rawFilePath)
      ? rawFilePath
      : path.resolve(this.cwd, rawFilePath);
    try {
      resolved = path.join(
        await realpath(path.dirname(resolved)),
        path.basename(resolved),
      );
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }

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
      const info = await lstat(resolved);
      if (!info.isFile() || info.size > 10 * 1024 * 1024)
        throw new Error("File cannot be safely backed up: " + resolved);
      content =
        before === null
          ? null
          : before === undefined
            ? await readFile(resolved)
            : Buffer.from(before);
      if (content && content.length > 10 * 1024 * 1024)
        throw new Error("File backup limit exceeded");
      for (const cp of this.checkpoints)
        if (!cp.files.has(resolved)) cp.modes.set(resolved, info.mode);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        for (const cp of this.checkpoints) {
          cp.invalidReason = "File backup unavailable: " + resolved;
          await this.saveCheckpoint(cp);
        }
        return;
      }
    }

    if (before !== undefined)
      content = before === null ? null : Buffer.from(before);
    if (content && content.length > 10 * 1024 * 1024) {
      for (const checkpoint of this.checkpoints) {
        checkpoint.invalidReason = "File backup limit exceeded: " + resolved;
        await this.saveCheckpoint(checkpoint);
      }
      return;
    }
    for (const cp of this.checkpoints) {
      if (!cp.files.has(resolved)) {
        cp.files.set(resolved, content);
        await this.saveCheckpoint(cp);
      }
    }
  }

  async recordShellOperation(): Promise<void> {
    for (const checkpoint of this.checkpoints) {
      if (!checkpoint.token.gitTreeSha) {
        checkpoint.invalidReason =
          "File snapshot cannot cover shell changes outside a Git worktree";
        await this.saveCheckpoint(checkpoint);
      }
    }
  }

  async assertFileCheckpoint(token: RevertToken): Promise<void> {
    if (!token.conversationId || !token.checkpointId)
      throw new AntigravityError(
        "No file snapshot exists for this historical turn",
        "REWIND_UNAVAILABLE",
      );
    await this.loadCheckpoints(token.conversationId);
    const checkpoint = this.checkpoints.find(
      (entry) =>
        entry.checkpointId === token.checkpointId &&
        entry.turnIndex === token.turnIndex,
    );
    if (!checkpoint)
      throw new AntigravityError(
        "The file checkpoint is unavailable",
        "REWIND_UNAVAILABLE",
      );
    if (
      checkpoint.token.gitTreeSha !== token.gitTreeSha ||
      checkpoint.token.gitTopLevel !== token.gitTopLevel
    )
      throw new AntigravityError(
        "File snapshot token does not match the checkpoint",
        "INVALID_REVERT_TOKEN",
      );
    if (checkpoint.invalidReason)
      throw new AntigravityError(
        checkpoint.invalidReason,
        "REWIND_UNAVAILABLE",
      );
    if (checkpoint.token.gitTreeSha && checkpoint.token.gitTopLevel)
      await execCommand(
        "git",
        ["cat-file", "-e", checkpoint.token.gitTreeSha + "^{tree}"],
        { cwd: checkpoint.token.gitTopLevel, env: this.env, timeout: 3000 },
      );
  }

  async revertFiles(token: RevertToken): Promise<void> {
    await this.assertFileCheckpoint(token);
    const checkpoint = this.checkpoints.find(
      (entry) => entry.checkpointId === token.checkpointId,
    )!;
    if (checkpoint.token.gitTreeSha && checkpoint.token.gitTopLevel)
      await this.restoreGitSnapshot(
        checkpoint.token.gitTopLevel,
        checkpoint.token.gitTreeSha,
        checkpoint.token.untrackedFiles ?? [],
      );
    const failures: unknown[] = [];
    for (const [filePath, originalBytes] of checkpoint.files) {
      try {
        await assertSafeParent(filePath);
        if (originalBytes === null) await rm(filePath, { force: true });
        else {
          await mkdir(path.dirname(filePath), { recursive: true });
          const temporary = path.join(
            path.dirname(filePath),
            ".paseo-rewind-" + randomUUID(),
          );
          const mode = checkpoint.modes.get(filePath);
          try {
            await writeFile(temporary, originalBytes, { mode });
            if (mode !== undefined) await chmod(temporary, mode);
            await rename(temporary, filePath);
          } finally {
            await rm(temporary, { force: true });
          }
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Some Antigravity file snapshots could not be restored",
      );
    await this.discardCheckpoints(token.turnIndex);
  }

  private checkpointDirectory(nativeSessionId: string): string {
    resolveConversationDbPath(nativeSessionId, this.env);
    return path.join(
      resolveAntigravityCliDir(this.env),
      "paseo-rewind",
      nativeSessionId,
    );
  }

  private async loadCheckpoints(nativeSessionId: string): Promise<void> {
    if (this.nativeSessionId === nativeSessionId) return;
    if (this.nativeSessionId !== null)
      throw new AntigravityError(
        "Rewind tracker belongs to another conversation",
        "INVALID_REVERT_TOKEN",
      );
    const directory = this.checkpointDirectory(nativeSessionId);
    if (!existsSync(directory)) {
      this.nativeSessionId = nativeSessionId;
      return;
    }
    const loaded: FileBackupCheckpoint[] = [];
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      const saved = checkpointSchema.parse(
        JSON.parse(await readFile(path.join(directory, file), "utf8")),
      );
      if (
        saved.nativeSessionId !== nativeSessionId ||
        !saved.token.checkpointId
      )
        throw new AntigravityError(
          "Invalid file checkpoint",
          "INVALID_CHECKPOINT",
        );
      loaded.push({
        checkpointId: saved.token.checkpointId,
        turnIndex: saved.token.turnIndex,
        token: saved.token,
        nativeSessionId,
        invalidReason: saved.invalidReason,
        files: new Map(
          saved.files.map((entry) => [
            entry.path,
            entry.content === null
              ? null
              : Buffer.from(entry.content, "base64"),
          ]),
        ),
        modes: new Map(
          saved.files
            .filter((entry) => entry.mode !== undefined)
            .map((entry) => [entry.path, entry.mode!]),
        ),
      });
    }
    this.checkpoints.push(
      ...loaded.sort((left, right) => left.turnIndex - right.turnIndex),
    );
    this.nativeSessionId = nativeSessionId;
  }

  private async saveCheckpoint(
    checkpoint: FileBackupCheckpoint,
  ): Promise<void> {
    const directory = this.checkpointDirectory(checkpoint.nativeSessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, checkpoint.checkpointId + ".json");
    const temporary = file + "." + randomUUID() + ".tmp";
    const saved = {
      token: checkpoint.token,
      nativeSessionId: checkpoint.nativeSessionId,
      invalidReason: checkpoint.invalidReason,
      files: [...checkpoint.files].map(([filePath, content]) => ({
        path: filePath,
        content: content === null ? null : content.toString("base64"),
        mode: checkpoint.modes.get(filePath),
      })),
    };
    try {
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async discardCheckpoints(turnIndex: number): Promise<void> {
    for (const checkpoint of this.checkpoints.filter(
      (entry) => entry.turnIndex >= turnIndex,
    )) {
      if (checkpoint.token.gitTreeSha && checkpoint.token.gitTopLevel)
        await execCommand(
          "git",
          [
            "update-ref",
            "-d",
            "refs/paseo/antigravity/" + checkpoint.checkpointId,
            checkpoint.token.gitTreeSha,
          ],
          { cwd: checkpoint.token.gitTopLevel, env: this.env, timeout: 3000 },
        );
      await rm(
        path.join(
          this.checkpointDirectory(checkpoint.nativeSessionId),
          checkpoint.checkpointId + ".json",
        ),
        { force: true },
      );
    }
    for (let index = this.checkpoints.length - 1; index >= 0; index--)
      if (this.checkpoints[index]!.turnIndex >= turnIndex)
        this.checkpoints.splice(index, 1);
  }

  async revertConversation(
    nativeSessionId: string,
    token: RevertToken,
  ): Promise<void> {
    const dbPath = resolveConversationDbPath(nativeSessionId, this.env);
    if (token.conversationId !== nativeSessionId)
      throw new AntigravityError(
        "Rewind token belongs to another conversation",
        "INVALID_REVERT_TOKEN",
      );
    if (!existsSync(dbPath))
      throw new AntigravityError(
        "Antigravity conversation database is unavailable",
        "REWIND_UNAVAILABLE",
      );

    let cutStepIndex = token.stepIndex;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath);
      const userRows = db
        .prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC")
        .all();
      const userIndices = userRows
        .map((row) => Number(row["idx"]))
        .filter((idx) => Number.isFinite(idx) && idx >= 0);

      if (token.turnIndex >= userIndices.length)
        throw new AntigravityError(
          "Rewind target is not a user turn in this conversation",
          "INVALID_REVERT_TOKEN",
        );
      cutStepIndex = userIndices[token.turnIndex]!;

      const backupDir = path.join(
        resolveAntigravityCliDir(this.env),
        "paseo-rewind",
        nativeSessionId,
      );
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      db.prepare("VACUUM INTO ?").run(
        path.join(backupDir, "conversation-" + randomUUID() + ".db"),
      );
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

    await this.discardCheckpoints(token.turnIndex);
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
            if (
              typeof parsed.step_index === "number" &&
              parsed.step_index >= cutStepIndex
            ) {
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

  private async captureGitSnapshot(checkpointId: string): Promise<{
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
        const statePath = path.relative(
          topLevel,
          path.join(resolveAntigravityCliDir(this.env), "paseo-rewind"),
        );
        const addArgs = ["add", "-A", "--", "."];
        if (!statePath.startsWith("..") && !path.isAbsolute(statePath))
          addArgs.push(":(exclude)" + statePath);
        await execCommand("git", addArgs, {
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
        if (!/^[0-9a-f]{40,64}$/i.test(treeSha)) return null;

        const { stdout: untrackedOut } = await execCommand(
          "git",
          ["ls-files", "--others", "--exclude-standard", "-z"],
          { cwd: topLevel, env: this.env, timeout: 3000 },
        );
        const untrackedFiles = untrackedOut
          .split("\0")
          .filter((entry) => entry.length > 0);

        await execCommand(
          "git",
          ["update-ref", "refs/paseo/antigravity/" + checkpointId, treeSha],
          { cwd: topLevel, env: this.env, timeout: 3000 },
        );
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
    const tempIndex = path.join(
      os.tmpdir(),
      `paseo-agy-restore-${randomUUID()}`,
    );
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

      const { stdout: targetOut } = await execCommand(
        "git",
        ["ls-tree", "-r", "--name-only", "-z", treeSha],
        { cwd: topLevel, env: this.env, timeout: 3000 },
      );
      const targetPaths = new Set(targetOut.split("\0").filter(Boolean));
      const { stdout: trackedOut } = await execCommand(
        "git",
        ["ls-files", "-z"],
        { cwd: topLevel, env: this.env, timeout: 3000 },
      );
      for (const relPath of trackedOut.split("\0").filter(Boolean)) {
        if (!targetPaths.has(relPath)) {
          const filePath = path.resolve(topLevel, relPath);
          await assertSafeParent(filePath);
          await rm(filePath, { force: true });
        }
      }
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
          const stateDir = path.join(
            resolveAntigravityCliDir(this.env),
            "paseo-rewind",
          );
          if (absPath === stateDir || absPath.startsWith(stateDir + path.sep))
            continue;
          if (absPath.startsWith(topLevel + path.sep)) {
            await assertSafeParent(absPath);
            await rm(absPath, { recursive: true, force: true });
          }
        }
      }
    } finally {
      await rm(tempIndex, { force: true }).catch(() => undefined);
    }
  }
}
