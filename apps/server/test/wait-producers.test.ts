import { randomUUID } from 'node:crypto';
import type { WaitPlan } from '@hornhoof/protocol/waits';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, people, requests, subscriptions, taskEvents, tasks, taskWaits, waitPolicies } from '../src/db/schema.js';
import { answer, ask, cancel, createTask, leaveWork, report, submit, updateTask, verdict, type Task } from '../src/modules/tasks/engine.js';
import { waitFor } from '../src/modules/tasks/external-wait.js';
import { resolveStuck } from '../src/modules/tasks/stuck.js';
import { afterSourceKey, recordRunWait, requestSourceKey, reviewSourceKey, waitForSourceKey } from '../src/modules/tasks/wait-state.js';
import { setUpCompany, testApp } from './helpers.js';

const HOUR = 3_600_000;
const later = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev, ops] = await db.insert(departments).values([{ companyId, templateKey: 'development', roleCode: 'DEV' }, { companyId, templateKey: 'operations', roleCode: 'OPS' }]).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const ctx = app.ctx;
  const CEO = { personId: ceo!.id };
  const task = async (title: string, change: Partial<Parameters<typeof createTask>[2]> = {}) => (await createTask(ctx, CEO, { title, brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, ...change })).task;
  const policy = (change: Partial<typeof waitPolicies.$inferInsert> = {}) => db.insert(waitPolicies).values({
    companyId, departmentId: dev!.id, kind: 'after', stage: '', version: 1, ownerMs: HOUR, headMs: 2 * HOUR, decisionMs: 3 * HOUR, reviewIntervalMs: 4 * HOUR, createdByPersonId: ceo!.id, ...change,
  });
  const waitsOf = (t: Pick<Task, 'id'>) => db.select().from(taskWaits).where(eq(taskWaits.taskId, t.id)).orderBy(asc(taskWaits.createdAt), asc(taskWaits.id));
  const plan = (change: Partial<WaitPlan> = {}): WaitPlan => ({
    version: 1, ownerDueAt: later(1), headDueAt: later(2), decisionDueAt: later(3),
    provenance: { kind: 'explicit_promise', actor: { personId: ceo!.id }, ref: 'promise-1', revision: 1, origin: 'test' },
    finalReview: { headAgentId: head.id, anchorAt: later(4), intervalMs: HOUR },
    ...change,
  });
  return { ctx, db, companyId, CEO, ceo: ceo!, dev: dev!, ops: ops!, head, bruno, rita, task, policy, waitsOf, plan, hire };
}

const reason = (p: Promise<unknown>) => p.then(() => 'ok', (err: { reason?: string }) => err.reason ?? String(err));

