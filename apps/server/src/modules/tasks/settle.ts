import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, taskEvents, tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { repoAt } from '../departments/repository.js';
import type { Grant } from '../templates/load.js';
import { requiredStagesComplete } from './echelons-accept.js';
import { routeOf } from './echelons-store.js';
import { filesOf } from './file-views.js';
import { Recorded } from './recorded.js';
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
   - recorded: a hand-in of work that is not code named where its result is recorded, it is still there, and a document has
     passed every check its route requires;
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

type Repo = NonNullable<Awaited<ReturnType<typeof repoAt>>>['repo'];
type Named = { commit: string; base: string };

const Sha = z.string().regex(COMMIT);
/* The commits one hand-in or closing report of the task names, each with the base it names: a candidate and its base, or the
   commit turnkey work joined a turn with and the start it named. A branch's head is not among them: it is only where an agent
   pushed. */
const NamedBy = z.object({
  candidate: z.object({ commit: Sha, baseCommit: Sha }).optional(),
  integration: z.object({ commit: Sha, start: Sha }).optional(),
}).transform(({ candidate, integration }): Named[] => [
  ...(candidate ? [{ commit: candidate.commit, base: candidate.baseCommit }] : []),
  ...(integration ? [{ commit: integration.commit, base: integration.start }] : []),
]);

/* What the task's own record names, oldest first. */
async function namedCommits(db: Ctx['db'], task: Task): Promise<Named[]> {
  const rows = await db.select(only(taskEvents, 'data')).from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), inArray(taskEvents.kind, ['submitted', 'report']))).orderBy(asc(taskEvents.id));
  return rows.flatMap(({ data }) => { const named = NamedBy.safeParse(data); return named.success ? named.data : []; });
}

/* The head of the task's own branch, task-<number>, where the record names no commit. */
async function branchCommit(ctx: Readers, repo: Repo, task: Task): Promise<string | null> {
  try {
    const at = await ctx.readCommit?.(repo, { task: task.number }, 5_000);
    return at && !('problem' in at) ? at.commitSha : null;
  } catch {
    return null;
  }
}

const none = (task: Task, why: string, commit: string | null = null, source: Released['source'] = null): Released => ({ task: task.number, commit, source, inMain: false, release: null, released: false, why });

/* Why the commit of a hand-in shows no work of the task's own past the base it names, or null where it does: a commit that is
   its own base, or that does not hold it, may be one main held before the task began. */
async function lacksOwnWork(ctx: Readers, repo: Repo, { commit, base }: Named): Promise<string | null> {
  if (commit === base) return `${commit} is its own base: the hand-in holds no work of the task's own past the base, and ${repo.branch} may have held it before the task began.`;
  if (!(await branchHolds(ctx, repo, commit, base))) return `${commit} could not be shown to hold its base ${base}, so nothing shows it holds work of the task's own past it.`;
  return null;
}

/* The newest of the release tags that hold the commit, as far as the repository could be read. */
async function releaseHolding(ctx: Readers, repo: Repo, commit: string): Promise<string | null> {
  let tags: [string, string][] = [];
  try {
    const read = await ctx.readTags?.(repo, 10_000);
    tags = read && 'tags' in read ? versionsNewestFirst(read.tags).slice(0, TAGS_ASKED) : [];
  } catch { /* Unread tags prove no release. */ }
  for (const [name, at] of tags) if (await branchHolds(ctx, repo, at, commit)) return name;
  return null;
}

/* Where main, or else the newest release tag, holds the commit; null where neither does. */
async function heldIn(ctx: Readers, repo: Repo, main: string, commit: string): Promise<{ inMain: boolean; release: string | null } | null> {
  if (await branchHolds(ctx, repo, main, commit)) return { inMain: true, release: null };
  const release = await releaseHolding(ctx, repo, commit);
  return release ? { inMain: false, release } : null;
}

/* Whether the commit of a task is in main or in a release, as the repository says: a commit only a turn branch or a branch of
   its own holds, or one that could not be read, is not. Only a commit a hand-in of the task names, with work of its own past
   the base it names, counts: the head of the task's branch, or a hand-in whose commit is its own base, may be a commit main
   held before the task began, and proves none of its work. */
