import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, requests, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { answer, ask, blocked, cancel, comment, createTask, leaveWork, report, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { listen, mcp, setUpCompany, testApp, echelonsTurn } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const tess = await hire('Tess', 'worker', 'DEV-TEST');
  const ctx = app.ctx;
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
  ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const CEO = { personId: ceo!.id };
  /* A department task from the CEO, and a member task the head made from it. */
  const deptTask = async () => (await createTask(ctx, CEO, { title: 'Payments', brief: 'Take card payments.', body: 'Stripe checkout.', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  const memberTask = async (reviewerAgentId = rita.id) => {
    const parent = await deptTask();
    return (await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: 'The API.', body: 'POST /checkout.', departmentId: dev!.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId, testsAgentId: tess.id })).task;
  };
  const read = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const snapshot = async (id: string) => { const task = await read(id); return routeSnapshot(await routeOf(db, task), task.assigneeAgentId); };
  await echelonsTurn(db, companyId);
  return { app, ctx, db, companyId, sub: sub!, snapshot, CEO, orchestrator: orchestrator!, dev: dev!, head, bruno, rita, tess, deptTask, memberTask, read };
}

/* The tools of an agent in a running turn of its own. */
async function mcpOf(c: Awaited<ReturnType<typeof company>>, agentId: string) {
  await listen(c.app);
  const token = `engine-${agentId}`;
  await c.db.insert(jobs).values({ companyId: c.companyId, agentId, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Work.', status: 'running', startedAt: new Date(), timeoutMs: 60_000, toolTokenHash: hashToken(token) });
  return mcp(c.app, token);
}

const code = { summary: 'Done.', evidence: 'Changed total tests.', review: { baseCommit: BASE } };
const reason = (p: Promise<unknown>) => p.then(() => 'ok', (err: { reason?: string }) => err.reason);
const woken = (r: { wakes: { agentId: string; why: string }[] }) => r.wakes.map(w => [w.agentId, w.why]);

describe('the task engine', () => {
  it('keeps the current stage unassigned after its executor leaves until the head assigns an owner', async () => {
    const { ctx, CEO, head, bruno, memberTask, read } = await company();
    const task = await memberTask();
    await blocked(ctx, bruno.id, task.id, 'Which currency?');
    await leaveWork(ctx, CEO, bruno);
    expect(await read(task.id)).toMatchObject({ status: 'waiting', assigneeAgentId: null, executorAgentId: bruno.id });
    const result = await comment(ctx, { agentId: head.id }, task.id, 'The next executor will use euros.');
    expect(result.wakes).toEqual([]);
    expect(await read(task.id)).toMatchObject({ status: 'waiting', assigneeAgentId: null, executorAgentId: bruno.id });
  });

  it('opens a blocked member task again when whoever gave it out answers in a comment, and wakes its executor with it', async () => {
    const { ctx, db, orchestrator, head, bruno, rita, memberTask, read } = await company();
    const task = await memberTask();
    await blocked(ctx, bruno.id, task.id, 'Which currency?');
    const aside = await comment(ctx, { agentId: rita.id }, task.id, 'I would ask too.');
    expect([aside.wakes, (await read(task.id)).status]).toEqual([[], 'blocked']);
    const answered = await comment(ctx, { agentId: head.id }, task.id, 'Euros only.');
    expect(answered.task).toMatchObject({ status: 'open', assigneeAgentId: bruno.id, silent: 0 });
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(taskEvents.id);
    expect(log.at(-1)).toMatchObject({ kind: 'comment', agentId: head.id, text: 'Euros only.' });
    expect(answered.wakes).toEqual([{
      agentId: bruno.id, taskId: task.id, why: 'unblocked', text: 'Euros only.',
      cause: { actor: { agentId: head.id }, action: 'commented', eventId: log.at(-1)!.id, task: { id: task.id, number: task.number } },
    }]);
    const [me] = await db.select().from(agents).where(eq(agents.id, bruno.id));
    const prompt = wakePrompt(me!, answered.task, answered.wakes[0]!);
    expect(prompt).toContain('answered what blocked it');
    expect(prompt).toContain('Euros only.');
    expect(prompt).toContain('blocked');
    const [hana] = await db.select().from(agents).where(eq(agents.id, head.id));
    const stopped = await blocked(ctx, bruno.id, task.id, 'And the rounding?');
    expect(wakePrompt(hana!, stopped.task, stopped.wakes[0]!)).toContain('Answer it with comment, which opens it again for its executor once');
    expect(wakePrompt(hana!, stopped.task, stopped.wakes[0]!)).toContain('write the answer into the task with update_task');
    const other = await memberTask();
    await blocked(ctx, bruno.id, other.id, 'Which rounding?');
    const resumed = await comment(ctx, { agentId: orchestrator.id }, other.id, 'Round half up.');
    expect(resumed.task).toMatchObject({ status: 'open', assigneeAgentId: bruno.id });
    expect(woken(resumed)).toEqual([[bruno.id, 'unblocked']]);
    await comment(ctx, { agentId: head.id }, task.id, 'Round half up as well.');
    await updateTask(ctx, head.id, task.id, { body: 'POST /checkout, rounding half up.' });
    expect(woken(await comment(ctx, { agentId: head.id }, task.id, 'Thanks.'))).toEqual([[bruno.id, 'comment']]);
    expect(woken(await comment(ctx, { agentId: bruno.id }, task.id, 'Understood.'))).toEqual([]);
  });

  describe('a task blocked again after a comment opened it', () => {
    async function blockedAgain() {
      const c = await company();
      const task = await c.memberTask();
      await blocked(c.ctx, c.bruno.id, task.id, 'Which currency?');
      expect(woken(await comment(c.ctx, { agentId: c.head.id }, task.id, 'I asked finance, wait.'))).toEqual([[c.bruno.id, 'unblocked']]);
      await blocked(c.ctx, c.bruno.id, task.id, 'Still no currency.');
      return { ...c, task };
    }

    it('stays blocked and wakes nobody on another comment from whoever gave it out', async () => {
      const c = await blockedAgain();
      for (const actor of [c.head, c.orchestrator]) {
        const later = await comment(c.ctx, { agentId: actor.id }, c.task.id, 'Still asking finance.');
        expect([later.wakes, later.task.status]).toEqual([[], 'blocked']);
      }
      expect(await c.read(c.task.id)).toMatchObject({ status: 'blocked', assigneeAgentId: c.bruno.id });
    });

    it('opens again when the answer goes into the task, and a comment opens it once more after that', async () => {
      const c = await blockedAgain();
      const rewritten = await updateTask(c.ctx, c.head.id, c.task.id, { body: 'Stripe checkout in euros.' });
      expect(rewritten.task).toMatchObject({ status: 'open', assigneeAgentId: c.bruno.id });
      await blocked(c.ctx, c.bruno.id, c.task.id, 'And the rounding?');
      expect(woken(await comment(c.ctx, { agentId: c.head.id }, c.task.id, 'Round half up.'))).toEqual([[c.bruno.id, 'unblocked']]);
    });

    it('tells whoever gave it out that a comment no longer opens it', async () => {
      const c = await blockedAgain();
      const head = await mcpOf(c, c.head.id);
      const said = await head.callTool({ name: 'comment', arguments: { task: c.task.number, text: 'Still asking finance.' } });
      expect(said.isError).toBeFalsy();
      expect(JSON.stringify(said.content)).toContain('stays blocked');
      expect(JSON.stringify(said.content)).toContain('update_task');
    });
  });

  it('refuses to block a task that is blocked already, and tells nobody again', async () => {
    const { ctx, CEO, bruno, memberTask, read } = await company();
    const task = await memberTask();
    await blocked(ctx, bruno.id, task.id, 'Which currency?');
    await comment(ctx, CEO, task.id, 'Check the accounting notes.');
    await expect(blocked(ctx, bruno.id, task.id, 'Still which currency?')).rejects.toMatchObject({ status: 409 });
    expect(await read(task.id)).toMatchObject({ status: 'blocked' });
  });

  it('delivers a person comment to the blocked executor without opening the task', async () => {
    const { ctx, db, CEO, bruno, memberTask, read } = await company();
    const task = await memberTask();
    await blocked(ctx, bruno.id, task.id, 'Which currency?');
    const result = await comment(ctx, CEO, task.id, 'Check the accounting notes.');
    expect(result.task).toMatchObject({ status: 'blocked', assigneeAgentId: bruno.id });
    expect(await read(task.id)).toMatchObject({ status: 'blocked', assigneeAgentId: bruno.id });
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(taskEvents.id);
    expect(log.at(-1)).toMatchObject({ kind: 'comment', personId: CEO.personId, text: 'Check the accounting notes.' });
    expect(result.wakes).toEqual([{
      agentId: bruno.id, taskId: task.id, why: 'comment', text: 'Check the accounting notes.',
      cause: { actor: CEO, action: 'commented', eventId: log.at(-1)!.id, task: { id: task.id, number: task.number } },
    }]);
  });

  it("gives a person's task to the department head and wakes the head", async () => {
    const { ctx, db, CEO, dev, head } = await company();
    const res = await createTask(ctx, CEO, { title: 'Payments', brief: 'Take card payments.', body: 'Stripe checkout.', departmentId: dev.id, assigneeAgentId: head.id });
    expect(res.task).toMatchObject({ number: 1, status: 'open', assigneeAgentId: head.id, createdByPersonId: CEO.personId, departmentId: dev.id });
    expect(woken(res)).toEqual([[head.id, 'assigned']]);
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, res.task.id));
    expect(log.map(e => [e.kind, e.personId])).toEqual([['created', CEO.personId]]);
    expect((await createTask(ctx, CEO, { title: 'Next', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id })).task.number).toBe(2);
  });

  it('hands Development to mandatory Review and then Tests without closing the result early', async () => {
    const { ctx, bruno, rita, tess, memberTask, read, snapshot } = await company();
    const task = await memberTask();
    expect(await snapshot(task.id)).toMatchObject({ stage: 'development', ownerAgentId: bruno.id });
    const sent = await submit(ctx, bruno.id, task.id, code);
    expect(sent.task).toMatchObject({ status: 'review', assigneeAgentId: rita.id });
    expect(woken(sent)).toEqual([[rita.id, 'review']]);
    const checked = await verdict(ctx, rita.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Clean diff.' });
    expect(await snapshot(task.id)).toMatchObject({ stage: 'tests', phase: 'active', ownerAgentId: tess.id });
    expect(woken(checked)).toEqual([[tess.id, 'assigned']]);
    expect((await read(task.id)).closedAt).toBeNull();
    /* Tests gives no verdict: its owner is told how a repair goes in and how its report is given (07dedb90, #1208). */
    await expect(verdict(ctx, tess.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'A verdict cannot replace finished test receipts.' }))
      .rejects.toMatchObject({ status: 409, reason: 'task_invalid', message: expect.stringMatching(/submit.*report/s) as unknown });
    expect(await snapshot(task.id)).toMatchObject({ stage: 'tests', phase: 'active', ownerAgentId: tess.id });
    expect((await read(task.id)).closedAt).toBeNull();
  });

  it('keeps repeated findings with the reviewer and never wakes the original producer for repair', async () => {
    const { ctx, bruno, rita, memberTask, snapshot } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, code);
    const candidateId = (await snapshot(task.id)).candidateId;
    for (let i = 0; i < 3; i++) {
      const repair = await verdict(ctx, rita.id, task.id, { pass: false, comment: 'I am fixing the missing refund test.', reviewedCommit: HEAD });
      expect(repair.task).toMatchObject({ status: 'working', assigneeAgentId: rita.id });
      expect(repair.wakes).toEqual([]);
      expect(await snapshot(task.id)).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: rita.id, candidateId });
    }
    await expect(submit(ctx, bruno.id, task.id, code)).rejects.toMatchObject({ reason: 'task_not_yours' });
  });

  it('never lets the executor pass its own Review', async () => {
    const { ctx, bruno, memberTask } = await company();
    expect(await reason(memberTask(bruno.id))).toBe('task_invalid');
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, code);
    expect(await reason(verdict(ctx, bruno.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Looks good to me.' }))).toBe('task_not_yours');
  });

  it('refuses a verdict without reasons or from an employee outside the current stage', async () => {
    const { ctx, bruno, rita, tess, memberTask, read } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, code);
    expect(await reason(verdict(ctx, tess.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Fine.' }))).toBe('task_not_yours');
    expect(await reason(verdict(ctx, rita.id, task.id, { pass: true, reviewedCommit: HEAD, comment: '  ' }))).toBe('task_invalid');
    expect(await read(task.id)).toMatchObject({ status: 'review', assigneeAgentId: rita.id });
  });

  it('refuses to cancel a finished task', async () => {
    const { ctx, CEO, head, deptTask } = await company();
    const task = await deptTask();
    expect((await report(ctx, head.id, task.id, { done: true, summary: 'Checked the coordination result.' })).task.status).toBe('done');
    expect(await reason(cancel(ctx, CEO, task.id, 'Not needed.'))).toBe('task_closed');
  });

  it('lets only one of two moves that read the same task land', async () => {
    const { ctx, CEO, bruno, rita, memberTask, read } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, code);
    const both = await Promise.allSettled([verdict(ctx, rita.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Clean.' }), cancel(ctx, CEO, task.id, 'Dropped.')]);
    expect(both.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((both.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.reason).toBe('task_changed');
    expect(['open', 'cancelled']).toContain((await read(task.id)).status);
  });

  it('tells whoever gave a department task when its head reports, and asks a person when a head is blocked on theirs, whose question the orchestrator puts into plain words', async () => {
    const { ctx, db, orchestrator, dev, head, deptTask } = await company();
    const given = await createTask(ctx, { agentId: orchestrator.id }, { title: 'Pricing page', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id });
    const done = await report(ctx, head.id, given.task.id, { done: true, summary: 'Shipped behind a flag.' });
    expect(done.task.status).toBe('done');
    expect(woken(done)).toEqual([[orchestrator.id, 'reported']]);
    const mine = await deptTask();
    const stuck = await report(ctx, head.id, mine.id, { done: false, summary: 'Need a Stripe account.' });
    expect(stuck.task.status).toBe('waiting');
    expect(woken(stuck)).toEqual([[orchestrator.id, 'explain']]);
    expect(await db.select({ kind: requests.kind, text: requests.text, status: requests.status }).from(requests)).toEqual([{ kind: 'stuck', text: 'Need a Stripe account.', status: 'open' }]);
  });

  it('lets a blocked executor wait for its head', async () => {
    const { ctx, head, bruno, memberTask } = await company();
    const task = await memberTask();
    const res = await blocked(ctx, bruno.id, task.id, 'The API key is missing.');
    expect(res.task).toMatchObject({ status: 'blocked', assigneeAgentId: bruno.id });
    expect(woken(res)).toEqual([[head.id, 'blocked']]);
  });

  it('waits for a person and wakes the agent with the answer', async () => {
    const { ctx, CEO, bruno, memberTask, read } = await company();
    const task = await memberTask();
    const asked = await ask(ctx, bruno.id, task.id, { kind: 'question', text: 'Which currency?' });
    expect((await read(task.id)).status).toBe('waiting');
    const answered = await answer(ctx, CEO, asked.request.id, { answer: 'EUR' });
    expect(answered.request).toMatchObject({ status: 'answered', answer: 'EUR', answeredBy: CEO.personId });
    expect((await read(task.id)).status).toBe('working');
    expect(woken(answered)).toEqual([[bruno.id, 'answered']]);
    expect(await reason(ask(ctx, bruno.id, task.id, { kind: 'approval', text: 'Release?', commit: 'abc' }))).toBe('task_invalid');
    const approval = await ask(ctx, bruno.id, task.id, { kind: 'approval', text: 'Release 0.5.0?', commit: 'a'.repeat(40) });
    expect(await reason(answer(ctx, CEO, approval.request.id, { answer: 'yes' }))).toBe('task_invalid');
    expect((await answer(ctx, CEO, approval.request.id, { approve: true })).request.status).toBe('approved');
    expect(await reason(answer(ctx, CEO, approval.request.id, { approve: false }))).toBe('request_closed');
  });

  it('leaves a task that closed while a person answered it closed', async () => {
    const { ctx, db, CEO, bruno, memberTask, read } = await company();
    const task = await memberTask();
    const asked = await ask(ctx, bruno.id, task.id, { kind: 'question', text: 'Which currency?' });
    /* The task is cancelled after the answer read it and before the answer is written. */
    const begin = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async (fn, config) => {
      await db.update(tasks).set({ status: 'cancelled', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task.id));
      return begin(fn, config);
    });
    const answered = await answer(ctx, CEO, asked.request.id, { answer: 'EUR' });
    expect((await read(task.id)).status).toBe('cancelled');
    expect(answered.wakes).toEqual([]);
  });

  it('gives no subtask under a task cancelled while it was being made', async () => {
    const { ctx, db, dev, head, bruno, deptTask } = await company();
    const parent = await deptTask();
    const begin = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async (fn, config) => {
      await db.update(tasks).set({ status: 'cancelled', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, parent.id));
      return begin(fn, config);
    });
    const made = createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true });
    expect(await reason(made)).toBe('task_closed');
    expect((await db.select().from(tasks)).map(t => t.id)).toEqual([parent.id]);
  });

  it('keeps a task open while a subtask under it is open', async () => {
    const { ctx, head, memberTask, read } = await company();
    const child = await memberTask();
    expect(await reason(report(ctx, head.id, child.parentId!, { done: true, summary: 'All done.' }))).toBe('task_invalid');
    expect((await read(child.parentId!)).status).toBe('open');
  });

  it('takes no work in while work under it is open, and tells its executor once that work is done', async () => {
    const { ctx, db, dev, head, bruno, memberTask, read } = await company();
    const task = await memberTask();
    const { task: under } = await createTask(ctx, { agentId: head.id }, { title: 'Refund decision', brief: '', body: 'Record the agreed refund scope.', departmentId: dev.id, parentId: task.id, assigneeAgentId: head.id, resultKind: 'coordination' });
    expect(await reason(submit(ctx, bruno.id, task.id, code))).toBe('task_invalid');
    expect((await read(task.id)).status).toBe('open');
    /* Where the department keeps code, a coordination piece without accepted subtasks is the head's to close. */
    const finished = await report(ctx, head.id, under.id, { done: true, summary: 'Checked refund scope.' });
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, under.id)).orderBy(taskEvents.id);
    expect(log.at(-1)).toMatchObject({ kind: 'report', agentId: head.id, text: 'Checked refund scope.' });
    expect(finished.wakes).toContainEqual({
      agentId: bruno.id, taskId: task.id, why: 'subtasks',
      cause: { actor: { agentId: head.id }, action: 'reported work done', eventId: log.find(event => event.kind === 'report')!.id, task: { id: under.id, number: under.number }, report: 'Checked refund scope.' },
    });
    expect((await submit(ctx, bruno.id, task.id, code)).task.status).toBe('review');
  });

  it('gives no new implementation under a candidate already at Review', async () => {
    const { ctx, dev, head, bruno, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, code);
    const made = createTask(ctx, { agentId: head.id }, { title: 'Refunds', brief: '', body: '', departmentId: dev.id, parentId: task.id, assigneeAgentId: bruno.id, executor: true });
    expect(await reason(made)).toBe('task_invalid');
  });

  it('assigns an eligible Review owner and excludes an employee without a subscription', async () => {
    const { ctx, db, dev, bruno, rita, memberTask } = await company();
    await db.insert(agents).values({ companyId: dev.companyId, kind: 'worker', name: 'Rex', roleKey: 'DEV-REV', departmentId: dev.id, model: '', subscriptionId: null });
    const task = await memberTask();
    const sent = await submit(ctx, bruno.id, task.id, code);
    expect(sent.task).toMatchObject({ status: 'review', assigneeAgentId: rita.id });
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(taskEvents.id);
    expect(log.at(-1)).toMatchObject({ kind: 'submitted', agentId: bruno.id, text: 'Done.' });
    expect(sent.wakes).toEqual([{
      agentId: rita.id, taskId: task.id, why: 'review',
      cause: { actor: { agentId: bruno.id }, action: 'handed in work', eventId: log.at(-1)!.id, task: { id: task.id, number: task.number }, report: 'Done.' },
    }]);
  });

  it('declines a commit: the request closes, the task goes on and the agent hears why', async () => {
    const { ctx, db, CEO, bruno, memberTask, read } = await company();
    const task = await memberTask();
    const commit = 'b'.repeat(40);
    const approval = await ask(ctx, bruno.id, task.id, { kind: 'approval', text: 'Merge the checkout?', commit });
    expect((await read(task.id)).status).toBe('waiting');
    const declined = await answer(ctx, CEO, approval.request.id, { approve: false, answer: 'Refunds first.' });
    expect(declined.request).toMatchObject({ status: 'declined', answer: 'Refunds first.', answeredBy: CEO.personId });
    expect((await read(task.id)).status).toBe('working');
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(taskEvents.id);
    expect(declined.wakes).toEqual([{
      agentId: bruno.id, taskId: task.id, why: 'answered', text: `Declined ${commit}. Refunds first.`,
      cause: { actor: CEO, action: `declined ${commit}`, eventId: log.at(-1)!.id, task: { id: task.id, number: task.number } },
    }]);
    expect(log.at(-1)).toMatchObject({ kind: 'answered', personId: CEO.personId, text: `Declined ${commit}. Refunds first.` });
    expect(await reason(answer(ctx, CEO, approval.request.id, { approve: true }))).toBe('request_closed');
  });

  it.each(['open', 'working'] as const)('wakes the %s task holder for another author, and skips its own comments', async status => {
    const { ctx, db, CEO, head, bruno, rita, memberTask } = await company();
    const task = await memberTask();
    await db.update(tasks).set({ status }).where(eq(tasks.id, task.id));
    expect(woken(await comment(ctx, CEO, task.id, 'Keep refunds out of this one.'))).toEqual([[bruno.id, 'comment']]);
    expect(woken(await comment(ctx, { agentId: head.id }, task.id, 'Noted.'))).toEqual([[bruno.id, 'comment']]);
    expect(woken(await comment(ctx, { agentId: rita.id }, task.id, 'I can check refunds separately.'))).toEqual([[bruno.id, 'comment']]);
    expect(woken(await comment(ctx, { agentId: bruno.id }, task.id, 'I will leave refunds out.'))).toEqual([]);
  });

  it('wakes the executor when its head rewrites the task', async () => {
    const { ctx, head, bruno, tess, memberTask } = await company();
    const task = await memberTask();
    const res = await updateTask(ctx, head.id, task.id, { body: 'POST /checkout with idempotency keys.' });
    expect(res.task.body).toBe('POST /checkout with idempotency keys.');
    expect(woken(res)).toEqual([[bruno.id, 'updated']]);
    const moved = await updateTask(ctx, head.id, task.id, { executor: tess.id });
    expect(moved.task).toMatchObject({ executorAgentId: tess.id, assigneeAgentId: tess.id });
    expect(woken(moved)).toEqual([[tess.id, 'assigned']]);
  });
});
