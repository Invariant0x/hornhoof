import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { filesFor } from '../src/modules/files/files.js';
import { TEST_SECRET } from './helpers-basic.js';

/* What a test with no app keeps its files under: the tests' secret, so an app on the same database opens the same store
   key, and a store of its own. */
const LOOSE = { secret: Buffer.from(TEST_SECRET, 'base64') } as Config;

/* The store a test with no app reads and writes. */
export const looseFiles = () => filesFor(LOOSE);

/* Puts bytes into the store the app of these settings reads, or into one of the test's own, and gives the hash a row of
   attachments names them by. */
export async function stored(db: Pick<Db, 'execute'>, bytes: Buffer | Uint8Array | string, config: Config = LOOSE): Promise<string> {
  return (await filesFor(config).putBytes(db, typeof bytes === 'string' ? Buffer.from(bytes) : bytes)).sha256;
}

export const sha256Of = (bytes: Buffer | Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/* The names of every plain file under a folder, temporary ones too, in order. */
export const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort();
