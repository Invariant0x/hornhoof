import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KEEPER_DIR = '/keeper';
const KEY_FILE = 'machine.key';

export type MachineKey = { privatePem: string; publicPem: string };

/* What a file or a text holds as JSON; null for one that is missing or is not JSON. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function readJson(path: string): unknown {
  try {
    return jsonOf(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/* Whether a failure that lasts may be said now: each kind once an hour at most. */
export class Hourly {
  private readonly saidAt = new Map<string, number>();

  due(what: string): boolean {
    const now = Date.now();
    if (now - (this.saidAt.get(what) ?? -Infinity) < 3_600_000) return false;
    this.saidAt.set(what, now);
    return true;
  }
}

/* What a failure says of itself. */
export const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/* Written whole and then renamed, so a crash leaves the old file or the new one and never half of it. */
export function writePrivately(path: string, text: string): void {
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, text, { mode: 0o600 });
  renameSync(partial, path);
}

function pemsOf(key: KeyObject): MachineKey {
  return {
    privatePem: key.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string,
  };
}

/* Only a missing file means no key: a read that fails for another reason must not cost the machine its identity. */
function readKeyFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function parseKey(pem: string): MachineKey | null {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? pemsOf(key) : null;
  } catch {
    return null;
  }
}

function makeKey(path: string): MachineKey {
  const pair = pemsOf(generateKeyPairSync('ed25519').privateKey);
  writePrivately(path, pair.privatePem);
  return pair;
}

/* The machine's Ed25519 key, in the keeper's own volume. It throws when the folder cannot be written, and its caller
   tries again. */
export function machineKey(dir: string): MachineKey {
  const path = join(dir, KEY_FILE);
  const pem = readKeyFile(path);
  return (pem === null ? null : parseKey(pem)) ?? makeKey(path);
}
