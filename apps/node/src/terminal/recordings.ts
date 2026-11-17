import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { JobUser } from '../isolation.js';
import type { ProgramOutput } from '../program-exit.js';
import { KEEP_BYTES, writePrivate } from '../providers/process.js';

export type ExitSnapshot = { output: string; complete: boolean; programOutput?: ProgramOutput };
export type Recording = { name: string; file: string; ready: string; flush: string; position: string; ended: Promise<ExitSnapshot | null> | null };

const digest = (name: string): string => createHash('sha256').update(name).digest('hex');
const capturePath = (file: string): boolean => isAbsolute(file) && !file.includes('\0') && /^\.hh-output-[a-f0-9]{16}\.log$/.test(basename(file));
const manifest = z.object({ name: z.string().min(1).max(256), file: z.string().refine(capturePath) });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/* A replaced recording cannot make the node follow a link, block on a pipe or read an unbounded file. */
function recordedBytes(file: string, limit: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const bytes = Math.min(stat.size, limit);
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, stat.size - bytes));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function recorded(file: string, limit = KEEP_BYTES): string | null {
  return recordedBytes(file, limit)?.toString('utf8') ?? null;
}

export type RecordingCursor = { file: string; offset: number };
type Position = { bytes: Buffer; generation: number; end: number; size: number };

/* Odd generations bracket a writer's append or trim. A reader accepts one stable, fully published generation. */
function positionOf(file: string): Position | null {
  const bytes = recordedBytes(file, 24);
  if (bytes?.length !== 24) return null;
  const generation = bytes.readDoubleBE(0);
  const end = bytes.readDoubleBE(8);
  const size = bytes.readDoubleBE(16);
  if (![generation, end, size].every(n => Number.isSafeInteger(n) && n >= 0) || generation % 2 || size > end) return null;
  return { bytes, generation, end, size };
}

export function recordingCursor(recording: Recording): RecordingCursor | null {
  const before = positionOf(recording.position);
  const after = positionOf(recording.position);
  return before && after && before.bytes.equals(after.bytes) ? { file: recording.file, offset: after.end } : null;
}

function readPublished(recording: Recording): { bytes: Buffer; end: number } | null {
  const before = positionOf(recording.position);
  if (!before) return null;
  const bytes = recordedBytes(recording.file, KEEP_BYTES);
  const after = positionOf(recording.position);
  if (!bytes || !after || !before.bytes.equals(after.bytes) || bytes.length !== Math.min(after.size, KEEP_BYTES)) return null;
  return { bytes, end: after.end };
}

export function recordedAfter(recording: Recording, cursor: RecordingCursor): string | null {
  if (cursor.file !== recording.file) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const published = readPublished(recording);
    if (!published || cursor.offset > published.end) continue;
    const { bytes, end } = published;
    const skip = Math.max(0, cursor.offset - (end - bytes.length));
    return bytes.subarray(skip).toString('utf8');
  }
  return null;
}

function privateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('Terminal recording metadata needs a private directory.');
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error('Terminal recording metadata belongs to another user.');
}

