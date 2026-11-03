import type { PGlite } from '@electric-sql/pglite';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, subscriptions, taskEvents, tasks, turns } from '../src/db/schema.js';
import { cancel, createTask, submit, verdict } from '../src/modules/tasks/engine.js';
import { setUpCompany, statements, testApp } from './helpers.js';

const TURNS = 50;
const PER_TURN = 40;

/* A company with a long history: 49 closed turns of 40 finished tasks each, every one coming after the one before it and
   checked by Rita, and the 50th turn open. Rex and Rita review for Development, Rex hired first. In the open turn and
   outside any turn some tasks wait at a gate now. */
async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const ctx = app.ctx;
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, at: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id, createdAt: new Date(at) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD', '2026-01-01T00:00:00Z');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', '2026-01-01T00:01:00Z');
  const tess = await hire('Tess', 'worker', 'DEV-TEST', '2026-01-01T00:02:00Z');
  const rex = await hire('Rex', 'worker', 'DEV-REV', '2026-01-01T00:03:00Z');
  const rita = await hire('Rita', 'worker', 'DEV-REV', '2026-01-01T00:04:00Z');

  const history = await db
    .insert(turns)
    .values(Array.from({ length: TURNS - 1 }, (_, i) => ({ companyId, number: i + 1, title: `Turn ${i + 1}`, goal: 'Old work.', status: 'closed' as const, closedAt: new Date() })))
    .returning();
  const [open] = await db.insert(turns).values({ companyId, number: TURNS, title: 'Payments', goal: 'Take card payments.', status: 'open', openedAt: new Date() }).returning();
  let number = 0;
  for (const turn of history) {
    const done = { companyId, turnId: turn.id, departmentId: dev!.id, status: 'done' as const, closedAt: new Date(), executorAgentId: bruno.id, gates: [rita.id], panel: [rita.id], createdByAgentId: head.id };
    const rows = await db.insert(tasks).values(Array.from({ length: PER_TURN }, () => ({ ...done, number: ++number, title: `Old task ${number}` }))).returning({ id: tasks.id });
    for (let i = 1; i < rows.length; i++) await db.update(tasks).set({ after: [rows[i - 1]!.id] }).where(eq(tasks.id, rows[i]!.id));
  }
  /* At a gate now: Rita on one task of the open turn; Rex on one there and on one outside any turn. */
  const atGate = (turnId: string | null, reviewer: string, status: 'review' | 'waiting') => ({
    companyId, turnId, number: ++number, title: `Checked ${number}`, departmentId: dev!.id, status, stage: 1, executorAgentId: bruno.id, assigneeAgentId: reviewer, gates: [reviewer], panel: [reviewer], createdByAgentId: head.id,
  });
  await db.insert(tasks).values([atGate(open!.id, rita.id, 'review'), atGate(open!.id, rex.id, 'review'), atGate(null, rex.id, 'waiting')]);

  const parent = (await createTask(ctx, { personId: ceo!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  const member = async (title: string, executor: string, after: string[] = []) =>
    (await createTask(ctx, { agentId: head.id }, { title, brief: '', body: '', departmentId: dev!.id, parentId: parent.id, assigneeAgentId: executor, executor: true, gates: [rita.id], after })).task;
  const read = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const started = async (id: string) => (await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, id), eq(taskEvents.kind, 'started')))).map(e => e.text);
  return { app, ctx, db, companyId, ceo: ceo!, orchestrator: orchestrator!, dev: dev!, open: open!, head, bruno, tess, rex, rita, parent, member, read, started };
}

