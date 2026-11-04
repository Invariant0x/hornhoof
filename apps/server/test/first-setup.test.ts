import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, jobs, machines, nodes, subscriptions } from '../src/db/schema.js';
import { agentState, enqueueTurn, pump } from '../src/modules/conversation/queue.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { agentFailureState } from '../src/modules/tasks/failures.js';
import { failureCompany } from './failure-company.js';

/* An Antigravity plan whose agy asks, on its machine, for a first setup only the plan's owner may pass: its terms. */
async function planOnMachine() {
  const c = await failureCompany();
  await c.db.update(subscriptions).set({ kind: 'personal', provider: 'antigravity' }).where(eq(subscriptions.id, c.sub.id));
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: 'a-host', hostname: 'a-host' }).returning();
  const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, status: 'ready', version: '0.5.2', keyHash: 'hash' }).returning();
  await c.db.update(agents).set({ nodeId: node!.id }).where(eq(agents.id, c.agent.id));
  const id = nodeIdentity(node!.id);
  const nodeStatus = async () => (await c.db.select().from(nodes).where(eq(nodes.id, node!.id)))[0]!.status;
  const planStatus = async () => (await c.db.select().from(subscriptions).where(eq(subscriptions.id, c.sub.id)))[0]!.status;
  return { ...c, node: node!, id, nodeStatus, planStatus };
}

describe("a program's first setup that only the plan's owner passes", () => {
  it('holds the turn that met it with no retry spent, names the wait, and lets it go once the owner passed it', async () => {
    const c = await planOnMachine();
    const turn = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Review the change', createdBy: null });
    await handleNodeMessage(c.ctx, c.id, { type: 'job.done', jobId: turn, ok: false, error: 'agent_failed', sessionId: null, result: '', tail: 'Terms of Service & Data Use', failure: { kind: 'setup', text: 'The terms wait for the owner.', retryable: false } });
    expect(await c.jobOf(turn)).toMatchObject({ error: 'agent_failed', failure: { kind: 'setup' } });
    expect((await c.turnsOf())[1]).toMatchObject({ status: 'queued', continueOf: turn, notBefore: null });
    expect(await agentFailureState(c.ctx, c.agent.id)).toMatchObject({ retry: null, failure: { kind: 'setup' } });
    const facts = (await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, turn))).map(e => (e.data as { text?: string }).text);
    expect(facts).toContain("The last try failed (setup): The terms wait for the owner.. The turn waits for the plan owner to pass its program's first setup on its machine, as for a sign-in.");
    expect([await c.nodeStatus(), await c.planStatus()]).toEqual(['needs_setup', 'needs_setup']);
    expect((await agentState(c.ctx, c.agent.id)).reason).toBe('needs_setup');
    await pump(c.ctx, c.agent.id);
    expect((await c.turnsOf())[1]!.status).toBe('queued');

    await handleNodeMessage(c.ctx, c.id, { type: 'status', loggedIn: true, limits: null });
    expect([await c.nodeStatus(), await c.planStatus()]).toEqual(['ready', 'ready']);
    expect(await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.agent.id), eq(jobs.status, 'running')))).toHaveLength(1);
  });

  it('is what a node says of itself once signed in, and the sign-in comes first', async () => {
    const c = await planOnMachine();
    await handleNodeMessage(c.ctx, c.id, { type: 'hello', version: '0.5.2', loggedIn: true, setupNeeded: true, running: [] });
    expect([await c.nodeStatus(), await c.planStatus()]).toEqual(['needs_setup', 'needs_setup']);
    await handleNodeMessage(c.ctx, c.id, { type: 'status', loggedIn: false, setupNeeded: true, limits: null });
    expect([await c.nodeStatus(), await c.planStatus()]).toEqual(['needs_login', 'needs_login']);
    await handleNodeMessage(c.ctx, c.id, { type: 'status', loggedIn: true, setupNeeded: true, limits: null });
    expect([await c.nodeStatus(), await c.planStatus()]).toEqual(['needs_setup', 'needs_setup']);
  });
});
