import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { agentEvents, agents, departments, jobs, machines, nodes, subscriptions, taskEvents, taskRoutes, tasks } from '../src/db/schema.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { receiveOperatorReply } from '../src/modules/program-operator/rpc.js';
import { programRestartStatus } from '../src/modules/tasks/program-restarts.js';
import type { Grant } from '../src/modules/templates/load.js';
import { registerWatchTools } from '../src/modules/tools/watch.js';
import { createRoute, routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { failureCompany } from './failure-company.js';
import { until } from './helpers-basic.js';

const MIN = 60_000;
type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: { employee: string }) => Promise<Result>;
async function stuck(provider: 'claude' | 'codex' | 'kimi' | 'antigravity' = 'codex', whose: 'agent' | 'head' | 'orchestrator' = 'agent') {
  const c = await failureCompany();
  const operator = await c.hire('Olga', 'worker', 'OPS-PROGRAM', c.ops.id);
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const target = { agent: c.agent, head: c.head, orchestrator: orchestrator! }[whose];
  await c.db.update(subscriptions).set({ provider, kind: 'personal' }).where(eq(subscriptions.id, c.sub.id));
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: 'mac-12345', hostname: 'Mac' }).returning();
  const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, version: '0.5.0', status: 'ready', keyHash: 'node-key-hash' }).returning();
  await c.db.update(agents).set({ nodeId: node!.id, subscriptionId: c.sub.id }).where(eq(agents.id, target.id));
  const task = await c.db.transaction(async tx => {
    const [row] = await tx.insert(tasks).values({ companyId: c.companyId, number: 1, title: 'Checkout', small: true, status: 'working', assigneeAgentId: target.id, executorAgentId: target.id }).returning();
    await createRoute(tx, row!, {}, developmentStages());
    return row!;
  });
  const taskWake = taskWakeOf(task, { why: 'assigned' }, routeSnapshot(await routeOf(c.db, task), task.assigneeAgentId));
  const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: target.id, prompt: 'Work', taskId: task.id, createdBy: null, message: { personId: null, text: 'Work', from: 'agent', by: c.head.id, name: c.head.name, taskWake } });
  await c.db.update(jobs).set({ sessionId: 'session' }).where(eq(jobs.id, id));
  const identity = nodeIdentity(node!.id);
  const report = (state: 'thinking' | 'retrying' | 'tool' | 'asking' | 'idle' | 'gone' = 'thinking', quiet = 80, tool?: string) => handleNodeMessage(c.ctx, identity, { type: 'job.program', jobId: id, state, since: Date.now() - quiet * MIN, screenAt: Date.now(), signAt: Date.now() - quiet * MIN, ...(tool ? { tool } : {}) });
  await report();
  const server = new McpServer({ name: 'test', version: '1' });
  const registered = vi.spyOn(server, 'registerTool');
  onTestFinished(() => server.close());
  registerWatchTools(server, c.ctx, { id: 'watcher-job', companyId: c.companyId, agentId: c.watcher.id, agentKind: 'worker' }, new Set<Grant>(['agents', 'restart_program']));
  const run = async (): Promise<Result> => {
    const entry = (registered.mock.calls as [string, unknown, unknown][]).find(([name]) => name === 'restart_program');
    expect(entry, 'the skill grants the restart_program tool').toBeDefined();
    return (entry![2] as Handler)({ employee: c.agent.id });
  };
  const answer = (ok: boolean, reason: string | null = null) => {
    c.sent.mockImplementation((to, msg) => {
      if (msg.type === 'agent.restart') queueMicrotask(() => void handleNodeMessage(c.ctx, identity, { type: 'agent.restarted', jobId: id, agentKey: target.id, ok, reason }));
      return true;
    });
  };
  /* Operations by their role alone, in a turn of their own, with no skill that grants the tool. */
  const byRole = async (caller: typeof agents.$inferSelect): Promise<Result> => {
    const [turn] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: caller.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Round.', timeoutMs: 1000, status: 'running', createdBy: null }).returning();
    const tool = vi.fn();
    registerWatchTools({ registerTool: tool } as unknown as McpServer, c.ctx, { id: turn!.id, companyId: c.companyId, agentId: caller.id, agentKind: caller.kind, roleKey: caller.roleKey }, new Set<Grant>());
    return (tool.mock.calls.find(([name]) => name === 'restart_program')![2] as Handler)({ employee: target.id });
  };
  return { ...c, operator, target, id, node: node!, identity, task, report, run, answer, registered, byRole };
}

