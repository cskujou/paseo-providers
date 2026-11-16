import { z } from "zod";
import type {
  ProviderCatalog,
  ProviderMode,
  ProviderModel,
  ProviderSessionConfig,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";

export const THINKING_OPTIONS: ProviderThinkingOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];
export const DEFAULT_MODELS: ProviderModel[] = [
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
    thinkingOptions: THINKING_OPTIONS,
    defaultThinkingOptionId: "high",
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    thinkingOptions: THINKING_OPTIONS,
    defaultThinkingOptionId: "high",
  },
  {
    id: "gpt-oss-120b-medium",
    label: "GPT-OSS 120B (Medium)",
    thinkingOptions: [],
  },
];
export const FULL_ACCESS_MODE: ProviderMode = {
  id: "full-access",
  label: "Full access",
  description:
    "Approve tool permissions without asking; chooser questions still require a selection.",
};
export const DEFAULT_MODES: ProviderMode[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Approve safe actions; ask on risky operations.",
  },
  {
    id: "default",
    label: "Default",
    description: "Ask before edits and commands.",
  },
  {
    id: "accept-edits",
    label: "Accept edits",
    description: "Approve edits; ask before commands.",
  },
  { id: "plan", label: "Plan", description: "Plan before executing a task." },
  FULL_ACCESS_MODE,
];
const choiceSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
const groupSchema = z.object({
  group: z.string(),
  name: z.string(),
  options: z.array(choiceSchema),
});
export const configOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  category: z.string().optional(),
  type: z.literal("select"),
  currentValue: z.string(),
  options: z.array(z.union([choiceSchema, groupSchema])),
});
export type AcpConfigOption = z.infer<typeof configOptionSchema>;
export const sessionResponseSchema = z.object({
  sessionId: z.string().min(1).optional(),
  configOptions: z.array(configOptionSchema).optional(),
  modes: z
    .object({
      currentModeId: z.string(),
      availableModes: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
        }),
      ),
    })
    .optional(),
  models: z
    .object({
      currentModelId: z.string(),
      availableModels: z.array(
        z.object({ modelId: z.string(), name: z.string() }),
      ),
    })
    .optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type AcpSessionResponse = z.infer<typeof sessionResponseSchema>;

