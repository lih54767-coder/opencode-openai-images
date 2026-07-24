import { randomUUID } from "node:crypto";
import { lstat, link, open, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { FileLayerError, isNodeError } from "./errors.js";
import { inspectImage } from "./inspect.js";
import { ensureOutputDirectory, isContained, normalizeWorkspaceRelativePath, resolveWorkspaceRoot } from "./paths.js";
import { MAX_IMAGE_BYTES, type ImageMimeType, type OutputOptions, type PreparedImage, type WorkspaceContext, type WrittenImage } from "./types.js";

function extensionForMime(mimeType: ImageMimeType): string {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpeg" : "webp";
}

function replaceExtension(filename: string, mimeType: ImageMimeType): string {
  const extension = `.${extensionForMime(mimeType)}`;
  const currentExtension = extname(filename);
  const stem = currentExtension.length > 0 ? filename.slice(0, -currentExtension.length) : filename;
  return `${stem || "image"}${extension}`;
}

function versionedFilename(filename: string, version: number): string {
  if (version === 1) return filename;
  const extension = extname(filename);
  const stem = extension.length > 0 ? filename.slice(0, -extension.length) : filename;
  return `${stem}-v${version}${extension}`;
}

const MAX_OUTPUT_VERSIONS = 10_000;
const OUTPUT_MIME_TYPES: readonly ImageMimeType[] = ["image/png", "image/jpeg", "image/webp"];

function outputCandidatePath(directory: string, filename: string, version: number): string {
  return join(directory, versionedFilename(filename, version));
}

async function rejectSymlinkCandidate(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new FileLayerError("OUTPUT_INVALID", `output path must not be a symlink: ${path}`);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

async function candidateExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function assertCandidateChainAvailable(directory: string, filename: string): Promise<void> {
  for (let version = 1; version < MAX_OUTPUT_VERSIONS; version += 1) {
    const candidate = outputCandidatePath(directory, filename, version);
    await rejectSymlinkCandidate(candidate);
    if (!(await candidateExists(candidate))) return;
  }
  throw new FileLayerError("OUTPUT_INVALID", "too many versioned output name collisions");
}

async function writeAtomicNonOverwriting(directory: string, filename: string, bytes: Uint8Array): Promise<{ path: string; version: number }> {
  for (let version = 1; version < MAX_OUTPUT_VERSIONS; version += 1) {
    const candidate = outputCandidatePath(directory, filename, version);
    await rejectSymlinkCandidate(candidate);
    if (await candidateExists(candidate)) continue;

    const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        const writeResult = await handle.write(bytes);
        if (writeResult.bytesWritten !== bytes.byteLength) {
          throw new FileLayerError("OUTPUT_INVALID", "output write was incomplete");
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, candidate);
      await unlink(temporary);
      return { path: candidate, version };
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError, "ENOENT")) throw cleanupError;
      }
      if (isNodeError(error, "EEXIST")) {
        await rejectSymlinkCandidate(candidate);
        continue;
      }
      if (error instanceof FileLayerError) throw error;
      throw new FileLayerError("OUTPUT_INVALID", `cannot atomically create output: ${String(error)}`);
    }
  }
  throw new FileLayerError("OUTPUT_INVALID", "too many versioned output name collisions");
}

function outputRelativePath(options: OutputOptions, mimeType: ImageMimeType): { directory: string; filename: string } {
  const outputDir = options.outputDir ?? "outputs";
  const normalizedOutputDir = normalizeWorkspaceRelativePath(outputDir, "outputDir");
  if (options.out === undefined) return { directory: normalizedOutputDir, filename: `image.${extensionForMime(mimeType)}` };
  const normalizedOut = normalizeWorkspaceRelativePath(options.out, "out");
  if (normalizedOut === ".") throw new FileLayerError("OUTPUT_INVALID", "out must name a file");
  return { directory: dirname(normalizedOut), filename: replaceExtension(basename(normalizedOut), mimeType) };
}

export async function validateOutputTarget(context: WorkspaceContext, options: OutputOptions = {}): Promise<void> {
  const root = await resolveWorkspaceRoot(context);
  const relativeOutput = outputRelativePath(options, "image/png");
  const directory = await ensureOutputDirectory(root, relativeOutput.directory);
  const requestedName = options.out === undefined
    ? "image.png"
    : basename(normalizeWorkspaceRelativePath(options.out, "out"));
  for (const mimeType of OUTPUT_MIME_TYPES) {
    await assertCandidateChainAvailable(directory, replaceExtension(requestedName, mimeType));
  }
}

export async function writeOutput(
  context: WorkspaceContext,
  image: Uint8Array | PreparedImage,
  options: OutputOptions = {},
): Promise<WrittenImage> {
  const root = await resolveWorkspaceRoot(context);
  const bytes = image instanceof Uint8Array ? image : image.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new FileLayerError("OUTPUT_INVALID", `output image must be a Uint8Array no larger than ${MAX_IMAGE_BYTES} bytes`);
  }
  let inspection;
  try {
    inspection = inspectImage(bytes);
  } catch (error) {
    if (error instanceof FileLayerError) throw new FileLayerError("OUTPUT_INVALID", `output is not a valid image: ${error.message}`);
    throw error;
  }

  const relativeOutput = outputRelativePath(options, inspection.mimeType);
  const directory = await ensureOutputDirectory(root, relativeOutput.directory);
  const result = await writeAtomicNonOverwriting(directory, relativeOutput.filename, bytes);
  const absolutePath = await import("node:fs/promises").then(({ realpath }) => realpath(result.path));
  if (!isContained(root, absolutePath)) {
    throw new FileLayerError("OUTPUT_INVALID", "output path escapes the session workspace");
  }
  return {
    path: absolutePath,
    mimeType: inspection.mimeType,
    width: inspection.width,
    height: inspection.height,
    byteLength: bytes.byteLength,
    versioned: result.version > 1,
  };
}
