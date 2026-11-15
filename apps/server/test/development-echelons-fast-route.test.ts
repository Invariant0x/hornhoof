import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, jobs, taskEvents, teams, testParts, testRuns } from '../src/db/schema.js';
import { report, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import type { AuthorCheckResult } from '../src/modules/tasks/review-quality.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { candidateChecks } from './development-echelons-verification.js';

const ORIGIN_BASE = '1'.repeat(40);
const ORIGIN_COMMIT = '2'.repeat(40);
let nextRunNumber = 1;

async function seedAuthorCheck(
  f: Awaited<ReturnType<typeof fixture>>,
  taskId: string,
  commit: string,
  options: { paths?: string[]; worstCrap?: number | null; docsOnly?: boolean } = {},
) {
  const paths = options.paths ?? ['logic/totals.ts'];
  const [job] = await f.db.insert(jobs).values({
    companyId: f.task.companyId, agentId: f.author.id, taskId, subscriptionId: f.author.subscriptionId!,
    kind: 'conversation', prompt: 'Run author check', timeoutMs: 1000,
  }).returning();
  const [run] = await f.db.insert(testRuns).values({
    companyId: f.task.companyId, taskId, agentId: f.author.id, jobId: job!.id, departmentId: f.task.departmentId!,
    number: nextRunNumber++, branch: 'task-1', commitSha: commit, command: 'author-check', timeoutMs: 1000, status: 'passed', finishedAt: new Date(),
  }).returning();
  const [part] = await f.db.insert(testParts).values({
    companyId: f.task.companyId, runId: run!.id, part: 1, status: 'passed', commit, exitCode: 0,
  }).returning();
  const stages = options.docsOnly
    ? [
        { name: 'format' as const, status: 'unavailable' as const, exitCode: null, partId: null },
        { name: 'lint' as const, status: 'unavailable' as const, exitCode: null, partId: null },
        { name: 'types' as const, status: 'unavailable' as const, exitCode: null, partId: null },
        { name: 'tests' as const, status: 'unavailable' as const, exitCode: null, partId: null },
        { name: 'crapper' as const, status: 'unavailable' as const, exitCode: null, partId: null },
        { name: 'dryer' as const, status: 'unavailable' as const, exitCode: null, partId: null },
      ]
    : (['format', 'lint', 'types', 'tests', 'crapper', 'dryer'] as const).map(name => ({
        name, status: 'passed' as const, exitCode: 0, partId: part!.id,
      }));
  const numbers: AuthorCheckResult['numbers'] = options.docsOnly
    ? { tests: null, changedLines: null, worstCrap: null, dryerFlags: null }
    : {
        tests: { passed: 6, failed: 0, skipped: 0, total: 6 },
        changedLines: { covered: 10, total: 10 },
        worstCrap: options.worstCrap === undefined ? 4.5 : options.worstCrap,
        dryerFlags: 0,
      };
  const authorCheck = {
    version: 1, producer: 'author-check-v1', companyId: f.task.companyId, taskId, authorId: f.author.id,
    jobId: job!.id, runId: run!.id, submissionCommit: commit, checkCommit: commit,
    scope: { kind: 'changed', paths }, stages, numbers,
    receipt: { status: 'passed', parts: [{ id: part!.id, status: 'passed', commit, exitCode: 0 }] },
  };
  await f.db.insert(taskEvents).values({
    companyId: f.task.companyId, taskId, kind: 'comment', text: `Author check on ${commit}.`, data: { authorCheck },
  });
}

describe('echelon route without idle handoffs', () => {
  it('collapses Architecture into Development when both belong to the same executor', async () => {
    const f = await fixture({ small: false });
    const detail = await f.detail();
    expect(detail.echelons).toMatchObject({
      stage: 'development',
      phase: 'active',
      ownerAgentId: f.author.id,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'architecture', status: 'skipped', reason: 'same_executor', ownerAgentId: null }),
        expect.objectContaining({ stage: 'development', status: 'active', ownerAgentId: f.author.id }),
      ]),
    });
    const moved = await submit(f.ctx, f.author.id, f.task.id, {
      summary: 'Implemented totals directly.', evidence: 'Focused totals check passed.', review: { baseCommit: BASE },
    });
    expect(moved.task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it('keeps Architecture separate when a different employee designs the plan before Development', async () => {
    const f = await fixture({ small: false });
    const architect = await f.hire('Architect', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    const { task } = await f.create({ small: false, architectAgentId: architect.id, assigneeAgentId: f.author.id });
    expect((await f.detail(task.id)).echelons).toMatchObject({
      stage: 'architecture',
      phase: 'active',
      ownerAgentId: architect.id,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'architecture', status: 'active', ownerAgentId: architect.id }),
        expect.objectContaining({ stage: 'development', status: 'pending', ownerAgentId: f.author.id }),
      ]),
    });
    const planned = await report(f.ctx, architect.id, task.id, { done: true, summary: 'Extract pure rounding helper and test boundaries.' });
    expect(planned.task).toMatchObject({ status: 'open', assigneeAgentId: f.author.id });
    expect((await f.detail(task.id)).echelons).toMatchObject({ stage: 'development', ownerAgentId: f.author.id });
  });

  it('assigns an eligible Security checker immediately on task creation and risk escalation', async () => {
    const f = await fixture();
    const { task } = await f.create({ riskClass: 'security', securityAgentId: undefined });
    expect((await f.detail(task.id)).echelons).toMatchObject({
      security: { required: true, reason: 'security' },
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'security', status: 'pending', ownerAgentId: f.security.id }),
      ]),
    });

    const { task: laterRisk } = await f.create({ riskClass: 'none', securityAgentId: undefined });
    expect((await f.detail(laterRisk.id)).echelons.stages.find(s => s.stage === 'security')).toMatchObject({ status: 'skipped', ownerAgentId: null });
    await updateTask(f.ctx, f.head.id, laterRisk.id, { riskClass: 'access' });
    expect((await f.detail(laterRisk.id)).echelons.stages.find(s => s.stage === 'security')).toMatchObject({
      status: 'pending', ownerAgentId: f.security.id,
    });
  });

  it('skips intermediate Review on small tasks with green check:author and CRAP < 10 and accepts cleanly', async () => {
    const f = await fixture({ small: true, riskClass: 'none' });
    await seedAuthorCheck(f, f.task.id, HEAD, { worstCrap: 5.2 });
    const moved = await submit(f.ctx, f.author.id, f.task.id, {
      summary: 'Small verified fix.', evidence: 'Author check green.', review: { baseCommit: BASE },
    });
    expect(moved.task).toMatchObject({ status: 'open', assigneeAgentId: f.tester.id });
    const afterSubmit = (await f.detail()).echelons;
    expect(afterSubmit).toMatchObject({
      stage: 'tests',
      phase: 'active',
      ownerAgentId: f.tester.id,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'review', status: 'skipped', reason: 'author_check_passed' }),
        expect.objectContaining({ stage: 'tests', status: 'active', ownerAgentId: f.tester.id }),
      ]),
    });

    const checks = await candidateChecks(f, afterSubmit, HEAD);
    const run = await checks.run();
    await report(f.ctx, f.tester.id, f.task.id, checks.verified([run.id]));
    const ready = (await f.detail()).echelons;
    f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: HEAD });
    const accepted = await report(f.ctx, f.head.id, f.task.id, {
      done: true, summary: 'Integrated small change.',
      acceptance: { candidateId: ready.candidateId!, revision: ready.revision, integrationCommit: HEAD },
    });
    expect(accepted.task.status).toBe('done');
  });

  it('skips intermediate Review on docs/** changes and clean cherry-picks when check:author is green and CRAP < 10', async () => {
    const f = await fixture({ small: false });
    const { task: docsTask } = await f.create({ small: false, paths: ['docs/**'] });
    f.atCommit(HEAD, ['docs/architecture.md']);
    await seedAuthorCheck(f, docsTask.id, HEAD, { paths: ['docs/architecture.md'], docsOnly: true });
    const docsMoved = await submit(f.ctx, f.author.id, docsTask.id, {
      summary: 'Documented route rules.', evidence: 'Author check green on docs.', review: { baseCommit: BASE },
    });
    expect(docsMoved.task.assigneeAgentId).toBe(f.tester.id);
    expect((await f.detail(docsTask.id)).echelons.stages.find(s => s.stage === 'review')).toMatchObject({
      status: 'skipped', reason: 'author_check_passed',
    });

    const { task: pickTask } = await f.create({ small: false, paths: ['logic/totals.ts'] });
    f.atCommit(HEAD, ['logic/totals.ts']);
    f.ctx.readCompare = async (_repo, want) => ({
      complete: true,
      baseSha: want.base,
      headSha: want.head,
      paths: ['logic/totals.ts'],
      diff: '@@ -1 +1 @@\n-old\n+new',
      commits: want.head === HEAD ? [{ sha: HEAD, parents: [BASE], message: `Backport fix\n\n(cherry picked from commit ${ORIGIN_COMMIT})` }] : [],
    });
    await seedAuthorCheck(f, pickTask.id, HEAD, { worstCrap: 3.1 });
    const pickMoved = await submit(f.ctx, f.author.id, pickTask.id, {
      summary: 'Clean cherry-pick.', evidence: 'Author check green.',
      review: { baseCommit: BASE, cherryPick: { baseCommit: ORIGIN_BASE, commit: ORIGIN_COMMIT } },
    });
    expect(pickMoved.task.assigneeAgentId).toBe(f.tester.id);
    expect((await f.detail(pickTask.id)).echelons.stages.find(s => s.stage === 'review')).toMatchObject({
      status: 'skipped', reason: 'author_check_passed',
    });

    const { task: trailerPick } = await f.create({ small: false, paths: ['logic/totals.ts'] });
    await seedAuthorCheck(f, trailerPick.id, HEAD, { worstCrap: 2.4 });
    const trailerMoved = await submit(f.ctx, f.author.id, trailerPick.id, {
      summary: 'Clean cherry-pick with -x trailer.', evidence: 'Author check green.', review: { baseCommit: BASE },
    });
    expect(trailerMoved.task.assigneeAgentId).toBe(f.tester.id);
  });

  it('keeps Review when CRAP >= 10 or when a cherry-pick modified the original diff, and keeps Security mandatory on risky tasks', async () => {
    const f = await fixture({ small: true, riskClass: 'none' });
    await seedAuthorCheck(f, f.task.id, HEAD, { worstCrap: 10 });
    const highCrap = await submit(f.ctx, f.author.id, f.task.id, {
      summary: 'Complex change.', evidence: 'CRAP reached 10.', review: { baseCommit: BASE },
    });
    expect(highCrap.task.assigneeAgentId).toBe(f.reviewer.id);
    expect((await f.detail()).echelons.stage).toBe('review');

    const { task: dirtyPick } = await f.create({ small: false, paths: ['logic/totals.ts'] });
    f.ctx.readCompare = async (_repo, want) => ({
      complete: true,
      baseSha: want.base,
      headSha: want.head,
      paths: ['logic/totals.ts'],
      diff: want.head === ORIGIN_COMMIT ? '@@ -1 +1 @@\n-old\n+origin' : '@@ -1 +1 @@\n-old\n+conflict-edit',
      commits: want.head === HEAD ? [{ sha: HEAD, parents: [BASE], message: `Edited pick\n\n(cherry picked from commit ${ORIGIN_COMMIT})` }] : [],
    });
    await seedAuthorCheck(f, dirtyPick.id, HEAD, { worstCrap: 2.0 });
    const dirtyMoved = await submit(f.ctx, f.author.id, dirtyPick.id, {
      summary: 'Edited cherry-pick.', evidence: 'Manual conflict fix.',
      review: { baseCommit: BASE, cherryPick: { baseCommit: ORIGIN_BASE, commit: ORIGIN_COMMIT } },
    });
    expect(dirtyMoved.task.assigneeAgentId).toBe(f.reviewer.id);

    const { task: spoofedTrailer } = await f.create({ small: false, paths: ['logic/totals.ts'] });
    await seedAuthorCheck(f, spoofedTrailer.id, HEAD, { worstCrap: 2.0 });
    const spoofedMoved = await submit(f.ctx, f.author.id, spoofedTrailer.id, {
      summary: 'Spoofed -x trailer with altered diff.', evidence: 'Author check green.', review: { baseCommit: BASE },
    });
    expect(spoofedMoved.task.assigneeAgentId).toBe(f.reviewer.id);

    const { task: riskySmall } = await f.create({ small: true, riskClass: 'security', securityAgentId: undefined });
    await seedAuthorCheck(f, riskySmall.id, HEAD, { worstCrap: 4.0 });
    const riskyMoved = await submit(f.ctx, f.author.id, riskySmall.id, {
      summary: 'Small auth check.', evidence: 'Author check green.', review: { baseCommit: BASE },
    });
    expect(riskyMoved.task).toMatchObject({ status: 'review', assigneeAgentId: f.security.id });
    expect((await f.detail(riskySmall.id)).echelons).toMatchObject({
      stage: 'security',
      phase: 'active',
      ownerAgentId: f.security.id,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'review', status: 'skipped', reason: 'author_check_passed' }),
        expect.objectContaining({ stage: 'security', status: 'active', ownerAgentId: f.security.id }),
      ]),
    });
    const afterSec = await verdict(f.ctx, f.security.id, riskySmall.id, {
      pass: true, comment: 'Access boundary holds.', reviewedCommit: HEAD,
    });
    expect(afterSec.task.assigneeAgentId).toBe(f.tester.id);
    expect((await f.detail(riskySmall.id)).echelons.stage).toBe('tests');
  });

  it('leaves turnkey team direct end-to-end routing completely unchanged', async () => {
    const f = await fixture({ small: false, riskClass: 'security' });
    const [team] = await f.db.insert(teams).values({
      companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Turnkey Lane', turnkey: true,
    }).returning();
    const player = await f.hire('Turnkey Dev', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, player.id));
    const { task } = await f.create({
      assigneeAgentId: player.id, small: false, riskClass: 'security',
      reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined,
    });
    expect((await f.detail(task.id)).echelons).toMatchObject({
      resultKind: 'turnkey', stage: null, stages: [], candidateId: null, security: { required: false },
    });
    f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: HEAD });
    const closed = await report(f.ctx, player.id, task.id, { done: true, summary: 'Completed end to end on task branch.' });
    expect(closed.task).toMatchObject({ status: 'done', assigneeAgentId: null });
  });
});
