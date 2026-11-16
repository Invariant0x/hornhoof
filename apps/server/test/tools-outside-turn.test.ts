import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, jobs, machines, nodes, people, subscriptions, tasks } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { standingPrincipal } from '../src/modules/conversation/decision-context.js';
import { appendEvent } from '../src/modules/events/store.js';
import { disconnectMachines } from '../src/modules/nodes/disconnect.js';
import { nodeIdentity, type NodeIdentity } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createRoute } from '../src/modules/tasks/echelons-store.js';
import { ONLY_CEO, ONLY_DEPARTMENT_OWNER } from '../src/modules/tools/control.js';
import { BUILTIN } from './builtin.js';
import { failureCompany } from './failure-company.js';
import { as } from './helpers.js';
import { developmentStages } from './templates-once.js';

type Rpc = { jsonrpc: '2.0'; id?: number; method: string; params?: object };
type Answer = { status: number; body: { id?: number; result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: { code: number; message: string } } | null };

const VERSION = '2025-06-18';
const rpc = (id: number | null, method: string, params?: object): Rpc => ({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) });
const call = (id: number, name: string, args: object = {}) => rpc(id, 'tools/call', { name, arguments: args });
/* What an MCP client sends as it connects, agy's server/discover first, as each of the programs we run sends it. */
const CONNECTING: Rpc[] = [
  rpc(1, 'server/discover'),
  rpc(2, 'initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'agy', version: '1.4.12' } }),
  rpc(null, 'notifications/initialized'),
  rpc(3, 'ping'),
  rpc(4, 'tools/list'),
  rpc(5, 'resources/list'),
  rpc(6, 'resources/templates/list'),
  rpc(7, 'prompts/list'),
];
const textOf = (a: Answer) => a.body?.result?.content?.map(c => c.text).join('\n') ?? '';

/* Acme with Hana, Bruno and Walt on the company key, which the built-in node runs, and its orchestrator. */
async function company() {
  const c = await failureCompany();
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  let refs = 0;
  /* What the agent's program sends to its tools while no turn of it runs, through its node, and what Hornhoof answers. */
  const outside = async (agentId: string, message: Rpc | Rpc[], node: NodeIdentity = BUILTIN): Promise<Answer> => {
    const ref = `ref-${++refs}`;
    await handleNodeMessage(c.ctx, node, { type: 'tools.call', agentKey: agentId, ref, body: JSON.stringify(message), version: VERSION });
    const answer = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'tools.answer' && m.ref === ref);
    if (answer?.type !== 'tools.answer') throw new Error(`Hornhoof did not answer ${ref}.`);
    expect(answer.agentKey).toBe(agentId);
    return { status: answer.status, body: answer.body ? JSON.parse(answer.body) : null };
  };
  /* A turn of the agent that runs now, and its token. */
  const turn = async (agentId: string, values: Partial<typeof jobs.$inferInsert> = {}) => {
    const token = `tok-${++refs}-${agentId}`;
    const [job] = await c.db
      .insert(jobs)
      .values({ companyId: c.companyId, agentId, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'work', status: 'running', startedAt: new Date(), timeoutMs: 60_000, toolTokenHash: hashToken(token), ...values })
      .returning();
    return { job: job!, token };
  };
  /* What /mcp answers the same message in a turn. */
  const inTurn = async (token: string, message: Rpc | Rpc[]): Promise<Answer> => {
    const res = await c.app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': VERSION }, payload: JSON.stringify(message) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const [owner] = await c.db.select(idOnly(people)).from(people).where(eq(people.isOwner, true));
  /* A machine of the CEO's with a node of the company's plan on it. */
  const machine = async (name: string) => {
    const [row] = await c.db.insert(machines).values({ companyId: c.companyId, personId: owner!.id, machineKey: name }).returning();
    const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: row!.id, subscriptionId: c.sub.id, status: 'ready', keyHash: name, version: '0.6.0' }).returning();
    return { machine: row!, node: node!, identity: nodeIdentity(node!.id) };
  };
  /* What the node asks as the agent's program runs a check command with no turn running, and what Hornhoof answers. */
  const check = async (agentId: string, node: NodeIdentity = BUILTIN) => {
    const ref = `ref-${++refs}`;
    await handleNodeMessage(c.ctx, node, { type: 'tools.check', agentKey: agentId, ref });
    const answer = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'tools.checking' && m.ref === ref);
    if (answer?.type !== 'tools.checking') throw new Error(`Hornhoof did not answer ${ref}.`);
    expect(answer.agentKey).toBe(agentId);
    return answer;
  };
  const stepsOf = (agentId: string) => c.db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'tools'))).orderBy(asc(jobs.createdAt));
  const turnsOf = (agentId: string) => c.db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation')));
  return { ...c, orchestrator: orchestrator!, outside, check, turn, inTurn, stepsOf, turnsOf, machine };
}

