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
  const mode = process.argv[2];
  const client = registry.definitions().antigravity.createClient(logger, {
    command: {
      mode: "replace",
      argv: [process.execPath, path.join(repo, "tests", "fixtures", "agy.mjs")],
    },
    env: {
      HOME: temporary,
      FIXTURE_EMPTY_LOAD: "1",
      FIXTURE_REJECT_PLAN: mode === "plan-approval" ? "0" : "1",
      ...(mode === "retry-and-compaction"
        ? {
            FIXTURE_DB: "1",
            PASEO_AGY_AUTO_RETRY_DELAY_MS: "10",
          }
        : {}),
    },
  });
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
  } else if (mode === "retry-and-compaction") {
    const session = await client.createSession(
      { provider: "antigravity", cwd: temporary, mcpServers: {} },
      undefined,
      { persistSession: true },
    );
    const events = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    const retryResult = await session.run("transient-silent-error");
    const autoResult = await session.run("auto-compact-turn");
    const manualResult = await session.run("/compact");
    unsubscribe();
    await session.close();

    const importLogs = path.join(
      temporary,
      ".gemini",
      "antigravity-cli",
      "brain",
      "matching",
      ".system_generated",
      "logs",
    );
    await mkdir(importLogs, { recursive: true });
    await writeFile(
      path.join(importLogs, "transcript_full.jsonl"),
      [
        { step_index: 0, type: "USER_INPUT", content: "long task" },
        { step_index: 1, type: "CHECKPOINT", status: "DONE" },
        { step_index: 2, type: "PLANNER_RESPONSE", content: "done" },
      ]
        .map((row, index) =>
          JSON.stringify({
            ...row,
            created_at: new Date(
              Date.UTC(2026, 0, 2, 0, 0, index),
            ).toISOString(),
          }),
        )
        .join("\n"),
    );
    const listed = await client.listImportableSessions({
      query: "long task",
      limit: 1,
    });
    const importCandidate = listed[0];
    if (!importCandidate) {
      throw new Error("Host did not list compact-import transcript");
    }
    const imported = await client.importSession(
      { providerHandleId: importCandidate.providerHandleId, cwd: temporary },
      {
        config: { provider: "antigravity", cwd: temporary, mcpServers: {} },
        storedConfig: { provider: "antigravity", cwd: temporary },
      },
    );
    await imported.session.close();

    const assistantLeakedError = events.some(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "assistant_message" &&
        event.item.text.includes("Agent execution terminated due to error."),
    );
    const liveCompactions = events
      .filter(
        (event) =>
          event.type === "timeline" && event.item.type === "compaction",
      )
      .map((event) => ({
        status: event.item.status,
        trigger: event.item.trigger,
        preTokens: event.item.preTokens ?? null,
      }));
    console.log(
      JSON.stringify({
        retryFinalText: retryResult.finalText,
        autoFinalText: autoResult.finalText,
        manualFinalText: manualResult.finalText,
        assistantLeakedError,
        turns: events
          .filter((event) => event.type.startsWith("turn_"))
          .map((event) => event.type),
        liveCompactions,
        importedTimeline: imported.timeline.map((entry) =>
          entry.item.type === "compaction"
            ? {
                type: entry.item.type,
                status: entry.item.status,
                trigger: entry.item.trigger,
              }
            : { type: entry.item.type, text: entry.item.text },
        ),
      }),
    );
  } else if (mode === "inline-thinking") {
    if (typeof compiled.clientBundle !== "string" || !compiled.clientBundle) {
      throw new Error("Expected compileDirectoryPlugin to emit clientBundle");
    }
    let stateSlot = null;
    let resetState = true;
    const mockClientRequire = (specifier) => {
      if (specifier === "zod") return originalRequire("zod");
      if (specifier === "@getpaseo/plugin/client") return {};
      if (specifier === "@getpaseo/plugin/client/ui") {
        return { Icon: "Icon", StreamedText: "StreamedText" };
      }
      if (specifier === "react-native") {
        return { View: "View", Text: "Text", Pressable: "Pressable" };
      }
      if (specifier === "react/jsx-runtime") {
        return {
          Fragment: "Fragment",
          jsx: (type, props) => ({ type, props }),
          jsxs: (type, props) => ({ type, props }),
        };
      }
      if (specifier === "react") {
        return {
          useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
          useEffect: (fn) => {
            fn();
          },
          useMemo: (fn) => fn(),
          useState: (initial) => {
            if (resetState) {
              stateSlot = typeof initial === "function" ? initial() : initial;
              resetState = false;
            }
            const setState = (next) => {
              stateSlot = typeof next === "function" ? next(stateSlot) : next;
            };
            return [stateSlot, setState];
          },
        };
      }
      throw new Error("Unexpected client require: " + specifier);
    };

    const clientExports = runInThisContext(compiled.clientBundle)(
      mockClientRequire,
    );
    let transformer;
    let renderer;
    const cleanup = clientExports.default({
      paseo: {
        agents: {
          subscribe: () => () => {},
          list: async () => ({
            entries: [
              { agent: { id: "agy-root-1", provider: "antigravity" } },
              { agent: { id: "codex-root-1", provider: "codex" } },
            ],
            subscription: {
              subscribe() {},
            },
          }),
          ref: (agentId) => ({
            refresh: async () =>
              agentId === "agy-archived-1"
                ? { agent: { id: "agy-archived-1", provider: "antigravity" } }
                : null,
          }),
        },
      },
      addTimelineTransformer(value) {
        transformer = value;
        return () => {};
      },
      addTimelineRenderer(value) {
        renderer = value;
        return () => {};
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!transformer || !renderer) {
      throw new Error("Client contribution did not register timeline hooks");
    }

    const emptyResult = transformer.transform({
      item: { type: "reasoning", text: "   " },
      phase: "streaming",
    });
    const streamingResult = transformer.transform({
      item: { type: "reasoning", text: "Checking build graph..." },
      phase: "streaming",
    });
    const parsedData = renderer.schema.parse(streamingResult.items[0].data);

    const theme = {
      colors: {
        surface0: "#000",
        surface1: "#111",
        surface2: "#222",
        border: "#333",
        foreground: "#fff",
        foregroundMuted: "#aaa",
        accent: "#0af",
        accentForeground: "#000",
        statusSuccess: "#0f0",
        statusWarning: "#ff0",
        statusDanger: "#f00",
      },
    };
    const findNode = (node, targetType) => {
      if (!node || typeof node !== "object") return null;
      if (node.type === targetType) return node;
      const children = node.props?.children;
      if (Array.isArray(children)) {
        for (const child of children) {
          const found = findNode(child, targetType);
          if (found) return found;
        }
        return null;
      }
      return findNode(children, targetType);
    };
    const renderFor = (agentId, fresh = true) => {
      if (fresh) resetState = true;
      const tree = renderer.Component({
        agentId,
        item: {
          type: "plugin",
          kind: streamingResult.items[0].kind,
          version: streamingResult.items[0].version,
          data: parsedData,
        },
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
        theme,
        host: { id: "local", label: "Local" },
        layout: { compact: false, platform: "web" },
      });
      const streamed = findNode(tree, "StreamedText");
      const pressable = findNode(tree, "Pressable");
      return {
        expanded: Boolean(streamed),
        text: streamed?.props?.text ?? null,
        phase: streamed?.props?.phase ?? null,
        press: pressable?.props?.onPress,
      };
    };

    const agyRoot = renderFor("agy-root-1");
    agyRoot.press();
    const agyRootAfterCollapse = renderFor("agy-root-1", false);

    const agyChild = renderFor(
      "agy-child:12345678-1234-4123-8123-123456789abc",
    );

    renderFor("agy-archived-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const agyArchived = renderFor("agy-archived-1", false);

    const codexDefault = renderFor("codex-root-1");
    codexDefault.press();
    const codexAfterExpand = renderFor("codex-root-1", false);

    await cleanup();
    console.log(
      JSON.stringify({
        queryItemType: transformer.query.itemType,
        emptySkipped: emptyResult === undefined,
        kind: streamingResult.items[0].kind,
        agyRootExpanded: agyRoot.expanded,
        agyRootText: agyRoot.text,
        agyRootPhase: agyRoot.phase,
        agyRootAfterCollapse: agyRootAfterCollapse.expanded,
        agyChildExpanded: agyChild.expanded,
        agyArchivedExpanded: agyArchived.expanded,
        codexDefaultExpanded: codexDefault.expanded,
        codexAfterExpand: codexAfterExpand.expanded,
      }),
    );
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
