import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import {
  agentChanges, agentEventArchives, agentEvents, agents, attachments, companies, computerRuns, departments, jobs, machineAccess, machines, mapReturns, nodes, notebookNotes, people, personAccess, programInstances,
  programOperatorCases, sessions, subscriptions, taskEvents, tasks, teams, testParts, testRuns, turns, worldLayouts,
} from '../src/db/schema.js';
import { idOnly, only } from '../src/db/selections.js';
import { nodeSource, withSource } from '../src/db/sources.js';
import { MergeRefused, runMerge, type MergeFiles, type MergeResult } from '../src/modules/merge/apply.js';
import { complete } from '../src/modules/merge/check.js';
import { pick } from '../src/modules/merge/picks.js';
import { ownDatabases } from './helpers.js';
import { asPlan7, twoSides, type Side } from './merge-fixture.js';
import { looseFiles, sha256Of, stored } from './files-fixture.js';

/* Each test forks its database, which a shared one would not survive. */
ownDatabases();

type Fork = Side & { source: () => Promise<import('../src/modules/merge/source.js').MergeSource> };
type Conflict = { id: string; merge: string; carried: string | null; tbl: string; key: Record<string, unknown>; op: string; kind: string; topic: string; task_id: string | null; cols: string[]; here: Record<string, unknown> | null; there: Record<string, unknown> | null; why: string };
type Kept = { merge: string; tbl: string; key: Record<string, unknown>; how: string; cols: string[]; was: Record<string, unknown> | null; here: Record<string, unknown> | null };

const rowsOf = async <T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(query)) as unknown as { rows: T[] }).rows;

/* A company on the leader, by plain inserts so that nothing but the test writes: its owner, a plan, the orchestrator, a
   department with a head and two workers, an open turn and two tasks in it. */
