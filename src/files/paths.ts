import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FileLayerError, isNodeError } from "./errors.js";
import type { WorkspaceContext } from "./types.js";

function pathError(code: "FILE_INPUT_INVALID" | "OUTPUT_INVALID", message: string): never {
  throw new FileLayerError(code, message);
}

function rejectUnsafePathText(value: string, label: string, code: "FILE_INPUT_INVALID" | "OUTPUT_INVALID"): void {
  if (value.length === 0) pathError(code, `${label} must be a non-empty path`);
  if (value.includes("\0")) pathError(code, `${label} must not contain NUL characters`);
  if (value.split(/[\\/]+/u).some((segment) => segment === "..")) {
    pathError(code, `${label} must not contain '..' path segments`);
  }
}

export function normalizeWorkspaceRelativePath(value: string, label: string): string {
  rejectUnsafePathText(value, label, "OUTPUT_INVALID");
  if (isAbsolute(value) || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value)) {
    pathError("OUTPUT_INVALID", `${label} must be relative to the workspace`);
  }
  const segments = value.split(/[\\/]+/u).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return ".";
  return join(...segments);
}

export function isContained(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance !== "" && !distance.startsWith("..") && !isAbsolute(distance);
}

export async function resolveWorkspaceRoot(context: WorkspaceContext): Promise<string> {
  if (!context || typeof context.directory !== "string" || context.directory.length === 0) {
    pathError("FILE_INPUT_INVALID", "session context.directory must be a non-empty path");
  }
  let root: string;
  try {
    root = await realpath(context.directory);
  } catch {
    pathError("FILE_INPUT_INVALID", "session context.directory does not exist");
  }
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    pathError("FILE_INPUT_INVALID", "session context.directory cannot be inspected");
  }
  if (!rootStat.isDirectory()) pathError("FILE_INPUT_INVALID", "session context.directory must be a directory");
  return root;
}

export async function resolveInputFile(context: WorkspaceContext, input: string): Promise<{ root: string; path: string }> {
  const root = await resolveWorkspaceRoot(context);
  if (typeof input !== "string") pathError("FILE_INPUT_INVALID", "input path must be a string");
  rejectUnsafePathText(input, "input path", "FILE_INPUT_INVALID");

  const normalizedInput = input.replace(/[\\/]+/gu, "/");
  const lexicalPath = isAbsolute(normalizedInput) ? resolve(normalizedInput) : resolve(root, normalizedInput);
  if (!isContained(root, lexicalPath)) {
    pathError("FILE_INPUT_INVALID", "input path must resolve inside the session workspace");
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(lexicalPath);
  } catch {
    pathError("FILE_INPUT_INVALID", "input path does not exist or cannot be resolved");
  }
  if (!isContained(root, resolvedPath)) {
    pathError("FILE_INPUT_INVALID", "input path escapes the session workspace through a symlink");
  }

  let inputStat;
  try {
    inputStat = await stat(resolvedPath);
  } catch {
    pathError("FILE_INPUT_INVALID", "input path cannot be inspected");
  }
  if (!inputStat.isFile()) pathError("FILE_INPUT_INVALID", "input path must be a regular file");
  return { root, path: resolvedPath };
}

async function assertSafeExistingDirectory(path: string, root: string, label: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    pathError("OUTPUT_INVALID", `${label} cannot be inspected`);
  }
  if (entry.isSymbolicLink()) pathError("OUTPUT_INVALID", `${label} must not contain symlinks`);
  if (!entry.isDirectory()) pathError("OUTPUT_INVALID", `${label} must be a directory`);
  let resolved;
  try {
    resolved = await realpath(path);
  } catch {
    pathError("OUTPUT_INVALID", `${label} cannot be resolved`);
  }
  if (resolved !== root && !isContained(root, resolved)) {
    pathError("OUTPUT_INVALID", `${label} escapes the session workspace`);
  }
}

export async function ensureOutputDirectory(root: string, relativeDirectory: string): Promise<string> {
  const normalized = normalizeWorkspaceRelativePath(relativeDirectory, "outputDir");
  if (normalized === ".") return root;

  let current = root;
  for (const segment of normalized.split(/[\\/]+/u)) {
    if (segment.length === 0 || segment === ".") continue;
    current = join(current, segment);
    try {
      await assertSafeExistingDirectory(current, root, "output directory");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, "EEXIST")) {
          throw new FileLayerError("OUTPUT_INVALID", `cannot create output directory: ${String(mkdirError)}`);
        }
      }
      await assertSafeExistingDirectory(current, root, "output directory");
    }
  }
  return current;
}
