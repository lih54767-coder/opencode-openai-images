import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_IMAGE_BYTES,
  inspectImage,
  materializeRemoteAsset,
  prepareInput,
  prepareMask,
  type WorkspaceContext,
  writeOutput,
} from "../src/files/index.js";
import { isLexicallyContainedByWorkspaceRoots } from "../src/files/paths.js";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(12 + payload.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, payload.length, false);
  for (let index = 0; index < 4; index += 1) result[4 + index] = type.charCodeAt(index);
  result.set(payload, 8);
  const crcInput = new Uint8Array(4 + payload.length);
  crcInput.set(result.subarray(4, 8), 0);
  crcInput.set(payload, 4);
  view.setUint32(8 + payload.length, crc32(crcInput), false);
  return result;
}

function makePng(width: number, height: number, colorType: 2 | 6 = 6): Uint8Array {
  const channels = colorType === 6 ? 4 : 3;
  const raw = new Uint8Array((width * channels + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * channels + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * channels;
      raw[pixel] = 0x10;
      raw[pixel + 1] = 0x80;
      raw[pixel + 2] = 0xe0;
      if (channels === 4) raw[pixel + 3] = (x + y) % 2 === 0 ? 0x80 : 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const iend = new Uint8Array(0);
  return concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", iend)]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(payload.length + 4);
  result[0] = 0xff;
  result[1] = marker;
  const view = new DataView(result.buffer);
  view.setUint16(2, payload.length + 2, false);
  result.set(payload, 4);
  return result;
}

function makeJpeg(width: number, height: number): Uint8Array {
  const app0 = new TextEncoder().encode("JFIF\0\1\1\0\0\1\0\1\0\0");
  const dqt = new Uint8Array(65);
  dqt[0] = 0;
  dqt.fill(1, 1);
  const sof = new Uint8Array([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  const sos = new Uint8Array([1, 1, 0, 0, 63, 0]);
  return concat([
    new Uint8Array([0xff, 0xd8]),
    jpegSegment(0xe0, app0),
    jpegSegment(0xdb, dqt),
    jpegSegment(0xc0, sof),
    jpegSegment(0xda, sos),
    new Uint8Array([0x00, 0xff, 0xd9]),
  ]);
}

function webpChunk(type: string, payload: Uint8Array): Uint8Array {
  const padded = payload.length % 2 === 0 ? payload : concat([payload, new Uint8Array([0])]);
  const result = new Uint8Array(8 + padded.length);
  for (let index = 0; index < 4; index += 1) result[index] = type.charCodeAt(index);
  new DataView(result.buffer).setUint32(4, payload.length, true);
  result.set(padded, 8);
  return result;
}

function makeWebp(width: number, height: number, alpha: boolean): Uint8Array {
  const vp8x = new Uint8Array(10);
  vp8x[0] = alpha ? 0x10 : 0;
  vp8x[4] = (width - 1) & 0xff;
  vp8x[5] = ((width - 1) >> 8) & 0xff;
  vp8x[6] = (width - 1) >> 16;
  vp8x[7] = (height - 1) & 0xff;
  vp8x[8] = ((height - 1) >> 8) & 0xff;
  vp8x[9] = (height - 1) >> 16;
  const packed = (width - 1) | ((height - 1) << 14) | (alpha ? 1 << 28 : 0);
  const vp8l = new Uint8Array(5);
  vp8l[0] = 0x2f;
  new DataView(vp8l.buffer).setUint32(1, packed, true);
  const body = concat([new TextEncoder().encode("WEBP"), webpChunk("VP8X", vp8x), webpChunk("VP8L", vp8l)]);
  const header = new Uint8Array(8);
  header.set(new TextEncoder().encode("RIFF"));
  new DataView(header.buffer).setUint32(4, body.length, true);
  return concat([header, body]);
}

let workspace = "";
let outside = "";
let context: WorkspaceContext;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "openai-images-files-workspace-"));
  outside = await mkdtemp(join(tmpdir(), "openai-images-files-outside-"));
  context = { directory: workspace };
});

afterAll(async () => {
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
});

describe("image inspection", () => {
  test("identifies PNG, JPEG, and WebP magic, dimensions, and alpha", () => {
    expect(inspectImage(makePng(3, 2, 6))).toEqual({
      format: "png", mimeType: "image/png", width: 3, height: 2, hasAlpha: true,
    });
    expect(inspectImage(makePng(5, 4, 2))).toMatchObject({
      format: "png", mimeType: "image/png", width: 5, height: 4, hasAlpha: false,
    });
    expect(inspectImage(makeJpeg(7, 5))).toEqual({
      format: "jpeg", mimeType: "image/jpeg", width: 7, height: 5, hasAlpha: false,
    });
    expect(inspectImage(makeWebp(4, 3, true))).toEqual({
      format: "webp", mimeType: "image/webp", width: 4, height: 3, hasAlpha: true,
    });
    expect(inspectImage(makeWebp(4, 3, false))).toMatchObject({
      format: "webp", mimeType: "image/webp", width: 4, height: 3, hasAlpha: false,
    });
  });

  test("reports unsupported and truncated files clearly", () => {
    expect(() => inspectImage(new Uint8Array([1, 2, 3]))).toThrow("unsupported image format");
    expect(() => inspectImage(PNG_SIGNATURE)).toThrow("truncated PNG");
    const badPng = makePng(1, 1);
    badPng[badPng.length - 1] ^= 0xff;
    expect(() => inspectImage(badPng)).toThrow("invalid PNG CRC");
    expect(() => inspectImage(makeJpeg(1, 1).subarray(0, 10))).toThrow("truncated JPEG");
    expect(() => inspectImage(makeWebp(1, 1, false).subarray(0, 15))).toThrow("truncated WebP");
  });
});

