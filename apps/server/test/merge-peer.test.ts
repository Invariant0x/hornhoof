import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agents, attachments, companies, departments, jobs, machines, people, subscriptions } from '../src/db/schema.js';
import { copyOrder } from '../src/modules/copies/slots.js';
import { LeaseHolder } from '../src/modules/keeper/lease-holder.js';
import { leaseStore } from '../src/modules/keeper/lease-store.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import * as apply from '../src/modules/merge/apply.js';
import { fastWay } from '../src/modules/merge/check.js';
import * as facts from '../src/modules/merge/facts.js';
import { Merger } from '../src/modules/merge/merger.js';
import * as snapshot from '../src/modules/merge/snapshot.js';
import { builtinOf } from '../src/modules/nodes/hub.js';
import { applyParkedMessages } from '../src/modules/nodes/messages.js';
import { park } from '../src/modules/nodes/parked.js';
import { MACHINE_SOURCE, type MergeSource } from '../src/modules/merge/source.js';
import { appOn, ownDatabases, setUpCompany } from './helpers.js';
import { openTestDb } from './helpers-db.js';
import { forkOf, pgliteSource, type Side } from './merge-fixture.js';

/* Each test forks its database, which a shared one would not survive. */
ownDatabases();

type MergeRow = { id: string; source: string; label: string; status: string; path: string | null; fork: string | null; tries: number; error: string | null; machine: string | null; merged_at: string | null; done_at: string | null };
const rowsOf = async <T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(query)) as unknown as { rows: T[] }).rows;
const NETWORK_ID = `99bb2233aabbccdd${'2'.repeat(48)}`;
const PORT = 45_678;
/* The machine id the old leader's own node ran under. */
const OLD_MACHINE = 'c1d2e3f4'.repeat(4);

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
  const [machine] = await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: 'copy-machine', hostname: 'dev-mac', role: 'data', networkId: NETWORK_ID, copyOld: 1, copyName: 'copy_99bb2233aabbccdd_2', copyState: 'ready' }).returning();
  const state: { old: Side | null; queries: string[]; around?: <T>(text: string, run: () => Promise<T>) => Promise<T> } = { old: null, queries: [] };
  /* The copy's old database as the role that only reads sees it, with every statement it was asked kept. */
  const peers = {
    open: async (port: number, label: string): Promise<MergeSource> => {
      expect(port).toBe(PORT);
      const source = await pgliteSource(state.old!.client, label);
      return {
        ...source,
        query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
          state.queries.push(text);
          const run = () => source.query<T>(text, params);
          return state.around ? state.around(text, run) : run();
        },
      };
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
    expect(merge).toMatchObject({ source: `machine:${s.machine.id}:1`, machine: s.machine.id, status: 'merged', fork: null, path: null, error: null, label: "dev-mac's copy from before it was made again" });
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

  it('takes a handed database as one that never wrote', async () => {
    const s = await stand();
    const old = await s.copied();
    /* It led once, and handed the server over in a planned switch: everything it wrote reached the new leader first. */
    await old.client.exec(`INSERT INTO net_local.state (term_number, term_machine, machine, cluster, handed_to, handed_lsn, handed_at) VALUES (9, 'copy', 'copy', 'cluster-of-the-copy', 'other', '0/3000000', now())`);
    expect(await fastWay(s.db, await pgliteSource(old.client, 'the copy')).finally(() => old.client.exec('ROLLBACK'))).toEqual({ way: 'fast', restoreAt: null });
    /* Leading again since, with no handover after it, it may hold what nobody else does. */
    await old.client.exec('UPDATE net_local.state SET handed_to = NULL, handed_lsn = NULL, handed_at = NULL');
    expect(await fastWay(s.db, await pgliteSource(old.client, 'the copy')).finally(() => old.client.exec('ROLLBACK'))).toEqual({ way: 'whole', restoreAt: null });
  });

  it('merges a led database under its own source', async () => {
    const s = await stand();
    await s.db.update(machines).set({ copyOld: 3, copyOldLed: 7 }).where(eq(machines.id, s.machine.id));
    /* What it held when the server was taken from it holds nothing of its own: only its ids would be read. */
    await s.copied();
    s.door(true);
    await s.look();
    const [merge, ...more] = await s.merges();
    expect(more).toEqual([]);
    expect(merge).toMatchObject({ source: `machine:${s.machine.id}:led-7`, label: "dev-mac's database from when it led", status: 'merged', machine: s.machine.id });
    /* It led, so it is compared the whole way. */
    expect(merge!.path).not.toBeNull();
    expect(await copyOrder(s.app.ctx, { ...s.machine, copyOld: 3, copyOldLed: 7 })).toMatchObject({ old: 'merged' });
    /* The machine dropped that database: its report names none. */
    await s.db.update(machines).set({ copyOld: null, copyOldLed: null }).where(eq(machines.id, s.machine.id));
    await s.look();
    expect((await s.merges())[0]).toMatchObject({ status: 'done', error: null });

    expect(MACHINE_SOURCE.test(`machine:${s.machine.id}:led-7`)).toBe(true);
    expect(MACHINE_SOURCE.test(`machine:${s.machine.id}:3`)).toBe(true);
    expect(MACHINE_SOURCE.test(`machine:${s.machine.id}:led-0`)).toBe(false);
  });

  it('keeps a parked job open, and closes it with what its node said', async () => {
    const s = await stand();
    await s.db.update(machines).set({ copyOld: 3, copyOldLed: 7 }).where(eq(machines.id, s.machine.id));
    const [sub] = await s.db.select().from(subscriptions);
    const [orchestrator] = await s.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const NODE = builtinOf(OLD_MACHINE);
    const ids = { told: randomUUID(), waited: randomUUID(), other: randomUUID(), claimed: randomUUID() };
    const job = (id: string, status: 'queued' | 'running') =>
      ({ id, companyId: s.acme.id, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation' as const, prompt: 'hi', timeoutMs: 900_000, status, startedAt: status === 'running' ? new Date() : null, builtinMachine: OLD_MACHINE });
    /* While it led alone, the old leader started two turns and queued one; of the queued one a node told it something
       while its row was away from it. */
    const old = await s.copied(async side => {
      await side.db.insert(jobs).values([job(ids.told, 'running'), job(ids.waited, 'queued'), job(ids.other, 'running'), job(ids.claimed, 'running')]);
      await side.client.exec(`INSERT INTO net.parked (job_id, node, kind, body) VALUES ('${ids.waited}', '${JSON.stringify(NODE)}', 'listed', '{}')`);
    });
    await old.client.exec(`INSERT INTO net_local.state (term_number, term_machine, machine, cluster) VALUES (7, 'copy', 'copy', 'cluster-of-the-copy')`);
    /* The new leader heard of the first from its node: that it runs, and then how it ended. */
    await park(s.db, { jobId: ids.told, node: NODE, kind: 'listed', body: {} });
    vi.spyOn(s.app.ctx.hub, 'send').mockReturnValue(true);
    await park(s.db, { jobId: ids.told, node: NODE, kind: 'done', body: { type: 'job.done', jobId: ids.told, ok: true, result: 'Done over there.', tail: '', error: null, sessionId: null } });
    /* Another node says it runs a turn the old leader sent to its own node: the old leader knew where it sent it. */
    await park(s.db, { jobId: ids.claimed, node: { kind: 'node', nodeId: randomUUID() }, kind: 'started', body: { type: 'job.started', jobId: ids.claimed } });
    s.door(true);
    await s.look();
    expect((await s.merges())[0]).toMatchObject({ source: `machine:${s.machine.id}:led-7`, status: 'merged' });
    const now = async (id: string) => (await s.db.select().from(jobs).where(eq(jobs.id, id)))[0];
    /* The one its node told the leader of came running on that node, and what the node said since closed it in the
       same look. */
    expect(await now(ids.told)).toMatchObject({ status: 'done', result: 'Done over there.', builtinMachine: OLD_MACHINE });
    expect(await now(ids.waited)).toMatchObject({ status: 'running', builtinMachine: OLD_MACHINE });
    expect((await now(ids.waited))!.startedAt).not.toBeNull();
    /* A turn nobody said anything of ended with the machine that ran it, and so did the one another node laid claim to. */
    expect(await now(ids.other)).toMatchObject({ status: 'failed' });
    expect(await now(ids.claimed)).toMatchObject({ status: 'failed', nodeId: null, builtinMachine: OLD_MACHINE });
    /* What the source kept of the queued one is here too. */
    const parked = await rowsOf<{ job_id: string; kind: string }>(s.db, sql`SELECT job_id::text AS job_id, kind FROM net.parked ORDER BY at, id`);
    expect(parked.map(row => [row.job_id, row.kind]).sort()).toEqual([[ids.claimed, 'started'], [ids.told, 'done'], [ids.told, 'listed'], [ids.waited, 'listed']].sort());
    expect(await applyParkedMessages(s.app.ctx)).toBe(0);
  });

  it('leaves a turn alone that both sides started, with nothing for anyone to settle', async () => {
    const s = await stand();
    await s.db.update(machines).set({ copyOld: 3, copyOldLed: 7 }).where(eq(machines.id, s.machine.id));
    const [sub] = await s.db.select().from(subscriptions);
    const [orchestrator] = await s.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    /* The turn waited in the queue on both sides when they parted. */
    const [turn] = await s.db.insert(jobs).values({ companyId: s.acme.id, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900_000, status: 'queued' }).returning();
    /* The old leader sent it out, and the new one took the node's word that it runs. */
    const old = await s.copied(side => side.db.update(jobs).set({ status: 'running', startedAt: new Date('2026-11-12T14:01:00.000Z'), builtinMachine: OLD_MACHINE }).where(eq(jobs.id, turn!.id)));
    await old.client.exec(`INSERT INTO net_local.state (term_number, term_machine, machine, cluster) VALUES (7, 'copy', 'copy', 'cluster-of-the-copy')`);
    await s.db.update(jobs).set({ status: 'running', startedAt: new Date('2026-11-12T14:03:00.000Z'), builtinMachine: OLD_MACHINE }).where(eq(jobs.id, turn!.id));
    s.door(true);
    await s.look();
    expect((await s.merges())[0]).toMatchObject({ status: 'merged' });
    expect((await s.db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]).toMatchObject({ status: 'running', startedAt: new Date('2026-11-12T14:03:00.000Z') });
    expect(await rowsOf<{ n: number }>(s.db, sql`SELECT count(*)::int AS n FROM net.merge_conflicts`)).toEqual([{ n: 0 }]);
  });

  describe('across a restore', () => {
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
    it('compares a copy when the kept database was brought back', async () => {
      const merged = await across(keptMerge('done', randomUUID(), true));
      expect(merged.merge.status).toBe('merged');
      expect(merged.merge.path).not.toBeNull();
      expect(merged.brought).toBe(true);
    });

    /* The CEO left the kept database out: the copy, which holds no more than that one did, is left out with it. */
    it.each(['removing', 'done'])('leaves a copy out with a kept database the CEO left out, its merge %s', async status => {
      const left = await across(keptMerge(status, randomUUID(), false));
      expect(left.merge).toMatchObject({ status: 'done', error: 'Left out with the database from before the restore of 10 Nov 08:00 UTC.', path: null });
      expect(left.merge.done_at).not.toBeNull();
      expect(left.brought).toBe(false);
    });

    /* A kept database that held no company, as after a total loss, was not the CEO's to leave out: the copy is compared. */
    it('compares a copy when the kept database held no company', async () => {
      const lost = await across(keptMerge('done', null, false));
      expect([lost.merge.status, lost.brought]).toEqual(['merged', true]);
    });

    it('compares a copy while the merge of the kept database still waits', async () => {
      const waiting = await across(keptMerge('removing', null, false));
      expect(waiting.brought).toBe(true);
    });
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

  it('is done once the machine dropped the old database', async () => {
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
  });

  it('ends unread when the machine left before its old copy was read', async () => {
    /* A machine that was disconnected before its old copy was read. */
    const left = await stand();
    await left.copied();
    left.door(false);
    await left.look();
    await left.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, left.machine.id));
    left.door(true);
    await left.look();
    expect((await left.merges())[0]).toMatchObject({ status: 'done', error: 'dev-mac left before its old copy was read.' });
    expect(left.state.queries).toEqual([]);
  });

  /* A machine whose owner lost the scope holds the data no more: no door leads to it, so its old copy is asked for
     no longer, and none is asked of a machine that left the data before the leader heard of an old copy. */
  it('asks no old copy of a machine that left the data', async () => {
    const gone = await stand();
    await gone.copied();
    gone.door(false);
    await gone.look();
    await gone.db.update(machines).set({ role: 'worker', uploadState: 'waiting', dataLeftAt: new Date() }).where(eq(machines.id, gone.machine.id));
    expect(await gone.merger.doors()).toEqual([]);
    await gone.look();
    expect((await gone.merges())[0]).toMatchObject({ status: 'done', error: 'dev-mac left before its old copy was read.' });
    const never = await stand();
    await never.db.update(machines).set({ role: 'worker', uploadState: 'waiting', dataLeftAt: new Date() }).where(eq(machines.id, never.machine.id));
    await never.look();
    expect(await never.merges()).toEqual([]);
  });

  it('merges a led database whose source answers each read after 2 s while renewing the lease and letting writes through', async () => {
    const s = await stand();
    await s.db.update(machines).set({ copyOld: 2, copyOldLed: 2 }).where(eq(machines.id, s.machine.id));
    let onlyThere!: { id: string };
    const old = await s.copied(async side => {
      [onlyThere] = await side.db.insert(departments).values({ companyId: s.acme.id, name: 'From old leader', roleCode: 'OLD' }).returning();
    });
    await old.client.exec(`INSERT INTO net_local.state (term_number, term_machine, machine, cluster) VALUES (2, 'copy', 'copy', 'cluster-of-the-copy')`);
    await s.db.insert(departments).values({ companyId: s.acme.id, name: 'Already on leader', roleCode: 'HERE' });

    const startWall = Date.parse('2026-11-14T01:31:00.000Z');
    let wall = startWall;
    let mono = 0;
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(wall);

    const store = leaseStore({ query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => s.opened.client.query<R>(text, params) }, { machineId: 'leader-a' });
    const holder = new LeaseHolder({ lease: store, updaterBusy: () => false, now: () => ({ wall, mono }), log: () => undefined });
    await holder.tick();
    const firstUntil = holder.standing()!.until;
    expect(firstUntil).toBe(startWall + 10_000);

    const outside = AsyncResource.bind(<T>(work: () => Promise<T>) => work());
    const txSpy = vi.spyOn(s.db, 'transaction');

    let reads = 0;
    let readsInTx = 0;
    let renewals = 0;
    let wroteWithoutWaiting = false;
    let companyWrite: Promise<{ id: string }> | null = null;
    s.state.around = async (_text, run) => {
      reads += 1;
      if (s.opened.client.isInTransaction()) readsInTx += 1;
      if (reads === 1) {
        let settled = false;
        companyWrite = outside(() =>
          s.db.insert(departments).values({ companyId: s.acme.id, name: 'Written during merge', roleCode: 'LIVE' }).returning(),
        ).then(rows => {
          settled = true;
          return rows[0]!;
        });
        for (let turn = 0; turn < 30 && !settled; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
        wroteWithoutWaiting = settled;
      }
      for (let second = 0; second < 2; second += 1) {
        wall += 1_000;
        mono += 1_000;
        vi.setSystemTime(wall);
        if (!s.opened.client.isInTransaction()) {
          await outside(() => holder.tick());
          renewals += 1;
        }
      }
      return run();
    };

    s.door(true);
    await s.look();
    const written = await companyWrite!.catch(() => null);

    expect(reads).toBeGreaterThan(5);
    expect(wall - startWall).toBe(reads * 2_000);
    const [merge] = await s.merges();
    expect({
      source: merge?.source,
      status: merge?.status,
      path: merge?.path,
      error: merge?.error,
      readsInTx,
      wroteWithoutWaiting,
      renewals,
      leaseValid: holder.standing() !== null && holder.standing()!.until > firstUntil,
      repeatableRead: txSpy.mock.calls.some(call => call[1]?.isolationLevel === 'repeatable read'),
      broughtOldLeaderRow: (await s.db.select().from(departments).where(eq(departments.id, onlyThere.id))).length,
      wroteConcurrentRow: written ? (await s.db.select().from(departments).where(eq(departments.id, written.id))).length : 0,
    }).toEqual({
      source: `machine:${s.machine.id}:led-2`,
      status: 'merged',
      path: 'journal',
      error: null,
      readsInTx: 0,
      wroteWithoutWaiting: true,
      renewals: reads * 2,
      leaseValid: true,
      repeatableRead: false,
      broughtOldLeaderRow: 1,
      wroteConcurrentRow: 1,
    });
  });
});

describe('a merge that needs more of the old database than it read ahead', () => {
  type Stand = Awaited<ReturnType<typeof stand>>;
  /* A database that led, so it is merged the whole way, with a department only it holds. */
  const led = async (s: Stand, first: (side: Side) => Promise<unknown> = async () => undefined) => {
    await s.db.update(machines).set({ copyOld: 3, copyOldLed: 7 }).where(eq(machines.id, s.machine.id));
    let only!: { id: string };
    const old = await s.copied(async side => {
      await first(side);
      [only] = await side.db.insert(departments).values({ companyId: s.acme.id, name: 'Only there', roleCode: 'THERE' }).returning();
    });
    await old.client.exec(`INSERT INTO net_local.state (term_number, term_machine, machine, cluster) VALUES (7, 'copy', 'copy', 'cluster-of-the-copy')`);
    return { old, brought: async () => (await s.db.select().from(departments).where(eq(departments.id, only.id))).length === 1 };
  };
  /* The merge, where the leader does meanwhile after each read of the old database ahead and before the merge takes its
     locks, with the read's number from 1: the merge as it ended, how many times it read ahead, and what it asked for more. */
  const merging = async (s: Stand, meanwhile: (read: number) => Promise<unknown>) => {
    const ahead = snapshot.prepareSource;
    let reads = 0;
    const reading = vi.spyOn(snapshot, 'prepareSource').mockImplementation(async (...args) => {
      const read = await ahead(...args);
      await meanwhile(++reads);
      return read;
    });
    const noted = vi.spyOn(snapshot, 'noteMoreNeeded');
    onTestFinished(() => {
      reading.mockRestore();
      noted.mockRestore();
    });
    s.door(true);
    await s.look();
    const [merge] = (await s.merges()) as (MergeRow & { cutoff: string | Date | null })[];
    return { merge: merge!, reads, asked: noted.mock.calls.map(([, , err]) => err.extra) };
  };
  const once = (work: () => Promise<unknown>) => async (read: number) => (read === 1 ? work() : undefined);
  /* What the leader keeps of a restore the old database knows nothing of: with it, the two are compared row by row. */
  const restoreHere = (s: Stand, attempt = randomUUID()) => s.db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at) VALUES (${attempt}::uuid, ${randomUUID()}::uuid, '2026-11-10T08:00:00.000Z')`);

  it('reads every row of it again when the leader went through a restore meanwhile, and merges by comparing', async () => {
    const s = await stand();
    const { brought } = await led(s);
    const { merge, reads, asked } = await merging(s, once(() => restoreHere(s)));
    expect({ status: merge.status, path: merge.path, error: merge.error, reads, asked }).toEqual({ status: 'merged', path: 'compare', error: null, reads: 2, asked: [{ compare: true }] });
    expect(await brought()).toBe(true);
  });

  it('reads its journal again when what made the leader compare is gone by the time the merge locks', async () => {
    const s = await stand();
    const { brought } = await led(s);
    const attempt = randomUUID();
    await restoreHere(s, attempt);
    const { merge, reads, asked } = await merging(s, once(() => s.db.execute(sql`DELETE FROM net.restores WHERE attempt = ${attempt}::uuid`)));
    expect({ status: merge.status, path: merge.path, error: merge.error, reads, asked }).toEqual({ status: 'merged', path: 'journal', error: null, reads: 2, asked: [{ journal: true }] });
    expect(await brought()).toBe(true);
  });

  it("reads its journal again from further back when the leader's horizon went back meanwhile", async () => {
    const s = await stand();
    const { old, brought } = await led(s);
    const [{ below }] = (await old.client.query<{ below: string | Date }>('SELECT below FROM net.horizon')).rows as [{ below: string | Date }];
    /* The leader pruned later than the old database did, and then holds its journal from where the old one does. */
    await s.db.execute(sql`UPDATE net.horizon SET below = below + interval '4 days'`);
    const { merge, reads, asked } = await merging(s, once(() => s.db.execute(sql`UPDATE net.horizon SET below = below - interval '4 days'`)));
    const dayBefore = new Date(new Date(below).getTime() - 86_400_000);
    expect({ status: merge.status, path: merge.path, error: merge.error, reads, asked, cutoff: new Date(merge.cutoff!).toISOString() })
      .toEqual({ status: 'merged', path: 'journal', error: null, reads: 2, asked: [{ cutoff: dayBefore }], cutoff: dayBefore.toISOString() });
    expect(await brought()).toBe(true);
  });

  it("reads the bytes of a file again when the leader's own one went meanwhile, and writes it whole", async () => {
    const s = await stand();
    const [orchestrator] = await s.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    /* Both hold the file alike, so its bytes are not read ahead. */
    const [file] = await s.db.insert(attachments).values({ companyId: s.acme.id, agentId: orchestrator!.id, mediaType: 'text/plain', bytes: new TextEncoder().encode('the file'), size: 8 }).returning();
    const { brought } = await led(s);
    await restoreHere(s);
    const { merge, reads, asked } = await merging(s, once(() => s.db.delete(attachments).where(eq(attachments.id, file!.id))));
    expect({ status: merge.status, path: merge.path, error: merge.error, reads, asked })
      .toEqual({ status: 'merged', path: 'compare', error: null, reads: 2, asked: [{ files: [{ table: 'attachments', key: { id: file!.id } }] }] });
    const [back] = await s.db.select().from(attachments).where(eq(attachments.id, file!.id));
    expect(new TextDecoder().decode(back!.bytes)).toBe('the file');
    expect(await brought()).toBe(true);
  });

  it('stops after reading it three times more, with nothing written, while the leader goes on changing under it', async () => {
    const s = await stand();
    const { brought } = await led(s);
    await s.db.execute(sql`UPDATE net.horizon SET below = below + interval '5 days'`);
    const departmentsBefore = (await s.db.select().from(departments)).length;
    /* Every time, its horizon is a day further back by the time the merge locks. */
    const { merge, reads, asked } = await merging(s, () => s.db.execute(sql`UPDATE net.horizon SET below = below - interval '1 day'`));
    expect({ status: merge.status, path: merge.path, error: merge.error, tries: merge.tries, reads, asked: asked.length })
      .toEqual({ status: 'pending', path: null, error: 'The merge stopped: More rows are needed from the merge source.', tries: 1, reads: 4, asked: 3 });
    expect(await brought()).toBe(false);
    expect((await s.db.select().from(departments)).length).toBe(departmentsBefore);
    expect(await rowsOf<{ n: number }>(s.db, sql`SELECT ((SELECT count(*) FROM net.merge_consumed) + (SELECT count(*) FROM net.merge_rows) + (SELECT count(*) FROM net.merge_conflicts))::int AS n`)).toEqual([{ n: 0 }]);
  });
});