describe('a task that comes after others', () => {
  it('in a department with no policy keeps a wait with no dates for each open edge, its holder answering for it', async () => {
    const c = await company();
    const first = await c.task('First', { assigneeAgentId: c.rita.id });
    const finished = await c.task('Finished');
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, finished.id));
    const follow = await c.task('Follow', { after: [first.id, finished.id], independentNone: 'One piece.' });
    expect(await c.waitsOf(follow)).toMatchObject([{
      kind: 'after', sourceKey: afterSourceKey(first.id), state: 'legacy_needs_plan', ownerAgentId: c.rita.id, plan: null, ownerDueAt: null, nextActionAt: null, level: 0,
    }]);
  });

  it('takes its dates from the department once it set one, from the moment it was given', async () => {
    const c = await company();
    await c.policy();
    const first = await c.task('First', { assigneeAgentId: c.rita.id });
    const before = Date.now();
    const follow = await c.task('Follow', { after: [first.id], independentNone: 'One piece.' });
    const [wait] = await c.waitsOf(follow);
    expect(wait).toMatchObject({ state: 'active', ownerAgentId: c.rita.id, plan: { provenance: { kind: 'department_policy', revision: 1 } }, level: 0 });
    expect(wait!.ownerDueAt!.getTime()).toBeGreaterThanOrEqual(before + HOUR);
    expect(wait!.ownerDueAt!.getTime()).toBeLessThan(Date.now() + HOUR + 1);
  });

  it('is refused whole where the department set a policy, but none for this and no promise is given', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const first = await c.task('First');
    const count = (await c.db.select().from(tasks)).length;
    expect(await reason(c.task('Follow', { after: [first.id], independentNone: 'One piece.' }))).toBe('task_invalid');
    expect(await c.db.select().from(tasks)).toHaveLength(count);
    expect(await c.db.select().from(taskWaits).where(eq(taskWaits.kind, 'after'))).toEqual([]);
  });

  it('turns strict with the first policy: what stood before stays, what comes next is refused', async () => {
    const c = await company();
    const first = await c.task('First');
    const old = await c.task('Old', { after: [first.id], independentNone: 'One piece.' });
    await c.policy({ kind: 'person' });
    expect(await c.waitsOf(old)).toMatchObject([{ state: 'legacy_needs_plan' }]);
    expect(await reason(c.task('New', { after: [first.id], independentNone: 'One piece.' }))).toBe('task_invalid');
  });

  it('takes a promise for each edge in place of a policy', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const first = await c.task('First');
    const plan = c.plan();
    const follow = await c.task('Follow', { after: [first.id], independentNone: 'One piece.', afterPlans: { [first.id]: plan } });
    expect(await c.waitsOf(follow)).toMatchObject([{ state: 'active', plan: { provenance: { kind: 'explicit_promise', ref: 'promise-1' } } }]);
  });

  it('refuses a promise for a task it does not come after', async () => {
    const c = await company();
    const first = await c.task('First');
    expect(await reason(c.task('Follow', { after: [first.id], independentNone: 'One piece.', afterPlans: { [randomUUID()]: c.plan() } }))).toBe('task_invalid');
  });

  it('answers to whoever holds the task before it now, at a new generation', async () => {
    const c = await company();
    await c.policy();
    const first = await c.task('First', { assigneeAgentId: c.rita.id });
    const follow = await c.task('Follow', { after: [first.id], independentNone: 'One piece.' });
    const [before] = await c.waitsOf(follow);
    await updateTask(c.ctx, c.head.id, first.id, { executor: c.bruno.id });
    const [wait] = await c.waitsOf(follow);
    expect(wait).toMatchObject({ id: before!.id, ownerAgentId: c.bruno.id, generation: 2, state: 'active', ownerDueAt: before!.ownerDueAt });
  });

  it('moves the owner of a wait with no plan too, which keeps its dates empty', async () => {
    const c = await company();
    const first = await c.task('First', { assigneeAgentId: c.rita.id });
    const follow = await c.task('Follow', { after: [first.id], independentNone: 'One piece.' });
    await updateTask(c.ctx, c.head.id, first.id, { executor: c.bruno.id });
    expect(await c.waitsOf(follow)).toMatchObject([{ ownerAgentId: c.bruno.id, state: 'legacy_needs_plan', ownerDueAt: null }]);
  });

  it('adds and ends edges as what it comes after changes', async () => {
    const c = await company();
    const [one, two] = [await c.task('One'), await c.task('Two', { assigneeAgentId: c.rita.id })];
    const follow = await c.task('Follow', { after: [one.id], independentNone: 'One piece.' });
    await updateTask(c.ctx, c.head.id, follow.id, { after: [two.id], independentNone: 'One piece.' });
    const rows = await c.waitsOf(follow);
    expect(rows.map(w => [w.sourceKey, w.state])).toEqual([[afterSourceKey(one.id), 'cancelled'], [afterSourceKey(two.id), 'legacy_needs_plan']]);
    expect(rows[0]!.proofRef).toMatch(/^update:\d+$/);
  });

  it('leaves the edge standing when the task before it is cancelled, and no date moves', async () => {
    const c = await company();
    await c.policy();
    const first = await c.task('First');
    const follow = await c.task('Follow', { after: [first.id], independentNone: 'One piece.' });
    const [before] = await c.waitsOf(follow);
    await cancel(c.ctx, c.CEO, first.id, 'Not needed.');
    expect(await c.waitsOf(follow)).toMatchObject([{ state: 'active', generation: before!.generation, ownerDueAt: before!.ownerDueAt }]);
  });

  it('ends its edge when the task before it is done, also after that task changed hands, and starts only with the last', async () => {
    const c = await company();
    await c.policy();
    const [one, two] = [await c.task('One', { assigneeAgentId: c.rita.id }), await c.task('Two', { assigneeAgentId: c.rita.id })];
    const follow = await c.task('Follow', { after: [one.id, two.id], independentNone: 'One piece.' });
    await updateTask(c.ctx, c.head.id, one.id, { executor: c.bruno.id });
    await submit(c.ctx, c.bruno.id, one.id, { summary: 'Done.', evidence: 'Seen.' });
    const rows = await c.waitsOf(follow);
    const edge = (t: Task) => rows.find(w => w.sourceKey === afterSourceKey(t.id))!;
    expect([edge(one).state, edge(two).state]).toEqual(['resolved', 'active']);
    expect(edge(one).proofRef).toBe(`task:${one.id}:done`);
    expect((await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, follow.id), eq(taskEvents.kind, 'started'))))).toEqual([]);
    await submit(c.ctx, c.rita.id, two.id, { summary: 'Done.', evidence: 'Seen.' });
    expect((await c.waitsOf(follow)).map(w => w.state)).toEqual(['resolved', 'resolved']);
    expect((await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, follow.id), eq(taskEvents.kind, 'started'))))).toHaveLength(1);
  });

  it('can wait again for a task it stopped waiting for', async () => {
    const c = await company();
    await c.policy();
    const first = await c.task('First');
    const follow = await c.task('Follow', { after: [first.id], independentNone: 'One piece.' });
    await updateTask(c.ctx, c.head.id, follow.id, { after: [] });
    await updateTask(c.ctx, c.head.id, follow.id, { after: [first.id], independentNone: 'One piece.' });
    expect((await c.waitsOf(follow)).map(w => w.state).sort()).toEqual(['active', 'cancelled']);
  });

  it('keeps the dates of the edges it had when another one is added', async () => {
    const c = await company();
    await c.policy();
    const [first, second] = [await c.task('First'), await c.task('Second')];
    const follow = await c.task('Follow', { after: [first.id], independentNone: 'One piece.' });
    const [before] = await c.waitsOf(follow);
    await updateTask(c.ctx, c.head.id, follow.id, { after: [first.id, second.id], independentNone: 'One piece.' });
    expect((await c.waitsOf(follow)).map(w => [w.sourceKey, w.generation, w.ownerDueAt])).toEqual(expect.arrayContaining([[afterSourceKey(first.id), 1, before!.ownerDueAt], [afterSourceKey(second.id), 1, expect.any(Date)]]));
  });

  it('keeps the dates of an edge when something else on the task changes, or the same list is given again', async () => {
    const c = await company();
    await c.policy();
    const first = await c.task('First');
    const follow = await c.task('Follow', { after: [first.id], independentNone: 'One piece.' });
    const [before] = await c.waitsOf(follow);
    await updateTask(c.ctx, c.head.id, follow.id, { title: 'Follow up' });
    await updateTask(c.ctx, c.head.id, follow.id, { after: [first.id], independentNone: 'One piece.' });
    expect(await c.waitsOf(follow)).toMatchObject([{ id: before!.id, generation: 1, ownerDueAt: before!.ownerDueAt }]);
  });

  it('ends all it has when it closes, with one line in its log for what had a plan', async () => {
    const c = await company();
    await c.policy();
    const first = await c.task('First');
    const follow = await c.task('Follow', { after: [first.id], independentNone: 'One piece.' });
    await cancel(c.ctx, c.CEO, follow.id, 'Not needed.');
    expect(await c.waitsOf(follow)).toMatchObject([{ state: 'cancelled', outcome: 'cancelled' }]);
    const log = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, follow.id), eq(taskEvents.kind, 'updated')));
    expect(log.filter(e => e.text.startsWith('A wait on this task ended'))).toHaveLength(1);
  });
});

