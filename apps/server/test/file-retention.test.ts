import { randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { agents, attachments, companies, departments, jobs, subscriptions, tasks, turns } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { finishMove } from '../src/modules/files/mover.js';
import { dropDue, markUnused } from '../src/modules/files/sweep.js';
import { dropOldFiles } from '../src/modules/tasks/attachments.js';
import { ownDatabases, setUpCompany, testApp } from './helpers.js';

/* One test puts the old column back, which a shared database would carry into the next. */
ownDatabases();

/* What the store keeps and lets go of by itself, and what Postgres keeps of a file: only its name, size and hash. */

const DAY = 86_400_000;
const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;

async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [bruno] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning();
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: bruno!.id, kind: 'conversation', prompt: 'go', timeoutMs: 1000 }).returning();
  let number = 0;
  const task = async (over: Partial<typeof tasks.$inferInsert> = {}) =>
    (await db.insert(tasks).values({ companyId, number: ++number, title: `Task ${number}`, departmentId: dev!.id, executorAgentId: bruno!.id, ...over }).returning())[0]!;
  const turn = async (closedAt: Date | null) =>
    (await db.insert(turns).values({ companyId, departmentId: dev!.id, number: ++number, goal: 'g', status: closedAt ? 'closed' : 'open', openedAt: new Date(0), closedAt }).returning())[0]!;
  const file = async (taskId: string, name: string, bytes: Buffer) => {
    const kept = await app.ctx.files.putBytes(db, bytes);
    return (await db.insert(attachments).values({ companyId, jobId: job!.id, agentId: bruno!.id, taskId, name, mediaType: 'application/octet-stream', sha256: kept.sha256, size: kept.size }).returning())[0]!;
  };
  const ids = async () => (await db.select(idOnly(attachments)).from(attachments)).map(row => row.id).sort();
  return { app, db, task, turn, file, ids };
}

describe('the store lets go of files by itself', () => {
  it('removes exactly the files whose time came, and their bytes a day after no row names them', async () => {
    const c = await company();
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const [oldTurn, recentTurn] = [await c.turn(ago(31)), await c.turn(ago(29))];
    const shared = randomBytes(3000);
    const gone = {
      ofOldTurn: await c.file((await c.task({ turnId: oldTurn.id })).id, 'a.bin', randomBytes(1000)),
      sharedOfOldTurn: await c.file((await c.task({ turnId: oldTurn.id })).id, 'shared.bin', shared),
      outsideClosedLongAgo: await c.file((await c.task({ status: 'done', closedAt: ago(31) })).id, 'b.bin', randomBytes(1000)),
    };
    const open = await c.task();
    const kept = [
      await c.file((await c.task({ turnId: recentTurn.id })).id, 'shared.bin', shared),
      await c.file((await c.task({ status: 'done', closedAt: ago(29) })).id, 'c.bin', randomBytes(1000)),
      await c.file(open.id, 'd.bin', randomBytes(1000)),
      /* A run's log on an open task stays with its task. */
      await c.file(open.id, 'tests-55-1.log', randomBytes(100)),
    ];

    expect(await dropOldFiles(c.app.ctx, now)).toBe(3);
    expect(await c.ids()).toEqual(kept.map(row => row.id).sort());

    /* The bytes no row names wait a day; the content another row still names stays. */
    const store = c.app.ctx.files.store();
    const unnamed = [gone.ofOldTurn, gone.outsideClosedLongAgo].map(row => row.sha256!);
    expect(await markUnused(c.db, now)).toBe(0);
    expect(await markUnused(c.db, new Date(now.getTime() + DAY - 60_000))).toBe(0);
    expect(await markUnused(c.db, new Date(now.getTime() + DAY + 60_000))).toBe(unnamed.length);
    await dropDue(c.app.ctx, new Date(now.getTime() + DAY + 60_000));
    for (const sha256 of unnamed) expect(store.has(sha256)).toBe(false);
    for (const row of kept) expect(store.has(row.sha256!)).toBe(true);
    const left = rowsOf<{ sha256: string }>(await c.db.execute(sql`SELECT sha256 FROM net.files ORDER BY sha256`)).map(row => row.sha256);
    expect(left).toEqual([...new Set(kept.map(row => row.sha256!))].sort());
  });

  it('lets go of no file by the rules of this version while the database still holds bytes of earlier ones, only by those of 0.43', async () => {
    const c = await company();
    /* An installation of 0.43 in the middle of the move: the old column is there until the CEO's yes clears it. A database
       of its own has not seen the column gone, as the app's saw it when it started. */
    await c.db.execute(sql`ALTER TABLE attachments ADD COLUMN bytes bytea`);
    const ctx = { ...c.app.ctx, db: drizzle((c.db as unknown as { $client: PGlite }).$client, { schema }) as unknown as Db };
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const ofOldTurn = await c.file((await c.task({ turnId: (await c.turn(ago(31))).id })).id, 'a.bin', randomBytes(1000));
    const outside = await c.file((await c.task({ status: 'done', closedAt: ago(31) })).id, 'b.bin', randomBytes(1000));
    expect(await dropOldFiles(ctx, now)).toBe(1);
    expect(await c.ids()).not.toContain(ofOldTurn.id);
    expect(await c.ids()).toEqual([outside.id]);
    /* Once the column went, as it goes after the CEO's yes, the rules of this version take their files too. */
    expect(await finishMove(ctx)).toBe(true);
    expect(await dropOldFiles(ctx, now)).toBe(1);
    expect(await c.ids()).toEqual([]);
  });

  it('keeps a content a new upload names again before its day is over', async () => {
    const c = await company();
    const now = new Date();
    const bytes = randomBytes(2000);
    const first = await c.file((await c.task()).id, 'one.bin', bytes);
    await c.db.delete(attachments);
    expect(await markUnused(c.db, now)).toBe(0);
    await c.file((await c.task()).id, 'again.bin', bytes);
    expect(await markUnused(c.db, new Date(now.getTime() + 2 * DAY))).toBe(0);
    await dropDue(c.app.ctx, new Date(now.getTime() + 2 * DAY));
    expect((await c.app.ctx.files.bytes(c.db, first.sha256!)).equals(bytes)).toBe(true);
  });
});

