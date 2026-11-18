import { and, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, machines, nodes, pendingWakes, people, requests, subscriptions, taskEvents, tasks, testRuns } from '../src/db/schema.js';
import { pump } from '../src/modules/conversation/queue.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';
import { handleNodeClose, handleNodeMessage } from '../src/modules/nodes/messages.js';
import { submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { createRoute, routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { setUpCompany, testApp, echelonsTurn } from './helpers.js';

const MIN = 60_000;

async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const ctx = app.ctx;
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, name, kind, roleKey, departmentId: dev!.id, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const tess = await hire('Tess', 'worker', 'DEV-TEST');
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
  ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const ready = vi.spyOn(ctx.hub, 'isReady').mockReturnValue(true);
  vi.spyOn(ctx.hub, 'hasTerminals').mockReturnValue(false);
  const send = vi.spyOn(ctx.hub, 'send').mockReturnValue(true);
  const turn = await echelonsTurn(db, companyId);
  let number = 0;
  const at = new Date(Date.now() - 10 * MIN);
  const task = async (set: Partial<typeof tasks.$inferInsert> = {}) => {
    const [row] = await db.insert(tasks).values({ companyId, number: ++number, title: 'Checkout API', small: true, departmentId: dev!.id, assigneeAgentId: bruno.id, executorAgentId: bruno.id, turnId: turn.id, createdByAgentId: head.id, createdAt: at, updatedAt: at, ...set }).returning();
    await db.transaction(tx => createRoute(tx, row!, { paths: ['logic/totals.ts'], reviewerAgentId: rita.id, testsAgentId: tess.id }, developmentStages()));
    await db.insert(taskEvents).values({ companyId, taskId: row!.id, kind: 'created', agentId: head.id, createdAt: at });
    return row!;
  };
  const ageMoves = async (id: string) => {
    await db.update(taskEvents).set({ createdAt: at }).where(eq(taskEvents.taskId, id));
    await db.update(tasks).set({ updatedAt: at }).where(eq(tasks.id, id));
    await db.update(pendingWakes).set({ createdAt: at }).where(eq(pendingWakes.taskId, id));
  };
  const reviewTask = async (set: Partial<typeof tasks.$inferInsert> = {}) => {
    const row = await task(set);
    const result = await submit(ctx, bruno.id, row.id, { summary: 'Candidate', evidence: 'Changed total tests.', review: { baseCommit: BASE } });
    await ageMoves(row.id);
    return result.task;
  };
  const snapshot = async (id: string) => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    return routeSnapshot(await routeOf(db, row!), row!.assigneeAgentId);
  };
  const job = async (set: Partial<typeof jobs.$inferInsert> = {}) =>
    (await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: bruno.id, kind: 'conversation', prompt: 'Work on it.', timeoutMs: 2 * 3_600_000, createdAt: at, ...set }).returning())[0]!;
  const turnsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId));
  /* The clock stands still from the round that queues a review until dueReview saw it held, so its settling delay cannot
     run out on a slow machine. */
  const stopClock = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
  };
  /* Review keeps its normal settling delay; then the fixture advances that one queued deadline. */
  const dueReview = async (agentId: string) => {
    const [queued] = await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued')));
    expect(queued).toMatchObject({ notBefore: expect.any(Date), startedAt: null });
    expect(queued!.notBefore!.getTime()).toBeGreaterThan(Date.now());
    expect(send).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'job.run', jobId: queued!.id }));
    vi.useRealTimers();
    await db.update(jobs).set({ notBefore: at }).where(eq(jobs.id, queued!.id));
    await pump(ctx, agentId);
  };
  const round = async (now = new Date()) => {
    const errors: unknown[] = [];
    await minuteRound(ctx, now, () => err => errors.push(err));
    expect(errors).toEqual([]);
  };
  return { ctx, db, companyId, ceo: ceo!, sub: sub!, head, bruno, rita, tess, ready, send, at, task, reviewTask, ageMoves, snapshot, job, turnsOf, stopClock, dueReview, round };
}

type Company = Awaited<ReturnType<typeof company>>;
type Task = typeof tasks.$inferSelect;

