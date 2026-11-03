import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions, taskEvents, tasks, teams, turns } from '../src/db/schema.js';
import { answer, ask, createTask, leaveWork, submit, verdict, type Moved } from '../src/modules/tasks/engine.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import { resumeAgent, wakePrompt } from '../src/modules/tasks/wake.js';
import { listen, mcp, setUpCompany, testApp } from './helpers.js';

/* Development works in a repository in turn 4: Bruno and Kai build, Rita (Claude) and Rex (Codex) review code, Sid
   reviews security. */
async function company({ repository = true, reviewers = true, productRepository = false, sidPlan = true } = {}) {
  const { app, db } = await testApp();
  await listen(app);
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [claude] = await db.select().from(subscriptions);
  const [codex] = await db.insert(subscriptions).values({ companyId, provider: 'codex', kind: 'personal', label: 'Codex', ownerPersonId: ceo!.id, status: 'ready' }).returning();
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: repository && !productRepository ? 'https://github.com/acme/shop.git' : null }).returning();
  /* A product of the department, when only the product has the repository. */
  const [product] = productRepository ? await db.insert(departments).values({ companyId, parentId: dev!.id, name: 'Shop', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning() : [];
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, sub: string | null = claude!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const kai = await hire('Kai', 'worker', 'DEV-FE');
  const rita = reviewers ? await hire('Rita', 'worker', 'DEV-REV') : null;
  const rex = reviewers ? await hire('Rex', 'worker', 'DEV-REV', codex!.id) : null;
  const sid = reviewers ? await hire('Sid', 'worker', 'DEV-SEC', sidPlan ? claude!.id : null) : null;
  await db.insert(turns).values({ companyId, number: 4, title: 'Payments', goal: 'Card payments.', status: 'open', openedAt: new Date() });
  const ctx = app.ctx;
  const parent = (await createTask(ctx, { personId: ceo!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  /* Code given out without gates for the review of the turn, as create_task gives it; research with gates: []. */
  const member = async (executor: string, title: string, { under = parent.id, code = true } = {}) =>
    (await createTask(ctx, { agentId: head.id }, { title, brief: '', body: '', departmentId: dev!.id, productId: product?.id ?? null, parentId: under, assigneeAgentId: executor, executor: true, gates: [], inTurnReview: code })).task;
  /* The executor hands it in, and hands in the merge into the turn's branch. */
  const merged = async (executor: string, taskId: string) => {
    await submit(ctx, executor, taskId, { summary: 'Done.', evidence: 'npm test' });
    return submit(ctx, executor, taskId, { summary: 'Merged into turn-4.', evidence: 'git log: 1a2b3c4' });
  };
  const reviews = () => db.select().from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.title, 'Review of turn 4')));
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them. */
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: claude!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  return { app, ctx, db, companyId, ceo: ceo!, dev: dev!, head, bruno, kai, rita, rex, sid, parent, member, merged, reviews, tools };
}

const woken = (r: Moved) => r.wakes.map(w => [w.agentId, w.why]);

describe('the review of a turn', () => {
  it('gives code in a repository no gate of its own: it merges into the turn branch as it is handed in', async () => {
    const { db, head, bruno, rita, parent, tools } = await company();
    const made = await (await tools(head)).callTool({ name: 'create_task', arguments: { title: 'Checkout API', brief: 'The API.', body: 'POST /checkout.', executor: bruno.id, parent: parent.number } });
    expect(made.isError).toBeFalsy();
    const [task] = await db.select().from(tasks).where(eq(tasks.title, 'Checkout API'));
    expect(task!.gates).toEqual([]);
    expect(rita).not.toBeNull();
  });

  it("opens one review when a department's last work of the turn is merged, with every reviewer of every gate role at once", async () => {
    const { ctx, db, head, bruno, kai, rita, rex, sid, parent, member, merged, reviews } = await company();
    const api = await member(bruno.id, 'Checkout API');
    const page = await member(kai.id, 'Checkout page');
    expect(woken(await merged(bruno.id, api.id))).toEqual([]);
    expect(await reviews()).toHaveLength(0);
    const last = await merged(kai.id, page.id);
    const [review] = await reviews();
    expect(review).toMatchObject({ status: 'review', stage: 1, executorAgentId: head.id, createdByAgentId: head.id, turnId: parent.turnId, departmentId: parent.departmentId });
    expect(review!.panel.sort()).toEqual([rita!.id, rex!.id, sid!.id].sort());
    /* The head hears of it once the review is over, not now. */
    expect(woken(last).sort()).toEqual([rita!.id, rex!.id, sid!.id].map(id => [id, 'turn_review']).sort());
    const [me] = await db.select().from(agents).where(eq(agents.id, rex!.id));
    const prompt = wakePrompt(me!, review!, last.wakes.find(w => w.agentId === rex!.id)!);
    expect(prompt).toContain('everything turn 4 changed');
    expect(prompt).toContain('turn-4');
    expect(prompt).toContain('Other reviewers check the same branch at once');
    expect(prompt).toContain('only in your verdict');
    void ctx;
  });

  it('closes the review once every reviewer has spoken and gives the head every finding in one list', async () => {
    const { ctx, db, head, bruno, kai, rita, rex, sid, member, merged, reviews } = await company();
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    await merged(kai.id, (await member(kai.id, 'Checkout page')).id);
    const [review] = await reviews();
    expect(woken(await verdict(ctx, rita!.id, review!.id, { pass: true, comment: 'Good. Note: rename total().' }))).toEqual([]);
    await verdict(ctx, rex!.id, review!.id, { pass: false, comment: 'cart.ts:12 drops the total.' });
    const last = await verdict(ctx, sid!.id, review!.id, { pass: false, comment: 'auth.ts:3 logs the token.' });
    expect(last.task).toMatchObject({ status: 'done', bounces: 0 });
    expect(woken(last)).toEqual([[head.id, 'reviewed']]);
    const text = last.wakes[0]!.text!;
    expect(text).toContain('Rex: cart.ts:12 drops the total.');
    expect(text).toContain('Sid: auth.ts:3 logs the token.');
    expect(text).toContain('Rita: Good. Note: rename total().');
    const [me] = await db.select().from(agents).where(eq(agents.id, head.id));
    const prompt = wakePrompt(me!, last.task, last.wakes[0]!);
    expect(prompt).toContain('fix task without gates');
    expect(prompt).toContain('starts with a test that fails');
    expect(prompt).toContain('no second review');
  });

  it('shows every reviewer of the turn on the task at once, each with its verdict as it comes', async () => {
    const { ctx, bruno, kai, rita, rex, member, merged, reviews } = await company();
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    await merged(kai.id, (await member(kai.id, 'Checkout page')).id);
    const shown = async () => {
      const detail = await taskDetail(ctx, (await reviews())[0]!, () => true);
      return { turnReview: detail.turnReview, gates: detail.gates.map(g => [g.name, g.state]) };
    };
    expect(await shown()).toEqual({ turnReview: true, gates: [['Rita', 'current'], ['Rex', 'current'], ['Sid', 'current']] });
    const [review] = await reviews();
    await verdict(ctx, rita!.id, review!.id, { pass: true, comment: 'Good.' });
    await verdict(ctx, rex!.id, review!.id, { pass: false, comment: 'cart.ts:12 drops the total.' });
    expect(await shown()).toEqual({ turnReview: true, gates: [['Rita', 'passed'], ['Rex', 'returned'], ['Sid', 'current']] });
  });

  it('tells the head to give the final check when every reviewer passed the turn', async () => {
    const { ctx, db, head, bruno, kai, rita, rex, sid, member, merged, reviews } = await company();
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    await merged(kai.id, (await member(kai.id, 'Checkout page')).id);
    const [review] = await reviews();
    for (const r of [rita!, rex!]) await verdict(ctx, r.id, review!.id, { pass: true, comment: 'Good.' });
    const last = await verdict(ctx, sid!.id, review!.id, { pass: true, comment: 'Nothing found.' });
    expect(woken(last)).toEqual([[head.id, 'review_passed']]);
    const [me] = await db.select().from(agents).where(eq(agents.id, head.id));
    expect(wakePrompt(me!, last.task, last.wakes[0]!)).toContain('Nobody found anything that blocks in the review of turn 4');
  });

  it('opens no second review once the fixes are in: the head hears the work is done', async () => {
    const { ctx, head, bruno, kai, rita, rex, sid, member, merged, reviews } = await company();
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    await merged(kai.id, (await member(kai.id, 'Checkout page')).id);
    const [review] = await reviews();
    await verdict(ctx, rita!.id, review!.id, { pass: true, comment: 'Good.' });
    await verdict(ctx, rex!.id, review!.id, { pass: false, comment: 'cart.ts:12 drops the total.' });
    await verdict(ctx, sid!.id, review!.id, { pass: true, comment: 'Nothing found.' });
    const fix = await member(bruno.id, 'Keep the total in the cart');
    const done = await merged(bruno.id, fix.id);
    expect(woken(done)).toEqual([[head.id, 'subtasks']]);
    expect(await reviews()).toHaveLength(1);
  });

  it("keeps the first review stage for code given outside a department's task of a turn, which no review of the turn covers", async () => {
    const { db, head, bruno, rita, tools } = await company();
    const made = await (await tools(head)).callTool({ name: 'create_task', arguments: { title: 'Hotfix', brief: 'A fix.', body: 'Fix it.', executor: bruno.id } });
    expect(made.isError).toBeFalsy();
    const [task] = await db.select().from(tasks).where(eq(tasks.title, 'Hotfix'));
    expect(task!.gates).toEqual([rita!.id]);
  });

  it('opens the review when only a product of the department has the repository', async () => {
    const { bruno, member, merged, reviews } = await company({ productRepository: true });
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    expect(await reviews()).toHaveLength(1);
  });

  it("opens one review for all of a department's tasks of the turn, once the work under each of them is in", async () => {
    const { ctx, head, bruno, kai, parent, member, merged, reviews, ceo, dev } = await company();
    const second = (await createTask(ctx, { personId: ceo.id }, { title: 'Refunds', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id })).task;
    const api = await member(bruno.id, 'Checkout API');
    const refunds = await member(kai.id, 'Refund API', { under: second.id });
    const first = await merged(bruno.id, api.id);
    /* The head hears its first task's work is in, and that the review waits for the rest. */
    expect(woken(first)).toEqual([[head.id, 'subtasks']]);
    expect(first.wakes[0]!.note).toContain(`#${second.number}`);
    expect(await reviews()).toHaveLength(0);
    await merged(kai.id, refunds.id);
    const all = await reviews();
    expect(all).toHaveLength(1);
    expect(all[0]!.body).toContain(`#${parent.number}`);
    expect(all[0]!.body).toContain(`#${second.number}`);
  });

  it('opens no review for work given with gates: [], such as research and docs', async () => {
    const { head, bruno, member, merged, reviews } = await company();
    const last = await merged(bruno.id, (await member(bruno.id, 'Compare providers', { code: false })).id);
    expect(woken(last)).toEqual([[head.id, 'subtasks']]);
    expect(await reviews()).toHaveLength(0);
  });

  it('tells the head who could not check the turn for want of a subscription', async () => {
    const { ctx, head, bruno, rita, rex, member, merged, reviews } = await company({ sidPlan: false });
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    const [review] = await reviews();
    expect(review!.panel.sort()).toEqual([rita!.id, rex!.id].sort());
    await verdict(ctx, rita!.id, review!.id, { pass: true, comment: 'Good.' });
    const last = await verdict(ctx, rex!.id, review!.id, { pass: true, comment: 'Good.' });
    expect(woken(last)).toEqual([[head.id, 'review_passed']]);
    expect(last.wakes[0]!.text).toContain('Did not check: Sid (no subscription to run on)');
  });

  it('tells the head when nobody who was to check the turn has a subscription', async () => {
    const { db, head, bruno, rita, rex, member, merged, reviews } = await company({ sidPlan: false });
    await db.update(agents).set({ subscriptionId: null }).where(eq(agents.roleKey, 'DEV-REV'));
    const last = await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    expect(await reviews()).toHaveLength(0);
    expect(woken(last)).toEqual([[head.id, 'subtasks']]);
    expect(last.wakes[0]!.note).toContain('Rita, Rex and Sid');
    void rita;
    void rex;
  });

  it('closes the review and tells the head once everyone who was to check it was switched off first, without a merge', async () => {
    const { ctx, db, companyId, ceo, head, bruno, rita, rex, sid, member, merged, reviews } = await company();
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    const wakes: string[][] = [];
    for (const r of [rita!, rex!, sid!]) {
      await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, r.id));
      wakes.push(...(await leaveWork(ctx, { personId: ceo.id }, { id: r.id, name: r.name, companyId })).wakes.map(w => [w.agentId, w.why]));
    }
    const [review] = await reviews();
    expect(review).toMatchObject({ status: 'done', merging: false });
    expect(wakes).toEqual([[head.id, 'review_passed']]);
  });

  it('names a reviewer who left before its verdict as not checked, to the head and on the task', async () => {
    const { ctx, db, companyId, ceo, bruno, rita, rex, sid, member, merged, reviews } = await company();
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    const [review] = await reviews();
    await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, sid!.id));
    await leaveWork(ctx, { personId: ceo.id }, { id: sid!.id, name: 'Sid', companyId });
    await verdict(ctx, rita!.id, review!.id, { pass: true, comment: 'Good.' });
    const last = await verdict(ctx, rex!.id, review!.id, { pass: true, comment: 'Good.' });
    expect(last.wakes[0]!.text).toContain('Did not check: Sid (left without a verdict)');
    const detail = await taskDetail(ctx, (await reviews())[0]!, () => true);
    expect(detail.gates.map(g => [g.name, g.state])).toEqual([['Rita', 'passed'], ['Rex', 'passed'], ['Sid', 'skipped']]);
  });

  it("names the department's task to put the fixes under", async () => {
    const { ctx, bruno, rita, rex, sid, parent, member, merged, reviews } = await company();
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    const [review] = await reviews();
    await verdict(ctx, rita!.id, review!.id, { pass: true, comment: 'Good.' });
    await verdict(ctx, rex!.id, review!.id, { pass: true, comment: 'Good.' });
    const last = await verdict(ctx, sid!.id, review!.id, { pass: false, comment: 'auth.ts:3 logs the token.' });
    expect(last.wakes[0]!.note).toContain(`parent ${parent.number}`);
  });

  it('wakes the others back to the review of the turn once a reviewer has its answer', async () => {
    const { ctx, ceo, bruno, rita, rex, sid, member, merged, reviews } = await company();
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    const [review] = await reviews();
    const { request } = await ask(ctx, rex!.id, review!.id, { kind: 'question', text: 'Is tax in scope?' });
    const { wakes } = await answer(ctx, { personId: ceo.id }, request.id, { answer: 'Yes.' });
    expect(wakes.map(w => [w.agentId, w.why, w.text]).sort()).toEqual([[rex!.id, 'answered', 'Yes.'], [rita!.id, 'turn_review', 'turn-4'], [sid!.id, 'turn_review', 'turn-4']].sort());
  });

  it('wakes a reviewer of the turn back on a subscription with the review of the turn', async () => {
    const { app, db, bruno, rex, member, merged } = await company();
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    await resumeAgent(app.ctx, rex!.id);
    const [turn] = await db.select().from(jobs).where(eq(jobs.agentId, rex!.id));
    expect(turn!.prompt).toContain('everything turn 4 changed');
  });

  it('opens no review where nobody can check the work, nor outside a repository: the head hears the work is done', async () => {
    for (const setup of [{ reviewers: false }, { repository: false }]) {
      const { bruno, head, member, merged, reviews, ctx } = await company(setup);
      const task = await member(bruno.id, 'Checkout API');
      const last = setup.repository === false ? await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test' }) : await merged(bruno.id, task.id);
      expect(woken(last)).toEqual([[head.id, 'subtasks']]);
      expect(await reviews()).toHaveLength(0);
    }
  });

  it('stores findings in the verdict event data when given through the tool, and leaves it out otherwise', async () => {
    const { db, bruno, kai, rita, rex, sid, member, merged, reviews, tools } = await company();
    await merged(bruno.id, (await member(bruno.id, 'Checkout API')).id);
    await merged(kai.id, (await member(kai.id, 'Checkout page')).id);
    const [review] = await reviews();
    const ritaRes = await (await tools(rita!)).callTool({
      name: 'verdict',
      arguments: { task: review!.number, pass: false, comment: 'Two problems in checkout.', findings: 2 },
    });
    expect(ritaRes.isError).toBeFalsy();
    const rexRes = await (await tools(rex!)).callTool({
      name: 'verdict',
      arguments: { task: review!.number, pass: true, comment: 'Looks good.' },
    });
    expect(rexRes.isError).toBeFalsy();
    const sidRes = await (await tools(sid!)).callTool({
      name: 'verdict',
      arguments: { task: review!.number, pass: true, comment: 'No issues.', findings: 0 },
    });
    expect(sidRes.isError).toBeFalsy();

    const events = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, review!.id), eq(taskEvents.kind, 'verdict')));
    const byAgent = new Map(events.map(e => [e.agentId, e.data]));
    expect(byAgent.get(rita!.id)).toEqual({ pass: false, stage: 1, round: 0, findings: 2 });
    expect(byAgent.get(rex!.id)).toEqual({ pass: true, stage: 1, round: 0 });
    expect('findings' in byAgent.get(rex!.id)!).toBe(false);
    expect(byAgent.get(sid!.id)).toEqual({ pass: true, stage: 1, round: 0, findings: 0 });
  });

  it('never puts a sub-unit employee into a task gate, the review of a turn, or the final check even when its role fits', async () => {
    const { db, companyId, dev, head, bruno, rita, rex, sid, parent, member, merged, reviews, tools } = await company();
    const [urgent] = await db.insert(teams).values({ companyId, departmentId: dev.id, name: 'Urgent fixes' }).returning();
    const [claude] = await db.select().from(subscriptions);
    const [simon] = await db
      .insert(agents)
      .values({ companyId, kind: 'worker', name: 'Simon', roleKey: 'DEV-REV', departmentId: dev.id, teamId: urgent!.id, model: '', subscriptionId: claude!.id })
      .returning();
    await db.update(agents).set({ teamId: urgent!.id }).where(eq(agents.id, sid!.id));

    const headTools = await tools(head);
    const hotfix = await headTools.callTool({ name: 'create_task', arguments: { title: 'Hotfix', brief: 'A fix.', body: 'Fix it.', executor: bruno.id } });
    expect(hotfix.isError).toBeFalsy();
    const [hotfixTask] = await db.select().from(tasks).where(eq(tasks.title, 'Hotfix'));
    expect(hotfixTask!.gates).toEqual([rita!.id]);

    const namedGate = await headTools.callTool({ name: 'create_task', arguments: { title: 'Checked', brief: 'A fix.', body: 'Fix it.', executor: bruno.id, gates: [simon!.id] } });
    expect(namedGate.isError).toBe(true);

    const roleGate = await headTools.callTool({ name: 'create_task', arguments: { title: 'Security check', brief: 'A fix.', body: 'Fix it.', executor: bruno.id, gates: ['DEV-SEC'] } });
    expect(roleGate.isError).toBe(true);

    const urgentTask = await headTools.callTool({
      name: 'create_task',
      arguments: { title: 'Urgent patch', brief: 'Quick fix.', body: 'Patch it.', executor: simon!.id, parent: parent.number },
    });
    expect(urgentTask.isError).toBeFalsy();
    const [simonTask] = await db.select().from(tasks).where(eq(tasks.title, 'Urgent patch'));
    expect(simonTask!.gates).toEqual([]);
    const urgentDone = await merged(simon!.id, simonTask!.id);
    expect(woken(urgentDone)).toEqual([[head.id, 'subtasks']]);
    expect(await reviews()).toHaveLength(0);

    const api = await member(bruno.id, 'Checkout API');
    const last = await merged(bruno.id, api.id);
    const [review] = await reviews();
    expect(review!.panel.sort()).toEqual([rita!.id, rex!.id].sort());
    expect(review!.panel).not.toContain(simon!.id);
    expect(review!.panel).not.toContain(sid!.id);
    expect(woken(last).map(w => w[0]).sort()).toEqual([rita!.id, rex!.id].sort());
  });
});
