import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { MIGRATIONS } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { Files, type FilesDb } from '../src/modules/files/files.js';
import { moveOldFiles } from '../src/modules/files/mover.js';
import { fileBytes } from '../src/modules/tasks/attachments.js';
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
    }
    expect(changedOnce).toBe(true);

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
