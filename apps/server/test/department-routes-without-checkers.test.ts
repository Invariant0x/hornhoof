import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, subscriptions } from '../src/db/schema.js';
import { createTask, loadTask, report, submit, verdict, type NewTask } from '../src/modules/tasks/engine.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import type { TemplateKey } from '@hornhoof/protocol';
import { echelonsTurn, listen, mcp, setUpCompany, testApp } from './helpers.js';
import { attached } from './recorded-fixture.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const HAND_IN = { summary: 'The screen layouts are attached as layouts.pdf.', evidence: 'Compared every screen with the brief.' };

/* A department of the given template that keeps its work in a repository, in a turn run in echelons: its head and the
   employees of the given roles, the first of them the author. */
async function department(templateKey: TemplateKey | null, headRole: string, roles: string[], skills: Record<number, string[]> = {}) {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [claude] = await db.select().from(subscriptions);
  const [dept] = await db.insert(departments).values({ companyId: company!.id, templateKey, roleCode: 'DEP', repoUrl: 'https://github.com/acme/hornhoof-design.git' }).returning();
  const skillsOf = (roleKey: string) => app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id);
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, model: string, given?: string[]) =>
    (await db.insert(agents).values({ companyId: company!.id, departmentId: dept!.id, name, kind, roleKey, subscriptionId: claude!.id, model, skills: given ?? skillsOf(roleKey) }).returning())[0]!;
  await echelonsTurn(db, company!.id);
  const head = await hire('Head', 'head', headRole, 'claude-opus-5-5');
  const staff = [];
  for (const [i, role] of roles.entries()) staff.push(await hire(`Member ${i + 1}`, 'worker', role, i === 0 ? 'claude-sonnet-5-5' : 'claude-opus-5-5', skills[i]));
  app.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: HEAD });
  app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['screens/tasks.fig'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const author = staff[0]!;
  const input: NewTask = {
    title: 'Tasks screen', brief: 'Lay out the tasks screen.', body: 'Lay out the tasks screen in every skin.',
    departmentId: dept!.id, assigneeAgentId: author.id, executor: true, small: false, riskClass: 'none', paths: ['screens/**'],
  };
  const create = (changes: Partial<NewTask> = {}, by = head.id) => createTask(app.ctx, { agentId: by }, { ...input, ...changes });
  const detail = async (id: string) => taskDetail(app.ctx, await loadTask(db, id), () => true);
  const echelons = async (id: string) => (await detail(id)).echelons;
  const log = async (id: string) => (await detail(id)).log;
  return { app, ctx: app.ctx, db, head, author, staff, create, echelons, log };
}

/* Design as the company runs it: a head and three interface designers, nobody who carries the skill of its check. */
const design = () => department('design', 'DSN-HEAD', ['DSN-UI', 'DSN-UI', 'DSN-UI']);
const stageOf = (route: { stages: { stage: string }[] }, stage: string) => route.stages.find(step => step.stage === stage);
const told = (events: unknown[], words: string) => events.some(event => JSON.stringify(event).includes(words));

