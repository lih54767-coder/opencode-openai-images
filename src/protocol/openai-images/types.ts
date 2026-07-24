import type {
  ImageBackground,
  ImageInputFidelity,
  ImageModerationLevel,
  ImageOutputFormat,
  ResolvedTransportTarget,
} from "../../config/types.js";

export interface CommonImageRequestOptions {
  size?: string;
  quality?: string;
  background?: ImageBackground;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
  moderation?: ImageModerationLevel;
}

export interface GenerateImageRequest extends CommonImageRequestOptions {
  prompt: string;
}

export interface PreparedImageInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface EditImageRequest extends CommonImageRequestOptions {
  prompt: string;
  images: readonly PreparedImageInput[];
  mask?: PreparedImageInput;
  inputFidelity?: ImageInputFidelity;
}

export interface NormalizedRemoteAsset {
  kind: "base64" | "data-url" | "url";
  value: string;
  mimeType?: string;
}

export interface NormalizedRemoteAssets {
  assets: readonly NormalizedRemoteAsset[];
  revisedPrompt?: string;
}

export interface ImagesTransport {
  generate(
    request: GenerateImageRequest,
    target: ResolvedTransportTarget,
    signal: AbortSignal,
  ): Promise<NormalizedRemoteAssets>;
  edit(
    request: EditImageRequest,
    target: ResolvedTransportTarget,
    signal: AbortSignal,
  ): Promise<NormalizedRemoteAssets>;
}
