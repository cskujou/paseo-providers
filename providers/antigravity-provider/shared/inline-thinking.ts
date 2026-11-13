import { z } from "zod";

export const INLINE_THINKING_KIND = "antigravity-inline-thinking";
export const INLINE_THINKING_VERSION = 1;

export const inlineThinkingSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

export type InlineThinkingData = z.infer<typeof inlineThinkingSchema>;