describe("workspace input and masks", () => {
  test("accepts lexical workspace aliases before canonical containment", () => {
    const lexicalRoot = join(tmpdir(), "workspace-lexical-alias");
    const canonicalRoot = join(tmpdir(), "workspace-canonical-root");

    expect(isLexicallyContainedByWorkspaceRoots(lexicalRoot, canonicalRoot, join(lexicalRoot, "input.png"))).toBe(true);
    expect(isLexicallyContainedByWorkspaceRoots(lexicalRoot, canonicalRoot, join(canonicalRoot, "input.png"))).toBe(true);
    expect(isLexicallyContainedByWorkspaceRoots(lexicalRoot, canonicalRoot, join(tmpdir(), "outside", "input.png"))).toBe(false);
  });

  test("prepares only ordinary files contained by the real workspace", async () => {
    const input = makePng(3, 2);
    await writeFile(join(workspace, "input.png"), input);
    await writeFile(join(outside, "outside.png"), input);
    await mkdir(join(workspace, "directory-input"));
    const prepared = await prepareInput(context, "input.png");
    expect(prepared).toMatchObject({ filename: "input.png", mimeType: "image/png", width: 3, height: 2, hasAlpha: true });
    expect(prepared.bytes).toEqual(input);
    expect(await prepareInput(context, join(workspace, "input.png"))).toMatchObject({ width: 3, height: 2 });

    await expect(prepareInput(context, "../outside.png")).rejects.toThrow("'..'");
    await expect(prepareInput(context, join(outside, "outside.png"))).rejects.toThrow("inside the session workspace");
    await expect(prepareInput(context, "directory-input")).rejects.toThrow("regular file");
    await symlink(join(outside, "outside.png"), join(workspace, "escape.png"));
    await expect(prepareInput(context, "escape.png")).rejects.toThrow("escapes the session workspace");

    const maxSized = join(workspace, "exact-limit.bin");
    const tooLarge = join(workspace, "over-limit.bin");
    const maxHandle = await open(maxSized, "w");
    await maxHandle.truncate(MAX_IMAGE_BYTES);
    await maxHandle.close();
    const overHandle = await open(tooLarge, "w");
    await overHandle.truncate(MAX_IMAGE_BYTES + 1);
    await overHandle.close();
    await expect(prepareInput(context, "exact-limit.bin")).rejects.toThrow("not a valid image");
    await expect(prepareInput(context, "over-limit.bin")).rejects.toThrow("exceeds");
  });

  test("enforces V1 PNG alpha and matching dimensions for masks", async () => {
    const first = await prepareInput(context, "input.png");
    await writeFile(join(workspace, "mask.png"), makePng(3, 2, 6));
    await writeFile(join(workspace, "mask-rgb.png"), makePng(3, 2, 2));
    await writeFile(join(workspace, "mask-size.png"), makePng(2, 2, 6));
    await writeFile(join(workspace, "mask.jpg"), makeJpeg(3, 2));
    expect(await prepareMask(context, "mask.png", first)).toMatchObject({ mimeType: "image/png", width: 3, height: 2, hasAlpha: true });
    await expect(prepareMask(context, "mask-rgb.png", first)).rejects.toThrow("alpha channel");
    await expect(prepareMask(context, "mask-size.png", first)).rejects.toThrow("must match");
    await expect(prepareMask(context, "mask.jpg", first)).rejects.toThrow("must be a PNG");
  });
});

