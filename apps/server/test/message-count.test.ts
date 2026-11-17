import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { MIGRATIONS } from '../src/db/client.js';
import { agentEvents, companies, jobs } from '../src/db/schema.js';
import { TURN_NUDGES } from '../src/modules/tools/watch.js';
import { failureCompany } from './failure-company.js';
import { ownDatabases, statements } from './helpers-db.js';
import { listen, mcp } from './helpers.js';
import { freshInstall, migrate, olderInstall, prepareInstalls } from './migrations-fixture.js';

ownDatabases();
await prepareInstalls(['0136_outbound_contact_log']);

const NOW = Date.parse('2030-01-01T12:00:00Z');
const CREATED = new Date(NOW - 60_000);
const STARTED = new Date(NOW - 30_000);
const INDEX = 'agent_events_message_sender_window';

async function messaging(startedAt: Date | null = STARTED) {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  onTestFinished(() => { vi.useRealTimers(); });
  const c = await failureCompany();
  await listen(c.app);
  const token = 'message-count-recorded-turn';
  const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.head.id, subscriptionId: c.sub.id,
    kind: 'conversation', prompt: 'Work.', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token), createdAt: CREATED, startedAt }).returning();
  const client = await mcp(c.app, token);
  const send = () => client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, text: 'Here is the result.' } });
  const rows = (n: number, createdAt: Date, by = c.head.id) => Array.from({ length: n }, () => ({ companyId: c.companyId,
    agentId: c.agent.id, kind: 'message' as const, createdAt, data: { by, from: 'agent', text: 'Recorded message.' } }));
  return { ...c, job: job!, send, rows };
}

type Plan = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: Plan[] };
const allPlans = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(allPlans)];

function counter(seen: ReturnType<typeof statements>) {
  const query = seen.find(q => q.sql.includes('count(*)') && q.sql.includes('"agent_events"') && q.sql.includes("->>'by'"));
  expect(query, 'The message handler must recover its persisted send count.').toBeDefined();
  return query!;
}

describe('the persisted message quota', () => {
  it('uses the sender and time index, stops at the quota and refuses the next message', async () => {
    const c = await messaging();
    /* Scenery goes past the change journal: the query needs event rows, not thirty thousand changes to replicate. */
    await c.db.transaction(async tx => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`insert into agent_events (company_id, agent_id, kind, data, created_at)
        select ${c.companyId}, ${c.agent.id}, case when n % 2 = 0 then 'message' else 'text' end,
          jsonb_build_object('by', case when n % 3 = 0 then ${c.head.id} else ${c.watcher.id} end, 'text', repeat('old ', 40)),
          ${new Date(CREATED.getTime() - 86_400_000)}::timestamptz from generate_series(1, 30000) n`);
    });
    await c.db.insert(agentEvents).values(c.rows(TURN_NUDGES + 1, STARTED));
    await c.db.execute(sql`analyze agent_events`);
    const seen = statements();
    expect((await c.send()).isError).toBe(true);
    const query = counter(seen);
    const explained = await c.db.$client.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(`explain (format json) ${query.sql}`, query.params);
    const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
    console.info('Message quota EXPLAIN:', JSON.stringify(plan, null, 2));
    const nodes = allPlans(plan);
    expect(nodes.map(node => node['Index Name'])).toContain(INDEX);
    expect(nodes.filter(node => node['Relation Name'] === 'agent_events' && node['Node Type'] === 'Seq Scan')).toEqual([]);
    expect(nodes.map(node => node['Node Type'])).toContain('Limit');
    const count = await c.db.$client.query<Record<string, number | string>>(query.sql, query.params);
    expect(Object.values(count.rows[0]!).map(Number)).toEqual([TURN_NUDGES]);
  });

  it('counts the inclusive turn window, excluding older messages, other senders, companies and kinds', async () => {
    const c = await messaging();
    const [foreign] = await c.db.insert(companies).values({ name: 'Elsewhere', singleton: false }).returning();
    await c.db.insert(agentEvents).values([
      ...c.rows(TURN_NUDGES - 1, STARTED),
      ...c.rows(TURN_NUDGES + 1, new Date(STARTED.getTime() - 1)),
      ...c.rows(TURN_NUDGES + 1, STARTED, c.watcher.id),
      ...c.rows(TURN_NUDGES + 1, STARTED).map(row => ({ ...row, companyId: foreign!.id })),
      ...c.rows(TURN_NUDGES + 1, STARTED).map(row => ({ ...row, kind: 'text' as const })),
      { ...c.rows(1, STARTED)[0]!, data: { text: 'Outgoing mirror without a sender key.' } },
    ]);
    expect((await c.send()).isError).toBeFalsy();
    expect((await c.send()).isError).toBe(true);
    const kept = await c.db.select().from(agentEvents).where(and(eq(agentEvents.companyId, c.companyId),
      eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'by' = ${c.head.id}`, sql`${agentEvents.createdAt} >= ${STARTED}`));
    expect(kept).toHaveLength(TURN_NUDGES);
  });

  it('uses creation time before a turn starts and saturates its recovered count at the same quota', async () => {
    const c = await messaging(null);
    await c.db.insert(agentEvents).values([
      ...c.rows(TURN_NUDGES - 1, CREATED),
      ...c.rows(TURN_NUDGES + 1, new Date(CREATED.getTime() - 1)),
    ]);
    const seen = statements();
    expect((await c.send()).isError).toBeFalsy();
    expect((await c.send()).isError).toBe(true);
    await c.db.insert(agentEvents).values(c.rows(1, CREATED));
    const query = counter(seen);
    const count = await c.db.$client.query<Record<string, number | string>>(query.sql, query.params);
    expect(Object.values(count.rows[0]!).map(Number)).toEqual([TURN_NUDGES]);
  });
});

describe('the message sender index migration', () => {
  it('is present on a fresh installation', async () => {
    const client = await freshInstall();
    expect((await client.query('select indexname from pg_indexes where tablename = $1 and indexname = $2', ['agent_events', INDEX])).rows)
      .toEqual([{ indexname: INDEX }]);
  });

  it('upgrades 0136 twice without changing its stored messages', async () => {
    const client = await olderInstall('0136_outbound_contact_log');
    const db = drizzle(client);
    await db.execute(sql`insert into companies (id, name) values ('00000000-0000-4000-8000-000000000001', 'Acme')`);
    await db.execute(sql`insert into agents (id, company_id, kind, name, model)
      values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'worker', 'Bruno', '')`);
    await db.execute(sql`insert into agent_events (company_id, agent_id, kind, data, created_at)
      values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'message', '{"by":"recorded sender","text":"Keep this."}', ${CREATED})`);
    const before = await client.query('select to_jsonb(e) as data from agent_events e order by seq');
    expect((await client.query('select indexname from pg_indexes where indexname = $1', [INDEX])).rows).toEqual([]);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await client.query('select to_jsonb(e) as data from agent_events e order by seq')).rows).toEqual(before.rows);
    expect((await client.query('select indexname from pg_indexes where indexname = $1', [INDEX])).rows).toEqual([{ indexname: INDEX }]);
  });
});
