import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writePrivately } from './machine-keys.js';

/* The key of the machine's owner as the keeper pinned it: the one the command the owner ran here carried. It lives in
   the keeper's own volume, and no answer of any server ever writes it. */
export const PIN_FILE = 'owner.json';

const Pin = z.object({ key: z.string().min(1), at: z.string() });

export function readPin(dir: string): string | null {
  const pin = Pin.safeParse(readJson(join(dir, PIN_FILE)));
  return pin.success ? pin.data.key : null;
}

/* Written whole and then moved, for its owner alone. */
export function pinKey(dir: string, key: string): void {
  writePrivately(join(dir, PIN_FILE), JSON.stringify({ key, at: new Date().toISOString() }));
}
