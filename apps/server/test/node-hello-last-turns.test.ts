import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { agents, jobs, machines, nodes, subscriptions } from '../src/db/schema.js';
import { releaseProgramsOfLeftPlans } from '../src/modules/agents/left-programs.js';
import { jobsOf } from '../src/modules/nodes/jobs.js';
import { ownDatabases, statements } from './helpers-db.js';
import { operatorCompany } from './program-operator-company.js';

ownDatabases();

/* A node that comes back says hello, and Hornhoof asks the jobs table for each employee's last turn there. That read ran on
   every hello of every node, and with no index on the node it read every job the node ever had (#2022). */

type Plan = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: Plan[] };

const walk = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(walk)];

async function planOf(client: PGlite, statement: { sql: string; params: unknown[] }): Promise<Plan[]> {
  const { rows } = await client.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params);
  return walk(rows[0]!['QUERY PLAN'][0]!.Plan);
}

async function setUp() {
  const c = await operatorCompany();
  const client = (c.db as unknown as { $client: PGlite }).$client;
  const [other] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'codex', kind: 'personal', label: 'Other plan', ownerPersonId: c.sub.ownerPersonId, status: 'ready' }).returning();
  const nodeOn = async (plan: string) => {
    const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: randomUUID(), hostname: 'Elsewhere' }).returning();
    const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: plan, keyHash: randomUUID(), status: 'ready', version: '0.6.1' }).returning();
    return node!.id;
  };
  return { ...c, client, other: other!, nodeOn };
}

const turn = (c: Awaited<ReturnType<typeof setUp>>, agentId: string, nodeId: string, minutesAgo: number, more: Partial<typeof jobs.$inferInsert> = {}) => ({
  companyId: c.companyId, agentId, subscriptionId: c.sub.id, nodeId, kind: 'conversation' as const, prompt: 'Words.', timeoutMs: 1000, status: 'done' as const,
  createdAt: new Date(Date.UTC(2026, 10, 20, 12) - minutesAgo * 60_000), startedAt: new Date(Date.UTC(2026, 10, 20, 12) - minutesAgo * 60_000 + 1000), ...more,
});

const releases = (c: Awaited<ReturnType<typeof setUp>>) =>
  c.sent.mock.calls.flatMap(([, message]) => (message.type === 'agent.release' ? [{ agentKey: message.agentKey, jobId: message.jobId }] : []));

