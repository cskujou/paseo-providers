import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../patches/apply-core-patches.mjs", import.meta.url),
);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fakeServer(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-patch-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

function run(root: string, ...ids: string[]) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    execFile(
      process.execPath,
      [script, root, ...ids],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        const code =
          error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, output: stdout + stderr });
      },
    );
  });
}

const coreLines = [
  "    async revert(messageId, scope) {",
  "        const token = this.revertTokens.get(messageId);",
  "        if (token === undefined)",
  '            throw new Error("No provider revert token for message " + messageId);',
  "        await this.bridge.revert({",
  '            type: "session.revert",',
  "            requestId: randomUUID(),",
  "            sessionId: this.bridge.providerId,",
  "            token,",
  "            scope,",
  "        });",
  "    }",
  "",
  "        onEvent: (listener) => connection.onEvent((event) => listener(ProviderEventSchema.parse(event))),",
  "    async listImportableSessions() {",
  "        return sessions.map((session) => ({",
  "            firstPromptPreview: null,",
  "            lastPromptPreview: session.description ?? null,",
  "        }));",
  "    }",
];
const corePath = "server/agent/plugin-provider.js";

describe("core patches", () => {
  it("truncates rewind history and reports a second run as already patched", async () => {
    const root = await fakeServer({ [corePath]: coreLines.join("\n") });
    const first = await run(root);
    expect(first.code).toBe(0);
    expect(first.output).toContain("+ Patched");
    const patched = await readFile(path.join(root, corePath), "utf8");
    expect(patched).toContain("this.history.length = index;");
    expect(patched).toContain("this.timelineSnapshots.clear();");
    expect(patched).not.toContain("revertTokens.set(item.clientMessageId");
    expect(patched).toContain(
      "firstPromptPreview: session.firstPromptPreview ?? null",
    );
    expect(patched).toContain(
      "lastPromptPreview: session.lastPromptPreview ?? session.description ?? null",
    );
    const second = await run(root);
    expect(second.code).toBe(0);
    expect(second.output).toContain("already patched");
  });

  it("fails loudly when the host revert code no longer matches", async () => {
    const changed = coreLines.filter(
      (line) => !line.startsWith("        await this.bridge.revert"),
    );
    const root = await fakeServer({ [corePath]: changed.join("\n") });
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Could not find PluginAgentSession.revert");
  });

  it("fails without modifying the host when its summary mapping no longer matches", async () => {
    const changed = coreLines
      .join("\n")
      .replace("firstPromptPreview: null,", "firstPromptPreview: otherValue,");
    const root = await fakeServer({ [corePath]: changed });
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "Could not find PluginAgentClient session summary mapping",
    );
    expect(await readFile(path.join(root, corePath), "utf8")).toBe(changed);
  });

  it("fails loudly when the plugin host file is missing", async () => {
    const root = await fakeServer({});
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("plugin host layout changed");
  });

  it("registers new plugin ids and fails when the registry has no list", async () => {
    const index = "server/plugins/builtin/index.js";
    const root = await fakeServer({
      [corePath]: coreLines.join("\n"),
      [index]: 'export const builtinPlugins = [\n    "alpha",\n];\n',
    });
    const registered = await run(root, "beta");
    expect(registered.code).toBe(0);
    expect(await readFile(path.join(root, index), "utf8")).toContain('"beta"');

    const broken = await fakeServer({
      [corePath]: coreLines.join("\n"),
      [index]: "const other = [];\n",
    });
    const failed = await run(broken, "beta");
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("Could not find the builtinPlugins list");
  });
});
