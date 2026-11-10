import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';

/* A corrupted evidence outbox or case history fails closed instead of forgetting what it held. */
export function readOperatorStore<T>(file: string, schema: z.ZodType<T>, empty: T): T {
  return existsSync(file) ? schema.parse(JSON.parse(readFileSync(file, 'utf8'))) : empty;
}

export function writeOperatorStore(file: string, state: unknown): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  writeTemporary(`${file}.new`, JSON.stringify(state));
  renameSync(`${file}.new`, file);
  syncDirectory(directory);
}

function writeTemporary(file: string, json: string): void {
  const fd = openSync(file, 'w', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, json);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); }
  catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally { closeSync(fd); }
}

function unsupportedDirectorySync(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(error.code));
}
