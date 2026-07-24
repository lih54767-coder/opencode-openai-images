import { basename, posix } from "node:path";
import { FileLayerError } from "./errors.js";
import { inspectImage } from "./inspect.js";
import { MAX_IMAGE_BYTES, type PreparedImage, type RemoteAssetInput, type RemoteAssetOptions } from "./types.js";

function remoteError(code: "REMOTE_POLICY_INVALID" | "REMOTE_ASSET_INVALID" | "REMOTE_ABORTED" | "REMOTE_TIMEOUT", message: string): never {
  throw new FileLayerError(code, message);
}

interface RemoteSignalState {
  signal?: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
}

function composeRemoteSignal(options: RemoteAssetOptions): RemoteSignalState {
  const timeoutMs = options.timeoutMs;
  if (options.signal === undefined && (timeoutMs === undefined || timeoutMs <= 0)) {
    return { timedOut: () => false, cleanup: () => undefined };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  if (!controller.signal.aborted && timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
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
      options.signal?.removeEventListener("abort", onAbort);
    },
  };
}

function validateBase64(value: string, label: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    remoteError("REMOTE_ASSET_INVALID", `${label} must be strictly padded standard base64`);
  }
  if (value.length / 4 * 3 > MAX_IMAGE_BYTES + 2) {
    remoteError("REMOTE_ASSET_INVALID", `${label} exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    remoteError("REMOTE_ASSET_INVALID", `${label} is not canonical base64`);
  }
  if (decoded.byteLength > MAX_IMAGE_BYTES) {
    remoteError("REMOTE_ASSET_INVALID", `${label} exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  }
  return new Uint8Array(decoded);
}

function parseDataUrl(value: string): { bytes: Uint8Array; mimeType: string } {
  if (!value.startsWith("data:") || value.includes("\r") || value.includes("\n")) {
    remoteError("REMOTE_ASSET_INVALID", "data-url must be a single-line data URL");
  }
  const comma = value.indexOf(",");
  if (comma < 6) remoteError("REMOTE_ASSET_INVALID", "data-url is missing its payload");
  const metadata = value.slice(5, comma);
  const payload = value.slice(comma + 1);
  const parts = metadata.split(";");
  const mimeType = parts.shift() ?? "";
  if (!/^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+$/u.test(mimeType)) {
    remoteError("REMOTE_ASSET_INVALID", "data-url has an invalid MIME type");
  }
  if (parts.length !== 1 || parts[0] !== "base64") {
    remoteError("REMOTE_ASSET_INVALID", "data-url must use exactly the base64 encoding marker");
  }
  return { bytes: validateBase64(payload, "data-url payload"), mimeType };
}

function ipv4Parts(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/u.test(part))) return undefined;
  const values = parts.map((part) => Number(part));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
  return values;
}

function isReservedIpv4(hostname: string): boolean {
  const parts = ipv4Parts(hostname);
  if (!parts) return false;
  const [first, second, third] = parts as [number, number, number, number];
  return first === 0
    || first === 10
    || (first === 100 && second >= 64 && second <= 127)
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function parseIpv6(hostname: string): number[] | undefined {
  const withoutZone = hostname.split("%")[0] ?? "";
  if (!withoutZone.includes(":")) return undefined;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
  const parse = (parts: string[]): number[] | undefined => {
    const values: number[] = [];
    for (const part of parts) {
      if (!/^[0-9A-Fa-f]{1,4}$/u.test(part)) return undefined;
      values.push(Number.parseInt(part, 16));
    }
    return values;
  };
  const leftValues = parse(left);
  const rightValues = parse(right);
  if (!leftValues || !rightValues) return undefined;
  if (halves.length === 1) {
    if (leftValues.length !== 8) return undefined;
    return leftValues;
  }
  if (leftValues.length + rightValues.length >= 8) return undefined;
  return [...leftValues, ...Array.from({ length: 8 - leftValues.length - rightValues.length }, () => 0), ...rightValues];
}

function isReservedIpv6(hostname: string): boolean {
  const values = parseIpv6(hostname);
  if (!values) return false;
  const first = values[0]!;
  const second = values[1]!;
  const third = values[2]!;
  const fourth = values[3]!;
  const mappedIpv4 = first === 0 && second === 0 && third === 0 && fourth === 0 && values[4] === 0 && values[5] === 0xffff;
  if (mappedIpv4) {
    const mapped = `${values[6]! >> 8}.${values[6]! & 0xff}.${values[7]! >> 8}.${values[7]! & 0xff}`;
    return isReservedIpv4(mapped);
  }
  return (first === 0 && values.slice(1).every((value) => value === 0))
    || (first === 0 && values.slice(1).some((value) => value !== 0) && values.slice(1).every((value, index) => index === 6 ? value === 1 : value === 0))
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && second === 0x0db8)
    || (first === 0x2001 && second === 0x0002)
    || (first === 0x2001 && second === 0x0010);
}