describe('a department where nobody carries the skill of a check of its route', () => {
  it('skips that check, says so in the log, and hands the result to its head to accept', async () => {
    const f = await design();
    const { task } = await f.create();
    expect(stageOf(await f.echelons(task.id), 'review')).toMatchObject({ status: 'skipped', reason: 'no_department_checker' });
    expect(told(await f.log(task.id), 'no_department_checker')).toBe(true);
    const handed = await submit(f.ctx, f.author.id, task.id, { summary: 'The layouts.', evidence: 'Every skin.', review: { baseCommit: BASE } });
    expect(handed.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect(handed.wakes).toEqual([expect.objectContaining({ agentId: f.head.id, why: 'reviewed' })]);
    const route = await f.echelons(task.id);
    expect(route).toMatchObject({ phase: 'ready' });
    const done = await report(f.ctx, f.head.id, task.id, { done: true, summary: 'Merged the layouts.', acceptance: { candidateId: route.candidateId!, revision: route.revision, integrationCommit: HEAD } });
    expect(done.task).toMatchObject({ status: 'done', assigneeAgentId: null });
  });

  it('keeps the check where somebody carries its skill', async () => {
    const f = await department('design', 'DSN-HEAD', ['DSN-UI', 'DSN-QA']);
    const { task } = await f.create();
    expect(stageOf(await f.echelons(task.id), 'review')).toMatchObject({ status: 'pending', reason: null });
    const handed = await submit(f.ctx, f.author.id, task.id, { summary: 'The layouts.', evidence: 'Every skin.', review: { baseCommit: BASE } });
    expect(handed.task).toMatchObject({ status: 'review', assigneeAgentId: f.staff[1]!.id });
  });

  it("waits for a checker as before when the head wrote the work itself, as the head can't check its own work", async () => {
    const f = await design();
    const { task } = await f.create({ assigneeAgentId: f.head.id });
    const handed = await submit(f.ctx, f.head.id, task.id, { summary: 'The layouts.', evidence: 'Every skin.', review: { baseCommit: BASE } });
    expect(handed.task).toMatchObject({ status: 'waiting', assigneeAgentId: null });
    expect(stageOf(await f.echelons(task.id), 'review')).toMatchObject({ status: 'pending', reason: 'eligible_owner_required' });
  });

  it('keeps Development as it is: a check with nobody to do it waits', async () => {
    const f = await department('development', 'DEV-HEAD', ['DEV-BE']);
    const { task } = await f.create({ small: true });
    const handed = await submit(f.ctx, f.author.id, task.id, { summary: 'The change.', evidence: 'Its tests.', review: { baseCommit: BASE } });
    expect(handed.task).toMatchObject({ status: 'waiting', assigneeAgentId: null });
    expect(stageOf(await f.echelons(task.id), 'review')).toMatchObject({ status: 'pending', reason: 'eligible_owner_required' });
  });

  it('waits for Security that the risk of the task asks for, though somebody checks the rest', async () => {
    const f = await department('development', 'DEV-HEAD', ['DEV-BE', 'DEV-REV'], { 1: ['dev-review-diff'] });
    const { task } = await f.create({ riskClass: 'access', small: true });
    await submit(f.ctx, f.author.id, task.id, { summary: 'The change.', evidence: 'Its tests.', review: { baseCommit: BASE } });
    const passed = await verdict(f.ctx, f.staff[1]!.id, task.id, { pass: true, comment: 'Reads right.', reviewedCommit: HEAD });
    expect(passed.task).toMatchObject({ status: 'waiting', assigneeAgentId: null });
    expect(stageOf(await f.echelons(task.id), 'security')).toMatchObject({ status: 'pending', reason: 'eligible_owner_required' });
  });
});

describe('a document in a department that keeps a repository', () => {
  it('is made when the task says so: no paths, no commit, files on the task, closed by its head', async () => {
    const f = await design();
    const { task } = await f.create({ resultKind: 'document', paths: undefined });
    const route = await f.echelons(task.id);
    expect(route).toMatchObject({ resultKind: 'document' });
    expect(route.stages.map(step => step.stage)).toEqual(['development', 'review']);
    const handed = await submit(f.ctx, f.author.id, task.id, { ...HAND_IN, recorded: await attached(f.db, task, f.author.id, 'layouts.pdf') });
    expect(handed.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect(await f.echelons(task.id)).toMatchObject({ phase: 'ready' });
    const done = await report(f.ctx, f.head.id, task.id, { done: true, summary: 'Accepted the layouts.' });
    expect(done.task).toMatchObject({ status: 'done', assigneeAgentId: null });
    expect((await f.log(task.id)).findLast(event => event.kind === 'report')!.data).toMatchObject({ acceptedDocument: { candidateId: expect.any(String) } });
  });

  it('still goes to its checker where the department has one, and refuses a commit named for it', async () => {
    const f = await department('design', 'DSN-HEAD', ['DSN-UI', 'DSN-QA']);
    const { task } = await f.create({ resultKind: 'document', paths: undefined });
    await expect(submit(f.ctx, f.author.id, task.id, { ...HAND_IN, review: { baseCommit: BASE } }).then(() => null)).rejects.toMatchObject({ status: 400 });
    const handed = await submit(f.ctx, f.author.id, task.id, { ...HAND_IN, recorded: await attached(f.db, task, f.author.id, 'layouts.pdf') });
    expect(handed.task).toMatchObject({ status: 'review', assigneeAgentId: f.staff[1]!.id });
  });

  it('is offered to heads by create_task', async () => {
    const f = await design();
    await listen(f.app);
    const [sub] = await f.db.select().from(subscriptions);
    const token = 'design-head-tool-token-0123456789abcdef01234567';
    await f.db.insert(jobs).values({ companyId: f.head.companyId, subscriptionId: sub!.id, agentId: f.head.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    const create = (await (await mcp(f.app, token)).listTools()).tools.find(t => t.name === 'create_task')!;
    expect((create.inputSchema.properties as Record<string, { enum?: string[] }>).resultKind!.enum).toEqual(['code', 'document', 'coordination']);
  });
});
