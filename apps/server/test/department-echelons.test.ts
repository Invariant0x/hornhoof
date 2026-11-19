import { describe, expect, it } from 'vitest';
import { agents, companies, departments, subscriptions } from '../src/db/schema.js';
import { createTask, loadTask, report, submit, verdict, type NewTask } from '../src/modules/tasks/engine.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import type { TemplateKey } from '@hornhoof/protocol';
import { echelonsTurn, setUpCompany, testApp } from './helpers.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

/* A department of the given template in a turn run in echelons: a head, an author and one more employee who carries the
   given skills. It keeps its work in a repository unless told otherwise. */
async function fixture(templateKey: TemplateKey | null, roles: { head: string; author: string }, checkerSkills: string[], options: { repo?: boolean; turn?: boolean } = {}) {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [claude] = await db.select().from(subscriptions);
  const [department] = await db.insert(departments).values({ companyId: company!.id, templateKey, roleCode: 'DEP', repoUrl: options.repo === false ? null : 'https://github.com/acme/site.git' }).returning();
  const skillsOf = (roleKey: string) => app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id);
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, model: string, skills = skillsOf(roleKey)) =>
    (await db.insert(agents).values({ companyId: company!.id, departmentId: department!.id, name, kind, roleKey, subscriptionId: claude!.id, model, skills }).returning())[0]!;
  if (options.turn !== false) await echelonsTurn(db, company!.id);
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
  const log = async (id: string) => (await taskDetail(app.ctx, await loadTask(db, id), () => true)).log;
  /* What was handed in last, as its hand-in recorded it. */
  const handedIn = async (id: string) => ((await log(id)).findLast(event => event.kind === 'submitted')!.data as { candidate: { id: string; digest: string } }).candidate;
  return { ctx: app.ctx, db, head, author, checker, create, echelons, log, handedIn };
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

  it('skips a check nobody in the department carries the skill of, and hands the result to the head to accept', async () => {
    const f = await fixture('marketing', { head: 'MKT-HEAD', author: 'MKT-WRITE' }, ['dev-review-diff']);
    const { task } = await f.create();
    const handed = await submit(f.ctx, f.author.id, task.id, { summary: 'The launch text.', evidence: 'Read it against the brief.', review: { baseCommit: BASE } });
    expect(handed.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect(handed.wakes).toEqual([expect.objectContaining({ agentId: f.head.id, why: 'reviewed' })]);
    expect((await f.echelons(task.id)).stages.find(step => step.stage === 'review')).toMatchObject({ status: 'skipped', reason: 'no_department_checker' });
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

const HAND_IN = { summary: 'The launch text is attached as launch.md.', evidence: 'Read it against the brief and the price list.' };
const office = (checkerSkills = ['hh-check-work'], options: { turn?: boolean } = {}) =>
  fixture('marketing', { head: 'MKT-HEAD', author: 'MKT-WRITE' }, checkerSkills, { repo: false, ...options });

describe('a department that keeps no repository', () => {
  it('stores the stock one-shot work and review stages on a document task', async () => {
    const f = await office();
    const { task } = await f.create({ paths: undefined });
    expect((await f.echelons(task.id)).oneShot).toEqual({
      development: { fanOut: 5, judge: expect.stringContaining('headline') },
      review: { fanOut: 3, judge: expect.stringContaining('claim') },
    });
  });

  it('takes the work of an employee through its stages as a document', async () => {
    const f = await office();
    const { task } = await f.create({ paths: undefined });
    expect(task).toMatchObject({ executorAgentId: f.author.id, assigneeAgentId: f.author.id });
    const route = await f.echelons(task.id);
    expect(route).toMatchObject({ resultKind: 'document', stage: 'development', abilities: { review: 'hh-check-work' } });
    expect(route.stages.map(step => step.stage)).toEqual(['development', 'review']);
  });

  it('hands the document to the checker, and to the head once it passed', async () => {
    const f = await office();
    const { task } = await f.create({ paths: undefined });
    const handed = await submit(f.ctx, f.author.id, task.id, HAND_IN);
    expect(handed.task).toMatchObject({ status: 'review', assigneeAgentId: f.checker.id });
    const candidate = await f.handedIn(task.id);
    expect(candidate).toMatchObject({ parentId: null, digest: expect.stringMatching(/^[a-f0-9]{64}$/), producedBy: { agentId: f.author.id, stage: 'development' } });
    expect(candidate).not.toHaveProperty('commit');
    const passed = await verdict(f.ctx, f.checker.id, task.id, { pass: true, comment: 'Every price matches the list.', candidateId: candidate.id });
    expect(passed.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect(await f.echelons(task.id)).toMatchObject({ phase: 'ready', candidateId: candidate.id });
    const done = await report(f.ctx, f.head.id, task.id, { done: true, summary: 'Accepted the checked text.' });
    expect(done.task).toMatchObject({ status: 'done', assigneeAgentId: null });
    expect(await f.echelons(task.id)).toMatchObject({ phase: 'done' });
    expect((await f.log(task.id)).findLast(event => event.kind === 'report')!.data).toMatchObject({ acceptedDocument: { candidateId: candidate.id, digest: candidate.digest } });
  });

  it('keeps a document that did not pass with its checker, who corrects it and hands the corrected one on', async () => {
    const f = await office();
    const { task } = await f.create({ paths: undefined });
    await submit(f.ctx, f.author.id, task.id, HAND_IN);
    const first = (await f.echelons(task.id)).candidateId!;
    await expect(verdict(f.ctx, f.checker.id, task.id, { pass: true, comment: 'Fine.', candidateId: f.author.id }).then(() => null)).rejects.toMatchObject({ status: 409 });
    const failed = await verdict(f.ctx, f.checker.id, task.id, { pass: false, comment: 'The second price is last year\'s.', candidateId: first });
    expect(failed.task).toMatchObject({ status: 'working', assigneeAgentId: f.checker.id });
    const corrected = await submit(f.ctx, f.checker.id, task.id, { summary: 'Corrected the second price.', evidence: 'Compared with the price list again.' });
    expect(corrected.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    const candidate = await f.handedIn(task.id);
    expect(candidate).toMatchObject({ parentId: first, producedBy: { agentId: f.checker.id, stage: 'review' } });
  });

  it('refuses a commit in a document hand-in, a report in place of it, and an acceptance before the check', async () => {
    const f = await office();
    const { task } = await f.create({ paths: undefined });
    await expect(submit(f.ctx, f.author.id, task.id, { ...HAND_IN, review: { baseCommit: BASE } }).then(() => null)).rejects.toMatchObject({ status: 400 });
    await expect(report(f.ctx, f.author.id, task.id, { done: true, summary: 'Done.' }).then(() => null)).rejects.toMatchObject({ status: 400 });
    await submit(f.ctx, f.author.id, task.id, HAND_IN);
    await expect(report(f.ctx, f.head.id, task.id, { done: true, summary: 'Accepted.' }).then(() => null)).rejects.toMatchObject({ status: 400 });
  });

  it('closes a group over an accepted document', async () => {
    const f = await office();
    const group = await createTask(f.ctx, { agentId: f.head.id }, { title: 'Launch', brief: 'Prepare the launch.', body: 'Texts for the launch.', departmentId: f.head.departmentId!, assigneeAgentId: f.head.id });
    const { task } = await f.create({ paths: undefined, parentId: group.task.id });
    await submit(f.ctx, f.author.id, task.id, HAND_IN);
    await verdict(f.ctx, f.checker.id, task.id, { pass: true, comment: 'Checked.', candidateId: (await f.echelons(task.id)).candidateId! });
    await report(f.ctx, f.head.id, task.id, { done: true, summary: 'Accepted the checked text.' });
    const closed = await report(f.ctx, f.head.id, group.task.id, { done: true, summary: 'The launch texts are ready.' });
    expect(closed.task).toMatchObject({ status: 'done' });
  });

  it('tells whoever holds a document how it is handed in, checked and accepted', async () => {
    const f = await office();
    const { task } = await f.create({ paths: undefined });
    const told = (agentId: string, why: 'assigned' | 'review' | 'reviewed') => wakePrompt({ kind: 'worker' }, { ...task, assigneeAgentId: agentId }, { agentId, taskId: task.id, why }, 'document');
    expect(told(f.author.id, 'assigned')).toContain('hand the result in with submit as a document');
    expect(told(f.checker.id, 'review')).toContain('Give verdict naming candidateId when the document meets the goal.');
    expect(told(f.checker.id, 'review')).not.toMatch(/branch|commit/);
    expect(told(f.head.id, 'reviewed')).toContain('record acceptance with report done true');
  });

  it('works as before where nobody in the department carries the skill of the check', async () => {
    const f = await office(['mkt-copywriting']);
    const { task } = await f.create({ paths: undefined });
    expect(task.executorAgentId).toBeNull();
    expect(await f.echelons(task.id)).toMatchObject({ resultKind: 'coordination', stages: [] });
    expect((await report(f.ctx, f.author.id, task.id, { done: true, summary: 'Wrote the launch text.' })).task).toMatchObject({ status: 'done' });
  });

  it('takes the work through its stages with an open turn or none, and as before in a department whose route has no check', async () => {
    /* The team of who does it decides, never a turn. */
    const outside = await office(['hh-check-work'], { turn: false });
    expect(await outside.echelons((await outside.create({ paths: undefined })).task.id)).toMatchObject({ resultKind: 'document', stage: 'development', abilities: { review: 'hh-check-work' } });
    const home = await fixture('household', { head: 'HHD-HEAD', author: 'HHD-BILLS' }, ['hh-check-work'], { repo: false });
    expect(await home.echelons((await home.create({ paths: undefined })).task.id)).toMatchObject({ resultKind: 'coordination' });
  });
});