/**
 * Validates only the URL syntax and literal-host policy. It intentionally does
 * not resolve DNS or protect against DNS rebinding; callers should add network
 * isolation or a DNS-aware egress policy when that boundary matters.
 */
export function validateRemoteAssetURL(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    remoteError("REMOTE_POLICY_INVALID", "remote asset URL is invalid");
  }
  if (url.protocol !== "https:") remoteError("REMOTE_POLICY_INVALID", "remote asset URL must use HTTPS");
  if (url.username || url.password) remoteError("REMOTE_POLICY_INVALID", "remote asset URL must not contain credentials");
  const hostname = url.hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.$/u, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    remoteError("REMOTE_POLICY_INVALID", "remote asset URL must not target localhost");
  }
  if (isReservedIpv4(hostname) || isReservedIpv6(hostname)) {
    remoteError("REMOTE_POLICY_INVALID", "remote asset URL must not target a private or reserved IP literal");
  }
  return url;
}

function extensionForMime(mimeType: PreparedImage["mimeType"]): string {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpeg" : "webp";
}

function safeUrlFilename(url: URL, mimeType: PreparedImage["mimeType"]): string {
  let candidate = "";
  try {
    candidate = basename(posix.normalize(decodeURIComponent(url.pathname)));
  } catch {
    candidate = "";
  }
  if (!candidate || candidate === "." || candidate === ".." || candidate === "/" || candidate.includes("\0") || candidate.includes("/") || candidate.includes("\\")) {
    candidate = `image.${extensionForMime(mimeType)}`;
  }
  return candidate;
}

function prepareRemoteBytes(bytes: Uint8Array, filename: string): PreparedImage {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    remoteError("REMOTE_ASSET_INVALID", `remote asset exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  }
  let inspection;
  try {
    inspection = inspectImage(bytes);
  } catch (error) {
    if (error instanceof FileLayerError) throw new FileLayerError("REMOTE_ASSET_INVALID", `remote asset is not a valid image: ${error.message}`);
    throw error;
  }
  return {
    bytes,
    filename,
    mimeType: inspection.mimeType,
    width: inspection.width,
    height: inspection.height,
    hasAlpha: inspection.hasAlpha,
  };
}

function contentLength(response: Response, url: URL): void {
  const raw = response.headers.get("content-length");
  if (raw === null) return;
  if (!/^\d+$/u.test(raw)) remoteError("REMOTE_ASSET_INVALID", `invalid Content-Length from ${url.origin}`);
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > MAX_IMAGE_BYTES) {
    remoteError("REMOTE_ASSET_INVALID", `remote response from ${url.origin} exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  }
}

