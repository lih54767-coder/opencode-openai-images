export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export type ImageFormat = "png" | "jpeg" | "webp";
export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageInspection {
  format: ImageFormat;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  hasAlpha: boolean;
}

export interface PreparedImage {
  bytes: Uint8Array;
  filename: string;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  hasAlpha: boolean;
}

export interface WorkspaceContext {
  readonly directory: string;
}

/** Compatible with the normalized asset shape produced by the image transport. */
export interface RemoteAssetInput {
  readonly kind: "base64" | "data-url" | "url";
  readonly value: string;
  readonly mimeType?: string;
}

export interface RemoteAssetOptions {
  /** Injectable for tests or callers that own the network boundary. */
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

export interface OutputOptions {
  /** Workspace-relative directory used when `out` is omitted. */
  readonly outputDir?: string;
  /** Explicit workspace-relative output path. It takes precedence over outputDir. */
  readonly out?: string;
}

export interface WrittenImage {
  readonly path: string;
  readonly mimeType: ImageMimeType;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly versioned: boolean;
}
