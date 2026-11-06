import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agentEvents, agents, companies, departments, jobs, subscriptions, tasks } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { checkIdleDepartments, evaluateIdle, IDLE_SETTINGS, isFree, type IdleEmployee, type IdleSnapshot, type IdleTask } from '../src/modules/tasks/idle.js';
import { connectNode, listen, setUpCompany, testApp } from './helpers.js';

const MINUTE = 60_000;
const START = Date.parse('2026-11-06T02:00:00Z');

const employee = (id: string, more: Partial<IdleEmployee> = {}): IdleEmployee => ({
  id,
  name: `Employee ${id}`,
  enabled: true,
  hasTurn: false,
  actionable: false,
  ...more,
});

const task = (id: string): IdleTask => ({ id, number: Number(id), title: `Task ${id}`, after: ['prerequisite'] });
const employees = (count: number, more: Partial<IdleEmployee> = {}) => Array.from({ length: count }, (_, index) => employee(String(index + 1), more));
const snapshot = (at: number, staff: IdleEmployee[], tasks: IdleTask[] = []): IdleSnapshot => ({ departmentId: 'development', at, employees: staff, tasks });

describe('an employee who is free for independent work', () => {
  it('is enabled and has neither a current turn nor work that can proceed now', () => {
    expect(isFree({ enabled: true, hasTurn: false, actionable: false })).toBe(true);
    expect(isFree({ enabled: true, hasTurn: false, actionable: true })).toBe(false);
    expect(isFree({ enabled: true, hasTurn: true, actionable: false })).toBe(false);
    expect(isFree({ enabled: false, hasTurn: false, actionable: false })).toBe(false);
  });
});

describe('an idle episode', () => {
  it('signals five free employees and three waiting tasks after ten minutes, then raises the watchdog at fifteen', () => {
    const tasks = ['1', '2', '3'].map(task);
    const first = evaluateIdle(null, snapshot(START, employees(5), tasks));
    expect(first.free.map(e => e.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(first.busy).toEqual([]);
    expect(first.notifications).toEqual([]);

    const before = evaluateIdle(first.episode, snapshot(START + 10 * MINUTE - 1, employees(5), tasks));
    expect(before.notifications).toEqual([]);
    expect(before.episode).toEqual(first.episode);

    const signal = evaluateIdle(first.episode, snapshot(START + 10 * MINUTE, employees(5), tasks));
    expect(signal.notifications).toEqual(['signal']);
    expect(signal.episode).toEqual(first.episode);

    const watchdog = evaluateIdle(first.episode, snapshot(START + 15 * MINUTE, employees(5), tasks));
    expect(watchdog.notifications).toEqual(['signal', 'watchdog']);
  });

  it('does not count a waiting employee who has other actionable work', () => {
    const staff = [...employees(4), employee('waiting', { actionable: true })];
    const evaluation = evaluateIdle(null, snapshot(START + 20 * MINUTE, staff, [task('1')]));
    expect(evaluation.free).toHaveLength(4);
    expect(evaluation.busy.map(e => e.id)).toEqual(['waiting']);
  });

  it('resets when the department has no work', () => {
    const previous = evaluateIdle(null, snapshot(START, employees(5), [task('1')])).episode;
    const evaluation = evaluateIdle(previous, snapshot(START + 20 * MINUTE, employees(5)));
    expect(evaluation.episode).toBeNull();
    expect(evaluation.notifications).toEqual([]);
  });

  it('raises neither a signal nor an alarm when every employee is disabled', () => {
    const evaluation = evaluateIdle(null, snapshot(START + 20 * MINUTE, employees(5, { enabled: false }), [task('1')]));
    expect(evaluation.episode).toBeNull();
    expect(evaluation.free).toEqual([]);
    expect(evaluation.notifications).toEqual([]);
  });

  it('raises the watchdog without an idle signal when only one employee is free', () => {
    const evaluation = evaluateIdle(null, snapshot(START, [employee('free')], [task('1')]));
    const later = evaluateIdle(evaluation.episode, snapshot(START + 15 * MINUTE, [employee('free')], [task('1')]));
    expect(later.notifications).toEqual(['watchdog']);
  });

  it('does not alarm at exactly the starting busy ratio, which is not a measured optimum', () => {
    expect(IDLE_SETTINGS).toEqual({ signalAfterMs: 600_000, watchdogAfterMs: 900_000, minFree: 3, busyRatio: 0.25 });
    const staff = [employee('busy', { hasTurn: true }), ...employees(3)];
    const first = evaluateIdle(null, snapshot(START, staff, [task('1')]));
    const later = evaluateIdle(first.episode, snapshot(START + 15 * MINUTE, staff, [task('1')]));
    expect(later.busyRatio).toBe(0.25);
    expect(later.notifications).toEqual(['signal']);
  });

  it('starts a new episode when the free set or waiting task set changes', () => {
    const first = evaluateIdle(null, snapshot(START, employees(5), [task('1'), task('2'), task('3')]));
    const changed = evaluateIdle(first.episode, snapshot(START + 9 * MINUTE, employees(5), [task('1'), task('2')]));
    expect(changed.episode?.since).toBe(START + 9 * MINUTE);
    expect(changed.episode?.key).not.toBe(first.episode?.key);
    expect(changed.notifications).toEqual([]);
    const later = evaluateIdle(changed.episode, snapshot(START + 18 * MINUTE, employees(5), [task('1'), task('2')]));
    expect(later.notifications).toEqual([]);
  });
});

const NODE_KEY = 'k'.repeat(40);

async function idleCompany() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], skillFiles: true });
  const [acme] = await db.select().from(companies);
  const [subscription] = await db.select().from(subscriptions);
  const [development] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [head] = await db.insert(agents).values({ companyId: acme!.id, departmentId: development!.id, kind: 'head', name: 'Hana', roleKey: 'DEV-HEAD', model: '', subscriptionId: subscription!.id }).returning();
  const staff = await db.insert(agents).values(Array.from({ length: 5 }, (_, index) => ({
    companyId: acme!.id,
    departmentId: development!.id,
    kind: 'worker' as const,
    name: `Free ${index + 1}`,
    roleKey: 'DEV-BE',
    model: '',
    subscriptionId: subscription!.id,
  }))).returning();
  const [prerequisite] = await db.insert(tasks).values({ companyId: acme!.id, departmentId: development!.id, number: 90, title: 'Prerequisite', status: 'working' }).returning();
  await db.insert(tasks).values(staff.slice(0, 3).map((agent, index) => ({
    companyId: acme!.id,
    departmentId: development!.id,
    number: index + 1,
    title: `Waiting task ${index + 1}`,
    status: 'open' as const,
    assigneeAgentId: agent.id,
    executorAgentId: agent.id,
    after: [prerequisite!.id],
  })));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { app, db, development: development!, head: head!, staff, orchestrator: orchestrator! };
}

