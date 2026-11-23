import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, attachments, departments, jobs, pendingWakes, taskEvents, tasks, teams } from '../src/db/schema.js';
import { routeOf } from '../src/modules/tasks/echelons-store.js';
import { loadTask, report, submit, verdict } from '../src/modules/tasks/engine.js';
import { setPaused } from '../src/modules/tasks/pause.js';
import { registerSettleTools } from '../src/modules/tasks/settle.js';
import type { Grant } from '../src/modules/templates/load.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { listen, mcp } from './helpers.js';
import { prepareSharedDatabase } from './helpers-db.js';

await prepareSharedDatabase();

/* The task watchdog of a new company is the employee its template hires. What it may close without anyone's word is what
   the server itself proves: the commit of the task is in main or a release, the result is recorded where a colleague finds
   it, or every subtask is closed. Anything else stays open, and paused work is never touched (#1942). */

const MAIN = 'c'.repeat(40);
const TURN = 'd'.repeat(40);
const TAG = 'e'.repeat(40);
const AT = new Date('2026-11-23T12:00:00.000Z');
const WHY = 'The release took its commit.';

/* branch is where the repository says the task's own branch, task-<n>, is; own is false where the commit a hand-in names does
   not hold the base it names. */
type Holds = { main?: string[]; turn?: string[]; tag?: string[]; unreadable?: boolean; branch?: string | null; own?: boolean; mainDown?: boolean; tagsDown?: boolean };

async function watched() {
  const f = await fixture();
  await listen(f.app);
  /* A new company's Operations, with the watchdog hired from its template: the skills are the ones the role ships with. */
  const [ops] = await f.db.insert(departments).values({ companyId: f.task.companyId, templateKey: 'operations', roleCode: 'OPS', position: 9 }).returning();
  const [watchdog] = await f.db.insert(agents).values({
    companyId: f.task.companyId, departmentId: ops!.id, name: 'Walt', kind: 'worker', roleKey: 'OPS-WATCH', subscriptionId: f.claude.id, model: 'claude-opus-5-5',
    skills: f.app.ctx.templates.roles.get('OPS-WATCH')!.skills.filter(s => s.on).map(s => s.id),
  }).returning();
  /* What the repository says: which commits main, the open turn and the release tag hold. */
  const remote = (holds: Holds) => {
    f.ctx.readCommit = async (_repo, want) => {
      if ('branch' in want) return holds.mainDown && want.branch === 'main' ? { problem: 'GitHub is down.' } : { branch: want.branch, commitSha: want.branch === 'main' ? MAIN : TURN };
      return holds.branch === null ? { problem: 'No such branch.', missing: true } : { branch: `task-${want.task}`, commitSha: holds.branch ?? HEAD };
    };
    f.ctx.readTags = async () => {
      if (holds.tagsDown) throw new Error('GitHub is down');
      return { tags: { 'v0.41.0': TAG } };
    };
    f.ctx.readMerged = async (_repo, { base, head }) => {
      if (holds.unreadable) throw new Error('GitHub is down');
      const lines: Record<string, string[]> = { [MAIN]: holds.main ?? [], [TURN]: holds.turn ?? [], [TAG]: holds.tag ?? [], [HEAD]: holds.own === false ? [] : [BASE] };
      return (lines[base] ?? []).includes(head);
    };
  };
  const tools = async (agentId: string) => {
    const token = `settle-${agentId}`;
    await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId, subscriptionId: f.claude.id, kind: 'conversation', prompt: 'Round.', status: 'running', startedAt: AT, timeoutMs: 60_000, toolTokenHash: hashToken(token) });
    const client = await mcp(f.app, token);
    return {
      names: async () => (await client.listTools()).tools.map(t => t.name),
      call: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] },
    };
  };
  const shipped = async (taskId = f.task.id) => (await submit(f.ctx, f.author.id, taskId, { summary: 'Changed the totals.', evidence: 'Totals tests pass.', review: { baseCommit: BASE } })).task;
  const log = (id: string) => f.db.select().from(taskEvents).where(eq(taskEvents.taskId, id)).orderBy(asc(taskEvents.id));
  return { ...f, watchdog: watchdog!, remote, tools, shipped, log, read: (id: string) => loadTask(f.db, id) };
}