describe('a task at its gate', () => {
  const atGate = async (c: Awaited<ReturnType<typeof company>>, gates: string[]) => {
    const work = await c.task('Work', { gates });
    await submit(c.ctx, c.bruno.id, work.id, { summary: 'Done.', evidence: 'Seen.' });
    return work;
  };
  /* Two reviewers of one role on two makers' subscriptions check it at once. */
  const atPanel = async (c: Awaited<ReturnType<typeof company>>) => {
    const [other] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'codex', kind: 'personal', label: 'Other', ownerPersonId: c.ceo.id, status: 'ready' }).returning();
    await c.db.insert(agents).values({ companyId: c.companyId, kind: 'worker', name: 'Sara', roleKey: 'DEV-REV', departmentId: c.dev.id, model: '', subscriptionId: other!.id });
    const made = await c.task('Work', { gates: [c.rita.id] });
    await submit(c.ctx, c.bruno.id, made.id, { summary: 'Done.', evidence: 'Seen.' });
    const [work] = await c.db.select().from(tasks).where(eq(tasks.id, made.id));
    expect(work!.panel).toHaveLength(2);
    return { work: work!, first: work!.panel[0]! };
  };

  it('in a department with no policy keeps a wait with no dates for its reviewer', async () => {
    const c = await company();
    const work = await atGate(c, [c.rita.id]);
    expect(await c.waitsOf(work)).toMatchObject([{ kind: 'review', sourceKey: reviewSourceKey(work.id, 0, c.rita.id), state: 'legacy_needs_plan', ownerAgentId: c.rita.id }]);
  });

  it('gives its reviewer the department\'s dates and ends with the verdict, whose event proves it', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const work = await atGate(c, [c.rita.id]);
    expect(await c.waitsOf(work)).toMatchObject([{ state: 'active', ownerAgentId: c.rita.id, plan: { provenance: { kind: 'department_policy' } } }]);
    await verdict(c.ctx, c.rita.id, work.id, { pass: false, comment: 'Fix it.' });
    expect(await c.waitsOf(work)).toMatchObject([{ state: 'resolved', proofRef: expect.stringMatching(/^verdict:\d+$/) as string }]);
  });

  it('refuses the hand-in whole where the department set dates but none for reviews', async () => {
    const c = await company();
    await c.policy();
    const work = await c.task('Work', { gates: [c.rita.id] });
    expect(await reason(submit(c.ctx, c.bruno.id, work.id, { summary: 'Done.', evidence: 'Seen.' }))).toBe('task_invalid');
    expect((await c.db.select().from(tasks).where(eq(tasks.id, work.id)))[0]).toMatchObject({ status: 'open', stage: 0, version: work.version });
    expect(await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, work.id), eq(taskEvents.kind, 'submitted')))).toEqual([]);
  });

  it('binds again on the next round: the one before cannot come back', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const work = await atGate(c, [c.rita.id]);
    await verdict(c.ctx, c.rita.id, work.id, { pass: false, comment: 'Fix it.' });
    await submit(c.ctx, c.bruno.id, work.id, { summary: 'Fixed.', evidence: 'Seen.' });
    expect((await c.waitsOf(work)).map(w => [w.sourceKey, w.state])).toEqual([
      [reviewSourceKey(work.id, 0, c.rita.id), 'resolved'], [reviewSourceKey(work.id, 1, c.rita.id), 'active'],
    ]);
  });

  it('binds the next gate of the same round to its own reviewer', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const tess = await c.hire('Tess', 'worker', 'DEV-TEST');
    const work = await atGate(c, [c.rita.id, tess.id]);
    await verdict(c.ctx, c.rita.id, work.id, { pass: true, comment: 'Fine.' });
    expect((await c.waitsOf(work)).map(w => [w.ownerAgentId, w.state])).toEqual([[c.rita.id, 'resolved'], [tess.id, 'active']]);
  });

  it('waits for each one on a panel, and one verdict ends only that one', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const panel = await atPanel(c);
    const [other] = panel.work.panel.filter(id => id !== panel.first);
    await verdict(c.ctx, panel.first, panel.work.id, { pass: true, comment: 'Fine.' });
    const rows = await c.waitsOf(panel.work);
    expect(Object.fromEntries(rows.map(w => [w.ownerAgentId, w.state]))).toEqual({ [panel.first]: 'resolved', [other!]: 'active' });
  });

  it('is not stopped where its reviewers have no dates once the work was handed in before the department set any', async () => {
    const c = await company();
    const tess = await c.hire('Tess', 'worker', 'DEV-TEST');
    const work = await atGate(c, [c.rita.id, tess.id]);
    await c.policy();
    await verdict(c.ctx, c.rita.id, work.id, { pass: true, comment: 'Fine.' });
    expect((await c.waitsOf(work)).map(w => [w.ownerAgentId, w.state])).toEqual([[c.rita.id, 'resolved'], [tess.id, 'legacy_needs_plan']]);
  });

  it('with nobody on to check it answers to whoever gave it out, and passes to the reviewer given later', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const rev = await c.hire('Gus', 'worker', 'DEV-SEC');
    const work = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Work', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id, executor: true, gates: [rev.id] })).task;
    await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, rev.id));
    await submit(c.ctx, c.bruno.id, work.id, { summary: 'Done.', evidence: 'Seen.' });
    expect(await c.waitsOf(work)).toMatchObject([{ state: 'active', ownerAgentId: c.head.id, sourceKey: reviewSourceKey(work.id, 0, c.head.id) }]);
    await updateTask(c.ctx, c.head.id, work.id, { gates: [c.rita.id] });
    expect((await c.waitsOf(work)).map(w => [w.ownerAgentId, w.state])).toEqual([[c.head.id, 'cancelled'], [c.rita.id, 'active']]);
  });

  it('resolves what is left when the last verdict closes it', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const work = await atGate(c, [c.rita.id]);
    await verdict(c.ctx, c.rita.id, work.id, { pass: true, comment: 'Fine.' });
    expect((await c.waitsOf(work)).map(w => w.state)).toEqual(['resolved']);
  });
});

