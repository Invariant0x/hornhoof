import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { DISK_CLEANED_MAX, type DiskReport } from '@hornhoof/protocol';
import { z } from 'zod';

/* The file the machine's updater copies into /data after each Docker disk pass. */
export const DOCKER_DISK_FILE = 'docker-disk.json';
const MAX_BYTES = 64 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

export const DOCKER_DISK_PARTS = ['images', 'containers', 'volumes', 'buildCache'] as const;
const DockerDiskPart = z.enum(DOCKER_DISK_PARTS);
type DockerDiskPart = z.infer<typeof DockerDiskPart>;

const Bytes = z.number().int().min(0);
const CleanedEntry = z.object({ part: DockerDiskPart, bytes: Bytes, at: z.iso.datetime() });
const RawDockerDisk = z.object({
  at: z.iso.datetime(),
  parts: z.record(z.string(), z.unknown()).default({}),
  cleaned: z.array(z.unknown()).default([]),
});

export type DockerDisk = {
  parts: Partial<Record<DockerDiskPart, number>>;
  cleaned: DiskReport['cleaned'];
};

/* Reads a regular, non-symlinked file up to MAX_BYTES so a link, FIFO or oversized file is ignored safely. */
function readCapped(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = Buffer.allocUnsafe(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buf.length) {
      const read = readSync(fd, buf, offset, buf.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    return offset > MAX_BYTES ? null : buf.subarray(0, offset).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function dockerParts(raw: Record<string, unknown>): DockerDisk['parts'] {
  const parts: DockerDisk['parts'] = {};
  for (const part of DOCKER_DISK_PARTS) {
    const parsed = Bytes.safeParse(raw[part]);
    if (parsed.success) parts[part] = parsed.data;
  }
  return parts;
}

function dockerCleaned(raw: unknown[], cutoff: number, maxFuture: number): DiskReport['cleaned'] {
  const entries: DiskReport['cleaned'] = [];
  for (const item of raw) {
    const parsed = CleanedEntry.safeParse(item);
    if (!parsed.success || parsed.data.bytes <= 0) continue;
    const atMs = Date.parse(parsed.data.at);
    if (atMs >= cutoff && atMs <= maxFuture) entries.push(parsed.data);
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, DISK_CLEANED_MAX);
}

/* Reads the updater's latest Docker disk report from <dir>/docker-disk.json. Only Docker's four parts and recent
   removals within 24 hours (and within 5 minutes of clock skew) are accepted; missing, stale, future, symlinked,
   oversized or malformed files return null. */
export function readDockerDisk(dir: string, now: Date = new Date()): DockerDisk | null {
  const text = readCapped(join(dir, DOCKER_DISK_FILE));
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = RawDockerDisk.safeParse(json);
  if (!parsed.success) return null;
  const nowMs = now.getTime();
  const cutoff = nowMs - MAX_AGE_MS;
  const maxFuture = nowMs + MAX_FUTURE_MS;
  const atMs = Date.parse(parsed.data.at);
  if (atMs < cutoff || atMs > maxFuture) return null;
  return { parts: dockerParts(parsed.data.parts), cleaned: dockerCleaned(parsed.data.cleaned, cutoff, maxFuture) };
}