describe('the last turns of a node that says hello', () => {
  it('are asked by the index of the node and the employee, with one probe for each employee and no pass over the node\'s jobs', async () => {
    const c = await setUp();
    const here = c.identity.nodeId;
    const elsewhere = await c.nodeOn(c.sub.id);
    const crew = await c.db.insert(agents).values(Array.from({ length: 12 }, (_, i) => ({ companyId: c.companyId, name: `Hand ${i}`, kind: 'worker' as const, roleKey: 'DEV-BE', departmentId: c.agent.departmentId, model: '', subscriptionId: c.sub.id }))).returning();
    const who = [c.agent.id, c.head.id, ...crew.map(a => a.id)];
    /* Six thousand turns of the fourteen employees, spread over this node and the other, as a company a few days old has. */
    await c.client.query(
      `INSERT INTO jobs (company_id, subscription_id, agent_id, prompt, status, kind, node_id, timeout_ms, created_at, started_at, finished_at)
       SELECT $1, $2, ($3::uuid[])[1 + i % 14], 'Words.', 'done', 'conversation', CASE WHEN i % 5 = 0 THEN $4::uuid ELSE $5::uuid END, 1000,
              timestamp '2026-10-01' + i * interval '2 minutes', timestamp '2026-10-01' + i * interval '2 minutes', timestamp '2026-10-01' + i * interval '2 minutes' + interval '30 seconds'
       FROM generate_series(1, 6000) i`,
      [c.companyId, c.sub.id, who, here, elsewhere],
    );
    await c.client.exec('ANALYZE jobs');
    const seen = statements();
    await releaseProgramsOfLeftPlans(c.ctx, c.identity, jobsOf(c.identity, c.ctx));
    const asked = seen.filter(q => /from "(jobs|agents)"/.test(q.sql));
    expect(asked).toHaveLength(1);
    const nodesOfPlan = await planOf(c.client, asked[0]!);
    const reads = nodesOfPlan.filter(n => n['Relation Name'] === 'jobs');
    expect(reads.map(n => n['Node Type'])).not.toContain('Seq Scan');
    expect(reads.flatMap(n => (n['Index Name'] ? [n['Index Name']] : []))).toEqual(['jobs_node_agent_conversation']);
  });

  it('read the columns they use and none of the turn\'s words, which fill a turn with thousands of characters', async () => {
    const c = await setUp();
    const seen = statements();
    await releaseProgramsOfLeftPlans(c.ctx, c.identity, jobsOf(c.identity, c.ctx));
    const asked = seen.find(q => /from "(jobs|agents)"/.test(q.sql))!;
    const columns = asked.sql.slice(0, asked.sql.search(/ from /i));
    for (const heavy of ['prompt', 'requested_prompt', 'result', 'tail', 'failure', 'interruption']) expect(columns).not.toContain(`"${heavy}"`);
  });

  it('tell the node to release the program of each employee whose last turn there was on a plan the employee has left, and no other', async () => {
    const c = await setUp();
    const here = c.identity.nodeId;
    const elsewhere = await c.nodeOn(c.other.id);
    const hire = async (name: string, plan: string | null, more: Partial<typeof agents.$inferInsert> = {}) =>
      (await c.db.insert(agents).values({ companyId: c.companyId, name, kind: 'worker', roleKey: 'DEV-BE', departmentId: c.agent.departmentId, model: '', subscriptionId: plan, ...more }).returning())[0]!;
    const stayed = await hire('Stayed', c.sub.id);
    const moved = await hire('Moved', c.other.id);
    const unplaced = await hire('Unplaced', null);
    const back = await hire('Back again', c.sub.id);
    const removed = await hire('Removed', c.other.id, { removedAt: new Date('2026-11-01') });
    const never = await hire('Never here', c.other.id);
    const failedOnly = await hire('Failed before it left', c.other.id);
    const queued = await hire('Queued here', c.other.id);
    const rows = await c.db.insert(jobs).values([
      turn(c, stayed.id, here, 50),
      turn(c, moved.id, here, 60), turn(c, moved.id, here, 70, { subscriptionId: c.sub.id }),
      turn(c, unplaced.id, here, 80),
      /* Back on the plan: the turn it ran here last was on the plan it has, though an older one was on another. */
      turn(c, back.id, here, 90, { subscriptionId: c.other.id }), turn(c, back.id, here, 85),
      turn(c, removed.id, here, 95),
      /* Its newest turns ran on the other node, a test, or a turn that never reached this one: none of them is its last turn here. */
      turn(c, never.id, elsewhere, 40),
      turn(c, failedOnly.id, here, 100, { subscriptionId: c.sub.id }), turn(c, failedOnly.id, here, 99, { status: 'failed', startedAt: null }),
      turn(c, moved.id, elsewhere, 10, { subscriptionId: c.other.id }), turn(c, moved.id, here, 5, { kind: 'test' as const }),
      turn(c, queued.id, here, 20, { subscriptionId: c.sub.id }), turn(c, queued.id, here, 2, { status: 'queued', startedAt: null }),
    ]).returning();
    const idOf = (agentId: string, minutesAgo: number) => {
      const at = Date.UTC(2026, 10, 20, 12) - minutesAgo * 60_000;
      return rows.find(r => r.agentId === agentId && r.createdAt.getTime() === at)!.id;
    };
    await releaseProgramsOfLeftPlans(c.ctx, c.identity, jobsOf(c.identity, c.ctx));
    expect(releases(c).sort((a, b) => a.agentKey.localeCompare(b.agentKey))).toEqual([
      { agentKey: moved.id, jobId: idOf(moved.id, 60) },
      { agentKey: unplaced.id, jobId: idOf(unplaced.id, 80) },
      { agentKey: failedOnly.id, jobId: idOf(failedOnly.id, 100) },
      { agentKey: queued.id, jobId: idOf(queued.id, 2) },
    ].sort((a, b) => a.agentKey.localeCompare(b.agentKey)));
  });

  it('are asked of the jobs of a built-in machine by its own key plans, as before', async () => {
    const c = await setUp();
    const seen = statements();
    const builtin = { kind: 'builtin' as const, machine: 'ab'.repeat(16) };
    await releaseProgramsOfLeftPlans(c.ctx, builtin, jobsOf(builtin, c.ctx));
    expect(seen.filter(q => /from "jobs"/.test(q.sql))).toHaveLength(1);
    expect(releases(c)).toEqual([]);
  });
});