describe('a question to a person', () => {
  it('answers to the person whose decision it is, and only its own answer ends it', async () => {
    const c = await company();
    await c.policy({ kind: 'person' });
    const work = await c.task('Work');
    const one = await ask(c.ctx, c.bruno.id, work.id, { kind: 'question', text: 'Which?' });
    const two = await ask(c.ctx, c.bruno.id, work.id, { kind: 'question', text: 'And which?' });
    expect(await c.waitsOf(work)).toMatchObject([
      { kind: 'person', state: 'active', ownerPersonId: c.ceo.id, ownerAgentId: null }, { kind: 'person', state: 'active', ownerPersonId: c.ceo.id },
    ]);
    await answer(c.ctx, c.CEO, one.request.id, { answer: 'This.' });
    const rows = await c.waitsOf(work);
    const states = Object.fromEntries(rows.map(w => [w.sourceKey, w.state]));
    expect(states).toEqual({ [requestSourceKey(one.request.id)]: 'resolved', [requestSourceKey(two.request.id)]: 'active' });
    expect(rows.find(w => w.state === 'resolved')!.proofRef).toBe(`request:${one.request.id}:answered`);
  });

  it('goes to the department\'s named owner for what the department decides', async () => {
    const c = await company();
    await c.policy({ kind: 'person' });
    const [ann] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Ann', email: 'ann@example.test', status: 'active', scopeKind: 'company' }).returning();
    await c.db.update(departments).set({ ownerPersonId: ann!.id }).where(eq(departments.id, c.dev.id));
    const work = await c.task('Work');
    const asked = await ask(c.ctx, c.bruno.id, work.id, { kind: 'approval', text: 'Send it?', approval: { channel: 'message', kind: 'welcome email', amount: null }, topic: 'task' });
    expect(await c.waitsOf(work)).toMatchObject([{ ownerPersonId: ann!.id, sourceKey: requestSourceKey(asked.request.id) }]);
  });

  it('leaves an approval of a commit as it was asked: who may take it, its exact commit, and that the answer ends only its wait', async () => {
    const c = await company();
    await c.policy({ kind: 'person' });
    const [ann, zed] = await c.db.insert(people).values([
      { companyId: c.companyId, name: 'Ann', email: 'ann@example.test', status: 'active', scopeKind: 'company' },
      { companyId: c.companyId, name: 'Zed', email: 'zed@example.test', status: 'active', scopeKind: 'company' },
    ]).returning();
    await c.db.update(departments).set({ ownerPersonId: ann!.id }).where(eq(departments.id, c.dev.id));
    const work = await c.task('Work');
    const commit = 'a'.repeat(40);
    const asked = await ask(c.ctx, c.bruno.id, work.id, { kind: 'approval', text: 'Release?', commit });
    expect(asked.request).toMatchObject({ commit, status: 'open', decisionTopic: 'release' });
    expect(await c.waitsOf(work)).toMatchObject([{ ownerPersonId: ann!.id }]);
    expect(await reason(answer(c.ctx, { personId: zed!.id }, asked.request.id, { approve: true }))).toBe('decision_not_allowed');
    expect(await c.waitsOf(work)).toMatchObject([{ state: 'active' }]);
    const answered = await answer(c.ctx, { personId: ann!.id }, asked.request.id, { approve: true });
    expect(answered.request).toMatchObject({ commit, status: 'approved', answeredBy: ann!.id });
    expect(await c.waitsOf(work)).toMatchObject([{ state: 'resolved', proofRef: `request:${asked.request.id}:approved` }]);
  });

  it('ends with the question when it is taken back, and with the task when it closes', async () => {
    const c = await company();
    await c.policy({ kind: 'person' });
    const work = (await createTask(c.ctx, c.CEO, { title: 'Dept', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.head.id })).task;
    await report(c.ctx, c.head.id, work.id, { done: false, summary: 'Stuck.' });
    const [first] = await c.waitsOf(work);
    const [now] = await c.db.select().from(tasks).where(eq(tasks.id, work.id));
    await report(c.ctx, c.head.id, now!.id, { done: false, summary: 'Stuck still.' });
    const rows = await c.waitsOf(work);
    expect(rows.map(w => w.state)).toEqual(['cancelled', 'active']);
    expect(rows[0]!.proofRef).toBe(`${first!.sourceKey}:withdrawn`);
    await cancel(c.ctx, c.CEO, work.id, 'Not needed.');
    expect((await c.waitsOf(work)).map(w => w.state)).toEqual(['cancelled', 'cancelled']);
  });

  it('in a department with no policy keeps its owner with no dates, and is refused whole where dates are set for others', async () => {
    const c = await company();
    const work = await c.task('Work');
    await ask(c.ctx, c.bruno.id, work.id, { kind: 'question', text: 'Which?' });
    expect(await c.waitsOf(work)).toMatchObject([{ state: 'legacy_needs_plan', ownerPersonId: c.ceo.id, ownerDueAt: null }]);
    await c.policy({ kind: 'review' });
    const other = await c.task('Other');
    expect(await reason(ask(c.ctx, c.bruno.id, other.id, { kind: 'question', text: 'Which?' }))).toBe('task_invalid');
    expect((await c.db.select().from(tasks).where(eq(tasks.id, other.id)))[0]).toMatchObject({ status: 'open', version: other.version });
  });

  it('takes a promise in place of a policy', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const work = await c.task('Work');
    await ask(c.ctx, c.bruno.id, work.id, { kind: 'question', text: 'Which?', plan: c.plan() });
    expect(await c.waitsOf(work)).toMatchObject([{ state: 'active', plan: { provenance: { kind: 'explicit_promise' } } }]);
  });

  it('never refuses what Hornhoof asks by itself, or an owner who says a person must unblock it', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const work = (await createTask(c.ctx, c.CEO, { title: 'Dept', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.head.id })).task;
    await report(c.ctx, c.head.id, work.id, { done: false, summary: 'Stuck.' });
    expect(await c.waitsOf(work)).toMatchObject([{ kind: 'person', state: 'legacy_needs_plan', ownerPersonId: c.ceo.id }]);
  });

  it('ends the durable request wait when the internal resolver answers', async () => {
    const c = await company();
    const work = (await createTask(c.ctx, c.CEO, { title: 'Dept', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.head.id })).task;
    await report(c.ctx, c.head.id, work.id, { done: false, summary: 'Stuck.' });
    const [request] = await c.db.select().from(requests).where(eq(requests.taskId, work.id));
    expect(await c.waitsOf(work)).toMatchObject([{ sourceKey: requestSourceKey(request!.id), state: 'legacy_needs_plan' }]);
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [sub] = await c.db.select().from(subscriptions);
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'Resolve the request.', timeoutMs: 900000, status: 'running' }).returning();

    const resolved = await resolveStuck(c.ctx, { id: job!.id, companyId: c.companyId, agentId: orchestrator!.id }, request!.id, { retry: true });

    expect(resolved?.request.status).toBe('resolved_internal');
    expect(await c.waitsOf(work)).toMatchObject([{ sourceKey: requestSourceKey(request!.id), state: 'resolved', proofRef: `request:${request!.id}:resolved_internal` }]);
  });
});

