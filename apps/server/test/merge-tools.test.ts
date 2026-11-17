import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { departments, jobs, machineAccess, machines, people, sessions, tasks, turns } from '../src/db/schema.js';
import type { ConflictView } from '../src/modules/merge/picks.js';
import { listen, mcp, ownDatabases } from './helpers.js';
import { mergeApp, ORCHESTRATOR_TOKEN, rowsOf } from './merge-app-fixture.js';

/* Each test forks its database, which a shared one would not survive. */
ownDatabases();

type Result = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
const text = (res: Result) => res.content[0]!.text;
const listed = async (client: Client, args: Record<string, unknown> = {}) => JSON.parse(text(await call(client, 'merge_conflicts', args))) as { conflicts: ConflictView[]; more: boolean };

/* The app with its orchestrator's tools open. */
async function stand() {
  const s = await mergeApp();
  await listen(s.app);
  const tools = await mcp(s.app, ORCHESTRATOR_TOKEN);
  /* A title each side changed: the plain conflict of the orchestrator's. */
  const titles = async (fork: Awaited<ReturnType<typeof s.fork>>, id: string, there: string, here: string) => {
    await fork.db.update(tasks).set({ title: there }).where(eq(tasks.id, id));
    await s.db.update(tasks).set({ title: here }).where(eq(tasks.id, id));
  };
  const picked = () => rowsOf<{ id: string; tbl: string; picked: string | null; picked_by: string | null; value: Record<string, unknown> | null }>(s.db, sql`SELECT id, tbl, picked, picked_by, value FROM net.merge_conflicts ORDER BY tbl, created_at, id`);
  return { ...s, tools, titles, picked };
}

