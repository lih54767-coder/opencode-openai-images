import { tool } from "@opencode-ai/plugin";
import type { ConnectionCatalog } from "../connections/catalog.js";
import {
  IMAGE_BACKGROUNDS,
  IMAGE_INPUT_FIDELITIES,
  IMAGE_MODERATION_LEVELS,
  IMAGE_OUTPUT_FORMATS,
} from "../config/types.js";

const MAX_IMAGE_PARAMETER_LENGTH = 64;

function connectionContext(catalog: ConnectionCatalog): string {
  const lines = catalog.names().map((name) => {
    const connection = catalog.get(name);
    const description = connection.description ? ` — ${connection.description}` : "";
    const capabilities = `edit=${connection.capabilities.edit ? "yes" : "no"}, mask=${connection.capabilities.mask ? "yes" : "no"}`;
    return `${name}${description} (${capabilities})`;
  });
  return `Configured connections (default: ${catalog.get().name}): ${lines.join("; ")}.`;
}

function connectionSchema(catalog: ConnectionCatalog) {
  const names = catalog.names();
  return tool.schema.enum(names as [string, ...string[]]).optional().describe(
    `Optional configured connection name. ${connectionContext(catalog)}`,
  );
}

function commonParameterArgs() {
  return {
    size: tool.schema.string().min(1).max(MAX_IMAGE_PARAMETER_LENGTH).optional().describe(
      "Output image size, for example 1024x1024, 1536x1024, or a relay-supported custom size.",
    ),
    quality: tool.schema.string().min(1).max(MAX_IMAGE_PARAMETER_LENGTH).optional().describe(
      "Image quality, for example low, medium, high, auto, or a relay-supported custom value.",
    ),
    background: tool.schema.enum(IMAGE_BACKGROUNDS).optional().describe("Image background behavior."),
    outputFormat: tool.schema.enum(IMAGE_OUTPUT_FORMATS).optional().describe("Output image format."),
    outputCompression: tool.schema.number().int().min(0).max(100).optional().describe("Lossy output compression level, 0-100."),
    moderation: tool.schema.enum(IMAGE_MODERATION_LEVELS).optional().describe("Moderation level."),
  };
}

export function makeGenerateDescription(catalog: ConnectionCatalog): string {
  return [
    "Create a new image from a text prompt using an OpenAI Images-compatible generation endpoint.",
    "Use this only when the user asks to generate, draw, create, or render a new image.",
    "This tool does not accept input images. Any input image, reference image, local modification, or reference-guided creation belongs to the edit tool.",
    "Do not use it for analyzing, describing, captioning, or answering questions about an existing image; use ordinary vision capability instead.",
    connectionContext(catalog),
  ].join(" ");
}

export function makeEditDescription(catalog: ConnectionCatalog): string {
  return [
    "Edit one or more existing images according to a text prompt using an OpenAI Images-compatible edits endpoint.",
    "Use this for any input image, reference image, local modification, partial modification, or reference-guided creation.",
    "An optional mask applies to the first image. When multiple images are provided, explain their roles and order in the prompt.",
    "Do not use it for analyzing or describing an existing image without requesting a modification; use ordinary vision capability instead.",
    connectionContext(catalog),
  ].join(" ");
}

export function createToolSchemas(catalog: ConnectionCatalog): {
  generateArgs: ReturnType<typeof createGenerateArgs>;
  editArgs: ReturnType<typeof createEditArgs>;
  generateDescription: string;
  editDescription: string;
} {
  return {
    generateArgs: createGenerateArgs(catalog),
    editArgs: createEditArgs(catalog),
    generateDescription: makeGenerateDescription(catalog),
    editDescription: makeEditDescription(catalog),
  };
}

function createGenerateArgs(catalog: ConnectionCatalog) {
  return {
    prompt: tool.schema.string().min(1).describe("A detailed description of the new image to create."),
    out: tool.schema.string().min(1).optional().describe("Optional workspace-relative output path."),
    connection: connectionSchema(catalog),
    ...commonParameterArgs(),
  };
}

function createEditArgs(catalog: ConnectionCatalog) {
  return {
    prompt: tool.schema.string().min(1).describe("A detailed instruction for how to modify the input image(s)."),
    images: tool.schema.array(tool.schema.string().min(1)).min(1).max(16).describe("Input image paths in order; explain each image's role in the prompt when there are multiple."),
    mask: tool.schema.string().min(1).optional().describe("Optional mask image path; the mask applies to the first input image."),
    out: tool.schema.string().min(1).optional().describe("Optional workspace-relative output path."),
    connection: connectionSchema(catalog),
    ...commonParameterArgs(),
    inputFidelity: tool.schema.enum(IMAGE_INPUT_FIDELITIES).optional().describe("How closely to preserve input image details."),
  };
}
