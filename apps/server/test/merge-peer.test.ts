import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { companies, departments, machines, people } from '../src/db/schema.js';
import { copyOrder } from '../src/modules/copies/slots.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import * as apply from '../src/modules/merge/apply.js';
import { fastWay } from '../src/modules/merge/check.js';
import * as facts from '../src/modules/merge/facts.js';
import { Merger } from '../src/modules/merge/merger.js';
import type { MergeSource } from '../src/modules/merge/source.js';
import { appOn, ownDatabases, setUpCompany } from './helpers.js';
import { openTestDb } from './helpers-db.js';
import { forkOf, pgliteSource, type Side } from './merge-fixture.js';

/* Each test forks its database, which a shared one would not survive. */
ownDatabases();

type MergeRow = { id: string; source: string; label: string; status: string; path: string | null; fork: string | null; tries: number; error: string | null; machine: string | null; merged_at: string | null; done_at: string | null };
const rowsOf = async <T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(query)) as unknown as { rows: T[] }).rows;
const NETWORK_ID = `99bb2233aabbccdd${'2'.repeat(48)}`;
const PORT = 45_678;

/* An app that leads on a company, with a machine that keeps a copy and says an old attempt's database waits on it. The
   old database is a fork of the app's own as it is when the test asks for it. */
async function stand() {
  const opened = await openTestDb();
  onTestFinished(() => opened.client.close());
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const { app, db } = await appOn(opened.client, { HORNHOOF_CONTROL_DIR: control });
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [machine] = await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: 'copy-machine', hostname: 'ivan-mac', role: 'data', networkId: NETWORK_ID, copyOld: 1, copyName: 'copy_99bb2233aabbccdd_2', copyState: 'ready' }).returning();
  const state: { old: Side | null; queries: string[] } = { old: null, queries: [] };
  /* The copy's old database as the role that only reads sees it, with every statement it was asked kept. */
  const peers = {
    open: async (port: number, label: string): Promise<MergeSource> => {
      expect(port).toBe(PORT);
      const source = await pgliteSource(state.old!.client, label);
      return { ...source, query: (text, params) => (state.queries.push(text), source.query(text, params)) };
    },
  };
  const merger = new Merger(app.ctx, { list: async () => [], open: async () => Promise.reject(new Error('no kept database here')), drop: async () => undefined }, { peers });
  /* A copy of the leader as it is now. It never led: it holds no term and no lease of its own. first: what the test
     writes into it before that, as rows that reached it and the leader then lost. */
  const copied = async (first: (side: Side) => Promise<unknown> = async () => undefined): Promise<Side> => {
    const side = await forkOf(opened.client);
    await first(side);
    await side.client.exec('DELETE FROM net_local.lease; DELETE FROM net_local.state');
    state.old = side;
    return side;
  };
  const door = (open: boolean) => writeKeeperState(control, { mode: 'lead', at: new Date().toISOString(), link: null, doors: open ? { [NETWORK_ID]: PORT } : {} });
  const merges = () => rowsOf<MergeRow>(db, sql`SELECT * FROM net.merges ORDER BY created_at, source`);
  const look = async () => {
    await merger.discover();
    await merger.tick();
  };
  return { app, db, acme: acme!, machine: machine!, control, state, merger, copied, door, merges, look, opened };
}

