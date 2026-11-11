import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { writePrivately } from './machine-keys.js';

/* The machine's own key for backups, in its keeper's folder. The company seals its bundles to the public half of a
   machine that holds its data; the private half never leaves this folder. */
export const AGE_KEY_FILE = 'age.key';

async function recipientOf(identity: string): Promise<string | null> {
  try {
    return await identityToRecipient(identity);
  } catch {
    /* What the library says of a key it refuses can quote the key: nothing of it is passed on. */
    return null;
  }
}

function kept(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/* The key, made once and kept for the keeper alone. One that is missing, or does not decode whole, is replaced by a new
   one: bundles sealed to the old key then open only with the recovery file. */
export async function ageKey(dir: string): Promise<{ identity: string; recipient: string }> {
  const file = join(dir, AGE_KEY_FILE);
  const held = kept(file);
  const recipient = held ? await recipientOf(held) : null;
  if (held && recipient) {
    chmodSync(file, 0o600);
    return { identity: held, recipient };
  }
  const identity = await generateX25519Identity();
  writePrivately(file, `${identity}\n`);
  return { identity, recipient: await identityToRecipient(identity) };
}
