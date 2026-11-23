import type { FileHandle } from 'node:fs/promises';
import { crc32, inflateRawSync } from 'node:zlib';
import type { ThemeLimits, ThemeProblem, ThemeProblemCode } from '@hornhoof/protocol/themes';

/* The zip reader of theme archives. It takes the plain zip every packing tool writes (stored or deflated files, one
   disk, no encryption) and refuses whatever hides more than it says: sizes the headers lie about, names that leave the
   archive, links, two names for one file, files that share their bytes, and packing far tighter than pictures, fonts and
   words pack. Everything is decided from the central directory before a byte is unpacked, and unpacking a file stops at
   the size its header gives. */

export class ArchiveRefused extends Error {
  constructor(readonly problem: ThemeProblem) {
    super(problem.path ? `${problem.code}: ${problem.path}` : problem.code);
  }
}

/* Throws, so a check that fails narrows the code after it. */
function refuse(code: ThemeProblemCode, path?: string): never {
  throw new ArchiveRefused(path === undefined ? { code } : { code, path });
}

/* Where the bytes of an archive come from: a file on disk, read where it is needed, or bytes already in memory. */
export type ZipSource = Readonly<{ size: number; read: (position: number, length: number) => Promise<Buffer> }>;

export const bufferSource = (bytes: Buffer): ZipSource => ({
  size: bytes.length,
  read: async (position, length) => bytes.subarray(position, Math.min(bytes.length, position + length)),
});

export async function fileSource(handle: FileHandle): Promise<ZipSource> {
  const { size } = await handle.stat();
  return {
    size,
    read: async (position, length) => {
      const into = Buffer.alloc(Math.max(0, Math.min(length, size - position)));
      const { bytesRead } = await handle.read(into, 0, into.length, position);
      return into.subarray(0, bytesRead);
    },
  };
}

/* One file of the archive: its path, its size unpacked, and its bytes once they are read and proven whole. */
export type ZipFile = Readonly<{ path: string; size: number; read: () => Promise<Buffer> }>;

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const END_BYTES = 22;
const LONGEST_COMMENT = 0xffff;
const ENCRYPTED = 0x0001 | 0x0040;
const UTF8_NAME = 0x0800;
const UNIX = 3;
const TYPE_BITS = 0o170000;
const LINK = 0o120000;
const STORED = 0;
const DEFLATED = 8;
const FULL32 = 0xffffffff;
const FULL16 = 0xffff;

/* A part of a path: Latin letters, digits and a few signs, never only dots. */
const PART = /^[A-Za-z0-9._@-]+$/;
const DOTS = /^\.+$/;
/* What a Mac writes beside the files of a folder it packs; never read. */
const MAC_EXTRA = (path: string) => path.startsWith('__MACOSX/') || /(?:^|\/)(?:\.DS_Store|\._[^/]*)$/.test(path);

type Entry = { path: string; method: number; crc: number; packed: number; size: number; offset: number; folder: boolean };

async function endRecord(source: ZipSource, limits: ThemeLimits): Promise<{ count: number; size: number; offset: number; at: number }> {
  if (source.size > limits.archiveBytes) refuse('archive_too_large');
  if (source.size < END_BYTES) refuse('not_zip');
  const from = Math.max(0, source.size - END_BYTES - LONGEST_COMMENT);
  const tail = await source.read(from, source.size - from);
  for (let at = tail.length - END_BYTES; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) !== END) continue;
    /* The record that ends the archive, comment and all: bytes after it are something the zip does not account for. */
    if (at + END_BYTES + tail.readUInt16LE(at + 20) !== tail.length) continue;
    if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0) refuse('zip_split');
    if (at >= 20 && tail.readUInt32LE(at - 20) === ZIP64_LOCATOR) refuse('zip64');
    const [here, count, size, offset] = [tail.readUInt16LE(at + 8), tail.readUInt16LE(at + 10), tail.readUInt32LE(at + 12), tail.readUInt32LE(at + 16)];
    if (count === FULL16 || size === FULL32 || offset === FULL32) refuse('zip64');
    if (here !== count) refuse('zip_split');
    return { count, size, offset, at: from + at };
  }
  return refuse('not_zip');
}

function pathOf(raw: Buffer, flags: number, limits: ThemeLimits): string {
  const name = raw.toString(flags & UTF8_NAME ? 'utf8' : 'latin1');
  const path = name.endsWith('/') ? name.slice(0, -1) : name;
  const shown = path.slice(0, limits.pathLength);
  if (!path || path.length > limits.pathLength || path.split('/').some(part => !PART.test(part) || DOTS.test(part))) refuse('path_unsafe', shown);
  return path;
}

