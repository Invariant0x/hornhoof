import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, people, subscriptions, tasks, turns, type TurnMessage } from '../src/db/schema.js';
import { CLOSED, type Tx } from '../src/modules/tasks/engine.js';
import { liveIn, newWords, TURN_MESSAGES, type By } from '../src/modules/tasks/turns.js';
import { setUpCompany, statements, testApp } from './helpers.js';
import { readIn, type PlanNode } from './rows-read.js';

/* A company with a long history: TURNS turns, the last one open, and TASKS tasks spread over them. Each turn keeps KEPT of
   the people's messages to the orchestrator from its day, and one more message of that day no turn keeps. */
const TURNS = 50;
const TASKS = 2000;
const KEPT = 3;
const DAY = 86_400_000;
const WORD_COUNTS = [[-1, 1], [0, 1], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 6]] as const;

type Word = { text: string; at: number; run?: boolean };
type Speaker = { companyId: string; agentId: string; subscriptionId: string; personId: string; name: string };

function wordRows(by: Speaker, word: Word) {
  const jobId = word.run ? randomUUID() : null;
  const event = { id: randomUUID(), companyId: by.companyId, agentId: by.agentId, jobId, kind: 'message' as const, data: { text: word.text }, personId: by.personId, createdAt: new Date(word.at) };
  const job = jobId ? { id: jobId, companyId: by.companyId, subscriptionId: by.subscriptionId, agentId: by.agentId, kind: 'conversation' as const, prompt: word.text, timeoutMs: 60_000, status: 'done' as const } : null;
  const message = { id: event.id, by: by.name, text: word.text, at: event.createdAt.toISOString() } satisfies TurnMessage;
  return { job, event, message };
}

async function conversation() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  /* The orchestrator's runs that answer a message, by the message they answer. */
  const runs: string[] = [];
  const speaker = { companyId, agentId: orchestrator!.id, subscriptionId: sub!.id, personId: ceo!.id, name: ceo!.name };
  const sayMany = async (words: Word[]) => {
    const rows = words.map(w => wordRows(speaker, w));
    const answered = rows.flatMap(r => r.job ? [r.job] : []);
    if (answered.length) await db.insert(jobs).values(answered);
    await db.insert(agentEvents).values(rows.map(r => r.event));
    runs.push(...answered.map(j => j.id));
    return rows.map(r => r.message);
  };
  const say = async (text: string, at: number, run = false) => (await sayMany([{ text, at, run }]))[0]!;
  const by = (jobId = runs.at(-1)!): By => ({ companyId, agentId: orchestrator!.id, jobId });
  return { app, db, companyId, agentId: orchestrator!.id, ceo: ceo!, runs, say, sayMany, by };
}

type Conversation = Awaited<ReturnType<typeof conversation>>;

function historicalWords(start: number, now: number): Word[] {
  const words: Word[] = [];
  for (let n = 1; n <= TURNS; n++) {
    const day = start + n * DAY;
    for (let k = 0; k < KEPT; k++) words.push({ text: `Turn ${n}, point ${k}.`, at: day + k * 60_000, run: k === KEPT - 1 });
    words.push({ text: `Thanks for turn ${n - 1}.`, at: day + 3_600_000, run: n % 10 === 0 });
  }
  for (let k = 0; k < 3; k++) words.push({ text: `New point ${k}.`, at: now + k * 1000, run: k === 2 });
  return words;
}

function historicalTurn(c: Conversation, n: number, day: number, messages: TurnMessage[]): typeof turns.$inferInsert {
  const open = n === TURNS;
  return { companyId: c.companyId, number: n, title: `Turn ${n}`, goal: '', status: open ? 'open' : 'closed', messages, createdByAgentId: c.agentId, openedAt: new Date(day), closedAt: open ? null : new Date(day + DAY / 2) };
}

