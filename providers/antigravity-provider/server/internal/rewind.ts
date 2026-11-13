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
import { AntigravityError } from "./diagnostics.js";

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

export function hasConversationDb(
  nativeSessionId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return existsSync(resolveConversationDbPath(nativeSessionId, env));
}

export interface ConversationTurnError {
  stepIndex: number;
  userMessage: string;
  shortError?: string;
  fullError?: string;
  details?: string;
  httpStatus?: number;
}

export interface CompactionStepInfo {
  stepIndex: number;
  status: "loading" | "completed";
  preTokens?: number;
  timestamp?: string;
}

type ProtoField =
  | { field: number; wireType: 0; value: number }
  | { field: number; wireType: 2; bytes: Uint8Array };

function readProtoFields(buffer: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  const readVarint = (): bigint | null => {
    let result = 0n;
    let shift = 0n;
    while (offset < buffer.length) {
      const byte = buffer[offset++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) return null;
    }
    return null;
  };
  while (offset < buffer.length) {
    const tag = readVarint();
    if (tag === null || tag <= 0n) break;
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (wireType === 0) {
      const value = readVarint();
      if (value === null) break;
      fields.push({ field, wireType: 0, value: Number(value) });
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) break;
      offset += 8;
    } else if (wireType === 2) {
      const lengthBig = readVarint();
      if (lengthBig === null || lengthBig < 0n) break;
      const length = Number(lengthBig);
      if (!Number.isSafeInteger(length) || offset + length > buffer.length)
        break;
      fields.push({
        field,
        wireType: 2,
        bytes: buffer.subarray(offset, offset + length),
      });
      offset += length;
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) break;
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

function protoString(
  fields: readonly ProtoField[],
  fieldNumber: number,
): string | undefined {
  const entry = fields.find(
    (item): item is Extract<ProtoField, { wireType: 2 }> =>
      item.wireType === 2 && item.field === fieldNumber,
  );
  if (!entry) return undefined;
  const decoded = Buffer.from(
    entry.bytes.buffer,
    entry.bytes.byteOffset,
    entry.bytes.byteLength,
  ).toString("utf8");
  return decoded.trim() ? decoded : undefined;
}

function protoVarint(
  fields: readonly ProtoField[],
  fieldNumber: number,
): number | undefined {
  const entry = fields.find(
    (item): item is Extract<ProtoField, { wireType: 0 }> =>
      item.wireType === 0 && item.field === fieldNumber,
  );
  return entry?.value;
}

function protoMessage(
  fields: readonly ProtoField[],
  fieldNumber: number,
): ProtoField[] | undefined {
  const entry = fields.find(
    (item): item is Extract<ProtoField, { wireType: 2 }> =>
      item.wireType === 2 && item.field === fieldNumber,
  );
  return entry ? readProtoFields(entry.bytes) : undefined;
}

function parseStepMetadata(raw: unknown): {
  timestamp?: string;
  preTokens?: number;
} {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0) return {};
  const meta = readProtoFields(raw);
  const created = protoMessage(meta, 1);
  const seconds = created ? protoVarint(created, 1) : undefined;
  const nanos = created ? (protoVarint(created, 2) ?? 0) : 0;
  const timestamp =
    seconds !== undefined && Number.isFinite(seconds) && seconds > 0
      ? new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString()
      : undefined;
  const usage = protoMessage(meta, 9);
  const uncachedInput = usage ? (protoVarint(usage, 2) ?? 0) : 0;
  const cachedInput = usage ? (protoVarint(usage, 5) ?? 0) : 0;
  const totalInput = uncachedInput + cachedInput;
  return {
    ...(timestamp ? { timestamp } : {}),
    ...(Number.isFinite(totalInput) && totalInput > 0
      ? { preTokens: totalInput }
      : {}),
  };
}

function parseStepErrorPayload(
  stepIndex: number,
  raw: unknown,
): ConversationTurnError | null {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0) return null;
  const top = readProtoFields(raw);
  const errorStep = protoMessage(top, 24);
  if (!errorStep) return null;
  const isInternal = protoVarint(errorStep, 4) === 1;
  const shouldShowUser = protoVarint(errorStep, 5) === 1;
  const info = protoMessage(errorStep, 3);
  const userMessage = info ? protoString(info, 1) : undefined;
  if (isInternal && !shouldShowUser && !userMessage) return null;
  const shortError = info
    ? (protoString(info, 2) ?? protoString(info, 9))
    : undefined;
  const fullError = info ? protoString(info, 3) : undefined;
  const details = info ? protoString(info, 5) : undefined;
  const httpStatus = info ? protoVarint(info, 7) : undefined;
  if (!shouldShowUser && !userMessage && !shortError) return null;
  return {
    stepIndex,
    userMessage: userMessage ?? "Agent execution terminated due to error.",
    ...(shortError ? { shortError } : {}),
    ...(fullError ? { fullError } : {}),
    ...(details ? { details } : {}),
    ...(httpStatus !== undefined && httpStatus > 0 ? { httpStatus } : {}),
  };
}

