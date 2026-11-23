import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, attachments, departments, jobs, pendingWakes, taskEvents, tasks, teams } from '../src/db/schema.js';
import { routeOf } from '../src/modules/tasks/echelons-store.js';
import { loadTask, report, submit, verdict } from '../src/modules/tasks/engine.js';
import { setPaused } from '../src/modules/tasks/pause.js';
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

type Holds = { main?: string[]; turn?: string[]; tag?: string[]; unreadable?: boolean };

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
    f.ctx.readCommit = async (_repo, want) => ('branch' in want ? { branch: want.branch, commitSha: want.branch === 'main' ? MAIN : TURN } : { branch: `task-${want.task}`, commitSha: HEAD });
    f.ctx.readTags = async () => ({ tags: { 'v0.41.0': TAG } });
    f.ctx.readMerged = async (_repo, { base, head }) => {
      if (holds.unreadable) throw new Error('GitHub is down');
      const lines: Record<string, string[]> = { [MAIN]: holds.main ?? [], [TURN]: holds.turn ?? [], [TAG]: holds.tag ?? [] };
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
