import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, jobs, people, requests, taskEvents, tasks, taskWaits } from '../src/db/schema.js';
import { ask, blocked, closeTask, createTask, loadTask, submit, type Task } from '../src/modules/tasks/engine.js';
import { closedBeyond } from '../src/modules/tasks/tools.js';
import { routeOf } from '../src/modules/tasks/echelons-store.js';
import { waitFor } from '../src/modules/tasks/external-wait.js';
import { setPaused } from '../src/modules/tasks/pause.js';
import { BASE, fixture } from './development-echelons-fixture.js';
import { as, listen, mcp } from './helpers.js';
import { prepareSharedDatabase } from './helpers-db.js';

await prepareSharedDatabase();

const WHY = 'Closed by hand in the database; the work is over.';
/* The moment the wait below is placed at: a date of its own, not the clock's. */
const AT = new Date('2026-11-17T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

async function closing() {
  const f = await fixture();
  const [orchestrator] = await f.db.select().from(agents).where(and(eq(agents.companyId, f.task.companyId), eq(agents.kind, 'orchestrator')));
  const [owner] = await f.db.select().from(people).where(eq(people.companyId, f.task.companyId));
  const read = (id: string) => loadTask(f.db, id);
  const log = async (id: string) => f.db.select().from(taskEvents).where(eq(taskEvents.taskId, id)).orderBy(asc(taskEvents.id));
  const openRequests = async (id: string) => f.db.select().from(requests).where(and(eq(requests.taskId, id), eq(requests.status, 'open')));
  const openWaits = async (id: string) => f.db.select().from(taskWaits).where(and(eq(taskWaits.taskId, id), inArray(taskWaits.state, ['active', 'legacy_needs_plan'])));
  /* A group the head holds, with the member task of the fixture and another one open under it. */
  const group = async () => {
    const made = (await f.create({ title: 'Totals, all of it', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    await f.db.update(tasks).set({ parentId: made.id }).where(eq(tasks.id, f.task.id));
    const other = (await f.create({ title: 'Totals in the report', parentId: made.id })).task;
    return { group: made, under: [f.task.id, other.id] };
  };
  return { ...f, orchestrator: orchestrator!, owner: owner!, read, log, openRequests, openWaits, group };
}
type Closing = Awaited<ReturnType<typeof closing>>;

/* Each state a task can stand in as the orchestrator closes it: the task it closes, and the work under it. */
const STATES: [string, (f: Closing) => Promise<{ target: Task; under: string[] }>][] = [
  ['open', async f => ({ target: f.task, under: [] })],
  ['in work', async f => {
    await f.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, f.task.id));
    return { target: await f.read(f.task.id), under: [] };
  }],
  ['at its Review stage', async f => ({ target: (await submit(f.ctx, f.author.id, f.task.id, { summary: 'Changed the totals.', evidence: 'Totals tests pass.', review: { baseCommit: BASE } })).task, under: [] })],
  ['waiting for a person', async f => ({ target: (await ask(f.ctx, f.author.id, f.task.id, { kind: 'question', text: 'Which currency do totals use?' })).task, under: [] })],
  ['blocked', async f => ({ target: (await blocked(f.ctx, f.author.id, f.task.id, 'Which currency do totals use?')).task, under: [] })],
  ['in a wait', async f => ({ target: (await waitFor(f.ctx, f.author.id, f.task.id, { reason: 'Images build', until: new Date(AT.getTime() + HOUR).toISOString() }, AT)).task, under: [] })],
  ['paused', async f => {
    await setPaused(f.ctx, { agentId: f.head.id }, f.task.id, true, 'Hold the totals.');
    return { target: await f.read(f.task.id), under: [] };
  }],
  ['with open work under it', async f => {
    const { group, under } = await f.group();
    return { target: group, under };
  }],
];

describe('the orchestrator closes a task in any state', () => {
  it.each(STATES.flatMap(([state, make]) => (['done', 'cancelled'] as const).map(status => [state, status, make] as const)))('closes a task %s as %s, with its reason in the log as its own act', async (_state, status, make) => {
    const f = await closing();
    const { target, under } = await make(f);
    await closeTask(f.ctx, { agentId: f.orchestrator.id }, target.id, { status, why: WHY });

    const row = await f.read(target.id);
    expect(row).toMatchObject({ status, assigneeAgentId: null, paused: null, externalWait: null });
    expect(row.closedAt).toBeInstanceOf(Date);
    expect((await f.log(target.id)).at(-1)).toMatchObject({ kind: status, agentId: f.orchestrator.id, personId: null, text: WHY });
    expect(await f.openRequests(target.id)).toEqual([]);
    expect(await f.openWaits(target.id)).toEqual([]);
    expect((await routeOf(f.db, row)).state.phase).toBe(status);
    /* Work under it nobody finished is cancelled with it, each saying so; none of it counts as done. */
    for (const id of under) {
      const child = await f.read(id);
      expect(child).toMatchObject({ status: 'cancelled', assigneeAgentId: null, paused: null });
      expect((await routeOf(f.db, child)).state.phase).toBe('cancelled');
      expect((await f.log(id)).at(-1)).toMatchObject({ kind: 'cancelled', agentId: f.orchestrator.id, text: status === 'done' ? `#${target.number} was closed by the orchestrator.` : `#${target.number} was cancelled.` });
    }
  });

  it('closes no task a second time, and takes a reason', async () => {
    const f = await closing();
    await closeTask(f.ctx, { agentId: f.orchestrator.id }, f.task.id, { status: 'done', why: WHY });
    await expect(closeTask(f.ctx, { agentId: f.orchestrator.id }, f.task.id, { status: 'cancelled', why: WHY })).rejects.toMatchObject({ status: 409, reason: 'task_closed' });
    const other = (await f.create({ title: 'Totals in the export' })).task;
    await expect(closeTask(f.ctx, { agentId: f.orchestrator.id }, other.id, { status: 'done', why: '  ' })).rejects.toMatchObject({ status: 400 });
    expect((await f.read(other.id)).status).toBe('open');
  });

  it('lets nobody but the orchestrator close a task past its route', async () => {
    const f = await closing();
    for (const actor of [{ agentId: f.head.id }, { agentId: f.author.id }, { personId: f.owner.id }]) {
      await expect(closeTask(f.ctx, actor, f.task.id, { status: 'done', why: WHY })).rejects.toMatchObject({ status: 403 });
    }
    expect((await f.read(f.task.id)).status).toBe('open');
  });

  /* Closing the record is all it does: the result joins no turn and is accepted by nobody, so no release or main takes it. */
  it('accepts nothing and joins no turn as it closes executable work done', async () => {
    const f = await closing();
    const { task } = await submit(f.ctx, f.author.id, f.task.id, { summary: 'Changed the totals.', evidence: 'Totals tests pass.', review: { baseCommit: BASE } });
    await f.db.update(tasks).set({ turnId: null }).where(eq(tasks.id, task.id));
    await closeTask(f.ctx, { agentId: f.orchestrator.id }, task.id, { status: 'done', why: WHY });
    expect((await f.read(task.id)).turnId).toBeNull();
    const proofs = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), sql`(${taskEvents.data} ? 'acceptedCandidate' OR ${taskEvents.data} ? 'integration')`));
    expect(proofs).toEqual([]);
  });
});