describe("an agent's tools with no turn of it running", () => {
  it.each(['agent', 'head', 'orchestrator'] as const)('answer the program of an %s as it connects, before any turn and with nothing kept on its node, as a turn answers it', async role => {
    const c = await company();
    const agent = c[role];
    const before = [];
    for (const message of CONNECTING) before.push(await c.outside(agent.id, message));
    /* Nothing it asked opened a turn, and no step of it is left open. */
    expect(await c.turnsOf(agent.id)).toEqual([]);
    expect((await c.stepsOf(agent.id)).filter(s => s.status === 'running')).toEqual([]);

    const { token } = await c.turn(agent.id);
    for (const [i, message] of CONNECTING.entries()) {
      expect(before[i], `${agent.name}: ${message.method}`).toEqual(await c.inTurn(token, message));
      expect(before[i]!.body?.error?.code, `${agent.name}: ${message.method}`).not.toBe(-32001);
    }
    expect(before[3]!.body?.result).toEqual({});
    expect(before[4]!.body?.result?.tools?.length).toBeGreaterThan(5);
  });

  it('list the tools of its role', async () => {
    const c = await company();
    /* Each role has its own tools: a head's are not an employee's. */
    const names = async (agentId: string) => (await c.outside(agentId, rpc(9, 'tools/list'))).body?.result?.tools?.map(t => t.name);
    expect(await names(c.head.id)).toContain('set_employee_assignment');
    expect(await names(c.agent.id)).not.toContain('set_employee_assignment');
  });

  it("run a call in a step of their own that ends with it, and write the call in the agent's journal without what it carried", async () => {
    const c = await company();
    const answer = await c.outside(c.agent.id, call(1, 'company'));
    expect(answer.status).toBe(200);
    expect(answer.body?.result?.isError).toBeUndefined();
    expect(textOf(answer)).toContain('"departments"');

    const [step, ...more] = await c.stepsOf(c.agent.id);
    expect(more).toEqual([]);
    expect(step).toMatchObject({ kind: 'tools', status: 'done', createdBy: null, prompt: '' });
    expect(step!.finishedAt).not.toBeNull();
    expect(await c.turnsOf(c.agent.id)).toEqual([]);
    const journal = await c.db.select({ kind: agentEvents.kind, data: agentEvents.data }).from(agentEvents).where(eq(agentEvents.jobId, step!.id)).orderBy(asc(agentEvents.seq));
    expect(journal).toEqual([
      { kind: 'tool', data: { name: 'company', input: '' } },
      { kind: 'tool_result', data: { ok: true, summary: 'Called with no turn running.' } },
    ]);

    /* A call that failed says so, and still nothing of what it carried. */
    await c.outside(c.agent.id, call(2, 'task', { task: 'secret-value-123' }));
    const last = (await c.stepsOf(c.agent.id)).at(-1)!;
    const logged = await c.db.select({ data: agentEvents.data }).from(agentEvents).where(eq(agentEvents.jobId, last.id));
    expect(JSON.stringify(logged)).not.toContain('secret-value-123');
    expect(logged.map(l => l.data)).toEqual([{ name: 'task', input: '' }, { ok: false, summary: 'Called with no turn running.' }]);
  });

  it('take no decision for a person in a step, which answers nobody, not even the last person who wrote, as a turn of Hornhoof does', async () => {
    const c = await company();
    const [done] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.orchestrator.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Hi', status: 'done', timeoutMs: 1000, finishedAt: new Date() }).returning();
    const ceoId = (await c.app.inject({ url: '/api/me', ...as(c.ceo) })).json().person.id as string;
    await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.orchestrator.id, jobId: done!.id, kind: 'message', personId: ceoId, data: { text: 'Mark the checkout work urgent when it comes.' } });
    const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 1, title: 'Checkout', status: 'working', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executorAgentId: c.agent.id }).returning();

    /* A turn Hornhoof opened goes on for the CEO, who wrote last. */
    const { job } = await c.turn(c.orchestrator.id);
    expect(await standingPrincipal(c.db, job.id)).toMatchObject({ personId: ceoId });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, job.id));

    const urgent = await c.outside(c.orchestrator.id, call(1, 'set_urgent', { task: '#1', urgent: true }));
    expect(textOf(urgent)).toContain(ONLY_DEPARTMENT_OWNER);
    expect((await c.db.select({ urgent: tasks.urgent }).from(tasks).where(eq(tasks.id, task!.id)))[0]!.urgent).toBe(false);
    const removed = await c.outside(c.orchestrator.id, call(2, 'remove_subscription', { subscription: c.sub.id }));
    expect(textOf(removed)).toContain(ONLY_CEO);
    expect(await c.db.select(idOnly(subscriptions)).from(subscriptions).where(eq(subscriptions.id, c.sub.id))).toHaveLength(1);
  });

  it('give a switched-off employee its tools as it connects, and refuse its calls until it is on again', async () => {
    const c = await company();
    const off = await c.app.inject({ method: 'PATCH', url: `/api/agents/${c.agent.id}`, payload: { on: false }, ...as(c.ceo) });
    expect(off.statusCode).toBe(200);
    expect((await c.outside(c.agent.id, rpc(1, 'tools/list'))).body?.result?.tools?.length).toBeGreaterThan(5);
    const listed = await c.stepsOf(c.agent.id);

    const refused = await c.outside(c.agent.id, call(2, 'company'));
    expect(refused).toMatchObject({ status: 200, body: { id: 2, error: { message: expect.stringContaining('switched off') } } });
    /* The call opened no step and ran nothing. */
    expect(await c.stepsOf(c.agent.id)).toEqual(listed);
    expect(await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.agent.id), eq(agentEvents.kind, 'tool')))).toEqual([]);

    await c.app.inject({ method: 'PATCH', url: `/api/agents/${c.agent.id}`, payload: { on: true }, ...as(c.ceo) });
    expect(textOf(await c.outside(c.agent.id, call(3, 'company')))).toContain('"departments"');
  });

  it("refuse an employee that left the company, and one whose program the node does not run", async () => {
    const c = await company();
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.watcher.id));
    for (const message of [rpc(1, 'tools/list'), call(2, 'company')]) {
      expect(await c.outside(c.watcher.id, message)).toMatchObject({ status: 200, body: { id: message.id, error: { message: expect.stringContaining('not on this machine') } } });
    }
    /* The node of another plan does not run the company key's employees. */
    const other = await c.machine('other');
    expect(await c.outside(c.agent.id, call(3, 'company'), other.identity)).toMatchObject({ body: { id: 3, error: { message: expect.stringContaining('not on this machine') } } });
    expect(await c.stepsOf(c.agent.id)).toEqual([]);
    expect(await c.stepsOf(c.watcher.id)).toEqual([]);
  });
});