describe('the commit of a task against the releases', () => {
  it('says a commit that main holds is released', async () => {
    const f = await watched();
    const task = await f.shipped();
    f.remote({ main: [HEAD] });
    const said = JSON.parse((await (await f.tools(f.watchdog.id)).call('task_released', { task: task.number })).content[0]!.text) as Record<string, unknown>;
    expect(said).toMatchObject({ task: task.number, commit: HEAD, inMain: true, released: true });
  });

  it('says a commit that only a turn branch holds is not released', async () => {
    const f = await watched();
    const task = await f.shipped();
    f.remote({ turn: [HEAD] });
    const said = JSON.parse((await (await f.tools(f.watchdog.id)).call('task_released', { task: task.number })).content[0]!.text) as Record<string, unknown>;
    expect(said).toMatchObject({ commit: HEAD, inMain: false, release: null, released: false });
  });

  it('says a commit that a release tag holds is released, and names the tag', async () => {
    const f = await watched();
    const task = await f.shipped();
    f.remote({ tag: [HEAD] });
    const said = JSON.parse((await (await f.tools(f.watchdog.id)).call('task_released', { task: task.number })).content[0]!.text) as Record<string, unknown>;
    expect(said).toMatchObject({ inMain: false, release: 'v0.41.0', released: true });
  });

  it('does not call a commit released when the repository cannot be read', async () => {
    const f = await watched();
    const task = await f.shipped();
    f.remote({ main: [HEAD], unreadable: true });
    const said = JSON.parse((await (await f.tools(f.watchdog.id)).call('task_released', { task: task.number })).content[0]!.text) as Record<string, unknown>;
    expect(said).toMatchObject({ released: false });
  });

  it('does not take the head of the task\'s branch for its work when no hand-in names a commit', async () => {
    const f = await watched();
    const watchdog = await f.tools(f.watchdog.id);
    /* A branch pushed at main before its first commit, or one that only took main in, holds nothing of the task's own. */
    for (const branch of [MAIN, HEAD]) {
      f.remote({ main: [HEAD], branch });
      const said = JSON.parse((await watchdog.call('task_released', { task: f.task.number })).content[0]!.text) as { why: string } & Record<string, unknown>;
      expect(said).toMatchObject({ commit: branch, source: 'branch', released: false });
      expect(said.why).toMatch(/branch/);
      const closed = await watchdog.call('settle_task', { task: f.task.number, why: WHY });
      expect(closed.isError).toBe(true);
      expect((await f.read(f.task.id)).status).not.toBe('done');
    }
  });

  it('does not take a hand-in whose commit is its own base for work, though main holds it', async () => {
    const f = await watched();
    f.atCommit(BASE);
    const task = await f.shipped();
    f.remote({ main: [BASE] });
    const watchdog = await f.tools(f.watchdog.id);
    const said = JSON.parse((await watchdog.call('task_released', { task: task.number })).content[0]!.text) as { why: string } & Record<string, unknown>;
    expect(said).toMatchObject({ commit: BASE, source: 'record', released: false });
    expect(said.why).toMatch(/base/);
    expect((await watchdog.call('settle_task', { task: task.number, why: WHY })).isError).toBe(true);
    expect((await f.read(task.id)).status).not.toBe('done');
  });

  it('does not take a hand-in whose commit does not hold the base it names for work', async () => {
    const f = await watched();
    const task = await f.shipped();
    f.remote({ main: [HEAD], own: false });
    const watchdog = await f.tools(f.watchdog.id);
    const said = JSON.parse((await watchdog.call('task_released', { task: task.number })).content[0]!.text) as { why: string } & Record<string, unknown>;
    expect(said).toMatchObject({ commit: HEAD, released: false });
    expect(said.why).toMatch(/base/);
    expect((await watchdog.call('settle_task', { task: task.number, why: WHY })).isError).toBe(true);
    expect((await f.read(task.id)).status).not.toBe('done');
  });

  it('proves nothing when main cannot be read, or the release tags cannot, or the task has no branch and no hand-in', async () => {
    const f = await watched();
    const task = await f.shipped();
    const watchdog = await f.tools(f.watchdog.id);
    const said = async (ref: number) => JSON.parse((await watchdog.call('task_released', { task: ref })).content[0]!.text) as { why: string } & Record<string, unknown>;
    f.remote({ main: [HEAD], mainDown: true });
    expect(await said(task.number)).toMatchObject({ commit: HEAD, released: false, why: expect.stringContaining('could not be read') as unknown });
    f.remote({ turn: [HEAD], tagsDown: true });
    expect(await said(task.number)).toMatchObject({ commit: HEAD, inMain: false, release: null, released: false });
    f.remote({ branch: null });
    const bare = (await f.create({ title: 'Nothing yet' })).task;
    expect(await said(bare.number)).toMatchObject({ commit: null, source: null, released: false, why: expect.stringContaining('no branch of its own') as unknown });
  });

  it('counts the commit turnkey work joined a turn with, when its start is behind it', async () => {
    const f = await watched();
    await f.db.insert(taskEvents).values({ companyId: f.task.companyId, taskId: f.task.id, kind: 'report', agentId: f.author.id, text: 'Done.', data: { done: true, integration: { branch: 'turn-43', commit: HEAD, start: BASE } } });
    f.remote({ main: [HEAD] });
    const said = JSON.parse((await (await f.tools(f.watchdog.id)).call('task_released', { task: f.task.number })).content[0]!.text) as Record<string, unknown>;
    expect(said).toMatchObject({ commit: HEAD, source: 'record', inMain: true, released: true });
  });
});

