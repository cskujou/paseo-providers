import { execCommand } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { CustomUsageSource } from "./usage.js";

const capabilities = [
  "prompt.message",
  "session.configure",
  "session.persistence",
] as const;

export function createCustomProvider(_usage?: CustomUsageSource): ProviderRegistration {
  return {
    id: "__PROVIDER_ID__",
    label: "__PROVIDER_LABEL__",
    description: "Custom __PROVIDER_LABEL__ agent provider",
    icon: "icon.svg",
    command: ["__CLI_CMD__"],
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic: "Install `__CLI_CMD__` and ensure it is on PATH.",
        };
      }
      try {
        await execCommand(launch.command, [...launch.args, "--version"], {
          env: launch.env,
          timeout: 5000,
        });
        return { available: true };
      } catch (err) {
        return {
          available: false,
          diagnostic: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async connect(request) {
      const negotiated = negotiateProviderCapabilities(request.capabilities, capabilities);
      throw new Error(
        `TODO: Implement connect() for __PROVIDER_ID__ (negotiated: ${negotiated.join(", ")})`,
      );
    },
  };
}