async function personalMachines(c: Company) {
  const [plan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, ownerPersonId: c.ceo.id, provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready' }).returning();
  const joined = [];
  for (const hostname of ['laptop', 'desktop']) {
    const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ceo.id, machineKey: hostname, hostname }).returning();
    const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: plan!.id, keyHash: hostname, status: 'ready', version: '0.5.0' }).returning();
    joined.push(node!);
  }
  return { plan: plan!, laptop: joined[0]!, desktop: joined[1]! };
}

const waitingCases: { why: string; hold(c: Company, task: Task): Promise<unknown> | void }[] = [
  { why: 'off', hold: c => c.db.update(agents).set({ switchedOffAt: c.at }).where(eq(agents.id, c.bruno.id)) },
  { why: 'removed', hold: c => c.db.update(agents).set({ removedAt: c.at }).where(eq(agents.id, c.bruno.id)) },
  { why: 'no subscription', hold: c => c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.bruno.id)) },
  { why: 'removed subscription', hold: c => c.db.update(subscriptions).set({ removedAt: c.at }).where(eq(subscriptions.id, c.sub.id)) },
  { why: 'not ready', hold: c => { c.ready.mockReturnValue(false); } },
  { why: 'busy', hold: c => c.job({ status: 'running', startedAt: c.at }) },
  { why: 'queued', hold: c => c.job() },
  { why: 'pending wake', hold: (c, task) => c.db.insert(pendingWakes).values({ companyId: c.companyId, taskId: task.id, agentId: c.bruno.id, why: 'assigned' }) },
  { why: 'after', hold: async (c, task) => {
    const before = await c.task({ assigneeAgentId: null });
    await c.db.update(tasks).set({ after: [before.id] }).where(eq(tasks.id, task.id));
  } },
  { why: 'request', hold: (c, task) => c.db.insert(requests).values({ companyId: c.companyId, taskId: task.id, agentId: c.bruno.id, kind: 'question', text: 'Which total?' }) },
  { why: 'tests', hold: async (c, task) => {
    const job = await c.job({ agentId: c.head.id, status: 'done', finishedAt: c.at });
    await c.db.insert(testRuns).values({ companyId: c.companyId, number: 1, taskId: task.id, agentId: c.bruno.id, jobId: job.id, command: 'npm test', timeoutMs: 30 * MIN });
  } },
  ...(['waiting', 'done', 'cancelled'] as const).map(status => ({ why: status, hold: (c: Company, task: Task) => c.db.update(tasks).set({ status, closedAt: c.at }).where(eq(tasks.id, task.id)) })),
];