async function historicalTasks(c: Conversation, turnIds: Map<number, string>, start: number) {
  const [dev] = await c.db.insert(departments).values({ companyId: c.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const each = TASKS / TURNS;
  await c.db.insert(tasks).values(
    Array.from({ length: TASKS }, (_, i) => {
      const n = Math.floor(i / each) + 1;
      /* The open turn's work: some of it done, the rest still at work. */
      const status = n < TURNS ? 'done' : i % 2 ? 'working' : 'done';
      const at = new Date(start + n * DAY);
      return { companyId: c.companyId, number: i + 1, turnId: turnIds.get(n)!, departmentId: dev!.id, title: `Task ${i + 1}`, brief: '', body: '', status, updatedAt: at, closedAt: status === 'done' ? at : null } as const;
    }),
  );
}

async function history(given?: Awaited<ReturnType<typeof conversation>>) {
  const c = given ?? (await conversation());
  const start = Date.now() - (TURNS + 2) * DAY;
  /* What people wrote since the open turn began, the last of it the message the orchestrator answers now. */
  const messages = await c.sayMany(historicalWords(start, Date.now() - 60_000));
  const all = await c.db.insert(turns).values(Array.from({ length: TURNS }, (_, i) => historicalTurn(c, i + 1, start + (i + 1) * DAY, messages.slice(i * (KEPT + 1), i * (KEPT + 1) + KEPT)))).returning({ id: turns.id, number: turns.number });
  const turnIds = new Map(all.map(t => [t.number, t.id]));
  await historicalTasks(c, turnIds, start);
  const turnOf = (n: number) => turnIds.get(n)!;
  return { ...c, turnOf };
}

/* One accounted message per closed turn. Optional gaps leave rare messages unaccounted for, and skew moves the
   database's message timestamps ahead of the server's close timestamps. Bulk inserts keep the 10,000-turn probe cheap. */
async function accountedHistory(total: number, gaps: number[] = [], skew = 0) {
  const c = await conversation();
  const start = Date.now() - (total + 2) * DAY;
  await c.db.execute(sql`
    with messages as (
      insert into agent_events (company_id, agent_id, kind, data, person_id, created_at)
      select ${c.companyId}::uuid, ${c.agentId}::uuid, 'message', jsonb_build_object('text', 'Point ' || n),
        ${c.ceo.id}::uuid, to_timestamp((${start}::double precision + n * ${DAY}::double precision + ${skew}::double precision) / 1000)
      from generate_series(1, ${total}::int) n order by n
      returning id, data, created_at
    )
    insert into turns (company_id, number, goal, status, messages, closed_at)
    select ${c.companyId}::uuid, substring(data->>'text' from 7)::int, '', 'closed',
      case when substring(data->>'text' from 7)::int = any(${`{${gaps.join(',')}}`}::int[]) then '[]'::jsonb
      else jsonb_build_array(jsonb_build_object('id', id, 'by', ${c.ceo.name}::text, 'text', data->>'text', 'at', created_at)) end,
      created_at - ${skew}::double precision * interval '1 millisecond' + interval '12 hours'
    from messages`);
  const last = await c.say('Last point', start + (total + 1) * DAY + skew, true);
  await c.db.insert(turns).values({ companyId: c.companyId, number: total + 1, goal: '', status: 'closed', messages: [last], closedAt: new Date(start + (total + 1) * DAY + DAY / 2) });
  await c.db.execute(sql`analyze turns`);
  await c.db.execute(sql`analyze agent_events`);
  return c;
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

type Db = Awaited<ReturnType<typeof history>>['db'];
type Statement = { sql: string; params: unknown[] };

async function explain(db: Db, s: Statement) {
  const client = (db as unknown as { $client: PGlite }).$client;
  const res = await client.query<{ 'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[] }>(`explain (analyze, format json) ${s.sql}`, s.params);
  return res.rows[0]!['QUERY PLAN'][0]!;
}

/* How many rows of a table the database read, and how many of them it kept, for the statements it ran, as EXPLAIN ANALYZE
   counts them on the same statements with the same values. */
async function rowsOf(db: Db, ran: Statement[], table: string): Promise<{ read: number; kept: number }> {
  let read = 0;
  let kept = 0;
  const keptIn = (p: PlanNode): number => (p['Relation Name'] === table ? (p['Actual Rows'] ?? 0) * (p['Actual Loops'] ?? 1) : 0) + (p.Plans ?? []).reduce((n, child) => n + keptIn(child), 0);
  for (const s of ran.filter(s => /^select/i.test(s.sql) && s.sql.includes(`from "${table}"`))) {
    const { Plan: plan } = await explain(db, s);
    read += readIn(plan, table);
    kept += keptIn(plan);
  }
  return { read, kept };
}

describe('the people\'s words a turn keeps, over a long history', () => {
  it.each([50, 100, 500])('reads %i accounted turns at most once when all messages are already kept', async total => {
    const h = await accountedHistory(total);
    expect(await h.db.transaction(tx => everyTurnsWords(tx, h.by(), TURN_MESSAGES))).toEqual([]);
    const ran = statements();
    expect(await h.db.transaction(tx => newWords(tx, h.by(), TURN_MESSAGES))).toEqual([]);
    const measured = await rowsOf(h.db, ran, 'turns');
    console.info({ total, gaps: false, ...measured });
    expect(measured.read).toBeLessThanOrEqual(total + 1);
  });

  it.each([50, 100, 500])('reads %i accounted turns at most once when unaccounted messages are rare', async total => {
    const h = await accountedHistory(total, [10, 30]);
    const before = await h.db.transaction(tx => everyTurnsWords(tx, h.by(), TURN_MESSAGES));
    expect(before.map(m => m.text)).toEqual(['Point 10', 'Point 30']);
    const ran = statements();
    expect(await h.db.transaction(tx => newWords(tx, h.by(), TURN_MESSAGES))).toEqual(before);
    const measured = await rowsOf(h.db, ran, 'turns');
    console.info({ total, gaps: true, ...measured });
    expect(measured.read).toBeLessThanOrEqual(total + 1);
  });

  it.each([-2 * DAY, 2 * DAY])('does not repeat kept messages when the database clock differs by %i ms', async skew => {
    const h = await accountedHistory(12, [], skew);
    expect(await h.db.transaction(tx => everyTurnsWords(tx, h.by(), 1))).toEqual([]);
    expect(await h.db.transaction(tx => newWords(tx, h.by(), 1))).toEqual([]);
  });

  it('ignores legacy words without an event id when finding unaccounted words', async () => {
    const h = await conversation();
    const message = await h.say('Fresh point', Date.now(), true);
    const legacy = { by: message.by, text: message.text, at: message.at };
    await h.db.insert(turns).values({ companyId: h.companyId, number: 1, goal: '', messages: [legacy] });
    expect(await h.db.transaction(tx => newWords(tx, h.by(), 1))).toEqual([message]);
  });

  it('reads 10,000 turns once, including when only one fresh message is needed', async () => {
    const h = await accountedHistory(9999);
    const ran = statements();
    expect(await h.db.transaction(async tx => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, h.companyId)).for('update');
      return newWords(tx, h.by(), TURN_MESSAGES);
    })).toEqual([]);
    const measured = await explain(h.db, ran.find(s => s.sql.includes('from "turns"'))!);
    expect(readIn(measured.Plan, 'turns')).toBe(10000);
    console.info('10,000 turns, all accounted:', JSON.stringify(measured));
    ran.splice(0);
    const message = await h.say('Fresh point', Date.now(), true);
    expect(await h.db.transaction(tx => newWords(tx, h.by(), 1))).toEqual([message]);
    expect((await rowsOf(h.db, ran, 'turns')).read).toBe(10000);
    expect((await rowsOf(h.db, ran, 'agent_events')).read).toBeLessThanOrEqual(2);
  });

  it('are the same as before for every number of words, also for a run that answered a message long ago', async () => {
    const c = await conversation();
    const ran = statements();
    const h = await history(c);
    const fixtureQueries = ran.splice(0).length;
    /* Bound the fixture and oracle work without relying on the machine's wall-clock speed. */
    expect(fixtureQueries, 'history setup query budget').toBeLessThanOrEqual(32);
    let cases = 0;
    await h.db.transaction(async tx => {
      for (const [run, jobId] of h.runs.entries()) {
        /* Every fixture message is nonblank: shorter requests end with the same newest words. Calculate the old
           answer once per run, then keep every word-count comparison against the real newWords query. */
        const before = await everyTurnsWords(tx, h.by(jobId), TURN_MESSAGES);
        for (const [words, count] of WORD_COUNTS) {
          const now = await newWords(tx, h.by(jobId), words);
          expect(now, `run ${run}, ${words} words`).toEqual(before.slice(-count));
          cases++;
        }
      }
    });
    expect(cases).toBe(504);
    expect(ran.length, 'comparison query budget').toBeLessThanOrEqual(1500);
    console.info('Turn word comparisons:', { fixtureQueries, comparisonQueries: ran.length, cases });
  });

  it('reads turn membership once inside the database and only the newest events it needs', async () => {
    const h = await history();
    const ran = statements();
    /* Before, it took the messages of every turn. */
    const before = await h.db.transaction(tx => everyTurnsWords(tx, h.by(), TURN_MESSAGES));
    expect((await rowsOf(h.db, ran.splice(0), 'turns')).kept).toBe(TURNS);
    expect(await h.db.transaction(tx => newWords(tx, h.by(), TURN_MESSAGES))).toEqual(before);
    expect(before.map(m => m.text)).toEqual(['Thanks for turn 47.', 'Thanks for turn 48.', 'Thanks for turn 49.', 'New point 0.', 'New point 1.', 'New point 2.']);
    /* With no membership index, exact deduplication needs one pass over turns, without sending their words back. */
    expect((await rowsOf(h.db, ran, 'turns')).read).toBe(TURNS);
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
    /* Counting still reads every task of the turn through its index. */
    await h.db.transaction(tx => everyLiveTask(tx, h.turnOf(TURNS)));
    expect(await rowsOf(h.db, ran.splice(0), 'tasks')).toEqual({ read: TASKS / TURNS, kept: TASKS / TURNS / 2 });
    expect(await h.db.transaction(tx => liveIn(tx, h.companyId, h.turnOf(TURNS)))).toBe(true);
    expect((await rowsOf(h.db, ran, 'tasks')).kept).toBe(1);
  });

  it("reads only the turn's own tasks through the migrated turn index", async () => {
    const h = await history();
    await h.db.execute(sql`analyze tasks`);
    const ran = statements();
    /* A closed turn: all its tasks, and no other. The open one: up to its first open task. */
    expect(await h.db.transaction(tx => liveIn(tx, h.companyId, h.turnOf(1)))).toBe(false);
    expect((await rowsOf(h.db, ran.splice(0), 'tasks')).read).toBe(TASKS / TURNS);
    expect(await h.db.transaction(tx => liveIn(tx, h.companyId, h.turnOf(TURNS)))).toBe(true);
    expect((await rowsOf(h.db, ran, 'tasks')).read).toBeLessThanOrEqual(2);
  });
});
