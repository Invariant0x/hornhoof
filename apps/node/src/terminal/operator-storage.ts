import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';

/* Corrupted evidence or execution history fails closed instead of forgetting a possibly applied key. */
export function readOperatorStore<T>(file: string, schema: z.ZodType<T>, empty: T): T {
  return existsSync(file) ? schema.parse(JSON.parse(readFileSync(file, 'utf8'))) : empty;
}

export function writeOperatorStore(file: string, state: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.new`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${file}.new`, file);
}
