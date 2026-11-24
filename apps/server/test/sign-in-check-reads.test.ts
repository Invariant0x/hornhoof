import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, jobs, machines, nodes, subscriptions } from '../src/db/schema.js';
import { insertTurn } from '../src/modules/conversation/queue.js';
import { checkSignInFailures } from '../src/modules/tasks/failures.js';
import { failureCompany } from './failure-company.js';
import { statements } from './helpers-db.js';

/* Every minute Hornhoof looks for a plan whose sign-in has not healed while turns wait. That look read, with every column,
   each job that ever failed for want of a sign-in on a node that now needs one, by a pass over all jobs, since nothing
   indexed the error (#2022). */

const MIN = 60_000;
type Plan = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: Plan[] };
const walk = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(walk)];

async function setUp() {
  const c = await failureCompany();
  await c.db.update(subscriptions).set({ kind: 'personal', provider: 'codex', status: 'needs_login' }).where(eq(subscriptions.id, c.sub.id));
  const nodeOf = async (key: string, status: 'needs_login' | 'ready', plan = c.sub.id) => {
    const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: key, hostname: key }).returning();
    const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: plan, status, version: '0.5.0', keyHash: key }).returning();
    return node!;
  };
  const [opsPlan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, ownerPersonId: c.sub.ownerPersonId, provider: 'anthropic_api', kind: 'api_key', label: 'Operations', status: 'ready' }).returning();
  await c.db.update(agents).set({ subscriptionId: opsPlan!.id }).where(eq(agents.id, c.watcher.id));
  const failedAt = (node: { id: string }, ago: number) =>
    c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.agent.id, nodeId: node.id, kind: 'conversation', prompt: 'Answer the owner', timeoutMs: 900000, status: 'failed', error: 'not_logged_in', failure: { kind: 'auth', text: 'Expired', retryable: false }, finishedAt: new Date(Date.now() - ago * MIN) });
  return { ...c, opsPlan: opsPlan!, client: (c.db as unknown as { $client: PGlite }).$client, nodeOf, failedAt };
}

describe('the minute check of sign-ins that have not healed', () => {
  it('asks for the failed turns of the nodes that need a sign-in by an index, with no pass over the jobs', async () => {
    const c = await setUp();
    const node = await c.nodeOf('plan-node', 'needs_login');
    await c.failedAt(node, 90);
    await c.client.query(
      `INSERT INTO jobs (company_id, subscription_id, agent_id, prompt, status, kind, node_id, timeout_ms, created_at, started_at, finished_at)
       SELECT $1, $2, $3, 'Words.', 'done', 'conversation', $4, 1000, timestamp '2026-10-01' + i * interval '2 minutes', timestamp '2026-10-01' + i * interval '2 minutes', timestamp '2026-10-01' + i * interval '2 minutes' + interval '30 seconds'
       FROM generate_series(1, 6000) i`,
      [c.companyId, c.sub.id, c.agent.id, node.id],
    );
    await c.client.exec('ANALYZE jobs');
    const seen = statements();
    await checkSignInFailures(c.ctx, new Date());
    const asked = seen.filter(q => q.params.includes('not_logged_in'));
    expect(asked).toHaveLength(1);
    const { rows } = await c.client.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(`EXPLAIN (FORMAT JSON) ${asked[0]!.sql}`, asked[0]!.params);
    const reads = walk(rows[0]!['QUERY PLAN'][0]!.Plan).filter(n => n['Relation Name'] === 'jobs');
    expect(reads.map(n => n['Node Type'])).not.toContain('Seq Scan');
    expect(reads.flatMap(n => (n['Index Name'] ? [n['Index Name']] : []))).toEqual(['jobs_not_logged_in']);
  });

  it('reads none of the words of the failed turns, which fill a turn with thousands of characters', async () => {
    const c = await setUp();
    const seen = statements();
    await checkSignInFailures(c.ctx, new Date());
    const asked = seen.find(q => q.params.includes('not_logged_in'))!;
    expect(asked.sql).not.toMatch(/"(prompt|requested_prompt|result|tail|failure|interruption)"/);
  });

  it('tells of the newest failed turn of a node alone, and of no node that has signed in again', async () => {
    const c = await setUp();
    const stuck = await c.nodeOf('still-out', 'needs_login');
    /* On the plan of Operations, so that the plan that waits has no other node that could take its turns. */
    const back = await c.nodeOf('signed-in-again', 'ready', c.opsPlan.id);
    const fresh = await c.nodeOf('just-failed', 'needs_login');
    await c.db.update(agents).set({ nodeId: stuck.id }).where(eq(agents.id, c.agent.id));
    await c.failedAt(stuck, 200);
    const [newest] = await c.failedAt(stuck, 90).returning();
    await c.failedAt(back, 300);
    /* The newest failure of this node is not an hour old, whatever an older one of the same node was. */
    await c.failedAt(fresh, 120);
    await c.failedAt(fresh, 10);
    await insertTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Waiting conversation', createdBy: null });
    await checkSignInFailures(c.ctx, new Date());
    const notices = await c.turnsOf(c.watcher.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.prompt).toContain(stuck.id);
    expect(notices[0]!.prompt).toContain(newest!.finishedAt!.toISOString());
    expect(notices[0]!.prompt).not.toContain(back.id);
    expect(notices[0]!.prompt).not.toContain(fresh.id);
  });
});