describe("remote asset materialization", () => {
  test("strictly decodes base64 and data URLs, using magic MIME over declarations", async () => {
    const png = makePng(2, 2);
    const base64 = Buffer.from(png).toString("base64");
    const fromBase64 = await materializeRemoteAsset({ kind: "base64", value: base64, mimeType: "image/jpeg" });
    const fromDataUrl = await materializeRemoteAsset({ kind: "data-url", value: `data:image/jpeg;base64,${base64}` });
    expect(fromBase64).toMatchObject({ mimeType: "image/png", width: 2, height: 2, filename: "image.png" });
    expect(fromDataUrl).toMatchObject({ mimeType: "image/png", width: 2, height: 2, filename: "image.png" });
    await expect(materializeRemoteAsset({ kind: "base64", value: `${base64}!` })).rejects.toThrow("strictly padded");
    await expect(materializeRemoteAsset({ kind: "base64", value: base64.slice(0, -1) })).rejects.toThrow("strictly padded");
    await expect(materializeRemoteAsset({ kind: "data-url", value: `data:image/png,${encodeURIComponent("not-an-image")}` })).rejects.toThrow("base64 encoding");
  });

  test("uses manual HTTPS redirects, revalidates every hop, and streams the byte limit", async () => {
    const png = makePng(2, 2);
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      expect(init?.redirect).toBe("manual");
      if (url.endsWith("/start")) return new Response(null, { status: 302, headers: { Location: "/final" } });
      return new Response(png, {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": String(png.byteLength) },
      });
    };
    const downloaded = await materializeRemoteAsset({ kind: "url", value: "https://cdn.example.test/start" }, { fetch: fakeFetch });
    expect(calls).toEqual(["https://cdn.example.test/start", "https://cdn.example.test/final"]);
    expect(downloaded).toMatchObject({ mimeType: "image/png", width: 2, height: 2, filename: "final" });

    const oversizedHeader: typeof fetch = async () => new Response(png, {
      status: 200,
      headers: { "content-length": String(MAX_IMAGE_BYTES + 1) },
    });
    await expect(materializeRemoteAsset({ kind: "url", value: "https://cdn.example.test/large" }, { fetch: oversizedHeader })).rejects.toThrow("exceeds");

    let emitted = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const oversizedStream: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 51) controller.close();
        else {
          emitted += 1;
          controller.enqueue(chunk);
        }
      },
    }), { status: 200 });
    await expect(materializeRemoteAsset({ kind: "url", value: "https://cdn.example.test/stream" }, { fetch: oversizedStream })).rejects.toThrow("exceeds");

    await expect(materializeRemoteAsset({ kind: "url", value: "https://cdn.example.test/redirect" }, {
      fetch: async () => new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/private" } }),
    })).rejects.toThrow("private or reserved");
  });

  test("rejects insecure, credentialed, localhost, and private literal URLs without fetching", async () => {
    let fetchCalls = 0;
    const neverFetch: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    };
    for (const value of [
      "http://cdn.example.test/image.png",
      "https://user:password@cdn.example.test/image.png",
      "https://localhost/image.png",
      "https://127.0.0.1/image.png",
      "https://[::1]/image.png",
      "https://192.168.1.10/image.png",
    ]) {
      await expect(materializeRemoteAsset({ kind: "url", value }, { fetch: neverFetch })).rejects.toThrow();
    }
    expect(fetchCalls).toBe(0);
  });
});

describe("atomic workspace output", () => {
  test("validates bytes, chooses the actual MIME extension, and versions collisions", async () => {
    const png = makePng(3, 2);
    const first = await writeOutput(context, png);
    const second = await writeOutput(context, png);
    const jpeg = await writeOutput(context, makeJpeg(7, 5), { out: "nested/photo.png" });
    expect(first).toMatchObject({ mimeType: "image/png", width: 3, height: 2, byteLength: png.byteLength, versioned: false });
    expect(first.path).toEndWith(join("outputs", "image.png"));
    expect(second.path).toEndWith(join("outputs", "image-v2.png"));
    expect(second.versioned).toBe(true);
    expect(jpeg).toMatchObject({ mimeType: "image/jpeg", width: 7, height: 5, versioned: false });
    expect(jpeg.path).toEndWith(join("nested", "photo.jpeg"));
    expect(await readFile(first.path)).toEqual(Buffer.from(png));
    await expect(writeOutput(context, new Uint8Array([1, 2, 3]), { out: "bad.png" })).rejects.toThrow("valid image");
  });

  test("creates safe directories and never overwrites under concurrency", async () => {
    const png = makePng(2, 2);
    const results = await Promise.all(Array.from({ length: 8 }, () => writeOutput(context, png, { out: "parallel/result.webp" })));
    const paths = new Set(results.map((result) => result.path));
    expect(paths.size).toBe(8);
    expect([...paths].every((path) => path.endsWith(".png"))).toBe(true);
    expect(new Set(results.map((result) => result.byteLength)).size).toBe(1);

    await expect(writeOutput(context, png, { outputDir: "/tmp/not-workspace" })).rejects.toThrow("relative");
    await expect(writeOutput(context, png, { out: "../escape.png" })).rejects.toThrow("'..'");
    await expect(writeOutput(context, png, { out: join(outside, "escape.png") })).rejects.toThrow("relative");

    await mkdirForTest(join(outside, "safe-target"));
    await symlink(join(outside, "safe-target"), join(workspace, "symlink-output"));
    await expect(writeOutput(context, png, { outputDir: "symlink-output" })).rejects.toThrow("must not contain symlinks");
    await symlink(join(outside, "safe-target"), join(workspace, "symlink.png"));
    await expect(writeOutput(context, png, { out: "symlink.png" })).rejects.toThrow("must not be a symlink");
  });
});

async function mkdirForTest(path: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}