function entryAt(directory: Buffer, at: number, limits: ThemeLimits): { entry: Entry; next: number } {
  if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) refuse('zip_corrupt');
  const flags = directory.readUInt16LE(at + 8);
  const [nameLength, extraLength, commentLength] = [directory.readUInt16LE(at + 28), directory.readUInt16LE(at + 30), directory.readUInt16LE(at + 32)];
  const next = at + 46 + nameLength + extraLength + commentLength;
  if (next > directory.length) refuse('zip_corrupt');
  const raw = directory.subarray(at + 46, at + 46 + nameLength);
  const name = raw.toString(flags & UTF8_NAME ? 'utf8' : 'latin1');
  const entry: Entry = {
    path: name,
    method: directory.readUInt16LE(at + 10),
    crc: directory.readUInt32LE(at + 16),
    packed: directory.readUInt32LE(at + 20),
    size: directory.readUInt32LE(at + 24),
    offset: directory.readUInt32LE(at + 42),
    folder: name.endsWith('/'),
  };
  if (MAC_EXTRA(name)) return { entry, next };
  if (entry.packed === FULL32 || entry.size === FULL32 || entry.offset === FULL32 || directory.readUInt16LE(at + 34) === FULL16) refuse('zip64');
  if (directory.readUInt16LE(at + 34) !== 0) refuse('zip_split');
  entry.path = pathOf(raw, flags, limits);
  if (flags & ENCRYPTED) refuse('zip_encrypted', entry.path);
  if (entry.method !== STORED && entry.method !== DEFLATED) refuse('zip_method', entry.path);
  /* The high byte of "version made by" names the system; on Unix the high half of the outer attributes is the mode. */
  const unixMode = directory.readUInt8(at + 5) === UNIX ? directory.readUInt32LE(at + 38) >>> 16 : 0;
  if ((unixMode & TYPE_BITS) === LINK) refuse('path_link', entry.path);
  return { entry, next };
}

function sizeProblem(entry: Entry, limits: ThemeLimits): void {
  if (entry.size > limits.fileBytes) refuse('file_too_large', entry.path);
  if (entry.method === STORED && entry.packed !== entry.size) refuse('zip_corrupt', entry.path);
  if (entry.size > limits.ratioFrom && entry.size > entry.packed * limits.ratio) refuse('packed_too_tightly', entry.path);
}

async function directoryOf(source: ZipSource, limits: ThemeLimits): Promise<{ entries: Entry[]; start: number }> {
  const end = await endRecord(source, limits);
  if (end.count > limits.files) refuse('too_many_files');
  if (end.offset + end.size !== end.at) refuse('zip_corrupt');
  const directory = await source.read(end.offset, end.size);
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let at = 0;
  for (let n = 0; n < end.count; n += 1) {
    const { entry, next } = entryAt(directory, at, limits);
    at = next;
    entries.push(entry);
    if (MAC_EXTRA(entry.path)) continue;
    const key = entry.path.toLowerCase();
    if (seen.has(key)) refuse('path_twice', entry.path);
    seen.add(key);
    sizeProblem(entry, limits);
  }
  if (at !== directory.length) refuse('zip_corrupt');
  if (entries.reduce((sum, entry) => sum + entry.size, 0) > limits.unpackedBytes) refuse('unpacked_too_large');
  return { entries, start: end.offset };
}

/* Where an entry's bytes lie, from its local header, which must name the same file the directory does. */
async function dataOf(source: ZipSource, entry: Entry, start: number): Promise<{ from: number; to: number }> {
  const head = await source.read(entry.offset, 30);
  if (head.length < 30 || head.readUInt32LE(0) !== LOCAL) refuse('zip_corrupt', entry.path);
  const [nameLength, extraLength] = [head.readUInt16LE(26), head.readUInt16LE(28)];
  const name = await source.read(entry.offset + 30, nameLength);
  const flags = head.readUInt16LE(6);
  const local = name.toString(flags & UTF8_NAME ? 'utf8' : 'latin1');
  if ((local.endsWith('/') ? local.slice(0, -1) : local) !== entry.path) refuse('zip_corrupt', entry.path);
  const from = entry.offset + 30 + nameLength + extraLength;
  const to = from + entry.packed;
  if (to > start) refuse('zip_corrupt', entry.path);
  return { from, to };
}

function unpacked(entry: Entry, packed: Buffer): Buffer {
  let bytes: Buffer;
  try {
    bytes = entry.method === STORED ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) });
  } catch {
    return refuse('zip_corrupt', entry.path);
  }
  if (bytes.length !== entry.size || crc32(bytes) >>> 0 !== entry.crc) refuse('zip_corrupt', entry.path);
  return bytes;
}

/* The files of an archive, each read only when asked for. Refuses the whole archive at the first thing that is wrong. */
export async function openZip(source: ZipSource, limits: ThemeLimits): Promise<ZipFile[]> {
  const { entries, start } = await directoryOf(source, limits);
  const kept = entries.filter(entry => !MAC_EXTRA(entry.path));
  /* No two files may share bytes: the data of each lies between its own header and the next one. */
  const spans = await Promise.all(kept.map(async entry => ({ entry, ...(await dataOf(source, entry, start)) })));
  const ordered = [...spans].sort((a, b) => a.entry.offset - b.entry.offset);
  for (let n = 1; n < ordered.length; n += 1) if (ordered[n]!.entry.offset < ordered[n - 1]!.to) refuse('zip_corrupt', ordered[n]!.entry.path);
  return spans.filter(span => !span.entry.folder).map(({ entry, from, to }) => ({
    path: entry.path,
    size: entry.size,
    read: async () => unpacked(entry, await source.read(from, to - from)),
  }));
}
