import { tool, type ToolDefinition, type ToolResult } from "@opencode-ai/plugin";
import { ConnectionCatalog } from "../connections/catalog.js";
import { ConnectionSelectionError } from "../config/errors.js";
import type { ResolvedConnection, ResolvedPluginConfig } from "../config/types.js";
import {
  FileLayerError,
  materializeRemoteAsset,
  prepareInput,
  prepareMask,
  validateOutputTarget,
  writeOutput,
  type OutputOptions,
  type PreparedImage,
  type RemoteAssetInput,
  type RemoteAssetOptions,
  type WorkspaceContext,
  type WrittenImage,
} from "../files/index.js";
import {
  ImagesTransportError,
  createOpenAIImagesTransport,
  type EditImageRequest,
  type GenerateImageRequest,
  type ImagesTransport,
} from "../protocol/openai-images/index.js";
import { createToolSchemas } from "./schemas.js";

const MAX_EDIT_IMAGES = 16;
const IMAGE_OUTPUT_FORMATS_WITH_COMPRESSION = new Set(["jpeg", "webp"]);

export interface ImageToolDependencies {
  readonly transport?: ImagesTransport;
  readonly prepareInput?: typeof prepareInput;
  readonly prepareMask?: typeof prepareMask;
  readonly materializeRemoteAsset?: typeof materializeRemoteAsset;
  readonly validateOutputTarget?: typeof validateOutputTarget;
  readonly writeOutput?: typeof writeOutput;
  readonly remoteFetch?: typeof globalThis.fetch;
}

function setIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function capabilityResult(connection: ResolvedConnection, capability: "edit" | "mask"): ToolResult {
  return {
    title: "Connection capability unavailable",
    output: `Connection '${connection.name}' does not support the '${capability}' capability.`,
    metadata: { code: "CAPABILITY_UNAVAILABLE", connection: connection.name, capability },
  };
}

function selectionResult(error: ConnectionSelectionError): ToolResult {
  return {
    title: "Invalid image connection",
    output: error.message,
    metadata: { code: error.code },
  };
}

function inputResult(code: string, output: string): ToolResult {
  return { title: "Invalid image request", output, metadata: { code } };
}

function safeFileMessage(error: FileLayerError, context: WorkspaceContext): string {
  return error.message.split(context.directory).join("workspace");
}

function errorResult(error: unknown, context: WorkspaceContext): ToolResult | undefined {
  if (error instanceof ImagesTransportError) {
    const metadata: Record<string, unknown> = { code: error.code };
    if (error.status !== undefined) metadata.status = error.status;
    if (error.requestId !== undefined) metadata.requestId = error.requestId;
    if (error.providerCode !== undefined) metadata.providerCode = error.providerCode;
    if (error.providerType !== undefined) metadata.providerType = error.providerType;
    return {
      title: "OpenAI Images request failed",
      output: `Image request failed [${error.code}]${error.status === undefined ? "" : ` (HTTP ${error.status})`}: ${error.message}`,
      metadata,
    };
  }
  if (error instanceof FileLayerError) {
    return {
      title: "Image file operation failed",
      output: `Image file operation failed [${error.code}]: ${safeFileMessage(error, context)}`,
      metadata: { code: error.code },
    };
  }
  if (error instanceof ConnectionSelectionError) return selectionResult(error);
  return undefined;
}

function outputOptions(config: ResolvedPluginConfig, out: string | undefined): OutputOptions {
  return out === undefined ? { outputDir: config.outputDir } : { outputDir: config.outputDir, out };
}

function remoteOptions(connection: ResolvedConnection, signal: AbortSignal, dependencies: ImageToolDependencies): RemoteAssetOptions {
  return dependencies.remoteFetch === undefined
    ? { signal, timeoutMs: connection.timeoutMs }
    : { signal, timeoutMs: connection.timeoutMs, fetch: dependencies.remoteFetch };
}

function outputMetadata(connection: ResolvedConnection, written: readonly WrittenImage[], revisedPrompt: string | undefined): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    code: "OK",
    connection: connection.name,
    model: connection.model,
    outputs: written.map((image) => ({
      path: image.path,
      mime: image.mimeType,
      width: image.width,
      height: image.height,
      byteLength: image.byteLength,
      versioned: image.versioned,
    })),
  };
  if (revisedPrompt !== undefined) metadata.revisedPrompt = revisedPrompt;
  return metadata;
}

async function materializeAndWrite(
  config: ResolvedPluginConfig,
  connection: ResolvedConnection,
  assets: readonly RemoteAssetInput[],
  context: WorkspaceContext,
  signal: AbortSignal,
  out: string | undefined,
  dependencies: ImageToolDependencies,
): Promise<WrittenImage[]> {
  const materialize = dependencies.materializeRemoteAsset ?? materializeRemoteAsset;
  const write = dependencies.writeOutput ?? writeOutput;
  const written: WrittenImage[] = [];
  for (const asset of assets) {
    const image = await materialize(asset, remoteOptions(connection, signal, dependencies));
    written.push(await write(context, image, outputOptions(config, out)));
  }
  return written;
}

