import { and, count, desc, eq, isNotNull, lte, notInArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, people, subscriptions, tasks, turns, type TurnMessage } from '../src/db/schema.js';
import { CLOSED, type Tx } from '../src/modules/tasks/engine.js';
import { liveIn, newWords, TURN_MESSAGES, type By } from '../src/modules/tasks/turns.js';
import { setUpCompany, statements, testApp } from './helpers.js';

/* A company with a long history: TURNS turns, the last one open, and TASKS tasks spread over them. Each turn keeps KEPT of
   the people's messages to the orchestrator from its day, and one more message of that day no turn keeps. */
const TURNS = 50;
const TASKS = 2000;
const KEPT = 3;
const DAY = 86_400_000;

async function history() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const start = Date.now() - (TURNS + 2) * DAY;
  /* The orchestrator's runs that answer a message, by the message they answer. */
  const runs: string[] = [];
  const say = async (text: string, at: number, run = false) => {
    const [job] = run ? await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: text, timeoutMs: 60_000, status: 'done' }).returning() : [];
    if (job) runs.push(job.id);
    const [e] = await db.insert(agentEvents).values({ companyId, agentId: orchestrator!.id, jobId: job?.id ?? null, kind: 'message', data: { text }, personId: ceo!.id, createdAt: new Date(at) }).returning();
    return { id: e!.id, by: ceo!.name, text, at: e!.createdAt.toISOString() } satisfies TurnMessage;
  };
  for (let n = 1; n <= TURNS; n++) {
    const day = start + n * DAY;
    const kept: TurnMessage[] = [];
    for (let k = 0; k < KEPT; k++) kept.push(await say(`Turn ${n}, point ${k}.`, day + k * 60_000, k === KEPT - 1));
    await say(`Thanks for turn ${n - 1}.`, day + 3_600_000, n % 10 === 0);
    const open = n === TURNS;
    await db.insert(turns).values({ companyId, number: n, title: `Turn ${n}`, goal: '', status: open ? 'open' : 'closed', messages: kept, createdByAgentId: orchestrator!.id, openedAt: new Date(day), closedAt: open ? null : new Date(day + DAY / 2) });
  }
  const all = await db.select({ id: turns.id, number: turns.number }).from(turns).where(eq(turns.companyId, companyId));
  const each = TASKS / TURNS;
  await db.insert(tasks).values(
    Array.from({ length: TASKS }, (_, i) => {
      const n = Math.floor(i / each) + 1;
      /* The open turn's work: some of it done, the rest still at work. */
      const status = n < TURNS ? 'done' : i % 2 ? 'working' : 'done';
      const at = new Date(start + n * DAY);
      return { companyId, number: i + 1, turnId: all.find(t => t.number === n)!.id, departmentId: dev!.id, title: `Task ${i + 1}`, brief: '', body: '', status, updatedAt: at, closedAt: status === 'done' ? at : null } as const;
    }),
  );
  /* What people wrote since the open turn began, the last of it the message the orchestrator answers now. */
  const now = Date.now() - 60_000;
  for (let k = 0; k < 3; k++) await say(`New point ${k}.`, now + k * 1000, k === 2);
  const by = (jobId = runs.at(-1)!): By => ({ companyId, agentId: orchestrator!.id, jobId });
  const turnOf = (n: number) => all.find(t => t.number === n)!.id;
  return { app, db, companyId, runs, by, turnOf };
}

/* newWords as it read before: the messages every turn keeps, then the newest of the rest. */
async function everyTurnsWords(tx: Tx, by: By, words: number): Promise<TurnMessage[]> {
  const mine = and(eq(agentEvents.agentId, by.agentId), eq(agentEvents.kind, 'message'), isNotNull(agentEvents.personId));
  const [asked] = await tx.select({ seq: agentEvents.seq }).from(agentEvents).where(and(mine, eq(agentEvents.jobId, by.jobId))).orderBy(desc(agentEvents.seq)).limit(1);
  if (!asked) return [];
  const kept = (await tx.select({ messages: turns.messages }).from(turns).where(eq(turns.companyId, by.companyId))).flatMap(t => t.messages.flatMap(m => (m.id ? [m.id] : [])));
  const rows = await tx
    .select({ id: agentEvents.id, text: agentEvents.data, at: agentEvents.createdAt, by: people.name })
    .from(agentEvents)
    .innerJoin(people, eq(people.id, agentEvents.personId))
    .where(and(mine, lte(agentEvents.seq, asked.seq), kept.length ? notInArray(agentEvents.id, kept) : undefined))
    .orderBy(desc(agentEvents.seq))
    .limit(Math.min(Math.max(words, 1), TURN_MESSAGES));
  return rows
    .reverse()
    .map(r => ({ id: r.id, by: r.by, text: typeof (r.text as { text?: unknown }).text === 'string' ? (r.text as { text: string }).text : '', at: r.at.toISOString() }))
    .filter(m => m.text.trim());
}

/* liveIn as it read before: every open task of the turn, counted. */
const everyLiveTask = async (tx: Tx, turnId: string) => Number((await tx.select({ n: count() }).from(tasks).where(and(eq(tasks.turnId, turnId), notInArray(tasks.status, [...CLOSED]))))[0]?.n ?? 0) > 0;