export async function releasedState(ctx: Readers, task: Task): Promise<Released> {
  const found = ctx.config ? await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]) : null;
  if (!found) return none(task, 'The department of the task keeps no repository, so it has no commit to look for.');
  const named = (await namedCommits(ctx.db, task)).at(-1);
  if (!named) return unnamed(ctx, found.repo, task);
  const { commit } = named;
  const lacking = await lacksOwnWork(ctx, found.repo, named);
  if (lacking) return none(task, lacking, commit, 'record');
  const main = await headOf(ctx, found.repo, found.repo.branch);
  if (!main) return none(task, `${found.repo.branch} could not be read, so nothing is proved.`, commit, 'record');
  const held = await heldIn(ctx, found.repo, main, commit);
  return held
    ? { task: task.number, commit, source: 'record', ...held, released: true, why: null }
    : none(task, `${commit} is in neither ${found.repo.branch} nor a release tag as far as the repository could be read: it is unfinished work.`, commit, 'record');
}

/* No hand-in names a commit: the branch of the task, if it has one, is reported and is no proof. */
async function unnamed(ctx: Readers, repo: Repo, task: Task): Promise<Released> {
  const head = await branchCommit(ctx, repo, task);
  if (!head) return none(task, 'No commit is recorded for the task and it has no branch of its own.');
  return none(task, `No hand-in of the task names a commit. The branch task-${task.number} is at ${head}, but a branch head is no proof of work: a branch pushed at ${repo.branch} before its first commit holds nothing of the task's own.`, head, 'branch');
}

/* A task held, done or given out by a person's own assistant stays that person's. */
async function personal(db: Ctx['db'], task: Task): Promise<boolean> {
  const ids = [task.assigneeAgentId, task.executorAgentId, task.createdByAgentId].filter((id): id is string => Boolean(id));
  if (!ids.length) return false;
  return (await db.select({ id: agents.id }).from(agents).where(and(inArray(agents.id, ids), eq(agents.kind, 'assistant'))).limit(1)).length > 0;
}

const Placed = z.object({ recorded: Recorded });

/* Where the newest hand-in of the task says its result is recorded, if that is still true: a file still on the task, or a path
   in the repository. A path is the department's own word that Hornhoof does not read: the watchdog opens it first. */
async function recordedPlace(db: Ctx['db'], task: Task): Promise<Recorded | null> {
  const rows = await db.select(only(taskEvents, 'data')).from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), inArray(taskEvents.kind, ['submitted', 'report']))).orderBy(desc(taskEvents.id));
  const place = rows.map(({ data }) => Placed.safeParse(data)).find(found => found.success)?.data?.recorded;
  if (!place || !('file' in place)) return place ?? null;
  return (await filesOf(db, task.id)).some(file => file.name === place.file) ? place : null;
}

const no = (why: string): Verdict => ({ clear: false, why });
const ASK_HEAD = 'Ask the head of its department instead of closing it';

const childrenOf = (db: Ctx['db'], task: Task) => db.select({ number: tasks.number, status: tasks.status }).from(tasks).where(and(eq(tasks.parentId, task.id), eq(tasks.companyId, task.companyId)));

/* Why a task is no case for the watchdog at all, or null: closed, paused, held by a person's assistant, or with work under it. */
async function notACase(db: Ctx['db'], task: Task): Promise<string | null> {
  if (CLOSED.includes(task.status)) return `#${task.number} is ${task.status} already.`;
  if (task.paused) return `#${task.number} is paused: paused work is never closed by the watchdog. ${ASK_HEAD}.`;
  if (await personal(db, task)) return `#${task.number} belongs to a person's own assistant.`;
  const open = (await childrenOf(db, task)).filter(child => !CLOSED.includes(child.status));
  return open.length ? `#${task.number} still has open subtasks (${open.map(child => `#${child.number}`).join(', ')}). ${ASK_HEAD}.` : null;
}

/* A parent with subtasks, every one of them closed, that waits for no person. */
async function coordinationVerdict(db: Ctx['db'], task: Task): Promise<Verdict> {
  const children = await childrenOf(db, task);
  if (!children.length) return no(`#${task.number} is a parent with no subtasks yet: it has not started, so nothing proves it is done.`);
  if (await waitsForPerson(db, task.id)) return no(`#${task.number} waits for a person's answer.`);
  return { clear: true, settle: { rule: 'coordination', evidence: { subtasks: children.map(child => child.number) } } };
}

