import { join, resolve } from 'node:path';
import type { JobUser } from '../isolation.js';

export type StoreOwner = { user: JobUser | null; home: string | null };

/* Per-UID package store root. Personal subscription nodes share one UID across every agent on the node, so their store
   lives at <dir>/work/.pkg-store (counted inside workingCopies and owned by that user). Built-in nodes give each API key
   or agent its own UID and home outside <dir>/home, so each gets its own <owner.home>/.pkg-store with no cross-UID sharing. */
export function storeDir(dir: string, owner: StoreOwner): string {
  const sharedHome = resolve(dir, 'home');
  if (owner.home && resolve(owner.home) !== sharedHome) return join(owner.home, '.pkg-store');
  return join(dir, 'work', '.pkg-store');
}

/* Turn environment variables for pnpm's hard-linked content-addressable store and npm's tarball cache, scoped to the
   turn's UID boundary. Values already set by the operator or environment stay as they are. */
export function packageStoreEnv(
  dir: string,
  owner: StoreOwner,
  existing: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const root = storeDir(dir, owner);
  const env: Record<string, string> = {};
  if (!existing.PNPM_STORE_DIR) env.PNPM_STORE_DIR = join(root, 'pnpm');
  if (!existing.npm_config_cache) env.npm_config_cache = join(root, 'npm');
  return env;
}
