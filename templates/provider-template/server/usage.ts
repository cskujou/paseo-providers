import { z } from "zod";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import { unavailable } from "@getpaseo/plugin/server/usage";

const inputSchema = z.object({ account: z.string().default("default") }).strict();

export class CustomUsageSource {
  close(): void {}

  registration(): UsageSourceRegistration {
    return {
      id: "__PROVIDER_ID__",
      label: "__PROVIDER_LABEL__",
      icon: "icon.svg",
      input: inputSchema,
      discover: async () => [],
      fetch: async () =>
        unavailable({
          kind: "no_quota",
          detail: "Usage reporting not yet configured for __PROVIDER_LABEL__.",
        }),
    };
  }
}