describe('turns on a machine that went away', () => {
  it('keeps running and queued conversations through a 60-second disconnect and accepts the result after return', async () => {
    const c = await company();
    const task = await c.task({ status: 'working' });
    const running = await c.job({ taskId: task.id, status: 'running', startedAt: new Date(c.at.getTime() + MIN) });
    const queued = await c.job({ taskId: task.id, prompt: 'Wait for the current turn.' });
    c.ready.mockReturnValue(false);
    await handleNodeClose(c.ctx, BUILTIN);
    const away = c.ctx.hub.awaySince(BUILTIN)!;

    await c.round(new Date(away + MIN));
    expect((await c.turnsOf(c.bruno.id)).find(j => j.id === running.id)).toMatchObject({ status: 'running', error: null });
    expect((await c.turnsOf(c.bruno.id)).find(j => j.id === queued.id)).toMatchObject({ status: 'queued', error: null });

    await handleNodeMessage(c.ctx, BUILTIN, { type: 'hello', version: '0.6.1', loggedIn: true, running: [running.id] });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.event', jobId: running.id, seq: 0, event: { kind: 'text', text: 'Kept while away.' } });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: running.id, ok: true, result: 'Done after return.', tail: 'Kept while away.', error: null, sessionId: 'back-session' });

    expect((await c.turnsOf(c.bruno.id)).find(j => j.id === running.id)).toMatchObject({ status: 'done', result: 'Done after return.', sessionId: 'back-session', error: null });
    expect((await c.turnsOf(c.bruno.id)).find(j => j.id === queued.id)).toMatchObject({ status: 'queued', error: null });
    expect(await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, running.id), eq(agentEvents.kind, 'failed')))).toEqual([]);
    const { agentFailureState } = await import('../src/modules/tasks/failures.js');
    expect((await agentFailureState(c.ctx, c.bruno.id)).failure).toBeNull();
    expect(c.send).not.toHaveBeenCalledWith(BUILTIN, { type: 'job.cancel', jobId: running.id });
    expect(c.send).toHaveBeenCalledWith(BUILTIN, { type: 'job.ack', jobId: running.id });
  });

  it('keeps a turn on a task whose machine is away, tells whoever gave the task once, and goes on when the machine is back', async () => {
    const c = await company();
    const task = await c.task({ status: 'working' });
    /* A turn young enough that its machine going away is all that happens to it: no quiet alarm falls due meanwhile. */
    const job = await c.job({ taskId: task.id, status: 'running', startedAt: new Date(c.at.getTime() + 9 * MIN) });
    c.ready.mockReturnValue(false);
    await handleNodeClose(c.ctx, BUILTIN);
    const away = c.ctx.hub.awaySince(BUILTIN)!;
    const noted = () => c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'away')));
    const heard = async () => (await c.turnsOf(c.head.id)).filter(j => j.prompt.includes('Hornhoof cannot reach') || j.prompt.includes('in reach again'));
    await c.round(new Date(away + 5 * MIN));
    expect([await noted(), await heard()]).toEqual([[], []]);
    await c.round(new Date(away + 5 * MIN + 1));
    /* The turn is not failed and nothing is queued in its place: the work on that machine is kept. */
    expect(await c.turnsOf(c.bruno.id)).toMatchObject([{ id: job.id, status: 'running', error: null }]);
    /* The line is Hornhoof's own, of nobody's doing: it is no move of the task. */
    expect(await noted()).toMatchObject([{ agentId: null, data: { job: job.id, stage: 'away', holder: c.bruno.id } }]);
    const [told] = await heard();
    expect(told!.prompt).toContain(`Bruno's turn on #${task.number} "Checkout API" runs on the server's own machine, which Hornhoof cannot reach since`);
    expect(told!.prompt).toContain(`The work on that machine is kept, not lost, and the turn goes on when the machine comes back. #${task.number} stays with Bruno.`);
    /* With when to hand it on, said where it is needed: the standing rules of a head have no room for it. */
    expect(told!.prompt).toContain(`Hand #${task.number} to someone else only if it cannot wait for that machine: someone is blocked by it, or it was promised for a date. A new holder starts from what was handed in or pushed; what stayed only on that machine stays there until it is back.`);
    /* Told once, however long the machine stays away. */
    await c.round(new Date(away + 6 * MIN));
    await c.round(new Date(away + 90 * MIN));
    expect([(await noted()).length, (await heard()).length]).toEqual([1, 1]);
    expect(await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, job.id), eq(agentEvents.kind, 'failed')))).toEqual([]);

    /* The machine is back with the turn still running: nothing is stopped, and whoever gave the task hears that too. */
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'hello', version: '0.5.0', loggedIn: true, running: [job.id] });
    expect(c.send).not.toHaveBeenCalledWith(BUILTIN, { type: 'job.cancel', jobId: job.id });
    vi.spyOn(c.ctx.hub, 'awaySince').mockReturnValue(null);
    /* Not before its node said hello again, which may still end a turn the machine no longer runs. */
    await c.round(new Date(away + 91 * MIN - 1));
    expect((await noted()).length).toBe(1);
    c.ready.mockReturnValue(true);
    await c.round(new Date(away + 91 * MIN));
    await c.round(new Date(away + 92 * MIN));
    expect((await noted()).map(e => (e.data as { stage: string }).stage)).toEqual(['away', 'back']);
    /* Heard in a turn of its own, or with the notice that waited for the machine in line. */
    expect((await heard()).some(j => j.prompt.includes('in reach again'))).toBe(true);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: job.id, ok: true, result: 'Done after all.', tail: '', error: null, sessionId: 'kept-session' });
    expect((await c.turnsOf(c.bruno.id)).find(j => j.id === job.id)).toMatchObject({ status: 'done', result: 'Done after all.' });
  });

  it('ends the turn as handed on when the task went to someone else while its machine was away', async () => {
    const c = await company();
    const task = await c.task({ status: 'working' });
    const job = await c.job({ taskId: task.id, status: 'running', startedAt: new Date(c.at.getTime() + 9 * MIN) });
    c.ready.mockReturnValue(false);
    await handleNodeClose(c.ctx, BUILTIN);
    const away = c.ctx.hub.awaySince(BUILTIN)!;
    await c.round(new Date(away + 5 * MIN + 1));
    expect(await c.turnsOf(c.bruno.id)).toMatchObject([{ id: job.id, status: 'running' }]);
    /* The head gave the task to Rita. */
    await c.db.update(tasks).set({ assigneeAgentId: c.rita.id, executorAgentId: c.rita.id }).where(eq(tasks.id, task.id));
    await c.round(new Date(away + 7 * MIN));
    /* The old turn is over, as one Hornhoof ended on purpose: nothing runs it again. */
    expect(await c.turnsOf(c.bruno.id)).toMatchObject([{ id: job.id, status: 'failed', error: 'handed_on' }]);
    /* Back, the machine is told to stop it. */
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'hello', version: '0.5.0', loggedIn: true, running: [job.id] });
    expect(c.send).toHaveBeenCalledWith(BUILTIN, { type: 'job.cancel', jobId: job.id });
  });

  it('ends a turn of someone who does not hold the task as before, and closes the note of a kept turn that ended', async () => {
    const c = await company();
    const task = await c.task({ status: 'working' });
    /* The head's own turn about the task, on the same machine: it is not the task's work, so it ends and goes on by
       the failed-turn path, and the head is free for what comes to it. */
    const about = await c.job({ taskId: task.id, agentId: c.head.id, status: 'running', startedAt: new Date(c.at.getTime() + 9 * MIN) });
    const job = await c.job({ taskId: task.id, status: 'running', startedAt: new Date(c.at.getTime() + 9 * MIN) });
    c.ready.mockReturnValue(false);
    await handleNodeClose(c.ctx, BUILTIN);
    const away = c.ctx.hub.awaySince(BUILTIN)!;
    await c.round(new Date(away + 5 * MIN + 1));
    expect((await c.turnsOf(c.head.id)).find(j => j.id === about.id)).toMatchObject({ status: 'failed', error: 'machine_offline' });
    expect((await c.turnsOf(c.bruno.id)).find(j => j.id === job.id)).toMatchObject({ status: 'running' });
    const stages = async () => (await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'away')))).map(e => (e.data as { stage: string }).stage);
    expect(await stages()).toEqual(['away']);
    /* The machine comes back without the turn: its hello ends it. The log says once that the turn is over, so no
       line is left that promises it goes on. */
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
    expect((await c.turnsOf(c.bruno.id)).find(j => j.id === job.id)).toMatchObject({ status: 'failed', error: 'machine_restarted' });
    await c.round(new Date(away + 7 * MIN));
    await c.round(new Date(away + 8 * MIN));
    expect(await stages()).toEqual(['away', 'ended']);
  });

  it('fails a turn of no task after five minutes away, as before', async () => {
    const c = await company();
    const job = await c.job({ status: 'running', startedAt: new Date(c.at.getTime() + 9 * MIN) });
    c.ready.mockReturnValue(false);
    await handleNodeClose(c.ctx, BUILTIN);
    const away = c.ctx.hub.awaySince(BUILTIN)!;
    await c.round(new Date(away + 5 * MIN));
    expect((await c.turnsOf(c.bruno.id))[0]!.status).toBe('running');
    await c.round(new Date(away + 5 * MIN + 1));
    expect((await c.turnsOf(c.bruno.id)).find(j => j.id === job.id)).toMatchObject({ status: 'failed', error: 'machine_offline', finishedAt: expect.any(Date) });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'hello', version: '0.5.0', loggedIn: true, running: [job.id] });
    expect(c.send).toHaveBeenCalledWith(BUILTIN, { type: 'job.cancel', jobId: job.id });
  });

  it('leaves online jobs, queued turns and test jobs alone', async () => {
    const c = await company();
    const running = await c.job({ status: 'running', startedAt: c.at });
    const waiting = await c.job();
    const testing = await c.job({ kind: 'test', status: 'running', startedAt: c.at });
    vi.spyOn(c.ctx.hub, 'awaySince').mockReturnValue(null);
    await c.round();
    expect(await c.turnsOf(c.bruno.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: running.id, status: 'running' }),
      expect.objectContaining({ id: waiting.id, status: 'queued' }),
      expect.objectContaining({ id: testing.id, status: 'running' }),
    ]));
  });

  /* As a plan's machines set up again leave its turns: no machine can run such a turn or end it, and none is away. */
  it('ends a running personal-plan job without a node as lost, not as one of a machine that went away', async () => {
    const c = await company();
    const { plan } = await personalMachines(c);
    const job = await c.job({ subscriptionId: plan.id, nodeId: null, status: 'running', startedAt: c.at });
    const away = vi.spyOn(c.ctx.hub, 'awaySince').mockReturnValue(c.at.getTime());
    await c.round();
    expect(await c.turnsOf(c.bruno.id)).toEqual([expect.objectContaining({ id: job.id, status: 'failed', error: 'machine_restarted' })]);
    expect(away).not.toHaveBeenCalled();
  });

  it('continues a failed review on another ready machine of its plan', async () => {
    const c = await company();
    const { plan, laptop, desktop } = await personalMachines(c);
    await c.db.update(agents).set({ subscriptionId: plan.id, nodeId: laptop.id }).where(eq(agents.id, c.rita.id));
    const task = await c.reviewTask();
    const job = await c.job({ subscriptionId: plan.id, nodeId: laptop.id, agentId: c.rita.id, taskId: task.id, status: 'running', startedAt: new Date(c.at.getTime() + MIN) });
    c.ready.mockImplementation(id => id.kind === 'builtin' || id.nodeId === desktop.id);
    vi.spyOn(c.ctx.hub, 'awaySince').mockImplementation(id => id.kind === 'node' && id.nodeId === laptop.id ? c.at.getTime() : null);
    c.stopClock();
    await c.round();
    await c.dueReview(c.rita.id);
    expect(await c.turnsOf(c.rita.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: job.id, status: 'failed', error: 'machine_offline' }),
      expect.objectContaining({ taskId: task.id, status: 'running', nodeId: desktop.id }),
    ]));
    expect(c.send).toHaveBeenCalledWith(nodeIdentity(desktop.id), expect.objectContaining({ type: 'job.run' }));
  });
});

