import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { departments, taskEvents, tasks, testRuns, turns } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';
import { GitHubRateLimited } from '../testruns/github-limit.js';
import type { RepoAddress } from '../testruns/refs.js';
import { taskNumberOf, type Category, type Facts, type Holds, type TaskFact } from './prune-plan.js';
import { BATCH, BUDGET, pruneRepository, restoreCommand, type Entry, type Pruned } from './prune-run.js';
import { pushRefs } from './ref-push.js';

/* Pruning the branches of the repositories a company keeps, by Hornhoof's own records (#1964): what the tasks, turns and test
   runs say, and what each repository says of its branches. This builds what the plan needs from them, does a run of it and
   writes down each change on the task it belongs to. */

export type Reader = Pick<Ctx, 'db' | 'config'> & { log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'> } & Partial<Pick<Ctx, 'readBranches' | 'readTags' | 'readMerged' | 'pushRefs'>>;

const READ_MS = 30_000;
const CLOSED = ['done', 'cancelled'];

export type Repository = { id: string; companyId: string; name: string; url: string; branch: string; address: RepoAddress };

const sameUrl = (url: string) => url.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();

/* Every repository the companies keep, one for each address of a company: its departments' and its products'. */
export async function repositoriesOf(ctx: Pick<Reader, 'db' | 'config'>, companyId?: string): Promise<Repository[]> {
  const rows = await ctx.db.select().from(departments).where(and(isNotNull(departments.repoUrl), ...(companyId ? [eq(departments.companyId, companyId)] : [])));
  const kept = new Map<string, Repository>();
  for (const d of rows.sort((a, b) => Number(a.parentId !== null) - Number(b.parentId !== null))) {
    const key = `${d.companyId} ${sameUrl(d.repoUrl!)}`;
    if (kept.has(key)) continue;
    const token = d.repoTokenEnc ? decryptSecret(d.repoTokenEnc, ctx.config.secret) : '';
    kept.set(key, { id: d.id, companyId: d.companyId, name: deptName(d), url: d.repoUrl!, branch: d.repoBranch ?? 'main', address: { url: d.repoUrl!, token } });
  }
  return [...kept.values()];
}

/* What a repository says and what Hornhoof's records say of it. taskIds: the id of each task of the repository by number, to log
   a change on. None where the repository could not be read whole: a plan made from half of it could delete what it should keep. */
type Known = { facts: Facts; taskIds: ReadonlyMap<number, string> };

async function branchesAndTags(ctx: Reader, at: RepoAddress): Promise<{ heads: Record<string, string>; tags: Record<string, string> } | { problem: string }> {
  if (!ctx.readBranches || !ctx.readTags) return { problem: 'Hornhoof cannot read branches here.' };
  const [branches, tags] = [await ctx.readBranches(at, READ_MS), await ctx.readTags(at, READ_MS)];
  if ('problem' in branches) return { problem: branches.problem };
  return 'problem' in tags ? { problem: tags.problem } : { heads: branches.heads, tags: tags.tags };
}

/* The task of a company belongs to the first repository of its product and its department, as its work does. */
async function taskFacts(ctx: Reader, repository: Repository): Promise<{ facts: Map<number, TaskFact>; ids: Map<number, string> }> {
  const withRepo = new Set((await ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.companyId, repository.companyId), isNotNull(departments.repoUrl)))).map(d => d.id));
  const rows = await ctx.db.select().from(tasks).where(eq(tasks.companyId, repository.companyId));
  const facts = new Map<number, TaskFact>();
  const ids = new Map<number, string>();
  for (const t of rows) {
    if ([t.productId, t.departmentId].find(id => id !== null && withRepo.has(id)) !== repository.id) continue;
    ids.set(t.number, t.id);
    facts.set(t.number, { status: t.status, paused: t.paused !== null, closedAt: CLOSED.includes(t.status) ? (t.closedAt ?? t.updatedAt).getTime() : null });
  }
  return { facts, ids };
}

