import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { MIGRATIONS } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { Files, type FilesDb } from '../src/modules/files/files.js';
import { approveMove, fileMoves } from '../src/modules/files/move.js';
import { moveOldFiles } from '../src/modules/files/mover.js';
import { dropDue, markUnused, UNUSED_MS } from '../src/modules/files/sweep.js';
import { dropOldFiles, fileBytes } from '../src/modules/tasks/attachments.js';
import { TEST_SECRET } from './helpers-basic.js';
import { createTestDb, freshPglite, ownDatabases } from './helpers-db.js';
import { migrate, migrationsUpTo } from './migrations-fixture.js';

ownDatabases();

/* The move of an installation of 0.43, whose files are in Postgres or on the disk of the machine that took them, into
   the store: lossless, checked by hash, resumable, and with the column and its room gone at the end. Synthetic bytes only. */

const TURN_43 = '0161_minute_query_indexes';
const COMPANY = '00000000-0000-4000-8000-000000000001';
const AGENT = '00000000-0000-4000-8000-000000000004';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-move-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

type Old = { id: string; bytes: Buffer; disk?: boolean };

/* A database of 0.43 with these files, then migrated to this build. A file on disk lies in FILES_DIR under its row's id,
   and its row keeps no byte, as 0.43 kept one over 50 MB. */
async function upgraded(files: Old[], filesDir: string) {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client, { schema });
  await migrate(drizzle(client), { migrationsFolder: await migrationsUpTo(TURN_43) });
  await client.exec(`
    insert into companies (id, name) values ('${COMPANY}', 'Acme');
    insert into agents (id, company_id, kind, name, model) values ('${AGENT}', '${COMPANY}', 'worker', 'Developer', '');
  `);
  for (const file of files) {
    await client.query('insert into attachments (id, company_id, agent_id, media_type, bytes, size) values ($1, $2, $3, $4, $5, $6)', [
      file.id, COMPANY, AGENT, 'application/octet-stream', file.disk ? new Uint8Array() : new Uint8Array(file.bytes), file.bytes.length,
    ]);
    if (file.disk) writeFileSync(join(filesDir, file.id), file.bytes);
  }
  const sizeBefore = rowsOf<{ n: string }>(await db.execute(sql`SELECT pg_total_relation_size('attachments') AS n`))[0]!.n;
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  return { client, db: db as unknown as Db, sizeBefore: Number(sizeBefore) };
}

/* The CEO says yes to every reconciliation that waits for it, as he would to the one he was shown. */
const approveAll = async (db: FilesDb) => {
  for (const move of await fileMoves(db)) if (!move.approvedAt) await approveMove(db, move.digest, 'person:ceo');
};

const columnsOf = async (db: FilesDb) =>
  rowsOf<{ name: string }>(await db.execute(sql`SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'attachments' AND column_name IN ('bytes', 'sha256') ORDER BY 1`)).map(row => row.name);
const byteaColumns = async (db: FilesDb) =>
  rowsOf<{ name: string }>(await db.execute(sql`SELECT table_schema || '.' || table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema IN ('public', 'net') AND data_type = 'bytea'`));

