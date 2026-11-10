import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, teams, turns } from '../src/db/schema.js';
import { report, updateTask } from '../src/modules/tasks/engine.js';
import { fixture } from './development-echelons-fixture.js';

/* The development fixture with no turn, then the given turn running, and a turnkey team of two members. */
async function modeFixture(mode: 'echelons' | 'turnkey' | null) {
  const f = await fixture({ turn: null });
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
  const player = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  const other = await f.hire('Other player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  for (const member of [player, other]) await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, member.id));
  if (mode) await f.db.insert(turns).values({ companyId: f.task.companyId, number: 1, goal: 'Totals', status: 'open', mode, openedAt: new Date() });
  return { ...f, player, other };
}

const routeOf = async (f: Awaited<ReturnType<typeof modeFixture>>, id: string) => (await f.detail(id)).echelons;

describe('echelons exist only in a turn started in echelons', () => {
  it('gives a task made outside any turn no echelons, whoever holds it, and its holder closes it alone', async () => {
    const f = await modeFixture(null);
    expect(await routeOf(f, f.task.id)).toMatchObject({ resultKind: 'turnkey', stage: null, stages: [] });
    const closed = await report(f.ctx, f.author.id, f.task.id, { done: true, summary: 'Changed the totals and checked them.' });
    expect(closed.task).toMatchObject({ status: 'done' });
    for (const id of [f.reviewer.id, f.security.id, f.tester.id]) expect(closed.wakes.map(wake => wake.agentId)).not.toContain(id);
  });

  it('gives a task of a turnkey turn no echelons and only to a member of a turnkey team', async () => {
    const f = await modeFixture('turnkey');
    const { task } = await f.create({ assigneeAgentId: f.player.id });
    expect(await routeOf(f, task.id)).toMatchObject({ resultKind: 'turnkey', stages: [] });
    await expect(f.create()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/turnkey turn[^.]*member of a turnkey team/) as unknown });
  });

  it('keeps the echelons for a task of an echelons turn, unless a member of a turnkey team holds it', async () => {
    const f = await modeFixture('echelons');
    const { task } = await f.create();
    expect(await routeOf(f, task.id)).toMatchObject({ resultKind: 'code', stage: 'development' });
    const { task: alone } = await f.create({ assigneeAgentId: f.player.id });
    expect(await routeOf(f, alone.id)).toMatchObject({ resultKind: 'turnkey', stages: [] });
  });

  it('never moves the route of a task made before a turn started', async () => {
    const f = await modeFixture('echelons');
    expect(await routeOf(f, f.task.id)).toMatchObject({ resultKind: 'turnkey', stages: [] });
  });

  it('lets a task outside a turn go to anyone, and a task of a turnkey turn only to a member of a turnkey team', async () => {
    const outside = await modeFixture(null);
    expect((await updateTask(outside.ctx, outside.head.id, outside.task.id, { executor: outside.security.id })).task).toMatchObject({ assigneeAgentId: outside.security.id });

    const f = await modeFixture('turnkey');
    const { task } = await f.create({ assigneeAgentId: f.player.id });
    await expect(updateTask(f.ctx, f.head.id, task.id, { executor: f.author.id })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('member of a turnkey team') as unknown });
    expect((await updateTask(f.ctx, f.head.id, task.id, { executor: f.other.id })).task).toMatchObject({ assigneeAgentId: f.other.id });
  });

  it('names no checker of a task with no echelons, even when the head names one', async () => {
    const f = await modeFixture(null);
    const { task } = await f.create({ reviewerAgentId: f.reviewer.id, securityAgentId: f.security.id, testsAgentId: f.tester.id, cleanup: true });
    expect(await routeOf(f, task.id)).toMatchObject({ resultKind: 'turnkey', stages: [], assignment: null });
  });
});
