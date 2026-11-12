import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [paseoServerDir, ...installedPluginIds] = process.argv.slice(2);
if (!paseoServerDir) {
  console.error("Usage: node apply-core-patches.mjs <paseoServerDir> [pluginId...]");
  process.exit(1);
}

// 1. Patch server/agent/plugin-provider.js so PluginAgentSession.revert truncates in-memory history
//    and indexes revertTokens by clientMessageId as well.
const pluginProviderPath = path.join(paseoServerDir, "server", "agent", "plugin-provider.js");
if (fs.existsSync(pluginProviderPath)) {
  let src = fs.readFileSync(pluginProviderPath, "utf8");
  let changed = false;

  if (!src.includes("this.timelineSnapshots.clear()")) {
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
    if (src.includes(target)) {
      src = src.replace(target, replacement);
      changed = true;
    }
  }

  if (!src.includes('if (item.type === "user_message" && item.clientMessageId)')) {
    const target = `        if (item.type === "user_message" || item.type === "assistant_message") {
            revertTokens.set(item.messageId ?? id, revertToken);
        }`;
    const replacement = `        if (item.type === "user_message" || item.type === "assistant_message") {
            revertTokens.set(item.messageId ?? id, revertToken);
        }
        if (item.type === "user_message" && item.clientMessageId) {
            revertTokens.set(item.clientMessageId, revertToken);
        }`;
    if (src.includes(target)) {
      src = src.replace(target, replacement);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(pluginProviderPath, src, "utf8");
    console.log("  + Patched server/agent/plugin-provider.js (rewind history truncation)");
  } else {
    console.log("  = server/agent/plugin-provider.js already patched");
  }
}

// 2. Ensure all installedPluginIds are registered in server/plugins/builtin/index.js
const builtinIndexPath = path.join(paseoServerDir, "server", "plugins", "builtin", "index.js");
if (fs.existsSync(builtinIndexPath) && installedPluginIds.length > 0) {
  let src = fs.readFileSync(builtinIndexPath, "utf8");
  const match = /export const builtinPlugins = \[([\s\S]*?)\];/.exec(src);
  if (match) {
    const existing = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const merged = Array.from(new Set([...existing, ...installedPluginIds])).sort();
    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      const formatted = merged.map((id) => `    "${id}",`).join("\n");
      src = src.replace(
        /export const builtinPlugins = \[[\s\S]*?\];/,
        `export const builtinPlugins = [\n${formatted}\n];`,
      );
      fs.writeFileSync(builtinIndexPath, src, "utf8");
      console.log(`  + Registered custom builtin plugins in server/plugins/builtin/index.js: ${installedPluginIds.join(", ")}`);
    } else {
      console.log("  = server/plugins/builtin/index.js already contains all target plugin IDs");
    }
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
