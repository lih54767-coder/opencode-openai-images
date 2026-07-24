export const IMAGE_BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export const IMAGE_MODERATION_LEVELS = ["auto", "low"] as const;
export const IMAGE_INPUT_FIDELITIES = ["low", "high"] as const;

export type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
export type ImageModerationLevel = (typeof IMAGE_MODERATION_LEVELS)[number];
export type ImageInputFidelity = (typeof IMAGE_INPUT_FIDELITIES)[number];

export interface CommonImageDefaultsInput {
  size?: string;
  quality?: string;
  background?: ImageBackground;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
}

export interface GenerateDefaultsInput extends CommonImageDefaultsInput {
  moderation?: ImageModerationLevel;
}

export interface EditDefaultsInput extends CommonImageDefaultsInput {
  moderation?: ImageModerationLevel;
  inputFidelity?: ImageInputFidelity;
}

export type CommonImageDefaults = CommonImageDefaultsInput;
export type GenerateDefaults = GenerateDefaultsInput;
export type EditDefaults = EditDefaultsInput;

export interface ConnectionDefaultsInput {
  generate?: GenerateDefaultsInput;
  edit?: EditDefaultsInput;
}

export interface ResolvedConnectionDefaults {
  generate: GenerateDefaults;
  edit: EditDefaults;
}

export interface ConnectionCapabilitiesInput {
  edit?: boolean;
  mask?: boolean;
}

export interface ResolvedConnectionCapabilities {
  edit: boolean;
  mask: boolean;
}

export interface ConnectionInput {
  baseURL: string;
  model: string;
  description?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  capabilities?: ConnectionCapabilitiesInput;
  defaults?: ConnectionDefaultsInput;
}

export interface ResolvedTransportTarget {
  name: string;
  baseURL: string;
  model: string;
  apiKey?: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface ResolvedConnection extends ConnectionInput {
  name: string;
  headers: Record<string, string>;
  timeoutMs: number;
  capabilities: ResolvedConnectionCapabilities;
  defaults: ResolvedConnectionDefaults;
}

export interface PluginConfigInput {
  connections: Record<string, unknown>;
  defaultConnection?: unknown;
  outputDir?: unknown;
}

export interface ResolvedPluginConfig {
  connections: Record<string, ResolvedConnection>;
  defaultConnection: string;
  outputDir: string;
}