function requestFlush(recording: Recording): void {
  const fd = openSync(recording.flush, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Invalid terminal recorder control file.');
    writeSync(fd, 'flush', 0, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/* The node owns this registry. It is written before raw files exist, so cleanup survives losing the node or recorder. */
export class Recordings {
  private readonly dir: string;
  private readonly active = new Map<string, Recording>();

  constructor(private readonly root: string, socket: string, private readonly user: JobUser | null) {
    this.dir = join(root, digest(socket));
  }

  /* The node's own folder for what its sessions need, where no agent can put a link. */
  privateDir(): string {
    privateDirectory(this.root);
    privateDirectory(this.dir);
    return this.dir;
  }

  private path(name: string): string {
    return join(this.dir, `${digest(name)}.json`);
  }

  isPrivate(name: string): boolean {
    return existsSync(join(this.dir, `${digest(name)}.private`));
  }

  protect(name: string): void {
    this.privateDir();
    writePrivate(join(this.dir, `${digest(name)}.private`), 'private', null);
  }

  release(name: string): void {
    rmSync(join(this.dir, `${digest(name)}.private`), { force: true });
  }

  create(name: string, dir: string): Recording {
    if (this.isPrivate(name)) throw new Error('Raw recording is disabled for a sensitive program.');
    privateDirectory(this.root);
    privateDirectory(this.dir);
    const file = resolve(dir, `.hh-output-${randomBytes(8).toString('hex')}.log`);
    this.publish(name, file);
    const recording = this.remember(name, file);
    writePrivate(file, '', this.user);
    writePrivate(recording.ready, '', this.user);
    writePrivate(recording.flush, '', this.user);
    writePrivate(recording.position, '', this.user);
    return recording;
  }

  private publish(name: string, file: string): void {
    const pending = `${this.path(name)}.${randomBytes(8).toString('hex')}.pending`;
    writePrivate(pending, JSON.stringify({ name, file }), null);
    try { linkSync(pending, this.path(name)); }
    finally { rmSync(pending, { force: true }); }
  }

  private remember(name: string, file: string): Recording {
    const known = this.active.get(name);
    if (known?.file === file) return known;
    const recording: Recording = { name, file, ready: `${file}.ready`, flush: `${file}.flush`, position: `${file}.position`, ended: null };
    this.active.set(name, recording);
    return recording;
  }

  private read(file: string): Recording | undefined {
    if (!existsSync(file)) return undefined;
    privateDirectory(this.root);
    privateDirectory(this.dir);
    try {
      const text = recorded(file, 4096);
      const data = manifest.parse(JSON.parse(text ?? 'null'));
      if (this.path(data.name) !== file) throw new Error('Mismatched recording.');
      return this.remember(data.name, data.file);
    } catch {
      throw new Error('Cannot read terminal recording metadata safely.');
    }
  }

  get(name: string): Recording | undefined {
    return this.read(this.path(name)) ?? this.active.get(name);
  }

  async snapshot(name: string, read: () => Promise<ExitSnapshot | null>): Promise<ExitSnapshot | null> {
    const recording = this.get(name);
    const reading = recording?.ended ?? read();
    if (recording) recording.ended = reading;
    try {
      const result = await reading;
      if (!result?.complete) this.forget(recording, reading);
      return result;
    } catch (error) {
      this.forget(recording, reading);
      throw error;
    }
  }

  private forget(recording: Recording | undefined, reading: Promise<ExitSnapshot | null>): void {
    if (recording?.ended === reading) recording.ended = null;
  }

  all(): Recording[] {
    if (existsSync(this.dir)) {
      privateDirectory(this.root);
      privateDirectory(this.dir);
      for (const file of readdirSync(this.dir)) this.recover(file);
    }
    return [...this.active.values()];
  }

  private recover(file: string): void {
    if (/^[a-f0-9]{64}\.json$/.test(file)) this.read(join(this.dir, file));
    if (/^[a-f0-9]{64}\.json\.[a-f0-9]{16}\.pending$/.test(file)) rmSync(join(this.dir, file), { force: true });
  }

  async wait(recording: Recording, state: 'ready' | 'ended', ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; recorded(recording.ready, 5) !== state;) {
      if (Date.now() >= end) return false;
      await sleep(10);
    }
    return true;
  }

  async finish(recording: Recording, ms: number): Promise<{ output: string | null; complete: boolean }> {
    if (recorded(recording.ready, 5) !== 'ended') {
      try { requestFlush(recording); } catch { /* A killed recorder is bounded by the same wait. */ }
    }
    const drained = await this.wait(recording, 'ended', ms);
    const output = recorded(recording.file);
    return { output, complete: drained && output !== null };
  }

  remove(name: string): void {
    const recording = this.get(name);
    if (!recording) return;
    for (const file of [recording.file, recording.ready, recording.flush, recording.position, this.path(name)]) rmSync(file, { force: true });
    this.active.delete(name);
  }
}