describe('a run', () => {
  const run = (c: Awaited<ReturnType<typeof company>>, work: Task) => ({ id: randomUUID(), taskId: work.id, companyId: c.companyId, agentId: c.bruno.id, departmentId: c.dev.id });

  it('is refused whole where the department set dates but none for this stage', async () => {
    const c = await company();
    await c.policy({ kind: 'run', stage: 'execute' });
    const work = await c.task('Work');
    expect(await reason(c.db.transaction(tx => recordRunWait(tx, run(c, work), 'queue', new Date())))).toBe('task_invalid');
    expect(await c.waitsOf(work)).toEqual([]);
  });

  it('keeps a wait with no dates in a department with no policy', async () => {
    const c = await company();
    const work = await c.task('Work');
    await c.db.transaction(tx => recordRunWait(tx, run(c, work), 'queue', new Date()));
    expect(await c.waitsOf(work)).toMatchObject([{ kind: 'run', state: 'legacy_needs_plan', ownerAgentId: c.bruno.id }]);
  });
});

describe('someone leaving', () => {
  it('moves the review on without dates where none are set for reviews, rather than leaving work with one who left', async () => {
    const c = await company();
    const tess = await c.hire('Tess', 'worker', 'DEV-TEST');
    const work = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Work', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id, executor: true, gates: [c.rita.id, tess.id] })).task;
    await submit(c.ctx, c.bruno.id, work.id, { summary: 'Done.', evidence: 'Seen.' });
    await c.policy();
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.rita.id));
    await leaveWork(c.ctx, c.CEO, { id: c.rita.id, name: c.rita.name, companyId: c.companyId });
    const [moved] = await c.db.select().from(tasks).where(eq(tasks.id, work.id));
    expect(moved!.panel).toEqual([tess.id]);
    expect((await c.waitsOf(work)).map(w => [w.ownerAgentId, w.state])).toEqual([[c.rita.id, 'cancelled'], [tess.id, 'legacy_needs_plan']]);
  });
});

