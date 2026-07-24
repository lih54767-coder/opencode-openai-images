export type FileLayerErrorCode =
  | "FILE_INPUT_INVALID"
  | "IMAGE_INVALID"
  | "MASK_INVALID"
  | "REMOTE_POLICY_INVALID"
  | "REMOTE_ASSET_INVALID"
  | "REMOTE_ABORTED"
  | "REMOTE_TIMEOUT"
  | "OUTPUT_INVALID";

export class FileLayerError extends Error {
  constructor(
    readonly code: FileLayerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FileLayerError";
  }
}

export function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}
