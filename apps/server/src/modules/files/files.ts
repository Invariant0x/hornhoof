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
import { copiesStand, FRESH_MS, placeFiles } from './place.js';
import { FileStore, type StoreRoom, type StoredFile } from './store.js';

/* How long a read waits for a machine that holds a file this one lacks to send it. */
export const WANT_WAIT_MS = 30_000;
/* How long an upload waits for the machines picked to keep its file, online now, before it is answered all the same. */
export const SETTLE_MS = 10_000;
const WANT_LOOK_MS = 250;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
type Tx = Pick<Db, 'execute'>;
/* The database, or a transaction of it. */
export type FilesDb = Tx;

/* A file as a row names it. */
export type Kept = { sha256: string; size: number };

export const fileAway = () =>
  new ApiError(503, 'unavailable', 'This file is kept on a machine of the company that is away now. Try again once it is back.', 'file_away');

/* Records a file the store of this machine keeps, and that this machine keeps it. A record there already keeps its
   sealed facts, which every copy has: the caller sealed this one under its salt (sealedAsRecorded). A file named again
   is in use again. */
export async function recordFile(tx: Tx, kept: StoredFile, machineId: string | null): Promise<void> {
  await tx.execute(sql`INSERT INTO net.files (sha256, size, sealed_sha256, sealed_size, salt) VALUES (${kept.sha256}, ${kept.size}, ${kept.sealedSha256}, ${kept.sealedSize}, ${kept.salt})
    ON CONFLICT (sha256) DO UPDATE SET unused_since = NULL, drop_at = NULL, wanted_at = NULL`);
  if (machineId) await tx.execute(sql`INSERT INTO net.file_copies (sha256, machine_id, verified) VALUES (${kept.sha256}, ${machineId}, true) ON CONFLICT (sha256, machine_id) DO UPDATE SET verified = true`);
}

/* A file this machine sealed, as the record of its content would have it: one the store keeps a record of already, and
   so copies of elsewhere, is sealed here again under the record's salt, so this copy is the very bytes theirs are and
   any machine takes it from this one or gives it back to it. */
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
  /* The last name the store's round checked this machine's copies through, placed files through, and looked at their
     targets through; '' to start again from the first. */
  checkedThrough = '';
  placedThrough = '';
  trimmedThrough = '';
  /* The most this machine keeps of files it is not picked for, as a read or an upload left them, once their copies stand
     elsewhere: min(2 GiB, a fifth of its free disk) unless set. */
  transitBytes: number | null = null;

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

  /* Keeps a file's bytes as they come, records them and picks the machines that are to keep them; the row that names it
     is the caller's. The record names the
     content in use again under its lock, so the store's round cannot take it away after this: a content it took away
     just before is not here any more, and the file is to be sent again. */
  async put(db: FilesDb, input: Readable | AsyncIterable<Buffer>, room?: StoreRoom): Promise<Kept> {
    const store = this.store();
    const key = await this.key(db);
    const kept = await sealedAsRecorded(db, store, await store.put(input, key, room), key);
    const mine = await this.machineId(db);
    await recordFile(db, kept, mine);
    await placeFiles(db, mine, { only: [kept.sha256] });
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

  /* Whether the file stands on as many machines as it wants, online or not this minute. */
  async copiesStand(db: FilesDb, sha256: string): Promise<boolean> {
    return copiesStand(db, await this.machineId(db), sha256);
  }

  /* Waits until every machine picked for the file that is online now keeps it, for at most a short while: a file of a
     company with one machine, or whose other machines are away, is kept at once. */
  async settled(db: FilesDb, sha256: string, waitMs = SETTLE_MS): Promise<boolean> {
    const mine = await this.machineId(db);
    const waiting = async () =>
      rowsOf<{ n: number }>(
        await db.execute(sql`SELECT count(*)::int AS n FROM net.file_targets t JOIN machines m ON m.id = t.machine_id WHERE t.sha256 = ${sha256}
          AND (t.machine_id = ${mine} OR m.report_at > ${new Date(Date.now() - FRESH_MS).toISOString()}::timestamptz)
          AND NOT EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = t.sha256 AND c.machine_id = t.machine_id AND c.verified)`),
      )[0]?.n ?? 0;
    for (let waited = 0; waited < waitMs; waited += WANT_LOOK_MS) {
      if ((await waiting()) === 0) return true;
      await new Promise(resolve => setTimeout(resolve, WANT_LOOK_MS));
    }
    return (await waiting()) === 0;
  }
}

/* One service for each settings of an app, so every part of the app finds the same store. */
const services = new WeakMap<Config, Files>();
export function filesFor(config: Config): Files {
  let found = services.get(config);
  if (!found) services.set(config, (found = new Files(config)));
  return found;
}
