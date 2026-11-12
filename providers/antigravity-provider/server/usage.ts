import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { execCommand, type UsageSourceRegistration } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  type UsageAccount,
  type UsageDetail,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { AcpClient } from "./internal/acp-client.js";

const usageInputSchema = z
  .object({
    home: z.string().min(1),
  })
  .strict();

interface QuotaWindowSnapshot {
  id: string;
  label: string;
  shortLabel: string;
  usedPct: number;
  remainingPct: number;
  resetsAt: string | null;
  note: string | null;
}

interface CachedUsageSnapshot {
  email?: string;
  tierName?: string;
  tierId?: string;
  observedAtMs: number;
  windows: QuotaWindowSnapshot[];
}

const PTY_USAGE_PYTHON_SCRIPT = `
import pty, os, time, select, sys, fcntl, struct, termios, signal

cmd = sys.argv[1:]
if not cmd:
    cmd = ["agy"]

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(cmd[0], cmd)
else:
    winsize = struct.pack("HHHH", 80, 120, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    out = b""
    start = time.time()
    stage = 0
    stage_time = start
    while time.time() - start < 14.0:
        r, _, _ = select.select([fd], [], [], 0.15)
        if r:
            try:
                data = os.read(fd, 8192)
                if not data:
                    break
                out += data
            except OSError:
                break
        now = time.time()
        if stage == 0 and (b"for shortcuts" in out or now - start > 3.5):
            os.write(fd, b"\\x1b")
            stage = 1
            stage_time = now
        elif stage == 1 and now - stage_time > 0.35:
            os.write(fd, b"/usage")
            stage = 2
            stage_time = now
        elif stage == 2 and now - stage_time > 0.35:
            os.write(fd, b"\\r")
            stage = 3
            stage_time = now
        elif stage == 3:
            tail = out.split(b"CLAUDE AND GPT MODELS")[-1] if b"CLAUDE AND GPT MODELS" in out else b""
            if (b"Quota available" in tail or tail.count(b"%") >= 2) or (now - stage_time > 3.5):
                if now - stage_time > 0.6:
                    break
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    sys.stdout.write(out.decode("utf-8", "replace"))
`;

function resolveHome(env?: Record<string, string | undefined>): string {
  return env?.HOME || env?.USERPROFILE || os.homedir();
}

function cacheFilePath(home: string): string {
  return path.join(home, ".gemini", "antigravity-cli", "paseo-usage-cache.json");
}

function hasAntigravityState(home: string): boolean {
  return (
    existsSync(path.join(home, ".gemini", "antigravity-cli")) ||
    existsSync(path.join(home, ".gemini", "antigravity"))
  );
}

