import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const KEEPER_FILE = 'keeper.json';
const FRESH_MS = 10_000;

export const MODES = ['lead', 'read', 'maintenance', 'off'] as const;
export type Mode = (typeof MODES)[number];

const KeeperStateShape = z.object({
  mode: z.enum(MODES),
  at: z.string(),
  link: z.object({ host: z.string().nullable(), fingerprint256: z.string().nullable() }).nullable(),
});
export type KeeperState = z.infer<typeof KeeperStateShape>;

/* The keeper's last word, or null when the file is missing, cut short or not this shape: the app then keeps what it has. */
export function readKeeperState(dir: string): KeeperState | null {
  try {
    const parsed = KeeperStateShape.safeParse(JSON.parse(readFileSync(join(dir, KEEPER_FILE), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* Written whole and then renamed, so the app never reads half a word. The file holds no key and no token, so any
   reader may have it. */
export function writeKeeperState(dir: string, state: KeeperState): void {
  const path = join(dir, KEEPER_FILE);
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify(state));
  chmodSync(partial, 0o644);
  renameSync(partial, path);
}

/* The word, only while it is recent: a keeper that stopped writing is not obeyed. A word from the future means the clock
   stepped back, so it says nothing about whether the keeper still lives; a live keeper's next word is obeyed anyway. */
export function freshState(dir: string, now: number, staleMs = FRESH_MS): KeeperState | null {
  const state = readKeeperState(dir);
  if (!state) return null;
  const age = now - Date.parse(state.at);
  return age >= 0 && age <= staleMs ? state : null;
}
