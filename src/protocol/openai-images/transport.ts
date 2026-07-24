import type { ResolvedTransportTarget } from "../../config/types.js";
import {
  ImagesTransportError,
  ImagesTransportAbortError,
  ImagesTransportHttpError,
  ImagesTransportInputError,
  ImagesTransportNetworkError,
  ImagesTransportResponseError,
  ImagesTransportTimeoutError,
} from "./errors.js";
import type {
  EditImageRequest,
  GenerateImageRequest,
  ImagesTransport,
  NormalizedRemoteAsset,
  NormalizedRemoteAssets,
  PreparedImageInput,
} from "./types.js";

const GENERATIONS_PATH = "images/generations";
const EDITS_PATH = "images/edits";
const DEFAULT_ERROR_BODY_LIMIT = 8 * 1024;
// 50 MiB decoded bytes need at most ceil(50 MiB / 3) * 4 ≈ 66.7 MiB of padded
// base64. 72 MiB leaves room for JSON keys, revised_prompt, and per-item metadata.
export const MAX_SUCCESS_RESPONSE_BYTES = 72 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_REQUEST_ID_LENGTH = 256;
const DEFAULT_TIMEOUT_MS = 600_000;

export type OpenAIImagesFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAIImagesTransportOptions {
  fetch?: OpenAIImagesFetch;
  errorBodyLimitBytes?: number;
  /** Internal contract-test override; not a user plugin configuration field. */
  successBodyLimitBytes?: number;
}

interface CompositeSignal {
  signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
}

interface BodyText {
  text: string;
  truncated: boolean;
}

