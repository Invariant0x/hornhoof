import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, tasks, teams } from '../src/db/schema.js';
import { report, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { readCommit } from '../src/modules/testruns/refs.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { as } from './helpers.js';
import { RECORDED } from './recorded-fixture.js';

/* A department with a team whose members each do a task end to end alone, and the ordinary members of the route. */
async function turnkeyFixture(turnkey = true) {
  const f = await fixture();
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey }).returning();
  const player = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, player.id));
  const other = await f.hire('Other player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, other.id));
  const give = (changes: Parameters<typeof f.create>[0] = {}) => f.create({
    assigneeAgentId: player.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined,
    body: 'Stages: Architecture, Development, Review, Security, Tests. Change logic/totals.ts.', ...changes,
  });
  return { ...f, team: team!, player, other, give };
}

describe('a task of a turnkey team never enters the echelons', () => {
  it('gets no echelon route, whatever its text says, and its holder closes it alone', async () => {
    const f = await turnkeyFixture();
    const { task } = await f.give();
    expect((await f.detail(task.id)).echelons).toMatchObject({ resultKind: 'turnkey', stage: null, stages: [], candidateId: null });

    const closed = await report(f.ctx, f.player.id, task.id, { done: true, summary: 'Merged and released 1.2.3, checks in the log.', turnkey: { commit: HEAD, baseCommit: BASE } });
    expect(closed.task).toMatchObject({ status: 'done', assigneeAgentId: null });
    expect((await f.detail(task.id)).echelons).toMatchObject({ resultKind: 'turnkey', phase: 'done', stages: [] });
    for (const id of [f.reviewer.id, f.security.id, f.tester.id, f.author.id]) expect(closed.wakes.map(wake => wake.agentId)).not.toContain(id);
  });

  it.each([500, 503, 'network'] as const)('keeps the task open when GitHub lookup fails with %s', async failure => {
    const f = await turnkeyFixture();
    const { task } = await f.give();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => failure === 'network'
      ? Promise.reject(new Error('Network unavailable')) : Promise.resolve(new Response(null, { status: failure })));
    onTestFinished(() => { fetch.mockRestore(); });
    f.ctx.readCommit = readCommit;

    await expect(report(f.ctx, f.player.id, task.id, { done: true, summary: 'Checked.' })).rejects.toMatchObject({
      status: 409, reason: 'task_changed', message: expect.stringContaining('Try again.') as unknown,
    });
    expect((await f.detail(task.id)).echelons.phase).toBe('active');
  });

  it('can close work without a branch when GitHub returns 404', async () => {
    const f = await turnkeyFixture();
    const { task } = await f.give();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    onTestFinished(() => { fetch.mockRestore(); });
    f.ctx.readCommit = readCommit;

    const closed = await report(f.ctx, f.player.id, task.id, { done: true, summary: 'Checked.', recorded: RECORDED });
    expect(closed.task).toMatchObject({ status: 'done', turnId: null });
  });

  it('tells whoever gave it when its holder cannot go on, and calls nobody else onto it', async () => {
    const f = await turnkeyFixture();
    const { task } = await f.give();
    const stuck = await report(f.ctx, f.player.id, task.id, { done: false, summary: 'The release needs a decision.' });
    expect(stuck.task).toMatchObject({ status: 'blocked' });
    expect(stuck.wakes.map(wake => wake.agentId)).toEqual([f.head.id]);
  });

  it('is taken by no echelon tool', async () => {
    const f = await turnkeyFixture();
    const { task } = await f.give();
    await expect(submit(f.ctx, f.player.id, task.id, { summary: 'Done.', evidence: 'Checks.', review: { baseCommit: BASE } })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('turnkey') as unknown });
    await expect(verdict(f.ctx, f.reviewer.id, task.id, { pass: true, comment: 'Looks fine.', reviewedCommit: HEAD })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('turnkey') as unknown });
    await expect(report(f.ctx, f.player.id, task.id, { done: true, summary: 'Checked.', verification: { candidateId: crypto.randomUUID(), revision: 1 } })).rejects.toMatchObject({ status: 409 });
    await expect(updateTask(f.ctx, f.head.id, task.id, { cleanup: true })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('turnkey') as unknown });
    expect((await f.detail(task.id)).echelons).toMatchObject({ resultKind: 'turnkey', phase: 'active', stages: [] });
  });

  it('tells its holder to do it end to end on its task branch with local tests, never to follow echelons', async () => {
    const f = await turnkeyFixture();
    const { task } = await f.give();
    const text = wakePrompt(f.player, task, { agentId: f.player.id, taskId: task.id, why: 'assigned' }, 'turnkey');
    expect(text).toMatch(/end to end[^.]*alone[^.]*report done true/);
    expect(text).toContain('checking what you touched with local tests, as the repository\'s CI checks the release');
    expect(text).not.toMatch(/tests,\s*merge and release/i);
    expect(text).not.toMatch(/follow task\.echelons|Review|verdict/);
    expect(wakePrompt(f.author, f.task, { agentId: f.author.id, taskId: f.task.id, why: 'assigned' }, 'code')).toMatch(/follow task\.echelons/);
  });

  it('calls no Review, Security or Tests owner onto it, even when the head names one', async () => {
    const f = await turnkeyFixture();
    const { task } = await f.give({ reviewerAgentId: f.reviewer.id, securityAgentId: f.security.id, testsAgentId: f.tester.id, cleanup: true });
    expect((await f.detail(task.id)).echelons).toMatchObject({ resultKind: 'turnkey', stages: [], assignment: null });
  });

  it('goes to another member of a turnkey team, never into the echelons', async () => {
    const f = await turnkeyFixture();
    const { task } = await f.give();
    const moved = await updateTask(f.ctx, f.head.id, task.id, { executor: f.other.id });
    expect(moved.task).toMatchObject({ assigneeAgentId: f.other.id });
    await expect(updateTask(f.ctx, f.head.id, task.id, { executor: f.author.id })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('turnkey') as unknown });
  });

  it('never puts a member of a turnkey team onto an echelon task', async () => {
    const f = await turnkeyFixture();
    await expect(updateTask(f.ctx, f.head.id, f.task.id, { executor: f.player.id })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('turnkey') as unknown });
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]).toMatchObject({ assigneeAgentId: f.author.id });
  });

  it('keeps the echelons for a team that is not marked turnkey, as a name says nothing', async () => {
    const f = await turnkeyFixture(false);
    const { task } = await f.give();
    expect((await f.detail(task.id)).echelons).toMatchObject({ resultKind: 'code', stage: 'development' });
  });

  it('is marked on the team by a person, and the map shows the mark', async () => {
    const f = await turnkeyFixture(false);
    const marked = await f.app.inject({ method: 'PATCH', url: `/api/departments/${f.task.departmentId}/teams/${f.team.id}`, payload: { turnkey: true }, ...as(f.ceoToken) });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().team).toMatchObject({ id: f.team.id, turnkey: true });
    const org = (await f.app.inject({ url: '/api/org', ...as(f.ceoToken) })).json() as { departments: { teams: { id: string; turnkey: boolean }[] }[] };
    expect(org.departments.flatMap(department => department.teams).find(team => team.id === f.team.id)).toMatchObject({ turnkey: true });
    const { task } = await f.give();
    expect((await f.detail(task.id)).echelons).toMatchObject({ resultKind: 'turnkey' });
  });
});
