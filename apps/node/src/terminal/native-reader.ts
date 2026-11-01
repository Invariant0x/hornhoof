import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { projectNativeRecord, type NativeRecord } from './native-records.js';

export interface NativeCapture {
  readonly record: NativeRecord;
  readonly generation: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly capturedAt: number;
}
export interface NativeCursor {
  readonly generation: string;
  readonly byteOffset: number;
  readonly readOffset: number;
  readonly atBoundary: boolean;
}
export interface NativeRead {
  readonly records: readonly NativeCapture[];
  readonly cursor: NativeCursor | null;
  readonly caughtUp: boolean;
  readonly continuity: 'opened' | 'continuous' | 'replaced' | 'truncated' | 'rewritten' | 'unavailable' | 'changed';
  readonly bytesRead: number;
  readonly discarded: number;
  readonly oversized: number;
}
export interface NativeReaderOptions {
  readonly maxReadBytes?: number;
  readonly maxLineBytes?: number;
  readonly maxRecords?: number;
}

interface Frame { byteStart: number; byteEnd: number; bytes: Buffer | null }
interface Anchor { offset: number; bytes: Buffer }
type Continuity = NativeRead['continuity'];

/* All limits also have hard ceilings. Lines include the newline in their byte budget. */
function bound(value: number | undefined, maximum: number): number {
  const n = value ?? maximum;
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new Error('Invalid native reader bound.');
  return n;
}

class RecordLines {
  offset = 0;
  completeOffset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private oversized = false;

  constructor(private readonly limit: number) {}

  consume(bytes: Buffer, maximum: number): Frame[] {
    const frames: Frame[] = [];
    let start = 0;
    while (start < bytes.length && frames.length < maximum) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline + 1;
      this.append(bytes.subarray(start, end));
      if (newline >= 0) frames.push(this.finish());
      start = end;
    }
    return frames;
  }

  private append(bytes: Buffer): void {
    this.offset += bytes.length;
    if (this.oversized) return;
    this.oversized = this.partial.length + bytes.length > this.limit;
    this.partial = this.oversized ? Buffer.alloc(0) : Buffer.concat([this.partial, bytes]);
  }

  private finish(): Frame {
    const frame = { byteStart: this.completeOffset, byteEnd: this.offset, bytes: this.oversized ? null : this.partial };
    this.completeOffset = this.offset;
    this.partial = Buffer.alloc(0);
    this.oversized = false;
    return frame;
  }
}

function identity(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}`;
}

function openRegular(file: string): { fd: number; stats: BigIntStats } | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isFile() || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsupported native file.');
    return { fd, stats };
  } catch {
    if (fd !== null) closeSync(fd);
    return null;
  }
}

function matches(fd: number, anchor: Anchor | null): boolean {
  if (!anchor) return true;
  const current = Buffer.alloc(anchor.bytes.length);
  const n = readSync(fd, current, 0, current.length, anchor.offset);
  return n === current.length && current.equals(anchor.bytes);
}

const decoder = new TextDecoder('utf-8', { fatal: true });
function decode(frame: Frame): NativeRecord | null {
  if (frame.bytes === null) return null;
  try { return projectNativeRecord(JSON.parse(decoder.decode(frame.bytes))); }
  catch { return null; }
}

function captures(frames: Frame[], generation: string, capturedAt: number): Pick<NativeRead, 'records' | 'discarded' | 'oversized'> {
  const records: NativeCapture[] = [];
  let discarded = 0;
  let oversized = 0;
  for (const frame of frames) {
    const record = decode(frame);
    if (frame.bytes === null) oversized++;
    else if (!record) discarded++;
    if (record) records.push(Object.freeze({ record, generation, byteStart: frame.byteStart, byteEnd: frame.byteEnd, capturedAt }));
  }
  return { records: Object.freeze(records), discarded, oversized };
}

function unavailable(continuity: Continuity = 'unavailable', bytesRead = 0): NativeRead {
  return Object.freeze({ records: Object.freeze([]), cursor: null, caughtUp: false, continuity, bytesRead, discarded: 0, oversized: 0 });
}

/* Reader-local generation detects observed file changes, not process/session identity or a writer fence.
   Bounded anchors cannot attest an unchanged earlier prefix or exclude rewrite-and-regrow between reads.
   This reader is deliberately not connected to a job, quota classifier or production input path. */
export class NativeRecordReader {
  private readonly maxReadBytes: number;
  private readonly maxLineBytes: number;
  private readonly maxRecords: number;
  private lines: RecordLines;
  private fileIdentity: string | null = null;
  private generation = randomUUID();
  private anchor: Anchor | null = null;

  constructor(private readonly file: string, options: NativeReaderOptions = {}) {
    this.maxReadBytes = bound(options.maxReadBytes, 65_536);
    this.maxLineBytes = bound(options.maxLineBytes, 32_768);
    this.maxRecords = bound(options.maxRecords, 128);
    this.lines = new RecordLines(this.maxLineBytes);
  }

  read(): NativeRead {
    const opened = openRegular(this.file);
    if (!opened) { this.reset(null); return unavailable(); }
    try { return this.readFile(opened.fd, opened.stats); }
    catch { this.reset(null); return unavailable(); }
    finally { closeSync(opened.fd); }
  }

  private readFile(fd: number, stats: BigIntStats): NativeRead {
    const capturedAt = Date.now();
    const continuity = this.prepare(fd, stats);
    const start = this.lines.offset;
    const previous = this.anchor;
    const buffer = Buffer.alloc(Math.min(this.maxReadBytes, Number(stats.size) - start));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    const frames = this.lines.consume(buffer.subarray(0, bytesRead), this.maxRecords);
    const consumed = this.lines.offset - start;
    if (consumed) this.anchor = { offset: start, bytes: Buffer.from(buffer.subarray(0, consumed)) };
    if (!this.stable(fd, previous)) { this.reset(null); return unavailable('changed', bytesRead); }
    return Object.freeze({
      ...captures(frames, this.generation, capturedAt),
      cursor: Object.freeze({ generation: this.generation, byteOffset: this.lines.completeOffset,
        readOffset: this.lines.offset, atBoundary: this.lines.completeOffset === this.lines.offset }),
      caughtUp: this.lines.offset === Number(fstatSync(fd, { bigint: true }).size), continuity, bytesRead,
    });
  }

  private prepare(fd: number, stats: BigIntStats): Continuity {
    const next = identity(stats);
    let continuity: Continuity = 'continuous';
    if (this.fileIdentity === null) continuity = 'opened';
    else if (this.fileIdentity !== next) continuity = 'replaced';
    else if (stats.size < BigInt(this.lines.offset)) continuity = 'truncated';
    else if (!matches(fd, this.anchor)) continuity = 'rewritten';
    if (continuity !== 'continuous') this.reset(next);
    return continuity;
  }

  private stable(fd: number, previous: Anchor | null): boolean {
    const path = lstatSync(this.file, { bigint: true });
    if (!path.isFile() || identity(path) !== this.fileIdentity) return false;
    if (fstatSync(fd, { bigint: true }).size < BigInt(this.lines.offset)) return false;
    return matches(fd, previous) && matches(fd, this.anchor);
  }

  private reset(next: string | null): void {
    this.fileIdentity = next;
    this.generation = randomUUID();
    this.lines = new RecordLines(this.maxLineBytes);
    this.anchor = null;
  }
}
