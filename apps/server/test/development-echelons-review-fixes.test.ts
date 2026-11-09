import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { departments, jobs, subscriptions } from '../src/db/schema.js';
import { candidateForRun } from '../src/modules/tasks/echelons-run.js';
import { createTask, loadTask, report, submit } from '../src/modules/tasks/engine.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { as, listen, mcp } from './helpers.js';
import { BASE, fixture } from './development-echelons-fixture.js';
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

  it('revokes Tests run binding and report after the public card disables its required ability', async () => {
    const f = await testsFixture();
    const run = await f.run();
    const response = await f.app.inject({ method: 'PATCH', url: `/api/agents/${f.tester.id}`, payload: { skills: { 'dev-test-environment': false } }, ...as(f.ceoToken) });
    expect(response.statusCode).toBe(200);
    const task = await loadTask(f.db, f.task.id);
    const binding = await candidateForRun(f.db, task, f.tester.id, { candidate: { candidateId: f.snapshot.candidateId!, revision: f.snapshot.revision } }, 'tests').then(() => 'accepted', (error: { status: number }) => error.status);
    const certification = await report(f.ctx, f.tester.id, f.task.id, f.verified([run.id])).then(() => 'accepted', (error: { status: number }) => error.status);
    expect({ binding, certification }).toEqual({ binding: 409, certification: 409 });
    expect((await f.detail()).echelons.phase).toBe('active');
  });
});
