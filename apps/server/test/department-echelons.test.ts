import { describe, expect, it } from 'vitest';
import { agents, companies, departments, subscriptions } from '../src/db/schema.js';
import { createTask, loadTask, report, submit, verdict, type NewTask } from '../src/modules/tasks/engine.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import type { TemplateKey } from '@hornhoof/protocol';
import { echelonsTurn, setUpCompany, testApp } from './helpers.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

/* A department of the given template that keeps its work in a repository, in a turn run in echelons: a head, an author
   and one more employee who carries the given skills. */
async function fixture(templateKey: TemplateKey | null, roles: { head: string; author: string }, checkerSkills: string[]) {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [claude] = await db.select().from(subscriptions);
  const [department] = await db.insert(departments).values({ companyId: company!.id, templateKey, roleCode: 'DEP', repoUrl: 'https://github.com/acme/site.git' }).returning();
  const skillsOf = (roleKey: string) => app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id);
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, model: string, skills = skillsOf(roleKey)) =>
    (await db.insert(agents).values({ companyId: company!.id, departmentId: department!.id, name, kind, roleKey, subscriptionId: claude!.id, model, skills }).returning())[0]!;
  await echelonsTurn(db, company!.id);
  const head = await hire('Head', 'head', roles.head, 'claude-opus-5-5');
  const author = await hire('Author', 'worker', roles.author, 'claude-sonnet-5-5');
  const checker = await hire('Checker', 'worker', roles.author, 'claude-opus-5-5', checkerSkills);
  app.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: HEAD });
  app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['copy/launch.md'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const input: NewTask = {
    title: 'Launch text', brief: 'Write the launch text.', body: 'Write copy/launch.md.',
    departmentId: department!.id, assigneeAgentId: author.id, executor: true, small: false, riskClass: 'none', paths: ['copy/**'],
  };
  const create = (changes: Partial<NewTask> = {}) => createTask(app.ctx, { agentId: head.id }, { ...input, ...changes });
  const echelons = async (id: string) => (await taskDetail(app.ctx, await loadTask(db, id), () => true)).echelons;
  return { ctx: app.ctx, db, head, author, checker, create, echelons };
}

const marketing = () => fixture('marketing', { head: 'MKT-HEAD', author: 'MKT-WRITE' }, ['hh-check-work']);

describe('the stages of a department other than Development', () => {
  it('lays a task out by the route of its department, with the skill each check asks for', async () => {
    const f = await marketing();
    const { task } = await f.create();
    const route = await f.echelons(task.id);
    expect(route.stages.map(step => step.stage)).toEqual(['development', 'review']);
    expect(route).toMatchObject({ resultKind: 'code', stage: 'development', abilities: { review: 'hh-check-work' } });
  });

  it('hands the work to an employee who carries the skill of the check, and to the head once the last stage passed', async () => {
    const f = await marketing();
    const { task } = await f.create();
    const handed = await submit(f.ctx, f.author.id, task.id, { summary: 'The launch text.', evidence: 'Read it against the brief.', review: { baseCommit: BASE } });
    expect(handed.task).toMatchObject({ status: 'review', assigneeAgentId: f.checker.id });
    const passed = await verdict(f.ctx, f.checker.id, task.id, { pass: true, comment: 'Every claim has its source.', reviewedCommit: HEAD });
    expect(passed.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect(passed.wakes).toEqual([expect.objectContaining({ agentId: f.head.id, why: 'reviewed' })]);
    const route = await f.echelons(task.id);
    expect(route).toMatchObject({ phase: 'ready', stage: 'review' });
    expect(route.stages.map(step => step.status)).toEqual(['complete', 'complete']);
  });

  it('lets the head accept a result that passed a route with no Tests', async () => {
    const f = await marketing();
    const { task } = await f.create();
    await submit(f.ctx, f.author.id, task.id, { summary: 'The launch text.', evidence: 'Read it against the brief.', review: { baseCommit: BASE } });
    await verdict(f.ctx, f.checker.id, task.id, { pass: true, comment: 'Every claim has its source.', reviewedCommit: HEAD });
    const route = await f.echelons(task.id);
    const done = await report(f.ctx, f.head.id, task.id, { done: true, summary: 'Merged the checked text.', acceptance: { candidateId: route.candidateId!, revision: route.revision, integrationCommit: HEAD } });
    expect(done.task).toMatchObject({ status: 'done', assigneeAgentId: null });
    expect(await f.echelons(task.id)).toMatchObject({ phase: 'done' });
  });

  it('waits for the head where nobody carries the skill of the check', async () => {
    const f = await fixture('marketing', { head: 'MKT-HEAD', author: 'MKT-WRITE' }, ['dev-review-diff']);
    const { task } = await f.create();
    const handed = await submit(f.ctx, f.author.id, task.id, { summary: 'The launch text.', evidence: 'Read it against the brief.', review: { baseCommit: BASE } });
    expect(handed.task).toMatchObject({ status: 'waiting', assigneeAgentId: null });
    expect(handed.wakes).toEqual([expect.objectContaining({ agentId: f.head.id, why: 'blocked' })]);
  });

  it('refuses a stage the route of the department does not have', async () => {
    const f = await marketing();
    await expect(f.create({ cleanup: true }).then(() => null)).rejects.toMatchObject({ status: 409 });
    await expect(f.create({ testsAgentId: f.checker.id }).then(() => null)).rejects.toMatchObject({ status: 409 });
  });

  it('adds no Security where the route of the department has none', async () => {
    const f = await marketing();
    const { task } = await f.create({ riskClass: 'money' });
    expect(await f.echelons(task.id)).toMatchObject({ security: { required: false } });
    await submit(f.ctx, f.author.id, task.id, { summary: 'The launch text.', evidence: 'Read it against the brief.', review: { baseCommit: BASE } });
    await expect(verdict(f.ctx, f.checker.id, task.id, { pass: true, comment: 'A price claim.', reviewedCommit: HEAD, security: 'Names a price.' }).then(() => null)).rejects.toMatchObject({ status: 409 });
  });

  it('takes a department made from no template through the stages of Development', async () => {
    const f = await fixture(null, { head: 'DEV-HEAD', author: 'DEV-BE' }, ['dev-review-diff']);
    const { task } = await f.create();
    const route = await f.echelons(task.id);
    expect(route.stages.map(step => step.stage)).toEqual(['architecture', 'development', 'review', 'security', 'tests']);
    expect(route.abilities).toEqual({ review: 'dev-review-diff', cleanup: 'dev-cleanup', security: 'dev-security-review', tests: 'dev-test-environment' });
  });
});
