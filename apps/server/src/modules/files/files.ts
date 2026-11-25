import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import { FileStore, type StoreRoom, type StoredFile } from './store.js';

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
type Tx = Pick<Db, 'execute'>;
/* The database, or a transaction of it. */
export type FilesDb = Tx;

/* A file as a row names it. */
export type Kept = { sha256: string; size: number };

/* A file a row names that the store does not keep: lost from the server's disk. */
export const storeLost = () => new ApiError(410, 'gone', "This file is not in the company's file store any more, and no copy of it is left.", 'file_lost');

/* Records a file the store keeps. A record there already keeps its sealed facts: the caller sealed this copy under its
   salt (sealedAsRecorded). A file named again is in use again. */
export async function recordFile(tx: Tx, kept: StoredFile): Promise<void> {
  await tx.execute(sql`INSERT INTO net.files (sha256, size, sealed_sha256, sealed_size, salt) VALUES (${kept.sha256}, ${kept.size}, ${kept.sealedSha256}, ${kept.sealedSize}, ${kept.salt})
    ON CONFLICT (sha256) DO UPDATE SET unused_since = NULL, drop_at = NULL`);
}

/* A file sealed here, as the record of its content would have it: one the store keeps a record of already is sealed again
   under the record's salt, so every copy of a content is the very bytes its record names. */
export async function sealedAsRecorded(tx: Tx, store: FileStore, kept: StoredFile, key: Buffer): Promise<StoredFile> {
  const [record] = rowsOf<{ sealed_sha256: string; sealed_size: string; salt: string }>(
    await tx.execute(sql`SELECT sealed_sha256, sealed_size, salt FROM net.files WHERE sha256 = ${kept.sha256}`),
  );
  if (!record || record.sealed_sha256 === kept.sealedSha256) return kept;
  const again = await store.reseal(kept.sha256, key, record.salt);
  if (again.sealedSha256 !== record.sealed_sha256 || again.sealedSize !== Number(record.sealed_size)) {
    throw new Error('A file sealed again under its salt is not the bytes its record names.');
  }
  return { ...kept, ...again };
}

/* The company's files as this app keeps and reads them: in the store on this server's disk, FILES_DIR, sealed with the
   key the database keeps under the company secret. Each call names the database, or the transaction, it reads and
   records in. */
export class Files {
  private keyKnown: { enc: string; key: Buffer } | null = null;
  private ownStore: FileStore | null = null;
  private ownDir: string | null = null;

  constructor(private readonly config: Config) {}

  /* The store: in FILES_DIR, or, where none is set, in a folder of this run alone. */
  store(): FileStore {
    const dir = this.config.filesDir ? join(this.config.filesDir, 'store') : (this.ownDir ??= mkdtempSync(join(tmpdir(), 'hornhoof-files-')));
    if (this.ownStore?.dir !== dir) this.ownStore = new FileStore(dir);
    return this.ownStore;
  }

  /* The store key, made once by the first app that needs it: two at once make one, as the second finds the first's. It
     is read each time in the database or transaction asked, as one made in a transaction that is rolled back is gone;
     only the opening of the text found is kept. */
  async key(db: Tx): Promise<Buffer> {
    const { config } = this;
    const read = async () => rowsOf<{ key_enc: string }>(await db.execute(sql`SELECT key_enc FROM net.file_key`))[0]?.key_enc;
    let enc = await read();
    if (!enc) {
      await db.execute(sql`INSERT INTO net.file_key (key_enc) VALUES (${encryptSecret(randomBytes(32).toString('base64'), config.secret)}) ON CONFLICT DO NOTHING`);
      enc = await read();
    }
    if (this.keyKnown?.enc === enc) return this.keyKnown.key;
    const key = Buffer.from(decryptSecret(enc!, config.secret), 'base64');
    if (key.length !== 32) throw new Error('The store key the database keeps is not 32 bytes.');
    this.keyKnown = { enc: enc!, key };
    return key;
  }

  /* Keeps a file's bytes as they come and records them; the row that names it is the caller's. The record names the
     content in use again under its lock, so the store's round cannot take it away after this: a content it took away
     just before is not here any more, and the file is to be sent again. */
  async put(db: FilesDb, input: Readable | AsyncIterable<Buffer>, room?: StoreRoom): Promise<Kept> {
    const store = this.store();
    const key = await this.key(db);
    const kept = await sealedAsRecorded(db, store, await store.put(input, key, room), key);
    await recordFile(db, kept);
    if (!store.has(kept.sha256)) throw new ApiError(503, 'unavailable', 'The same file was leaving the store as it came. Send it again.', 'file_retry');
    return { sha256: kept.sha256, size: kept.size };
  }

  /* Keeps bytes that are here whole already; once more when the same content was leaving the store as they came. */
  async putBytes(db: FilesDb, bytes: Buffer | Uint8Array): Promise<Kept> {
    try {
      return await this.put(db, Readable.from([Buffer.from(bytes)]));
    } catch (err) {
      if (err instanceof ApiError && err.reason === 'file_retry') return this.put(db, Readable.from([Buffer.from(bytes)]));
      throw err;
    }
  }

  /* A file's bytes as they go out, opened with the store key and checked against its name as they go. */
  async open(db: FilesDb, sha256: string): Promise<Readable> {
    const key = await this.key(db);
    const store = this.store();
    if (!store.has(sha256)) throw storeLost();
    return store.open(sha256, key);
  }

  /* A small file's bytes whole. */
  async bytes(db: FilesDb, sha256: string): Promise<Buffer> {
    return buffer(await this.open(db, sha256));
  }
}

/* One service for each settings of an app, so every part of the app finds the same store. */
const services = new WeakMap<Config, Files>();
export function filesFor(config: Config): Files {
  let found = services.get(config);
  if (!found) services.set(config, (found = new Files(config)));
  return found;
}