describe('the files of an installation from before the store', () => {
  it('leave no bytea column on a fresh install, nor on one of 0.43 that kept no file', async () => {
    expect(await byteaColumns(await createTestDb())).toEqual([]);
    const { db } = await upgraded([], folder());
    expect([await columnsOf(db), await byteaColumns(db)]).toEqual([['sha256'], []]);
  });

  it('move into the store a few at a time, checked by hash, go on after an interruption, and leave Postgres with no byte of them', async () => {
    const filesDir = folder();
    const same = randomBytes(40_000);
    const old: Old[] = [
      { id: randomUUID(), bytes: randomBytes(300_000) },
      { id: randomUUID(), bytes: randomBytes(1) },
      { id: randomUUID(), bytes: Buffer.alloc(0) },
      { id: randomUUID(), bytes: same },
      { id: randomUUID(), bytes: same },
      { id: randomUUID(), bytes: randomBytes(2_500_000) },
      { id: randomUUID(), bytes: randomBytes(700_000) },
      { id: randomUUID(), bytes: randomBytes(900_000), disk: true },
    ];
    const { db, sizeBefore } = await upgraded(old, filesDir);
    expect(await columnsOf(db)).toEqual(['bytes', 'sha256']);
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;

    /* The app stops right after it stored a file and before its row gave up the bytes. */
    class Stopping extends Files {
      override async settled(): Promise<boolean> {
        throw new Error('the app stopped');
      }
    }
    await expect(moveOldFiles({ db, config, files: new Stopping(config) })).rejects.toThrow('the app stopped');
    expect(rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM attachments WHERE bytes IS NOT NULL`))[0]!.n).toBe(old.length);

    /* A row whose bytes change between the store and its update keeps them, and its new bytes move later. */
    const changed = Buffer.from('changed under the mover');
    let changedOnce = false;
    class Changing extends Files {
      override async settled(on: FilesDb, sha256: string, waitMs?: number): Promise<boolean> {
        if (!changedOnce && sha256 === sha(old[6]!.bytes)) {
          changedOnce = true;
          await on.execute(sql`UPDATE attachments SET bytes = ${changed}, size = ${changed.length} WHERE id = ${old[6]!.id}`);
        }
        return super.settled(on, sha256, waitMs);
      }
    }
    /* Started again, it moves in rounds of a few rows: a clock that moves on with every look ends each round early. */
    const files = new Changing(config);
    let tick = 0;
    for (let round = 0; round < 20 && (await columnsOf(db)).includes('bytes'); round++) {
      await moveOldFiles({ db, config, files }, { budgetMs: 2, now: () => tick++ });
      await approveAll(db);
    }
    expect(changedOnce).toBe(true);
    /* One reconciliation, made once every row was named, the changed one with its new bytes. */
    expect(await fileMoves(db)).toMatchObject([{ files: old.length, left: 0, clearedAt: expect.any(String) }]);

    expect([await columnsOf(db), await byteaColumns(db)]).toEqual([['sha256'], []]);
    const ctx = { db, config, files: new Files(config) };
    const kept = rowsOf<{ id: string; sha256: string | null }>(await db.execute(sql`SELECT id, sha256 FROM attachments`));
    const want = old.map(file => (file.id === old[6]!.id ? changed : file.bytes));
    for (const [at, file] of old.entries()) {
      expect(kept.find(row => row.id === file.id)!.sha256, `file ${at}`).toBe(sha(want[at]!));
      expect((await fileBytes(ctx, file.id)).equals(want[at]!), `file ${at}`).toBe(true);
    }
    /* Each content is in the store once, the one the changed row had too until the store's round lets it go, and the disk
       file of 0.43 is gone, as its bytes are in the store. */
    const contents = new Set([...want.map(sha), sha(old[6]!.bytes)]);
    expect((await ctx.files.store().list()).map(file => file.sha256).sort()).toEqual([...contents].sort());
    expect(existsSync(join(filesDir, old[7]!.id))).toBe(false);
    /* The table gave its room back. */
    const sizeAfter = Number(rowsOf<{ n: string }>(await db.execute(sql`SELECT pg_total_relation_size('attachments') AS n`))[0]!.n);
    expect(sizeAfter).toBeLessThan(sizeBefore / 4);
  });

  it('keep a big file that lies on the disk of another machine for that machine to move, and read an empty one as empty', async () => {
    const filesDir = folder();
    const elsewhere: Old = { id: randomUUID(), bytes: randomBytes(5000), disk: true };
    const empty: Old = { id: randomUUID(), bytes: Buffer.alloc(0) };
    const { db } = await upgraded([elsewhere, empty], filesDir);
    /* The disk file is on another machine: this one's folder lacks it. */
    rmSync(join(filesDir, elsewhere.id));
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    const ctx = { db, config, files: new Files(config) };
    /* The column holds no byte of either, so it went with the migration. */
    expect(await columnsOf(db)).toEqual(['sha256']);
    await moveOldFiles(ctx);
    expect((await fileBytes(ctx, empty.id)).length).toBe(0);
    await expect(fileBytes(ctx, elsewhere.id)).rejects.toMatchObject({ status: 410 });
    /* That machine leads later, with the file on its disk: it moves it. */
    writeFileSync(join(filesDir, elsewhere.id), elsewhere.bytes);
    await moveOldFiles({ db, config, files: new Files(config) });
    expect(rowsOf<{ sha256: string }>(await db.execute(sql`SELECT sha256 FROM attachments WHERE id = ${elsewhere.id}`))[0]!.sha256).toBe(sha(elsewhere.bytes));
    expect((await fileBytes(ctx, elsewhere.id)).equals(elsewhere.bytes)).toBe(true);
    /* Its disk file goes only with the CEO's yes. */
    expect(existsSync(join(filesDir, elsewhere.id))).toBe(true);
    await approveAll(db);
    expect(await moveOldFiles(ctx)).toEqual({ moved: 0, waiting: 0, cleared: 1, finished: true });
    expect(existsSync(join(filesDir, elsewhere.id))).toBe(false);
    expect((await fileBytes(ctx, elsewhere.id)).equals(elsewhere.bytes)).toBe(true);
  });
});

const withBytes = async (db: FilesDb) => rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM attachments WHERE bytes IS NOT NULL`))[0]!.n;
const nameOf = async (db: FilesDb, id: string) => rowsOf<{ sha256: string | null }>(await db.execute(sql`SELECT sha256 FROM attachments WHERE id = ${id}`))[0]!.sha256;
/* Another machine the company has, picked to keep its files, which keeps none of them yet. */
const holder = async (db: FilesDb) => {
  const machine = randomUUID();
  await db.execute(sql`INSERT INTO net.file_holders (machine_id) VALUES (${machine})`);
  return { keeps: (sha256: string) => db.execute(sql`INSERT INTO net.file_copies (sha256, machine_id) VALUES (${sha256}, ${machine})`) };
};

describe('the mover', () => {
  it('leaves the bytes in Postgres while the server has no FILES_DIR to keep them in, and says so once', async () => {
    const file: Old = { id: randomUUID(), bytes: randomBytes(5000) };
    const { db } = await upgraded([file], folder());
    const config = { secret: Buffer.from(TEST_SECRET, 'base64') } as Config;
    const files = new Files(config);
    expect(await moveOldFiles({ db, config, files })).toEqual({ moved: 0, waiting: 0, finished: false, stays: 'no_files_dir' });
    expect(await moveOldFiles({ db, config, files })).toEqual({ moved: 0, waiting: 0, finished: false });
    expect([await withBytes(db), await columnsOf(db), await nameOf(db, file.id)]).toEqual([1, ['bytes', 'sha256'], null]);
    expect((await fileBytes({ db, config, files }, file.id)).equals(file.bytes)).toBe(true);
  });

  it('names no row by its stored file until a second machine keeps the file, and then each as its file is kept', async () => {
    const filesDir = folder();
    const [one, two]: Old[] = [{ id: randomUUID(), bytes: randomBytes(3000) }, { id: randomUUID(), bytes: randomBytes(4000) }];
    const { db } = await upgraded([one!, two!], filesDir);
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    const ctx = { db, config, files: new Files(config) };
    const other = await holder(db);
    expect(await moveOldFiles(ctx)).toEqual({ moved: 0, waiting: 2, finished: false });
    expect(await withBytes(db)).toBe(2);
    expect((await ctx.files.store().list()).map(file => file.sha256).sort()).toEqual([sha(one!.bytes), sha(two!.bytes)].sort());
    await other.keeps(sha(one!.bytes));
    expect(await moveOldFiles(ctx)).toEqual({ moved: 1, waiting: 1, finished: false });
    expect([await nameOf(db, one!.id), await nameOf(db, two!.id), await withBytes(db)]).toEqual([sha(one!.bytes), null, 2]);
    await other.keeps(sha(two!.bytes));
    expect(await moveOldFiles(ctx)).toMatchObject({ moved: 1, waiting: 0, finished: false, ready: { files: 2 } });
    expect(await withBytes(db)).toBe(2);
    await approveAll(db);
    expect(await moveOldFiles(ctx)).toEqual({ moved: 0, waiting: 0, cleared: 2, finished: true, roomBack: { before: expect.any(Number), after: expect.any(Number) } });
    expect(await columnsOf(db)).toEqual(['sha256']);
    for (const file of [one!, two!]) expect((await fileBytes(ctx, file.id)).equals(file.bytes)).toBe(true);
  });

  it('names no row by a stored copy that does not open to its bytes, and goes on with the rows after it', async () => {
    const filesDir = folder();
    const [swapped, broken, fine]: Old[] = [0, 1, 2].map(n => ({ id: randomUUID(), bytes: randomBytes(3000 + n) }));
    const { db } = await upgraded([swapped!, broken!, fine!], filesDir);
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    /* By the time the mover opens it again, one copy on the disk is the sealed file of other bytes, and one has a byte
       changed, as a fault of the disk or a hand may leave them. */
    class Spoiling extends Files {
      override async put(...args: Parameters<Files['put']>): ReturnType<Files['put']> {
        const kept = await super.put(...args);
        const store = this.store();
        if (kept.sha256 === sha(swapped!.bytes)) {
          const other = await store.put(Readable.from([Buffer.from('other bytes')]), await this.key(args[0]));
          copyFileSync(store.path(other.sha256), store.path(kept.sha256));
        }
        if (kept.sha256 === sha(broken!.bytes)) {
          const sealed = readFileSync(store.path(kept.sha256));
          sealed[sealed.length - 1] ^= 1;
          writeFileSync(store.path(kept.sha256), sealed);
        }
        return kept;
      }
    }
    expect(await moveOldFiles({ db, config, files: new Spoiling(config) })).toEqual({ moved: 1, waiting: 0, finished: false });
    expect([await nameOf(db, swapped!.id), await nameOf(db, broken!.id), await nameOf(db, fine!.id), await withBytes(db)]).toEqual([null, null, sha(fine!.bytes), 3]);
    for (const file of [swapped!, broken!]) expect((await fileBytes({ db, config, files: new Files(config) }, file.id)).equals(file.bytes)).toBe(true);
  });

  it('moves no file from the disk that is not as long as its row says, and moves it once it is whole', async () => {
    const filesDir = folder();
    const big: Old = { id: randomUUID(), bytes: randomBytes(9000), disk: true };
    const { db } = await upgraded([big], filesDir);
    writeFileSync(join(filesDir, big.id), big.bytes.subarray(0, 4000));
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    const ctx = { db, config, files: new Files(config) };
    expect(await moveOldFiles(ctx)).toEqual({ moved: 0, waiting: 0, finished: true });
    expect([await nameOf(db, big.id), existsSync(join(filesDir, big.id))]).toEqual([null, true]);
    writeFileSync(join(filesDir, big.id), big.bytes);
    const whole = await moveOldFiles(ctx);
    expect(whole).toMatchObject({ moved: 1, waiting: 0, finished: true, ready: { files: 1, bytes: big.bytes.length } });
    expect([await nameOf(db, big.id), existsSync(join(filesDir, big.id))]).toEqual([sha(big.bytes), true]);
    await approveMove(db, whole.ready!.digest, 'person:ceo');
    expect(await moveOldFiles(ctx)).toEqual({ moved: 0, waiting: 0, cleared: 1, finished: true });
    expect(existsSync(join(filesDir, big.id))).toBe(false);
  });

  it('keeps what it stored for a second machine that is away for more than a day, and moves it once that machine has it', async () => {
    const filesDir = folder();
    const file: Old = { id: randomUUID(), bytes: randomBytes(6000) };
    const { db } = await upgraded([file], filesDir);
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    const ctx = { db, config, files: new Files(config) };
    const other = await holder(db);
    const start = Date.now();
    expect(await moveOldFiles(ctx)).toMatchObject({ moved: 0, waiting: 1 });
    /* The store's round and the mover's go on each minute while the other machine is away. */
    for (const at of [start, start + UNUSED_MS / 2, start + UNUSED_MS + 60_000, start + 2 * UNUSED_MS]) {
      await markUnused(db, new Date(at));
      await dropDue(ctx, new Date(at));
      expect(await moveOldFiles(ctx)).toMatchObject({ moved: 0, waiting: 1 });
    }
    expect(ctx.files.store().has(sha(file.bytes))).toBe(true);
    await other.keeps(sha(file.bytes));
    expect(await moveOldFiles(ctx)).toMatchObject({ moved: 1, waiting: 0, finished: false, ready: { files: 1 } });
    await approveAll(db);
    expect(await moveOldFiles(ctx)).toEqual({ moved: 0, waiting: 0, cleared: 1, finished: true, roomBack: { before: expect.any(Number), after: expect.any(Number) } });
    expect((await fileBytes(ctx, file.id)).equals(file.bytes)).toBe(true);
  });

  it('names no row by a content the store is letting go, though a second machine kept it', async () => {
    const filesDir = folder();
    const file: Old = { id: randomUUID(), bytes: randomBytes(2000) };
    const { db } = await upgraded([file], filesDir);
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    /* The store's round gives the content its time to go just as the second machine says it keeps it. */
    class Going extends Files {
      override async settled(on: FilesDb, sha256: string): Promise<boolean> {
        await on.execute(sql`UPDATE net.files SET drop_at = now() WHERE sha256 = ${sha256}`);
        return true;
      }
    }
    expect(await moveOldFiles({ db, config, files: new Going(config) })).toEqual({ moved: 0, waiting: 0, finished: false });
    expect([await withBytes(db), await nameOf(db, file.id)]).toEqual([1, null]);
  });

  it('keeps in the store a content a row came to name after the store gave it its time to go', async () => {
    const filesDir = folder();
    const { db } = await upgraded([], filesDir);
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    const ctx = { db, config, files: new Files(config) };
    const kept = await ctx.files.putBytes(db, Buffer.from('a content no row names yet'));
    const start = Date.now();
    await markUnused(db, new Date(start));
    expect(await markUnused(db, new Date(start + UNUSED_MS + 60_000))).toBe(1);
    /* A row names it now, as a moved file's row does, before the store's round removes it. */
    await db.execute(sql`INSERT INTO attachments (id, company_id, agent_id, media_type, size, sha256) VALUES (${randomUUID()}, ${COMPANY}, ${AGENT}, 'text/plain', ${kept.size}, ${kept.sha256})`);
    expect(await dropDue(ctx, new Date(start + UNUSED_MS + 120_000))).toBe(0);
    expect(ctx.files.store().has(kept.sha256)).toBe(true);
    expect(rowsOf<{ drop_at: string | null; unused_since: string | null }>(await db.execute(sql`SELECT drop_at, unused_since FROM net.files WHERE sha256 = ${kept.sha256}`))).toEqual([{ drop_at: null, unused_since: null }]);
  });
});

describe('the big files of 0.43 on the disk', () => {
  it('go once their rows are gone and they are 30 days old, and those still to move, the store and any other file stay', async () => {
    const filesDir = folder();
    const [goes, young, stays]: Old[] = [3000, 3500, 4000].map(size => ({ id: randomUUID(), bytes: randomBytes(size), disk: true }));
    const { client, db } = await upgraded([goes!, young!, stays!], filesDir);
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    const ctx = { db, config, files: new Files(config) };
    const kept = await ctx.files.putBytes(db, Buffer.from('a file of the store'));
    writeFileSync(join(filesDir, 'notes.txt'), 'no file of a row');
    const monthAgo = new Date(Date.now() - 31 * 86_400_000);
    for (const name of [goes!.id, stays!.id, 'notes.txt']) utimesSync(join(filesDir, name), monthAgo, monthAgo);
    /* Their tasks went, and their rows with them, before the mover came to them. */
    await db.execute(sql`DELETE FROM attachments WHERE id IN (${goes!.id}, ${young!.id})`);
    /* A database a restore set aside may be merged back, with the rows that name them: while it is there, all stay. */
    await client.exec('CREATE DATABASE hornhoof_before_20261124_090000');
    await dropOldFiles(ctx, new Date());
    expect(existsSync(join(filesDir, goes!.id))).toBe(true);
    await client.exec('DROP DATABASE hornhoof_before_20261124_090000');
    await dropOldFiles(ctx, new Date());
    expect([goes!.id, young!.id, stays!.id, 'notes.txt'].map(name => existsSync(join(filesDir, name)))).toEqual([false, true, true, true]);
    expect(ctx.files.store().has(kept.sha256)).toBe(true);
/* What a reconciliation lists: each row whose bytes the store keeps, ordered by id, as "<id> <sha256> <size>" and a newline;
   its digest is the sha256 of that text. */
const digestOf = (files: Old[]) =>
  sha(Buffer.from([...files].sort((a, b) => (a.id < b.id ? -1 : 1)).map(file => `${file.id} ${sha(file.bytes)} ${file.bytes.length}\n`).join('')));

describe('the bytes of the moved files', () => {
  it('stay in Postgres, with the column and the disk files, until the CEO says yes to the digest of their reconciliation, and then go', async () => {
    const filesDir = folder();
    const same = randomBytes(30_000);
    const here: Old[] = [
      { id: randomUUID(), bytes: randomBytes(200_000) },
      { id: randomUUID(), bytes: same },
      { id: randomUUID(), bytes: same },
      { id: randomUUID(), bytes: Buffer.alloc(0) },
      { id: randomUUID(), bytes: randomBytes(500_000), disk: true },
    ];
    /* A big file of 0.43 on the disk of another machine, which leads later. */
    const away: Old = { id: randomUUID(), bytes: randomBytes(4000), disk: true };
    const { db } = await upgraded([...here, away], filesDir);
    rmSync(join(filesDir, away.id));
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    const ctx = { db, config, files: new Files(config) };

    const first = await moveOldFiles(ctx);
    const ready = { digest: digestOf(here), files: 5, contents: 4, bytes: 760_000, notHere: 1, databaseBytes: expect.any(Number) };
    expect(first).toEqual({ moved: 5, waiting: 0, finished: false, ready });
    expect(first.ready!.databaseBytes).toBeGreaterThan(0);
    /* Every file is read from the store now, and nothing of the old ones went: not a byte, not the column, not the disk file. */
    for (const file of here) {
      expect(await nameOf(db, file.id)).toBe(sha(file.bytes));
      expect((await fileBytes(ctx, file.id)).equals(file.bytes)).toBe(true);
    }
    expect([await withBytes(db), await columnsOf(db), existsSync(join(filesDir, here[4]!.id))]).toEqual([6, ['bytes', 'sha256'], true]);
    /* Rounds go on with no yes: nothing more is made or cleared. */
    expect(await moveOldFiles(ctx)).toEqual({ moved: 0, waiting: 0, finished: false });
    expect(await fileMoves(db)).toEqual([{ ...ready, madeAt: expect.any(String), approvedAt: null, approvedBy: null, clearedAt: null, databaseBytesAfter: null, left: 5 }]);
    expect(await withBytes(db)).toBe(6);

    /* A yes counts only for the digest of a reconciliation there is, and once. */
    await expect(approveMove(db, 'f'.repeat(64), 'person:ceo')).rejects.toMatchObject({ status: 404 });
    expect(await withBytes(db)).toBe(6);
    await approveMove(db, ready.digest, 'orchestrator:for-the-ceo');
    await expect(approveMove(db, ready.digest, 'person:ceo')).rejects.toMatchObject({ status: 409 });

    const cleared = await moveOldFiles(ctx);
    expect(cleared).toEqual({ moved: 0, waiting: 0, cleared: 5, finished: true, roomBack: { before: expect.any(Number), after: expect.any(Number) } });
    expect(cleared.roomBack!.after).toBeLessThan(cleared.roomBack!.before);
    expect([await columnsOf(db), existsSync(join(filesDir, here[4]!.id))]).toEqual([['sha256'], false]);
    for (const file of here) expect((await fileBytes(ctx, file.id)).equals(file.bytes)).toBe(true);
    const [done] = await fileMoves(db);
    expect(done).toMatchObject({ approvedBy: 'orchestrator:for-the-ceo', approvedAt: expect.any(String), clearedAt: expect.any(String), left: 0 });
    expect(done!.databaseBytesAfter).toBe(cleared.roomBack!.after);

    /* The machine with the away file leads: its file is copied, and its disk file waits for a yes of its own. */
    writeFileSync(join(filesDir, away.id), away.bytes);
    const later = await moveOldFiles({ db, config, files: new Files(config) });
    expect(later).toEqual({ moved: 1, waiting: 0, finished: true, ready: { digest: digestOf([away]), files: 1, contents: 1, bytes: 4000, notHere: 0, databaseBytes: expect.any(Number) } });
    expect(await moveOldFiles(ctx)).toEqual({ moved: 0, waiting: 0, finished: true });
    expect(existsSync(join(filesDir, away.id))).toBe(true);
    await approveMove(db, later.ready!.digest, 'person:ceo');
    expect(await moveOldFiles(ctx)).toEqual({ moved: 0, waiting: 0, cleared: 1, finished: true });
    expect(existsSync(join(filesDir, away.id))).toBe(false);
    expect((await fileBytes(ctx, away.id)).equals(away.bytes)).toBe(true);
  });

  it('are cleared only while Postgres finds them the bytes stored, and a row whose bytes changed after its reconciliation moves again', async () => {
    const filesDir = folder();
    const [kept, changing]: Old[] = [{ id: randomUUID(), bytes: randomBytes(3000) }, { id: randomUUID(), bytes: randomBytes(3000) }];
    const { db } = await upgraded([kept!, changing!], filesDir);
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    const ctx = { db, config, files: new Files(config) };
    const { ready } = await moveOldFiles(ctx);
    expect(ready).toMatchObject({ digest: digestOf([kept!, changing!]), files: 2 });
    /* Something writes the old column after the reconciliation, as nothing of this build does. */
    const changed = Buffer.from('written after the reconciliation');
    await db.execute(sql`UPDATE attachments SET bytes = ${changed}, size = ${changed.length} WHERE id = ${changing!.id}`);
    await approveMove(db, ready!.digest, 'person:ceo');
    expect(await moveOldFiles(ctx)).toMatchObject({ cleared: 1, finished: false });
    expect([await withBytes(db), await nameOf(db, kept!.id), await nameOf(db, changing!.id)]).toEqual([1, sha(kept!.bytes), null]);
    expect((await fileBytes(ctx, changing!.id)).equals(changed)).toBe(true);
    /* It moves as it reads now, and its bytes wait for a yes to that. */
    const again = await moveOldFiles(ctx);
    expect(again).toMatchObject({ moved: 1, finished: false, ready: { digest: digestOf([{ ...changing!, bytes: changed }]), files: 1 } });
    expect(await withBytes(db)).toBe(1);
    await approveMove(db, again.ready!.digest, 'person:ceo');
    expect(await moveOldFiles(ctx)).toEqual({ moved: 0, waiting: 0, cleared: 1, finished: true, roomBack: { before: expect.any(Number), after: expect.any(Number) } });
    expect((await fileBytes(ctx, changing!.id)).equals(changed)).toBe(true);
  });
});

describe('the store key', () => {
  it('is never used once the transaction that made it was rolled back', async () => {
    const db = await createTestDb();
    const filesDir = folder();
    const config = { secret: Buffer.from(TEST_SECRET, 'base64'), filesDir } as Config;
    const files = new Files(config);
    await expect(
      db.transaction(async tx => {
        await files.putBytes(tx as unknown as FilesDb, Buffer.from('a file of a rolled back transaction'));
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    const kept = await files.putBytes(db, Buffer.from('the bytes'));
    /* Another app of the same database, as a copy that leads later, opens it with the key the database keeps. */
    expect((await new Files({ ...config }).bytes(db, kept.sha256)).toString()).toBe('the bytes');
  });
});
