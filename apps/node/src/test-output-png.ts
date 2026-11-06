import { inflateSync } from 'node:zlib';
import { RUN_FILE_BYTES } from '@hornhoof/protocol';

export type PngOutputDimensions = { width: number; height: number };
type Shape = PngOutputDimensions & { depth: number; color: number; channels: number; interlace: number };
type Chunk = { type: string; data: Buffer; end: number };
type Image = { shape: Shape; compressed: Buffer; palette: number };
type Chunks = Image & { used: number; seenData: boolean; closedData: boolean };
type Pass = { width: number; height: number; rowBytes: number };

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function readChunk(bytes: Buffer, at: number): Chunk | null {
  if (at + 12 > bytes.length) return null;
  const size = bytes.readUInt32BE(at), end = at + size + 12;
  const type = bytes.toString('latin1', at + 4, at + 8);
  if (size > 0x7fffffff || end > bytes.length || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return null;
  if (crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return null;
  return { type, data: bytes.subarray(at + 8, end - 4), end };
}

const validMethods = (bytes: Buffer): boolean => bytes[10] === 0 && bytes[11] === 0 && bytes[12]! < 2;

function imageShape(bytes: Buffer): Shape | null {
  if (bytes.length !== 13) return null;
  const width = bytes.readUInt32BE(0), height = bytes.readUInt32BE(4);
  const depth = bytes[8]!, color = bytes[9]!, interlace = bytes[12]!;
  if (!width || !height || !validMethods(bytes)) return null;
  // Bound both decoded storage and indexed-pixel work, before invoking zlib.
  if (width * height > RUN_FILE_BYTES || !DEPTHS[color]?.includes(depth)) return null;
  return { width, height, depth, color, interlace, channels: CHANNELS[color]! };
}

function setPalette(state: Chunks, bytes: Buffer): boolean {
  if (state.palette || state.seenData || [0, 4].includes(state.shape.color)) return false;
  const entries = bytes.length / 3;
  if (!Number.isInteger(entries) || entries < 1 || entries > 256) return false;
  if (state.shape.color === 3 && entries > 2 ** state.shape.depth) return false;
  state.palette = entries;
  return true;
}

function acceptChunk(state: Chunks, chunk: Chunk): boolean {
  if (chunk.type === 'IDAT') {
    if (state.closedData) return false;
    chunk.data.copy(state.compressed, state.used);
    state.used += chunk.data.length; state.seenData = true;
    return true;
  }
  if (chunk.type === 'PLTE') return setPalette(state, chunk.data);
  state.closedData = state.seenData;
  // Ancillary metadata is not interpreted. Animated frames are outside this static output contract.
  return /^[a-z]/.test(chunk.type) && !['acTL', 'fcTL', 'fdAT'].includes(chunk.type);
}

function finishImage(state: Chunks, chunk: Chunk, length: number): Image | null {
  if (chunk.data.length || chunk.end !== length || !state.seenData) return null;
  if (state.shape.color === 3 && !state.palette) return null;
  return { shape: state.shape, palette: state.palette, compressed: state.compressed.subarray(0, state.used) };
}

function readImage(bytes: Buffer): Image | null {
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) return null;
  const first = readChunk(bytes, 8);
  if (!first || first.type !== 'IHDR') return null;
  const shape = imageShape(first.data);
  if (!shape) return null;
  const state: Chunks = { shape, palette: 0, compressed: Buffer.allocUnsafe(bytes.length), used: 0, seenData: false, closedData: false };
  let at = first.end;
  while (at < bytes.length) {
    const chunk = readChunk(bytes, at);
    if (!chunk) return null;
    if (chunk.type === 'IEND') return finishImage(state, chunk, bytes.length);
    if (!acceptChunk(state, chunk)) return null;
    at = chunk.end;
  }
  return null;
}

function passesOf(shape: Shape): Pass[] {
  const positions = shape.interlace ? ADAM7 : [[0, 0, 1, 1] as const];
  return positions.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((shape.width - x) / dx));
    const height = Math.max(0, Math.ceil((shape.height - y) / dy));
    return { width, height, rowBytes: Math.ceil(width * shape.channels * shape.depth / 8) };
  }).filter(pass => pass.width > 0 && pass.height > 0);
}

function paeth(left: number, up: number, corner: number): number {
  const predicted = left + up - corner;
  const a = Math.abs(predicted - left), b = Math.abs(predicted - up), c = Math.abs(predicted - corner);
  if (a <= b && a <= c) return left;
  return b <= c ? up : corner;
}

function prediction(filter: number, left: number, up: number, corner: number): number {
  switch (filter) {
    case 1: return left;
    case 2: return up;
    case 3: return Math.floor((left + up) / 2);
    case 4: return paeth(left, up, corner);
    default: return 0;
  }
}

/* Indexed pixels are one-byte-or-smaller samples, so their filter byte distance is always one. */
function restoreIndices(row: Buffer, previous: Buffer, filter: number): void {
  for (let at = 0; at < row.length; at++) {
    row[at] = (row[at]! + prediction(filter, row[at - 1] ?? 0, previous[at]!, previous[at - 1] ?? 0)) & 255;
  }
}

function validIndices(row: Buffer, width: number, depth: number, palette: number): boolean {
  const mask = (1 << depth) - 1;
  for (let pixel = 0; pixel < width; pixel++) {
    const bit = pixel * depth;
    if (((row[bit >>> 3]! >>> (8 - depth - bit % 8)) & mask) >= palette) return false;
  }
  return true;
}

function checkPass(raw: Buffer, from: number, pass: Pass, image: Image): number | null {
  let at = from, previous: Buffer = Buffer.alloc(image.shape.color === 3 ? pass.rowBytes : 0);
  for (let y = 0; y < pass.height; y++) {
    const filter = raw[at++]!;
    if (filter > 4) return null;
    if (image.shape.color === 3) {
      const row = Buffer.from(raw.subarray(at, at + pass.rowBytes));
      restoreIndices(row, previous, filter);
      if (!validIndices(row, pass.width, image.shape.depth, image.palette)) return null;
      previous = row;
    }
    at += pass.rowBytes;
  }
  return at;
}

function decodedImage(image: Image): boolean {
  const passes = passesOf(image.shape), expected = passes.reduce((sum, pass) => sum + (pass.rowBytes + 1) * pass.height, 0);
  if (expected > RUN_FILE_BYTES) return false;
  const raw = inflateSync(image.compressed, { maxOutputLength: expected + 1 });
  if (raw.length !== expected) return false;
  let at: number | null = 0;
  for (const pass of passes) {
    at = checkPass(raw, at, pass, image);
    if (at === null) return false;
  }
  return true;
}

// Content inspection only; declarations, file reads, ownership and upload stay with the runner.
export function pngOutputDimensions(bytes: Uint8Array): PngOutputDimensions | null {
  if (bytes.byteLength < 8 || bytes.byteLength > RUN_FILE_BYTES) return null;
  try {
    const image = readImage(Buffer.from(bytes));
    return image && decodedImage(image) ? { width: image.shape.width, height: image.shape.height } : null;
  } catch { return null; }
}