describe('the store keeps what a refused merge still holds', () => {
  it('keeps the content of a file row a merge refused while nobody picked a side, and lets it go a day after', async () => {
    const c = await company();
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() + days * DAY);
    const store = c.app.ctx.files.store();
    const kept = await c.app.ctx.files.putBytes(c.db, randomBytes(2000));
    const [merge] = rowsOf<{ id: string }>(await c.db.execute(sql`INSERT INTO net.merges (source, label, status) VALUES ('machine:another', 'a copy', 'merged') RETURNING id`));
    const [conflict] = rowsOf<{ id: string }>(
      await c.db.execute(sql`INSERT INTO net.merge_conflicts (merge, tbl, key, op, kind, topic, here, there, why)
        VALUES (${merge!.id}, 'attachments', '{"id": "00000000-0000-4000-8000-0000000000aa"}', 'insert', 'refused', 'work', NULL, ${JSON.stringify({ sha256: kept.sha256 })}::jsonb, 'refused') RETURNING id`),
    );
    for (const day of [0, 2]) {
      await markUnused(c.db, at(day));
      await dropDue(c.app.ctx, at(day));
    }
    expect(store.has(kept.sha256)).toBe(true);
    /* A side picked, the row is gone with the conflict, and its content waits its day. */
    await c.db.execute(sql`UPDATE net.merge_conflicts SET picked = 'here' WHERE id = ${conflict!.id}`);
    await markUnused(c.db, at(2));
    await dropDue(c.app.ctx, at(2));
    expect(store.has(kept.sha256)).toBe(true);
    await markUnused(c.db, at(3.1));
    await dropDue(c.app.ctx, at(3.1));
    expect(store.has(kept.sha256)).toBe(false);
  });
});

describe('what Postgres keeps of a file', () => {
  it('holds no byte of any file, so the database and its backups do not grow with them', async () => {
    const c = await company();
    const sizeOf = async () => rowsOf<{ n: number }>(await c.db.execute(sql`SELECT coalesce(sum(pg_column_size(a.*)), 0)::int AS n FROM attachments a`))[0]!.n;
    const task = await c.task();
    for (let at = 0; at < 10; at++) await c.file(task.id, `small-${at}.bin`, randomBytes(100));
    const ten = await sizeOf();
    for (let at = 0; at < 10; at++) await c.file(task.id, `big-${at}.bin`, randomBytes(200_000));
    /* Ten files of 200 KB add about what ten of 100 bytes did: their rows, never their bytes. */
    expect(await sizeOf()).toBeLessThan(ten * 2 + 2000);
    expect(await sizeOf()).toBeLessThan(20_000);
    const columns = rowsOf<{ name: string }>(await c.db.execute(sql`SELECT table_schema || '.' || table_name || '.' || column_name AS name FROM information_schema.columns
      WHERE table_schema IN ('public', 'net') AND data_type = 'bytea'`));
    expect(columns).toEqual([]);
  });
});
