import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agentEvents, agents, companies, people, subscriptions } from '../src/db/schema.js';
import { historyQuery } from '../src/modules/tasks/tree-history.js';
import { createTestDb } from './helpers.js';

it('reads a turn history without scanning thirty thousand unrelated event bodies', async () => {
  const db = await createTestDb();
  const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const companyId = company!.id;
  const [owner] = await db.insert(people).values({ companyId, name: 'Ivan', email: 'ivan@acme.example', status: 'active', scopeKind: 'company' }).returning();
  const [sub] = await db.insert(subscriptions).values({ companyId, provider: 'anthropic_api', kind: 'api_key', label: 'Plan', ownerPersonId: owner!.id, status: 'ready' }).returning();
  const [agent] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', model: '', subscriptionId: sub!.id }).returning();
  const inserted = await db.execute<{ id: string }>(sql`insert into jobs (company_id, subscription_id, agent_id, kind, prompt, timeout_ms)
    select ${companyId}, ${sub!.id}, ${agent!.id}, 'conversation', 'Work ' || n, 60000 from generate_series(1,857) n returning id`);
  const ids = inserted.rows.map(r => r.id);
  await db.execute(sql`with numbered as (select id, row_number() over (order by id) as n from jobs)
    insert into agent_events (company_id, agent_id, job_id, kind, data)
    select ${companyId}, ${agent!.id}, j.id, 'text', jsonb_build_object('text', repeat('step ',120))
    from generate_series(1,30161) as steps(step) join numbered j on j.n = 1 + steps.step % 857`);
  await db.insert(agentEvents).values([
    { companyId, agentId: agent!.id, jobId: ids[0]!, kind: 'program', data: { program: { state: 'thinking', since: 1, tool: null }, alarm: null } },
    { companyId, agentId: agent!.id, kind: 'message', data: { silentJob: ids[1]!, silentReason: 'node_silent', text: 'Last change: 2026-11-03 06:11 UTC (2026-11-03T06:11:06.000Z). Reason: node_silent.' } },
  ]);
  await db.execute(sql`analyze agent_events`);
  const plan = await db.execute(sql`explain (analyze, buffers) ${historyQuery(db, ids)}`);
  const text = plan.rows.map(r => r['QUERY PLAN']).join('\n');
  console.log(text);
  expect(text).not.toContain('Seq Scan on agent_events');
  expect((await db.execute(historyQuery(db, ids))).rows).toHaveLength(2);
});