function validateCompression(outputFormat: string | undefined, outputCompression: number | undefined): ToolResult | undefined {
  if (outputCompression !== undefined && !IMAGE_OUTPUT_FORMATS_WITH_COMPRESSION.has(outputFormat ?? "")) {
    return inputResult("INVALID_ARGUMENT", "outputCompression requires final outputFormat to be jpeg or webp");
  }
  return undefined;
}

export function createImageTools(config: ResolvedPluginConfig, dependencies: ImageToolDependencies = {}): {
  generate: ToolDefinition;
  edit: ToolDefinition;
} {
  const catalog = new ConnectionCatalog(config);
  const schemas = createToolSchemas(catalog);
  const transport = dependencies.transport ?? createOpenAIImagesTransport(
    dependencies.remoteFetch === undefined ? undefined : { fetch: dependencies.remoteFetch },
  );
  const prepare = dependencies.prepareInput ?? prepareInput;
  const mask = dependencies.prepareMask ?? prepareMask;
  const validateOutput = dependencies.validateOutputTarget ?? validateOutputTarget;

  return {
    generate: tool({
      description: schemas.generateDescription,
      args: schemas.generateArgs,
      async execute(args, context) {
        const workspace: WorkspaceContext = { directory: context.directory };
        try {
          const connection = catalog.get(args.connection);
          const defaults = connection.defaults.generate;
          const outputFormat = args.outputFormat ?? defaults.outputFormat;
          const outputCompression = args.outputCompression ?? defaults.outputCompression;
          const compressionError = validateCompression(outputFormat, outputCompression);
          if (compressionError) return compressionError;
          await validateOutput(workspace, outputOptions(config, args.out));

          const request: GenerateImageRequest = { prompt: args.prompt };
          setIfDefined(request, "size", args.size ?? defaults.size);
          setIfDefined(request, "quality", args.quality ?? defaults.quality);
          setIfDefined(request, "background", args.background ?? defaults.background);
          setIfDefined(request, "outputFormat", outputFormat);
          setIfDefined(request, "outputCompression", outputCompression);
          setIfDefined(request, "moderation", args.moderation ?? defaults.moderation);

          const result = await transport.generate(request, catalog.target(connection.name), context.abort);
          const written = await materializeAndWrite(config, connection, result.assets, workspace, context.abort, args.out, dependencies);
          return {
            title: "OpenAI Images generation complete",
            output: `Generated ${written.length} image${written.length === 1 ? "" : "s"}:\n${written.map((image) => image.path).join("\n")}`,
            metadata: outputMetadata(connection, written, result.revisedPrompt),
          };
        } catch (error) {
          const result = errorResult(error, workspace);
          if (result !== undefined) return result;
          throw error;
        }
      },
    }),
    edit: tool({
      description: schemas.editDescription,
      args: schemas.editArgs,
      async execute(args, context) {
        const workspace: WorkspaceContext = { directory: context.directory };
        try {
          const connection = catalog.get(args.connection);
          if (args.images.length < 1 || args.images.length > MAX_EDIT_IMAGES) {
            return inputResult("INVALID_ARGUMENT", `edit requires between 1 and ${MAX_EDIT_IMAGES} images`);
          }
          if (!connection.capabilities.edit) return capabilityResult(connection, "edit");
          if (args.mask !== undefined && !connection.capabilities.mask) return capabilityResult(connection, "mask");

          const defaults = connection.defaults.edit;
          const outputFormat = args.outputFormat ?? defaults.outputFormat;
          const outputCompression = args.outputCompression ?? defaults.outputCompression;
          const compressionError = validateCompression(outputFormat, outputCompression);
          if (compressionError) return compressionError;
          await validateOutput(workspace, outputOptions(config, args.out));

          const preparedImages: PreparedImage[] = [];
          for (const imagePath of args.images) preparedImages.push(await prepare(workspace, imagePath));
          const preparedMask = args.mask === undefined ? undefined : await mask(workspace, args.mask, preparedImages[0]!);
          const request: EditImageRequest = { prompt: args.prompt, images: preparedImages.map(toTransportInput) };
          setIfDefined(request, "mask", preparedMask === undefined ? undefined : toTransportInput(preparedMask));
          setIfDefined(request, "size", args.size ?? defaults.size);
          setIfDefined(request, "quality", args.quality ?? defaults.quality);
          setIfDefined(request, "background", args.background ?? defaults.background);
          setIfDefined(request, "outputFormat", outputFormat);
          setIfDefined(request, "outputCompression", outputCompression);
          setIfDefined(request, "moderation", args.moderation ?? defaults.moderation);
          setIfDefined(request, "inputFidelity", args.inputFidelity ?? defaults.inputFidelity);

          const result = await transport.edit(request, catalog.target(connection.name), context.abort);
          const written = await materializeAndWrite(config, connection, result.assets, workspace, context.abort, args.out, dependencies);
          return {
            title: "OpenAI Images edit complete",
            output: `Edited ${written.length} image${written.length === 1 ? "" : "s"}:\n${written.map((image) => image.path).join("\n")}`,
            metadata: outputMetadata(connection, written, result.revisedPrompt),
          };
        } catch (error) {
          const result = errorResult(error, workspace);
          if (result !== undefined) return result;
          throw error;
        }
      },
    }),
  };
}

function toTransportInput(image: PreparedImage): { bytes: Uint8Array; filename: string; mimeType: string } {
  return { bytes: image.bytes, filename: image.filename, mimeType: image.mimeType };
}