describe("a running turn's tools", () => {
  it('stop at once when a person stops the turn, while its program still winds down', async () => {
    const c = await company();
    const { job, token } = await c.turn(c.agent.id);
    expect(textOf(await c.inTurn(token, call(1, 'company')))).toContain('"departments"');
    const stop = await c.app.inject({ method: 'POST', url: `/api/agents/${c.agent.id}/stop`, ...as(c.ceo) });
    expect(stop.statusCode).toBeLessThan(300);
    /* The node was told and has not ended it yet. */
    expect((await c.db.select({ status: jobs.status, error: jobs.error }).from(jobs).where(eq(jobs.id, job.id)))[0]).toEqual({ status: 'running', error: 'cancelled' });
    expect((await c.inTurn(token, call(2, 'company'))).status).toBe(401);
  });

  it('stop at once for an employee that left the company', async () => {
    const c = await company();
    const { token } = await c.turn(c.agent.id);
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.agent.id));
    expect((await c.inTurn(token, call(1, 'company'))).status).toBe(401);
  });

  it('stop at once, with its calls with no turn, when its machine is disconnected', async () => {
    const c = await company();
    await c.db.update(subscriptions).set({ kind: 'personal', provider: 'claude' }).where(eq(subscriptions.id, c.sub.id));
    const { machine, node, identity: laptop } = await c.machine('laptop');
    await c.db.update(agents).set({ nodeId: node.id }).where(eq(agents.id, c.agent.id));
    const { token } = await c.turn(c.agent.id, { nodeId: node.id });
    expect(textOf(await c.outside(c.agent.id, call(1, 'company'), laptop))).toContain('"departments"');

    await disconnectMachines(c.ctx, [machine.id]);
    expect((await c.inTurn(token, call(2, 'company'))).status).toBe(401);
    expect(await c.outside(c.agent.id, call(3, 'company'), laptop)).toMatchObject({ body: { id: 3, error: { message: expect.stringContaining('not on this machine') } } });
  });
});