describe('settle_task closes the clear cases, in any department', () => {
  it('closes work whose commit is in main, with its reason in the log and a notice to the head of its department', async () => {
    const f = await watched();
    const task = await f.shipped();
    f.remote({ main: [HEAD] });
    const said = await (await f.tools(f.watchdog.id)).call('settle_task', { task: task.number, why: WHY });
    expect(said.isError).toBeFalsy();
    expect(await f.read(task.id)).toMatchObject({ status: 'done', assigneeAgentId: null });
    expect((await f.log(task.id)).at(-1)).toMatchObject({ kind: 'done', agentId: f.watchdog.id, text: WHY, data: expect.objectContaining({ settled: expect.objectContaining({ rule: 'code' }) }) as unknown });
    /* The head of the task's department, which is not the watchdog's own, is told. */
    const pending = await f.db.select().from(pendingWakes).where(eq(pendingWakes.taskId, task.id));
    expect(pending.map(w => w.agentId)).toContain(f.head.id);
  });

  it('leaves work open whose commit is on a turn branch but not in main or a release', async () => {
    const f = await watched();
    const task = await f.shipped();
    f.remote({ turn: [HEAD] });
    const said = await (await f.tools(f.watchdog.id)).call('settle_task', { task: task.number, why: WHY });
    expect(said.isError).toBe(true);
    expect(said.content[0]!.text).toMatch(/unfinished work/);
    expect((await f.read(task.id)).status).not.toBe('done');
    expect((await f.log(task.id)).some(e => e.kind === 'done')).toBe(false);
  });

  it('closes a document whose result is recorded, and leaves one whose result is not', async () => {
    const f = await watched();
    const recorded = (await f.create({ resultKind: 'document', paths: undefined, testsAgentId: undefined, securityAgentId: undefined, title: 'Handbook' })).task;
    const unrecorded = (await f.create({ resultKind: 'document', paths: undefined, testsAgentId: undefined, securityAgentId: undefined, title: 'Notes' })).task;
    await submit(f.ctx, f.author.id, recorded.id, { summary: 'Wrote the handbook.', evidence: 'Read it through.', recorded: { path: 'docs/handbook.md' } });
    await f.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, unrecorded.id));
    const watchdog = await f.tools(f.watchdog.id);
    /* Recorded, but its checker has not passed it: the check is never skipped by closing the record. */
    const early = await watchdog.call('settle_task', { task: recorded.number, why: 'Its handbook is in docs/handbook.md.' });
    expect(early.isError).toBe(true);
    expect(early.content[0]!.text).toMatch(/checked|check/i);
    expect((await f.read(recorded.id)).status).not.toBe('done');
    const route = await routeOf(f.db, await f.read(recorded.id));
    await verdict(f.ctx, f.reviewer.id, recorded.id, { pass: true, comment: 'Checked.', candidateId: route.state.candidateId! });
    expect((await watchdog.call('settle_task', { task: recorded.number, why: 'Its handbook is in docs/handbook.md.' })).isError).toBeFalsy();
    expect((await f.read(recorded.id)).status).toBe('done');
    expect((await watchdog.call('settle_task', { task: unrecorded.number, why: 'Looks done.' })).isError).toBe(true);
    expect((await f.read(unrecorded.id)).status).not.toBe('done');
  });

  it('tells the head the close is the server\'s proof, and lets a parent close over a document it settled', async () => {
    const f = await watched();
    const group = (await f.create({ title: 'Handbook set', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    const doc = (await f.create({ resultKind: 'document', paths: undefined, testsAgentId: undefined, securityAgentId: undefined, title: 'Handbook', parentId: group.id })).task;
    await submit(f.ctx, f.author.id, doc.id, { summary: 'Wrote the handbook.', evidence: 'Read it through.', recorded: { path: 'docs/handbook.md' } });
    const route = await routeOf(f.db, await f.read(doc.id));
    await verdict(f.ctx, f.reviewer.id, doc.id, { pass: true, comment: 'Checked.', candidateId: route.state.candidateId! });
    expect((await (await f.tools(f.watchdog.id)).call('settle_task', { task: doc.number, why: 'Its handbook is in docs/handbook.md.' })).isError).toBeFalsy();
    const told = await f.db.select().from(pendingWakes).where(eq(pendingWakes.taskId, doc.id));
    expect(told.map(w => w.text).join('\n')).toMatch(/server's own proof[\s\S]*not by an accepted result/);
    /* The settled document has no accepted result of its route, and the parent closes over it as a child closed without one. */
    const closed = await report(f.ctx, f.head.id, group.id, { done: true, summary: 'The handbook is in.', recorded: { path: 'reports/handbook.md' } });
    expect(closed.task.status).toBe('done');
    expect((await f.log(group.id)).find(e => 'acceptedChildren' in e.data)?.data).toMatchObject({ acceptedChildren: [{ taskId: doc.id, unaccepted: { status: 'done' } }] });
  });

  it('closes a document recorded as a file on the task while the file is there, and not once it is gone', async () => {
    const f = await watched();
    const make = async (title: string) => {
      const doc = (await f.create({ resultKind: 'document', paths: undefined, testsAgentId: undefined, securityAgentId: undefined, title })).task;
      await f.db.insert(attachments).values({ companyId: doc.companyId, taskId: doc.id, agentId: f.author.id, name: 'handbook.md', mediaType: 'text/markdown', bytes: Buffer.from('# Handbook'), size: 10 });
      await submit(f.ctx, f.author.id, doc.id, { summary: 'Wrote the handbook.', evidence: 'Read it through.', recorded: { file: 'handbook.md' } });
      const route = await routeOf(f.db, await f.read(doc.id));
      await verdict(f.ctx, f.reviewer.id, doc.id, { pass: true, comment: 'Checked.', candidateId: route.state.candidateId! });
      return doc;
    };
    const kept = await make('Kept handbook');
    const lost = await make('Lost handbook');
    await f.db.delete(attachments).where(eq(attachments.taskId, lost.id));
    const watchdog = await f.tools(f.watchdog.id);
    const refused = await watchdog.call('settle_task', { task: lost.number, why: WHY });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/not recorded/);
    expect((await f.read(lost.id)).status).not.toBe('done');
    expect((await watchdog.call('settle_task', { task: kept.number, why: WHY })).isError).toBeFalsy();
    expect((await f.log(kept.id)).at(-1)?.data).toMatchObject({ settled: { rule: 'recorded', evidence: { recorded: { file: 'handbook.md' } } } });
  });

  it('closes a parent with no work left and leaves one with work under it', async () => {
    const f = await watched();
    const group = (await f.create({ title: 'Totals', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    const done = (await f.create({ title: 'Totals, report', parentId: group.id })).task;
    const open = (await f.create({ title: 'Totals, export', parentId: group.id })).task;
    await f.db.update(tasks).set({ status: 'done', closedAt: AT }).where(eq(tasks.id, done.id));
    const watchdog = await f.tools(f.watchdog.id);
    expect((await watchdog.call('settle_task', { task: group.number, why: 'All subtasks are closed.' })).isError).toBe(true);
    expect((await f.read(group.id)).status).not.toBe('done');
    await f.db.update(tasks).set({ status: 'cancelled', closedAt: AT }).where(eq(tasks.id, open.id));
    expect((await watchdog.call('settle_task', { task: group.number, why: 'All subtasks are closed.' })).isError).toBeFalsy();
    expect((await f.read(group.id)).status).toBe('done');
  });

  it('never closes paused work, even when its commit is released, and says to ask the head', async () => {
    const f = await watched();
    const task = await f.shipped();
    await setPaused(f.ctx, { agentId: f.head.id }, task.id, true, 'Hold the totals.');
    f.remote({ main: [HEAD] });
    const said = await (await f.tools(f.watchdog.id)).call('settle_task', { task: task.number, why: WHY });
    expect(said.isError).toBe(true);
    expect(said.content[0]!.text).toMatch(/paused/i);
    expect(said.content[0]!.text).toMatch(/head/i);
    expect(await f.read(task.id)).toMatchObject({ status: expect.not.stringMatching(/^done$/) as unknown });
  });

  it('closes nothing without a reason, and nothing a person\'s own assistant holds', async () => {
    const f = await watched();
    const task = await f.shipped();
    f.remote({ main: [HEAD] });
    const watchdog = await f.tools(f.watchdog.id);
    const blank = await watchdog.call('settle_task', { task: task.number, why: '  ' });
    expect(blank.isError).toBe(true);
    expect(blank.content[0]!.text).toMatch(/why/);
    const [assistant] = await f.db.insert(agents).values({ companyId: f.task.companyId, name: 'Mine', kind: 'assistant', roleKey: null, subscriptionId: f.claude.id, model: '', skills: [] }).returning();
    await f.db.update(tasks).set({ assigneeAgentId: assistant!.id }).where(eq(tasks.id, task.id));
    const refused = await watchdog.call('settle_task', { task: task.number, why: WHY });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/assistant/);
    expect((await f.read(task.id)).status).not.toBe('done');
    /* Nor does the read tell where a person's own work stands. */
    const read = await watchdog.call('task_released', { task: task.number });
    expect(read.isError).toBe(true);
    expect(read.content[0]!.text).toMatch(/assistant/);
    expect(read.content[0]!.text).not.toContain(HEAD);
  });

  it('gives the two tools to the watchdog the template hires, and to nobody who holds none of its skills', async () => {
    const f = await watched();
    expect(await (await f.tools(f.watchdog.id)).names()).toEqual(expect.arrayContaining(['task_released', 'settle_task']));
    for (const agent of [f.head, f.author, f.reviewer]) {
      const names = await (await f.tools(agent.id)).names();
      expect(names).not.toContain('task_released');
      expect(names).not.toContain('settle_task');
    }
  });
});

describe('who is given the two tools', () => {
  it('registers them for a skill that carries settle, not for any other skill, and not for the orchestrator', async () => {
    const f = await watched();
    const registered = (kind: 'worker' | 'orchestrator', grants: string[]) => {
      const names: string[] = [];
      const server = { registerTool: (name: string) => { names.push(name); } } as unknown as McpServer;
      registerSettleTools(server, f.ctx, { id: 'job', companyId: f.task.companyId, agentId: f.watchdog.id, agentKind: kind, departmentId: null }, new Set(grants as Grant[]));
      return names;
    };
    expect(registered('worker', ['settle'])).toEqual(['task_released', 'settle_task']);
    expect(registered('worker', ['tracker'])).toEqual([]);
    /* The orchestrator holds every grant, yet closes with close_task: settling is the watchdog's. */
    expect(registered('orchestrator', ['agents', 'tracker', 'settle'])).toEqual([]);
  });
});

describe('a hand-in of work that is not code says where its result is recorded', () => {
  it('refuses a coordination report that names no place, and takes one that names a path or an attached file', async () => {
    const f = await watched();
    const group = async (title: string) => (await f.create({ title, assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    const first = await group('Report one');
    await expect(report(f.ctx, f.head.id, first.id, { done: true, summary: 'All parts are in.' })).rejects.toMatchObject({ status: 400, reason: 'task_invalid', message: expect.stringContaining('recorded') as unknown });
    expect((await f.read(first.id)).status).not.toBe('done');
    expect((await report(f.ctx, f.head.id, first.id, { done: true, summary: 'All parts are in.', recorded: { path: 'reports/totals.md' } })).task.status).toBe('done');
    const second = await group('Report two');
    await expect(report(f.ctx, f.head.id, second.id, { done: true, summary: 'All parts are in.', recorded: { file: 'totals.md' } })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('totals.md') as unknown });
    await f.db.insert(attachments).values({ companyId: f.task.companyId, taskId: second.id, agentId: f.head.id, name: 'totals.md', mediaType: 'text/markdown', bytes: Buffer.from('# Totals'), size: 8 });
    expect((await report(f.ctx, f.head.id, second.id, { done: true, summary: 'All parts are in.', recorded: { file: 'totals.md' } })).task.status).toBe('done');
    expect((await f.log(second.id)).find(e => e.kind === 'report' && 'recorded' in e.data)?.data).toMatchObject({ recorded: { file: 'totals.md' } });
  });

  it('refuses a path that leaves the repository, and a path where the department keeps none', async () => {
    const f = await watched();
    const group = (await f.create({ title: 'Report three', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    for (const path of ['../secrets.md', '/etc/passwd', 'a\\b.md', 'docs/../../x.md']) {
      await expect(report(f.ctx, f.head.id, group.id, { done: true, summary: 'Done.', recorded: { path } })).rejects.toMatchObject({ status: 400 });
    }
    expect((await f.read(group.id)).status).not.toBe('done');
  });

  it('refuses a document hand-in that names no place', async () => {
    const f = await watched();
    const doc = (await f.create({ resultKind: 'document', paths: undefined, testsAgentId: undefined, securityAgentId: undefined, title: 'Handbook' })).task;
    await expect(submit(f.ctx, f.author.id, doc.id, { summary: 'Wrote it.', evidence: 'Read it.' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('recorded') as unknown });
    const handed = await submit(f.ctx, f.author.id, doc.id, { summary: 'Wrote it.', evidence: 'Read it.', recorded: { path: 'docs/handbook.md' } });
    expect(handed.task.id).toBe(doc.id);
    expect((await f.log(doc.id)).find(e => e.kind === 'submitted')?.data).toMatchObject({ recorded: { path: 'docs/handbook.md' } });
  });

  it('refuses turnkey work closed with no commit and no place, and takes one that names a place', async () => {
    const f = await watched();
    const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
    const player = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, player.id));
    const { task } = await f.create({ assigneeAgentId: player.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
    f.ctx.readCommit = async (_repo, want) => ('branch' in want ? { branch: want.branch, commitSha: HEAD } : { problem: 'No such branch.', missing: true });
    await expect(report(f.ctx, player.id, task.id, { done: true, summary: 'Posted the notice.' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('recorded') as unknown });
    const closed = await report(f.ctx, player.id, task.id, { done: true, summary: 'Posted the notice.', recorded: { path: 'posts/2026-11-23.md' } });
    expect(closed.task.status).toBe('done');
    expect((await f.log(task.id)).find(e => e.kind === 'report' && 'recorded' in e.data)?.data).toMatchObject({ done: true, recorded: { path: 'posts/2026-11-23.md' } });
  });
});
