import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, departments, jobs, subscriptions } from '../src/db/schema.js';
import { agentIdentity, checkerFor } from '../src/modules/tasks/echelons-assign.js';
import { answer, ask, createTask, loadTask, report, submit, verdict } from '../src/modules/tasks/engine.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { as, listen, mcp } from './helpers.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { testsFixture } from './development-echelons-verification.js';

const code = { summary: 'Keep totals.', evidence: 'Changed tests passed.', review: { baseCommit: BASE } };
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function plan(f: Fixture) {
  return (await f.db.insert(subscriptions).values({ companyId: f.task.companyId, provider: 'claude', kind: 'personal', label: 'Claude Code', ownerPersonId: f.claude.ownerPersonId, status: 'ready' }).returning())[0]!;
}

async function model(f: Fixture, id: string, subscription: string, value: string) {
  const result = await f.app.inject({ method: 'PATCH', url: `/api/agents/${id}`, payload: { subscription, model: value }, ...as(f.ceoToken) });
  expect(result.statusCode, result.body).toBe(200);
}

async function withoutRepository(f: Fixture) {
  await f.db.update(departments).set({ templateKey: 'design', repoUrl: null }).where(eq(departments.id, f.task.departmentId!));
}

async function tools(f: Fixture) {
  await listen(f.app);
  const token = `review-fixes-${f.head.id}-0123456789abcdef`;
  await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: f.head.id, subscriptionId: f.head.subscriptionId!, taskId: f.task.id, kind: 'conversation', prompt: 'Assign a result.', status: 'running', timeoutMs: 1000, toolTokenHash: hashToken(token) });
  return mcp(f.app, token);
}

