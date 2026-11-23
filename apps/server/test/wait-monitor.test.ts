import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, jobs, requests, tasks, testRuns, turns } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { quietDepartment as observeQuiet, waitCycles } from '../src/modules/tasks/wait-observations.js';
import { checkWaitHealth } from '../src/modules/tasks/wait-monitor.js';
import { statements } from './helpers-db.js';
import { waitCompany } from './wait-company.js';

const MINUTE = 60_000;
async function quietDepartment() {
  const c = await waitCompany({ turn: false });
  const now = new Date();
  const since = new Date(now.getTime() - 15 * MINUTE);
  const [turn] = await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.dev.id, number: 1, goal: 'Deliver work', openedAt: since }).returning();
  const task = await c.task();
  await c.db.update(tasks).set({ turnId: turn!.id, updatedAt: since, externalWait: { since: since.toISOString(), until: new Date(now.getTime() + 120 * MINUTE).toISOString(), reason: 'Machine run' } }).where(eq(tasks.id, task.id));
  return { ...c, taskRow: task, turn: turn!, now };
}

/* Nothing runs and nothing says why. */
async function unexplained() {
  const c = await quietDepartment();
  await c.db.update(tasks).set({ externalWait: null }).where(eq(tasks.id, c.taskRow.id));
  return c;
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
    expect(notices[0]!.data).toMatchObject({ text: expect.stringContaining(`${c.agent.name} on #${c.work[0]!.number} waits for ${c.head.name}: Result from ${c.head.name}`) });
    if (length === 3) expect(notices[0]!.data).toMatchObject({ text: expect.stringContaining('Result from Cora') });
  });

  it('excludes an employee edge whose deadline is exactly now', async () => {
    const c = await cycle(2);
    const [task] = await c.db.select().from(tasks).where(eq(tasks.id, c.work[0]!.id));
    await c.db.update(tasks).set({ externalWait: { ...task!.externalWait!, until: c.now.toISOString() } }).where(eq(tasks.id, task!.id));
    expect(await waitCycles(c.ctx, c.now)).toEqual([]);
  });

  it('does not report a work dependency with a scheduled check as a waiting cycle', async () => {
    const c = await cycle(2);
    const [task] = await c.db.select().from(tasks).where(eq(tasks.id, c.work[0]!.id));
    await c.db.update(tasks).set({ status: 'working', externalWait: { ...task!.externalWait!, work: true } }).where(eq(tasks.id, task!.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.orchestrator.id)).toEqual([]);
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
  it('stays silent where everything waits on something known and in time: nobody is told, Operations least of all', async () => {
    const c = await quietDepartment();
    await checkWaitHealth(c.ctx, c.now);
    await checkWaitHealth(c.ctx, new Date(c.now.getTime() + 120 * MINUTE - 1));
    for (const who of [c.watcher, c.head, c.orchestrator, c.agent]) expect(await c.messages(who.id)).toEqual([]);
  });

  it.each(['blocked', 'waiting', 'paused', 'prerequisite', 'person', 'run', 'children'] as const)('counts a %s wait as known with no timer of its own', async kind => {
    const c = await quietDepartment();
    await c.db.update(tasks).set({ externalWait: null, ...(kind === 'blocked' || kind === 'waiting' ? { status: kind } : {}) }).where(eq(tasks.id, c.taskRow.id));
    /* A task its holder paused with a reason stays at work by status: the pause alone explains it. */
    if (kind === 'paused') await c.db.update(tasks).set({ paused: { at: c.now.toISOString(), reason: 'Waits for the test stand', by: { agentId: c.head.id }, root: c.taskRow.id } }).where(eq(tasks.id, c.taskRow.id));
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
    if (kind === 'children') {
      const child = await c.task();
      await c.db.update(tasks).set({ parentId: c.taskRow.id, turnId: c.turn.id, updatedAt: new Date(c.now.getTime() - 15 * MINUTE), externalWait: { since: c.now.toISOString(), until: new Date(c.now.getTime() + 120 * MINUTE).toISOString(), reason: 'Machine run' } }).where(eq(tasks.id, child.id));
    }
    await c.db.update(tasks).set({ updatedAt: new Date(c.now.getTime() - 15 * MINUTE) }).where(eq(tasks.id, c.taskRow.id));
    await checkWaitHealth(c.ctx, c.now);
    for (const who of [c.watcher, c.head]) expect(await c.messages(who.id)).toEqual([]);
  });

  it('asks the head at fifteen minutes about work nothing explains, naming it and no words of it, once', async () => {
    const c = await unexplained();
    await checkWaitHealth(c.ctx, new Date(c.now.getTime() - 1));
    expect(await c.messages(c.head.id)).toEqual([]);
    await checkWaitHealth(c.ctx, c.now);
    await checkWaitHealth({ ...c.ctx }, new Date(c.now.getTime() + MINUTE));
    const notices = await c.messages(c.head.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ data: { notification: { source: 'department_quiet', tasks: [{ id: c.taskRow.id, number: c.taskRow.number }] }, text: expect.stringContaining('department development') } });
    expect(notices[0]!.data).toMatchObject({ text: expect.stringContaining(`#${c.taskRow.number}`) });
    expect(JSON.stringify(notices[0]!.data)).not.toContain('Publish images');
    expect(await c.messages(c.watcher.id)).toEqual([]);
  });

  it('goes on with the orchestrator where the department has no head on, and never to Operations', async () => {
    const c = await unexplained();
    await c.db.update(agents).set({ switchedOffAt: c.now }).where(eq(agents.id, c.head.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.head.id)).toEqual([]);
    expect(await c.messages(c.watcher.id)).toEqual([]);
    expect(await c.messages(c.orchestrator.id)).toHaveLength(1);
  });

  it('asks the head of the department above for one of its products', async () => {
    const c = await unexplained();
    const [product] = await c.db.insert(departments).values({ companyId: c.companyId, parentId: c.dev.id, name: 'API', roleCode: 'API' }).returning();
    await c.db.update(tasks).set({ departmentId: product!.id }).where(eq(tasks.id, c.taskRow.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.head.id)).toHaveLength(1);
    expect(await c.messages(c.orchestrator.id)).toEqual([]);
  });

  it('does not treat a turn that never started as recent work', async () => {
    const c = await unexplained();
    await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Unsent', status: 'failed', error: 'send_failed', finishedAt: c.now, timeoutMs: 1000 });
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.head.id)).toHaveLength(1);
  });

  it('counts running work on a department task assigned outside the department', async () => {
    const c = await unexplained();
    await c.db.update(tasks).set({ assigneeAgentId: c.orchestrator.id }).where(eq(tasks.id, c.taskRow.id));
    await c.run(c.orchestrator.id, c.taskRow.id);
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.head.id)).toEqual([]);
  });

  it('checks quiet waits in the minute round', async () => {
    const c = await unexplained();
    const errors: unknown[] = [];
    await minuteRound(c.ctx, c.now, () => error => { errors.push(error); });
    expect(errors).toEqual([]);
    expect(await c.messages(c.head.id)).toHaveLength(1);
  });

  it('does not call for a long running conversation and starts fifteen minutes at its completion', async () => {
    const c = await unexplained();
    const running = await c.run();
    await c.db.update(jobs).set({ startedAt: new Date(c.now.getTime() - 120 * MINUTE) }).where(eq(jobs.id, running.job.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.head.id)).toEqual([]);
    await c.db.update(jobs).set({ status: 'done', finishedAt: c.now }).where(eq(jobs.id, running.job.id));
    await checkWaitHealth(c.ctx, new Date(c.now.getTime() + 15 * MINUTE - 1));
    expect(await c.messages(c.head.id)).toEqual([]);
    await checkWaitHealth(c.ctx, new Date(c.now.getTime() + 15 * MINUTE));
    expect(await c.messages(c.head.id)).toHaveLength(1);
  });

  it('does not call for a closed turn', async () => {
    const c = await unexplained();
    await c.db.update(turns).set({ status: 'closed', closedAt: c.now }).where(eq(turns.id, c.turn.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.head.id)).toEqual([]);
  });

  it('counts work in a descendant department as work', async () => {
    const c = await unexplained();
    const [child] = await c.db.insert(departments).values({ companyId: c.companyId, parentId: c.dev.id, name: 'API', roleCode: 'API' }).returning();
    await c.db.update(agents).set({ departmentId: child!.id }).where(eq(agents.id, c.agent.id));
    await c.run();
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.head.id)).toEqual([]);
  });

  it('checks a turn only against the work of its own department', async () => {
    const c = await unexplained();
    await c.db.update(turns).set({ departmentId: c.watcher.departmentId }).where(eq(turns.id, c.turn.id));
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.head.id)).toEqual([]);
    expect(await c.messages(c.orchestrator.id)).toEqual([]);
  });

  it('keeps unrelated department descendants outside its quiet scope', async () => {
    const c = await unexplained();
    const [other] = await c.db.insert(departments).values({ companyId: c.companyId, parentId: c.watcher.departmentId, name: 'Other', roleCode: 'OTHER' }).returning();
    const [employee] = await c.db.insert(agents).values({ companyId: c.companyId, departmentId: other!.id, kind: 'worker', roleKey: 'OPS-WATCH', name: 'Owen', model: '', subscriptionId: c.sub.id }).returning();
    await c.run(employee!.id);
    await checkWaitHealth(c.ctx, c.now);
    expect(await c.messages(c.head.id)).toHaveLength(1);
  });

  it('does not manufacture an observation at an expired wait boundary: its time starts then', async () => {
    const c = await quietDepartment();
    await c.db.update(tasks).set({ externalWait: { reason: 'Machine', since: new Date(c.now.getTime() - 900_000).toISOString(), until: c.now.toISOString() } }).where(eq(tasks.id, c.taskRow.id));
    expect(await observeQuiet(c.ctx, c.turn.id, c.dev.id, c.now)).toBeNull();
    expect(await waitCycles(c.ctx, c.now)).toEqual([]);
    expect(await observeQuiet(c.ctx, c.turn.id, c.dev.id, new Date(c.now.getTime() + 15 * MINUTE))).toMatchObject({ silent: [{ id: c.taskRow.id }] });
  });

  it('defers a quiet observation if no head or orchestrator is enabled', async () => {
    const c = await unexplained();
    await c.db.update(agents).set({ switchedOffAt: c.now }).where(eq(agents.id, c.head.id));
    await c.db.update(agents).set({ switchedOffAt: c.now }).where(eq(agents.id, c.orchestrator.id));
    await expect(checkWaitHealth(c.ctx, c.now)).resolves.toBeUndefined();
    expect(await c.messages(c.head.id)).toEqual([]);
    expect(await c.messages(c.orchestrator.id)).toEqual([]);
  });

  /* #1981: the check runs every minute for every department, and read each conversation of it whole (prompt, tail, result:
     25 000 rows, 113 MB) to learn two things; under load that ended in the 5 s transaction timeout. */
  it('asks the database only whether a conversation runs and when the last one ended, never for the conversations', async () => {
    const c = await unexplained();
    const seen = statements();
    await observeQuiet(c.ctx, c.turn.id, c.dev.id, c.now);
    const reads = seen.filter(({ sql }) => /from "jobs"/.test(sql));
    expect(reads.length).toBeGreaterThan(0);
    for (const { sql } of reads) {
      expect(sql).toMatch(/bool_or\(|max\(/);
      expect(sql).not.toMatch(/"prompt"|"tail"|"result"|"failure"/);
    }
  });

  it('starts its silence at the last end of a conversation of its employees or of its work, and counts no other', async () => {
    const c = await unexplained();
    const at = (minutes: number) => new Date(c.now.getTime() + minutes * MINUTE);
    const conversation = (values: Partial<typeof jobs.$inferInsert>) => c.db.insert(jobs).values({
      companyId: c.companyId, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Work.', status: 'done', timeoutMs: 1000, startedAt: at(0), ...values,
    });
    expect((await observeQuiet(c.ctx, c.turn.id, c.dev.id, at(30)))?.since).toEqual(new Date(c.now.getTime() - 15 * MINUTE));
    await conversation({ agentId: c.agent.id, finishedAt: at(1) });
    await conversation({ agentId: c.orchestrator.id, taskId: c.taskRow.id, finishedAt: at(5) });
    await conversation({ agentId: c.agent.id, kind: 'test', finishedAt: at(9) });
    await conversation({ agentId: c.agent.id, startedAt: null, status: 'failed', finishedAt: at(8) });
    await conversation({ agentId: c.watcher.id, finishedAt: at(7) });
    expect((await observeQuiet(c.ctx, c.turn.id, c.dev.id, at(30)))?.since).toEqual(at(5));
    await conversation({ agentId: c.agent.id, status: 'running', finishedAt: null });
    expect(await observeQuiet(c.ctx, c.turn.id, c.dev.id, at(30))).toBeNull();
  });
});
