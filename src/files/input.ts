import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { FileLayerError } from "./errors.js";
import { inspectImage } from "./inspect.js";
import { resolveInputFile } from "./paths.js";
import { MAX_IMAGE_BYTES, type PreparedImage, type WorkspaceContext } from "./types.js";

export async function prepareInput(context: WorkspaceContext, input: string): Promise<PreparedImage> {
  const resolved = await resolveInputFile(context, input);
  let fileStat;
  try {
    fileStat = await stat(resolved.path);
  } catch (error) {
    throw new FileLayerError("FILE_INPUT_INVALID", `input file cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (fileStat.size > MAX_IMAGE_BYTES) {
    throw new FileLayerError("FILE_INPUT_INVALID", `input file exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  }
  let file;
  try {
    file = await readFile(resolved.path);
  } catch (error) {
    throw new FileLayerError("FILE_INPUT_INVALID", `input file cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (file.byteLength > MAX_IMAGE_BYTES) {
    throw new FileLayerError("FILE_INPUT_INVALID", `input file exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  }
  let inspection;
  try {
    inspection = inspectImage(file);
  } catch (error) {
    if (error instanceof FileLayerError) throw new FileLayerError("FILE_INPUT_INVALID", `input file is not a valid image: ${error.message}`);
    throw error;
  }
  return {
    bytes: new Uint8Array(file),
    filename: basename(resolved.path),
    mimeType: inspection.mimeType,
    width: inspection.width,
    height: inspection.height,
    hasAlpha: inspection.hasAlpha,
  };
}

export async function prepareMask(
  context: WorkspaceContext,
  maskInput: string,
  firstImage: Pick<PreparedImage, "width" | "height">,
): Promise<PreparedImage> {
  const mask = await prepareInput(context, maskInput);
  if (mask.mimeType !== "image/png") {
    throw new FileLayerError("MASK_INVALID", "mask must be a PNG image");
  }
  if (!mask.hasAlpha) throw new FileLayerError("MASK_INVALID", "mask PNG must contain an alpha channel");
  if (mask.width !== firstImage.width || mask.height !== firstImage.height) {
    throw new FileLayerError(
      "MASK_INVALID",
      `mask dimensions ${mask.width}x${mask.height} must match the first image ${firstImage.width}x${firstImage.height}`,
    );
  }
  return mask;
}
