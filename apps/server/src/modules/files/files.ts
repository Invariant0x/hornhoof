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

/* How long a read waits for a machine that holds a file this one lacks to send it. */
export const WANT_WAIT_MS = 30_000;
/* How long an upload waits for a second machine to keep its file before it is answered all the same. */
export const SETTLE_MS = 10_000;
const WANT_LOOK_MS = 250;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
type Tx = Pick<Db, 'execute'>;
/* The database, or a transaction of it. */
export type FilesDb = Tx;

/* Whether any machine besides this one is to keep the files: another data machine, or one picked to hold them. */
async function holdersBesides(db: Tx, mine: string | null): Promise<boolean> {
  const [row] = rowsOf<{ there: boolean }>(
    await db.execute(sql`SELECT EXISTS (SELECT 1 FROM machines WHERE role = 'data' AND revoked_at IS NULL AND id IS DISTINCT FROM ${mine})
      OR EXISTS (SELECT 1 FROM net.file_holders WHERE machine_id IS DISTINCT FROM ${mine}) AS there`),
  );
  return Boolean(row?.there);
}

/* A file as a row names it. */
export type Kept = { sha256: string; size: number };

export const fileAway = () =>
  new ApiError(503, 'unavailable', 'This file is kept on a machine of the company that is away now. Try again once it is back.', 'file_away');

/* Records a file the store of this machine keeps, and that this machine keeps it. A record there already takes the
   sealed facts of the copy here, which is the one this machine sends on; a copy another machine holds opens to the same
   bytes. A file named again is in use again. */
export async function recordFile(tx: Tx, kept: StoredFile, machineId: string | null): Promise<void> {
  await tx.execute(sql`INSERT INTO net.files (sha256, size, sealed_sha256, sealed_size) VALUES (${kept.sha256}, ${kept.size}, ${kept.sealedSha256}, ${kept.sealedSize})
    ON CONFLICT (sha256) DO UPDATE SET sealed_sha256 = excluded.sealed_sha256, sealed_size = excluded.sealed_size, unused_since = NULL, drop_at = NULL, wanted_at = NULL`);
  if (machineId) await tx.execute(sql`INSERT INTO net.file_copies (sha256, machine_id) VALUES (${kept.sha256}, ${machineId}) ON CONFLICT DO NOTHING`);
}

/* The company's files as this app keeps and reads them: in the store of this machine, sealed with the key the database
   keeps under the company secret. A file this machine lacks is asked of the machines that hold it. Each call names the
   database, or the transaction, it reads and records in. */
export class Files {
  private keyKnown: { enc: string; key: Buffer } | null = null;
  private ownStore: FileStore | null = null;
  private ownDir: string | null = null;
  private machine: string | null = null;
  /* How long a read waits for a file this machine lacks; a test waits less. */
  wantWaitMs = WANT_WAIT_MS;
  /* The last name the store's round checked this machine's copies through; '' to start again from the first. */
  checkedThrough = '';

  constructor(private readonly config: Config) {}

  /* The store of this machine: in FILES_DIR, or, where none is set, in a folder of this run alone. */
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

  /* This machine's row, which holds what its store keeps; none where the app runs without a machine id. A row found is
     kept, and one not found looked for again next time, as the app makes its row once it leads. */
  async machineId(db: FilesDb): Promise<string | null> {
    if (!this.machine && this.config.machineId) {
      const found = await db.execute(sql`SELECT id FROM machines WHERE network_id = ${this.config.machineId} AND revoked_at IS NULL`).catch(() => null);
      this.machine = found ? (rowsOf<{ id: string }>(found)[0]?.id ?? null) : null;
    }
    return this.machine;
  }

  /* Keeps a file's bytes as they come and records them; the row that names it is the caller's. The record names the
     content in use again under its lock, so the store's round cannot take it away after this: a content it took away
     just before is not here any more, and the file is to be sent again. */
  async put(db: FilesDb, input: Readable | AsyncIterable<Buffer>, room?: StoreRoom): Promise<Kept> {
    const store = this.store();
    const kept = await store.put(input, await this.key(db), room);
    await recordFile(db, kept, await this.machineId(db));
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

  /* A file's bytes as they go out. One this machine lacks is asked for, and waited for a while. */
  async open(db: FilesDb, sha256: string, waitMs = this.wantWaitMs): Promise<Readable> {
    const key = await this.key(db);
    const store = this.store();
    if (store.has(sha256)) return store.open(sha256, key);
    await db.execute(sql`UPDATE net.files SET wanted_at = now() WHERE sha256 = ${sha256}`);
    for (let waited = 0; waited < waitMs; waited += WANT_LOOK_MS) {
      await new Promise(resolve => setTimeout(resolve, WANT_LOOK_MS));
      if (store.has(sha256)) return store.open(sha256, key);
    }
    throw fileAway();
  }

  /* A small file's bytes whole. */
  async bytes(db: FilesDb, sha256: string): Promise<Buffer> {
    return buffer(await this.open(db, sha256));
  }

  /* Waits until a machine besides this one keeps the file, while another machine could, for at most a short while. */
  async settled(db: FilesDb, sha256: string, waitMs = SETTLE_MS): Promise<boolean> {
    const mine = await this.machineId(db);
    const others = async () =>
      rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM net.file_copies WHERE sha256 = ${sha256} AND machine_id IS DISTINCT FROM ${mine}`))[0]?.n ?? 0;
    if (!(await holdersBesides(db, mine))) return true;
    for (let waited = 0; waited < waitMs; waited += WANT_LOOK_MS) {
      if ((await others()) > 0) return true;
      await new Promise(resolve => setTimeout(resolve, WANT_LOOK_MS));
    }
    return (await others()) > 0;
  }
}

/* One service for each settings of an app, so every part of the app finds the same store. */
const services = new WeakMap<Config, Files>();
export function filesFor(config: Config): Files {
  let found = services.get(config);
  if (!found) services.set(config, (found = new Files(config)));
  return found;
}
