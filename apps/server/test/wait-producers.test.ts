import { randomUUID } from 'node:crypto';
import type { WaitPlan } from '@hornhoof/protocol/waits';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, companies, departments, jobs, people, requests, subscriptions, taskEvents, tasks, taskWaits, waitPolicies } from '../src/db/schema.js';
import { answer, ask, cancel, createTask, leaveWork, report, submit, updateTask, verdict, type Task } from '../src/modules/tasks/engine.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { backOn } from '../src/modules/tasks/wake.js';
import { waitFor } from '../src/modules/tasks/external-wait.js';
import { resolveStuck } from '../src/modules/tasks/stuck.js';
import { afterSourceKey, recordRunWait, requestSourceKey, reviewSourceKey, waitForSourceKey } from '../src/modules/tasks/wait-state.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { setUpCompany, testApp, echelonsTurn } from './helpers.js';
import { recorded } from './recorded-fixture.js';

const HOUR = 3_600_000;
const later = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev, ops] = await db.insert(departments).values([{ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }, { companyId, templateKey: 'operations', roleCode: 'OPS' }]).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const ctx = app.ctx;
  let commit = HEAD;
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: commit });
  ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const atCommit = (sha: string) => { commit = sha; };
  const snapshot = async (id: string) => { const [task] = await db.select().from(tasks).where(eq(tasks.id, id)); return routeSnapshot(await routeOf(db, task!), task!.assigneeAgentId); };
  const CEO = { personId: ceo!.id };
  const task = async (title: string, change: Partial<Parameters<typeof createTask>[2]> = {}) => (await createTask(ctx, CEO, { title, brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, small: true, paths: ['logic/totals.ts'], ...change })).task;
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
  await echelonsTurn(db, companyId);
  return { ctx, db, atCommit, snapshot, companyId, CEO, ceo: ceo!, dev: dev!, ops: ops!, head, bruno, rita, task, policy, waitsOf, plan, hire };
}

const code = { summary: 'Done.', evidence: 'Changed total tests.', review: { baseCommit: BASE } };
const reason = (p: Promise<unknown>) => p.then(() => 'ok', (err: { reason?: string }) => err.reason ?? String(err));

