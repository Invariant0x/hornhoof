import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { companies, departments } from '../src/db/schema.js';
import * as apply from '../src/modules/merge/apply.js';
import { CHOICE_FILE, type KeptDatabases } from '../src/modules/merge/kept.js';
import { MERGE_EVERY_MS, Merger, RETRY_MAX_MS } from '../src/modules/merge/merger.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { appOn, ownDatabases, setUpCompany } from './helpers.js';
import { openTestDb } from './helpers-db.js';
import { forkOf, pgliteSource, type Side } from './merge-fixture.js';

/* Each test forks its database, which a shared one would not survive. */
ownDatabases();

type MergeRow = { id: string; source: string; label: string; status: string; path: string | null; fork: string | null; tries: number; tried_at: string | null; error: string | null; counts: { added?: number } };

const rowsOf = async <T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(query)) as unknown as { rows: T[] }).rows;

/* An app that leads on a company, a control folder, and kept databases that are forks of the app's own. */
async function stand(env: NodeJS.ProcessEnv = {}) {
  const opened = await openTestDb();
  onTestFinished(() => opened.client.close());
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const { app, db } = await appOn(opened.client, { HORNHOOF_CONTROL_DIR: control, ...env });
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const databases = new Map<string, Side>();
  const dropped: string[] = [];
  let failing = 0;
  let now = Date.now();
  const kept: KeptDatabases = {
    list: async () => [...databases.keys()],
    open: async (name, label) => {
      if (failing > 0) {
        failing -= 1;
        throw new Error('could not connect');
      }
      return pgliteSource(databases.get(name)!.client, label);
    },
    drop: async name => {
      dropped.push(name);
      databases.delete(name);
    },
  };
  const merger = new Merger(app.ctx, kept, { now: () => new Date(now) });
  /* A database a restore set aside, as it is now; what the test then writes into it is what came after. */
  const keep = async (name: string): Promise<Side> => {
    const side = await forkOf(opened.client);
    databases.set(name, side);
    return side;
  };
  const merges = () => rowsOf<MergeRow>(db, sql`SELECT * FROM net.merges ORDER BY created_at, source`);
  const restored = async (name: string, at = '2026-11-10T08:00:00.000Z') => {
    const attempt = randomUUID();
    await db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, kept) VALUES (${attempt}, ${randomUUID()}, ${at}, ${name})`);
    return attempt;
  };
  const backup = (id: string) =>
    db.execute(sql`INSERT INTO net.backups (id, company_id, dumped_at, made_at, reason, size, sha256, signer, serial, recipients, migrations, head)
      VALUES (${id}, ${acme!.id}, now(), now(), 'fork', 10, ${'a'.repeat(64)}, ${randomUUID()}, 'ab', '{}', 107, '{}')`);
  return { app, db, acme: acme!, control, databases, dropped, merger, keep, merges, restored, backup, later: (ms: number) => void (now += ms), fail: (times: number) => void (failing = times), opened };
}

describe('the databases a restore set aside', () => {
  it('brings back the database from before a restore', async () => {
    const s = await stand();
    await s.restored('hornhoof_before_t1');
    const kept = await s.keep('hornhoof_before_t1');
    const [later] = await kept.db.insert(departments).values({ companyId: s.acme.id, name: 'Later', roleCode: 'LATER' }).returning();
    await s.merger.discover();
    const [found] = await s.merges();
    expect(found).toMatchObject({ source: 'kept:hornhoof_before_t1', status: 'pending', label: 'the database from before the restore of 10 Nov 08:00 UTC', tries: 0 });
    expect(found!.fork).toMatch(/^[0-9a-f-]{36}$/);
    expect(await s.merger.pending()).toBe(true);
    const heard: string[] = [];
    s.app.ctx.bus.subscribe(s.acme.id, message => heard.push(message.type));
    await s.merger.tick();
    const [merged] = await s.merges();
    expect(merged).toMatchObject({ status: 'merged', path: 'compare', error: null, tries: 1 });
    expect(merged!.counts.added).toBe(1);
    expect(await s.db.select().from(departments).where(eq(departments.id, later!.id))).toHaveLength(1);
    /* The screens are told once to read again. */
    expect(heard).toEqual(['org']);
    expect(await s.merger.pending()).toBe(false);
    /* Discovered once. */
    await s.merger.discover();
    expect(await s.merges()).toHaveLength(1);
  });

  it('leaves it out when the CEO chose so', async () => {
    const s = await stand();
    const attempt = await s.restored('hornhoof_before_t1');
    await s.keep('hornhoof_before_t1');
    writeFileSync(join(s.control, CHOICE_FILE), JSON.stringify({ attempt, bringBack: false }));
    const run = vi.spyOn(apply, 'runMerge');
    await s.merger.discover();
    expect(await s.merges()).toMatchObject([{ status: 'removing' }]);
    expect(existsSync(join(s.control, CHOICE_FILE))).toBe(false);
    await s.merger.tick();
    expect(run).not.toHaveBeenCalled();
    /* Kept until its backup is made. */
    expect([s.dropped, (await s.merges())[0]!.status]).toEqual([[], 'removing']);
    run.mockRestore();
  });

  it('keeps the choice until it is written', async () => {
    const s = await stand();
    const attempt = await s.restored('hornhoof_before_t1');
    await s.keep('hornhoof_before_t1');
    const file = join(s.control, CHOICE_FILE);
    writeFileSync(file, JSON.stringify({ attempt, bringBack: false }));
    s.fail(1);
    await s.merger.discover();
    expect([existsSync(file), await s.merges()]).toEqual([true, []]);
    await s.merger.discover();
    expect([existsSync(file), (await s.merges()).map(row => row.status)]).toEqual([false, ['removing']]);
    /* A file of another attempt stays for the next restore to write over. */
    await s.restored('hornhoof_before_t2');
    await s.keep('hornhoof_before_t2');
    writeFileSync(file, JSON.stringify({ attempt: randomUUID(), bringBack: false }));
    await s.merger.discover();
    expect([existsSync(file), (await s.merges()).map(row => row.status)]).toEqual([true, ['removing', 'pending']]);
  });

  it('waits for a restore that still runs', async () => {
    const s = await stand();
    await s.keep('hornhoof_before_t1');
    const attempt = randomUUID();
    const backup = randomUUID();
    const status = (state: string, kept: string | null) => writeFileSync(join(s.control, 'restore-status.json'), JSON.stringify({ attempt, id: backup, state, step: 'start', line: '', at: new Date().toISOString(), kept, dumpedAt: '2026-11-10T08:00:00.000Z' }));
    /* The updater has not said yet which database it kept: nothing is told of one before it has. */
    status('running', null);
    await s.merger.discover();
    expect(await s.merges()).toEqual([]);
    status('done', 'hornhoof_before_t1');
    await s.merger.discover();
    expect(await s.merges()).toMatchObject([{ source: 'kept:hornhoof_before_t1', label: 'the database from before the restore of 10 Nov 08:00 UTC', status: 'pending' }]);
    expect(await rowsOf(s.db, sql`SELECT attempt, backup, kept FROM net.restores`)).toEqual([{ attempt, backup, kept: 'hornhoof_before_t1' }]);
  });

  it('names a database kept before this release', async () => {
    const s = await stand();
    await s.keep('hornhoof_before_t9');
    await s.merger.discover();
    expect(await s.merges()).toMatchObject([{ label: 'the database kept as hornhoof_before_t9', status: 'pending' }]);
  });

  it('removes an empty database without a backup', async () => {
    const s = await stand();
    const empty = await s.keep('hornhoof_before_t1');
    await empty.client.exec('SET session_replication_role = replica; DELETE FROM companies; SET session_replication_role = DEFAULT');
    await s.merger.discover();
    expect(await s.merges()).toMatchObject([{ status: 'removing', fork: null }]);
    await s.merger.tick();
    expect([s.dropped, (await s.merges())[0]!.status]).toEqual([['hornhoof_before_t1'], 'done']);
  });

  it('drops only what is merged and saved', async () => {
    const s = await stand();
    await s.keep('hornhoof_before_t1');
    await s.merger.discover();
    await s.merger.tick();
    const [merged] = await s.merges();
    expect([merged!.status, s.dropped]).toEqual(['merged', []]);
    await s.merger.tick();
    expect(s.dropped).toEqual([]);
    /* Once its bundle is recorded it goes, once. */
    await s.backup(merged!.fork!);
    await s.merger.tick();
    await s.merger.tick();
    expect([s.dropped, (await s.merges())[0]!.status]).toEqual([['hornhoof_before_t1'], 'done']);
    /* One that waits or was only applied never goes, and nothing that is no kept database is ever touched. */
    await s.keep('hornhoof_before_t2');
    await s.merger.discover();
    const waiting = (await s.merges()).find(row => row.source === 'kept:hornhoof_before_t2')!;
    await s.backup(waiting.fork!);
    for (const status of ['pending', 'applied']) {
      await s.db.execute(sql`UPDATE net.merges SET status = ${status}, tried_at = now(), tries = 20 WHERE id = ${waiting.id}`);
      await s.merger.tick();
      expect(s.dropped).toEqual(['hornhoof_before_t1']);
    }
    s.databases.set('hornhoof', s.opened as unknown as Side);
    await s.merger.discover();
    await s.merger.tick();
    expect([(await s.merges()).map(row => row.source), s.dropped]).toEqual([['kept:hornhoof_before_t1', 'kept:hornhoof_before_t2'], ['hornhoof_before_t1']]);
  });

  it('goes on with the check after a stop', async () => {
    const s = await stand();
    const kept = await s.keep('hornhoof_before_t1');
    await kept.db.insert(departments).values({ companyId: s.acme.id, name: 'Later', roleCode: 'LATER' });
    await s.merger.discover();
    const [row] = await s.merges();
    /* The app stopped between the merge and its check. */
    const source = await pgliteSource(kept.client, row!.label);
    await apply.runMerge(s.db, { id: row!.id, label: row!.label, kept: true, companyId: s.acme.id }, source, { log: () => undefined });
    await source.close();
    expect((await s.merges())[0]!.status).toBe('applied');
    const run = vi.spyOn(apply, 'runMerge');
    await s.merger.tick();
    expect(run).not.toHaveBeenCalled();
    expect((await s.merges())[0]).toMatchObject({ status: 'merged', error: null });
    run.mockRestore();
  });

  it('tries a failed merge again, less often', async () => {
    const s = await stand();
    const kept = await s.keep('hornhoof_before_t1');
    await s.merger.discover();
    await kept.client.exec(`SET session_replication_role = replica; UPDATE companies SET id = '${randomUUID()}'; SET session_replication_role = DEFAULT`);
    await s.merger.tick();
    expect((await s.merges())[0]).toMatchObject({ status: 'pending', error: 'This database is of another company.', tries: 1 });
    /* Not again within a minute; then again, and each time after twice as long, an hour at most. */
    s.later(MERGE_EVERY_MS - 1000);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(1);
    s.later(2000);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(2);
    s.later(MERGE_EVERY_MS + 1000);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(2);
    s.later(MERGE_EVERY_MS);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(3);
    await s.db.execute(sql`UPDATE net.merges SET tries = 30`);
    s.later(RETRY_MAX_MS - 1000);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(30);
    s.later(2000);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(31);
  });

  it('says what is not complete yet, and stays applied', async () => {
    const s = await stand();
    const kept = await s.keep('hornhoof_before_t1');
    const [later] = await kept.db.insert(departments).values({ companyId: s.acme.id, name: 'Later', roleCode: 'LATER' }).returning();
    await s.merger.discover();
    const run = vi.spyOn(apply, 'runMerge').mockImplementation(async (db, merge) => {
      /* A merge that applied and left a row behind. */
      await (db as Db).execute(sql`UPDATE net.merges SET status = 'applied', path = 'compare', applied_at = now() WHERE id = ${merge.id}`);
      return { path: 'compare', counts: {} as apply.Counts, tasks: [], code: [], from: null, to: null, heldMs: 0 };
    });
    await s.merger.tick();
    run.mockRestore();
    const [row] = await s.merges();
    expect(row).toMatchObject({ status: 'applied', tries: 1 });
    expect(row!.error).toBe(`Not complete yet: departments ${JSON.stringify({ id: later!.id })}`);
    expect(s.dropped).toEqual([]);
  });

  it('merges one at a time, only while leading', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
    writeKeeperState(control, { mode: 'lead', at: new Date().toISOString(), link: null });
    const s = await stand({ HORNHOOF_CONTROL_DIR: control, HORNHOOF_KEEPER: 'on' });
    for (const name of ['hornhoof_before_t1', 'hornhoof_before_t2']) await s.keep(name);
    await s.merger.discover();
    await s.merger.tick();
    expect((await s.merges()).map(row => row.status).sort()).toEqual(['merged', 'pending']);
    /* Two ticks at once are one. */
    await Promise.all([s.merger.tick(), s.merger.tick()]);
    expect((await s.merges()).map(row => row.status)).toEqual(['merged', 'merged']);
    await s.keep('hornhoof_before_t3');
    writeKeeperState(control, { mode: 'read', at: new Date().toISOString(), link: null });
    await vi.waitFor(() => expect(s.app.ctx.mode.current()).toBe('read'));
    await s.merger.tick();
    expect(await s.merges()).toHaveLength(2);
  });

  it('writes the choice for the swap to find', async () => {
    const s = await stand();
    const file = join(s.control, CHOICE_FILE);
    expect(existsSync(file)).toBe(false);
    const { writeChoice } = await import('../src/modules/merge/kept.js');
    writeChoice(s.control, { attempt: 'a1', bringBack: false });
    expect([JSON.parse(readFileSync(file, 'utf8')), statSync(file).mode & 0o777]).toEqual([{ attempt: 'a1', bringBack: false }, 0o600]);
  });
});
