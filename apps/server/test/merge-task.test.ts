import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, invites, jobs, machines, nodes, pendingWakes, people, tasks } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { bodyOf, taskFor, titleOf } from '../src/modules/merge/task.js';
import { ownDatabases } from './helpers.js';
import { mergeApp, rowsOf } from './merge-app-fixture.js';

/* Each test forks its database, which a shared one would not survive. */
ownDatabases();

const taskOf = async (s: Awaited<ReturnType<typeof mergeApp>>, id: string) => (await s.db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

describe('the task a merge leaves the orchestrator', () => {
  it('names what came back in its title', () => {
    const [from, to] = [new Date('2026-11-03T14:02:00Z'), new Date('2026-11-03T15:30:00Z')];
    expect(titleOf([{ label: 'marat-mac', path: 'journal', from, to }])).toBe('Bring back what marat-mac did while apart (14:02 to 15:30 UTC)');
    expect(titleOf([{ label: 'the database from before the restore of 3 Nov 14:02 UTC', path: 'compare', from, to }])).toBe('Bring back what the database from before the restore of 3 Nov 14:02 UTC held (14:02 to 15:30 UTC)');
    expect(titleOf([{ label: 'marat-mac', path: 'journal', from: null, to: null }])).toBe('Bring back what marat-mac did while apart');
    const more = { path: 'journal' as const, from, to };
    expect(titleOf([{ label: 'a', ...more }, { label: 'b', ...more }])).toBe('Bring back what a and b did while apart');
    expect(titleOf([{ label: 'a', ...more }, { label: 'b', ...more }, { label: 'c', ...more }])).toBe('Bring back what a, b and c did while apart');
  });

  it('gives the orchestrator one task', async () => {
    const s = await mergeApp();
    const [machine] = await s.db.insert(machines).values({ ...s.on, personId: s.owner.id, machineKey: 'm1', hostname: 'marat-mac' }).returning();
    const [node] = await s.db.insert(nodes).values({ ...s.on, machineId: machine!.id, subscriptionId: s.plan.id }).returning();
    const fork = await s.fork();
    await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, s.one.id));
    await s.db.update(tasks).set({ title: 'Here' }).where(eq(tasks.id, s.one.id));
    await fork.db.update(tasks).set({ body: 'Body there' }).where(eq(tasks.id, s.two.id));
    await s.db.update(tasks).set({ body: 'Body here' }).where(eq(tasks.id, s.two.id));
    /* The same number given on each side, and work on the source's. */
    const there = await s.task(fork.db, 3, 'Three there');
    await s.task(s.db, 3, 'Three here');
    await fork.db.insert(jobs).values({ ...s.on, subscriptionId: s.plan.id, agentId: s.ana.id, nodeId: node!.id, prompt: 'Work', timeoutMs: 60_000, status: 'done', taskId: there.id, startedAt: new Date('2026-11-03T14:00:00Z'), finishedAt: new Date('2026-11-03T14:20:00Z'), toolTokenHash: 'h'.repeat(64) });
    const { id } = await s.merge(fork, { label: 'marat-mac' });
    /* The source is closed by the time the task is made: everything it needs is in the leader's own records. */
    await s.app.ctx.merger.tick();
    const [merge] = await rowsOf<{ task_id: string | null; task_wanted: boolean }>(s.db, sql`SELECT task_id, task_wanted FROM net.merges WHERE id = ${id}`);
    expect(merge!.task_id).toMatch(/^[0-9a-f-]{36}$/);
    const made = await taskOf(s, merge!.task_id!);
    expect(made).toMatchObject({ assigneeAgentId: s.orchestrator.id, createdByAgentId: s.orchestrator.id, departmentId: null });
    expect(made.title).toMatch(/^Bring back what marat-mac did while apart \(.+ UTC\)$/);
    const body = made.body;
    expect(body).toContain('What marat-mac did from ');
    expect(body).toContain(' UTC is brought back as far as its records prove.');
    expect(body).toContain('To settle: 2 for you; 0 proposed permanent deletions for the CEO.');
    expect(body).toContain('Task #4 here was #3 on marat-mac.');
    expect(body).toContain('Task #4 was worked on as task-3 on marat-mac until 3 Nov 14:20 UTC');
    expect(body).toContain('task #1 "Here": title: here "Here", there "There"');
    expect(body).toContain('task #2 "Two": body: here "Body here", there "Body there"');
    expect(body).toContain('merge_conflicts');
    expect(body).toContain('merge_pick');
    expect(body).not.toContain('h'.repeat(64));
    /* Asked again, it makes no second one. */
    await s.app.ctx.merger.tick();
    expect(await s.db.select(idOnly(tasks)).from(tasks).where(eq(tasks.assigneeAgentId, s.orchestrator.id))).toHaveLength(1);
  });

  it('includes reversible people and access conflicts while withholding their protected details', async () => {
    const s = await mergeApp();
    const [maria] = await s.db.insert(people).values({ ...s.on, name: 'Maria', email: 'maria@acme.test', status: 'invited', scopeKind: 'company' }).returning();
    await s.db.insert(invites).values({ tokenHash: 't'.repeat(64), companyId: s.acme.id, personId: maria!.id, createdBy: s.owner.id, expiresAt: new Date('2026-12-01T00:00:00Z') });
    const fork = await s.fork();
    await fork.db.update(people).set({ email: 'maria.there@acme.test' }).where(eq(people.id, maria!.id));
    await s.db.update(people).set({ email: 'maria.here@acme.test' }).where(eq(people.id, maria!.id));
    await fork.db.update(invites).set({ expiresAt: new Date('2026-12-02T00:00:00Z') }).where(eq(invites.personId, maria!.id));
    await s.db.update(invites).set({ expiresAt: new Date('2026-12-03T00:00:00Z') }).where(eq(invites.personId, maria!.id));
    await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, s.one.id));
    await s.db.update(tasks).set({ title: 'Here' }).where(eq(tasks.id, s.one.id));
    const { id } = await s.merge(fork);
    expect((await s.conflicts(id)).map(conflict => conflict.tbl)).toEqual(['invites', 'people', 'tasks']);
    const body = await bodyOf(s.db, [id]);
    expect(body).toContain('To settle: 3 for you; 0 proposed permanent deletions for the CEO.');
    for (const hidden of ['maria', 'Maria', ', people:', ', invites:', 't'.repeat(64)]) expect(body).not.toContain(hidden);
    expect(body).toContain('task #1 "Here"');
    /* A task nobody worked on there has no code to move. */
    expect(body).not.toContain('Code:');
    /* A conflict carried from a build that had a table this one has no rule for also needs investigation. */
    await s.db.execute(sql`INSERT INTO net.merge_conflicts (merge, carried, tbl, key, op, kind, topic, why) VALUES (${id}, gen_random_uuid(), 'a_table_of_another_build', '{"id": "1"}'::jsonb, 'insert', 'refused', 'work', 'x')`);
    expect(await bodyOf(s.db, [id])).toContain('To settle: 4 for you; 0 proposed permanent deletions for the CEO.');
  });

  it('joins a second merge into the open task', async () => {
    const s = await mergeApp();
    const [first, second] = [await s.fork(), await s.fork()];
    await first.db.update(tasks).set({ title: 'First there' }).where(eq(tasks.id, s.one.id));
    await second.db.update(tasks).set({ body: 'Second there' }).where(eq(tasks.id, s.two.id));
    await s.db.update(tasks).set({ title: 'Here', }).where(eq(tasks.id, s.one.id));
    await s.db.update(tasks).set({ body: 'Body here' }).where(eq(tasks.id, s.two.id));
    const a = await s.merge(first, { label: 'marat-mac' });
    const made = await taskFor(s.app.ctx, a.id);
    expect(made).not.toBeNull();
    await s.db.execute(sql`UPDATE net.merges SET task_id = ${made} WHERE id = ${a.id}`);
    const wakesBefore = (await s.db.select().from(pendingWakes).where(and(eq(pendingWakes.agentId, s.orchestrator.id), eq(pendingWakes.taskId, made!)))).length + (await s.db.select().from(jobs).where(and(eq(jobs.agentId, s.orchestrator.id), eq(jobs.taskId, made!)))).length;
    const b = await s.merge(second, { label: 'office-mini' });
    expect(await taskFor(s.app.ctx, b.id)).toBe(made);
    const joined = await taskOf(s, made!);
    expect(joined.title).toBe('Bring back what marat-mac and office-mini did while apart');
    expect(joined.body).toContain('What marat-mac did');
    expect(joined.body).toContain('What office-mini did');
    expect(joined.body).toContain('title: here "Here", there "First there"');
    expect(joined.body).toContain('body: here "Body here", there "Second there"');
    expect(await s.db.select(idOnly(tasks)).from(tasks).where(eq(tasks.assigneeAgentId, s.orchestrator.id))).toHaveLength(1);
    /* He is woken on it again. */
    const wakesAfter = (await s.db.select().from(pendingWakes).where(and(eq(pendingWakes.agentId, s.orchestrator.id), eq(pendingWakes.taskId, made!)))).length + (await s.db.select().from(jobs).where(and(eq(jobs.agentId, s.orchestrator.id), eq(jobs.taskId, made!)))).length;
    expect(wakesAfter).toBeGreaterThan(wakesBefore);
  });

  it('makes no task for nothing', async () => {
    const s = await mergeApp();
    const fork = await s.fork();
    await s.task(fork.db, 3, 'Three');
    const { id } = await s.merge(fork);
    expect(await taskFor(s.app.ctx, id)).toBeNull();
    await s.app.ctx.merger.tick();
    expect(await rowsOf(s.db, sql`SELECT task_id, task_wanted FROM net.merges WHERE id = ${id}`)).toEqual([{ task_id: null, task_wanted: false }]);
  });

  it('waits for an orchestrator', async () => {
    const s = await mergeApp();
    const fork = await s.fork();
    await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, s.one.id));
    await s.db.update(tasks).set({ title: 'Here' }).where(eq(tasks.id, s.one.id));
    const { id } = await s.merge(fork);
    await s.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, s.orchestrator.id));
    await expect(taskFor(s.app.ctx, id)).rejects.toThrow(/switched off/);
    await s.app.ctx.merger.tick();
    expect(await rowsOf(s.db, sql`SELECT task_id, task_wanted FROM net.merges WHERE id = ${id}`)).toEqual([{ task_id: null, task_wanted: true }]);
    await s.db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, s.orchestrator.id));
    await s.app.ctx.merger.tick();
    expect((await rowsOf<{ task_id: string | null }>(s.db, sql`SELECT task_id FROM net.merges WHERE id = ${id}`))[0]!.task_id).not.toBeNull();
  });
});