export function readConversationTurnError(
  nativeSessionId: string,
  minStepIndex: number,
  env: Record<string, string | undefined> = process.env,
): ConversationTurnError | null {
  const dbPath = resolveConversationDbPath(nativeSessionId, env);
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
    const rows = db
      .prepare(
        "SELECT idx, step_type, status, step_payload FROM steps WHERE idx >= ? ORDER BY idx DESC",
      )
      .all(minStepIndex);
    for (const row of rows) {
      const stepType = Number(row["step_type"]);
      const status = Number(row["status"]);
      if (stepType === 15 && status === 3) return null;
      if (stepType === 17) {
        const parsed = parseStepErrorPayload(
          Number(row["idx"]),
          row["step_payload"],
        );
        if (parsed) return parsed;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function readCompactionSteps(
  nativeSessionId: string,
  env: Record<string, string | undefined> = process.env,
  minStepIndex = 0,
): CompactionStepInfo[] {
  const dbPath = resolveConversationDbPath(nativeSessionId, env);
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
    const rows = db
      .prepare(
        "SELECT idx, status, metadata FROM steps WHERE step_type = 23 AND idx >= ? ORDER BY idx ASC",
      )
      .all(minStepIndex);
    const items: CompactionStepInfo[] = [];
    for (const row of rows) {
      const stepIndex = Number(row["idx"]);
      const statusCode = Number(row["status"]);
      if (!Number.isFinite(stepIndex) || stepIndex < 0) continue;
      if (statusCode !== 1 && statusCode !== 2 && statusCode !== 3) continue;
      const meta = parseStepMetadata(row["metadata"]);
      items.push({
        stepIndex,
        status: statusCode === 3 ? "completed" : "loading",
        ...meta,
      });
    }
    return items;
  } catch {
    return [];
  } finally {
    db?.close();
  }
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
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
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

    const targetCheckpoints: FileBackupCheckpoint[] = [];
    for (const cp of this.checkpoints) {
      if (cp.files.has(resolved)) continue;
      if (
        before === undefined &&
        cp.token.gitTreeSha &&
        cp.token.gitTopLevel &&
        resolved.startsWith(cp.token.gitTopLevel + path.sep) &&
        !(await this.isGitIgnored(cp.token.gitTopLevel, resolved))
      ) {
        continue;
      }
      targetCheckpoints.push(cp);
    }
    if (targetCheckpoints.length === 0) return;

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
      for (const cp of targetCheckpoints) cp.modes.set(resolved, info.mode);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        for (const cp of targetCheckpoints) {
          cp.invalidReason = "File backup unavailable: " + resolved;
          await this.saveCheckpoint(cp);
        }
        return;
      }
    }

    if (before !== undefined)
      content = before === null ? null : Buffer.from(before);
    if (content && content.length > 10 * 1024 * 1024) {
      for (const checkpoint of targetCheckpoints) {
        checkpoint.invalidReason = "File backup limit exceeded: " + resolved;
        await this.saveCheckpoint(checkpoint);
      }
      return;
    }
    for (const cp of targetCheckpoints) {
      cp.files.set(resolved, content);
      await this.saveCheckpoint(cp);
    }
  }

  private async isGitIgnored(
    topLevel: string,
    resolvedPath: string,
  ): Promise<boolean> {
    try {
      await execCommand(
        "git",
        ["check-ignore", "-q", "--", path.relative(topLevel, resolvedPath)],
        { cwd: topLevel, env: this.env, timeout: 2000 },
      );
      return true;
    } catch {
      return false;
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

  async revertAttemptConversation(
    nativeSessionId: string,
    token: RevertToken,
  ): Promise<void> {
    await this.truncateConversation(nativeSessionId, token, true);
  }

  async revertConversation(
    nativeSessionId: string,
    token: RevertToken,
  ): Promise<void> {
    await this.truncateConversation(nativeSessionId, token, false);
  }

  private async truncateConversation(
    nativeSessionId: string,
    token: RevertToken,
    allowMissingUserTurn: boolean,
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
    let shouldDeleteDbRows = false;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { timeout: 2000 });
      const userRows = db
        .prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC")
        .all();
      const userIndices = userRows
        .map((row) => Number(row["idx"]))
        .filter((idx) => Number.isFinite(idx) && idx >= 0);

      if (token.turnIndex < userIndices.length) {
        cutStepIndex = userIndices[token.turnIndex]!;
        shouldDeleteDbRows = true;
      } else if (!allowMissingUserTurn) {
        throw new AntigravityError(
          "Rewind target is not a user turn in this conversation",
          "INVALID_REVERT_TOKEN",
        );
      } else {
        const maxRow = db.prepare("SELECT MAX(idx) AS maxIdx FROM steps").get();
        const maxIdx =
          maxRow?.["maxIdx"] === null || maxRow?.["maxIdx"] === undefined
            ? -1
            : Number(maxRow["maxIdx"]);
        shouldDeleteDbRows = Number.isFinite(maxIdx) && maxIdx >= cutStepIndex;
      }

      if (shouldDeleteDbRows) {
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
        const cliDirRel = path.relative(
          topLevel,
          resolveAntigravityCliDir(this.env),
        );
        const addArgs = ["add", "-A", "--", "."];
        if (!cliDirRel.startsWith("..") && !path.isAbsolute(cliDirRel))
          addArgs.push(":(exclude)" + cliDirRel);
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
          const cliDir = resolveAntigravityCliDir(this.env);
          if (absPath === cliDir || absPath.startsWith(cliDir + path.sep))
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
