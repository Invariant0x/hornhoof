import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, jobs, requests, tasks, testRuns, turns } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { checkWaitHealth } from '../src/modules/tasks/wait-monitor.js';
import { waitCompany } from './wait-company.js';

const MINUTE = 60_000;
async function quietDepartment() {
  const c = await waitCompany();
  const now = new Date();
  const since = new Date(now.getTime() - 15 * MINUTE);
  const [turn] = await c.db.insert(turns).values({ companyId: c.companyId, number: 1, goal: 'Deliver work', openedAt: since }).returning();
  const task = await c.task();
  await c.db.update(tasks).set({ turnId: turn!.id, updatedAt: since, externalWait: { since: since.toISOString(), until: new Date(now.getTime() + 120 * MINUTE).toISOString(), reason: 'Machine run' } }).where(eq(tasks.id, task.id));
  return { ...c, taskRow: task, turn: turn!, now };
}

async function cycle(length: number) {
  const c = await waitCompany();
  const employees = [c.agent, c.head];
  if (length === 3) employees.push((await c.db.insert(agents).values({ companyId: c.companyId, departmentId: c.dev.id, kind: 'worker', roleKey: 'DEV-BE', name: 'Cora', model: '', subscriptionId: c.sub.id }).returning())[0]!);
  const now = new Date();
  const work = [];
  for (const [i, employee] of employees.entries()) {
    const task = await c.task(employee.id);
    const target = employees[(i + 1) % employees.length]!;
    await c.db.update(tasks).set({ externalWait: { since: now.toISOString(), until: new Date(now.getTime() + 120 * MINUTE).toISOString(), reason: `Result from ${target.name}`, on: { kind: 'employee', employee: target.id, name: target.name } } }).where(eq(tasks.id, task.id));
    work.push(task);
  }
  return { ...c, work, now };
}

describe('waiting cycles', () => {
  it.each([2, 3])('tells the orchestrator every reason in a %i-person cycle once across concurrent and restarted sweeps', async length => {
    const c = await cycle(length);
    await Promise.all([checkWaitHealth(c.ctx, c.now), checkWaitHealth({ ...c.ctx }, c.now)]);
    await checkWaitHealth({ ...c.ctx }, new Date(c.now.getTime() + MINUTE));
    const notices = await c.messages(c.orchestrator.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ data: { notification: { source: 'wait_cycle', tasks: expect.arrayContaining(c.work.map(t => ({ id: t.id, number: t.number }))) } } });
    for (const employee of [c.agent, c.head]) expect(notices[0]!.data).toMatchObject({ text: expect.stringContaining(`Result from ${employee.name}`) });
    if (length === 3) expect(notices[0]!.data).toMatchObject({ text: expect.stringContaining('Result from Cora') });
  });

  it('reports a recreated cycle as a new incident', async () => {
    const c = await cycle(2);
    await checkWaitHealth(c.ctx, c.now);
    const task = (await c.db.select().from(tasks).where(eq(tasks.id, c.work[0]!.id)))[0]!;
    await c.db.update(tasks).set({ version: task.version + 1, externalWait: { ...task.externalWait!, reason: 'Acceptance after retry' } }).where(eq(tasks.id, task.id));
    await checkWaitHealth(c.ctx, new Date(c.now.getTime() + MINUTE));
    const notices = await c.messages(c.orchestrator.id);
    expect(notices).toHaveLength(2);
    expect(notices[1]!.data).toMatchObject({ text: expect.stringContaining('Acceptance after retry') });
  });

  it('does not call a chain ending at an external event a cycle', async () => {
    const c = await cycle(2);
    await c.db.update(tasks).set({ externalWait: { reason: 'Machine', since: c.now.toISOString(), until: new Date(c.now.getTime() + 60 * MINUTE).toISOString() } }).where(eq(tasks.id, c.work[1]!.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.orchestrator.id)).toEqual([]);
  });
});