describe('closing a task through the API and the tool', () => {
  it('closes a task through the route the orchestrator calls, and refuses it to a person and to a head', async () => {
    const f = await closing();
    const close = (by: { headers: Record<string, string> } | ReturnType<typeof as>, status = 'done') => f.app.inject({ method: 'POST', url: `/api/tasks/${f.task.id}/close`, ...by, payload: { status, why: WHY } });
    expect((await close(as(f.ceoToken))).statusCode).toBe(403);
    expect((await close({ headers: orchestratorHeaders(f.owner.id, f.head.id) })).statusCode).toBe(403);
    expect((await f.read(f.task.id)).status).toBe('open');
    const done = await close({ headers: orchestratorHeaders(f.owner.id, f.orchestrator.id) }, 'cancelled');
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ task: { id: f.task.id, status: 'cancelled' } });
    expect((await f.log(f.task.id)).at(-1)).toMatchObject({ kind: 'cancelled', agentId: f.orchestrator.id, text: WHY });
  });

  it('gives the orchestrator close_task, and no head or worker', async () => {
    const f = await closing();
    await listen(f.app);
    const toolsOf = async (agentId: string) => {
      const token = `close-${agentId}`;
      await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId, subscriptionId: f.claude.id, kind: 'conversation', prompt: 'Work.', status: 'running', startedAt: AT, timeoutMs: 60_000, toolTokenHash: hashToken(token) });
      return mcp(f.app, token);
    };
    for (const agent of [f.head, f.author]) expect((await (await toolsOf(agent.id)).listTools()).tools.map(t => t.name)).not.toContain('close_task');
    const { group, under } = await f.group();
    /* A task the orchestrator made to follow work under the group: nobody else hears that it still waits. */
    const next = (await createTask(f.ctx, { agentId: f.orchestrator.id }, { title: 'Totals, next', brief: '', body: 'After the report.', departmentId: f.task.departmentId!, assigneeAgentId: f.head.id, after: [under[1]!], independentNone: 'It starts only once the report is in.' })).task;
    const boss = await toolsOf(f.orchestrator.id);
    const said = await boss.callTool({ name: 'close_task', arguments: { task: group.number, status: 'done', why: WHY } }) as { isError?: boolean; content: { text: string }[] };
    expect(said.isError).toBeFalsy();
    expect(said.content[0]!.text).toBe(`Closed #${group.number} as done. Open tasks cancelled under it: 2. Still waiting for work cancelled under it: #${next.number}. Give each what to wait for with update_task, or cancel it.`);
    expect(await f.read(group.id)).toMatchObject({ status: 'done' });
    expect(await f.read(next.id)).toMatchObject({ status: 'open' });
    expect((await f.log(group.id)).at(-1)).toMatchObject({ kind: 'done', agentId: f.orchestrator.id, text: WHY });
  });

  it('says nothing more of a close that ended nothing under the task', () => {
    expect(closedBeyond({ closed: ['one'], waiting: [] })).toBe('');
  });
});