export function configChoices(
  option: AcpConfigOption,
): z.infer<typeof choiceSchema>[] {
  return option.options.flatMap((entry) =>
    "options" in entry ? entry.options : [entry],
  );
}
export function findConfigOption(
  options: AcpConfigOption[],
  category: string,
): AcpConfigOption | undefined {
  return options.find(
    (option) => option.category === category || option.id === category,
  );
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
export function catalogFromResponse(
  response: AcpSessionResponse,
  fallback: ProviderCatalog,
): ProviderCatalog {
  const options = response.configOptions ?? [];
  const model = findConfigOption(options, "model");
  const thinking = findConfigOption(options, "thought_level");
  const mode = findConfigOption(options, "mode");
  const thinkingOptions = thinking
    ? configChoices(thinking).map((choice) => ({
        id: choice.value,
        label: choice.name,
      }))
    : [];
  let models: readonly ProviderModel[] = fallback.models;
  if (model) {
    models = configChoices(model).map((choice) => ({
      id: choice.value,
      label: choice.name,
      description: choice.description,
      thinkingOptions:
        choice.value === model.currentValue
          ? thinkingOptions
          : fallback.models.find((entry) => entry.id === choice.value)
              ?.thinkingOptions,
      defaultThinkingOptionId:
        fallback.models.find((entry) => entry.id === choice.value)
          ?.defaultThinkingOptionId ??
        (choice.value === model.currentValue
          ? thinking?.currentValue
          : undefined),
    }));
  } else if (response.models) {
    models = response.models.availableModels.map((entry) => ({
      id: entry.modelId,
      label: entry.name,
    }));
  }
  let modes: readonly ProviderMode[] = fallback.modes;
  if (mode)
    modes = configChoices(mode).map((choice) => ({
      id: choice.value,
      label: choice.name,
      description: choice.description,
    }));
  else if (response.modes)
    modes = response.modes.availableModes.map((entry) => ({
      id: entry.id,
      label: entry.name,
      description: entry.description,
    }));
  if (
    modes.some((entry) => entry.id === "auto") &&
    !modes.some((entry) => entry.id === "full-access")
  )
    modes = [...modes, FULL_ACCESS_MODE];
  return {
    models,
    modes,
    thinkingOptions,
    defaultModel:
      fallback.defaultModel ??
      model?.currentValue ??
      response.models?.currentModelId,
    defaultMode:
      fallback.defaultMode ??
      mode?.currentValue ??
      response.modes?.currentModeId,
    defaultThinkingOption:
      fallback.defaultThinkingOption ?? thinking?.currentValue,
  };
}

export interface NormalizedSelection {
  baseModel: string;
  thinkingOption?: string;
  mode: string;
  acpMode: string;
  autoApproveAll: boolean;
}
export function normalizeSelection(
  config: Pick<ProviderSessionConfig, "model" | "mode" | "thinkingOption">,
  catalog: ProviderCatalog = fallbackCatalog(),
): NormalizedSelection {
  let baseModel = config.model ?? catalog.defaultModel ?? "gemini-4-carbon";
  let thinkingOption =
    config.thinkingOption === "auto" ? undefined : config.thinkingOption;
  if (!catalog.models.some((model) => model.id === baseModel)) {
    const legacy = /^(.*)-(low|medium|high|xhigh|thinking)$/.exec(baseModel);
    if (legacy && catalog.models.some((model) => model.id === legacy[1])) {
      baseModel = legacy[1]!;
      thinkingOption ??= legacy[2] === "thinking" ? "high" : legacy[2];
    }
  }
  const model = catalog.models.find((entry) => entry.id === baseModel);
  thinkingOption ??= model?.defaultThinkingOptionId;
  if (model?.thinkingOptions?.length === 0) thinkingOption = undefined;
  const mode = config.mode ?? catalog.defaultMode ?? "auto";
  // agy "auto" enables the terminal sandbox. That sandbox uses a user
  // namespace and cannot enter a 0700 workspace owned by another uid, so
  // run_command dies with fork/exec permission denied. Full access approves
  // every prompt and stays on agy's unsandboxed default mode.
  const acpMode = mode === "full-access" ? "default" : mode;
  return {
    baseModel,
    thinkingOption,
    mode,
    acpMode,
    autoApproveAll: mode === "full-access",
  };
}
export function validateSelection(
  config: Pick<ProviderSessionConfig, "model" | "mode" | "thinkingOption">,
  catalog: ProviderCatalog,
): NormalizedSelection {
  const selection = normalizeSelection(config, catalog);
  const model = catalog.models.find(
    (entry) => entry.id === selection.baseModel,
  );
  if (!model)
    throw new Error(
      'Unsupported Antigravity model "' + selection.baseModel + '"',
    );
  if (!catalog.modes.some((entry) => entry.id === selection.mode))
    throw new Error('Unsupported Antigravity mode "' + selection.mode + '"');
  if (
    selection.thinkingOption &&
    model.thinkingOptions &&
    !model.thinkingOptions.some(
      (entry) => entry.id === selection.thinkingOption,
    )
  ) {
    throw new Error(
      'Unsupported Antigravity thinking level "' +
        selection.thinkingOption +
        '"',
    );
  }
  return selection;
}

function stripAnsi(text: string): string {
  /* oxlint-disable-next-line no-control-regex -- CLI output can carry terminal control bytes. */
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function catalogFromModelOutput(stdout: string): ProviderCatalog {
  const models = new Map<string, ProviderModel>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([\w.-]+)[ \t]+(.+?)\s*$/.exec(stripAnsi(line).trim());
    if (!match) continue;
    const rawId = match[1]!;
    const variant = /^(gemini-.+|claude-.+)-(low|medium|high|xhigh)$/.exec(
      rawId,
    );
    const id = variant?.[1] ?? rawId;
    const paren = variant ? /\s*\(([^)]+)\)$/.exec(match[2]!) : null;
    let model = models.get(id);
    if (!model) {
      model = {
        id,
        label: paren ? match[2]!.slice(0, paren.index).trimEnd() : match[2]!,
        thinkingOptions: [],
      };
      models.set(id, model);
    }
    if (variant) {
      model.thinkingOptions!.push({
        id: variant[2]!,
        label: paren?.[1] ?? variant[2]!,
      });
      model.defaultThinkingOptionId ??= variant[2];
    }
  }
  if (models.size === 0)
    throw new Error("Antigravity returned an empty model catalog");
  const list = [...models.values()];
  return {
    models: list,
    modes: DEFAULT_MODES,
    thinkingOptions: THINKING_OPTIONS,
    defaultModel: list[0]!.id,
    defaultMode: "auto",
    defaultThinkingOption: list[0]!.defaultThinkingOptionId,
  };
}