describe('the accepted review fixes', () => {
  it('hands a Claude Code opus candidate to an equal reviewer on the same real plan', async () => {
    const f = await fixture();
    const subscription = await plan(f);
    await model(f, f.author.id, subscription.id, 'opus');
    await model(f, f.reviewer.id, subscription.id, 'opus');
    await submit(f.ctx, f.author.id, f.task.id, code);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });
  });

  it('assigns the named Claude Code opus reviewer to a Codex candidate', async () => {
    const f = await fixture();
    const subscription = await plan(f);
    await model(f, f.reviewer.id, subscription.id, 'opus');
    await submit(f.ctx, f.author.id, f.task.id, code);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });
  });

  it('keeps Default unknown rather than assuming an Opus runtime identity', async () => {
    const f = await fixture();
    const subscription = await plan(f);
    await model(f, f.author.id, subscription.id, '');
    await expect(submit(f.ctx, f.author.id, f.task.id, code)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.candidateId).toBeNull();
  });

  it('does not assign a weaker Claude Code alias to check a Codex candidate', async () => {
    const f = await fixture();
    const subscription = await plan(f);
    await model(f, f.reviewer.id, subscription.id, 'haiku');
    await submit(f.ctx, f.author.id, f.task.id, code);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null });
  });

  it('lets a worker finish a default task without a repository or an invented Git candidate', async () => {
    const f = await fixture();
    await withoutRepository(f);
    const { task } = await createTask(f.ctx, { agentId: f.head.id }, { title: 'Draw the card', brief: 'A readable card.', body: 'Deliver the drawing.', departmentId: f.task.departmentId, assigneeAgentId: f.author.id, executor: true, small: true, riskClass: 'none' });
    const result = await report(f.ctx, f.author.id, task.id, { done: true, summary: 'Delivered the drawing and checked its labels.' });
    expect(result.task.status).toBe('done');
    expect((await f.detail(task.id)).echelons).toMatchObject({ phase: 'done', candidateId: null });
  });

  /* Where a department keeps code, a coordination task a worker holds closes only on accepted subtask results: a report of its
     own would hand in work that no Review saw. Its head still closes a finding that has no code. */
  it('refuses a worker the close of a coordination task without accepted subtasks where the department keeps code, and lets its head close one', async () => {
    const f = await fixture();
    const given = (assigneeAgentId: string) => createTask(f.ctx, { agentId: f.head.id }, { title: 'Look into the totals', brief: 'Why they differ.', body: 'Find why.', departmentId: f.task.departmentId, assigneeAgentId, executor: false, resultKind: 'coordination' });
    const held = (await given(f.author.id)).task;
    await expect(report(f.ctx, f.author.id, held.id, { done: true, summary: 'Fixed the totals.' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('accepted results of its subtasks') });
    expect((await loadTask(f.db, held.id)).status).not.toBe('done');
    const own = (await given(f.head.id)).task;
    expect((await report(f.ctx, f.head.id, own.id, { done: true, summary: 'The totals differ by rounding; nothing to change.' })).task.status).toBe('done');
  });

  /* A code task without paths is made, and then every submit of it is refused as outside the head-approved scope until the head
     sets them: create_task asks for them at once. */
  it('refuses create_task a code task without the paths its change may touch', async () => {
    const f = await fixture();
    const api = await tools(f);
    const made = await api.callTool({ name: 'create_task', arguments: { title: 'Fix the totals', brief: 'Totals add up.', body: 'Fix them.', executor: f.author.id, small: true } });
    expect(made.isError).toBe(true);
    expect((made.content as { text: string }[])[0]!.text).toContain('needs the paths its change may touch');
    const scoped = await api.callTool({ name: 'create_task', arguments: { title: 'Fix the totals', brief: 'Totals add up.', body: 'Fix them.', executor: f.author.id, small: true, paths: ['logic/**'] } });
    expect(scoped.isError).not.toBe(true);
  });

  /* Where only the department's products keep code, a task made without a product had no repository and closed by a report. */
  it('refuses create_task a task without a product where only the products of the department keep code', async () => {
    const f = await fixture();
    const [department] = await f.db.select().from(departments).where(eq(departments.id, f.task.departmentId!));
    const [product] = await f.db.insert(departments).values({ companyId: department!.companyId, templateKey: 'development', roleCode: 'DEV', parentId: department!.id, name: 'Shop', repoUrl: department!.repoUrl }).returning();
    await f.db.update(departments).set({ repoUrl: null }).where(eq(departments.id, department!.id));
    const api = await tools(f);
    const made = await api.callTool({ name: 'create_task', arguments: { title: 'Fix the totals', brief: 'Totals add up.', body: 'Fix them.', executor: f.author.id, small: true, paths: ['logic/**'] } });
    expect(made.isError).toBe(true);
    expect((made.content as { text: string }[])[0]!.text).toContain('Name the product');
    /* The head picks the product by the repository the change goes to. */
    expect((made.content as { text: string }[])[0]!.text).toContain(`Shop (${product!.id}): ${department!.repoUrl}`);
    const tool = (await api.listTools()).tools.find(t => t.name === 'create_task')!;
    expect((tool.inputSchema.properties as Record<string, { description?: string }>).product?.description).toMatch(/repository the change goes to/);
    const named = await api.callTool({ name: 'create_task', arguments: { title: 'Fix the totals', brief: 'Totals add up.', body: 'Fix them.', executor: f.author.id, small: true, paths: ['logic/**'], product: product!.id } });
    expect(named.isError).not.toBe(true);
  });

  /* A head who holds a checking ability checks only where it names itself: picked on its own, it would take a stage from the
     employees of its department and leave the department without the one who gives the work out. */
  it('never picks the head as a checker by itself, and lets a head that names itself check', async () => {
    const f = await fixture();
    const [head] = await f.db.select().from(agents).where(eq(agents.id, f.head.id));
    await f.db.update(agents).set({ skills: [...head!.skills, 'dev-test-environment'] }).where(eq(agents.id, f.head.id));
    await f.db.update(agents).set({ skills: [] }).where(eq(agents.id, f.tester.id));
    const producer = (await agentIdentity(f.db, f.task.companyId, f.author.id))!;
    const task = await loadTask(f.db, f.task.id);
    expect(await checkerFor({ db: f.db }, task, producer, 'dev-test-environment', null)).toBeNull();
    expect(await checkerFor({ db: f.db }, task, producer, 'dev-test-environment', f.head.id)).toMatchObject({ agentId: f.head.id });
  });

  /* The Tests owner a candidate comes to ran nothing yet: it is told the candidate is at its checking stage, not that its tests ended. */
  it('wakes a new Tests owner as the owner of a checking stage, not as one whose tests ended', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Focused checks.', review: { baseCommit: BASE } });
    const moved = await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked the candidate.', reviewedCommit: HEAD });
    const wake = moved.wakes.find(each => each.agentId === f.tester.id)!;
    expect(wake).toMatchObject({ taskId: f.task.id, why: 'assigned' });
    const prompt = wakePrompt(f.tester, await loadTask(f.db, f.task.id), wake);
    expect(prompt).toContain('in Tests check what the change touched with local tests, as the full run happens once at release, and report the exact candidate');
    expect(prompt).not.toContain('report verified final-candidate runs in Tests');
    expect(prompt).not.toContain('The tests you ran');
  });

  /* An answer gives a task back to the stage it waited at: a Review that asked a person goes on as a Review. */
  it('gives a task back to the status of its stage once a person answered what its checker asked', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Focused checks.', review: { baseCommit: BASE } });
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ status: 'review', assigneeAgentId: f.reviewer.id });
    const asked = await ask(f.ctx, f.reviewer.id, f.task.id, { kind: 'question', text: 'Is rounding to cents meant?' });
    expect((await loadTask(f.db, f.task.id)).status).toBe('waiting');
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, asked.request.id, { answer: 'Yes, to cents.' });
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ status: 'review', assigneeAgentId: f.reviewer.id });
  });

  it('uses the no-repository default through the public create_task tool too', async () => {
    const f = await fixture();
    await withoutRepository(f);
    const api = await tools(f);
    const made = await api.callTool({ name: 'create_task', arguments: { title: 'Draw the card', brief: 'A readable card.', body: 'Deliver the drawing.', executor: f.author.id, small: true } });
    expect(made.isError).not.toBe(true);
    const listed = await api.callTool({ name: 'tasks', arguments: {} });
    const rows = JSON.parse((listed.content as { text: string }[])[0]!.text) as { id: string; title: string }[];
    const task = rows.find(row => row.title === 'Draw the card')!;
    const result = await report(f.ctx, f.author.id, task.id, { done: true, summary: 'Delivered and checked the drawing.' });
    expect(result.task.status).toBe('done');
  });

  it('tells a coordination worker to report its result without asking it to create tasks', async () => {
    const f = await fixture();
    const { task } = await f.create({ executor: false, resultKind: 'coordination' });
    const prompt = wakePrompt({ kind: 'worker' }, task, { agentId: f.author.id, taskId: task.id, why: 'assigned' });
    expect(prompt).not.toContain('create_task');
    expect(prompt).toMatch(/report/i);
  });

  it('revokes the Tests report after the public card disables its required ability', async () => {
    const f = await testsFixture();
    const response = await f.app.inject({ method: 'PATCH', url: `/api/agents/${f.tester.id}`, payload: { skills: { 'dev-test-environment': false } }, ...as(f.ceoToken) });
    expect(response.statusCode).toBe(200);
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified()).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.phase).toBe('active');
  });
});
