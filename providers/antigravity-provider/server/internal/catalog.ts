import type {
  ProviderCatalog,
  ProviderModeDescriptor,
  ProviderModelDescriptor,
  ProviderSessionConfig,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";

export const THINKING_OPTIONS: readonly ProviderThinkingOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

export const CLAUDE_THINKING_OPTIONS: readonly ProviderThinkingOption[] = [
  { id: "low", label: "Standard" },
  { id: "high", label: "Thinking" },
];

export const DEFAULT_MODELS: readonly ProviderModelDescriptor[] = [
  {
    id: "gemini-4-carbon",
    label: "Gemini 4 Carbon",
    isDefault: true,
    thinkingOptions: THINKING_OPTIONS,
    defaultThinkingOptionId: "medium",
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    thinkingOptions: THINKING_OPTIONS,
    defaultThinkingOptionId: "medium",
  },
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    thinkingOptions: THINKING_OPTIONS,
    defaultThinkingOptionId: "medium",
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    thinkingOptions: CLAUDE_THINKING_OPTIONS,
    defaultThinkingOptionId: "high",
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    thinkingOptions: CLAUDE_THINKING_OPTIONS,
    defaultThinkingOptionId: "high",
  },
  {
    id: "gpt-oss-120b-medium",
    label: "GPT-OSS 120B (Medium)",
    thinkingOptions: [],
  },
];

export const DEFAULT_MODES: readonly ProviderModeDescriptor[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Smart auto-approve safe actions, ask on risky operations",
  },
  {
    id: "default",
    label: "Default",
    description: "Ask for permission on writes and shell commands",
  },
  {
    id: "accept-edits",
    label: "Accept edits",
    description: "Auto-approve file edits, ask on shell commands",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only research and planning mode",
  },
  {
    id: "full-access",
    label: "Full access",
    description: "Run all tool calls and shell commands without asking",
  },
];

const LEGACY_MODEL_MAP: Readonly<
  Record<string, { baseModel: string; thinkingOption?: string; fullModelId: string }>
> = {
  "gemini-4-carbon-low": {
    baseModel: "gemini-4-carbon",
    thinkingOption: "low",
    fullModelId: "gemini-4-carbon-low",
  },
  "gemini-4-carbon-medium": {
    baseModel: "gemini-4-carbon",
    thinkingOption: "medium",
    fullModelId: "gemini-4-carbon-medium",
  },
  "gemini-4-carbon-high": {
    baseModel: "gemini-4-carbon",
    thinkingOption: "high",
    fullModelId: "gemini-4-carbon-high",
  },
  "gemini-4-argon-low": {
    baseModel: "gemini-4-argon",
    thinkingOption: "low",
    fullModelId: "gemini-4-argon-low",
  },
  "gemini-4-argon-medium": {
    baseModel: "gemini-4-argon",
    thinkingOption: "medium",
    fullModelId: "gemini-4-argon-medium",
  },
  "gemini-4-argon-high": {
    baseModel: "gemini-4-argon",
    thinkingOption: "high",
    fullModelId: "gemini-4-argon-high",
  },
  "gemini-3.8-flash-low": {
    baseModel: "gemini-3.8-flash",
    thinkingOption: "low",
    fullModelId: "gemini-3.8-flash-low",
  },
  "gemini-3.8-flash-medium": {
    baseModel: "gemini-3.8-flash",
    thinkingOption: "medium",
    fullModelId: "gemini-3.8-flash-medium",
  },
  "gemini-3.8-flash-high": {
    baseModel: "gemini-3.8-flash",
    thinkingOption: "high",
    fullModelId: "gemini-3.8-flash-high",
  },
  "claude-opus-5-5-thinking": {
    baseModel: "claude-opus-5-5",
    thinkingOption: "high",
    fullModelId: "claude-opus-5-5-thinking",
  },
  "claude-sonnet-5-5-thinking": {
    baseModel: "claude-sonnet-5-5",
    thinkingOption: "high",
    fullModelId: "claude-sonnet-5-5-thinking",
  },
};

export interface NormalizedSelection {
  baseModel: string;
  thinkingOption?: string;
  mode: string;
  acpMode: string;
  autoApproveAll: boolean;
}

export function fallbackCatalog(): ProviderCatalog {
  return {
    models: DEFAULT_MODELS,
    modes: DEFAULT_MODES,
    thinkingOptions: THINKING_OPTIONS,
    defaultModel: "gemini-4-carbon",
    defaultMode: "auto",
    defaultThinkingOption: "medium",
  };
}

export function normalizeSelection(
  config: Pick<ProviderSessionConfig, "model" | "mode" | "thinkingOption">,
  catalog: ProviderCatalog = fallbackCatalog(),
): NormalizedSelection {
  let rawModel = config.model ?? catalog.defaultModel ?? "gemini-4-carbon";
  let thinkingOption =
    config.thinkingOption && config.thinkingOption !== "auto"
      ? config.thinkingOption
      : undefined;

  const legacy = LEGACY_MODEL_MAP[rawModel];
  if (legacy) {
    rawModel = legacy.baseModel;
    if (!thinkingOption && legacy.thinkingOption) {
      thinkingOption = legacy.thinkingOption;
    }
  }

  const descriptor =
    catalog.models.find((m) => m.id === rawModel) ??
    DEFAULT_MODELS.find((m) => m.id === rawModel);

  if (!thinkingOption && descriptor?.defaultThinkingOptionId) {
    thinkingOption = descriptor.defaultThinkingOptionId;
  }

  const mode = config.mode ?? catalog.defaultMode ?? "auto";
  const autoApproveAll = mode === "full-access";
  const acpMode = mode === "full-access" ? "auto" : mode;

  return {
    baseModel: rawModel,
    thinkingOption,
    mode,
    acpMode,
    autoApproveAll,
  };
}

export function validateSelection(
  config: Pick<ProviderSessionConfig, "model" | "mode" | "thinkingOption">,
  catalog: ProviderCatalog,
): NormalizedSelection {
  const normalized = normalizeSelection(config, catalog);
  const validModes = new Set([
    ...catalog.modes.map((m) => m.id),
    ...DEFAULT_MODES.map((m) => m.id),
  ]);
  if (!validModes.has(normalized.mode)) {
    throw new Error(`Unsupported Antigravity mode "${normalized.mode}"`);
  }
  return normalized;
}