describe('a wait_for', () => {
  const until = () => new Date(Date.now() + HOUR).toISOString();

  it('is refused whole where the department set dates but none for it, and no plan is given', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const work = await c.task('Work');
    expect(await reason(waitFor(c.ctx, c.bruno.id, work.id, { reason: 'The build', until: until() }))).toBe('task_invalid');
    expect((await c.db.select().from(tasks).where(eq(tasks.id, work.id)))[0]!.externalWait).toBeNull();
  });

  it('takes the department\'s dates, with its holder answering for an event', async () => {
    const c = await company();
    await c.policy({ kind: 'external' });
    const work = await c.task('Work');
    const moved = await waitFor(c.ctx, c.bruno.id, work.id, { reason: 'The build', until: until() });
    expect(await c.waitsOf(work)).toMatchObject([{ kind: 'external', state: 'active', ownerAgentId: c.bruno.id, sourceKey: waitForSourceKey(moved.task.externalWait!.operation!), plan: { provenance: { kind: 'department_policy' } } }]);
  });

  it('ends when the work goes on to its gate, and the wait for the reviewer takes over', async () => {
    const c = await company();
    await c.policy({ kind: 'external' });
    await c.policy({ kind: 'review' });
    const work = await c.task('Work', { gates: [c.rita.id] });
    await waitFor(c.ctx, c.bruno.id, work.id, { reason: 'The build', until: until() });
    await submit(c.ctx, c.bruno.id, work.id, { summary: 'Done.', evidence: 'Seen.' });
    expect((await c.waitsOf(work)).map(w => [w.kind, w.state])).toEqual([['external', 'superseded'], ['review', 'active']]);
  });

  it('in a department with no policy keeps a wait with no dates', async () => {
    const c = await company();
    const work = await c.task('Work');
    await waitFor(c.ctx, c.bruno.id, work.id, { reason: 'The build', until: until() });
    expect(await c.waitsOf(work)).toMatchObject([{ kind: 'external', state: 'legacy_needs_plan', ownerAgentId: c.bruno.id }]);
  });

  it('ends once the holder moves the work on, while a comment that resumes it leaves it standing', async () => {
    const c = await company();
    await c.policy({ kind: 'external' });
    const work = await c.task('Work');
    await waitFor(c.ctx, c.bruno.id, work.id, { reason: 'The build', until: until() });
    const { comment } = await import('../src/modules/tasks/engine.js');
    await comment(c.ctx, { agentId: c.head.id }, work.id, 'Any news?');
    const [resumed] = await c.waitsOf(work);
    expect(resumed).toMatchObject({ state: 'active', generation: 1 });
    await submit(c.ctx, c.bruno.id, work.id, { summary: 'Done.', evidence: 'Seen.' });
    expect((await c.waitsOf(work)).map(w => w.state)).toEqual(['resolved']);
  });
});
