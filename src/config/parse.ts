import { ConfigError } from "./errors.js";
import {
  IMAGE_BACKGROUNDS,
  IMAGE_INPUT_FIDELITIES,
  IMAGE_MODERATION_LEVELS,
  IMAGE_OUTPUT_FORMATS,
  type EditDefaults,
  type GenerateDefaults,
  type ResolvedConnection,
  type ResolvedConnectionCapabilities,
  type ResolvedConnectionDefaults,
  type ResolvedPluginConfig,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_OUTPUT_DIR = "outputs";
const MAX_CONNECTION_NAME_LENGTH = 64;
const MAX_CONNECTION_DESCRIPTION_LENGTH = 256;
const MAX_MODEL_LENGTH = 256;
const MAX_IMAGE_PARAMETER_LENGTH = 64;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new ConfigError(`${path} must be an object`);
}

function assertKnownFields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${path}.${key} is not supported (unknown fields are rejected)`);
    }
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function boundedString(value: unknown, path: string, maxLength = MAX_IMAGE_PARAMETER_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || CONTROL_CHARACTER_RE.test(value)) {
    throw new ConfigError(`${path} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    throw new ConfigError(`${path} must be one of: ${values.join(", ")}`);
  }
  return value as T[number];
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be a boolean`);
  return value;
}

function optionalInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_SET_TIMEOUT_MS) {
    throw new ConfigError(`${path} must be a positive safe integer no greater than ${MAX_SET_TIMEOUT_MS}`);
  }
  return value;
}

function optionalCompression(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new ConfigError(`${path} must be an integer between 0 and 100`);
  }
  return value;
}

function setIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function validateConnectionName(name: string, path: string): string {
  if (name.length === 0 || name !== name.trim()) {
    throw new ConfigError(`${path} must be non-empty and must not have leading or trailing whitespace`);
  }
  if (name.length > MAX_CONNECTION_NAME_LENGTH) {
    throw new ConfigError(`${path} must be at most ${MAX_CONNECTION_NAME_LENGTH} characters`);
  }
  if (CONTROL_CHARACTER_RE.test(name)) {
    throw new ConfigError(`${path} must not contain control characters`);
  }
  return name;
}

export function normalizeBaseURL(value: unknown, path = "baseURL"): string {
  const baseURL = requiredString(value, path);
  if (/\s/.test(baseURL)) throw new ConfigError(`${path} must not contain whitespace`);

  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new ConfigError(`${path} must be an absolute http/https URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`${path} must use http or https`);
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigError(`${path} must be an API root without credentials, query, or fragment`);
  }

  return baseURL.replace(/\/+$/, "");
}

function parseHeaders(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  assertRecord(value, path);
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, rawValue] of Object.entries(value)) {
    if (!HTTP_TOKEN_RE.test(name)) throw new ConfigError(`${path} contains an invalid HTTP token header name: ${name || "<empty>"}`);
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new ConfigError(`${path}.${name} is forbidden`);
    if (typeof rawValue !== "string" || CONTROL_CHARACTER_RE.test(rawValue)) {
      throw new ConfigError(`${path}.${name} must be a string without control characters`);
    }
    headers[name] = rawValue;
  }
  return headers;
}

function parseCapabilities(value: unknown, path: string): ResolvedConnectionCapabilities {
  if (value === undefined) return { edit: true, mask: true };
  assertRecord(value, path);
  assertKnownFields(value, ["edit", "mask"], path);
  const edit = optionalBoolean(value.edit, `${path}.edit`) ?? true;
  const capabilities: ResolvedConnectionCapabilities = {
    edit,
    mask: optionalBoolean(value.mask, `${path}.mask`) ?? edit,
  };
  if (!capabilities.edit && capabilities.mask) {
    throw new ConfigError(`${path} cannot set edit=false while mask=true`);
  }
  return capabilities;
}

function rejectPngCompression(outputFormat: string | undefined, outputCompression: number | undefined, path: string): void {
  if (outputCompression !== undefined && (outputFormat === undefined || !["jpeg", "webp"].includes(outputFormat))) {
    throw new ConfigError(`${path} requires outputCompression to use outputFormat jpeg or webp`);
  }
}

function parseCommonDefaults(value: unknown, path: string): {
  size?: string;
  quality?: string;
  background?: (typeof IMAGE_BACKGROUNDS)[number];
  outputFormat?: (typeof IMAGE_OUTPUT_FORMATS)[number];
  outputCompression?: number;
} {
  assertRecord(value, path);
  assertKnownFields(value, ["size", "quality", "background", "outputFormat", "outputCompression", "moderation", "inputFidelity"], path);
  const size = boundedString(value.size, `${path}.size`);
  const quality = boundedString(value.quality, `${path}.quality`);
  const background = oneOf(value.background, IMAGE_BACKGROUNDS, `${path}.background`);
  const outputFormat = oneOf(value.outputFormat, IMAGE_OUTPUT_FORMATS, `${path}.outputFormat`);
  const outputCompression = optionalCompression(value.outputCompression, `${path}.outputCompression`);
  rejectPngCompression(outputFormat, outputCompression, path);
  const defaults: {
    size?: string;
    quality?: string;
    background?: (typeof IMAGE_BACKGROUNDS)[number];
    outputFormat?: (typeof IMAGE_OUTPUT_FORMATS)[number];
    outputCompression?: number;
  } = {};
  setIfDefined(defaults, "size", size);
  setIfDefined(defaults, "quality", quality);
  setIfDefined(defaults, "background", background);
  setIfDefined(defaults, "outputFormat", outputFormat);
  setIfDefined(defaults, "outputCompression", outputCompression);
  return defaults;
}