function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;:?]*m/g, "")
    .replace(/\x1b\[\d*C/g, " ")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function parseRefreshDurationMs(note: string | null): number | null {
  if (!note) return null;
  const match = /Refreshes\s+in\s+(.+)/i.exec(note);
  if (!match) return null;
  const body = match[1]!;
  let totalMs = 0;
  let matchedAny = false;
  for (const [regex, unitMs] of [
    [/(\d+)\s*d(?:ays?)?\b/i, 86400_000],
    [/(\d+)\s*h(?:ours?|r|rs)?\b/i, 3600_000],
    [/(\d+)\s*m(?:in(?:ute)?s?)?\b/i, 60_000],
    [/(\d+)\s*s(?:ec(?:ond)?s?)?\b/i, 1_000],
  ] as const) {
    const m = regex.exec(body);
    if (m) {
      totalMs += Number(m[1]) * unitMs;
      matchedAny = true;
    }
  }
  return matchedAny && totalMs > 0 ? totalMs : null;
}

export function parsePtyUsageOutput(
  rawOutput: string,
  observedAtMs = Date.now(),
): { email?: string; tierName?: string; windows: QuotaWindowSnapshot[] } {
  const clean = stripAnsi(rawOutput);
  const lines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let email: string | undefined;
  let tierName: string | undefined;
  let currentGroup: "gemini" | "claude_gpt" | null = null;
  let currentPeriod: "weekly" | "five_hour" | null = null;
  let lastWindowId: string | null = null;
  const byId = new Map<string, QuotaWindowSnapshot>();

  for (const line of lines) {
    const accountMatch = /Account:\s*([^\s]+@[^\s]+)/i.exec(line);
    if (accountMatch) {
      email = accountMatch[1]!.trim();
    }

    const tierMatch = /\((Google AI [^)\r\n]+)\)/i.exec(line);
    if (tierMatch) {
      tierName = tierMatch[1]!.trim();
    }

    if (/GEMINI\s+MODELS/i.test(line)) {
      currentGroup = "gemini";
      currentPeriod = null;
      lastWindowId = null;
      continue;
    }
    if (/CLAUDE\s+AND\s+GPT\s+MODELS/i.test(line)) {
      currentGroup = "claude_gpt";
      currentPeriod = null;
      lastWindowId = null;
      continue;
    }

    if (/Weekly\s+Limit/i.test(line)) {
      currentPeriod = "weekly";
      lastWindowId = null;
      continue;
    }
    if (/Five\s+Hour\s+Limit/i.test(line)) {
      currentPeriod = "five_hour";
      lastWindowId = null;
      continue;
    }

    const pctMatch = /(?:Remaining:\s*)?(\d+(?:\.\d+)?)%\s*(?:\(([^)]+)\))?/i.exec(line);
    if (pctMatch && currentGroup && currentPeriod) {
      const remainingPct = Number(Number(pctMatch[1]).toFixed(2));
      const usedPct = Number(Math.max(0, 100 - remainingPct).toFixed(2));
      const inlineNote = pctMatch[2]?.trim() ?? null;
      const refreshMs = parseRefreshDurationMs(inlineNote);
      const resetsAt =
        refreshMs !== null ? new Date(observedAtMs + refreshMs).toISOString() : null;

      const groupLabel = currentGroup === "gemini" ? "Gemini" : "Claude & GPT";
      const groupShort = currentGroup === "gemini" ? "Gemini" : "Claude/GPT";
      const periodLabel = currentPeriod === "five_hour" ? "5-hour" : "Weekly";
      const periodShort = currentPeriod === "five_hour" ? "5h" : "wk";
      const id = `${currentGroup}:${currentPeriod}`;

      byId.set(id, {
        id,
        label: `${groupLabel} · ${periodLabel}`,
        shortLabel: `${groupShort} ${periodShort}`,
        usedPct,
        remainingPct,
        resetsAt,
        note: inlineNote,
      });
      lastWindowId = id;
      currentPeriod = null;
      continue;
    }

    if (lastWindowId) {
      const noteMatch = /^(Refreshes\s+in\s+[0-9dhms\s]+|Quota\s+available)/i.exec(line);
      if (noteMatch) {
        const win = byId.get(lastWindowId);
        if (win) {
          const note = noteMatch[1]!.trim();
          const refreshMs = parseRefreshDurationMs(note);
          win.note = note;
          if (refreshMs !== null) {
            win.resetsAt = new Date(observedAtMs + refreshMs).toISOString();
          }
        }
        lastWindowId = null;
      }
    }
  }

  const orderedIds = [
    "gemini:five_hour",
    "gemini:weekly",
    "claude_gpt:five_hour",
    "claude_gpt:weekly",
  ];
  const windows: QuotaWindowSnapshot[] = [];
  for (const id of orderedIds) {
    const win = byId.get(id);
    if (win) windows.push(win);
  }
  for (const [id, win] of byId.entries()) {
    if (!orderedIds.includes(id)) windows.push(win);
  }

  return { email, tierName, windows };
}

export class AntigravityUsage {
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly memoryCache = new Map<string, CachedUsageSnapshot>();
  private readonly inflightProbes = new Map<string, Promise<CachedUsageSnapshot>>();

  remember(launch: ProviderLaunch): { home: string } {
    const home = resolveHome(launch.env);
    this.launches.set(home, launch);
    return { home };
  }

