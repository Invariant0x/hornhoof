import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, taskEvents, tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { repoAt } from '../departments/repository.js';
import type { Grant } from '../templates/load.js';
import { routeOf } from './echelons-store.js';
import { filesOf } from './file-views.js';
import { taskByRef } from './lookup.js';
import { endRoutes } from './route-records.js';
import { CLOSED, loadTask, refuse, stillOpen, waitsForPerson, type Moved, type Task, type Wake } from './state.js';
import { move } from './transitions.js';
import { branchHolds, headOf } from './turn-integration.js';
import { versionsNewestFirst } from './turn-tags.js';
import type { ToolJob } from './tools.js';

/* A watchdog of the company finds tasks whose work is done or has lost its point, and closes the clear cases itself, in any
   department (#1942). What it may close is what the server proves, never what the watchdog says:
   - code: the commit the task recorded is in main or in a release tag (the ancestry, never the turn number);
   - recorded: a hand-in of work that is not code named where its result is recorded, and it is still there;
   - coordination: a parent with subtasks, every one of them closed.
   Anything else stays open: a commit outside every release is unfinished work, work paused or held by a person's own assistant
   is never touched, and a duplicate or a task paused long is a question for the head of its department. */

type Readers = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCommit' | 'readCompare' | 'readMerged' | 'readTags'>>;

export type Released = { task: number; commit: string | null; source: 'record' | 'branch' | null; inMain: boolean; release: string | null; released: boolean; why: string | null };

export type Settle = { rule: 'code' | 'recorded' | 'coordination'; evidence: Record<string, unknown> };
type Verdict = { clear: true; settle: Settle } | { clear: false; why: string };

const COMMIT = /^[0-9a-f]{40}$/;
/* How many of the newest release tags are asked for a commit main does not hold: a release is on main's line, so this is a
   fallback for a main that moved. */
const TAGS_ASKED = 5;

/* The commits the task's own record names, oldest first: what its hand-ins and its closing report kept. */
async function namedCommits(db: Ctx['db'], task: Task): Promise<string[]> {
  const rows = await db.select(only(taskEvents, 'data')).from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), inArray(taskEvents.kind, ['submitted', 'report']))).orderBy(asc(taskEvents.id));
  const found: string[] = [];
  for (const { data } of rows) {
    const d = data as { candidate?: { commit?: unknown }; acceptedCandidate?: { commit?: unknown }; integration?: { commit?: unknown } };
    for (const commit of [d.candidate?.commit, d.acceptedCandidate?.commit, d.integration?.commit]) if (typeof commit === 'string' && COMMIT.test(commit)) found.push(commit);
  }
  return found;
}

/* The head of the task's own branch, task-<number>, where the record names no commit. */
async function branchCommit(ctx: Readers, repo: Parameters<NonNullable<Ctx['readCommit']>>[0], task: Task): Promise<string | null> {
  if (!ctx.readCommit) return null;
  try {
    const at = await ctx.readCommit(repo, { task: task.number }, 5_000);
    return 'problem' in at ? null : at.commitSha;
  } catch {
    return null;
  }
}

/* Whether the commit of a task is in main or in a release, as the repository says: a commit only a turn branch or a branch of
   its own holds, or one that could not be read, is not. */
export async function releasedState(ctx: Readers, task: Task): Promise<Released> {
  const none = (why: string, commit: string | null = null, source: Released['source'] = null): Released => ({ task: task.number, commit, source, inMain: false, release: null, released: false, why });
  const found = ctx.config ? await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]) : null;
  if (!found) return none('The department of the task keeps no repository, so it has no commit to look for.');
  const named = (await namedCommits(ctx.db, task)).at(-1) ?? null;
  const commit = named ?? (await branchCommit(ctx, found.repo, task));
  const source = named ? 'record' : commit ? 'branch' : null;
  if (!commit) return none('No commit is recorded for the task and it has no branch of its own.');
  const main = await headOf(ctx, found.repo, found.repo.branch);
  if (!main) return none(`${found.repo.branch} could not be read, so nothing is proved.`, commit, source);
  if (await branchHolds(ctx, found.repo, main, commit)) return { task: task.number, commit, source, inMain: true, release: null, released: true, why: null };
  const tags = ctx.readTags ? await ctx.readTags(found.repo, 10_000).catch(() => ({ problem: 'unread' })) : { problem: 'unread' };
  for (const [name, at] of 'tags' in tags ? versionsNewestFirst(tags.tags).slice(0, TAGS_ASKED) : []) {
    if (await branchHolds(ctx, found.repo, at, commit)) return { task: task.number, commit, source, inMain: false, release: name, released: true, why: null };
  }
  return none(`${commit} is in neither ${found.repo.branch} nor a release tag as far as the repository could be read: it is unfinished work.`, commit, source);
}