/* Code: the commit its hand-ins name is in a release. Turnkey work that named none and has no branch is judged as recorded. */
async function codeVerdict(ctx: Readers, task: Task, kind: 'code' | 'turnkey'): Promise<Verdict | null> {
  const state = await releasedState(ctx, task);
  if (state.released) return { clear: true, settle: { rule: 'code', evidence: { commit: state.commit, inMain: state.inMain, release: state.release, source: state.source } } };
  return kind === 'code' || state.commit ? no(state.why ?? `The commit of #${task.number} is not in a release.`) : null;
}

/* Work that is not code: its result is recorded where a colleague finds it, and a document has passed every check its route
   requires, as recording it never skips a stage. */
async function recordedVerdict(db: Ctx['db'], task: Task, route: Awaited<ReturnType<typeof routeOf>>): Promise<Verdict> {
  if (route.state.resultKind === 'document' && (route.state.phase !== 'ready' || !requiredStagesComplete(route))) return no(`The result of #${task.number} has not passed every check its route requires, and closing the record would skip them. ${ASK_HEAD}.`);
  const place = await recordedPlace(db, task);
  return place
    ? { clear: true, settle: { rule: 'recorded', evidence: { recorded: place } } }
    : no(`The result of #${task.number} is not recorded anywhere a colleague finds it: no hand-in names a path in the repository or a file still on the task, so it is not done.`);
}

/* Whether a task is a clear case, and which rule says so. */
export async function settleVerdict(ctx: Readers, task: Task): Promise<Verdict> {
  const why = await notACase(ctx.db, task);
  if (why) return no(why);
  const route = await routeOf(ctx.db, task);
  const kind = route.state.resultKind;
  if (kind === 'coordination') return coordinationVerdict(ctx.db, task);
  const code = kind === 'code' || kind === 'turnkey' ? await codeVerdict(ctx, task, kind) : null;
  return code ?? recordedVerdict(ctx.db, task, route);
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
  const wakes: Wake[] = head && head !== agentId ? [{ agentId: head, taskId: task.id, why: 'reported', text: `The task watchdog ${watcher.name} closed it as done on the server's own proof (${verdict.settle.rule}), not by an accepted result of its route: ${reason}` }] : [];
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0 }, {
    kind: 'done', actor: { agentId }, text: reason, data: { settled: verdict.settle },
  }, async tx => { await endRoutes(tx, task.companyId, [task.id], 'done'); }, wakes);
  return { task: row, wakes, settle: verdict.settle };
}

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const Ref = z.union([z.number().int().positive(), z.string().max(40)]).describe('The task number, like 12 or "#12", or its id.');

/* The two tools of the watchdog's skill: a read of where a task's commit stands, and the close of a clear case. */
export function registerSettleTools(server: McpServer, ctx: Ctx, job: ToolJob, grants: ReadonlySet<Grant>): void {
  /* The orchestrator closes any task with close_task already: settling is the watchdog's, by its skill. */
  if (!grants.has('settle') || job.agentKind === 'orchestrator') return;
  const find = async (ref: number | string): Promise<Task> => {
    const task = await taskByRef(ctx, job.companyId, ref);
    if (!task) throw refuse(404, 'task_unknown', `There is no task ${ref} in this company.`);
    /* Neither tool says where a person's own work stands. */
    if (await personal(ctx.db, task)) throw refuse(403, 'task_not_yours', `#${task.number} belongs to a person's own assistant.`);
    return task;
  };
  const answer = async (run: () => Promise<string>) => run().then(text => say(text), (err: unknown) => (err instanceof ApiError ? say(err.message, true) : Promise.reject(err)));
  server.registerTool('task_released', {
    description: 'Whether the commit a task recorded is in main or in a release tag, as the repository says, so a task of any department can be judged without a query: the commit, where it came from (the task\'s own record, or its branch which is no proof), inMain, the release tag that holds it, and released. Only a commit a hand-in of the task names, with work of its own past the base it names, counts. A commit that only a turn branch or a branch of the task holds, and the head of the task\'s branch, are not released: they are unfinished work, never a reason to close the task.',
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