async function knownOf(ctx: Reader, repository: Repository, now: number): Promise<Known | { problem: string }> {
  const read = await branchesAndTags(ctx, repository.address);
  if ('problem' in read) return read;
  const { facts, ids } = await taskFacts(ctx, repository);
  const turnRows = await ctx.db.select({ number: turns.number }).from(turns).where(and(eq(turns.companyId, repository.companyId), eq(turns.departmentId, repository.id)));
  const runRows = await ctx.db.selectDistinct({ branch: testRuns.branch }).from(testRuns).where(and(eq(testRuns.companyId, repository.companyId), eq(testRuns.departmentId, repository.id), isNotNull(testRuns.branch)));
  const recorded = new Set([...turnRows.map(t => `turn-${t.number}`), ...runRows.map(r => r.branch!)]);
  return { facts: { main: repository.branch, heads: read.heads, tags: read.tags, tasks: facts, recorded, now }, taskIds: ids };
}

/* Whether the commit holder holds head, by GitHub's own comparison: none where it could not say. A used-up request limit is not
   one more branch it could not read: it stops the run, which says when it may go on. */
const holdsOf = (ctx: Reader, at: RepoAddress): Holds => async (holder, head) => {
  if (holder === head) return true;
  try {
    return (await ctx.readMerged?.(at, { base: holder, head }, 10_000)) ?? null;
  } catch (error) {
    if (error instanceof GitHubRateLimited) throw error;
    return null;
  }
};

/* One change written on the task its branch belongs to, so the task's log says what became of its branch and how to bring it
   back; any other, and each one that was refused, in the server's log. */
async function recordOf(ctx: Reader, repository: Repository, taskIds: ReadonlyMap<number, string>, entry: Entry): Promise<void> {
  const where = { repository: repository.url, branch: entry.branch, head: entry.head };
  if (entry.done === 'refused') {
    ctx.log.warn({ ...where, why: entry.problem }, 'Hornhoof did not prune a branch: the repository refused it.');
    return;
  }
  ctx.log.info({ ...where, action: entry.done, reason: entry.reason }, 'Hornhoof pruned a branch.');
  const number = taskNumberOf(entry.branch);
  const taskId = number === null ? undefined : taskIds.get(number);
  if (!taskId) return;
  const restore = entry.done === 'archived' ? { restore: restoreCommand(entry.branch) } : {};
  await ctx.db.insert(taskEvents).values({
    companyId: repository.companyId,
    taskId,
    kind: 'comment',
    text: `The branch ${entry.branch} (${entry.head.slice(0, 9)}) was ${entry.done}: ${entry.reason}.${entry.done === 'archived' ? ` Bring it back with: ${restoreCommand(entry.branch)}` : ''}`,
    data: { pruned: { branch: entry.branch, head: entry.head, action: entry.done, reason: entry.reason, ...(entry.heldBy ? { heldBy: entry.heldBy } : {}), ...restore } },
  });
}

export type Pruning = { repository: Repository; result: Pruned; counts: Record<Category, number> };
const CATEGORIES: readonly Category[] = ['main', 'held', 'archive', 'live', 'closed-lately', 'foreign', 'turn-kept', 'turn-delete', 'unreadable', 'waiting'];
const countsOf = (result: Pruned): Record<Category, number> => {
  const counts = Object.fromEntries(CATEGORIES.map(category => [category, 0])) as Record<Category, number>;
  for (const v of result.verdicts) counts[v.category] += 1;
  return counts;
};

/* A run over one repository. */
export async function pruneOne(ctx: Reader, repository: Repository, { apply, limit = BATCH, budget = BUDGET, now = Date.now() }: { apply: boolean; limit?: number; budget?: number; now?: number }): Promise<Pruning> {
  let taskIds: ReadonlyMap<number, string> = new Map();
  const result = await pruneRepository({
    facts: async () => {
      const known = await knownOf(ctx, repository, now);
      if ('problem' in known) return known;
      taskIds = known.taskIds;
      return known.facts;
    },
    holds: holdsOf(ctx, repository.address),
    push: (updates, options) => (ctx.pushRefs ?? pushRefs)(repository.address, updates, options),
    record: entry => recordOf(ctx, repository, taskIds, entry),
  }, { apply, limit, budget });
  return { repository, result, counts: countsOf(result) };
}

/* A run over each repository of a company, or of every company. */
export async function pruneCompany(ctx: Reader, options: { companyId?: string; apply: boolean; limit?: number; budget?: number }): Promise<Pruning[]> {
  const out: Pruning[] = [];
  for (const repository of await repositoriesOf(ctx, options.companyId)) out.push(await pruneOne(ctx, repository, options));
  return out;
}