/* A task held, done or given out by a person's own assistant stays that person's. */
async function personal(db: Ctx['db'], task: Task): Promise<boolean> {
  const ids = [task.assigneeAgentId, task.executorAgentId, task.createdByAgentId].filter((id): id is string => Boolean(id));
  if (!ids.length) return false;
  return (await db.select({ id: agents.id }).from(agents).where(and(inArray(agents.id, ids), eq(agents.kind, 'assistant'))).limit(1)).length > 0;
}

/* Where the newest hand-in of the task says its result is recorded, if that is still true: a file still on the task, or a path
   in the repository. A path is the department's own word that Hornhoof does not read: the watchdog opens it first. */
async function recordedPlace(db: Ctx['db'], task: Task): Promise<{ path: string } | { file: string } | null> {
  const rows = await db.select(only(taskEvents, 'data')).from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), inArray(taskEvents.kind, ['submitted', 'report']))).orderBy(desc(taskEvents.id));
  for (const { data } of rows) {
    const where = (data as { recorded?: { path?: unknown; file?: unknown } }).recorded;
    if (typeof where?.path === 'string') return { path: where.path };
    if (typeof where?.file === 'string') return (await filesOf(db, task.id)).some(file => file.name === where.file) ? { file: where.file } : null;
  }
  return null;
}

const no = (why: string): Verdict => ({ clear: false, why });
const ASK_HEAD = 'Ask the head of its department instead of closing it';

/* Whether a task is a clear case, and which rule says so. */
export async function settleVerdict(ctx: Readers, task: Task): Promise<Verdict> {
  if (CLOSED.includes(task.status)) return no(`#${task.number} is ${task.status} already.`);
  if (task.paused) return no(`#${task.number} is paused: paused work is never closed by the watchdog. ${ASK_HEAD}.`);
  if (await personal(ctx.db, task)) return no(`#${task.number} belongs to a person's own assistant.`);
  const children = await ctx.db.select({ number: tasks.number, status: tasks.status }).from(tasks).where(and(eq(tasks.parentId, task.id), eq(tasks.companyId, task.companyId)));
  const open = children.filter(child => !CLOSED.includes(child.status));
  if (open.length) return no(`#${task.number} still has open subtasks (${open.map(child => `#${child.number}`).join(', ')}). ${ASK_HEAD}.`);
  const kind = (await routeOf(ctx.db, task)).state.resultKind;
  if (kind === 'coordination') {
    if (!children.length) return no(`#${task.number} is a parent with no subtasks yet: it has not started, so nothing proves it is done.`);
    if (await waitsForPerson(ctx.db, task.id)) return no(`#${task.number} waits for a person's answer.`);
    return { clear: true, settle: { rule: 'coordination', evidence: { subtasks: children.map(child => child.number) } } };
  }
  if (kind === 'code' || kind === 'turnkey') {
    const state = await releasedState(ctx, task);
    if (state.released) return { clear: true, settle: { rule: 'code', evidence: { commit: state.commit, inMain: state.inMain, release: state.release, source: state.source } } };
    if (kind === 'code' || state.commit) return no(state.why ?? `The commit of #${task.number} is not in a release.`);
  }
  const place = await recordedPlace(ctx.db, task);
  if (!place) return no(`The result of #${task.number} is not recorded anywhere a colleague finds it: no hand-in names a path in the repository or a file still on the task, so it is not done.`);
  return { clear: true, settle: { rule: 'recorded', evidence: { recorded: place } } };
}

/* The head of the task's department, who hears that the watchdog closed it. */
async function headOfDepartment(db: Ctx['db'], task: Task): Promise<string | null> {
  if (!task.departmentId) return null;
  const [head] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.departmentId, task.departmentId), eq(agents.kind, 'head'), isNull(agents.removedAt))).orderBy(asc(agents.createdAt)).limit(1);
  return head?.id ?? null;
}