describe('restart_program', () => {
  it.each(['thinking', 'idle'] as const)('sends a native agy turn left %s by a lost successful Stop to Operations', async state => {
    const c = await stuck('antigravity');
    await c.report(state, 31);
    const { agentProgramState, checkSilentTurns } = await import('../src/modules/tasks/silent.js');
    await checkSilentTurns(c.ctx);
    expect(agentProgramState(c.ctx, { id: c.id }).alarm).toMatchObject({ reason: 'program_stalled' });
    const notices = await c.turnsOf(c.operator.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.prompt).toContain('restart_program is not allowed');
    expect((await c.run()).isError).toBe(true);
    expect(c.sent.mock.calls.some(([, m]) => m.type === 'agent.restart')).toBe(false);
    expect((await c.jobOf(c.id)).status).toBe('running');
    await checkSilentTurns(c.ctx);
    expect(await c.turnsOf(c.operator.id)).toHaveLength(1);
  });

  it('stops an obsolete native agy turn with a lost successful Stop instead of alerting Operations', async () => {
    const c = await stuck('antigravity');
    await c.report('thinking', 31);
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, c.task.id));
    const { checkSilentTurns } = await import('../src/modules/tasks/silent.js');
    await checkSilentTurns(c.ctx);
    expect(await c.jobOf(c.id)).toMatchObject({ status: 'failed', error: 'stale' });
    expect(c.sent.mock.calls).toContainEqual([c.identity, { type: 'job.cancel', jobId: c.id }]);
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
    expect((await c.log(c.task.id)).filter(e => e.kind === 'wake_skipped')).toHaveLength(1);
  });

  it('keeps a giver notification valid after its task closed', async () => {
    const c = await stuck();
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null, createdByAgentId: c.agent.id }).where(eq(tasks.id, c.task.id));
    const [event] = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.id));
    const taskWake = taskWakeOf({ ...c.task, status: 'done' }, { why: 'done' }, routeSnapshot(await routeOf(c.db, c.task), null));
    await c.db.update(agentEvents).set({ data: { ...(event!.data as object), taskWake } }).where(eq(agentEvents.id, event!.id));
    c.answer(true);
    expect((await c.run()).isError).toBeFalsy();
    expect(await c.jobOf(c.id)).toMatchObject({ status: 'running', restartedAt: expect.any(Date) });
    expect((await c.log(c.task.id)).filter(e => e.kind === 'wake_skipped')).toEqual([]);
  });

  it.each(['done', 'cancelled', 'transferred', 'next_stage'] as const)('stops stale task work after %s without a program restart or Operations wake', async change => {
    const c = await stuck();
    if (change === 'done' || change === 'cancelled') await c.db.update(tasks).set({ status: change, closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, c.task.id));
    else if (change === 'transferred') await c.db.update(tasks).set({ assigneeAgentId: c.head.id }).where(eq(tasks.id, c.task.id));
    else {
      const route = await routeOf(c.db, c.task);
      await c.db.update(taskRoutes).set({ state: { ...route.state, stage: 'review' } }).where(eq(taskRoutes.taskId, c.task.id));
    }
    c.answer(true);
    expect((await c.run()).isError).toBe(true);
    expect(await c.jobOf(c.id)).toMatchObject({ status: 'failed', error: 'stale', restartedAt: null });
    expect(c.sent.mock.calls.some(([, m]) => m.type === 'agent.restart')).toBe(false);
    expect(c.sent.mock.calls).toContainEqual([c.identity, { type: 'job.cancel', jobId: c.id }]);
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
    const skipped = (await c.log(c.task.id)).filter(e => e.kind === 'wake_skipped');
    expect(skipped).toHaveLength(change === 'done' || change === 'cancelled' ? 1 : 0);
  });

  it('restarts a taskless conversation as before', async () => {
    const c = await stuck();
    await c.db.update(jobs).set({ taskId: null }).where(eq(jobs.id, c.id));
    c.answer(true);
    expect((await c.run()).isError).toBeFalsy();
    expect(c.sent.mock.calls.some(([, m]) => m.type === 'agent.restart' && m.jobId === c.id)).toBe(true);
    expect((await c.jobOf(c.id)).status).toBe('running');
  });

  it.each(['head', 'orchestrator'] as const)('lets the head of Operations and the program operator restart the program of the %s by their role, and names who asked', async whose => {
    for (const roleKey of ['OPS-HEAD', 'OPS-PROGRAM'] as const) {
      const c = await stuck('codex', whose);
      const caller = roleKey === 'OPS-HEAD' ? await c.hire('Oleg', 'head', 'OPS-HEAD', c.ops.id) : c.operator;
      c.answer(true);
      const result = await c.byRole(caller);
      expect(result.isError, roleKey).toBeFalsy();
      expect(c.sent.mock.calls.filter(([, msg]) => msg.type === 'agent.restart' && msg.jobId === c.id && msg.agentKey === c.target.id), roleKey).toHaveLength(1);
      expect((await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.id))).map(e => (e.data as { text?: string }).text), roleKey).toContain(`${caller.name} requested a program restart of ${c.target.name} after 80 minutes without a sign from the model. Hornhoof waits up to 15 seconds for the node.`);
      expect((await c.jobOf(c.id)).restartedAt, roleKey).not.toBeNull();
    }
  });

  it('asks the node to restart a fresh session and keeps its refusal in both logs', async () => {
    const c = await stuck();
    await c.db.update(jobs).set({ sessionId: null }).where(eq(jobs.id, c.id));
    c.answer(false, 'The session is not known.');

    const result = await c.run();

    expect(c.sent.mock.calls.some(([, msg]) => msg.type === 'agent.restart' && msg.jobId === c.id)).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('The session is not known.');
    expect((await c.jobOf(c.id)).restartedAt).toBeNull();
    expect((await c.db.select().from(taskEvents)).some(e => e.text === `${c.agent.name}: The session is not known.`)).toBe(true);
    expect((await c.db.select().from(agentEvents)).some(e => (e.data as { text?: string }).text === 'The session is not known.')).toBe(true);
  });

  it.each(['claude', 'codex', 'kimi'] as const)('restarts a silent %s once, sends the note and logs what the node said', async provider => {
    const c = await stuck(provider);
    c.answer(true);
    const result = await c.run();
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('restarted');
    expect((await c.jobOf(c.id)).restartedAt).not.toBeNull();
    expect(c.sent.mock.calls.some(([, msg]) => msg.type === 'agent.restart' && msg.jobId === c.id && msg.agentKey === c.agent.id && /80 minutes without a sign/.test(msg.note))).toBe(true);
    expect((await c.db.select().from(taskEvents)).some(e => /restarted/.test(e.text))).toBe(true);
    expect((await c.db.select().from(agentEvents)).some(e => /restarted/.test(JSON.stringify(e.data)))).toBe(true);
    expect((await c.run()).content[0]!.text).toContain('already');
  });

  it.each(['tool', 'asking', 'idle', 'gone'] as const)('refuses %s and sends nothing', async state => {
    const c = await stuck();
    await c.report(state);
    expect((await c.run()).isError).toBe(true);
    expect((await c.run()).content[0]!.text).toContain(state);
    expect(c.sent.mock.calls.some(([, m]) => m.type === 'agent.restart')).toBe(false);
    expect((await c.jobOf(c.id)).restartedAt).toBeNull();
  });

  it('refuses a tool named even in a thinking report', async () => {
    const c = await stuck();
    await c.report('thinking', 80, 'Bash');
    expect((await c.run()).content[0]!.text).toContain('tool');
  });

  it.each(['codex', 'antigravity'] as const)('allows restart_program at state=tool when the live view has job=null on %s, and refuses when the running job owns the tool', async provider => {
    const c = await stuck(provider);
    await c.report('tool', 31, 'call_mcp_tool');
    vi.spyOn(c.ctx.hub, 'hasProgramOperator').mockReturnValue(true);
    let viewJobId: string | null = c.id;
    c.sent.mockImplementation((node, msg) => {
      if (msg.type === 'program.view_get') {
        receiveOperatorReply(c.ctx, node, {
          type: 'program.view',
          agentKey: msg.agentKey,
          request: msg.request,
          result: 'ok',
          reason: null,
          snapshot: 'snap-1',
          instance: 'inst-1',
          jobId: viewJobId,
          state: 'working',
          tool: 'call_mcp_tool',
          question: null,
          input: 'empty',
          undelivered: false,
          cols: 80,
          rows: 24,
          cells: '> ',
        });
      }
      if (msg.type === 'agent.restart') {
        queueMicrotask(() => void handleNodeMessage(c.ctx, c.identity, { type: 'agent.restarted', jobId: c.id, agentKey: c.target.id, ok: true, reason: null }));
      }
      return true;
    });

    expect((await programRestartStatus(c.ctx, c.companyId, c.agent.id)).allowed).toBe(false);
    expect((await c.run()).isError).toBe(true);

    viewJobId = null;
    expect(await programRestartStatus(c.ctx, c.companyId, c.agent.id)).toEqual({ allowed: true, reason: null });
    const restarted = await c.run();
    expect(restarted.isError).toBeFalsy();
    expect(c.sent.mock.calls.some(([, m]) => m.type === 'agent.restart' && m.jobId === c.id)).toBe(true);
    expect((await c.jobOf(c.id)).restartedAt).not.toBeNull();
  });

  it.each([['claude', 74], ['codex', 29], ['kimi', 29], ['antigravity', 200]] as const)('refuses %s after only %i quiet minutes', async (provider, minutes) => {
    const c = await stuck(provider);
    await c.report('thinking', minutes);
    expect((await c.run()).isError).toBe(true);
    expect((await c.jobOf(c.id)).restartedAt).toBeNull();
  });

  it('refuses an older report without a sign, an offline node and a node without terminals', async () => {
    const c = await stuck();
    await handleNodeMessage(c.ctx, c.identity, { type: 'job.program', jobId: c.id, state: 'thinking', since: 1, screenAt: 1 });
    expect((await c.run()).content[0]!.text).toContain('sign');
    await c.report();
    vi.mocked(c.ctx.hub.isOnline).mockReturnValue(false);
    expect((await c.run()).content[0]!.text).toContain('offline');
    vi.mocked(c.ctx.hub.isOnline).mockReturnValue(true);
    vi.mocked(c.ctx.hub.hasTerminals).mockReturnValue(false);
    expect((await c.run()).content[0]!.text).toContain('terminal');
    await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, c.id));
    expect((await c.run()).content[0]!.text).toContain('running');
  });

  it('clears the restart mark when the node refuses, keeps its reason in both logs and allows another checked request', async () => {
    const c = await stuck();
    c.answer(false, 'A tool just started.');
    const result = await c.run();
    expect(result.content[0]!.text).toContain('A tool just started.');
    expect(result.isError).toBe(true);
    expect((await c.jobOf(c.id)).restartedAt).toBeNull();
    expect((await c.db.select().from(taskEvents)).some(e => /A tool just started/.test(e.text))).toBe(true);
    c.answer(true);
    expect((await c.run()).isError).toBeFalsy();
  });

  it('gives the agents tool the program, failure, waiting retry and checked restart reason', async () => {
    const c = await stuck();
    const entry = (c.registered.mock.calls as [string, unknown, unknown][]).find(([name]) => name === 'agents')!;
    const all = JSON.parse((await (entry[2] as () => Promise<Result>)()).content[0]!.text);
    expect(all.find((a: { id: string }) => a.id === c.agent.id)).toMatchObject({ program: { state: 'thinking', signAt: expect.any(Number), retry: null }, failure: null, retry: null, restart: { allowed: true, reason: null } });
  });
});

