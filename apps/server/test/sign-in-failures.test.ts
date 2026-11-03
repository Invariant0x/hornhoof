import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, jobs, machines, nodes, subscriptions } from '../src/db/schema.js';
import { enqueueTurn, pump } from '../src/modules/conversation/queue.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { reconcile } from '../src/modules/tasks/reconcile.js';
import { failureCompany } from './failure-company.js';

const MIN = 60_000;
describe('a failed sign-in', () => {
  it('waits for the owner, reports once after an hour while turns wait, and goes on after sign-in', async () => {
    const c = await failureCompany();
    await c.db.update(subscriptions).set({ kind: 'personal', provider: 'codex' }).where(eq(subscriptions.id, c.sub.id));
    const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: 'login-mac', hostname: 'Mac' }).returning();
    const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, status: 'ready', version: '0.5.0', keyHash: 'hash' }).returning();
    await c.db.update(agents).set({ nodeId: node!.id }).where(eq(agents.id, c.agent.id));
    /* Operations runs on a different ready plan, so it can hear about this one. */
    const [opsPlan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, ownerPersonId: c.sub.ownerPersonId, provider: 'anthropic_api', kind: 'api_key', label: 'Operations', status: 'ready' }).returning();
    await c.db.update(agents).set({ subscriptionId: opsPlan!.id }).where(eq(agents.id, c.watcher.id));
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Answer the person', createdBy: null });
    const at = new Date();
    await handleNodeMessage(c.ctx, nodeIdentity(node!.id), { type: 'job.done', jobId: id, ok: false, error: 'agent_failed', sessionId: 'session', result: '', tail: 'Expired', failure: { kind: 'auth', text: 'Sign-in expired.', retryable: false } }, at);
    expect(await c.jobOf(id)).toMatchObject({ error: 'not_logged_in', failure: { kind: 'auth' } });
    expect((await c.turnsOf())[1]).toMatchObject({ status: 'queued', continueOf: id });
    expect((await c.db.select().from(nodes).where(eq(nodes.id, node!.id)))[0]!.status).toBe('needs_login');
    await reconcile(c.ctx, new Date(+at + 60 * MIN - 1));
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
    await reconcile(c.ctx, new Date(+at + 60 * MIN));
    const notices = await c.turnsOf(c.watcher.id);
    expect(notices).toHaveLength(1);
    for (const text of ['Ivan', 'sign in', node!.id, at.toISOString()]) expect(notices[0]!.prompt).toContain(text);
    await reconcile(c.ctx, new Date(+at + 61 * MIN));
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    await c.db.update(nodes).set({ status: 'ready' }).where(eq(nodes.id, node!.id));
    await c.db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, c.sub.id));
    await pump(c.ctx, c.agent.id);
    expect((await c.turnsOf())[1]!.status).toBe('running');
    expect((await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.agent.id), eq(jobs.status, 'running'))))).toHaveLength(1);
  });
});

it('does not call Operations when another signed-in machine can take the waiting conversation', async () => {
  const c = await failureCompany();
  await c.db.update(subscriptions).set({ kind: 'personal', provider: 'codex' }).where(eq(subscriptions.id, c.sub.id));
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: 'two-nodes', hostname: 'Mac' }).returning();
  const [spareMachine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: 'spare-machine', hostname: 'Spare' }).returning();
  const [old] = await c.db.insert(nodes).values([
    { companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, status: 'needs_login', version: '0.5.0', keyHash: 'old' },
    { companyId: c.companyId, machineId: spareMachine!.id, subscriptionId: c.sub.id, status: 'ready', version: '0.5.0', keyHash: 'spare' },
  ]).returning();
  await c.db.update(agents).set({ nodeId: old!.id }).where(eq(agents.id, c.agent.id));
  await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.agent.id, nodeId: old!.id, kind: 'conversation', prompt: 'Answer the owner', timeoutMs: 900000, status: 'failed', error: 'not_logged_in', failure: { kind: 'auth', text: 'Expired', retryable: false }, finishedAt: new Date(Date.now() - 61 * MIN) });
  const { insertTurn } = await import('../src/modules/conversation/queue.js');
  await insertTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Waiting conversation', createdBy: null });
  await reconcile(c.ctx);
  expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
});

it('drops an undelivered sign-in alarm when the owner signs in before Operations returns', async () => {
  const c = await failureCompany();
  await c.db.update(subscriptions).set({ kind: 'personal', provider: 'codex', status: 'needs_login' }).where(eq(subscriptions.id, c.sub.id));
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: 'healed-login', hostname: 'Mac' }).returning();
  const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, status: 'needs_login', version: '0.5.0', keyHash: 'hash' }).returning();
  await c.db.update(agents).set({ nodeId: node!.id }).where(eq(agents.id, c.agent.id));
  const [opsPlan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, ownerPersonId: c.sub.ownerPersonId, provider: 'anthropic_api', kind: 'api_key', label: 'Operations', status: 'ready' }).returning();
  await c.db.update(agents).set({ subscriptionId: opsPlan!.id, switchedOffAt: new Date() }).where(eq(agents.id, c.watcher.id));
  await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.agent.id, nodeId: node!.id, kind: 'conversation', prompt: 'Answer the owner', timeoutMs: 900000, status: 'failed', error: 'not_logged_in', failure: { kind: 'auth', text: 'Expired', retryable: false }, finishedAt: new Date(Date.now() - 61 * MIN) });
  const { insertTurn } = await import('../src/modules/conversation/queue.js');
  await insertTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Waiting conversation', createdBy: null });
  await reconcile(c.ctx);
  await c.db.update(nodes).set({ status: 'ready' }).where(eq(nodes.id, node!.id));
  await c.db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, c.sub.id));
  await c.db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, c.watcher.id));
  await reconcile(c.ctx);
  expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
});