describe('a step of the tools', () => {
  it('is no work that holds an employee: one in a step is removed, and one switched off hands its work on', async () => {
    const c = await company();
    const step = async (agentId: string) => (await c.turn(agentId, { kind: 'tools', prompt: '' })).job;
    const rita = await c.hire('Rita', 'worker', 'DEV-BE', c.dev.id);
    await step(rita.id);
    expect((await c.app.inject({ method: 'DELETE', url: `/api/agents/${rita.id}`, ...as(c.ceo) })).statusCode).toBe(204);
    expect((await c.stepsOf(rita.id)).map(s => [s.status, s.error])).toEqual([['failed', 'removed']]);

    const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 1, title: 'Checkout', status: 'working', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executorAgentId: c.agent.id }).returning();
    await c.db.transaction(tx => createRoute(tx, task!, {}, developmentStages()));
    await step(c.agent.id);
    await c.app.inject({ method: 'PATCH', url: `/api/agents/${c.agent.id}`, payload: { on: false }, ...as(c.ceo) });
    expect((await c.db.select({ assignee: tasks.assigneeAgentId }).from(tasks).where(eq(tasks.id, task!.id)))[0]!.assignee).not.toBe(c.agent.id);
  });
});

describe('a check command its program runs with no turn running', () => {
  const journalOf = (c: Awaited<ReturnType<typeof company>>, jobId: string) =>
    c.db.select({ kind: agentEvents.kind, data: agentEvents.data }).from(agentEvents).where(eq(agentEvents.jobId, jobId)).orderBy(asc(agentEvents.seq));

  it("runs in a step of its own, open while it runs, that the machine's check slot goes to, and ends as the node says it did", async () => {
    const c = await company();
    const opened = await c.check(c.agent.id);
    expect(opened.refused).toBeUndefined();
    const [step, ...more] = await c.stepsOf(c.agent.id);
    expect(more).toEqual([]);
    expect(step).toMatchObject({ id: opened.jobId, kind: 'tools', status: 'running', createdBy: null, prompt: '', toolTokenHash: null });
    expect(await c.turnsOf(c.agent.id)).toEqual([]);
    expect(await journalOf(c, step!.id)).toEqual([{ kind: 'tool', data: { name: 'hh-check', input: '' } }]);

    /* The node asks for a slot of the machine's checks for the step, as it does for a turn, with its load just said: a step
       no running work of the agent's would have its request end at once. */
    vi.spyOn(c.ctx.hub, 'loadOf').mockReturnValue({ cpus: 4, load: 0, at: Date.now() } as ReturnType<typeof c.ctx.hub.loadOf>);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.acquire', id: 'slot-1', label: 'npx', agentId: c.agent.id, jobId: step!.id });
    const slot = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'check.state' && m.id === 'slot-1');
    expect(['queued', 'running']).toContain(slot?.type === 'check.state' ? slot.state : null);
    /* One with no step and no turn running gets no slot. */
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.acquire', id: 'slot-2', label: 'npx', agentId: c.head.id });
    expect(c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'check.state' && m.id === 'slot-2')).toMatchObject({ state: 'ended' });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.release', id: 'slot-1' });

    /* A word of the end for another employee changes nothing. */
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'tools.checked', agentKey: c.head.id, jobId: step!.id, ok: true });
    expect((await c.stepsOf(c.agent.id))[0]!.status).toBe('running');
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'tools.checked', agentKey: c.agent.id, jobId: step!.id, ok: false });
    expect((await c.stepsOf(c.agent.id))[0]).toMatchObject({ status: 'done' });
    expect(await journalOf(c, step!.id)).toEqual([
      { kind: 'tool', data: { name: 'hh-check', input: '' } },
      { kind: 'tool_result', data: { ok: false, summary: 'Ran with no turn running.' } },
    ]);
    /* Once over, it stays as it ended. */
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'tools.checked', agentKey: c.agent.id, jobId: step!.id, ok: true });
    expect(await journalOf(c, step!.id)).toHaveLength(2);
  });

  it('may not run for one switched off, one that left the company, or one whose program another node runs', async () => {
    const c = await company();
    await c.app.inject({ method: 'PATCH', url: `/api/agents/${c.agent.id}`, payload: { on: false }, ...as(c.ceo) });
    expect(await c.check(c.agent.id)).toMatchObject({ jobId: null, refused: expect.stringContaining('switched off') });
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.watcher.id));
    expect(await c.check(c.watcher.id)).toMatchObject({ jobId: null, refused: expect.stringContaining('not on this machine') });
    const other = await c.machine('other');
    expect(await c.check(c.head.id, other.identity)).toMatchObject({ jobId: null, refused: expect.stringContaining('not on this machine') });
    for (const agent of [c.agent, c.watcher, c.head]) expect(await c.stepsOf(agent.id)).toEqual([]);
  });

  it('stops at once when the employee is removed, and when its machine is disconnected', async () => {
    const c = await company();
    const rita = await c.hire('Rita', 'worker', 'DEV-BE', c.dev.id);
    const { jobId } = await c.check(rita.id);
    expect((await c.app.inject({ method: 'DELETE', url: `/api/agents/${rita.id}`, ...as(c.ceo) })).statusCode).toBe(204);
    expect((await c.stepsOf(rita.id)).map(s => [s.status, s.error])).toEqual([['failed', 'removed']]);
    /* The node hears to stop the command now. */
    expect(c.sent.mock.calls.filter(([, m]) => m.type === 'job.cancel').map(([node, m]) => [node, m])).toEqual([[BUILTIN, { type: 'job.cancel', jobId }]]);

    await c.db.update(subscriptions).set({ kind: 'personal', provider: 'claude' }).where(eq(subscriptions.id, c.sub.id));
    const { machine, node, identity: laptop } = await c.machine('laptop');
    await c.db.update(agents).set({ nodeId: node.id }).where(eq(agents.id, c.agent.id));
    const onLaptop = await c.check(c.agent.id, laptop);
    expect(onLaptop.jobId).not.toBeNull();
    await disconnectMachines(c.ctx, [machine.id]);
    expect((await c.stepsOf(c.agent.id)).map(s => s.status)).toEqual(['failed']);
    expect(await c.check(c.agent.id, laptop)).toMatchObject({ jobId: null, refused: expect.stringContaining('not on this machine') });
  });
});