const idleJobs = (db: Db, agentId: string) => db.select().from(jobs)
  .where(and(eq(jobs.agentId, agentId), sql`${jobs.prompt} like 'Hornhoof idle%'`))
  .orderBy(asc(jobs.createdAt));

const idleEvents = (db: Db, kind: 'idle_state' | 'idle_signal') => db.select().from(agentEvents)
  .where(sql`${agentEvents.kind} = ${kind}`)
  .orderBy(asc(agentEvents.seq));

describe('idle signals on the server', () => {
  it('lists five free employees and three waiting tasks once, persists the episode and repeats only after a reaction', async () => {
    const { app, db, head } = await idleCompany();
    await checkIdleDepartments(app.ctx, new Date(START));
    await checkIdleDepartments(app.ctx, new Date(START + 9 * MINUTE));
    expect(await idleJobs(db, head.id)).toHaveLength(0);

    await minuteRound(app.ctx, new Date(START + 10 * MINUTE), () => () => {});
    const signals = await idleJobs(db, head.id);
    expect(signals).toHaveLength(1);
    for (const text of ['Free 1', 'Free 2', 'Free 3', 'Free 4', 'Free 5', 'Waiting task 1', 'Waiting task 2', 'Waiting task 3', 'independent']) {
      expect(signals[0]!.prompt).toContain(text);
    }
    expect(await idleEvents(db, 'idle_state')).toHaveLength(1);
    expect(await idleEvents(db, 'idle_signal')).toHaveLength(1);

    await checkIdleDepartments({ ...app.ctx }, new Date(START + 11 * MINUTE));
    expect(await idleJobs(db, head.id)).toHaveLength(1);
    expect(await idleEvents(db, 'idle_state')).toHaveLength(1);
    expect(await idleEvents(db, 'idle_signal')).toHaveLength(1);

    await db.update(jobs).set({ status: 'done', finishedAt: new Date(START + 11 * MINUTE) }).where(eq(jobs.id, signals[0]!.id));
    await checkIdleDepartments(app.ctx, new Date(START + 12 * MINUTE));
    expect(await idleJobs(db, head.id)).toHaveLength(2);
    await checkIdleDepartments(app.ctx, new Date(START + 13 * MINUTE));
    expect(await idleJobs(db, head.id)).toHaveLength(2);
    expect(await idleEvents(db, 'idle_signal')).toHaveLength(2);
  });

  it('signals the orchestrator when the department head is busy', async () => {
    const { app, db, head, orchestrator } = await idleCompany();
    await db.insert(jobs).values({ companyId: head.companyId, subscriptionId: head.subscriptionId!, agentId: head.id, kind: 'conversation', prompt: 'Head is busy', timeoutMs: 900_000, status: 'running' });
    await checkIdleDepartments(app.ctx, new Date(START));
    await checkIdleDepartments(app.ctx, new Date(START + 10 * MINUTE));
    expect(await idleJobs(db, head.id)).toHaveLength(0);
    expect(await idleJobs(db, orchestrator.id)).toHaveLength(1);
    expect((await idleJobs(db, orchestrator.id))[0]!.prompt).toContain('Free 5');
  });

  it('sends no signal or watchdog without work or with every employee switched off', async () => {
    const { app, db, head, staff, orchestrator, development } = await idleCompany();
    await db.update(tasks).set({ status: 'done', closedAt: new Date(START) }).where(eq(tasks.departmentId, development.id));
    await checkIdleDepartments(app.ctx, new Date(START));
    await checkIdleDepartments(app.ctx, new Date(START + 20 * MINUTE));
    await db.update(tasks).set({ status: 'open', closedAt: null }).where(eq(tasks.departmentId, development.id));
    await db.update(agents).set({ switchedOffAt: new Date(START) }).where(eq(agents.id, staff[0]!.id));
    await db.update(agents).set({ switchedOffAt: new Date(START) }).where(eq(agents.id, staff[1]!.id));
    await db.update(agents).set({ switchedOffAt: new Date(START) }).where(eq(agents.id, staff[2]!.id));
    await db.update(agents).set({ switchedOffAt: new Date(START) }).where(eq(agents.id, staff[3]!.id));
    await db.update(agents).set({ switchedOffAt: new Date(START) }).where(eq(agents.id, staff[4]!.id));
    await checkIdleDepartments(app.ctx, new Date(START + 40 * MINUTE));
    expect(await idleJobs(db, head.id)).toHaveLength(0);
    expect(await idleJobs(db, orchestrator.id)).toHaveLength(0);
    expect(await idleEvents(db, 'idle_signal')).toHaveLength(0);
  });

  it('raises the watchdog after fifteen minutes below the starting occupancy threshold', async () => {
    const { app, db, head } = await idleCompany();
    await checkIdleDepartments(app.ctx, new Date(START));
    await checkIdleDepartments(app.ctx, new Date(START + 14 * MINUTE));
    expect(await idleJobs(db, head.id)).toHaveLength(0);
    await checkIdleDepartments(app.ctx, new Date(START + 15 * MINUTE));
    const alarms = await idleJobs(db, head.id);
    expect(alarms).toHaveLength(2);
    expect(alarms[1]!.prompt).toContain('watchdog');
    expect(alarms[1]!.prompt).toContain('0%');
    expect(alarms[1]!.prompt).not.toContain('normal');
  });

  it('leaves an employee with actionable work out of the free list', async () => {
    const { app, db, head, staff, development } = await idleCompany();
    await db.insert(tasks).values({ companyId: head.companyId, departmentId: development.id, number: 4, title: 'Start now', status: 'open', assigneeAgentId: staff[4]!.id, executorAgentId: staff[4]!.id });
    await checkIdleDepartments(app.ctx, new Date(START));
    await checkIdleDepartments(app.ctx, new Date(START + 10 * MINUTE));
    const signals = await idleJobs(db, head.id);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.prompt).toContain('Free 4');
    expect(signals[0]!.prompt).toContain('Start now');
    expect(signals[0]!.prompt).not.toContain('Free 5');
  });
});