function parseGenerateDefaults(value: unknown, path: string): GenerateDefaults | undefined {
  if (value === undefined) return undefined;
  const common = parseCommonDefaults(value, path) as GenerateDefaults;
  assertRecord(value, path);
  const moderation = oneOf(value.moderation, IMAGE_MODERATION_LEVELS, `${path}.moderation`);
  setIfDefined(common, "moderation", moderation);
  if (Object.hasOwn(value, "inputFidelity")) {
    throw new ConfigError(`${path}.inputFidelity is only valid for edit defaults`);
  }
  return common;
}

function parseEditDefaults(value: unknown, path: string): EditDefaults | undefined {
  if (value === undefined) return undefined;
  const common = parseCommonDefaults(value, path) as EditDefaults;
  assertRecord(value, path);
  const moderation = oneOf(value.moderation, IMAGE_MODERATION_LEVELS, `${path}.moderation`);
  const inputFidelity = oneOf(value.inputFidelity, IMAGE_INPUT_FIDELITIES, `${path}.inputFidelity`);
  setIfDefined(common, "moderation", moderation);
  setIfDefined(common, "inputFidelity", inputFidelity);
  return common;
}

function parseDefaults(value: unknown, path: string): ResolvedConnectionDefaults {
  if (value === undefined) return { generate: {}, edit: {} };
  assertRecord(value, path);
  assertKnownFields(value, ["generate", "edit"], path);
  return {
    generate: parseGenerateDefaults(value.generate, `${path}.generate`) ?? {},
    edit: parseEditDefaults(value.edit, `${path}.edit`) ?? {},
  };
}

function parseConnection(name: string, value: unknown, path: string): ResolvedConnection {
  assertRecord(value, path);
  assertKnownFields(value, ["baseURL", "model", "description", "apiKey", "headers", "timeoutMs", "capabilities", "defaults"], path);

  const apiKey = optionalString(value.apiKey, `${path}.apiKey`);
  if (apiKey !== undefined && CONTROL_CHARACTER_RE.test(apiKey)) {
    throw new ConfigError(`${path}.apiKey must not contain control characters`);
  }
  const headers = parseHeaders(value.headers, `${path}.headers`);
  if (apiKey !== undefined && Object.keys(headers).some((header) => header.toLowerCase() === "authorization")) {
    throw new ConfigError(`${path} cannot define both apiKey and headers.Authorization`);
  }

  const description = optionalString(value.description, `${path}.description`);
  if (description !== undefined && (description.length > MAX_CONNECTION_DESCRIPTION_LENGTH || CONTROL_CHARACTER_RE.test(description))) {
    throw new ConfigError(`${path}.description must be at most ${MAX_CONNECTION_DESCRIPTION_LENGTH} characters without control characters`);
  }
  const model = requiredString(value.model, `${path}.model`);
  if (model.length > MAX_MODEL_LENGTH || CONTROL_CHARACTER_RE.test(model)) {
    throw new ConfigError(`${path}.model must be at most ${MAX_MODEL_LENGTH} characters without control characters`);
  }
  const connection: ResolvedConnection = {
    name,
    baseURL: normalizeBaseURL(value.baseURL, `${path}.baseURL`),
    model,
    headers,
    timeoutMs: optionalInteger(value.timeoutMs, `${path}.timeoutMs`) ?? DEFAULT_TIMEOUT_MS,
    capabilities: parseCapabilities(value.capabilities, `${path}.capabilities`),
    defaults: parseDefaults(value.defaults, `${path}.defaults`),
  };
  setIfDefined(connection, "description", description);
  setIfDefined(connection, "apiKey", apiKey);
  return connection;
}

function parseOutputDir(value: unknown): string {
  if (value === undefined) return DEFAULT_OUTPUT_DIR;
  const outputDir = requiredString(value, "outputDir");
  if (outputDir.includes("\0") || outputDir.startsWith("/") || outputDir.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(outputDir)) {
    throw new ConfigError("outputDir must be a relative path inside the workspace");
  }
  if (outputDir.split(/[\\/]+/).includes("..")) {
    throw new ConfigError("outputDir must not contain '..' path segments");
  }
  return outputDir;
}

export function parsePluginConfig(input: unknown): ResolvedPluginConfig {
  assertRecord(input, "config");
  assertKnownFields(input, ["connections", "defaultConnection", "outputDir"], "config");
  assertRecord(input.connections, "connections");

  const names = Object.keys(input.connections).map((name) => validateConnectionName(name, `connections.${name}`));
  if (names.length === 0) throw new ConfigError("connections must be a non-empty map");

  const connections: Record<string, ResolvedConnection> = Object.create(null) as Record<string, ResolvedConnection>;
  for (const name of names) connections[name] = parseConnection(name, input.connections[name], `connections.${name}`);

  let defaultConnection: string;
  if (input.defaultConnection !== undefined) {
    defaultConnection = validateConnectionName(requiredString(input.defaultConnection, "defaultConnection"), "defaultConnection");
    if (!Object.hasOwn(connections, defaultConnection)) {
      throw new ConfigError(`defaultConnection '${defaultConnection}' does not exist in connections`);
    }
  } else if (names.length === 1) {
    defaultConnection = names[0]!;
  } else {
    throw new ConfigError("defaultConnection is required when connections has more than one entry");
  }

  return { connections, defaultConnection, outputDir: parseOutputDir(input.outputDir) };
}
