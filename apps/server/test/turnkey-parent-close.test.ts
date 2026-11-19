import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, taskEvents, tasks, teams } from '../src/db/schema.js';
import { report } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

describe('the task a turnkey task was made under', () => {
  it('closes with its owner\'s report once the turnkey work under it is done', async () => {
    const f = await fixture();
    const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
    const player = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, player.id));
    const group = (await f.create({ title: 'The work of a turnkey turn', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    const { task } = await f.create({ parentId: group.id, assigneeAgentId: player.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined, body: 'Change logic/totals.ts.' });
    await report(f.ctx, player.id, task.id, { done: true, summary: 'Merged and released, checks in the log.', turnkey: { commit: HEAD, baseCommit: BASE } });

    const closed = await report(f.ctx, f.head.id, group.id, { done: true, summary: 'The turnkey work under it is done.' });
    expect(closed.task).toMatchObject({ status: 'done' });
    expect((await f.detail(group.id)).echelons).toMatchObject({ resultKind: 'coordination', phase: 'done' });
  });

  /* As in a company whose turnkey task was closed by hand in its database, with no report of its holder. */
  it('closes once the turnkey work under it was closed directly in the database', async () => {
    const f = await fixture();
    const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
    const player = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, player.id));
    const group = (await f.create({ title: 'The work of a turnkey turn', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    const { task } = await f.create({ parentId: group.id, assigneeAgentId: player.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined, body: 'Change logic/totals.ts.' });
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date('2026-11-17T12:00:00.000Z') }).where(eq(tasks.id, task.id));

    const closed = await report(f.ctx, f.head.id, group.id, { done: true, summary: 'The turnkey work under it is closed.' });
    expect(closed.task).toMatchObject({ status: 'done' });
    const log = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, group.id)).orderBy(asc(taskEvents.id));
    expect(log.findLast(event => event.kind === 'report' && 'acceptedChildren' in event.data)?.data).toMatchObject({ acceptedChildren: [{ taskId: task.id, unaccepted: { status: 'done', phase: 'active', closedBy: null } }] });
  });

  it('stays open while the turnkey work under it is not done', async () => {
    const f = await fixture();
    const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
    const player = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, player.id));
    const group = (await f.create({ title: 'The work of a turnkey turn', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    await f.create({ parentId: group.id, assigneeAgentId: player.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined, body: 'Change logic/totals.ts.' });

    await expect(report(f.ctx, f.head.id, group.id, { done: true, summary: 'Done.' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('still has open subtasks') });
  });
});
