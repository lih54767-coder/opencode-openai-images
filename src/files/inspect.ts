import { FileLayerError } from "./errors.js";
import type { ImageInspection } from "./types.js";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function fail(message: string): never {
  throw new FileLayerError("IMAGE_INVALID", message);
}

function hasPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let value = "";
  for (let index = start; index < start + length; index += 1) {
    const byte = bytes[index];
    if (byte === undefined || byte < 0x20 || byte > 0x7e) return "";
    value += String.fromCharCode(byte);
  }
  return value;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  if (first === undefined || second === undefined) fail("truncated image header");
  return (first << 8) | second;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  if (first === undefined || second === undefined) fail("truncated image header");
  return first | (second << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  if (first === undefined || second === undefined || third === undefined) fail("truncated WebP dimensions");
  return first | (second << 8) | (third << 16);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    fail("truncated image header");
  }
  return first * 0x1000000 + (second << 16) + (third << 8) + fourth;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    fail("truncated image header");
  }
  return first + (second << 8) + (third << 16) + fourth * 0x1000000;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let value = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    value = CRC_TABLE[(value ^ bytes[index]!) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function validPngBitDepth(bitDepth: number, colorType: number): boolean {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 2 || colorType === 4 || colorType === 6) return bitDepth === 8 || bitDepth === 16;
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  return false;
}

function inspectPng(bytes: Uint8Array): ImageInspection {
  if (bytes.length < 8) fail("truncated PNG signature");
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  let width = 0;
  let height = 0;
  let hasAlpha = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail("truncated PNG chunk header");
    const chunkLength = readUint32BE(bytes, offset);
    const chunkStart = offset + 4;
    const chunkDataStart = offset + 8;
    const chunkEnd = chunkDataStart + chunkLength;
    const crcEnd = chunkEnd + 4;
    if (chunkEnd < chunkDataStart || crcEnd > bytes.length) fail("truncated PNG chunk");

    const type = ascii(bytes, chunkStart, 4);
    if (type.length !== 4) fail("invalid PNG chunk type");
    const expectedCrc = readUint32BE(bytes, chunkEnd);
    const actualCrc = crc32(bytes, chunkStart, chunkEnd);
    if (expectedCrc !== actualCrc) fail(`invalid PNG CRC for ${type}`);

    if (!sawHeader && type !== "IHDR") fail("PNG must begin with IHDR");
    if (type === "IHDR") {
      if (sawHeader || chunkLength !== 13) fail("invalid PNG IHDR");
      width = readUint32BE(bytes, chunkDataStart);
      height = readUint32BE(bytes, chunkDataStart + 4);
      const bitDepth = bytes[chunkDataStart + 8];
      const colorType = bytes[chunkDataStart + 9];
      const compression = bytes[chunkDataStart + 10];
      const filter = bytes[chunkDataStart + 11];
      if (width === 0 || height === 0 || bitDepth === undefined || colorType === undefined) {
        fail("PNG dimensions and color type must be valid");
      }
      if (!validPngBitDepth(bitDepth, colorType) || compression !== 0 || filter !== 0) {
        fail("unsupported or invalid PNG IHDR");
      }
      hasAlpha = colorType === 4 || colorType === 6;
      sawHeader = true;
    } else if (type === "IDAT") {
      sawData = true;
    } else if (type === "IEND") {
      if (chunkLength !== 0 || !sawHeader || !sawData) fail("invalid or incomplete PNG IEND");
      offset = crcEnd;
      if (offset !== bytes.length) fail("unexpected data after PNG IEND");
      return { format: "png", mimeType: "image/png", width, height, hasAlpha };
    }

    offset = crcEnd;
  }

  fail("truncated PNG: missing IEND");
}

function isRestartMarker(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0x01 || isRestartMarker(marker);
}

function consumeJpegScan(bytes: Uint8Array, offset: number): { nextOffset: number; foundEoi: boolean } {
  while (offset < bytes.length) {
    const byte = bytes[offset]!;
    offset += 1;
    if (byte !== 0xff) continue;
    const markerStart = offset - 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return { nextOffset: offset, foundEoi: false };
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0x00 || isRestartMarker(marker)) continue;
    if (marker === 0xd9) return { nextOffset: offset, foundEoi: true };
    return { nextOffset: markerStart, foundEoi: false };
  }
  return { nextOffset: offset, foundEoi: false };
}

