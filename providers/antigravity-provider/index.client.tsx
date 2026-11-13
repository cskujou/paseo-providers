import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  createAgentProviderDirectory,
  createInlineThinkingComponent,
} from "./client/inline-thinking.js";
import {
  INLINE_THINKING_KIND,
  INLINE_THINKING_VERSION,
  inlineThinkingSchema,
} from "./shared/inline-thinking.js";

export default function contribute(client: PluginClientContext) {
  const directory = createAgentProviderDirectory(client.paseo);
  const InlineThinking = createInlineThinkingComponent(directory);

  const removeRenderer = client.addTimelineRenderer({
    kind: INLINE_THINKING_KIND,
    version: INLINE_THINKING_VERSION,
    schema: inlineThinkingSchema,
    Component: InlineThinking,
  });

  const removeTransformer = client.addTimelineTransformer({
    id: INLINE_THINKING_KIND,
    query: { itemType: "reasoning" },
    transform: ({ item, phase }) => {
      if (!item.text.trim()) return undefined;
      return {
        items: [
          {
            type: "plugin",
            kind: INLINE_THINKING_KIND,
            version: INLINE_THINKING_VERSION,
            data: {
              text: item.text,
              phase,
            },
          },
        ],
      };
    },
  });

  return () => {
    directory.dispose();
    void removeTransformer();
    void removeRenderer();
  };
}
