import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions, tasks, turns } from '../src/db/schema.js';
import { createTask, submit, verdict, type Moved } from '../src/modules/tasks/engine.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { listen, mcp, setUpCompany, testApp } from './helpers.js';

/* Development works in a repository in turn 4: Bruno and Kai build, Rita (Claude) and Rex (Codex) review code, Sid
   reviews security. */
async function company({ repository = true, reviewers = true } = {}) {
  const { app, db } = await testApp();
  await listen(app);
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [claude] = await db.select().from(subscriptions);
  const [codex] = await db.insert(subscriptions).values({ companyId, provider: 'codex', kind: 'personal', label: 'Codex', ownerPersonId: ceo!.id, status: 'ready' }).returning();
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: repository ? 'https://github.com/acme/shop.git' : null }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, sub = claude!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const kai = await hire('Kai', 'worker', 'DEV-FE');
  const rita = reviewers ? await hire('Rita', 'worker', 'DEV-REV') : null;
  const rex = reviewers ? await hire('Rex', 'worker', 'DEV-REV', codex!.id) : null;
  const sid = reviewers ? await hire('Sid', 'worker', 'DEV-SEC') : null;
  await db.insert(turns).values({ companyId, number: 4, title: 'Payments', goal: 'Card payments.', status: 'open', openedAt: new Date() });
  const ctx = app.ctx;
  const parent = (await createTask(ctx, { personId: ceo!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  const member = async (executor: string, title: string) =>
    (await createTask(ctx, { agentId: head.id }, { title, brief: '', body: '', departmentId: dev!.id, parentId: parent.id, assigneeAgentId: executor, executor: true, gates: [] })).task;
  /* The executor hands it in, and hands in the merge into the turn's branch. */
  const merged = async (executor: string, taskId: string) => {
    await submit(ctx, executor, taskId, { summary: 'Done.', evidence: 'npm test' });
    return submit(ctx, executor, taskId, { summary: 'Merged into turn-4.', evidence: 'git log: 1a2b3c4' });
  };
  const reviews = () => db.select().from(tasks).where(and(eq(tasks.parentId, parent.id), eq(tasks.title, 'Review of turn 4')));
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them. */
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: claude!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  return { app, ctx, db, dev: dev!, head, bruno, kai, rita, rex, sid, parent, member, merged, reviews, tools };
}

const woken = (r: Moved) => r.wakes.map(w => [w.agentId, w.why]);

describe('the review of a turn', () => {
  it('gives code in a repository no gate of its own: it merges into the turn branch as it is handed in', async () => {
    const { db, head, bruno, rita, tools } = await company();
    const made = await (await tools(head)).callTool({ name: 'create_task', arguments: { title: 'Checkout API', brief: 'The API.', body: 'POST /checkout.', executor: bruno.id } });
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
    expect(wakePrompt(me!, last.task, last.wakes[0]!)).toContain('passed the review of turn 4');
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

  it('opens no review where nobody can check the work, nor outside a repository: the head hears the work is done', async () => {
    for (const setup of [{ reviewers: false }, { repository: false }]) {
      const { bruno, head, member, merged, reviews, ctx } = await company(setup);
      const task = await member(bruno.id, 'Checkout API');
      const last = setup.repository === false ? await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test' }) : await merged(bruno.id, task.id);
      expect(woken(last)).toEqual([[head.id, 'subtasks']]);
      expect(await reviews()).toHaveLength(0);
    }
  });
});