describe("the orchestrator's tools for what a merge could not prove", () => {
  it('lists conflicts with both values', async () => {
    const s = await stand();
    const fork = await s.fork();
    await s.titles(fork, s.one.id, 'There', 'Here');
    const { id } = await s.merge(fork, { label: 'marat-mac' });
    const { conflicts, more } = await listed(s.tools);
    expect(more).toBe(false);
    expect(conflicts).toEqual([{
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), merge: id, label: 'marat-mac', table: 'tasks', topic: 'work', what: 'task #1 "Here"', kind: 'differs', cols: ['title'],
      here: { title: '"Here"' }, there: { title: '"There"' }, at: expect.stringMatching(/^\d{4}-/), task: { id: s.one.id, number: 1, title: 'Here' }, whose: 'orchestrator', picked: null,
    }]);
    expect((await listed(s.tools, { settled: true })).conflicts).toEqual([]);
    expect(text(await call(s.tools, 'merge_pick', { ids: [conflicts[0]!.id], take: 'here' }))).toBe('Settled 1: kept here 1, took there 0.');
    expect((await listed(s.tools)).conflicts).toEqual([]);
    expect((await listed(s.tools, { settled: true })).conflicts).toMatchObject([{ id: conflicts[0]!.id, picked: 'here' }]);
    /* By merge and by table, a page at a time. */
    const more2 = await s.fork();
    await s.titles(more2, s.two.id, 'Two there', 'Two here');
    await more2.db.update(tasks).set({ body: 'There' }).where(eq(tasks.id, s.one.id));
    await s.db.update(tasks).set({ body: 'Here' }).where(eq(tasks.id, s.one.id));
    const second = await s.merge(more2);
    expect((await listed(s.tools, { merge: second.id })).conflicts).toHaveLength(2);
    expect((await listed(s.tools, { merge: id })).conflicts).toHaveLength(0);
    expect((await listed(s.tools, { table: 'teams' })).conflicts).toHaveLength(0);
    const first = await listed(s.tools, { limit: 1 });
    expect([first.conflicts.length, first.more]).toEqual([1, true]);
    const next = await listed(s.tools, { limit: 1, after: first.conflicts[0]!.id });
    expect([next.conflicts.length, next.more, next.conflicts[0]!.id === first.conflicts[0]!.id]).toEqual([1, false, false]);
  });

  it("keeps secrets from the orchestrator and lists only its own conflicts, while it settles the CEO's it names", async () => {
    const s = await stand();
    const [maria] = await s.db.insert(people).values({ ...s.on, name: 'Maria', email: 'maria@acme.test', status: 'active', scopeKind: 'company' }).returning();
    await s.db.insert(sessions).values({ tokenHash: 'a'.repeat(64), personId: maria!.id, expiresAt: new Date('2026-12-01T00:00:00Z') });
    const [job] = await s.db.insert(jobs).values({ ...s.on, subscriptionId: s.plan.id, agentId: s.ana.id, prompt: 'Work', timeoutMs: 60_000, status: 'done', finishedAt: new Date(), toolTokenHash: hashToken('one') }).returning();
    const fork = await s.fork();
    await fork.db.update(people).set({ name: 'Maria There' }).where(eq(people.id, maria!.id));
    await s.db.update(people).set({ name: 'Maria Here' }).where(eq(people.id, maria!.id));
    await fork.db.update(sessions).set({ expiresAt: new Date('2026-12-02T00:00:00Z') }).where(eq(sessions.personId, maria!.id));
    await s.db.update(sessions).set({ expiresAt: new Date('2026-12-03T00:00:00Z') }).where(eq(sessions.personId, maria!.id));
    await fork.db.update(jobs).set({ toolTokenHash: hashToken('there') }).where(eq(jobs.id, job!.id));
    await s.db.update(jobs).set({ toolTokenHash: hashToken('here') }).where(eq(jobs.id, job!.id));
    const { id } = await s.merge(fork);
    const all = await s.conflicts(id);
    expect(all.map(conflict => conflict.tbl)).toEqual(['jobs', 'people', 'sessions']);
    const { conflicts } = await listed(s.tools);
    expect(conflicts.map(conflict => conflict.table)).toEqual(['jobs']);
    expect(conflicts[0]).toMatchObject({ cols: ['tool_token_hash'], here: { tool_token_hash: '(hidden)' }, there: { tool_token_hash: '(hidden)' }, whose: 'orchestrator' });
    expect(JSON.stringify(conflicts)).not.toContain(hashToken('there'));
    for (const table of ['people', 'sessions']) expect((await listed(s.tools, { table })).conflicts).toEqual([]);
    const person = all.find(conflict => conflict.tbl === 'people')!;
    /* Named, one of the CEO's he settles too. */
    expect(text(await call(s.tools, 'merge_pick', { ids: [person.id], take: 'there' }))).toBe('Settled 1: kept here 0, took there 1.');
    /* In bulk he settles his own alone, and is not told of the others. */
    expect(text(await call(s.tools, 'merge_pick', { merge: id, take: 'here' }))).toBe('Settled 1: kept here 1, took there 0.');
    expect((await s.picked()).map(row => [row.tbl, row.picked])).toEqual([['jobs', 'here'], ['people', 'there'], ['sessions', null]]);
    expect((await s.db.select().from(people).where(eq(people.id, maria!.id)))[0]!.name).toBe('Maria There');
  });

  it('settles one or many', async () => {
    const s = await stand();
    const extra = await s.task(s.db, 3, 'Three');
    const [first, second] = [await s.fork(), await s.fork()];
    await s.titles(first, s.one.id, 'One there', 'One here');
    await first.db.update(tasks).set({ title: 'Three there' }).where(eq(tasks.id, extra.id));
    await second.db.update(tasks).set({ title: 'Two there' }).where(eq(tasks.id, s.two.id));
    await s.db.update(tasks).set({ title: 'Two here' }).where(eq(tasks.id, s.two.id));
    await s.db.update(tasks).set({ title: 'Three here' }).where(eq(tasks.id, extra.id));
    const [a, b] = [await s.merge(first), await s.merge(second)];
    const of = async (merge: string) => (await listed(s.tools, { merge })).conflicts;
    /* Nothing is settled without saying which. */
    const none = await call(s.tools, 'merge_pick', { take: 'here' });
    expect([none.isError, text(none)]).toEqual([true, 'Name the conflicts: ids, a merge, a table or a time range.']);
    /* One, by its id: the source's title. */
    const one = (await of(a.id)).find(conflict => conflict.task?.id === s.one.id)!;
    expect(text(await call(s.tools, 'merge_pick', { ids: [one.id], take: 'there' }))).toBe('Settled 1: kept here 0, took there 1.\nTasks changed: #1. Tell their holders.');
    expect(await s.titleOf(s.one.id)).toBe('One there');
    /* Settled once. */
    expect(text(await call(s.tools, 'merge_pick', { ids: [one.id], take: 'here' }))).toBe(`Settled 0: kept here 0, took there 0.\nRefused 1: ${one.id}: Already settled.`);
    /* A value of his own, for one conflict and its columns alone. */
    const three = (await of(a.id))[0]!;
    const wide = await call(s.tools, 'merge_pick', { merge: a.id, take: 'value', value: { title: 'Both' } });
    expect([wide.isError, text(wide)]).toEqual([true, 'A value of your own settles one conflict: name it by its id.']);
    expect(text(await call(s.tools, 'merge_pick', { ids: [three.id], take: 'value', value: { body: 'x' } }))).toContain('Refused 1');
    expect(text(await call(s.tools, 'merge_pick', { ids: [three.id], take: 'value', value: { title: 'Both' } }))).toBe('Settled 1: kept here 0, took there 1.\nTasks changed: #3. Tell their holders.');
    expect(await s.titleOf(extra.id)).toBe('Both');
    /* Every open one of a merge: only that source's. */
    expect(text(await call(s.tools, 'merge_pick', { merge: b.id, take: 'here' }))).toBe('Settled 1: kept here 1, took there 0.');
    expect(await s.titleOf(s.two.id)).toBe('Two here');
    expect((await s.picked()).map(row => [row.picked, row.picked_by, row.value])).toEqual(expect.arrayContaining([
      ['there', `agent:${s.orchestrator.id}`, null], ['value', `agent:${s.orchestrator.id}`, { title: 'Both' }], ['here', `agent:${s.orchestrator.id}`, null],
    ]));
    /* By table, and by when the source changed the row. */
    const third = await s.fork();
    await s.titles(third, s.one.id, 'Again there', 'Again here');
    await third.db.update(departments).set({ about: 'There' }).where(eq(departments.id, s.dev.id));
    await s.db.update(departments).set({ about: 'Here' }).where(eq(departments.id, s.dev.id));
    const c = await s.merge(third);
    expect(text(await call(s.tools, 'merge_pick', { table: 'tasks', take: 'here' }))).toBe('Settled 1: kept here 1, took there 0.');
    const left = await of(c.id);
    expect(left.map(conflict => conflict.table)).toEqual(['departments']);
    const at = new Date(left[0]!.at!).getTime();
    expect(text(await call(s.tools, 'merge_pick', { from: new Date(at + 60_000).toISOString(), take: 'here' }))).toBe('Settled 0: kept here 0, took there 0.');
    expect(text(await call(s.tools, 'merge_pick', { from: new Date(at - 60_000).toISOString(), to: new Date(at + 60_000).toISOString(), take: 'there' }))).toBe('Settled 1: kept here 0, took there 1.');
    expect((await s.db.select().from(departments).where(eq(departments.id, s.dev.id)))[0]!.about).toBe('There');
  });

  it('writes a value of his own wherever the CEO could', async () => {
    const s = await stand();
    const fork = await s.fork();
    await fork.db.update(tasks).set({ urgent: true, title: 'There' }).where(eq(tasks.id, s.one.id));
    await s.db.update(tasks).set({ urgent: false, title: 'Here', small: true }).where(eq(tasks.id, s.one.id));
    await fork.db.update(departments).set({ repoUrl: 'https://github.com/acme/there' }).where(eq(departments.id, s.dev.id));
    await s.db.update(departments).set({ repoUrl: 'https://github.com/acme/here' }).where(eq(departments.id, s.dev.id));
    const { id } = await s.merge(fork);
    const { conflicts } = await listed(s.tools, { merge: id });
    const repo = conflicts.find(conflict => conflict.table === 'departments')!;
    /* Where a department pushes changes only through the CEO's routes, and the orchestrator acts as the CEO. */
    expect(text(await call(s.tools, 'merge_pick', { ids: [repo.id], take: 'value', value: { repo_url: 'https://github.com/acme/both' } }))).toBe('Settled 1: kept here 0, took there 1.');
    expect((await s.db.select().from(departments).where(eq(departments.id, s.dev.id)))[0]!.repoUrl).toBe('https://github.com/acme/both');
  });

  it('runs what the merge tried', async () => {
    const s = await stand();
    const [parent] = await s.db.insert(departments).values({ ...s.on, name: 'Parent', roleCode: 'PAR' }).returning();
    const fork = await s.fork();
    /* A number the leader gave to another task meanwhile. */
    await fork.db.update(tasks).set({ number: 7 }).where(eq(tasks.id, s.one.id));
    const seven = await s.task(s.db, 7, 'Seven here');
    /* A department the leader removed, which the source changed and put a turn with its task under, released there. */
    await s.db.delete(departments).where(eq(departments.id, parent!.id));
    await fork.db.update(departments).set({ about: 'Still used there' }).where(eq(departments.id, parent!.id));
    const [turn] = await fork.db.insert(turns).values({ ...s.on, departmentId: s.dev.id, number: 2, goal: 'Later', status: 'closed', closedAt: new Date() }).returning();
    const inTurn = await s.task(fork.db, 3, 'Of the later turn', { departmentId: parent!.id, turnId: turn!.id });
    await fork.db.update(turns).set({ taskId: inTurn.id }).where(eq(turns.id, turn!.id));
    const { id } = await s.merge(fork);
    const all = await s.conflicts(id);
    expect(all.map(conflict => [conflict.tbl, conflict.kind, conflict.op]).sort()).toEqual([['departments', 'changed_removed', 'insert'], ['tasks', 'refused', 'insert'], ['tasks', 'refused', 'update'], ['turns', 'refused', 'insert']]);
    const by = (table: string, op: string) => all.find(conflict => conflict.tbl === table && conflict.op === op)!;
    /* The number is free again: the change the merge could not make goes through. */
    const number = by('tasks', 'update');
    expect(text(await call(s.tools, 'merge_pick', { ids: [number.id], take: 'there' }))).toContain('Refused 1');
    await s.db.update(tasks).set({ number: 8 }).where(eq(tasks.id, seven.id));
    expect(text(await call(s.tools, 'merge_pick', { ids: [number.id], take: 'there' }))).toBe('Settled 1: kept here 0, took there 1.\nTasks changed: #7. Tell their holders.');
    expect((await s.db.select().from(tasks).where(eq(tasks.id, s.one.id)))[0]!.number).toBe(7);
    /* The turn and its task point at each other and at a department that is not here: neither comes back alone. */
    const refused = text(await call(s.tools, 'merge_pick', { ids: [by('turns', 'insert').id], take: 'there' }));
    expect(refused).toContain('Its departments row is not here.');
    expect(await s.db.select().from(turns).where(eq(turns.id, turn!.id))).toEqual([]);
    /* With the department back, the two come back together in one step, and both are settled. */
    expect(text(await call(s.tools, 'merge_pick', { ids: [by('departments', 'insert').id], take: 'there' }))).toBe('Settled 1: kept here 0, took there 1.');
    expect(text(await call(s.tools, 'merge_pick', { ids: [by('turns', 'insert').id], take: 'there' }))).toBe('Settled 2: kept here 0, took there 2.\nTasks changed: #3. Tell their holders.');
    expect((await s.db.select().from(turns).where(eq(turns.id, turn!.id)))[0]).toMatchObject({ status: 'closed', taskId: inTurn.id });
    expect((await s.db.select().from(tasks).where(eq(tasks.id, inTurn.id)))[0]).toMatchObject({ turnId: turn!.id, departmentId: parent!.id });
    expect((await s.picked()).every(row => row.picked === 'there')).toBe(true);
  });

  it('refuses a pick the leader cannot take', async () => {
    const s = await stand();
    const [gone] = await s.db.insert(departments).values({ ...s.on, name: 'Gone', roleCode: 'GON' }).returning();
    const lost = await s.task(s.db, 3, 'Lost', { departmentId: gone!.id, turnId: null });
    const fork = await s.fork();
    await fork.db.update(tasks).set({ title: 'Changed there' }).where(eq(tasks.id, lost.id));
    await s.db.delete(tasks).where(eq(tasks.id, lost.id));
    await s.db.delete(departments).where(eq(departments.id, gone!.id));
    const { id } = await s.merge(fork);
    const [conflict] = await s.conflicts(id);
    expect(conflict).toMatchObject({ tbl: 'tasks', kind: 'changed_removed', op: 'insert' });
    expect(text(await call(s.tools, 'merge_pick', { ids: [conflict!.id], take: 'there' }))).toBe(`Settled 0: kept here 0, took there 0.\nRefused 1: ${conflict!.id}: Its departments row is not here.`);
    expect(await s.db.select().from(tasks).where(eq(tasks.id, lost.id))).toEqual([]);
    expect((await s.picked())[0]!.picked).toBeNull();
    /* Keeping what is here always goes. */
    expect(text(await call(s.tools, 'merge_pick', { ids: [conflict!.id], take: 'here' }))).toBe('Settled 1: kept here 1, took there 0.');
  });

  it('never opens computer access', async () => {
    const s = await stand();
    const [machine] = await s.db.insert(machines).values({ ...s.on, personId: s.owner.id, machineKey: 'm1', hostname: 'marat-mac' }).returning();
    await s.db.insert(machineAccess).values({ ...s.on, machineId: machine!.id });
    const fork = await s.fork();
    await fork.db.update(machineAccess).set({ until: new Date(Date.now() + 3_600_000), openedBy: s.owner.id, openedAt: new Date(), grant: { payload: 'p', signature: 's' } }).where(eq(machineAccess.machineId, machine!.id));
    const { id } = await s.merge(fork);
    const [conflict] = await s.conflicts(id);
    expect(conflict).toMatchObject({ tbl: 'machine_access', kind: 'differs' });
    for (const how of [{ take: 'there' }, { take: 'value', value: { until: new Date(Date.now() + 3_600_000).toISOString() } }]) {
      expect(text(await call(s.tools, 'merge_pick', { ids: [conflict!.id], ...how }))).toBe(`Settled 0: kept here 0, took there 0.\nRefused 1: ${conflict!.id}: Only the machine's owner opens computer access, on its card.`);
    }
    expect((await s.db.select().from(machineAccess))[0]).toMatchObject({ until: null, grant: null });
  });

  it("is the orchestrator's alone", async () => {
    const s = await stand();
    const token = 'tool-token-worker-0123456789abcdef01';
    await s.db.insert(jobs).values({ ...s.on, subscriptionId: s.plan.id, agentId: s.ana.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900_000, status: 'running', toolTokenHash: hashToken(token) });
    const names = async (client: Client) => (await client.listTools()).tools.map(tool => tool.name);
    const mine = await names(s.tools);
    expect([mine.includes('merge_conflicts'), mine.includes('merge_pick')]).toEqual([true, true]);
    const theirs = await names(await mcp(s.app, token));
    expect([theirs.includes('merge_conflicts'), theirs.includes('merge_pick')]).toEqual([false, false]);
  });
});