async function stand() {
  const sides = await twoSides();
  const { db } = sides.leader;
  const [acme] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const on = { companyId: acme!.id };
  const [owner] = await db.insert(people).values({ ...on, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const [plan] = await db.insert(subscriptions).values({ ...on, provider: 'claude', kind: 'personal', label: 'Plan', ownerPersonId: owner!.id, status: 'ready' }).returning();
  const staff = { ...on, subscriptionId: plan!.id, model: '' };
  const [orchestrator] = await db.insert(agents).values({ ...staff, kind: 'orchestrator', name: 'Olga' }).returning();
  const [dev] = await db.insert(departments).values({ ...on, name: 'Development', roleCode: 'DEV' }).returning();
  const [head] = await db.insert(agents).values({ ...staff, kind: 'head', name: 'Hana', departmentId: dev!.id }).returning();
  const [ana] = await db.insert(agents).values({ ...staff, kind: 'worker', name: 'Ana', departmentId: dev!.id }).returning();
  const [ben] = await db.insert(agents).values({ ...staff, kind: 'worker', name: 'Ben', departmentId: dev!.id }).returning();
  const [turn] = await db.insert(turns).values({ ...on, departmentId: dev!.id, number: 1, goal: 'Ship', status: 'open' }).returning();
  const task = async (side: Db, number: number, title: string, over: Partial<typeof tasks.$inferInsert> = {}) =>
    (await side.insert(tasks).values({ ...on, number, title, departmentId: dev!.id, turnId: turn!.id, createdByPersonId: owner!.id, ...over }).returning())[0]!;
  const [one, two] = [await task(db, 1, 'One'), await task(db, 2, 'Two')];
  let made = 0;
  /* A merge of this fork into the leader, as the merger would run it. */
  const merge = async (fork: Fork, over: { kept?: boolean; label?: string; onUnit?: (n: number) => void | Promise<void>; log?: (line: string) => void; clock?: () => number; files?: MergeFiles } = {}): Promise<{ id: string; result: MergeResult }> => {
    made += 1;
    const kept = over.kept ?? false;
    const label = over.label ?? 'the fork';
    const [row] = await rowsOf<{ id: string }>(db, sql`INSERT INTO net.merges (source, label) VALUES (${kept ? `kept:hornhoof_before_t${made}` : `machine:${made}`}, ${label}) RETURNING id`);
    const source = await fork.source();
    try {
      return { id: row!.id, result: await runMerge(db, { id: row!.id, label, kept, companyId: acme!.id }, source, { onUnit: over.onUnit, log: over.log ?? (() => undefined), clock: over.clock, files: over.files }) };
    } finally {
      await source.close();
    }
  };
  const checked = async (fork: Fork, id: string) => {
    const source = await fork.source();
    try {
      return await complete(db, id, source);
    } finally {
      await source.close();
    }
  };
  const conflicts = (id?: string) => rowsOf<Conflict>(db, id ? sql`SELECT * FROM net.merge_conflicts WHERE merge = ${id} ORDER BY tbl, created_at, id` : sql`SELECT * FROM net.merge_conflicts ORDER BY tbl, created_at, id`);
  const kept = (id: string) => rowsOf<Kept>(db, sql`SELECT * FROM net.merge_rows WHERE merge = ${id} ORDER BY tbl, how`);
  const consumed = (id: string) => rowsOf<{ journal: string; how: string }>(db, sql`SELECT journal, how FROM net.merge_consumed WHERE merge = ${id}`);
  const mergeRow = async (id: string) => (await rowsOf<{ status: string; path: string | null; xact: string | null; tasks: string[]; counts: Record<string, unknown>; task_wanted: boolean; from_at: Date | null; to_at: Date | null; applied_at: Date | null }>(db, sql`SELECT * FROM net.merges WHERE id = ${id}`))[0]!;
  const titleOf = async (side: Db, id: string) => (await side.select(only(tasks, 'title')).from(tasks).where(eq(tasks.id, id)))[0]?.title ?? null;
  return { sides, db, acme: acme!, on, owner: owner!, plan: plan!, staff, orchestrator: orchestrator!, dev: dev!, head: head!, ana: ana!, ben: ben!, turn: turn!, one, two, task, merge, checked, conflicts, kept, consumed, mergeRow, titleOf };
}

describe('a merge applied', () => {
  it('adds what the leader lacks', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    const [sales] = await fork.db.insert(departments).values({ ...s.on, name: 'Sales', roleCode: 'SALES' }).returning();
    const added = await s.task(fork.db, 3, 'Three', { departmentId: sales!.id });
    /* Events here meanwhile, so the numbers the fork gave its own are taken. */
    await s.db.insert(taskEvents).values([{ ...s.on, taskId: s.one.id, kind: 'created' }, { ...s.on, taskId: s.one.id, kind: 'comment', text: 'here' }]);
    await s.db.insert(agentEvents).values({ ...s.on, agentId: s.ana.id, kind: 'text', data: {} });
    const events = await fork.db.insert(taskEvents).values([{ ...s.on, taskId: added.id, kind: 'created' }, { ...s.on, taskId: added.id, kind: 'comment', text: 'there' }]).returning();
    const [said] = await fork.db.insert(agentEvents).values({ ...s.on, agentId: s.ana.id, kind: 'text', data: { text: 'there' } }).returning();
    const [change] = await fork.db.insert(agentChanges).values({ ...s.on, agentId: s.ana.id, field: 'name', before: 'Ana', after: 'Anna' }).returning();
    const { id, result } = await s.merge(fork);
    expect(result.path).toBe('journal');
    expect(result.counts).toMatchObject({ added: 6, changed: 0, deleted: 0, conflicts: 0, skipped: 0 });
    expect(result.counts.byTable.task_events).toEqual({ added: 2, changed: 0, deleted: 0, conflicts: 0 });
    expect((await s.db.select().from(departments).where(eq(departments.id, sales!.id)))[0]).toMatchObject({ name: 'Sales' });
    expect((await s.db.select().from(tasks).where(eq(tasks.id, added.id)))[0]).toMatchObject({ number: 3, title: 'Three', departmentId: sales!.id });
    /* A log's rows come with a number of this side's own. */
    const here = await s.db.select().from(taskEvents).where(eq(taskEvents.taskId, added.id)).orderBy(taskEvents.id);
    expect(here.map(event => event.uuid)).toEqual(events.map(event => event.uuid));
    expect(here.map(event => event.id)).toEqual([3, 4]);
    expect(events.map(event => event.id)).toEqual([1, 2]);
    const [heard] = await s.db.select().from(agentEvents).where(eq(agentEvents.id, said!.id));
    expect([heard!.data, Number(heard!.seq) > Number(said!.seq)]).toEqual([{ text: 'there' }, true]);
    expect(await s.db.select().from(agentChanges).where(eq(agentChanges.id, change!.id))).toHaveLength(1);
    expect(await s.conflicts(id)).toEqual([]);
    const row = await s.mergeRow(id);
    expect(row).toMatchObject({ status: 'applied', path: 'journal', task_wanted: true, tasks: [added.id] });
    expect([row.xact, row.applied_at, row.from_at, row.to_at].every(Boolean)).toBe(true);
    expect((await s.consumed(id)).every(entry => entry.how === 'applied')).toBe(true);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  /* A log's added rows come in the order the source numbered them, by either way. Each way stands its own company, so
     no test of this file builds three. */
  it.each([false, true])('adds a log in the order the source numbered it, kept %s', async kept => {
    const again = await stand();
    const other = await again.sides.fork();
    const told = await other.db.insert(agentEvents).values(['a', 'b', 'c', 'd', 'e'].map(text => ({ ...again.on, agentId: again.ana.id, kind: 'text' as const, data: { text } }))).returning();
    await again.merge(other, { kept });
    const order = await again.db.select().from(agentEvents).orderBy(agentEvents.seq);
    expect(order.map(event => event.id)).toEqual([...told].sort((a, b) => Number(a.seq) - Number(b.seq)).map(event => event.id));
  });

  /* #2126: an event the leader moved into its archive of an agent's old history is not one it lacks. */
  it.each([false, true])('adds no event the leader archived, kept %s', async kept => {
    const s = await stand();
    const ended = new Date(Date.now() - 30 * 86_400_000);
    const [done] = await s.db.insert(jobs).values({ ...s.on, subscriptionId: s.plan.id, agentId: s.ana.id, prompt: 'Work', timeoutMs: 60_000, status: 'done', createdAt: ended, finishedAt: ended }).returning();
    const told = await s.db.insert(agentEvents).values(['a', 'b', 'c'].map(text => ({ ...s.on, agentId: s.ana.id, jobId: done!.id, kind: 'text' as const, data: { text }, createdAt: ended }))).returning();
    const fork = await s.sides.fork();
    /* The leader's archive round: the archive's row names the events, and they leave the table. */
    await s.db.insert(agentEventArchives).values({
      ...s.on, agentId: s.ana.id, sha256: 'a'.repeat(64), firstSeq: told[0]!.seq, lastSeq: told[2]!.seq, events: 3, jobIds: [done!.id], eventIds: told.map(e => e.id),
      firstAt: ended, lastAt: ended, clearedAt: new Date(),
    });
    await s.db.delete(agentEvents).where(inArray(agentEvents.id, told.map(e => e.id)));
    const { id } = await s.merge(fork, { kept });
    expect(await s.db.select(idOnly(agentEvents)).from(agentEvents).where(inArray(agentEvents.id, told.map(e => e.id)))).toEqual([]);
    expect(await s.conflicts(id)).toEqual([]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('applies a proven overwrite', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    await fork.db.update(tasks).set({ title: 'There', version: 5 }).where(eq(tasks.id, s.one.id));
    const { id, result } = await s.merge(fork);
    expect(result.counts).toMatchObject({ added: 0, changed: 1, conflicts: 0 });
    const [now] = await s.db.select().from(tasks).where(eq(tasks.id, s.one.id));
    expect([now!.title, now!.version]).toEqual(['There', 6]);
    expect(await s.conflicts(id)).toEqual([]);
    expect(await s.consumed(id)).toMatchObject([{ how: 'applied' }]);
    expect((await s.mergeRow(id)).tasks).toEqual([s.one.id]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it("keeps the leader's value on an unproven difference", async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    await fork.db.update(tasks).set({ title: 'There', body: 'Only there' }).where(eq(tasks.id, s.one.id));
    await s.db.update(tasks).set({ title: 'Here' }).where(eq(tasks.id, s.one.id));
    const { id, result } = await s.merge(fork);
    /* One row takes what is proven and lists what is not. */
    expect(result.counts).toMatchObject({ changed: 1, conflicts: 1 });
    expect((await s.db.select().from(tasks).where(eq(tasks.id, s.one.id)))[0]).toMatchObject({ title: 'Here', body: 'Only there' });
    const [conflict] = await s.conflicts(id);
    expect(conflict).toMatchObject({ tbl: 'tasks', key: { id: s.one.id }, op: 'update', kind: 'differs', topic: 'work', task_id: s.one.id, cols: ['title'], carried: null });
    expect([conflict!.here!.title, conflict!.there!.title]).toEqual(['Here', 'There']);
    expect(conflict!.why).toBe('task #1 "Here": title: here "Here", there "There"');
    expect(await s.consumed(id)).toMatchObject([{ how: 'conflict' }]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it("brings over a company's city the leader lacks, and keeps the leader's own city on a difference", async () => {
    const s = await stand();
    const city = () => s.db.select({ packId: worldLayouts.packId, seed: worldLayouts.seed, layout: worldLayouts.layout, relocations: worldLayouts.relocations }).from(worldLayouts);
    const fork = await s.sides.fork();
    /* The CEO's order to move Ana's house, given on the copy while it led. */
    const relocation = {
      id: 'r1', buildingId: 'house-ana', buildingKind: 'house' as const, buildingLabel: 'Ana', fromCol: 2, fromRow: 3, toCol: 4, toRow: 7,
      taskId: s.one.id, taskNumber: 1, assigneeAgentId: s.ana.id, departmentId: s.dev.id, createdAt: '2026-11-23T10:00:00.000Z',
    };
    await fork.db.insert(worldLayouts).values({ companyId: s.acme.id, packId: 'space', seed: 'seed-1', layout: { buildings: 3 }, relocations: [relocation] });
    const first = await s.merge(fork);
    expect(first.result.counts.byTable.world_layouts).toEqual({ added: 1, changed: 0, deleted: 0, conflicts: 0 });
    expect(await city()).toEqual([{ packId: 'space', seed: 'seed-1', layout: { buildings: 3 }, relocations: [relocation] }]);
    expect(await s.checked(fork, first.id)).toEqual({ ok: true, missing: [] });
    /* Both went on building, each its own way: the leader keeps its city and the orchestrator hears of the other. */
    const second = await s.sides.fork();
    await second.db.update(worldLayouts).set({ layout: { buildings: 4 }, updatedAt: new Date('2026-11-23T11:00:00Z') }).where(eq(worldLayouts.companyId, s.acme.id));
    await s.db.update(worldLayouts).set({ layout: { buildings: 5 }, updatedAt: new Date('2026-11-23T12:00:00Z') }).where(eq(worldLayouts.companyId, s.acme.id));
    const { id } = await s.merge(second);
    expect((await city())[0]!.layout).toEqual({ buildings: 5 });
    expect(await s.conflicts(id)).toMatchObject([{ tbl: 'world_layouts', key: { company_id: s.acme.id }, op: 'update', kind: 'differs', topic: 'work', cols: ['layout'] }]);
  });

  it("keeps each company's city its own through a merge, and a conflict over one city names that city alone", async () => {
    const s = await stand();
    await s.db.insert(worldLayouts).values({ companyId: s.acme.id, packId: 'space', seed: 'acme', layout: { buildings: 1 } });
    const fork = await s.sides.fork();
    /* Another company on the leader, as only a test makes one: a deployment serves one company, and a source holds the
       one it merges alone (#1967). */
    const [other] = await s.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const theirs = { buildings: 9, marker: 'the-other-city' };
    await s.db.insert(worldLayouts).values({ companyId: other!.id, packId: 'space', seed: 'other', layout: theirs });
    /* Both sides build on Acme's city, each its own way; only the leader moves the other company's city on. */
    await fork.db.update(worldLayouts).set({ layout: { buildings: 2 } }).where(eq(worldLayouts.companyId, s.acme.id));
    await s.db.update(worldLayouts).set({ layout: { buildings: 3 } }).where(eq(worldLayouts.companyId, s.acme.id));
    await s.db.update(worldLayouts).set({ layout: { ...theirs, buildings: 10 } }).where(eq(worldLayouts.companyId, other!.id));
    const { id } = await s.merge(fork);
    expect(await s.db.select({ companyId: worldLayouts.companyId, seed: worldLayouts.seed, layout: worldLayouts.layout }).from(worldLayouts).orderBy(worldLayouts.seed)).toEqual([
      { companyId: s.acme.id, seed: 'acme', layout: { buildings: 3 } },
      { companyId: other!.id, seed: 'other', layout: { ...theirs, buildings: 10 } },
    ]);
    const conflicts = await s.conflicts(id);
    expect(conflicts).toMatchObject([{ tbl: 'world_layouts', key: { company_id: s.acme.id }, kind: 'differs', topic: 'work', cols: ['layout'] }]);
    /* What the orchestrator is shown of it holds Acme's city and nothing of the other company's. */
    expect([conflicts[0]!.here?.layout, conflicts[0]!.there?.layout]).toEqual([{ buildings: 3 }, { buildings: 2 }]);
    expect(JSON.stringify(conflicts)).not.toContain(theirs.marker);
    expect(JSON.stringify(conflicts)).not.toContain(other!.id);
  });

  it('refuses a source that holds more than one company, whole, by its journal and by comparing, with nothing written', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    /* The copy holds a second company beside the one merged, after it: no deployment makes one. */
    await fork.db.insert(companies).values({ name: 'Other', singleton: false });
    await fork.db.update(tasks).set({ title: 'From a copy of two companies' }).where(eq(tasks.id, s.one.id));
    for (const kept of [false, true]) await expect(s.merge(fork, { kept })).rejects.toThrow(new MergeRefused('This database is of another company.'));
    expect(await s.titleOf(s.db, s.one.id)).toBe('One');
    expect(await s.db.select(only(companies, 'name')).from(companies)).toEqual([{ name: 'Acme' }]);
    expect(await s.conflicts()).toEqual([]);
  });

  it("refuses a source that brings a row of another company, or would write over one of the leader's other companies", async () => {
    const s = await stand();
    await s.db.insert(worldLayouts).values({ companyId: s.acme.id, packId: 'space', seed: 'acme', layout: { buildings: 1 } });
    const fork = await s.sides.fork();
    /* Another company the leader holds, which the copy never had: as only a test makes one. */
    const [other] = await s.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const marker = 'a-city-of-the-other-company';
    /* The copy says it holds Acme alone, and carries a city of the other company all the same, as a crafted database
       could: its keys are not checked while the row goes in. */
    await fork.client.exec('SET session_replication_role = replica');
    await fork.db.insert(worldLayouts).values({ companyId: other!.id, packId: 'space', seed: 'other', layout: { marker } });
    await fork.client.exec('RESET session_replication_role');
    await expect(s.merge(fork, { kept: true })).rejects.toThrow(new MergeRefused('This database is of another company.'));
    expect(await s.db.select(only(worldLayouts, 'companyId')).from(worldLayouts)).toEqual([{ companyId: s.acme.id }]);
    expect(await s.conflicts()).toEqual([]);

    /* A row of Acme there whose key names a row of the other company here: the leader's row is not written over. */
    const second = await s.sides.fork();
    await second.db.update(tasks).set({ title: 'Written over' }).where(eq(tasks.id, s.two.id));
    await s.db.execute(sql`SET session_replication_role = replica`);
    await s.db.update(tasks).set({ companyId: other!.id, title: marker }).where(eq(tasks.id, s.two.id));
    await s.db.execute(sql`RESET session_replication_role`);
    await expect(s.merge(second)).rejects.toThrow(new MergeRefused('This database is of another company.'));
    expect(await s.titleOf(s.db, s.two.id)).toBe(marker);
    expect(await s.conflicts()).toEqual([]);
  });

  it('never writes a city the app would not save, from a copy or by a pick, and lists it for the orchestrator', async () => {
    const s = await stand();
    const valid = { buildings: 3 };
    await s.db.insert(worldLayouts).values({ companyId: s.acme.id, packId: 'space', seed: 'acme', layout: valid });
    const city = async () => (await s.db.select({ packId: worldLayouts.packId, seed: worldLayouts.seed, layout: worldLayouts.layout }).from(worldLayouts))[0];
    /* Each copy changes the city in one way PUT /api/world/layout refuses: a layout that is no object, no pack, a seed
       over its length, and an order to move a building with no task. */
    const broken = [
      sql`UPDATE world_layouts SET layout = '"not a city"'::jsonb`,
      sql`UPDATE world_layouts SET pack_id = '  '`,
      sql`UPDATE world_layouts SET seed = ${'s'.repeat(121)}`,
      sql`UPDATE world_layouts SET relocations = '[{"id":"r1","buildingId":"house-ana"}]'::jsonb`,
    ];
    for (const change of broken) {
      const fork = await s.sides.fork();
      await fork.db.execute(change);
      const { id, result } = await s.merge(fork);
      expect(await city()).toEqual({ packId: 'space', seed: 'acme', layout: valid });
      expect(result.counts.byTable.world_layouts).toEqual({ added: 0, changed: 0, deleted: 0, conflicts: 1 });
      const [conflict] = await s.conflicts(id);
      expect(conflict).toMatchObject({ tbl: 'world_layouts', key: { company_id: s.acme.id }, op: 'update', kind: 'refused', topic: 'work' });
      expect(conflict!.why).toContain('Its city is not one the app saves');
      /* Taking the copy's side writes nothing either. */
      const ctx = { db: s.db, bus: { publish: () => undefined }, applyParked: async () => undefined, log: { warn: () => undefined } } as unknown as Ctx;
      const picked = await pick(ctx, { kind: 'orchestrator', agentId: s.orchestrator.id }, { ids: [conflict!.id] }, 'there');
      expect(picked).toMatchObject({ settled: 0, refused: [{ id: conflict!.id, why: expect.stringContaining('Its city is not one the app saves') }] });
      expect(await city()).toEqual({ packId: 'space', seed: 'acme', layout: valid });
      await s.db.execute(sql`UPDATE net.merge_conflicts SET picked = 'here', picked_at = now() WHERE id = ${conflict!.id}`);
    }
    /* Nor is a city the leader lacks brought over when it is not one the app saves. */
    await s.db.delete(worldLayouts);
    const fork = await s.sides.fork();
    await fork.db.insert(worldLayouts).values({ companyId: s.acme.id, packId: 'space', seed: 'acme', layout: valid });
    await fork.db.execute(sql`UPDATE world_layouts SET layout = '[1, 2, 3]'::jsonb`);
    const { id } = await s.merge(fork);
    expect(await city()).toBeUndefined();
    expect(await s.conflicts(id)).toMatchObject([{ tbl: 'world_layouts', op: 'insert', kind: 'refused' }]);
  });

  it('keeps a value the leader changed where its journal lost it', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    await s.db.update(tasks).set({ title: 'Here' }).where(eq(tasks.id, s.one.id));
    /* As a prune that took that row alone. */
    await s.db.execute(sql`DELETE FROM net.journal WHERE tbl = 'tasks' AND op = 'update' AND key = ${JSON.stringify({ id: s.one.id })}::jsonb`);
    await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, s.one.id));
    const { id } = await s.merge(fork);
    expect(await s.titleOf(s.db, s.one.id)).toBe('Here');
    expect(await s.conflicts(id)).toMatchObject([{ tbl: 'tasks', kind: 'differs', cols: ['title'] }]);
  });

  it('deletes only what the source alone removed', async () => {
    const s = await stand();
    const [lonely] = await s.db.insert(teams).values({ ...s.on, departmentId: s.dev.id, name: 'Lonely' }).returning();
    const [support] = await s.db.insert(departments).values({ ...s.on, name: 'Support', roleCode: 'SUP' }).returning();
    const fork = await s.sides.fork();
    await fork.db.delete(teams).where(eq(teams.id, lonely!.id));
    await fork.db.delete(departments).where(eq(departments.id, support!.id));
    const [note] = await s.db.insert(notebookNotes).values({ ...s.on, number: 1, text: 'Keep', departmentId: support!.id }).returning();
    const { id, result } = await s.merge(fork);
    expect(result.counts).toMatchObject({ deleted: 1, conflicts: 1 });
    expect(await s.db.select().from(teams).where(eq(teams.id, lonely!.id))).toEqual([]);
    /* Nothing of the merge deletes through a cascade. */
    expect(await s.db.select().from(departments).where(eq(departments.id, support!.id))).toHaveLength(1);
    expect(await s.db.select().from(notebookNotes).where(eq(notebookNotes.id, note!.id))).toHaveLength(1);
    expect(await s.conflicts(id)).toMatchObject([{ tbl: 'departments', key: { id: support!.id }, op: 'delete', kind: 'still_used', there: null }]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('never deletes through a skipped transaction', async () => {
    const s = await stand();
    const extra = await s.task(s.db, 3, 'Three', { turnId: null });
    const fork = await s.sides.fork();
    await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, extra.id));
    await withSource(nodeSource('n1', 'jobs', 7), () => fork.db.delete(tasks).where(eq(tasks.id, extra.id)));
    /* The leader has its own result of that input. */
    await withSource(nodeSource('n1', 'jobs', 7), () => s.db.update(tasks).set({ body: 'Seen here' }).where(eq(tasks.id, s.two.id)));
    const { id, result } = await s.merge(fork);
    expect(result.counts.deleted).toBe(0);
    expect(await s.titleOf(s.db, extra.id)).toBe('Three');
    const [conflict] = await s.conflicts(id);
    expect(conflict).toMatchObject({ tbl: 'tasks', key: { id: extra.id }, op: 'delete', kind: 'removed_changed' });
    expect(conflict!.there!.title).toBe('There');
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('skips what the leader already did from the same source', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    const said = (side: Db) => withSource(nodeSource('n1', 'jobs', 7), async () => (await side.insert(agentEvents).values({ ...s.on, agentId: s.ana.id, kind: 'text', data: {} }).returning())[0]!);
    const [there, here] = [await said(fork.db), await said(s.db)];
    const { id, result } = await s.merge(fork);
    expect(result.counts).toMatchObject({ added: 0, skipped: 2 });
    expect((await s.db.select(idOnly(agentEvents)).from(agentEvents)).map(row => row.id)).toEqual([here.id]);
    expect((await s.consumed(id)).map(entry => entry.how)).toEqual(['skipped', 'skipped']);
    expect(await s.kept(id)).toMatchObject([{ tbl: 'agent_events', key: { id: there.id }, how: 'skipped' }]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('closes the second open turn', async () => {
    const s = await stand();
    await s.db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.id, s.turn.id));
    const fork = await s.sides.fork();
    /* Each side opens its own turn with a task of that turn, which point at each other. */
    const open = async (side: Db, number: number) => {
      const [turn] = await side.insert(turns).values({ ...s.on, departmentId: s.dev.id, number: 2, goal: `Goal ${number}`, status: 'open' }).returning();
      const task = await s.task(side, number, `Of turn ${number}`, { turnId: turn!.id });
      await side.update(turns).set({ taskId: task.id }).where(eq(turns.id, turn!.id));
      return { turn: turn!, task };
    };
    const [there, here] = [await open(fork.db, 3), await open(s.db, 4)];
    const { id, result } = await s.merge(fork);
    expect(result.counts).toMatchObject({ added: 2, conflicts: 0 });
    const [turn] = await s.db.select().from(turns).where(eq(turns.id, there.turn.id));
    expect(turn).toMatchObject({ status: 'closed', number: 3, taskId: there.task.id });
    expect(turn!.closedAt).toBeInstanceOf(Date);
    /* Its task that is not done goes on in the turn that is open here. */
    expect((await s.db.select().from(tasks).where(eq(tasks.id, there.task.id)))[0]).toMatchObject({ turnId: here.turn.id, number: 3 });
    expect((await s.db.select().from(turns).where(eq(turns.status, 'open'))).map(found => found.id)).toEqual([here.turn.id]);
    const written = await s.kept(id);
    expect(written.map(row => [row.tbl, row.how, [...row.cols].sort()])).toEqual([['tasks', 'rewritten', ['turn_id']], ['turns', 'rewritten', ['closed_at', 'number', 'status']]]);
    expect(written.find(row => row.tbl === 'turns')!.was).toMatchObject({ status: 'open', number: 2, closed_at: null });
    expect(result.counts.rewritten).toBe(2);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('adds an open turn of another department open, beside the one that is open here', async () => {
    const s = await stand();
    const [sales] = await s.db.insert(departments).values({ ...s.on, name: 'Sales', roleCode: 'SAL' }).returning();
    const fork = await s.sides.fork();
    /* Each department runs turns of its own: Development's is open here, and Sales opened one there. */
    const [there] = await fork.db.insert(turns).values({ ...s.on, departmentId: sales!.id, number: 2, goal: 'Sell', status: 'open' }).returning();
    const task = await s.task(fork.db, 3, 'A sale', { departmentId: sales!.id, turnId: there!.id });
    const { id, result } = await s.merge(fork);
    expect(result.counts).toMatchObject({ added: 2, conflicts: 0 });
    expect((await s.db.select().from(turns).where(eq(turns.id, there!.id)))[0]).toMatchObject({ status: 'open', departmentId: sales!.id, closedAt: null });
    expect((await s.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ turnId: there!.id });
    expect((await s.db.select().from(turns).where(eq(turns.status, 'open'))).map(found => found.id).sort()).toEqual([s.turn.id, there!.id].sort());
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('renumbers a split number', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    const [there, here] = [await s.task(fork.db, 3, 'Three there'), await s.task(s.db, 3, 'Three here')];
    const { id } = await s.merge(fork);
    expect((await s.db.select().from(tasks).where(eq(tasks.id, there.id)))[0]).toMatchObject({ number: 4, title: 'Three there' });
    expect((await s.db.select().from(tasks).where(eq(tasks.id, here.id)))[0]!.number).toBe(3);
    expect(await s.kept(id)).toMatchObject([{ tbl: 'tasks', key: { id: there.id }, how: 'rewritten', cols: ['number'], was: { number: 3 } }]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it.each([[false], [true]])("keeps two forks' task_events apart by uuid, kept %s", async kept => {
    const s = await stand();
    const line = (downstream: string, over: Partial<typeof mapReturns.$inferInsert> = {}) => ({ ...s.on, upstreamAgentId: s.head.id, downstreamAgentId: downstream, ...over });
    await s.db.insert(mapReturns).values(line(s.ana.id, { sourceKey: null }));
    const fork = await s.sides.fork();
    /* The same number on each side, for another event. */
    const [here] = await s.db.insert(taskEvents).values({ ...s.on, taskId: s.one.id, kind: 'comment', text: 'here' }).returning();
    const [there] = await fork.db.insert(taskEvents).values({ ...s.on, taskId: s.one.id, kind: 'comment', text: 'there' }).returning();
    expect(there!.id).toBe(here!.id);
    await s.db.insert(agentEvents).values({ ...s.on, agentId: s.ana.id, kind: 'text', data: {} });
    await s.db.insert(agentEvents).values({ ...s.on, agentId: s.ana.id, kind: 'text', data: {} });
    const [message] = await fork.db.insert(agentEvents).values({ ...s.on, agentId: s.ana.id, kind: 'text', data: {} }).returning();
    /* A line that was given back names what gave it back, with when. */
    const back = { returnedAt: new Date(), returnedEpoch: 0 };
    await fork.db.insert(mapReturns).values(line(s.ben.id, { ...back, sourceKey: `task:${there!.id}`, sourceTaskId: s.one.id }));
    await fork.db.update(mapReturns).set({ ...back, sourceKey: `message:${message!.seq}` }).where(eq(mapReturns.downstreamAgentId, s.ana.id));
    /* A line whose event the leader will not have: the fork's own event goes before the merge reads it. */
    const [gone] = await fork.db.insert(taskEvents).values({ ...s.on, taskId: s.two.id, kind: 'comment', text: 'gone' }).returning();
    await fork.db.insert(mapReturns).values(line(s.orchestrator.id, { ...back, sourceKey: `task:${gone!.id}` }));
    await fork.db.delete(taskEvents).where(eq(taskEvents.id, gone!.id));
    const { id } = await s.merge(fork, { kept });
    const both = await s.db.select().from(taskEvents).where(eq(taskEvents.taskId, s.one.id)).orderBy(taskEvents.id);
    expect(both.map(event => event.text)).toEqual(['here', 'there']);
    const mine = both[1]!;
    expect(mine.uuid).toBe(there!.uuid);
    expect(mine.id).not.toBe(there!.id);
    const lines = await s.db.select().from(mapReturns);
    expect(lines.find(found => found.downstreamAgentId === s.ben.id)!.sourceKey).toBe(`task:${mine.id}`);
    const [heard] = await s.db.select().from(agentEvents).where(eq(agentEvents.id, message!.id));
    if (!kept) expect(lines.find(found => found.downstreamAgentId === s.ana.id)!.sourceKey).toBe(`message:${heard!.seq}`);
    /* After a restore a difference is listed, in the words of this side's numbers. */
    else expect((await s.conflicts(id)).find(conflict => conflict.tbl === 'map_returns' && conflict.kind === 'differs')!.cols).toContain('source_key');
    expect(lines.some(found => found.downstreamAgentId === s.orchestrator.id)).toBe(false);
    expect((await s.conflicts(id)).find(conflict => conflict.kind === 'refused')).toMatchObject({ tbl: 'map_returns', op: 'insert', why: expect.stringContaining('Its task_events row is not here.') });
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('makes a second head an ordinary agent', async () => {
    const s = await stand();
    const [sales] = await s.db.insert(departments).values({ ...s.on, name: 'Sales', roleCode: 'SALES' }).returning();
    const fork = await s.sides.fork();
    const hire = async (side: Db, name: string) => (await side.insert(agents).values({ ...s.staff, kind: 'head', name, departmentId: sales!.id }).returning())[0]!;
    const [there, here] = [await hire(fork.db, 'There'), await hire(s.db, 'Here')];
    const { id } = await s.merge(fork);
    expect((await s.db.select().from(agents).where(eq(agents.id, there.id)))[0]!.kind).toBe('worker');
    expect((await s.db.select().from(agents).where(eq(agents.id, here.id)))[0]!.kind).toBe('head');
    expect(await s.kept(id)).toMatchObject([{ tbl: 'agents', how: 'rewritten', cols: ['kind'], was: { kind: 'head' } }]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('refuses a row whose parent is gone, and what hangs on it', async () => {
    const s = await stand();
    const [parent] = await s.db.insert(departments).values({ ...s.on, name: 'Parent', roleCode: 'PAR' }).returning();
    const [kept] = await s.db.insert(notebookNotes).values({ ...s.on, number: 1, text: 'Stays', departmentId: s.dev.id }).returning();
    const fork = await s.sides.fork();
    await s.db.delete(departments).where(eq(departments.id, parent!.id));
    const [child] = await fork.db.insert(departments).values({ ...s.on, name: 'Child', roleCode: 'CHI', parentId: parent!.id }).returning();
    const [note] = await fork.db.insert(notebookNotes).values({ ...s.on, number: 1, text: 'Of the child', departmentId: child!.id }).returning();
    const task = await s.task(fork.db, 3, 'Of the child', { departmentId: child!.id });
    await fork.db.insert(taskEvents).values([{ ...s.on, taskId: task.id, kind: 'created' }, { ...s.on, taskId: task.id, kind: 'comment', text: 'x' }]);
    const sales = (await fork.db.insert(departments).values({ ...s.on, name: 'Sales', roleCode: 'SALES' }).returning())[0]!;
    const { id, result } = await s.merge(fork);
    /* The merge commits, and what did not hang on the lost parent applies. */
    expect(await s.db.select().from(departments).where(eq(departments.id, sales.id))).toHaveLength(1);
    expect(result.counts).toMatchObject({ added: 1, conflicts: 5 });
    const refused = await s.conflicts(id);
    expect(refused.map(conflict => [conflict.tbl, conflict.kind, conflict.op])).toEqual([
      ['departments', 'refused', 'insert'], ['notebook_notes', 'refused', 'insert'], ['task_events', 'refused', 'insert'], ['task_events', 'refused', 'insert'], ['tasks', 'refused', 'insert'],
    ]);
    expect(refused[0]!.why).toContain('Its departments row is not here.');
    expect(refused[0]!.there).toMatchObject({ id: child!.id, name: 'Child' });
    expect(refused.find(conflict => conflict.tbl === 'tasks')).toMatchObject({ task_id: task.id, topic: 'work' });
    for (const [table, key] of [[departments, child!.id], [notebookNotes, note!.id], [tasks, task.id]] as const) expect(await s.db.select().from(table).where(eq(table.id, key))).toEqual([]);
    expect(await s.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id))).toEqual([]);
    expect(await s.db.select().from(notebookNotes).where(eq(notebookNotes.id, kept!.id))).toHaveLength(1);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('refuses a task whose after names a refused task', async () => {
    const s = await stand();
    const [gone] = await s.db.insert(departments).values({ ...s.on, name: 'Gone', roleCode: 'GON' }).returning();
    const fork = await s.sides.fork();
    await s.db.delete(departments).where(eq(departments.id, gone!.id));
    const first = await s.task(fork.db, 3, 'First', { departmentId: gone!.id, turnId: null });
    const second = await s.task(fork.db, 4, 'Second', { after: [first.id], turnId: null });
    const { id } = await s.merge(fork);
    const refused = await s.conflicts(id);
    expect(refused.map(conflict => [conflict.key.id, conflict.kind]).sort()).toEqual([[first.id, 'refused'], [second.id, 'refused']].sort());
    expect(refused.find(conflict => conflict.key.id === second.id)!.why).toContain('Its tasks row is not here.');
    expect(await s.db.select().from(tasks).where(eq(tasks.companyId, s.acme.id))).toHaveLength(2);
  });

  it('replays instead of putting values back', async () => {
    const s = await stand();
    const machine = async (key: string) => (await s.db.insert(machines).values({ ...s.on, personId: s.owner.id, machineKey: key, hostname: key }).returning())[0]!;
    const [m1, m2] = [await machine('m1'), await machine('m2')];
    const [node] = await s.db.insert(nodes).values({ ...s.on, machineId: m1.id, subscriptionId: s.plan.id }).returning();
    const fork = await s.sides.fork();
    await s.db.delete(machines).where(eq(machines.id, m2.id));
    await fork.db.update(nodes).set({ machineId: m2.id }).where(eq(nodes.id, node!.id));
    const [second] = await fork.db.insert(nodes).values({ ...s.on, machineId: m1.id, subscriptionId: s.plan.id }).returning();
    const { id } = await s.merge(fork);
    const refused = await s.conflicts(id);
    expect(refused.map(conflict => [conflict.key.id, conflict.kind, conflict.op, conflict.topic]).sort()).toEqual([[node!.id, 'refused', 'update', 'plans'], [second!.id, 'refused', 'insert', 'plans']].sort());
    expect(refused.find(conflict => conflict.key.id === node!.id)!.why).toContain('Its machines row is not here.');
    /* The second one fails only once the first is not written: on a key another row still holds. */
    expect(refused.find(conflict => conflict.key.id === second!.id)!.why).toContain('nodes_machine_plan');
    expect((await s.db.select().from(nodes)).map(found => [found.id, found.machineId])).toEqual([[node!.id, m1.id]]);
  });

  it('sends one email on both sides to the CEO', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    const invite = async (side: Db, name: string) => (await side.insert(people).values({ ...s.on, name, email: 'maria@acme.test', status: 'invited', scopeKind: 'company' }).returning())[0]!;
    const [there] = [await invite(fork.db, 'Maria there'), await invite(s.db, 'Maria here')];
    await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, s.one.id));
    const { id } = await s.merge(fork);
    const [conflict] = await s.conflicts(id);
    expect(conflict).toMatchObject({ tbl: 'people', key: { id: there.id }, op: 'insert', kind: 'refused', topic: 'people', task_id: null });
    expect(conflict!.why).toContain('people_email_unique');
    expect(await s.titleOf(s.db, s.one.id)).toBe('There');
    expect((await s.db.select().from(people).where(eq(people.email, 'maria@acme.test'))).map(person => person.name)).toEqual(['Maria here']);
  });

  it("sends a change this side's rows no longer take to the orchestrator", async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    await fork.db.update(tasks).set({ number: 7 }).where(eq(tasks.id, s.one.id));
    await s.task(s.db, 7, 'Seven here');
    const { id } = await s.merge(fork);
    const [conflict] = await s.conflicts(id);
    expect(conflict).toMatchObject({ tbl: 'tasks', key: { id: s.one.id }, op: 'update', kind: 'refused', topic: 'work', cols: ['number'], task_id: s.one.id });
    expect(conflict!.why).toContain('tasks_company_number');
    expect((await s.db.select().from(tasks).where(eq(tasks.id, s.one.id)))[0]!.number).toBe(1);
  });

  it('lists once a row that takes some columns, lists others, and is then refused', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    /* The number is proven and the title is not; the number then meets a task this side made meanwhile. */
    await fork.db.update(tasks).set({ number: 7, title: 'There' }).where(eq(tasks.id, s.one.id));
    await s.db.update(tasks).set({ title: 'Here' }).where(eq(tasks.id, s.one.id));
    await s.task(s.db, 7, 'Seven here');
    const { id, result } = await s.merge(fork);
    const [conflict, ...more] = await s.conflicts(id);
    expect(more).toEqual([]);
    expect(conflict).toMatchObject({ tbl: 'tasks', key: { id: s.one.id }, op: 'update', kind: 'refused' });
    expect([...conflict!.cols].sort()).toEqual(['number', 'title']);
    expect(conflict!.why).toContain('tasks_company_number');
    expect(conflict!.why).toContain('title: here "Here", there "There"');
    expect(result.counts.conflicts).toBe(1);
    expect((await s.db.select().from(tasks).where(eq(tasks.id, s.one.id)))[0]).toMatchObject({ number: 1, title: 'Here' });
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('brings back nothing the company removed since the restore, and lists it', async () => {
    const s = await stand();
    const [maria] = await s.db.insert(people).values({ ...s.on, name: 'Maria', email: 'maria@acme.test', status: 'active', scopeKind: 'listed' }).returning();
    const [sales] = await s.db.insert(departments).values({ ...s.on, name: 'Sales', roleCode: 'SALES' }).returning();
    await s.db.insert(personAccess).values([{ ...s.on, personId: maria!.id, departmentId: s.dev.id }, { ...s.on, personId: maria!.id, departmentId: sales!.id }]);
    const gone = await s.task(s.db, 3, 'Removed since', { turnId: null });
    const fork = await s.sides.fork();
    /* The restore: its carry writes her places anew, and leaves its mark. */
    await s.db.delete(personAccess).where(eq(personAccess.personId, maria!.id));
    await s.db.insert(personAccess).values([{ ...s.on, personId: maria!.id, departmentId: s.dev.id }, { ...s.on, personId: maria!.id, departmentId: sales!.id }]);
    await s.db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, kept) VALUES (gen_random_uuid(), gen_random_uuid(), now(), 'hornhoof_before_t1')`);
    /* A moment later the CEO narrows her access to one department, as the screen does: all of her places go, and one
       comes back. And a task is removed. What came before is set a second back, so on any clock it is a moment later. */
    await s.db.execute(sql`UPDATE net.journal SET at = at - interval '1 second'`);
    await s.db.execute(sql`UPDATE net.restores SET at = at - interval '1 second', dumped_at = dumped_at - interval '1 second'`);
    await s.db.delete(personAccess).where(eq(personAccess.personId, maria!.id));
    const [left] = await s.db.insert(personAccess).values({ ...s.on, personId: maria!.id, departmentId: s.dev.id }).returning();
    await s.db.delete(tasks).where(eq(tasks.id, gone.id));
    const { id, result } = await s.merge(fork, { kept: true });
    /* She reaches what she reached after the CEO's change, and nothing more; the task stays removed. */
    expect((await s.db.select().from(personAccess).where(eq(personAccess.personId, maria!.id))).map(row => row.id)).toEqual([left!.id]);
    expect(await s.titleOf(s.db, gone.id)).toBeNull();
    expect(result.counts).toMatchObject({ added: 0, matched: 1 });
    expect((await s.conflicts(id)).map(conflict => [conflict.tbl, conflict.kind, conflict.op, conflict.topic])).toEqual([['person_access', 'changed_removed', 'insert', 'access'], ['tasks', 'changed_removed', 'insert', 'work']]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('brings a file as its hash, which names its bytes in the store', async () => {
    const s = await stand();
    const file = async (side: Db, bytes: string) => (await side.insert(attachments).values({ ...s.on, agentId: s.ana.id, mediaType: 'text/plain', sha256: await stored(side, bytes), size: bytes.length, taskId: s.one.id }).returning())[0]!;
    const same = await file(s.db, 'the same on both');
    const fork = await s.sides.fork();
    const added = await file(fork.db, 'only there');
    const asked: string[] = [];
    const source = await fork.source();
    const { id } = await (async () => {
      const [row] = await rowsOf<{ id: string }>(s.db, sql`INSERT INTO net.merges (source, label) VALUES ('kept:hornhoof_before_t9', 'the fork') RETURNING id`);
      const watched = { ...source, query: (async (text: string, params?: unknown[]) => {
        asked.push(text);
        return source.query(text, params);
      }) as typeof source.query };
      await runMerge(s.db, { id: row!.id, label: 'the fork', kept: true, companyId: s.acme.id }, watched, { log: () => undefined });
      return { id: row!.id };
    })();
    await source.close();
    const [kept] = await s.db.select().from(attachments).where(eq(attachments.id, added.id));
    expect(kept!.sha256).toBe(sha256Of('only there'));
    expect((await s.db.select().from(attachments).where(eq(attachments.id, same.id)))[0]!.sha256).toBe(sha256Of('the same on both'));
    /* Its rows name their files by hash, and no read of the source asks for a file's bytes. */
    expect(asked.some(text => text.includes('public."attachments"'))).toBe(true);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('writes in few passes however deep what hangs on a refused row goes', async () => {
    const s = await stand();
    const [parent] = await s.db.insert(departments).values({ ...s.on, name: 'Parent', roleCode: 'PAR' }).returning();
    const fork = await s.sides.fork();
    await s.db.delete(departments).where(eq(departments.id, parent!.id));
    /* A chain five deep under the department that is gone: a department, a team, an agent, a task of his, its event. */
    const [child] = await fork.db.insert(departments).values({ ...s.on, name: 'Child', roleCode: 'CHI', parentId: parent!.id }).returning();
    const [team] = await fork.db.insert(teams).values({ ...s.on, departmentId: child!.id, name: 'Team' }).returning();
    const [agent] = await fork.db.insert(agents).values({ ...s.staff, kind: 'worker', name: 'Deep', departmentId: child!.id, teamId: team!.id }).returning();
    const task = await s.task(fork.db, 3, 'Deep', { departmentId: child!.id, assigneeAgentId: agent!.id, turnId: null });
    await fork.db.insert(taskEvents).values({ ...s.on, taskId: task.id, kind: 'created', agentId: agent!.id });
    for (let n = 4; n < 10; n += 1) await s.task(fork.db, n, `Plain ${n}`, { turnId: null });
    let units = 0;
    const { id, result } = await s.merge(fork, { onUnit: () => void (units += 1) });
    expect(result.counts).toMatchObject({ added: 6, conflicts: 5 });
    /* Asked of the database once per pass: what hangs on a refused row is found without writing it again and again. */
    const passes = await rowsOf<{ n: number }>(s.db, sql`SELECT (counts->>'passes')::int AS n FROM net.merges WHERE id = ${id}`);
    expect(passes[0]!.n).toBeLessThanOrEqual(2);
    expect(units).toBe(11);
  });

  it('stops what the source left running', async () => {
    const s = await stand();
    const [machine] = await s.db.insert(machines).values({ ...s.on, personId: s.owner.id, machineKey: 'm1', hostname: 'marat-mac' }).returning();
    const fork = await s.sides.fork();
    const job = async (status: 'queued' | 'running' | 'done') =>
      (await fork.db.insert(jobs).values({ ...s.on, subscriptionId: s.plan.id, agentId: s.ana.id, prompt: 'Work', timeoutMs: 60_000, status, taskId: s.one.id, ...(status === 'done' ? { finishedAt: new Date() } : {}) }).returning())[0]!;
    const [running, queued, done] = [await job('running'), await job('queued'), await job('done')];
    const [command] = await fork.db.insert(computerRuns).values({ ...s.on, machineId: machine!.id, command: 'id', timeoutS: 60 }).returning();
    const [run] = await fork.db.insert(testRuns).values({ ...s.on, number: 1, taskId: s.one.id, agentId: s.ana.id, jobId: done.id, command: 'npm test', parts: 2, timeoutMs: 60_000, status: 'running' }).returning();
    const parts = await fork.db.insert(testParts).values([{ ...s.on, runId: run!.id, part: 1, status: 'queued' }, { ...s.on, runId: run!.id, part: 2, status: 'running' }]).returning();
    const { id, result } = await s.merge(fork, { label: 'marat-mac' });
    const error = 'Ran on marat-mac while it was cut off.';
    for (const made of [running, queued]) {
      const [now] = await s.db.select().from(jobs).where(eq(jobs.id, made.id));
      expect([now!.status, now!.error, now!.finishedAt instanceof Date]).toEqual(['failed', error, true]);
    }
    expect((await s.db.select().from(jobs).where(eq(jobs.id, done.id)))[0]).toMatchObject({ status: 'done', error: null });
    expect((await s.db.select().from(computerRuns).where(eq(computerRuns.id, command!.id)))[0]).toMatchObject({ state: 'lost', doneAt: expect.any(Date) });
    expect((await s.db.select().from(testRuns).where(eq(testRuns.id, run!.id)))[0]).toMatchObject({ status: 'stopped', finishedAt: expect.any(Date) });
    for (const part of parts) expect((await s.db.select().from(testParts).where(eq(testParts.id, part.id)))[0]).toMatchObject({ status: 'stopped', error, finishedAt: expect.any(Date) });
    const written = await s.kept(id);
    expect(written.map(row => [row.tbl, row.how]).sort()).toEqual([['computer_runs', 'rewritten'], ['jobs', 'rewritten'], ['jobs', 'rewritten'], ['test_parts', 'rewritten'], ['test_parts', 'rewritten'], ['test_runs', 'rewritten']]);
    expect(written.find(row => row.tbl === 'computer_runs')).toMatchObject({ cols: ['state', 'done_at'], was: { state: 'waiting', done_at: null } });
    expect(result.counts.rewritten).toBe(6);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('stops what a kept database left running, once, whichever copy of it comes later', async () => {
    /* After a restore nobody knows where it ran. */
    const again = await stand();
    const kept = await again.sides.fork();
    const [left] = await kept.db.insert(jobs).values({ ...again.on, subscriptionId: again.plan.id, prompt: 'Work', timeoutMs: 60_000, status: 'running' }).returning();
    const copy = await again.sides.fork();
    await copy.db.insert(jobs).values(left!);
    await again.merge(kept, { kept: true });
    expect((await again.db.select().from(jobs).where(eq(jobs.id, left!.id)))[0]).toMatchObject({ status: 'failed', error: 'Ran before the restore; how it ended was not kept.' });
    /* A copy that followed the database from before holds the same turn as it was left. This side ended it itself when
       it took it from that database: the copy's row says nothing new, and nobody is asked which of the two holds. */
    const second = await again.merge(copy, { kept: true });
    expect(await again.conflicts(second.id)).toEqual([]);
    expect((await again.db.select().from(jobs).where(eq(jobs.id, left!.id)))[0]).toMatchObject({ status: 'failed' });
    expect(await again.checked(copy, second.id)).toEqual({ ok: true, missing: [] });
    /* What the copy holds otherwise than that database did is still a difference to settle. */
    const other = await again.sides.fork();
    await other.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, left!.id));
    const third = await again.merge(other, { kept: true });
    expect(await again.conflicts(third.id)).toMatchObject([{ tbl: 'jobs', kind: 'differs' }]);
  });

  it('leaves open what the leader holds open', async () => {
    const s = await stand();
    const work = { ...s.on, subscriptionId: s.plan.id, prompt: 'Work', timeoutMs: 60_000 };
    const [waiting] = await s.db.insert(jobs).values({ ...work, status: 'queued' }).returning();
    const [failed] = await s.db.insert(jobs).values({ ...work, status: 'failed', error: 'Lost', finishedAt: new Date() }).returning();
    const fork = await s.sides.fork();
    await fork.db.update(jobs).set({ status: 'running', startedAt: new Date() }).where(eq(jobs.id, waiting!.id));
    await fork.db.update(jobs).set({ status: 'running', error: null, finishedAt: null, startedAt: new Date() }).where(eq(jobs.id, failed!.id));
    const { id } = await s.merge(fork, { label: 'marat-mac' });
    /* The turn the leader still holds in its queue runs here as the leader knows it: nothing of the source's run of it
       is taken. */
    expect((await s.db.select().from(jobs).where(eq(jobs.id, waiting!.id)))[0]).toMatchObject({ status: 'queued', startedAt: null });
    /* One the leader holds ended is never written open. */
    expect((await s.db.select().from(jobs).where(eq(jobs.id, failed!.id)))[0]).toMatchObject({ status: 'failed', error: 'Ran on marat-mac while it was cut off.', finishedAt: expect.any(Date), startedAt: expect.any(Date) });
    const written = await s.kept(id);
    expect(written.map(row => [row.key.id, row.how])).toEqual(expect.arrayContaining([[waiting!.id, 'rewritten'], [failed!.id, 'rewritten']]));
    expect([...written.find(row => row.key.id === waiting!.id)!.cols].sort()).toEqual(['started_at', 'status']);
    expect(await s.conflicts(id)).toEqual([]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it("brings a file of a side that still holds its bytes into this side's store, and names it by their hash", async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    /* The fork's database had not moved its files into the store yet: it keeps their bytes in the old column. */
    await fork.db.execute(sql`ALTER TABLE attachments ADD COLUMN bytes bytea`);
    const bytes = Buffer.from('the old bytes of a file');
    const [old] = await fork.db.insert(attachments).values({ ...s.on, agentId: s.ana.id, mediaType: 'application/octet-stream', size: bytes.length, taskId: s.one.id }).returning();
    await fork.db.execute(sql`UPDATE attachments SET bytes = ${bytes} WHERE id = ${old!.id}`);
    const files = looseFiles();
    const { id } = await s.merge(fork, { files });
    const [kept] = await s.db.select().from(attachments).where(eq(attachments.id, old!.id));
    expect(kept!.sha256).toBe(sha256Of(bytes));
    expect((await files.bytes(s.db, kept!.sha256!)).equals(bytes)).toBe(true);
    expect(await s.kept(id)).toMatchObject([{ tbl: 'attachments', how: 'rewritten', cols: ['sha256'], was: { sha256: null } }]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('leaves the programs a server watched behind, and brings back a picture of one without it', async () => {
    const s = await stand();
    const [machine] = await s.db.insert(machines).values({ ...s.on, personId: s.owner.id, machineKey: 'm1', hostname: 'marat-mac' }).returning();
    const [node] = await s.db.insert(nodes).values({ ...s.on, machineId: machine!.id, subscriptionId: s.plan.id }).returning();
    const fork = await s.sides.fork();
    const [job] = await fork.db.insert(jobs).values({ ...s.on, subscriptionId: s.plan.id, agentId: s.ana.id, prompt: 'Work', timeoutMs: 60_000, status: 'done', finishedAt: new Date() }).returning();
    const [program] = await fork.db.insert(programInstances).values({ ...s.on, id: randomUUID(), agentId: s.ana.id, nodeId: node!.id, launched: true, active: true }).returning();
    const [hung] = await fork.db.insert(programOperatorCases).values({
      ...s.on, agentId: s.ana.id, jobId: job!.id, nodeId: node!.id, instance: program!.id, reason: 'recorded_no_activity', evidenceKey: 'k1', capability: 'c'.repeat(32), deadlineAt: new Date(Date.now() + 3_600_000),
    }).returning();
    const [picture] = await fork.db.insert(attachments).values({ ...s.on, agentId: s.ana.id, mediaType: 'image/png', sha256: await stored(fork.db, 'screen'), size: 6, operatorCaseId: hung!.id }).returning();
    const { id, result } = await s.merge(fork);
    expect(await s.db.select().from(programInstances)).toEqual([]);
    expect(await s.db.select().from(programOperatorCases)).toEqual([]);
    const [kept] = await s.db.select().from(attachments).where(eq(attachments.id, picture!.id));
    expect([kept!.operatorCaseId, kept!.sha256]).toEqual([null, sha256Of('screen')]);
    expect(await s.kept(id)).toMatchObject([{ tbl: 'attachments', how: 'rewritten', cols: ['operator_case_id'], was: { operator_case_id: hung!.id } }]);
    expect([result.counts.added, await s.conflicts(id)]).toEqual([2, []]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('keeps a machine closed and imports no employee grants from a copy', async () => {
    const s = await stand();
    const [known] = await s.db.insert(machines).values({ ...s.on, personId: s.owner.id, machineKey: 'known', hostname: 'known', computerClosed: true }).returning();
    const fork = await s.sides.fork();
    const [added] = await fork.db.insert(machines).values({ ...s.on, personId: s.owner.id, machineKey: 'added', hostname: 'added', computerClosed: true }).returning();
    await fork.db.update(machines).set({ computerClosed: false }).where(eq(machines.id, known!.id));
    await fork.db.insert(machineAccess).values([known!, added!].map(machine => ({ ...s.on, machineId: machine.id, scope: 'all_agents' as const })));
    const restored = await s.merge(fork, { kept: true });
    expect((await s.db.select().from(machines).where(eq(machines.id, added!.id)))[0]).toMatchObject({ computerClosed: true });
    expect((await s.db.select().from(machines).where(eq(machines.id, known!.id)))[0]).toMatchObject({ computerClosed: true });
    expect(await s.db.select().from(machineAccess)).toEqual([]);
    expect(await s.conflicts(restored.id)).toMatchObject([{ tbl: 'machines', cols: ['computer_closed'] }]);
    expect(await s.checked(fork, restored.id)).toEqual({ ok: true, missing: [] });
  });

  it('finds a row the carry wrote anew', async () => {
    const s = await stand();
    const [maria] = await s.db.insert(people).values({ ...s.on, name: 'Maria', email: 'maria@acme.test', status: 'active', scopeKind: 'listed' }).returning();
    const [place] = await s.db.insert(personAccess).values({ ...s.on, personId: maria!.id, departmentId: s.dev.id }).returning();
    const fork = await s.sides.fork();
    await s.db.delete(personAccess).where(eq(personAccess.id, place!.id));
    const [anew] = await s.db.insert(personAccess).values({ ...s.on, personId: maria!.id, departmentId: s.dev.id }).returning();
    const { id, result } = await s.merge(fork, { kept: true });
    expect(await s.conflicts(id)).toEqual([]);
    expect(result.counts).toMatchObject({ matched: 1, added: 0 });
    expect(await s.kept(id)).toMatchObject([{ tbl: 'person_access', key: { id: place!.id }, how: 'matched', here: { id: anew!.id } }]);
    expect((await s.db.select().from(personAccess)).map(row => row.id)).toEqual([anew!.id]);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('never reads a stale absence as a deletion or a stale value as a change', async () => {
    const s = await stand();
    const [stays, back] = [await s.task(s.db, 3, 'Stays', { turnId: null }), await s.task(s.db, 4, 'Comes back', { turnId: null })];
    const fork = await s.sides.fork();
    await fork.db.delete(tasks).where(eq(tasks.id, stays.id));
    await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, s.one.id));
    await s.db.delete(tasks).where(eq(tasks.id, back.id));
    const { id, result } = await s.merge(fork, { kept: true });
    expect(result.path).toBe('compare');
    expect(await s.titleOf(s.db, stays.id)).toBe('Stays');
    expect(await s.titleOf(s.db, s.one.id)).toBe('One');
    expect(await s.titleOf(s.db, back.id)).toBe('Comes back');
    expect(await s.conflicts(id)).toMatchObject([{ tbl: 'tasks', key: { id: s.one.id }, kind: 'differs', cols: ['title'], op: 'update' }]);
    expect(result.counts).toMatchObject({ added: 1, deleted: 0, changed: 0, conflicts: 1 });
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('compares a kept database even when its journal adds nothing', async () => {
    for (const kept of [true, false]) {
      const s = await stand();
      const fork = await s.sides.fork();
      await fork.client.exec(`ALTER TABLE tasks DISABLE TRIGGER net_journal; UPDATE tasks SET title = 'Unjournaled' WHERE id = '${s.one.id}'; ALTER TABLE tasks ENABLE TRIGGER net_journal`);
      const { id, result } = await s.merge(fork, { kept });
      expect(await s.titleOf(s.db, s.one.id)).toBe('One');
      if (kept) {
        expect(await s.conflicts(id)).toMatchObject([{ tbl: 'tasks', kind: 'differs', cols: ['title'] }]);
        expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
      } else {
        /* The journals share every row and prove nothing new: nothing is listed, and the check finds what nothing explains. */
        expect([result.path, await s.conflicts(id)]).toEqual(['journal', []]);
        expect(await s.checked(fork, id)).toEqual({ ok: false, missing: [{ table: 'tasks', key: { id: s.one.id } }] });
      }
    }
  });

  it('never adds sessions after a restore', async () => {
    for (const kept of [true, false]) {
      const s = await stand();
      const fork = await s.sides.fork();
      await fork.db.insert(sessions).values({ tokenHash: 'a'.repeat(64), personId: s.owner.id, expiresAt: new Date(Date.now() + 3_600_000) });
      const { id } = await s.merge(fork, { kept });
      expect(await s.db.select().from(sessions)).toHaveLength(kept ? 0 : 1);
      expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
    }
  });

  it('merges a database plan 7 kept', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    const [sales] = await fork.db.insert(departments).values({ ...s.on, name: 'Sales', roleCode: 'SALES' }).returning();
    await asPlan7(fork.client);
    const { id, result } = await s.merge(fork, { kept: true });
    expect(result.counts.added).toBe(1);
    expect(await s.db.select().from(departments).where(eq(departments.id, sales!.id))).toHaveLength(1);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('carries a conflict left open', async () => {
    const s = await stand();
    const lost = { id: randomUUID() };
    const hold = async (fork: Fork) => {
      const [earlier] = await rowsOf<{ id: string }>(fork.db, sql`INSERT INTO net.merges (source, label, status) VALUES ('machine:earlier', 'an earlier one', 'merged') RETURNING id`);
      await fork.db.execute(sql`INSERT INTO net.merge_conflicts (id, merge, tbl, key, op, kind, topic, there, why)
        VALUES (${open}, ${earlier!.id}, 'tasks', ${JSON.stringify(lost)}::jsonb, 'insert', 'refused', 'work', ${JSON.stringify({ ...lost, title: 'Only here' })}::jsonb, 'Its departments row is not here.')`);
    };
    const open = randomUUID();
    const [first, second] = [await s.sides.fork(), await s.sides.fork()];
    await hold(first);
    await hold(second);
    const { id, result } = await s.merge(first);
    expect(result.counts).toMatchObject({ carried: 1, conflicts: 1 });
    expect(await s.conflicts(id)).toMatchObject([{ merge: id, carried: open, tbl: 'tasks', key: lost, op: 'insert', kind: 'refused', topic: 'work', here: null, there: { title: 'Only here' } }]);
    expect(await s.checked(first, id)).toEqual({ ok: true, missing: [] });
    /* It may hold the only copy of a value the company wrote, and is carried once. */
    const again = await s.merge(second);
    expect(again.result.counts.carried).toBe(0);
    expect(await s.conflicts(again.id)).toEqual([]);
    expect(await s.checked(second, again.id)).toEqual({ ok: true, missing: [] });
  });

  it('merges three sides one at a time', async () => {
    const s = await stand();
    const [first, second] = [await s.sides.fork(), await s.sides.fork()];
    await first.db.update(tasks).set({ title: 'From the first' }).where(eq(tasks.id, s.one.id));
    await second.db.update(tasks).set({ title: 'From the second' }).where(eq(tasks.id, s.two.id));
    const [one, two] = [await s.merge(first), await s.merge(second)];
    expect([await s.titleOf(s.db, s.one.id), await s.titleOf(s.db, s.two.id)]).toEqual(['From the first', 'From the second']);
    expect([(await s.consumed(one.id)).length, (await s.consumed(two.id)).length]).toEqual([1, 1]);
    /* What the first merge wrote here is no change of the second source's, and no difference of it either. */
    expect([two.result.counts.changed, await s.conflicts()]).toEqual([1, []]);
    expect(await s.checked(second, two.id)).toEqual({ ok: true, missing: [] });
    /* A source read again brings nothing it brought before. */
    const [more] = await rowsOf<{ id: string }>(s.db, sql`INSERT INTO net.merges (source, label) VALUES ('machine:again', 'the first again') RETURNING id`);
    const source = await first.source();
    const again = await runMerge(s.db, { id: more!.id, label: 'the first again', kept: false, companyId: s.acme.id }, source, { log: () => undefined });
    await source.close();
    expect(again.counts).toMatchObject({ changed: 0, added: 0, conflicts: 0 });
  });

  it('never applies twice', async () => {
    const s = await stand();
    await s.db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.id, s.turn.id));
    const fork = await s.sides.fork();
    await s.task(fork.db, 3, 'Three there', { turnId: null });
    await s.task(s.db, 3, 'Three here', { turnId: null });
    await fork.db.insert(turns).values({ ...s.on, departmentId: s.dev.id, number: 2, goal: 'There', status: 'open' });
    await s.db.insert(turns).values({ ...s.on, departmentId: s.dev.id, number: 2, goal: 'Here', status: 'open' });
    await fork.db.insert(jobs).values({ ...s.on, subscriptionId: s.plan.id, prompt: 'Work', timeoutMs: 60_000, status: 'running' });
    const { id } = await s.merge(fork);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
    const before = await rowsOf<{ n: number }>(s.db, sql`SELECT count(*)::int AS n FROM net.journal`);
    const source = await fork.source();
    await expect(runMerge(s.db, { id, label: 'the fork', kept: false, companyId: s.acme.id }, source, { log: () => undefined })).rejects.toThrow(new MergeRefused('The merge was applied already.'));
    await source.close();
    expect(await rowsOf<{ n: number }>(s.db, sql`SELECT count(*)::int AS n FROM net.journal`)).toEqual(before);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('finishes the completion check', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, s.one.id));
    await fork.db.update(tasks).set({ title: 'Two there' }).where(eq(tasks.id, s.two.id));
    await s.db.update(tasks).set({ title: 'Two here' }).where(eq(tasks.id, s.two.id));
    const said = (side: Db) => withSource(nodeSource('n1', 'jobs', 7), async () => (await side.insert(agentEvents).values({ ...s.on, agentId: s.ana.id, kind: 'text', data: {} }).returning())[0]!);
    const [there] = [await said(fork.db), await said(s.db)];
    const added = await s.task(fork.db, 3, 'Three');
    const { id } = await s.merge(fork);
    expect((await s.consumed(id)).map(entry => entry.how).sort()).toEqual(['applied', 'applied', 'conflict', 'skipped', 'skipped']);
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
    /* A journal row of the source that nothing accounts for. */
    const [taken] = await rowsOf<{ journal: string; merge: string; at: string | Date; how: string }>(s.db, sql`DELETE FROM net.merge_consumed WHERE merge = ${id} AND how = 'applied' AND journal = (SELECT min(journal::text)::uuid FROM net.merge_consumed WHERE merge = ${id} AND how = 'applied') RETURNING *`);
    expect((await s.checked(fork, id)).ok).toBe(false);
    await s.db.execute(sql`INSERT INTO net.merge_consumed (journal, merge, at, how) VALUES (${taken!.journal}, ${id}, ${new Date(taken!.at).toISOString()}, 'applied')`);
    /* A row the leader lacks that nothing names. */
    await s.db.execute(sql`DELETE FROM net.merge_rows WHERE merge = ${id} AND how = 'skipped'`);
    expect(await s.checked(fork, id)).toEqual({ ok: false, missing: [{ table: 'agent_events', key: { id: there.id } }] });
    await s.db.execute(sql`INSERT INTO net.merge_rows (merge, tbl, key, how) VALUES (${id}, 'agent_events', ${JSON.stringify({ id: there.id })}::jsonb, 'skipped')`);
    expect((await s.checked(fork, id)).ok).toBe(true);
    /* What the company itself did to a row since is its own later change. */
    await s.db.update(tasks).set({ title: 'Changed since' }).where(eq(tasks.id, added.id));
    expect((await s.checked(fork, id)).ok).toBe(true);
    await s.db.delete(tasks).where(eq(tasks.id, added.id));
    expect(await s.checked(fork, id)).toEqual({ ok: true, missing: [] });
  });

  it('changes nothing when it fails half way', async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    for (let n = 3; n < 15; n += 1) await s.task(fork.db, n, `Task ${n}`, { turnId: null });
    const state = async () => ({
      tasks: (await s.db.select(idOnly(tasks)).from(tasks)).length,
      journal: await rowsOf(s.db, sql`SELECT count(*)::int AS n FROM net.journal`),
      records: await rowsOf(s.db, sql`SELECT (SELECT count(*) FROM net.merge_conflicts)::int AS conflicts, (SELECT count(*) FROM net.merge_consumed)::int AS consumed, (SELECT count(*) FROM net.merge_rows)::int AS kept`),
    });
    const before = await state();
    await expect(s.merge(fork, { onUnit: n => (n === 10 ? Promise.reject(new Error('a fault')) : undefined) })).rejects.toThrow('a fault');
    expect(await state()).toEqual(before);
    expect((await rowsOf<{ status: string }>(s.db, sql`SELECT status FROM net.merges`)).map(row => row.status)).toEqual(['pending']);
    /* Two shapes never merge. */
    const other = await s.sides.fork();
    await other.client.exec('ALTER TABLE teams ADD COLUMN nickname text');
    await expect(s.merge(other)).rejects.toThrow(new MergeRefused('The two databases are of different versions.'));
    /* Nor does another company's database. */
    const stranger = await s.sides.fork();
    await expect((async () => {
      const [row] = await rowsOf<{ id: string }>(s.db, sql`INSERT INTO net.merges (source, label) VALUES ('machine:stranger', 'a stranger') RETURNING id`);
      const source = await stranger.source();
      try {
        return await runMerge(s.db, { id: row!.id, label: 'a stranger', kept: false, companyId: randomUUID() }, source, { log: () => undefined });
      } finally {
        await source.close();
      }
    })()).rejects.toThrow(new MergeRefused('This database is of another company.'));
    expect(await state()).toEqual(before);
  });

  it("holds the app's writes while it runs", async () => {
    const s = await stand();
    const fork = await s.sides.fork();
    await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, s.one.id));
    let free!: () => void;
    const waits = new Promise<void>(resolve => (free = resolve));
    let reached!: () => void;
    const atFirst = new Promise<void>(resolve => (reached = resolve));
    const lines: string[] = [];
    /* The merge counts on this clock: 150 ms go by on it while the write waits, and nobody waits for real time. */
    let now = 1_000;
    const merging = s.merge(fork, { onUnit: n => (n === 1 ? (reached(), waits) : undefined), log: line => lines.push(line), clock: () => now });
    /* A merge that ends before its first unit fails the test with its own reason, instead of leaving it to wait. */
    await Promise.race([atFirst, merging.then(() => Promise.reject(new Error('The merge ended before its first unit.')))]);
    const order: string[] = [];
    const write = s.db.update(tasks).set({ title: 'Meanwhile' }).where(and(eq(tasks.id, s.two.id))).then(() => {
      order.push('written');
      return 'written';
    });
    now += 150;
    /* The merge holds the only connection a PGlite has, so what is there is asked of the merge's own result later. */
    order.push('freed');
    free();
    const { id, result } = await merging;
    expect(await write).toBe('written');
    expect([await s.titleOf(s.db, s.one.id), await s.titleOf(s.db, s.two.id)]).toEqual(['There', 'Meanwhile']);
    /* The write came after the merge: the merge lists nothing of it. */
    expect([result.counts.changed, await s.conflicts(id)]).toEqual([1, []]);
    const journal = await rowsOf<{ xact: string; key: { id: string } }>(s.db, sql`SELECT xact, key FROM net.journal WHERE tbl = 'tasks' AND op = 'update' ORDER BY at`);
    expect(journal.map(row => row.key.id)).toEqual([s.one.id, s.two.id]);
    expect(journal[0]!.xact).toBe((await s.mergeRow(id)).xact);
    expect(order).toEqual(['freed', 'written']);
    expect(result.heldMs).toBe(150);
    expect(lines).toEqual([`The merge ${id} held the app's writes ${result.heldMs} ms.`]);
    expect(lines.join(' ')).not.toMatch(/There|Meanwhile|One|Two/);
  });
});
