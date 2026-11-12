import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [paseoServerDir, ...installedPluginIds] = process.argv.slice(2);
if (!paseoServerDir) {
  console.error("Usage: node apply-core-patches.mjs <paseoServerDir> [pluginId...]");
  process.exit(1);
}

function fail(message) {
  console.error("  ! " + message);
  process.exit(1);
}

// 1. Truncate PluginAgentSession's in-memory history after a revert. A provider
//    only sees its own ACP state, so the daemon timeline keeps the reverted
//    messages until the agent is reopened unless the host drops them here.
const pluginProviderPath = path.join(paseoServerDir, "server", "agent", "plugin-provider.js");
if (!fs.existsSync(pluginProviderPath)) {
  fail("Missing " + pluginProviderPath + ". Paseo's plugin host layout changed; rewind needs this patch.");
}
let pluginProviderSrc = fs.readFileSync(pluginProviderPath, "utf8");
const rewindPatchApplied =
  pluginProviderSrc.includes("this.history.length = index;") &&
  pluginProviderSrc.includes("this.timelineSnapshots.clear();");
const nativeRewindReplay = pluginProviderSrc.includes("async replayBinding() {") &&
  pluginProviderSrc.includes("this.replay = { persistence, config: this.bridge.config, messageId, scope, closed: false };") &&
  pluginProviderSrc.includes("await this.ensureReplay();");
if (nativeRewindReplay) {
  console.log("  = Paseo native rewind history replay detected; legacy rewind patch skipped");
} else if (rewindPatchApplied) {
  console.log("  = server/agent/plugin-provider.js already patched");
} else {
  const target = `        await this.bridge.revert({
            type: "session.revert",
            requestId: randomUUID(),
            sessionId: this.bridge.providerId,
            token,
            scope,
        });
    }`;
  const replacement = `        await this.bridge.revert({
            type: "session.revert",
            requestId: randomUUID(),
            sessionId: this.bridge.providerId,
            token,
            scope,
        });
        if (scope !== "files") {
            const index = this.history.findIndex(
                (event) =>
                    event.type === "timeline" &&
                    event.item.type === "user_message" &&
                    (event.item.messageId === messageId || event.item.clientMessageId === messageId),
            );
            if (index !== -1) {
                this.history.length = index;
                this.timelineSnapshots.clear();
            }
        }
    }`;
  if (!pluginProviderSrc.includes(target)) {
    fail(
      "Could not find PluginAgentSession.revert in " +
        pluginProviderPath +
        ". Paseo changed this code; update the rewind patch before deploying.",
    );
  }
  pluginProviderSrc = pluginProviderSrc.replace(target, replacement);
  console.log("  + Patched server/agent/plugin-provider.js (rewind history truncation)");
}

// Preserve optional prompt previews until the SDK exposes them. Description remains
// the fallback for other plugins that use the existing 0.14 session summary contract.
const summaryTarget = [
  "            firstPromptPreview: null,",
  "            lastPromptPreview: session.description ?? null,",
].join("\n");
const summaryReplacement = [
  "            firstPromptPreview: session.firstPromptPreview ?? null,",
  "            lastPromptPreview: session.lastPromptPreview ?? session.description ?? null,",
].join("\n");
if (pluginProviderSrc.includes(summaryReplacement)) {
  console.log("  = PluginAgentClient prompt previews already patched");
} else {
  if (!pluginProviderSrc.includes(summaryTarget)) {
    fail("Could not find PluginAgentClient session summary mapping in " + pluginProviderPath + "; update the prompt-preview patch before deploying.");
  }
  pluginProviderSrc = pluginProviderSrc.replace(summaryTarget, summaryReplacement);
  console.log("  + Patched PluginAgentClient session prompt previews");
}
const eventTarget = "        onEvent: (listener) => connection.onEvent((event) => listener(ProviderEventSchema.parse(event))),";
const eventReplacement = [
  "        onEvent: (listener) => connection.onEvent((event) => {",
  "            const parsed = ProviderEventSchema.parse(event);",
  "            if (parsed.type === \"sessions\") {",
  "                const previews = z.object({ sessions: z.array(z.object({",
  "                    firstPromptPreview: z.string().optional(),",
  "                    lastPromptPreview: z.string().optional(),",
  "                }).strip()) }).parse(event);",
  "                parsed.sessions = parsed.sessions.map((session, index) => ({ ...session, ...previews.sessions[index] }));",
  "            }",
  "            listener(parsed);",
  "        }),",
].join("\n");
if (!pluginProviderSrc.includes(eventReplacement)) {
  if (!pluginProviderSrc.includes(eventTarget)) fail("Could not find normalizeConnection event validation in " + pluginProviderPath + "; update the prompt-preview patch before deploying.");
  pluginProviderSrc = pluginProviderSrc.replace(eventTarget, eventReplacement);
}
fs.writeFileSync(pluginProviderPath, pluginProviderSrc, "utf8");

// 2. Ensure all installedPluginIds are registered in server/plugins/builtin/index.js
const builtinIndexPath = path.join(paseoServerDir, "server", "plugins", "builtin", "index.js");
if (installedPluginIds.length > 0) {
  if (!fs.existsSync(builtinIndexPath)) {
    fail("Missing " + builtinIndexPath + ". Cannot register " + installedPluginIds.join(", ") + ".");
  }
  let indexSrc = fs.readFileSync(builtinIndexPath, "utf8");
  const match = /export const builtinPlugins = \[([\s\S]*?)\];/.exec(indexSrc);
  if (!match) {
    fail("Could not find the builtinPlugins list in " + builtinIndexPath + "; Paseo's plugin registry changed.");
  }
  const existing = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  const merged = Array.from(new Set([...existing, ...installedPluginIds])).sort();
  if (JSON.stringify(existing) === JSON.stringify(merged)) {
    console.log("  = server/plugins/builtin/index.js already contains all target plugin IDs");
  } else {
    const formatted = merged.map((id) => "    " + JSON.stringify(id) + ",").join("\n");
    indexSrc = indexSrc.replace(
      /export const builtinPlugins = \[[\s\S]*?\];/,
      "export const builtinPlugins = [\n" + formatted + "\n];",
    );
    fs.writeFileSync(builtinIndexPath, indexSrc, "utf8");
    console.log(
      "  + Registered custom builtin plugins in server/plugins/builtin/index.js: " +
        installedPluginIds.join(", "),
    );
  }
}

// 3. Validate each installed plugin using Paseo's own PluginCompiler
const compilerPath = path.join(paseoServerDir, "server", "plugins", "compiler.js");
if (fs.existsSync(compilerPath) && installedPluginIds.length > 0) {
  const { compileDirectoryPlugin } = await import(pathToFileURL(compilerPath).href);
  let daemonVersion = "0.14.0";
  const serverPkgPath = path.resolve(paseoServerDir, "..", "..", "package.json");
  if (fs.existsSync(serverPkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(serverPkgPath, "utf8"));
      if (typeof pkg.version === "string") daemonVersion = pkg.version;
    } catch {
      // keep default
    }
  }
  for (const pluginId of installedPluginIds) {
    const dir = path.join(paseoServerDir, "builtin-plugins", pluginId);
    await compileDirectoryPlugin(dir, daemonVersion, pluginId);
    console.log(`  ✓ Verified bundle compilation for ${pluginId}`);
  }
}