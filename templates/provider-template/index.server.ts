import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCustomProvider } from "./server/provider.js";
import { CustomUsageSource } from "./server/usage.js";

export default function contribute(
  server: Pick<PluginServerContext, "registerProvider" | "registerUsageSource">,
) {
  const usage = new CustomUsageSource();
  server.registerUsageSource(usage.registration());
  server.registerProvider(createCustomProvider(usage));
  return () => {
    usage.close();
  };
}