describe('the move path in a company with a long history', () => {
  it('picks the reviewer, starts what waited and tells who waits on a cancelled task as before', async () => {
    const c = await company();
    expect((await c.db.select({ n: sql<number>`count(*)::int` }).from(tasks))[0]!.n).toBeGreaterThan((TURNS - 1) * PER_TURN);
    const api = await c.member('Checkout API', c.bruno.id);
    const schema = await c.member('Database schema', c.bruno.id);
    const docs = await c.member('Docs', c.tess.id, [api.id]);
    const e2e = await c.member('End-to-end tests', c.tess.id, [api.id, schema.id]);
    expect(api.turnId).toBe(c.open.id);

    /* Rex checks two tasks now, one of them outside any turn, and Rita one: Rita takes it. The 1960 old tasks Rita
       checked are done and count for nothing. */
    const handed = await submit(c.ctx, c.bruno.id, api.id, { summary: 'Done.', evidence: 'npm test' });
    expect(handed.task.panel).toEqual([c.rita.id]);
    expect(handed.wakes.map(w => [w.agentId, w.why])).toEqual([[c.rita.id, 'review']]);

    /* Done: Docs waited for it alone and starts; the tests wait for the schema still. */
    const passed = await verdict(c.ctx, c.rita.id, api.id, { pass: true, comment: 'Good.' });
    expect(passed.wakes.map(w => [w.agentId, w.taskId, w.why])).toContainEqual([c.tess.id, docs.id, 'assigned']);
    expect(passed.wakes.filter(w => w.why === 'assigned').map(w => w.taskId)).toEqual([docs.id]);
    expect(await c.started(docs.id)).toEqual([`#${api.number} is done, so it starts now.`]);
    expect(await c.started(e2e.id)).toEqual([]);
    expect((await c.read(docs.id)).version).toBeGreaterThan(docs.version);

    /* Cancelled: whoever made each task that waits for it hears so, the orchestrator for the CEO's. */
    const ceos = (await createTask(c.ctx, { personId: c.ceo.id }, { title: 'Launch', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.head.id, after: [schema.id] })).task;
    const gone = await cancel(c.ctx, { personId: c.ceo.id }, schema.id, 'Not needed.');
    const told = gone.wakes.filter(w => w.why === 'after_cancelled').map(w => [w.agentId, w.taskId, w.text]);
    expect(told).toEqual([
      [c.head.id, e2e.id, `#${schema.number}`],
      [c.orchestrator.id, ceos.id, `#${schema.number}`],
    ]);
    expect(gone.waiting).toEqual([]);
    expect((await c.read(e2e.id)).status).toBe('open');
  });

  it('reads and locks only the tasks of the open turn and of none, with the index on the turn that its migration adds', async () => {
    const c = await company();
    const client = (c.db as unknown as { $client: PGlite }).$client;
    /* The index a separate migration adds; without it Postgres reads the company's tasks to find a turn's. */
    await client.exec('create index tasks_turn_id on tasks (turn_id); analyze tasks;');
    const api = await c.member('Checkout API', c.bruno.id);
    const schema = await c.member('Database schema', c.bruno.id);
    const docs = await c.member('Docs', c.tess.id, [api.id]);
    const e2e = await c.member('End-to-end tests', c.tess.id, [api.id, schema.id]);

    const seen = statements();
    await submit(c.ctx, c.bruno.id, api.id, { summary: 'Done.', evidence: 'npm test' });
    await verdict(c.ctx, c.rita.id, api.id, { pass: true, comment: 'Good.' });
    await cancel(c.ctx, { personId: c.ceo.id }, schema.id, 'Not needed.');
    const one = (what: string, test: (sql: string) => boolean) => {
      const found = seen.filter(s => test(s.sql));
      expect(found, what).toHaveLength(1);
      return found[0]!;
    };
    const busy = one('who checks what now', s => /^select "panel" from "tasks"/.test(s));
    const waiting = one('what comes after the done task', s => /^select .* from "tasks" where .*"after".* for update$/.test(s));
    const left = one('what comes after the cancelled task', s => /^select .* from "tasks" where .*"after"/.test(s) && !s.endsWith('for update'));

    /* The whole history is 1960 tasks; what is open now is a few. */
    for (const s of [busy, waiting, left]) expect.soft(await tasksRead(client, s), s.sql).toBeLessThan(PER_TURN);

    /* Locked are the rows it gives back, the open tasks that come after it, and no other. */
    const locked = await client.transaction(async tx => {
      const given = await tx.query<{ id: string }>(waiting.sql, waiting.params);
      const held = await tx.query<{ id: string }>(`select id from tasks where xmax = (txid_current() % 4294967296)::text::xid order by number`);
      await tx.rollback();
      return { given: given.rows.map(r => r.id), held: held.rows.map(r => r.id) };
    });
    expect(locked.given).toEqual([docs.id, e2e.id]);
    expect(locked.held).toEqual([docs.id, e2e.id]);
  });
});

type PlanNode = { 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] };

/* The rows of tasks a statement reads, as Postgres counts them running it: what each scan of tasks gives on and what its
   filter drops. */
async function tasksRead(client: PGlite, s: { sql: string; params: unknown[] }): Promise<number> {
  const res = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`explain (analyze, format json) ${s.sql}`, s.params);
  const walk = (n: PlanNode): number =>
    (n['Relation Name'] === 'tasks' ? (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0) + (n['Rows Removed by Index Recheck'] ?? 0)) * n['Actual Loops'] : 0) +
    (n.Plans ?? []).reduce((sum, p) => sum + walk(p), 0);
  return walk(res.rows[0]!['QUERY PLAN'][0]!.Plan);
}