function inspectJpeg(bytes: Uint8Array): ImageInspection {
  if (bytes.length < 2) fail("truncated JPEG signature");
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) fail("invalid JPEG marker boundary");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) fail("truncated JPEG marker");
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0x00) fail("invalid JPEG stuffed marker outside scan data");
    if (marker === 0xd9) break;
    if (marker === 0xd8) continue;
    if (isStandaloneJpegMarker(marker)) continue;
    if (offset + 2 > bytes.length) fail("truncated JPEG segment length");
    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2) fail("invalid JPEG segment length");
    const segmentEnd = offset + segmentLength;
    if (segmentEnd > bytes.length) fail("truncated JPEG segment");

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) fail("truncated JPEG frame header");
      height = readUint16BE(bytes, offset + 3);
      width = readUint16BE(bytes, offset + 5);
      if (width === 0 || height === 0) fail("JPEG dimensions must be non-zero");
      sawFrame = true;
    } else if (marker === 0xda) {
      sawScan = true;
      const scan = consumeJpegScan(bytes, segmentEnd);
      if (scan.foundEoi) {
        offset = scan.nextOffset;
        break;
      }
      offset = scan.nextOffset;
      continue;
    }
    offset = segmentEnd;
  }

  if (!sawFrame || !sawScan || offset > bytes.length || bytes[offset - 2] !== 0xff || bytes[offset - 1] !== 0xd9) {
    fail("incomplete JPEG: missing frame or EOI");
  }
  return { format: "jpeg", mimeType: "image/jpeg", width, height, hasAlpha: false };
}

function inspectWebp(bytes: Uint8Array): ImageInspection {
  if (bytes.length < 12) fail("truncated WebP RIFF header");
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") fail("invalid WebP RIFF signature");
  const riffSize = readUint32LE(bytes, 4);
  if (riffSize < 4) fail("invalid WebP RIFF size");
  const riffEnd = 8 + riffSize;
  if (riffEnd > bytes.length) fail("truncated WebP RIFF payload");
  if (riffEnd !== bytes.length) fail("unexpected data after WebP RIFF payload");

  let offset = 12;
  let width: number | undefined;
  let height: number | undefined;
  let hasAlpha = false;
  let sawImageChunk = false;

  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) fail("truncated WebP chunk header");
    const type = ascii(bytes, offset, 4);
    const chunkLength = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const nextOffset = dataEnd + (chunkLength & 1);
    if (type.length !== 4 || dataEnd < dataStart || nextOffset > riffEnd) fail("truncated WebP chunk");

    if (type === "VP8X") {
      if (chunkLength < 10) fail("truncated WebP VP8X header");
      width = readUint24LE(bytes, dataStart + 4) + 1;
      height = readUint24LE(bytes, dataStart + 7) + 1;
      hasAlpha = (bytes[dataStart]! & 0x10) !== 0;
    } else if (type === "VP8L") {
      if (chunkLength < 5 || bytes[dataStart] !== 0x2f) fail("invalid WebP VP8L header");
      const packed = readUint32LE(bytes, dataStart + 1);
      width = (packed & 0x3fff) + 1;
      height = ((packed >>> 14) & 0x3fff) + 1;
      hasAlpha = hasAlpha || (packed & 0x10000000) !== 0;
      sawImageChunk = true;
    } else if (type === "VP8 ") {
      if (chunkLength < 10 || bytes[dataStart + 3] !== 0x9d || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a) {
        fail("invalid WebP VP8 frame header");
      }
      width = readUint16LE(bytes, dataStart + 6) & 0x3fff;
      height = readUint16LE(bytes, dataStart + 8) & 0x3fff;
      if (width === 0 || height === 0) fail("WebP dimensions must be non-zero");
      sawImageChunk = true;
    } else if (type === "ALPH") {
      hasAlpha = true;
    }
    offset = nextOffset;
  }

  if (!sawImageChunk || width === undefined || height === undefined || width === 0 || height === 0) {
    fail("WebP has no supported image frame");
  }
  return { format: "webp", mimeType: "image/webp", width, height, hasAlpha };
}

export function inspectImage(bytes: Uint8Array): ImageInspection {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) fail("image bytes must be non-empty");
  if (hasPrefix(bytes, PNG_SIGNATURE)) return inspectPng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return inspectWebp(bytes);
  fail("unsupported image format: expected PNG, JPEG, or WebP magic");
}
