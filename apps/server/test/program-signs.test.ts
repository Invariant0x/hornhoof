import type { ProgramState } from '@hornhoof/protocol';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, jobs, tasks } from '../src/db/schema.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createRoute, routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { agentProgramState, checkSilentTurns, SILENT_TURN_MS } from '../src/modules/tasks/silent.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { failureCompany } from './failure-company.js';

const MIN = 60_000;
/* The company with a program operator in Operations, who sees the screens. */
async function company() {
  const c = await failureCompany();
  return { ...c, operator: await c.hire('Olga', 'worker', 'OPS-PROGRAM', c.ops.id) };
}
function alarmsAbout(c: Awaited<ReturnType<typeof company>>, id: string) {
  return c.db.select({ agentId: agentEvents.agentId }).from(agentEvents)
    .where(and(eq(agentEvents.kind, 'message'), sql`split_part(${agentEvents.data}->>'silentJob', ':', 1) = ${id}`));
}
/* A working task with its required route, and a turn that carries the wake state a real assignment leaves. */
async function taskTurn(c: Awaited<ReturnType<typeof company>>) {
  const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 1, title: 'Checkout', status: 'working', assigneeAgentId: c.agent.id }).returning();
  await c.db.transaction(tx => createRoute(tx, task!, {}, developmentStages()));
  const taskWake = taskWakeOf(task!, { why: 'go_on' }, routeSnapshot(await routeOf(c.db, task!), task!.assigneeAgentId));
  const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, taskId: task!.id, prompt: 'Work', createdBy: null, message: { personId: null, text: 'Work', taskWake } });
  return { task, id };
}
describe('silence measured by signs of life', () => {
  it.each(['done', 'cancelled'] as const)('stops silent work on a %s task before it can call Operations', async status => {
    const c = await company();
    const { task, id } = await taskTurn(c);
    const now = Date.now();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'thinking', since: now - 31 * MIN, screenAt: now, signAt: now - 31 * MIN }, new Date(now));
    await c.db.update(tasks).set({ status, closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task!.id));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(await c.jobOf(id)).toMatchObject({ status: 'failed', error: 'stale' });
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
    expect(c.sent.mock.calls).toContainEqual([BUILTIN, { type: 'job.cancel', jobId: id }]);
    expect((await c.log(task!.id)).filter(e => e.kind === 'wake_skipped')).toHaveLength(1);
  });

  it('keeps the last program evidence and redacted 200-line tail when running work becomes stale', async () => {
    const c = await company();
    const { task, id } = await taskTurn(c);
    const now = Date.now();
    const signAt = now - 121 * MIN;
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'tool', tool: 'Bash', since: signAt - MIN, screenAt: now, signAt }, new Date(now));
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task!.id));
    await checkSilentTurns(c.ctx, new Date(now));

    const stale = await c.jobOf(id);
    expect(stale).toMatchObject({ status: 'failed', error: 'stale', tail: 'No output.', failure: { kind: 'unknown', retryable: false } });
    expect(stale.failure!.text).toContain('Program state: tool (Bash)');
    expect(stale.failure!.text).toContain(`Last sign of life: ${new Date(signAt).toISOString()}`);
    expect(stale.result).toBe(stale.failure!.text);
    expect(stale.result).not.toContain('Wake-up became obsolete');

    const lines = Array.from({ length: 205 }, (_, i) => `line ${i + 1}`);
    lines[204] = 'last [hidden] line';
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: id, ok: false, sessionId: 'session', result: 'Stopped.', tail: lines.join('\n'), error: 'cancelled' });

    const ended = await c.jobOf(id);
    expect(ended).toMatchObject({ status: 'failed', error: 'stale', failure: stale.failure });
    expect(ended.tail).toBe(lines.slice(-200).join('\n'));
    expect(ended.tail).not.toContain('line 1\n');
    const card = (await c.app.inject({ url: `/api/agents/${c.agent.id}`, ...c.as(c.ceo) })).json();
    expect(card.failure).toMatchObject({ text: stale.failure!.text, tail: ended.tail });
  });

  it('says when a running stale turn never reported its program state or a sign of life', async () => {
    const c = await company();
    const { task, id } = await taskTurn(c);
    const now = Date.now();
    await c.db.update(jobs).set({ startedAt: new Date(now - 31 * MIN) }).where(eq(jobs.id, id));
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task!.id));

    await checkSilentTurns(c.ctx, new Date(now));

    const stale = await c.jobOf(id);
    expect(stale).toMatchObject({ status: 'failed', error: 'stale', tail: 'No output.' });
    expect(stale.failure!.text).toContain('Program state: no data');
    expect(stale.failure!.text).toContain('Last sign of life: no data');
  });

  it.each<[ProgramState, number]>([['thinking', 10], ['retrying', 10], ['idle', 10], ['tool', 30]])('%s alarms at %i minutes since the sign, even while the screen changes, and whoever sees its screen is told', async (state, minutes) => {
    const c = await company();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const signAt = Date.now();
    const report = (now: number, lastSign = signAt) => handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state, since: signAt - MIN, screenAt: now, signAt: lastSign, ...(state === 'retrying' ? { retry: { attempt: 2, max: 5, nextAt: null } } : {}), ...(state === 'tool' ? { tool: 'Bash' } : {}) }, new Date(now));
    await report(signAt + minutes * MIN - 1);
    await checkSilentTurns(c.ctx, new Date(signAt + minutes * MIN - 1));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
    await report(signAt + minutes * MIN);
    await checkSilentTurns(c.ctx, new Date(signAt + minutes * MIN));
    expect(agentProgramState(c.ctx, { id }).alarm).toEqual({ reason: 'program_stalled', since: signAt });
    const notices = await c.turnsOf(c.operator.id);
    expect(notices).toHaveLength(1);
    for (const fact of [state, new Date(signAt).toISOString(), 'Last sign', `program_screen for employee ${c.agent.id}`, 'restart_program', 'outside any task']) expect(notices[0]!.prompt).toContain(fact);
    if (state === 'retrying') expect(notices[0]!.prompt).toContain('2 of 5');
    await checkSilentTurns(c.ctx, new Date(signAt + minutes * MIN + 1));
    expect(await c.turnsOf(c.operator.id)).toHaveLength(1);
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
    await report(signAt + minutes * MIN + 2, signAt + minutes * MIN + 2);
    await checkSilentTurns(c.ctx, new Date(signAt + minutes * MIN + 2));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
  });

  it('counts the quiet from the turn start while the program gave no sign yet', async () => {
    const c = await company();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const job = await c.jobOf(id);
    const start = (job!.startedAt ?? job!.createdAt).getTime();
    const report = (now: number) => handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'thinking', since: start, screenAt: now, signAt: 0 }, new Date(now));
    await report(start + 2000);
    await checkSilentTurns(c.ctx, new Date(start + 2000));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
    expect(await c.turnsOf(c.operator.id)).toEqual([]);
    await report(start + 10 * MIN);
    await checkSilentTurns(c.ctx, new Date(start + 10 * MIN));
    expect(agentProgramState(c.ctx, { id }).alarm).toEqual({ reason: 'program_stalled', since: start });
    const notices = await c.turnsOf(c.operator.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.prompt).not.toContain('1970');
    expect(notices[0]!.prompt).toContain(`Last sign: none since the turn started at ${new Date(start).toISOString()}`);
  });

  it('tells again each time the quiet doubles, and nothing in between', async () => {
    const c = await company();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const signAt = Date.now();
    const quietFor = async (minutes: number) => {
      const now = signAt + minutes * MIN;
      await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'thinking', since: signAt - MIN, screenAt: now, signAt }, new Date(now));
      await checkSilentTurns(c.ctx, new Date(now));
      return (await alarmsAbout(c, id)).length;
    };
    expect([await quietFor(10), await quietFor(19), await quietFor(20), await quietFor(39), await quietFor(40)]).toEqual([1, 1, 2, 2, 3]);
  });

  it.each([
    ['Operations head', [], 'operations'],
    ['orchestrator', ['operations'], 'orchestrator'],
    ['department head', ['operations', 'orchestrator'], 'department'],
    ['busy Operations head', ['operations', 'orchestrator', 'department'], 'operations'],
  ] as const)('tells the %s when the operator is busy and earlier recipients are silent', async (_, unavailable, expected) => {
    const c = await company();
    const operations = await c.hire('Hugo', 'head', 'OPS-HEAD', c.ops.id);
    const [orchestrator] = await c.db.select().from(agents).where(and(eq(agents.companyId, c.companyId), eq(agents.kind, 'orchestrator')));
    const recipients = { operations, orchestrator: orchestrator!, department: c.head };
    const startedAt = new Date('2026-11-03T10:00:00Z');
    const now = new Date(+startedAt + SILENT_TURN_MS);
    const running = { companyId: c.companyId, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Work', status: 'running', timeoutMs: SILENT_TURN_MS } as const;
    const [stuck] = await c.db.insert(jobs).values({ ...running, agentId: c.agent.id, startedAt }).returning();
    await c.db.insert(jobs).values([
      { ...running, agentId: c.operator.id, startedAt: now },
      ...unavailable.map(key => ({ ...running, agentId: recipients[key].id, startedAt })),
    ]);

    await checkSilentTurns(c.ctx, now);

    expect(await alarmsAbout(c, stuck!.id)).toEqual([{ agentId: recipients[expected].id }]);
  });

  it('never calls a live node asking a person silent, even after two hours without a sign', async () => {
    const c = await company();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const now = Date.now();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'asking', since: now - 180 * MIN, screenAt: now - 180 * MIN, signAt: now - 180 * MIN }, new Date(now));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
    await checkSilentTurns(c.ctx, new Date(now + 30 * MIN));
    expect(agentProgramState(c.ctx, { id }).alarm).toEqual({ reason: 'node_silent', since: now });
  });

  it('calls whoever sees the screen three minutes after a thinking program\'s screen stood still, for a window of the program may wait on it', async () => {
    const c = await company();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const signAt = Date.now(), stillSince = signAt + MIN;
    const report = (now: number) => handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'thinking', since: signAt, screenAt: stillSince, signAt }, new Date(now));
    await report(stillSince + 3 * MIN - 1);
    await checkSilentTurns(c.ctx, new Date(stillSince + 3 * MIN - 1));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
    await report(stillSince + 3 * MIN);
    await checkSilentTurns(c.ctx, new Date(stillSince + 3 * MIN));
    expect(agentProgramState(c.ctx, { id }).alarm).toEqual({ reason: 'program_stalled', since: stillSince });
    const notices = await c.turnsOf(c.operator.id);
    expect(notices).toHaveLength(1);
    for (const fact of ['screen stood still for 3 minutes', 'window', `program_screen for employee ${c.agent.id}`]) expect(notices[0]!.prompt).toContain(fact);
  });

  it('tells again each time a still screen\'s quiet doubles, and nothing in between', async () => {
    const c = await company();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const signAt = Date.now();
    const stillFor = async (minutes: number) => {
      const now = signAt + minutes * MIN;
      await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'thinking', since: signAt, screenAt: signAt, signAt }, new Date(now));
      await checkSilentTurns(c.ctx, new Date(now));
      return (await alarmsAbout(c, id)).length;
    };
    expect([await stillFor(3), await stillFor(5), await stillFor(6), await stillFor(11), await stillFor(12)]).toEqual([1, 1, 2, 2, 3]);
  });

  it.each<ProgramState>(['tool', 'retrying', 'idle'])('leaves a still screen of a %s program to the quiet of its signs', async state => {
    const c = await company();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const signAt = Date.now(), now = signAt + 9 * MIN;
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state, since: signAt, screenAt: signAt, signAt, ...(state === 'tool' ? { tool: 'Bash' } : {}), ...(state === 'retrying' ? { retry: { attempt: 2, max: 5, nextAt: null } } : {}) }, new Date(now));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
    expect(await c.turnsOf(c.operator.id)).toEqual([]);
  });

  it('keeps the older node screen rule exactly, including an asking state', async () => {
    const c = await company();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const now = Date.now();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'asking', since: now - 31 * MIN, screenAt: now - 30 * MIN }, new Date(now));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm).toEqual({ reason: 'program_stalled', since: now - 30 * MIN });
    expect((await c.db.select().from(jobs).where(eq(jobs.id, id)))[0]!.status).toBe('running');
  });
});