async function readResponseBytes(response: Response, url: URL): Promise<Uint8Array> {
  contentLength(response, url);
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) remoteError("REMOTE_ASSET_INVALID", `remote response from ${url.origin} exceeds the ${MAX_IMAGE_BYTES} byte limit`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      total += chunk.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        remoteError("REMOTE_ASSET_INVALID", `remote response from ${url.origin} exceeds the ${MAX_IMAGE_BYTES} byte limit`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the byte-limit or stream error that caused cancellation.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function downloadRemoteAsset(urlValue: string, options: RemoteAssetOptions): Promise<PreparedImage> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") remoteError("REMOTE_ASSET_INVALID", "fetch is not available");
  const maxRedirects = options.maxRedirects ?? 3;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) {
    remoteError("REMOTE_POLICY_INVALID", "maxRedirects must be an integer from 0 through 3");
  }

  const composite = composeRemoteSignal(options);
  try {
    let url = validateRemoteAssetURL(urlValue);
    let redirects = 0;
    while (true) {
      url = validateRemoteAssetURL(url.toString());
      let response: Response;
      try {
        const requestInit: RequestInit = { redirect: "manual" };
        if (composite.signal !== undefined) requestInit.signal = composite.signal;
        response = await fetchImpl(url, requestInit);
      } catch (error) {
        if (composite.timedOut()) remoteError("REMOTE_TIMEOUT", `remote asset request timed out after ${options.timeoutMs}ms`);
        if (options.signal?.aborted) remoteError("REMOTE_ABORTED", "remote asset request was cancelled by the caller");
        if (error instanceof FileLayerError) throw error;
        remoteError("REMOTE_ASSET_INVALID", "remote asset request failed");
      }
      contentLength(response, url);
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= maxRedirects) remoteError("REMOTE_ASSET_INVALID", "remote asset exceeded the maximum of 3 redirects");
        const location = response.headers.get("location");
        if (!location) remoteError("REMOTE_ASSET_INVALID", "remote redirect is missing Location");
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, url);
        } catch {
          remoteError("REMOTE_ASSET_INVALID", "remote redirect Location is invalid");
        }
        url = validateRemoteAssetURL(nextUrl.toString());
        redirects += 1;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        remoteError("REMOTE_ASSET_INVALID", `remote asset returned HTTP ${response.status}`);
      }
      const bytes = await readResponseBytes(response, url);
      const inspection = prepareRemoteBytes(bytes, safeUrlFilename(url, "image/png"));
      return { ...inspection, filename: safeUrlFilename(url, inspection.mimeType) };
    }
  } catch (error) {
    if (error instanceof FileLayerError) throw error;
    if (composite.timedOut()) remoteError("REMOTE_TIMEOUT", `remote asset request timed out after ${options.timeoutMs}ms`);
    if (options.signal?.aborted) remoteError("REMOTE_ABORTED", "remote asset request was cancelled by the caller");
    remoteError("REMOTE_ASSET_INVALID", "remote asset request failed");
  } finally {
    composite.cleanup();
  }
}

export async function materializeRemoteAsset(input: RemoteAssetInput, options: RemoteAssetOptions = {}): Promise<PreparedImage> {
  if (!input || typeof input !== "object" || typeof input.value !== "string" || input.value.length === 0) {
    remoteError("REMOTE_ASSET_INVALID", "remote asset must contain a non-empty value");
  }
  if (input.kind === "base64") {
    const bytes = validateBase64(input.value, "base64 asset");
    const image = prepareRemoteBytes(bytes, "image.png");
    return { ...image, filename: `image.${extensionForMime(image.mimeType)}` };
  }
  if (input.kind === "data-url") {
    const parsed = parseDataUrl(input.value);
    const image = prepareRemoteBytes(parsed.bytes, "image.png");
    return { ...image, filename: `image.${extensionForMime(image.mimeType)}` };
  }
  if (input.kind === "url") return downloadRemoteAsset(input.value, options);
  remoteError("REMOTE_ASSET_INVALID", `unsupported remote asset kind: ${String((input as { kind?: unknown }).kind)}`);
}