describe('work whose move lost its wake', () => {
  it.each(['worker', 'head'] as const)('does not wake a %s that moved it during its turn', async kind => {
    const c = await company();
    const agent = kind === 'worker' ? c.bruno : c.head;
    const task = await c.task({ status: 'working', assigneeAgentId: agent.id, executorAgentId: kind === 'worker' ? agent.id : null });
    const job = await c.job({ agentId: agent.id, taskId: kind === 'worker' ? task.id : null, status: 'running', startedAt: new Date(Date.now() - MIN) });
    if (kind === 'worker') await submit(c.ctx, agent.id, task.id, { summary: 'Candidate', evidence: 'Changed total tests.', review: { baseCommit: BASE } });
    else await updateTask(c.ctx, agent.id, task.id, { body: 'The total includes tax.' });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: job.id, ok: true, result: 'Moved the task.', tail: '', error: null, sessionId: null });
    await c.round(new Date(Date.now() + 3 * MIN));
    expect(await c.turnsOf(agent.id)).toEqual([expect.objectContaining({ id: job.id, status: 'done' })]);
  });

  it.each([
    { when: 'during its running job', minutes: 2, count: 1 },
    { when: 'before its job started', minutes: 0.5, count: 2 },
    { when: 'after its job ended', minutes: 4, count: 2 },
  ])('counts a move $when only if that turn covered it', async ({ minutes, count }) => {
    const c = await company();
    const task = await c.task({ status: 'working' });
    const job = await c.job({ taskId: task.id, status: 'running', startedAt: new Date(c.at.getTime() + MIN) });
    const movedAt = new Date(c.at.getTime() + minutes * MIN);
    await c.db.insert(taskEvents).values({ companyId: c.companyId, taskId: task.id, kind: 'updated', agentId: c.head.id, createdAt: movedAt });
    await c.db.update(tasks).set({ updatedAt: movedAt }).where(eq(tasks.id, task.id));
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date(c.at.getTime() + 3 * MIN) }).where(eq(jobs.id, job.id));
    await c.round(new Date(c.at.getTime() + 7 * MIN));
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(count);
  });

  it.each(['open', 'working', 'review', 'waiting', 'blocked'] as const)('leaves a parent waiting for its %s subtask', async status => {
    const c = await company();
    const parent = await c.task({ status: 'working', assigneeAgentId: c.head.id, executorAgentId: null });
    await c.db.update(taskEvents).set({ agentId: null, personId: c.ceo.id }).where(eq(taskEvents.taskId, parent.id));
    await c.task({ parentId: parent.id, status, assigneeAgentId: null });
    await c.round();
    expect(await c.turnsOf(c.head.id)).toHaveLength(0);
  });

  it.each(['done', 'cancelled'] as const)('counts a turn on a %s subtask for its parent', async status => {
    const c = await company();
    const parent = await c.task({ status: 'working' });
    const child = await c.task({ parentId: parent.id, status, closedAt: new Date(c.at.getTime() + 2 * MIN) });
    const job = await c.job({ taskId: child.id, status: 'done', createdAt: new Date(c.at.getTime() + MIN), finishedAt: new Date(c.at.getTime() + 2 * MIN) });
    await c.round();
    expect(await c.turnsOf(c.bruno.id)).toEqual([expect.objectContaining({ id: job.id, status: 'done' })]);
  });

  it.each(['open', 'working', 'review'] as const)('recovers the assignee of an old %s task once per move', async status => {
    const c = await company();
    const task = status === 'review' ? await c.reviewTask() : await c.task({ status });
    const owner = status === 'review' ? c.rita : c.bruno;
    if (status === 'review') c.stopClock();
    await c.round();
    if (status === 'review') await c.dueReview(owner.id);
    const [job] = await c.turnsOf(owner.id);
    expect(job).toMatchObject({ kind: 'conversation', taskId: task.id, status: 'running' });
    expect(await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, job!.id))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'message' })]));
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date(Date.now() - 3 * MIN) }).where(eq(jobs.id, job!.id));
    await c.round();
    expect(await c.turnsOf(owner.id)).toHaveLength(1);
    /* A later move can need a new turn even though the earlier one already ran. */
    const movedAt = new Date(Date.now() - 3 * MIN);
    await c.db.update(jobs).set({ createdAt: c.at }).where(eq(jobs.id, job!.id));
    await c.db.insert(taskEvents).values({ companyId: c.companyId, taskId: task.id, kind: 'updated', createdAt: movedAt });
    await c.db.update(tasks).set({ updatedAt: movedAt }).where(eq(tasks.id, task.id));
    await c.round();
    expect(await c.turnsOf(owner.id)).toHaveLength(2);
  });

  it('waits more than two minutes after the move and after the agent was last busy', async () => {
    const c = await company();
    const now = new Date();
    const movedAt = new Date(now.getTime() - 2 * MIN);
    const task = await c.task({ createdAt: movedAt, updatedAt: movedAt });
    await c.db.update(taskEvents).set({ createdAt: movedAt }).where(eq(taskEvents.taskId, task.id));
    await c.round(now);
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(0);
    const other = await c.job({ status: 'done', finishedAt: now });
    await c.round(new Date(now.getTime() + 2 * MIN));
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(1);
    await c.round(new Date(now.getTime() + 2 * MIN + 1));
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.id !== other.id)).toEqual([expect.objectContaining({ taskId: task.id, status: 'running' })]);
  });

  it('recovers only the current Review owner and its exact candidate in an open turn', async () => {
    const c = await company();
    const task = await c.reviewTask();
    const snapshot = await c.snapshot(task.id);
    c.stopClock();
    await c.round();
    await c.dueReview(c.rita.id);
    const [job] = await c.turnsOf(c.rita.id);
    expect(job).toMatchObject({ taskId: task.id, status: 'running' });
    const messages = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, job!.id), eq(agentEvents.kind, 'message')));
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ taskWake: expect.objectContaining({ stage: 'review', candidateId: snapshot.candidateId }) }) })]));
    expect(await c.turnsOf(c.head.id)).toHaveLength(0);
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(0);
    expect(await c.snapshot(task.id)).toMatchObject({ stage: 'review', ownerAgentId: c.rita.id, candidateId: snapshot.candidateId });
  });

  it('recovers Tests after a passed Review without waking the former checker', async () => {
    const c = await company();
    const task = await c.reviewTask();
    await verdict(c.ctx, c.rita.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Checked the candidate.' });
    await c.ageMoves(task.id);
    const snapshot = await c.snapshot(task.id);
    await c.round();
    expect(await c.turnsOf(c.rita.id)).toHaveLength(0);
    expect(await c.turnsOf(c.head.id)).toHaveLength(0);
    const [job] = await c.turnsOf(c.tess.id);
    expect(job).toMatchObject({ taskId: task.id, status: 'running' });
    const messages = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, job!.id), eq(agentEvents.kind, 'message')));
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ taskWake: expect.objectContaining({ stage: 'tests', candidateId: snapshot.candidateId }) }) })]));
    expect((await c.snapshot(task.id)).stage).toBe('tests');
  });

  it('recovers the giver of blocked work instead of its executor', async () => {
    const c = await company();
    const task = await c.task({ status: 'blocked' });
    await c.db.insert(taskEvents).values({ companyId: c.companyId, taskId: task.id, kind: 'blocked', agentId: c.bruno.id, text: 'Need access.', createdAt: c.at });
    await c.round();
    expect(await c.turnsOf(c.head.id)).toEqual([expect.objectContaining({ taskId: task.id, prompt: expect.stringContaining('Need access.') })]);
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(0);
  });

  it('recovers the head for a wrong-goal escalation without returning work to its author', async () => {
    const c = await company();
    const task = await c.reviewTask();
    await verdict(c.ctx, c.rita.id, task.id, { pass: false, reviewedCommit: HEAD, escalate: true, comment: 'The requested currency behavior is different.' });
    await c.ageMoves(task.id);
    await c.round();
    expect(await c.turnsOf(c.head.id)).toEqual([expect.objectContaining({ taskId: task.id, prompt: expect.stringContaining('The requested currency behavior is different.') })]);
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(0);
    expect(await c.snapshot(task.id)).toMatchObject({ stage: 'review', phase: 'escalated', ownerAgentId: null });
  });

  it('keeps repeated ordinary findings with the checker without calling in the head or author', async () => {
    const c = await company();
    const task = await c.reviewTask();
    const candidateId = (await c.snapshot(task.id)).candidateId;
    for (let finding = 0; finding < 3; finding++) await verdict(c.ctx, c.rita.id, task.id, { pass: false, reviewedCommit: HEAD, comment: `Repair finding ${finding + 1} in the same branch.` });
    await c.ageMoves(task.id);
    await c.round();
    expect(await c.turnsOf(c.head.id)).toHaveLength(0);
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(0);
    expect(await c.snapshot(task.id)).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: c.rita.id, candidateId });
  });

  it.each(waitingCases)('leaves work waiting when it is $why', async ({ hold }) => {
    const c = await company();
    const task = await c.task();
    await hold(c, task);
    await c.round();
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.taskId === task.id)).toHaveLength(0);
  });

  it.each(['comment', 'reminded', 'continued', 'stuck'] as const)('does not treat %s as a new move after a turn ended', async kind => {
    const c = await company();
    const task = await c.task();
    await c.job({ taskId: task.id, status: 'done', createdAt: new Date(c.at.getTime() + MIN), finishedAt: new Date(c.at.getTime() + 2 * MIN) });
    await c.db.insert(taskEvents).values({ companyId: c.companyId, taskId: task.id, kind, agentId: c.bruno.id, createdAt: new Date(c.at.getTime() + 3 * MIN) });
    await c.db.update(tasks).set({ updatedAt: new Date(c.at.getTime() + 3 * MIN) }).where(eq(tasks.id, task.id));
    await c.round();
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(1);
  });

  it('recovers an old task without move history and queues it once across overlapping rounds', async () => {
    const c = await company();
    const task = await c.task();
    await c.db.delete(taskEvents).where(eq(taskEvents.taskId, task.id));
    await Promise.all([c.round(), c.round()]);
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(1);
  });
});