describe('a task that comes after others', () => {
  it('in a department with no policy keeps a wait with no dates for each open edge, its holder answering for it', async () => {
    const c = await company();
    /* Where the department keeps code, a worker closes a task without code only through its head; these keep none. */
    await c.db.update(departments).set({ repoUrl: null });
    const first = await c.task('First', { assigneeAgentId: c.rita.id });
    const finished = await c.task('Finished decision', { executor: false, resultKind: 'coordination' });
    await report(c.ctx, c.bruno.id, finished.id, { done: true, summary: 'Checked the scope decision.', ...(await recorded(c.ctx, finished.id, c.bruno.id)) });
    const follow = await c.task('Follow', { after: [first.id, finished.id], independentNone: 'One piece.' });
    expect(await c.waitsOf(follow)).toMatchObject([{
      kind: 'after', sourceKey: afterSourceKey(first.id), state: 'legacy_needs_plan', ownerAgentId: c.rita.id, plan: null, ownerDueAt: null, nextActionAt: null, level: 0,
    }]);
  });

  it('takes its dates from the department once it set one, from the moment it was given', async () => {
    const c = await company();
    await c.policy();
    const first = await c.task('First', { assigneeAgentId: c.rita.id });
    /* The moment it was given, on a clock that stands still. */
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const given = new Date();
    const follow = await c.task('Follow', { after: [first.id], independentNone: 'One piece.' });
    const [wait] = await c.waitsOf(follow);
    expect(wait).toMatchObject({ state: 'active', ownerAgentId: c.rita.id, plan: { provenance: { kind: 'department_policy', revision: 1 } }, level: 0 });
    expect(wait!.ownerDueAt).toEqual(new Date(given.getTime() + HOUR));
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
    /* Where the department keeps code, a worker closes a task without code only through its head; these keep none. */
    await c.db.update(departments).set({ repoUrl: null });
    await c.policy();
    const [one, two] = [await c.task('One decision', { assigneeAgentId: c.rita.id, executor: false, resultKind: 'coordination' }), await c.task('Two decisions', { assigneeAgentId: c.rita.id, executor: false, resultKind: 'coordination' })];
    const follow = await c.task('Follow', { after: [one.id, two.id], independentNone: 'One piece.' });
    await updateTask(c.ctx, c.head.id, one.id, { ownerAgentId: c.bruno.id });
    await report(c.ctx, c.bruno.id, one.id, { done: true, summary: 'Checked the first decision.', ...(await recorded(c.ctx, one.id, c.bruno.id)) });
    const rows = await c.waitsOf(follow);
    const edge = (t: Task) => rows.find(w => w.sourceKey === afterSourceKey(t.id))!;
    expect([edge(one).state, edge(two).state]).toEqual(['resolved', 'active']);
    expect(edge(one).proofRef).toBe(`task:${one.id}:done`);
    expect((await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, follow.id), eq(taskEvents.kind, 'started'))))).toEqual([]);
    await report(c.ctx, c.rita.id, two.id, { done: true, summary: 'Checked the second decision.', ...(await recorded(c.ctx, two.id, c.rita.id)) });
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

describe('a candidate at its current checking stage', () => {
  const atReview = async (c: Awaited<ReturnType<typeof company>>, change: Parameters<typeof c.task>[1] = {}) => {
    const work = await c.task('Work', { reviewerAgentId: c.rita.id, ...change });
    await submit(c.ctx, c.bruno.id, work.id, code);
    return work;
  };
  const key = async (c: Awaited<ReturnType<typeof company>>, work: Task, owner = c.rita.id) => {
    const snapshot = await c.snapshot(work.id);
    return reviewSourceKey(work.id, snapshot.stage!, snapshot.candidateId!, owner);
  };
  const securityTask = async (c: Awaited<ReturnType<typeof company>>) => {
    const checker = await c.hire('Security', 'worker', 'DEV-SEC');
    const work = await atReview(c, { riskClass: 'security', securityAgentId: checker.id });
    return { checker, work };
  };

  it('keeps an undated wait for one exact Review candidate and owner when no policy exists', async () => {
    const c = await company();
    const work = await atReview(c);
    expect(await c.waitsOf(work)).toMatchObject([{ kind: 'review', sourceKey: await key(c, work), state: 'legacy_needs_plan', ownerAgentId: c.rita.id }]);
  });

  it('keeps its policy dates during owner repair and ends with the recorded forward verdict', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const work = await atReview(c);
    const [before] = await c.waitsOf(work);
    await verdict(c.ctx, c.rita.id, work.id, { pass: false, comment: 'I am fixing it.', reviewedCommit: HEAD });
    expect(await c.waitsOf(work)).toMatchObject([{ id: before!.id, state: 'active', generation: before!.generation, ownerDueAt: before!.ownerDueAt, proofRef: null }]);
    await verdict(c.ctx, c.rita.id, work.id, { pass: true, comment: 'Checked.', reviewedCommit: HEAD });
    const [event] = (await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, work.id), eq(taskEvents.kind, 'verdict')))).filter(event => event.data.pass === true);
    expect(await c.waitsOf(work)).toMatchObject([{ state: 'resolved', proofRef: `moved:${event!.id}` }]);
  });

  it('refuses the whole handoff if a strict department has no Review policy', async () => {
    const c = await company();
    await c.policy();
    const work = await c.task('Work', { reviewerAgentId: c.rita.id });
    expect(await reason(submit(c.ctx, c.bruno.id, work.id, code))).toBe('task_invalid');
    expect((await c.db.select().from(tasks).where(eq(tasks.id, work.id)))[0]).toMatchObject({ status: 'open', version: work.version });
    expect((await c.snapshot(work.id)).stage).toBe('development');
    expect(await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, work.id), eq(taskEvents.kind, 'submitted')))).toEqual([]);
  });

  it('supersedes its Review wait when the reviewer hands a repaired candidate to Tests', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const tester = await c.hire('Tests', 'worker', 'DEV-TEST');
    const work = await atReview(c, { testsAgentId: tester.id });
    const input = await c.snapshot(work.id);
    const original = await key(c, work);
    await verdict(c.ctx, c.rita.id, work.id, { pass: false, comment: 'I am fixing it.', reviewedCommit: HEAD });
    c.atCommit('c'.repeat(40));
    await submit(c.ctx, c.rita.id, work.id, { ...code, summary: 'Fixed.' });
    const repaired = await c.snapshot(work.id);
    expect(repaired).toMatchObject({ stage: 'tests', phase: 'active', ownerAgentId: tester.id });
    expect(repaired.candidateId).not.toBe(input.candidateId);
    expect(repaired.stages.find(step => step.stage === 'tests')!.inputCandidateId).toBe(repaired.candidateId);
    const submitted = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, work.id), eq(taskEvents.kind, 'submitted'))).orderBy(asc(taskEvents.id));
    expect(submitted.at(-1)!.data.candidate).toMatchObject({ id: repaired.candidateId, parentId: input.candidateId, commit: 'c'.repeat(40), producedBy: { agentId: c.rita.id, stage: 'review' } });
    expect((await c.waitsOf(work)).map(wait => [wait.sourceKey, wait.state])).toEqual([[original, 'superseded']]);
  });

  it('binds conditional Security to the same candidate and its own current owner', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const { checker, work } = await securityTask(c);
    await verdict(c.ctx, c.rita.id, work.id, { pass: true, comment: 'Checked.', reviewedCommit: HEAD });
    expect((await c.snapshot(work.id)).stage).toBe('security');
    expect((await c.waitsOf(work)).map(wait => [wait.ownerAgentId, wait.state])).toEqual([[c.rita.id, 'resolved'], [checker.id, 'active']]);
    expect((await c.waitsOf(work))[1]!.sourceKey).toBe(await key(c, work, checker.id));
  });

  it('creates only the named owner wait even when another provider has an eligible reviewer', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const [other] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'codex', kind: 'personal', label: 'Other', ownerPersonId: c.ceo.id, status: 'ready' }).returning();
    const reviewer = await c.hire('Sara', 'worker', 'DEV-REV');
    await c.db.update(agents).set({ subscriptionId: other!.id, model: 'gpt-6.1-sol' }).where(eq(agents.id, reviewer.id));
    const work = await atReview(c);
    expect(await c.waitsOf(work)).toMatchObject([{ ownerAgentId: c.rita.id, sourceKey: await key(c, work) }]);
    await verdict(c.ctx, c.rita.id, work.id, { pass: true, comment: 'Checked.', reviewedCommit: HEAD });
    expect((await c.waitsOf(work)).map(wait => wait.state)).toEqual(['resolved']);
  });

  it('never refuses an automatic Security handoff when a later policy omits checking dates', async () => {
    const c = await company();
    const { checker, work } = await securityTask(c);
    await c.policy();
    await verdict(c.ctx, c.rita.id, work.id, { pass: true, comment: 'Checked.', reviewedCommit: HEAD });
    expect((await c.waitsOf(work)).map(wait => [wait.ownerAgentId, wait.state])).toEqual([[c.rita.id, 'resolved'], [checker.id, 'legacy_needs_plan']]);
  });

  it('waits for an eligible owner without inventing a head check and binds the assigned reviewer later', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const unavailable = await c.hire('Gus', 'worker', 'DEV-REV');
    const work = await c.task('Work', { reviewerAgentId: unavailable.id });
    await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, unavailable.id));
    await submit(c.ctx, c.bruno.id, work.id, code);
    const candidateId = (await c.snapshot(work.id)).candidateId;
    expect(await c.waitsOf(work)).toEqual([]);
    expect(await c.snapshot(work.id)).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null });
    await updateTask(c.ctx, c.head.id, work.id, { ownerAgentId: c.rita.id });
    expect(await c.snapshot(work.id)).toMatchObject({ stage: 'review', candidateId, ownerAgentId: c.rita.id });
    expect(await c.waitsOf(work)).toMatchObject([{ state: 'active', ownerAgentId: c.rita.id, sourceKey: await key(c, work) }]);
  });

  it('ends Review once without declaring the executable result complete before Tests', async () => {
    const c = await company();
    await c.policy({ kind: 'review' });
    const work = await atReview(c);
    const moved = await verdict(c.ctx, c.rita.id, work.id, { pass: true, comment: 'Checked.', reviewedCommit: HEAD });
    expect(moved.task.status).not.toBe('done');
    expect((await c.snapshot(work.id)).stage).toBe('tests');
    expect((await c.waitsOf(work)).map(wait => wait.state)).toEqual(['resolved']);
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

  it('keeps its owner with no dates in a department with no policy, and also where dates are set for others', async () => {
    const c = await company();
    const work = await c.task('Work');
    await ask(c.ctx, c.bruno.id, work.id, { kind: 'question', text: 'Which?' });
    expect(await c.waitsOf(work)).toMatchObject([{ state: 'legacy_needs_plan', ownerPersonId: c.ceo.id, ownerDueAt: null }]);
    await c.policy({ kind: 'review' });
    const other = await c.task('Other');
    await ask(c.ctx, c.bruno.id, other.id, { kind: 'question', text: 'Which?' });
    expect(await c.waitsOf(other)).toMatchObject([{ state: 'legacy_needs_plan', ownerPersonId: c.ceo.id, ownerDueAt: null }]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, other.id)))[0]).toMatchObject({ status: 'waiting' });
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
  it('resumes the same required Review with an eligible replacement without inventing checking dates', async () => {
    const c = await company();
    const replacement = await c.hire('Replacement', 'worker', 'DEV-REV');
    const work = await c.task('Work', { reviewerAgentId: c.rita.id });
    await submit(c.ctx, c.bruno.id, work.id, code);
    const candidateId = (await c.snapshot(work.id)).candidateId;
    await c.policy();
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.rita.id));
    await leaveWork(c.ctx, c.CEO, c.rita);
    expect(await c.snapshot(work.id)).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null, candidateId });
    await backOn(c.ctx, c.CEO, replacement.id);
    expect(await c.snapshot(work.id)).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: replacement.id, candidateId });
    expect((await c.waitsOf(work)).map(wait => [wait.ownerAgentId, wait.state])).toEqual([[c.rita.id, 'superseded'], [replacement.id, 'legacy_needs_plan']]);
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
    const work = await c.task('Work', { reviewerAgentId: c.rita.id });
    await waitFor(c.ctx, c.bruno.id, work.id, { reason: 'The build', until: until() });
    await submit(c.ctx, c.bruno.id, work.id, code);
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
    await c.policy({ kind: 'review' });
    const work = await c.task('Work');
    await waitFor(c.ctx, c.bruno.id, work.id, { reason: 'The build', until: until() });
    const { comment } = await import('../src/modules/tasks/engine.js');
    await comment(c.ctx, { agentId: c.head.id }, work.id, 'Any news?');
    const [resumed] = await c.waitsOf(work);
    expect(resumed).toMatchObject({ state: 'active', generation: 1 });
    await submit(c.ctx, c.bruno.id, work.id, code);
    expect((await c.waitsOf(work)).map(w => [w.kind, w.state])).toEqual([['external', 'superseded'], ['review', 'active']]);
  });
});