  recordTier(
    env: Record<string, string | undefined>,
    tierName?: string,
    tierId?: string,
  ): void {
    if (!tierName) return;
    const home = resolveHome(env);
    const existing = this.memoryCache.get(home);
    const updated: CachedUsageSnapshot = {
      email: existing?.email,
      tierName,
      tierId: tierId ?? existing?.tierId,
      observedAtMs: existing?.observedAtMs ?? 0,
      windows: existing?.windows ?? [],
    };
    this.memoryCache.set(home, updated);
    void this.saveDiskCache(home, updated);
  }

  close(): void {
    this.launches.clear();
  }

  private async loadDiskCache(home: string): Promise<CachedUsageSnapshot | null> {
    const mem = this.memoryCache.get(home);
    if (mem && mem.windows.length > 0) return mem;
    const file = cacheFilePath(home);
    if (!existsSync(file)) return mem ?? null;
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as CachedUsageSnapshot;
      if (raw && typeof raw === "object" && Array.isArray(raw.windows)) {
        const merged: CachedUsageSnapshot = {
          email: raw.email ?? mem?.email,
          tierName: mem?.tierName ?? raw.tierName,
          tierId: mem?.tierId ?? raw.tierId,
          observedAtMs: typeof raw.observedAtMs === "number" ? raw.observedAtMs : 0,
          windows: raw.windows,
        };
        this.memoryCache.set(home, merged);
        return merged;
      }
    } catch {
      // Ignore corrupt cache
    }
    return mem ?? null;
  }

  private async saveDiskCache(home: string, snapshot: CachedUsageSnapshot): Promise<void> {
    const file = cacheFilePath(home);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(snapshot, null, 2), "utf8");
    } catch {
      // Non-fatal
    }
  }

  private resolveLaunchForHome(home: string): ProviderLaunch {
    const remembered = this.launches.get(home);
    if (remembered) return remembered;
    const candidates = [
      path.join(home, ".local", "bin", "agy"),
      "/root/.local/bin/agy",
      "/usr/local/bin/agy",
    ];
    const command = candidates.find((c) => existsSync(c)) ?? "agy";
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") baseEnv[k] = v;
    }
    baseEnv.HOME = home;
    return { command, args: [], env: baseEnv };
  }

  private async probeTierViaAcp(launch: ProviderLaunch): Promise<{
    tierName?: string;
    tierId?: string;
  }> {
    const client = new AcpClient({
      launch,
      cwd: os.tmpdir(),
      startupTimeoutMs: 8000,
    });
    try {
      await client.initialize();
      const res = await client.request<Record<string, unknown>>(
        "session/new",
        { cwd: os.tmpdir(), mcpServers: [] },
        8000,
      );
      const sessionId = typeof res.sessionId === "string" ? res.sessionId : undefined;
      if (sessionId) {
        await client.request("session/close", { sessionId }, 2000).catch(() => undefined);
      }
      const meta =
        typeof res._meta === "object" && res._meta !== null
          ? (res._meta as Record<string, unknown>)
          : undefined;
      const agyMeta =
        meta && typeof meta.antigravity === "object" && meta.antigravity !== null
          ? (meta.antigravity as Record<string, unknown>)
          : undefined;
      const tier =
        agyMeta && typeof agyMeta.tier === "object" && agyMeta.tier !== null
          ? (agyMeta.tier as Record<string, unknown>)
          : undefined;
      return {
        tierName: typeof tier?.name === "string" ? tier.name : undefined,
        tierId: typeof tier?.id === "string" ? tier.id : undefined,
      };
    } catch {
      return {};
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async probeLiveUsage(home: string): Promise<CachedUsageSnapshot> {
    const inflight = this.inflightProbes.get(home);
    if (inflight) return inflight;

    const promise = (async (): Promise<CachedUsageSnapshot> => {
      const prior = await this.loadDiskCache(home);
      const now = Date.now();
      if (prior && prior.windows.length > 0 && now - prior.observedAtMs < 15_000) {
        return prior;
      }

      const launch = this.resolveLaunchForHome(home);
      const ptyResult = await execCommand(
        "python3",
        ["-c", PTY_USAGE_PYTHON_SCRIPT, launch.command, ...launch.args],
        {
          env: launch.env,
          timeout: 18_000,
          maxBuffer: 512 * 1024,
        },
      ).catch((err) => ({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      }));

      const observedAtMs = Date.now();
      const parsed = parsePtyUsageOutput(ptyResult.stdout, observedAtMs);
      const tierResult =
        parsed.tierName || prior?.tierName
          ? { tierName: parsed.tierName ?? prior?.tierName, tierId: prior?.tierId }
          : await this.probeTierViaAcp(launch);

      const snapshot: CachedUsageSnapshot = {
        email: parsed.email ?? prior?.email,
        tierName: tierResult.tierName ?? prior?.tierName,
        tierId: tierResult.tierId ?? prior?.tierId,
        observedAtMs: parsed.windows.length > 0 ? observedAtMs : (prior?.observedAtMs ?? 0),
        windows: parsed.windows.length > 0 ? parsed.windows : (prior?.windows ?? []),
      };

      this.memoryCache.set(home, snapshot);
      if (snapshot.windows.length > 0 || snapshot.email || snapshot.tierName) {
        await this.saveDiskCache(home, snapshot);
      }
      return snapshot;
    })();

    this.inflightProbes.set(home, promise);
    try {
      return await promise;
    } finally {
      this.inflightProbes.delete(home);
    }
  }

  registration(): UsageSourceRegistration {
    return {
      id: "antigravity",
      label: "Antigravity",
      icon: "icon.svg",
      input: usageInputSchema,
      discover: async (scope): Promise<UsageAccount[]> => {
        const homes = new Set<string>();
        if (scope.kind === "global") {
          for (const h of this.launches.keys()) homes.add(h);
          const defaultHome = resolveHome();
          if (hasAntigravityState(defaultHome)) homes.add(defaultHome);
        } else {
          if (scope.provider !== "antigravity") return [];
          const sessionHome = resolveHome(scope.env);
          if (this.launches.has(sessionHome) || hasAntigravityState(sessionHome)) {
            homes.add(sessionHome);
          }
        }

        const accounts: UsageAccount[] = [];
        for (const home of homes) {
          let cached = await this.loadDiskCache(home);
          if (!cached?.email) {
            cached = await this.probeLiveUsage(home).catch(() => cached);
          }
          const label = cached?.email || "Antigravity";
          const key = hashAccountKey(`antigravity:${cached?.email ?? home}`);
          accounts.push({
            key,
            label,
            input: { home },
          });
        }
        return accounts;
      },
      fetch: async (rawInput): Promise<UsageReport> => {
        const { home } = usageInputSchema.parse(rawInput);
        try {
          const snapshot = await this.probeLiveUsage(home);
          if (snapshot.windows.length === 0) {
            return unavailable({
              kind: "no_quota",
              detail: "No Antigravity quota reported. Ensure `agy` is signed in.",
            });
          }

          const windows: UsageWindow[] = snapshot.windows.map((w) => ({
            id: w.id,
            label: w.label,
            shortLabel: w.shortLabel,
            usedPct: w.usedPct,
            remainingPct: w.remainingPct,
            resetsAt: w.resetsAt,
            summary: true,
            tone: toneFromUsedPct(w.usedPct),
          }));

          const details: UsageDetail[] = [];
          if (snapshot.email) {
            details.push({ id: "account", label: "Account", value: snapshot.email });
          }
          if (snapshot.tierName) {
            details.push({ id: "tier", label: "Tier", value: snapshot.tierName });
          }
          for (const w of snapshot.windows) {
            if (w.note) {
              details.push({
                id: `${w.id}:note`,
                label: `${w.shortLabel} status`,
                value: w.note,
              });
            }
          }

          return {
            status: "available",
            planLabel: snapshot.tierName ?? "Antigravity",
            windows,
            details,
          };
        } catch (error) {
          return {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  }
}