describe("the old database of a copy on another machine", () => {
  it('merges a copy that never wrote by its ids', async () => {
    const s = await stand();
    await s.copied();
    s.door(true);
    const ran = vi.spyOn(apply, 'runMerge');
    const shaped = vi.spyOn(facts, 'sameShape');
    await s.look();
    const [merge] = await s.merges();
    expect(merge).toMatchObject({ source: `machine:${s.machine.id}:1`, machine: s.machine.id, status: 'merged', fork: null, path: null, error: null, label: "ivan-mac's copy from before it was made again" });
    expect(merge!.merged_at).not.toBeNull();
    expect(ran).not.toHaveBeenCalled();
    expect(shaped).not.toHaveBeenCalled();
    /* Only what tells whether it wrote and what it knows of was read, by column: no table of the company's. */
    const read = [...new Set(s.state.queries.flatMap(text => [...text.matchAll(/(?:FROM|JOIN)\s+((?:net|net_local|public|pg_catalog)\.\w+)/g)].map(found => found[1]!)))].sort();
    expect(read).toEqual(['net.backups', 'net.journal', 'net.merge_conflicts', 'net.restores', 'net_local.state', 'pg_catalog.pg_class'].sort());
    for (const text of s.state.queries) expect(text).not.toMatch(/public\./);
    expect(await copyOrder(s.app.ctx, s.machine)).toMatchObject({ old: 'merged' });
  });

  it('merges a copy of an older schema the same way', async () => {
    const s = await stand();
    const old = await s.copied();
    await old.client.exec('ALTER TABLE tasks DROP COLUMN title');
    s.door(true);
    await s.look();
    expect((await s.merges())[0]).toMatchObject({ status: 'merged', error: null });
  });

  it('does not bring back what the leader deleted', async () => {
    const s = await stand();
    const [gone] = await s.db.insert(departments).values({ companyId: s.acme.id, name: 'Gone', roleCode: 'GONE' }).returning();
    await s.copied();
    /* The leader deleted it after the copy stopped following. */
    await s.db.delete(departments).where(eq(departments.id, gone!.id));
    s.door(true);
    await s.look();
    expect((await s.merges())[0]).toMatchObject({ status: 'merged' });
    expect(await s.db.select().from(departments).where(eq(departments.id, gone!.id))).toEqual([]);
    expect((await s.state.old!.db.select().from(departments).where(eq(departments.id, gone!.id)))).toHaveLength(1);
  });

  it('reads every row of a copy that wrote', async () => {
    const s = await stand();
    const old = await s.copied();
    /* It once held a term, and wrote something of its own under it. */
    await old.client.exec(`INSERT INTO net_local.state (term_number, term_machine, machine, cluster) VALUES (9, 'copy', 'copy', 'cluster-of-the-copy');
      INSERT INTO net_local.lease (term_number, term_machine, kind, until, sync) VALUES (9, 'copy', 'normal', 'infinity', 'alone')`);
    const [mine] = await old.db.insert(departments).values({ companyId: s.acme.id, name: 'Only there', roleCode: 'THERE' }).returning();
    expect(await fastWay(s.db, await pgliteSource(old.client, 'the copy')).finally(() => old.client.exec('ROLLBACK'))).toEqual({ way: 'whole', restoreAt: null });
    s.door(true);
    await s.look();
    const [merge] = await s.merges();
    expect(merge).toMatchObject({ status: 'merged' });
    expect(merge!.path).not.toBeNull();
    expect(await s.db.select().from(departments).where(eq(departments.id, mine!.id))).toHaveLength(1);
  });

  it('compares across a restore', async () => {
    /* The leader went through a restore the copy knows nothing of, and the copy holds a department only it has. */
    const across = async (kept: (s: Awaited<ReturnType<typeof stand>>, attempt: string) => Promise<void>) => {
      const s = await stand();
      let only: { id: string } | undefined;
      /* The row came to the copy with its journal row, and the leader then lost both to the restore. */
      await s.copied(async side => void ([only] = await side.db.insert(departments).values({ companyId: s.acme.id, name: 'Only there', roleCode: 'THERE' }).returning()));
      const attempt = randomUUID();
      await s.db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, kept) VALUES (${attempt}, ${randomUUID()}, '2026-11-10T08:00:00.000Z', 'hornhoof_before_t1')`);
      await kept(s, attempt);
      s.door(true);
      await s.look();
      const merge = (await s.merges()).find(row => row.source.startsWith('machine:'))!;
      const brought = (await s.db.select().from(departments).where(eq(departments.id, only!.id))).length === 1;
      return { merge, brought };
    };
    const keptMerge = (status: string, fork: string | null, merged: boolean) => (s: Awaited<ReturnType<typeof stand>>) =>
      s.db.execute(sql`INSERT INTO net.merges (source, label, status, fork, merged_at, done_at) VALUES ('kept:hornhoof_before_t1', 'the database from before the restore', ${status}, ${fork}::uuid, ${merged ? sql`now()` : sql`NULL`}, ${status === 'done' ? sql`now()` : sql`NULL`})`).then(() => undefined);

    /* The kept database was brought back: the copy is compared row by row, and what only it held comes too. */
    const merged = await across(keptMerge('done', randomUUID(), true));
    expect(merged.merge.status).toBe('merged');
    expect(merged.merge.path).not.toBeNull();
    expect(merged.brought).toBe(true);
    /* The CEO left the kept database out: the copy, which holds no more than that one did, is left out with it. */
    for (const status of ['removing', 'done']) {
      const left = await across(keptMerge(status, randomUUID(), false));
      expect(left.merge).toMatchObject({ status: 'done', error: 'Left out with the database from before the restore of 10 Nov 08:00 UTC.', path: null });
      expect(left.merge.done_at).not.toBeNull();
      expect(left.brought).toBe(false);
    }
    /* A kept database that held no company, as after a total loss, was not the CEO's to leave out: the copy is compared. */
    const lost = await across(keptMerge('done', null, false));
    expect([lost.merge.status, lost.brought]).toEqual(['merged', true]);
    /* A kept database whose merge still waits: the copy is compared too. */
    const waiting = await across(keptMerge('removing', null, false));
    expect(waiting.brought).toBe(true);
  });

  it('waits for its door', async () => {
    const s = await stand();
    await s.copied();
    s.door(false);
    await s.look();
    await s.look();
    expect((await s.merges())[0]).toMatchObject({ status: 'pending', tries: 0, error: null });
    expect(await s.merger.doors()).toEqual([NETWORK_ID]);
    expect(await s.app.ctx.doorsWanted()).toEqual([NETWORK_ID]);
    expect(await copyOrder(s.app.ctx, s.machine)).toMatchObject({ old: 'waiting' });
    /* It holds no update of the leader up meanwhile. */
    expect(await s.merger.pending()).toBe(false);
    s.door(true);
    await s.look();
    expect((await s.merges())[0]).toMatchObject({ status: 'merged', tries: 1 });
    expect(await s.merger.doors()).toEqual([]);
  });

  it('is done once the machine dropped the old database, and ends unread when the machine left', async () => {
    const s = await stand();
    await s.copied();
    s.door(true);
    await s.look();
    expect((await s.merges())[0]).toMatchObject({ status: 'merged' });
    /* The copy changed places with its new one and names no old attempt any more. */
    await s.db.update(machines).set({ copyOld: null }).where(eq(machines.id, s.machine.id));
    await s.look();
    const [done] = await s.merges();
    expect(done).toMatchObject({ status: 'done', error: null });
    expect(done!.done_at).not.toBeNull();
    expect(await copyOrder(s.app.ctx, { ...s.machine, copyOld: null })).toMatchObject({ old: null });

    /* A machine that was disconnected before its old copy was read. */
    const left = await stand();
    await left.copied();
    left.door(false);
    await left.look();
    await left.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, left.machine.id));
    left.door(true);
    await left.look();
    expect((await left.merges())[0]).toMatchObject({ status: 'done', error: 'ivan-mac left before its old copy was read.' });
    expect(left.state.queries).toEqual([]);

    /* A machine whose owner lost the scope holds the data no more: no door leads to it, so its old copy is asked for
       no longer, and none is asked of a machine that left the data before the leader heard of an old copy. */
    const gone = await stand();
    await gone.copied();
    gone.door(false);
    await gone.look();
    await gone.db.update(machines).set({ role: 'worker', uploadState: 'waiting', dataLeftAt: new Date() }).where(eq(machines.id, gone.machine.id));
    expect(await gone.merger.doors()).toEqual([]);
    await gone.look();
    expect((await gone.merges())[0]).toMatchObject({ status: 'done', error: 'ivan-mac left before its old copy was read.' });
    const never = await stand();
    await never.db.update(machines).set({ role: 'worker', uploadState: 'waiting', dataLeftAt: new Date() }).where(eq(machines.id, never.machine.id));
    await never.look();
    expect(await never.merges()).toEqual([]);
  });
});
