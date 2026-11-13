import type {
  PluginClientContext,
  PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { Icon, StreamedText } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { InlineThinkingData } from "../shared/inline-thinking.js";

type HostPaseo = PluginClientContext["paseo"];

export interface AgentProviderDirectory {
  getProvider(agentId: string): string | null;
  ensureAgent(agentId: string): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function isAntigravityAgent(
  agentId: string,
  provider: string | null,
): boolean {
  return agentId.startsWith("agy-child:") || provider === "antigravity";
}

export function createAgentProviderDirectory(
  paseo: HostPaseo,
): AgentProviderDirectory {
  const providers = new Map<string, string>();
  const pending = new Set<string>();
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const record = (agentId: string, provider: string | null | undefined) => {
    if (!agentId || !provider) return;
    if (providers.get(agentId) === provider) return;
    providers.set(agentId, provider);
    notify();
  };

  const unsubscribeDirect = paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") {
      record(update.agent.id, update.agent.provider);
    }
  });

  void paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ entries, subscription }) => {
      for (const entry of entries) {
        record(entry.agent.id, entry.agent.provider);
      }
      subscription.subscribe({
        snapshot: ({ entries: nextEntries }) => {
          for (const entry of nextEntries) {
            record(entry.agent.id, entry.agent.provider);
          }
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            record(update.agent.id, update.agent.provider);
          }
        },
      });
      return undefined;
    })
    .catch(() => {
      // Individual timeline rows still fall back to ensureAgent() when needed.
    });

  return {
    getProvider(agentId: string): string | null {
      return providers.get(agentId) ?? null;
    },
    ensureAgent(agentId: string): void {
      if (
        !agentId ||
        agentId.startsWith("agy-child:") ||
        providers.has(agentId) ||
        pending.has(agentId) ||
        lifetime.signal.aborted
      ) {
        return;
      }
      pending.add(agentId);
      void paseo.agents
        .ref(agentId)
        .refresh()
        .then((result) => {
          if (!lifetime.signal.aborted && result?.agent) {
            record(result.agent.id, result.agent.provider);
          }
          return undefined;
        })
        .catch(() => undefined)
        .finally(() => {
          pending.delete(agentId);
        });
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      lifetime.abort();
      unsubscribeDirect();
      listeners.clear();
      pending.clear();
    },
  };
}

export function createInlineThinkingComponent(
  directory: AgentProviderDirectory,
) {
  return function InlineThinking({
    agentId,
    item,
    theme,
    layout,
  }: PluginTimelineItemProps<InlineThinkingData>) {
    const provider = useSyncExternalStore(
      directory.subscribe,
      () => directory.getProvider(agentId),
      () => directory.getProvider(agentId),
    );

    useEffect(() => {
      directory.ensureAgent(agentId);
    }, [agentId]);

    const defaultExpanded = isAntigravityAgent(agentId, provider);
    const [manualOverride, setManualOverride] = useState<boolean | null>(null);
    const expanded = manualOverride ?? defaultExpanded;
    const streaming = item.data.phase === "streaming";

    const styles = useMemo(
      () => ({
        container: {
          gap: layout.compact ? 4 : 6,
          paddingVertical: 2,
        },
        header: {
          flexDirection: "row" as const,
          alignItems: "center" as const,
          alignSelf: "flex-start" as const,
          gap: 6,
          paddingVertical: 2,
        },
        headerLabel: {
          color: theme.colors.foregroundMuted,
          fontSize: layout.compact ? 12 : 13,
          fontWeight: "500" as const,
          lineHeight: layout.compact ? 16 : 18,
        },
        body: {
          marginLeft: 6,
          paddingLeft: layout.compact ? 10 : 12,
          borderLeftWidth: 2,
          borderColor: theme.colors.border,
        },
        bodyText: {
          color: theme.colors.foregroundMuted,
          fontSize: layout.compact ? 13 : 14,
          lineHeight: layout.compact ? 19 : 21,
        },
      }),
      [layout.compact, theme],
    );

    return (
      <View style={styles.container} testID="antigravity-inline-thinking">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={
            expanded ? "Collapse thinking process" : "Expand thinking process"
          }
          onPress={() =>
            setManualOverride((previous) => !(previous ?? defaultExpanded))
          }
          style={styles.header}
        >
          <Icon name="Brain" size={14} color={theme.colors.foregroundMuted} />
          <Text style={styles.headerLabel}>
            {streaming ? "Thinking..." : "Thinking"}
          </Text>
          <Icon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            size={14}
            color={theme.colors.foregroundMuted}
          />
        </Pressable>
        {expanded ? (
          <View style={styles.body}>
            <StreamedText
              selectable
              text={item.data.text}
              phase={item.data.phase}
              style={styles.bodyText}
            />
          </View>
        ) : null}
      </View>
    );
  };
}