/* Only an employee a skill of whose gives the settle grant closes this way: asked of the skills it has now. */
function mayWatch(ctx: Readers, agent: Pick<typeof agents.$inferSelect, 'skills'>): boolean {
  return agent.skills.some(id => ctx.templates?.skills.get(id)?.grants.includes('settle'));
}

/* Closes a task the server proves to be done, with the watchdog's reason in its log as its own act and a notice to the head
   of the task's department. It closes only the record: the work under it is none (a task with open subtasks is no clear case),
   and it accepts no result and puts nothing into a turn, a release or main. */
export async function settleTask(ctx: Readers, agentId: string, taskId: string, why: string): Promise<Moved & { settle: Settle }> {
  const task = await loadTask(ctx.db, taskId);
  const [watcher] = await ctx.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, task.companyId), isNull(agents.removedAt)));
  if (!watcher || !mayWatch(ctx, watcher)) throw refuse(403, 'task_not_yours', 'Only the task watchdog closes a task it did not do.');
  stillOpen(task);
  const reason = why.trim();
  if (!reason) throw refuse(400, 'task_invalid', `Say why #${task.number} closes.`);
  const verdict = await settleVerdict(ctx, task);
  if (!verdict.clear) throw refuse(409, 'task_invalid', verdict.why);
  const head = await headOfDepartment(ctx.db, task);
  const wakes: Wake[] = head && head !== agentId ? [{ agentId: head, taskId: task.id, why: 'reported', text: `The task watchdog ${watcher.name} closed it as done (${verdict.settle.rule}): ${reason}` }] : [];
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0 }, {
    kind: 'done', actor: { agentId }, text: reason, data: { settled: verdict.settle },
  }, async tx => { await endRoutes(tx, task.companyId, [task.id], 'done'); }, wakes);
  return { task: row, wakes, settle: verdict.settle };
}

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const Ref = z.union([z.number().int().positive(), z.string().max(40)]).describe('The task number, like 12 or "#12", or its id.');

/* The two tools of the watchdog's skill: a read of where a task's commit stands, and the close of a clear case. */
export function registerSettleTools(server: McpServer, ctx: Ctx, job: ToolJob, grants: ReadonlySet<Grant>): void {
  if (!grants.has('settle')) return;
  const find = async (ref: number | string): Promise<Task> => {
    const task = await taskByRef(ctx, job.companyId, ref);
    if (!task) throw refuse(404, 'task_unknown', `There is no task ${ref} in this company.`);
    return task;
  };
  const answer = async (run: () => Promise<string>) => run().then(text => say(text), (err: unknown) => (err instanceof ApiError ? say(err.message, true) : Promise.reject(err)));
  server.registerTool('task_released', {
    description: 'Whether the commit a task recorded is in main or in a release tag, as the repository says, so a task of any department can be judged without a query: the commit, where it came from (the task\'s own record or its branch), inMain, the release tag that holds it, and released. A commit that only a turn branch or a branch of the task holds is not released: it is unfinished work, never a reason to close the task.',
    inputSchema: { task: Ref },
  }, async ({ task: ref }) => answer(async () => JSON.stringify(await releasedState(ctx, await find(ref)))));
  server.registerTool('settle_task', {
    description: 'Closes a task of any department as done when the server itself proves it is: its recorded commit is in main or a release, its non-code result is recorded where a colleague finds it, or its parent has no work left. why goes into its log as your act and the head of its department is told. It refuses paused work, a commit outside every release, a duplicate and any case that is not clear: ask the head of its department for those.',
    inputSchema: { task: Ref, why: z.string().trim().min(1).max(1000) },
  }, async ({ task: ref, why }) => answer(async () => {
    const task = await find(ref);
    const settled = await settleTask(ctx, job.agentId, task.id, why);
    return `Closed #${task.number} as done (${settled.settle.rule}). The head of its department is told.`;
  }));
}