function endpoint(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path}`;
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function generationPayload(request: GenerateImageRequest, target: ResolvedTransportTarget): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: target.model,
    prompt: request.prompt,
    n: 1,
  };
  setIfDefined(payload, "size", request.size);
  setIfDefined(payload, "quality", request.quality);
  setIfDefined(payload, "background", request.background);
  setIfDefined(payload, "output_format", request.outputFormat);
  setIfDefined(payload, "output_compression", request.outputCompression);
  setIfDefined(payload, "moderation", request.moderation);
  return payload;
}

function preparedInput(input: PreparedImageInput, field: string): PreparedImageInput {
  if (typeof input !== "object" || input === null) {
    throw new ImagesTransportInputError(`${field} must be prepared binary input; local paths are not read by transport`);
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new ImagesTransportInputError(`${field}.bytes must be a non-empty Uint8Array`);
  }
  if (typeof input.filename !== "string" || input.filename.length === 0) {
    throw new ImagesTransportInputError(`${field}.filename must be a non-empty string`);
  }
  if (typeof input.mimeType !== "string" || input.mimeType.length === 0) {
    throw new ImagesTransportInputError(`${field}.mimeType must be a non-empty string`);
  }
  return input;
}

function blobFor(input: PreparedImageInput, field: string): Blob {
  const prepared = preparedInput(input, field);
  return new Blob([prepared.bytes as unknown as BlobPart], { type: prepared.mimeType });
}

function editForm(request: EditImageRequest, target: ResolvedTransportTarget): FormData {
  const form = new FormData();
  form.append("model", target.model);
  form.append("prompt", request.prompt);
  form.append("n", "1");
  setFormValue(form, "size", request.size);
  setFormValue(form, "quality", request.quality);
  setFormValue(form, "background", request.background);
  setFormValue(form, "output_format", request.outputFormat);
  setFormValue(form, "output_compression", request.outputCompression);
  setFormValue(form, "moderation", request.moderation);
  setFormValue(form, "input_fidelity", request.inputFidelity);

  request.images.forEach((input, index) => {
    const prepared = preparedInput(input, `images[${index}]`);
    form.append("image[]", blobFor(prepared, `images[${index}]`), prepared.filename);
  });
  if (request.mask !== undefined) {
    const prepared = preparedInput(request.mask, "mask");
    form.append("mask", blobFor(prepared, "mask"), prepared.filename);
  }
  return form;
}

function setFormValue(form: FormData, key: string, value: unknown): void {
  if (value !== undefined) form.append(key, String(value));
}

function requestHeaders(target: ResolvedTransportTarget, json: boolean): Headers {
  const headers = new Headers(target.headers);
  headers.set("Accept", "application/json");
  if (target.apiKey !== undefined) headers.set("Authorization", `Bearer ${target.apiKey}`);
  if (json) {
    headers.set("Content-Type", "application/json");
  } else {
    headers.delete("Content-Type");
  }
  return headers;
}

function compositeSignal(userSignal: AbortSignal, timeoutMs: number): CompositeSignal {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onUserAbort = () => controller.abort(userSignal.reason);
  if (userSignal.aborted) {
    controller.abort(userSignal.reason);
  } else {
    userSignal.addEventListener("abort", onUserAbort, { once: true });
  }
  if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      userSignal.removeEventListener("abort", onUserAbort);
    },
  };
}

function effectiveTimeout(target: ResolvedTransportTarget): number {
  return Number.isFinite(target.timeoutMs) && target.timeoutMs > 0 ? target.timeoutMs : DEFAULT_TIMEOUT_MS;
}

function redactSecrets(value: string, target: ResolvedTransportTarget): string {
  const secrets = [target.baseURL, target.apiKey, ...Object.values(target.headers)]
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length);
  return secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
}

async function readBodyText(
  response: Response,
  signal: AbortSignal,
  limit: number,
  rejectOnLimit: boolean,
): Promise<BodyText> {
  throwIfAborted(signal);
  if (!response.body) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ImagesTransportResponseError("Unable to read the response body.", response.status);
    }
    throwIfAborted(signal);
    if (bytes.byteLength > limit && rejectOnLimit) {
      throw new ImagesTransportResponseError(`Response body exceeds the ${limit} byte limit.`, response.status);
    }
    const truncated = bytes.byteLength > limit;
    return { text: new TextDecoder().decode(truncated ? bytes.subarray(0, limit) : bytes), truncated };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ImagesTransportResponseError("Unable to read the response body.", response.status);
      }
      if (result.done) break;
      throwIfAborted(signal);
      const remaining = limit - total;
      if (remaining <= 0) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // The limit error is the useful failure for a completed response.
        }
        if (rejectOnLimit) throw new ImagesTransportResponseError(`Response body exceeds the ${limit} byte limit.`, response.status);
        break;
      }
      const chunk = result.value;
      const accepted = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
      chunks.push(accepted);
      total += accepted.byteLength;
      if (accepted.byteLength < chunk.byteLength) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-body result.
        }
        if (rejectOnLimit) throw new ImagesTransportResponseError(`Response body exceeds the ${limit} byte limit.`, response.status);
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  throwIfAborted(signal);
  return { text: new TextDecoder().decode(bytes), truncated };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rawStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function redactAndClip(value: string, target: ResolvedTransportTarget, limit: number): string {
  return clip(redactSecrets(value, target), limit);
}

function providerErrorDetails(body: string, response: Response, target: ResolvedTransportTarget): {
  message: string;
  providerCode?: string;
  providerType?: string;
  requestId?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const root = record(parsed);
  const nested = record(root?.error) ?? root;
  const rawMessage = rawStringValue(nested?.message)
    ?? rawStringValue(root?.message)
    ?? (body.length > 0 ? body : "Upstream returned an error response.");
  const headerRequestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
  const requestId = rawStringValue(headerRequestId ?? nested?.request_id ?? nested?.requestId ?? root?.request_id);
  const details: {
    message: string;
    providerCode?: string;
    providerType?: string;
    requestId?: string;
  } = { message: redactAndClip(rawMessage, target, MAX_ERROR_MESSAGE_LENGTH) };
  const providerCodeValue = rawStringValue(nested?.code ?? root?.code);
  const providerTypeValue = rawStringValue(nested?.type ?? root?.type);
  const providerCode = providerCodeValue === undefined ? undefined : redactAndClip(providerCodeValue, target, MAX_ERROR_MESSAGE_LENGTH);
  const providerType = providerTypeValue === undefined ? undefined : redactAndClip(providerTypeValue, target, MAX_ERROR_MESSAGE_LENGTH);
  if (providerCode !== undefined) details.providerCode = providerCode;
  if (providerType !== undefined) details.providerType = providerType;
  if (requestId !== undefined) details.requestId = redactAndClip(requestId, target, MAX_REQUEST_ID_LENGTH);
  return details;
}

function requestIdFromResponse(response: Response, target: ResolvedTransportTarget): string | undefined {
  const value = response.headers.get("x-request-id") ?? response.headers.get("request-id");
  return value === null ? undefined : redactAndClip(value, target, MAX_REQUEST_ID_LENGTH);
}

function throwForHttp(response: Response, body: BodyText, target: ResolvedTransportTarget): never {
  if (body.truncated) {
    const requestId = requestIdFromResponse(response, target);
    const details: { status: number; message: string; requestId?: string } = {
      status: response.status,
      message: "Upstream error response body was truncated; provider error details unavailable.",
    };
    if (requestId !== undefined) details.requestId = requestId;
    throw new ImagesTransportHttpError(details);
  }
  const providerDetails = providerErrorDetails(body.text, response, target);
  const details: {
    status: number;
    message: string;
    providerCode?: string;
    providerType?: string;
    requestId?: string;
  } = {
    status: response.status,
    message: providerDetails.message,
  };
  if (providerDetails.providerCode !== undefined) details.providerCode = providerDetails.providerCode;
  if (providerDetails.providerType !== undefined) details.providerType = providerDetails.providerType;
  if (providerDetails.requestId !== undefined) details.requestId = providerDetails.requestId;
  throw new ImagesTransportHttpError(details);
}

function parseDataURL(value: string): { kind: "data-url"; value: string; mimeType?: string } | undefined {
  if (!/^data:/i.test(value)) return undefined;
  const match = /^data:([^;,]*)(?:;[^,]*)?,/i.exec(value);
  if (!match) throw new ImagesTransportResponseError("Response contained an invalid data URL.");
  const asset: { kind: "data-url"; value: string; mimeType?: string } = { kind: "data-url", value };
  if (match[1]) asset.mimeType = match[1];
  return asset;
}

function normalizeURL(value: string): NormalizedRemoteAsset {
  const dataURL = parseDataURL(value);
  if (dataURL) return dataURL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ImagesTransportResponseError("Response contained an invalid image URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ImagesTransportResponseError("Response contained an unsupported image URL.");
  }
  return { kind: "url", value };
}

function normalizeRemoteAssets(payload: unknown, status: number): NormalizedRemoteAssets {
  const root = record(payload);
  if (!root || !Array.isArray(root.data) || root.data.length === 0) {
    throw new ImagesTransportResponseError("Response must contain a non-empty data array.", status);
  }

  const assets: NormalizedRemoteAsset[] = [];
  const rootRevisedPrompt = rawStringValue(root.revised_prompt);
  let revisedPrompt = rootRevisedPrompt === undefined ? undefined : clip(rootRevisedPrompt, MAX_ERROR_MESSAGE_LENGTH);
  for (const [index, rawItem] of root.data.entries()) {
    const item = record(rawItem);
    if (!item) throw new ImagesTransportResponseError(`Response data item ${index} is invalid.`, status);
    const base64 = item.b64_json;
    const urlValue = item.url ?? item.data_url;
    if (base64 !== undefined && urlValue !== undefined) {
      throw new ImagesTransportResponseError(`Response data item ${index} contains multiple asset forms.`, status);
    }
    if (typeof base64 === "string" && base64.length > 0) {
      assets.push({ kind: "base64", value: base64 });
    } else if (typeof urlValue === "string" && urlValue.length > 0) {
      assets.push(normalizeURL(urlValue));
    } else {
      throw new ImagesTransportResponseError(`Response data item ${index} contains no supported image asset.`, status);
    }
    const itemRevisedPrompt = rawStringValue(item.revised_prompt);
    revisedPrompt ??= itemRevisedPrompt === undefined ? undefined : clip(itemRevisedPrompt, MAX_ERROR_MESSAGE_LENGTH);
  }

  return revisedPrompt === undefined ? { assets } : { assets, revisedPrompt };
}

function assertSuccessContentLength(response: Response, limit: number): void {
  const raw = response.headers.get("content-length");
  if (raw === null) return;
  if (!/^\d+$/u.test(raw)) throw new ImagesTransportResponseError("Response Content-Length was invalid.", response.status);
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > limit) {
    throw new ImagesTransportResponseError(`Response body exceeds the ${limit} byte limit.`, response.status);
  }
}

async function responsePayload(
  response: Response,
  target: ResolvedTransportTarget,
  signal: AbortSignal,
  errorBodyLimit: number,
  successBodyLimit: number,
): Promise<NormalizedRemoteAssets> {
  if (!response.ok) {
    const body = await readBodyText(response, signal, errorBodyLimit, false);
    throwForHttp(response, body, target);
  }
  assertSuccessContentLength(response, successBodyLimit);
  const body = await readBodyText(response, signal, successBodyLimit, true);
  throwIfAborted(signal);
  let payload: unknown;
  try {
    payload = JSON.parse(body.text);
  } catch {
    throw new ImagesTransportResponseError("Response body was not valid JSON.", response.status);
  }
  return normalizeRemoteAssets(payload, response.status);
}

async function perform(
  fetchImpl: OpenAIImagesFetch,
  url: string,
  init: RequestInit,
  target: ResolvedTransportTarget,
  signal: AbortSignal,
  errorBodyLimit: number,
  successBodyLimit: number,
): Promise<NormalizedRemoteAssets> {
  const timeout = effectiveTimeout(target);
  if (signal.aborted) throw new ImagesTransportAbortError();
  const composite = compositeSignal(signal, timeout);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: composite.signal });
    } catch {
      if (composite.timedOut()) throw new ImagesTransportTimeoutError(timeout);
      if (signal.aborted) throw new ImagesTransportAbortError();
      throw new ImagesTransportNetworkError();
    }
    if (composite.timedOut()) throw new ImagesTransportTimeoutError(timeout);
    if (signal.aborted) throw new ImagesTransportAbortError();
    return await responsePayload(response, target, composite.signal, errorBodyLimit, successBodyLimit);
  } catch (error) {
    if (composite.timedOut()) throw new ImagesTransportTimeoutError(timeout);
    if (signal.aborted) throw new ImagesTransportAbortError();
    if (error instanceof ImagesTransportError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw new ImagesTransportNetworkError();
    throw error;
  } finally {
    composite.cleanup();
  }
}

export function createOpenAIImagesTransport(fetch: OpenAIImagesFetch): ImagesTransport;
export function createOpenAIImagesTransport(options?: OpenAIImagesTransportOptions): ImagesTransport;
export function createOpenAIImagesTransport(options: OpenAIImagesTransportOptions | OpenAIImagesFetch = {}): ImagesTransport {
  const fetchImpl = typeof options === "function" ? options : options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new ImagesTransportNetworkError();
  const errorBodyLimit = typeof options === "function"
    ? DEFAULT_ERROR_BODY_LIMIT
    : options.errorBodyLimitBytes ?? DEFAULT_ERROR_BODY_LIMIT;
  const successBodyLimit = typeof options === "function"
    ? MAX_SUCCESS_RESPONSE_BYTES
    : options.successBodyLimitBytes ?? MAX_SUCCESS_RESPONSE_BYTES;

  return {
    generate(request, target, signal) {
      return perform(
        fetchImpl,
        endpoint(target.baseURL, GENERATIONS_PATH),
        {
          method: "POST",
          headers: requestHeaders(target, true),
          body: JSON.stringify(generationPayload(request, target)),
        },
        target,
        signal,
        errorBodyLimit,
        successBodyLimit,
      );
    },
    async edit(request, target, signal) {
      request.images.forEach((input, index) => preparedInput(input, `images[${index}]`));
      if (request.mask !== undefined) preparedInput(request.mask, "mask");
      return perform(
        fetchImpl,
        endpoint(target.baseURL, EDITS_PATH),
        {
          method: "POST",
          headers: requestHeaders(target, false),
          body: editForm(request, target),
        },
        target,
        signal,
        errorBodyLimit,
        successBodyLimit,
      );
    },
  };
}