describe('restart safety after the request', () => {
  it('tells the parent department head when a nested department stays silent after restart', async () => {
    const c = await stuck();
    const [product] = await c.db.insert(departments).values({ companyId: c.companyId, name: 'Checkout', parentId: c.dev.id, roleCode: 'CHECKOUT' }).returning();
    await c.db.update(agents).set({ departmentId: product!.id }).where(eq(agents.id, c.agent.id));
    c.answer(true);
    await c.run();
    const restartedAt = (await c.jobOf(c.id)).restartedAt!;
    const { checkSilentTurns } = await import('../src/modules/tasks/silent.js');
    const now = new Date(+restartedAt + 30 * MIN);
    await handleNodeMessage(c.ctx, c.identity, { type: 'job.program', jobId: c.id, state: 'thinking', since: +restartedAt, signAt: +restartedAt - MIN, screenAt: +restartedAt }, now);

    await checkSilentTurns(c.ctx, now);

    expect(await c.turnsOf(c.head.id)).toHaveLength(1);
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect(await c.turnsOf(orchestrator!.id)).toHaveLength(0);
    expect((await c.log(c.task.id)).some(e => e.text.includes(`${c.head.name} was told`))).toBe(true);
  });

  it.each([false, true])('applies a late restart answer with ok %s after the tool has returned', async ok => {
    const c = await stuck();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const result = c.run();
    await until(() => c.sent.mock.calls.some(([, m]) => m.type === 'agent.restart'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await result).content[0]!.text).toContain('may have happened');
    const reason = ok ? null : 'A tool started before the restart.';

    await handleNodeMessage(c.ctx, c.identity, { type: 'agent.restarted', agentKey: c.agent.id, jobId: c.id, ok, reason });

    expect((await c.jobOf(c.id)).restartedAt === null).toBe(!ok);
    const text = ok ? 'The node restarted the program in the same session.' : reason!;
    expect((await c.db.select().from(agentEvents)).some(e => (e.data as { text?: string }).text === text)).toBe(true);
    expect((await c.db.select().from(taskEvents)).some(e => e.text === `${c.agent.name}: ${text}`)).toBe(true);
  });

  it('accepts retrying at the exact provider threshold and ignores a reply from another node', async () => {
    const c = await stuck('codex');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    onTestFinished(() => clock.mockRestore());
    await c.report('retrying', 30);
    c.sent.mockImplementation((to, msg) => {
      if (msg.type === 'agent.restart') queueMicrotask(() => {
        void handleNodeMessage(c.ctx, nodeIdentity(c.sub.id), { type: 'agent.restarted', jobId: c.id, agentKey: c.agent.id, ok: false, reason: 'Wrong node' });
        void handleNodeMessage(c.ctx, c.identity, { type: 'agent.restarted', jobId: c.id, agentKey: c.agent.id, ok: true, reason: null });
      });
      return true;
    });
    expect((await c.run()).isError).toBeFalsy();
    expect((await c.jobOf(c.id)).restartedAt).not.toBeNull();
  });

  it('keeps an unanswered restart counted after 15 seconds and reports the uncertainty', async () => {
    const c = await stuck();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const result = c.run();
    /* Real immediate turns let the database finish before advancing the reply deadline. */
    await until(() => c.sent.mock.calls.some(([, m]) => m.type === 'agent.restart'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await result).content[0]!.text).toContain('may have happened');
    expect((await c.jobOf(c.id)).restartedAt).not.toBeNull();
  });

  it('tells the head once when a restarted program still gives no sign, with a line in each log', async () => {
    const c = await stuck();
    c.answer(true);
    await c.run();
    const restartAt = (await c.jobOf(c.id)).restartedAt!;
    const { checkSilentTurns } = await import('../src/modules/tasks/silent.js');
    await handleNodeMessage(c.ctx, c.identity, { type: 'job.program', jobId: c.id, state: 'thinking', since: +restartAt, signAt: +restartAt - MIN, screenAt: +restartAt }, new Date(+restartAt + 30 * MIN));
    await checkSilentTurns(c.ctx, new Date(+restartAt + 30 * MIN));
    expect(await c.turnsOf(c.head.id)).toHaveLength(1);
    expect((await c.turnsOf(c.head.id))[0]!.prompt).toContain('already');
    await checkSilentTurns(c.ctx, new Date(+restartAt + 31 * MIN));
    expect(await c.turnsOf(c.head.id)).toHaveLength(1);
    expect((await c.db.select().from(taskEvents)).some(e => /Hana was told/.test(e.text))).toBe(true);
  });
});