describe('quiet departments', () => {
  it('does not treat a turn that never started as recent work', async () => {
    const c = await quietDepartment();
    await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Unsent', status: 'failed', error: 'send_failed', finishedAt: c.now, timeoutMs: 1000 });
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.watcher.id)).toHaveLength(1);
  });

  it('counts running work on a department task assigned outside the department', async () => {
    const c = await quietDepartment();
    await c.db.update(tasks).set({ assigneeAgentId: c.orchestrator.id }).where(eq(tasks.id, c.taskRow.id));
    await c.run(c.orchestrator.id, c.taskRow.id);
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.watcher.id)).toEqual([]);
  });

  it('checks quiet waits in the minute round', async () => {
    const c = await quietDepartment();
    const errors: unknown[] = [];
    await minuteRound(c.ctx, c.now, () => error => { errors.push(error); });
    expect(errors).toEqual([]);
    expect(await c.messages(c.watcher.id)).toHaveLength(1);
  });

  it('calls OPS-WATCH at fifteen minutes with the department, tasks and reasons, once', async () => {
    const c = await quietDepartment();
    await checkWaitHealth(c.ctx, new Date(c.now.getTime() - 1));
    expect(await c.messages(c.watcher.id)).toEqual([]);
    await checkWaitHealth(c.ctx, c.now);
    await checkWaitHealth({ ...c.ctx }, new Date(c.now.getTime() + MINUTE));
    const notices = await c.messages(c.watcher.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ data: { notification: { source: 'department_quiet', tasks: [{ id: c.taskRow.id, number: c.taskRow.number }] }, text: expect.stringContaining('Machine run') } });
  });

  it('sends the quiet-department call directly to the orchestrator without an active OPS-WATCH', async () => {
    const c = await quietDepartment();
    await c.db.update(agents).set({ switchedOffAt: c.now }).where(eq(agents.id, c.watcher.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.watcher.id)).toEqual([]);
    expect(await c.messages(c.orchestrator.id)).toHaveLength(1);
  });

  it('does not call for a long running conversation and starts fifteen minutes at its completion', async () => {
    const c = await quietDepartment();
    const running = await c.run();
    await c.db.update(jobs).set({ startedAt: new Date(c.now.getTime() - 120 * MINUTE) }).where(eq(jobs.id, running.job.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.watcher.id)).toEqual([]);
    await c.db.update(jobs).set({ status: 'done', finishedAt: c.now }).where(eq(jobs.id, running.job.id));
    await checkWaitHealth(c.ctx, new Date(c.now.getTime() + 15 * MINUTE - 1));
    expect(await c.messages(c.watcher.id)).toEqual([]);
    await checkWaitHealth(c.ctx, new Date(c.now.getTime() + 15 * MINUTE));
    expect(await c.messages(c.watcher.id)).toHaveLength(1);
  });

  it('does not call while an unclosed task is available to work on', async () => {
    const c = await quietDepartment();
    await c.db.update(tasks).set({ externalWait: null }).where(eq(tasks.id, c.taskRow.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.watcher.id)).toEqual([]);
  });

  it('does not call for a closed turn', async () => {
    const c = await quietDepartment();
    await c.db.update(turns).set({ status: 'closed', closedAt: c.now }).where(eq(turns.id, c.turn.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.watcher.id)).toEqual([]);
  });

  it('counts a parent waiting for its open children as waiting', async () => {
    const c = await quietDepartment();
    const parent = await c.task(c.head.id);
    const since = new Date(c.now.getTime() - 15 * MINUTE);
    await c.db.update(tasks).set({ turnId: c.turn.id, updatedAt: since }).where(eq(tasks.id, parent.id));
    await c.db.update(tasks).set({ parentId: parent.id }).where(eq(tasks.id, c.taskRow.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.watcher.id)).toHaveLength(1);
  });
  it.each(['blocked', 'waiting', 'prerequisite', 'person', 'run'] as const)('recognizes a %s wait without an external timer', async kind => {
    const c = await quietDepartment();
    await c.db.update(tasks).set({ externalWait: null, ...(kind === 'blocked' || kind === 'waiting' ? { status: kind } : {}) }).where(eq(tasks.id, c.taskRow.id));
    if (kind === 'prerequisite') {
      const prerequisite = await c.task();
      await c.db.update(tasks).set({ departmentId: c.watcher.departmentId }).where(eq(tasks.id, prerequisite.id));
      await c.db.update(tasks).set({ after: [prerequisite.id] }).where(eq(tasks.id, c.taskRow.id));
    }
    if (kind === 'person') await c.db.insert(requests).values({ companyId: c.companyId, taskId: c.taskRow.id, agentId: c.agent.id, kind: 'question', text: 'Confirm acceptance.' });
    if (kind === 'run') {
      const run = await c.run();
      await c.db.update(jobs).set({ status: 'done', finishedAt: new Date(c.now.getTime() - 16 * MINUTE) }).where(eq(jobs.id, run.job.id));
      await c.db.insert(testRuns).values({ companyId: c.companyId, taskId: c.taskRow.id, agentId: c.agent.id, jobId: run.job.id, number: 1, command: 'npm test', timeoutMs: 3_600_000 });
    }
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.watcher.id)).toHaveLength(1);
  });

  it('counts work in a descendant department as work', async () => {
    const c = await quietDepartment();
    const [child] = await c.db.insert(departments).values({ companyId: c.companyId, parentId: c.dev.id, name: 'API', roleCode: 'API' }).returning();
    await c.db.update(agents).set({ departmentId: child!.id }).where(eq(agents.id, c.agent.id));
    await c.run();
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.watcher.id)).toEqual([]);
  });

});
