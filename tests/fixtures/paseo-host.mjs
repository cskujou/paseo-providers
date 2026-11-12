import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInThisContext } from "node:vm";

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const serverEntry =
  process.env.PASEO_TEST_SERVER_ENTRY ?? require.resolve("@getpaseo/server");
const serverRoot = path.dirname(serverEntry);
const serverVersion = JSON.parse(
  await readFile(
    path.resolve(serverRoot, "..", "..", "..", "package.json"),
    "utf8",
  ),
).version;
const original = path.join(serverRoot, "agent", "plugin-provider.js");
const originalRequire = createRequire(original);
const temporary = await mkdtemp(path.join(os.tmpdir(), "agy-host-test-"));
const host = path.join(temporary, "server", "agent", "plugin-provider.js");
let registry;
let contribution;
try {
  await mkdir(path.dirname(host), { recursive: true });
  await writeFile(path.join(temporary, "package.json"), '{"type":"module"}');
  const source = await readFile(original, "utf8");
  const resolved = source.replace(/from "([^"]+)"/g, (match, specifier) => {
    if (specifier.startsWith("node:")) return match;
    return (
      'from "' + pathToFileURL(originalRequire.resolve(specifier)).href + '"'
    );
  });
  await writeFile(host, resolved);
  execFileSync(
    process.execPath,
    [path.join(repo, "patches", "apply-core-patches.mjs"), temporary],
    { encoding: "utf8" },
  );
  const { PluginAgentClientRegistry } = await import(pathToFileURL(host).href);
  const { compileDirectoryPlugin } = await import(
    pathToFileURL(path.join(serverRoot, "plugins", "compiler.js")).href
  );
  const compiled = await compileDirectoryPlugin(
    path.join(repo, "providers", "antigravity-provider"),
    serverVersion,
    "antigravity-provider",
  );
  const exports = runInThisContext(compiled.serverBundle)(originalRequire);
  let registration;
  contribution = exports.default({
    registerProvider(value) {
      registration = value;
    },
    registerUsageSource() {},
  });
  if (!registration)
    throw new Error("Compiled plugin did not register a provider");
  const logger = { warn() {} };
  registry = new PluginAgentClientRegistry(logger);
  registry.replace([registration]);
  const client = registry.definitions().antigravity.createClient(logger, {
    command: {
      mode: "replace",
      argv: [process.execPath, path.join(repo, "tests", "fixtures", "agy.mjs")],
    },
    env: {
      HOME: temporary,
      FIXTURE_EMPTY_LOAD: "1",
      FIXTURE_REJECT_PLAN: process.argv[2] === "plan-approval" ? "0" : "1",
    },
  });
  const mode = process.argv[2];
  if (mode === "summaries") {
    const logs = path.join(
      temporary,
      ".gemini",
      "antigravity-cli",
      "brain",
      "matching",
      ".system_generated",
      "logs",
    );
    await mkdir(logs, { recursive: true });
    await writeFile(
      path.join(logs, "transcript_full.jsonl"),
      [
        {
          step_index: 0,
          type: "USER_INPUT",
          content:
            "<USER_REQUEST> First\nrequest </USER_REQUEST><ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>",
        },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            { name: "run_command", args: { CommandLine: "npm test" } },
          ],
        },
        {
          step_index: 2,
          type: "RUN_COMMAND",
          status: "DONE",
          exit_code: 0,
          content: "passed",
        },
        { step_index: 3, type: "USER_INPUT", content: "Latest request needle" },
        { step_index: 4, type: "PLANNER_RESPONSE", content: "answer" },
      ]
        .map((r, index) =>
          JSON.stringify({
            ...r,
            created_at: new Date(
              Date.UTC(2026, 0, 1, 0, 0, index),
            ).toISOString(),
          }),
        )
        .join("\n"),
    );
    const listed = await client.listImportableSessions({
      query: "needle",
      limit: 1,
    });
    const item = listed[0];
    if (!item) throw new Error("Host did not list a prompt-only search match");
    const imported = await client.importSession(
      { providerHandleId: item.providerHandleId, cwd: temporary },
      {
        config: { provider: "antigravity", cwd: temporary, mcpServers: {} },
        storedConfig: { provider: "antigravity", cwd: temporary },
      },
    );
    console.log(
      JSON.stringify({
        listed: listed.map((row) => ({
          title: row.title,
          firstPromptPreview: row.firstPromptPreview,
          lastPromptPreview: row.lastPromptPreview,
          hasActivity: row.lastActivityAt.getTime() > 0,
        })),
        timeline: imported.timeline.map((entry) => ({
          type: entry.item.type,
          text: entry.item.text,
          status: entry.item.status,
          detail: entry.item.detail,
          timestamp: entry.timestamp,
        })),
        hasPersistence: imported.persistence.provider === "antigravity",
      }),
    );
    await imported.session.close();
  } else if (mode === "contract") {
    const catalog = await client.fetchCatalog({ scope: "global" });
    const session = await client.createSession(
      { provider: "antigravity", cwd: temporary, mcpServers: {} },
      undefined,
      { persistSession: true },
    );
    await session.setModel("claude-opus-5-5");
    await session.setThinkingOption("high");
    await session.setFeature("agent", "review");
    let rejectedMode;
    try {
      await session.setMode("plan");
    } catch (error) {
      rejectedMode = error.message;
    }
    const info = await session.getRuntimeInfo();
    const events = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    const result = await session.run("hello");
    unsubscribe();
    if (!result.finalText.includes("hello"))
      throw new Error("Host run did not return the assistant reply");
    const lifecycle = [];
    const stopLifecycle = session.subscribe((event) => lifecycle.push(event));
    await session.run("early-end");
    stopLifecycle();
    const drainOrder = lifecycle.flatMap((event) =>
      event.type.startsWith("turn_")
        ? [event.type]
        : event.type === "timeline" && event.item.type === "tool_call"
          ? [event.item.status]
          : event.type === "timeline" && event.item.type === "reasoning"
            ? ["reasoning"]
            : [],
    );
    const idle = await session.canStopRuntime();
    await session.startTurn("hold");
    const busy = await session.canStopRuntime();
    await session.interrupt();
    const idleAfterInterrupt = await session.canStopRuntime();
    const persistence = session.describePersistence();
    await session.close();
    const restored = await client.resumeSession(
      persistence,
      { cwd: temporary },
      undefined,
    );
    console.log(
      JSON.stringify({
        modelCount: catalog.models.length,
        info: {
          model: info.model,
          modeId: info.modeId,
          thinkingOptionId: info.thinkingOptionId,
        },
        rejectedMode,
        drainOrder,
        features: restored.features.map((f) => ({ id: f.id, value: f.value })),
        turns: events
          .filter((e) => e.type.startsWith("turn_"))
          .map((e) => e.type),
        idle,
        busy,
        idleAfterInterrupt,
        restoredInfo: { model: (await restored.getRuntimeInfo()).model },
      }),
    );
    await restored.close();
  } else if (mode === "background-stream") {
    const session = await client.createSession(
      { provider: "antigravity", cwd: temporary, mcpServers: {} },
      undefined,
      { persistSession: true },
    );
    const waiting = Promise.withResolvers();
    const live = Promise.withResolvers();
    const events = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
      if (
        event.type === "timeline" &&
        event.item.type === "notification" &&
        event.item.message.includes("Background task is running")
      )
        waiting.resolve();
      if (
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.detail.type === "read" &&
        event.item.status === "running"
      )
        live.resolve();
    });
    const run = session.run("background-held");
    void run.catch(() => {});
    await waiting.promise;
    const file = path.join(
      temporary,
      ".gemini",
      "antigravity-cli",
      "brain",
      "fixture",
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    );
    const initial = await readFile(file, "utf8");
    const continuation = [
      {
        type: "SYSTEM_MESSAGE",
        step_index: 4,
        status: "DONE",
        content:
          'Task id "fixture/task-2" finished with result:\nCommand exited with code 0.',
      },
      {
        type: "PLANNER_RESPONSE",
        step_index: 5,
        status: "DONE",
        thinking: "automatic thinking",
        tool_calls: [{ name: "read_file", args: { Path: "/tmp/result.txt" } }],
      },
    ];
    await writeFile(
      file,
      initial + continuation.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    await live.promise;
    const endedBeforeTools = events.some(
      (event) => event.type === "turn_completed",
    );
    continuation.push(
      { type: "GENERIC", step_index: 6, status: "DONE", content: "result" },
      {
        type: "PLANNER_RESPONSE",
        step_index: 7,
        status: "DONE",
        content: "STREAM_DONE",
      },
    );
    await writeFile(
      file,
      initial + continuation.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const result = await run;
    unsubscribe();
    console.log(
      JSON.stringify({
        endedBeforeTools,
        finalText: result.finalText,
        readStatuses: events
          .filter(
            (e) =>
              e.type === "timeline" &&
              e.item.type === "tool_call" &&
              e.item.detail.type === "read",
          )
          .map((e) => e.item.status),
        turns: events
          .filter((e) => e.type.startsWith("turn_"))
          .map((e) => e.type),
      }),
    );
    await session.close();
  } else if (mode === "diagnostics") {
    const session = await client.createSession(
      { provider: "antigravity", cwd: temporary, mcpServers: {} },
      undefined,
      { persistSession: true },
    );
    let failure;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_failed") failure = event;
    });
    try {
      await session.run("upstream-error");
    } catch {
      /* Inspect the actual host event, not run()'s simplified exception. */
    }
    unsubscribe();
    const result = await session.run("next");
    console.log(
      JSON.stringify({
        message: failure?.error,
        code: failure?.code,
        diagnostic: failure?.diagnostic,
        followUpSucceeded: result.finalText.includes("next"),
      }),
    );
    await session.close();
  } else if (mode === "plan-approval") {
    const session = await client.createSession(
      {
        provider: "antigravity",
        cwd: temporary,
        mcpServers: {},
        modeId: "plan",
      },
      undefined,
      { persistSession: true },
    );
    const events = [];
    const approvalReady = Promise.withResolvers();
    const implemented = Promise.withResolvers();
    let planId;
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
      if (
        event.type === "permission_requested" &&
        event.request.kind === "plan"
      ) {
        planId = event.request.id;
        approvalReady.resolve(event.request);
      }
      if (
        planId &&
        event.type === "turn_completed" &&
        events.filter((e) => e.type === "turn_completed").length === 2
      )
        implemented.resolve();
    });
    await session.run("plan-proposal");
    const approval = await approvalReady.promise;
    await session.respondToPermission(approval.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });
    await implemented.promise;
    console.log(
      JSON.stringify({
        planKind: approval.kind,
        planText: approval.metadata.planText,
        mode: (await session.getRuntimeInfo()).modeId,
        turns: events
          .filter((e) => e.type.startsWith("turn_"))
          .map((e) => e.type),
        planCards: events
          .filter(
            (e) =>
              e.type === "timeline" &&
              e.item.type === "tool_call" &&
              e.item.detail.type === "plan",
          )
          .map((e) => e.item.status),
      }),
    );
    unsubscribe();
    await session.close();
  } else if (mode === "subagent-lifecycle") {
    const session = await client.createSession(
      { provider: "antigravity", cwd: temporary, mcpServers: {} },
      undefined,
      { persistSession: true },
    );
    const events = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    const result = await session.run("subagent-task");
    const subagent = events.filter((e) => e.type === "provider_subagent");
    console.log(
      JSON.stringify({
        updates: subagent
          .filter((e) => e.event.type === "upsert")
          .map((e) => ({
            id: e.event.id,
            parent: e.event.parentSubagentId,
            status: e.event.status,
            hasToolLink: !!e.event.toolCallId,
          })),
        childTimeline: subagent
          .filter((e) => e.event.type === "timeline")
          .map((e) => e.event.item.type),
        hasLinkedCard: events.some(
          (e) =>
            e.type === "timeline" &&
            e.item.type === "tool_call" &&
            e.item.detail.type === "sub_agent" &&
            !!e.item.detail.childSessionId,
        ),
        historyEvents: session.subagentHistory().length,
        parentFinalText: result.finalText,
      }),
    );
    unsubscribe();
    await session.close();
  } else if (mode === "legacy") {
    // Other plugins still use description; the summary patch must not break them.
    let listener;
    const legacy = {
      id: "legacy",
      label: "Legacy",
      command: [process.execPath],
      async connect() {
        return {
          version: 1,
          capabilities: ["session.list"],
          onEvent(callback) {
            listener = callback;
            return () => {};
          },
          async send(input) {
            listener({
              type: "sessions",
              requestId: input.requestId,
              sessions: [
                {
                  persistence: { version: 1, data: {} },
                  cwd: temporary,
                  description: "old-style preview",
                },
              ],
            });
          },
          async close() {},
        };
      },
    };
    registry.replace([legacy]);
    const legacyClient = registry.clients().legacy;
    const entries = await legacyClient.listImportableSessions();
    console.log(
      JSON.stringify(
        entries.map((entry) => ({
          firstPromptPreview: entry.firstPromptPreview,
          lastPromptPreview: entry.lastPromptPreview,
        })),
      ),
    );
  } else throw new Error("Unknown fixture mode");
} finally {
  if (registry) await registry.shutdown();
  if (contribution) await contribution();
  await rm(temporary, { recursive: true, force: true });
}