type Plan = { 'Node Type': string; 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number; Plans?: Plan[] };
type Db = Awaited<ReturnType<typeof history>>['db'];

/* How many rows of a table the database read, and how many of them it kept, for the statements it ran, as EXPLAIN ANALYZE
   counts them on the same statements with the same values. */
async function rowsOf(db: Db, ran: { sql: string; params: unknown[] }[], table: string): Promise<{ read: number; kept: number }> {
  const client = (db as unknown as { $client: { query(sql: string, params: unknown[]): Promise<{ rows: { 'QUERY PLAN': { Plan: Plan }[] }[] }> } }).$client;
  let read = 0;
  let kept = 0;
  const walk = (p: Plan) => {
    if (p['Relation Name'] === table) {
      read += (p['Actual Rows'] + (p['Rows Removed by Filter'] ?? 0)) * p['Actual Loops'];
      kept += p['Actual Rows'] * p['Actual Loops'];
    }
    for (const c of p.Plans ?? []) walk(c);
  };
  for (const s of ran.filter(s => /^select/i.test(s.sql) && s.sql.includes(`from "${table}"`))) {
    const res = await client.query(`explain (analyze, format json) ${s.sql}`, s.params);
    walk(res.rows[0]!['QUERY PLAN'][0]!.Plan);
  }
  return { read, kept };
}

describe('the people\'s words a turn keeps, over a long history', () => {
  it('are the same as before for every number of words, also for a run that answered a message long ago', async () => {
    const h = await history();
    for (const jobId of h.runs)
      for (let words = 1; words <= TURN_MESSAGES + 1; words++) {
        const [before, now] = await h.db.transaction(async tx => [await everyTurnsWords(tx, h.by(jobId), words), await newWords(tx, h.by(jobId), words)]);
        expect(now, `run ${h.runs.indexOf(jobId)}, ${words} words`).toEqual(before);
      }
  });

  it('are read from the newest messages and the turns that may keep them, not from every turn', async () => {
    const h = await history();
    const ran = statements();
    /* Before, it took the messages of every turn. */
    const before = await h.db.transaction(tx => everyTurnsWords(tx, h.by(), TURN_MESSAGES));
    expect((await rowsOf(h.db, ran.splice(0), 'turns')).kept).toBe(TURNS);
    expect(await h.db.transaction(tx => newWords(tx, h.by(), TURN_MESSAGES))).toEqual(before);
    expect(before.map(m => m.text)).toEqual(['Thanks for turn 47.', 'Thanks for turn 48.', 'Thanks for turn 49.', 'New point 0.', 'New point 1.', 'New point 2.']);
    /* Now the open turn and the few that closed about the time of the newest messages, and those messages only. */
    expect((await rowsOf(h.db, ran, 'turns')).kept).toBeLessThanOrEqual(5);
    expect((await rowsOf(h.db, ran, 'agent_events')).read).toBeLessThanOrEqual(2 * TURN_MESSAGES + 2);
  });
});

describe('whether a turn has open tasks, over a long history', () => {
  it('is the same as before for every turn', async () => {
    const h = await history();
    for (let n = 1; n <= TURNS; n++) {
      const [before, now] = await h.db.transaction(async tx => [await everyLiveTask(tx, h.turnOf(n)), await liveIn(tx, h.companyId, h.turnOf(n))]);
      expect(now, `turn ${n}`).toBe(before);
    }
  });

  it('stops at the first open task it finds rather than counting them all', async () => {
    const h = await history();
    const ran = statements();
    /* Before, every task was read and each open one of the turn counted. */
    await h.db.transaction(tx => everyLiveTask(tx, h.turnOf(TURNS)));
    expect(await rowsOf(h.db, ran.splice(0), 'tasks')).toEqual({ read: TASKS, kept: TASKS / TURNS / 2 });
    expect(await h.db.transaction(tx => liveIn(tx, h.companyId, h.turnOf(TURNS)))).toBe(true);
    expect((await rowsOf(h.db, ran, 'tasks')).kept).toBe(1);
  });

  it("reads only the turn's own tasks once they have an index by turn, which a migration of its own adds", async () => {
    const h = await history();
    /* In this test's database only: the index that migration is to add. */
    await (h.db as unknown as { $client: { exec(sql: string): Promise<unknown> } }).$client.exec('create index tasks_turn_id on tasks (turn_id); analyze tasks;');
    const ran = statements();
    /* A closed turn: all its tasks, and no other. The open one: up to its first open task. */
    expect(await h.db.transaction(tx => liveIn(tx, h.companyId, h.turnOf(1)))).toBe(false);
    expect((await rowsOf(h.db, ran.splice(0), 'tasks')).read).toBe(TASKS / TURNS);
    expect(await h.db.transaction(tx => liveIn(tx, h.companyId, h.turnOf(TURNS)))).toBe(true);
    expect((await rowsOf(h.db, ran, 'tasks')).read).toBeLessThanOrEqual(2);
  });
});
