import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { departments, testRuns } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import { publicUrl } from '../link/link.js';
import { runPurpose } from './purpose.js';
import type { RepoAddress } from './refs.js';

type Run = typeof testRuns.$inferSelect;
type MarkState = 'success' | 'failure';
export type TestsMark = { state: MarkState; description: string; targetUrl: string | null };
export type MarkAnswer = { ok: true } | { problem: string };
export type CommitMarker = (repo: RepoAddress, commit: string, mark: TestsMark) => Promise<MarkAnswer>;

/* What a full test run leaves on the commit it checked. scripts/tests-mark.mjs reads it for .github/workflows/images.yml. */
export const TESTS_CONTEXT = 'hornhoof/tests';
const API = 'https://api.github.com';
/* How long the end of a run waits for GitHub. */
const POST_MS = 10_000;

const STATUS_RIGHT = 'Give the repository\'s token the right to write commit statuses: "Commit statuses: Read and write" on a fine-grained token, repo:status on a classic one.';
const WHAT_TO_DO: Record<number, string> = {
  401: 'GitHub no longer takes this token: give the repository a new token.',
  403: STATUS_RIGHT,
  404: STATUS_RIGHT,
  301: 'The repository moved: give it its new address.',
  302: 'The repository moved: give it its new address.',
  307: 'The repository moved: give it its new address.',
  308: 'The repository moved: give it its new address.',
};

/* owner/name of a repository on GitHub, none of one elsewhere. */
function nameOnGitHub(url: string): string | null {
  const at = new URL(url);
  return at.host === 'github.com' ? at.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '') : null;
}

/* Sets the mark on that commit with the repository's token. It says what went wrong rather than throw, and never with the
   token. It follows no redirect: the token stays with GitHub, and a POST sent on as a GET would look as if it was set. */
export const markCommit = async (repo: RepoAddress, commit: string, mark: TestsMark, api = API, timeoutMs = POST_MS): Promise<MarkAnswer> => {
  const name = nameOnGitHub(repo.url);
  if (!name) return { problem: `Only a repository on github.com can carry it, and this one is at ${repo.url}.` };
  if (!repo.token) return { problem: 'The repository has no token to set it with.' };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${api}/repos/${name}/statuses/${commit}`, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${repo.token}`, 'content-type': 'application/json', 'user-agent': 'hornhoof', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ state: mark.state, context: TESTS_CONTEXT, description: mark.description, ...(mark.targetUrl ? { target_url: mark.targetUrl } : {}) }),
    });
    await res.body?.cancel();
    return res.ok ? { ok: true } : { problem: `GitHub answered ${res.status}. ${WHAT_TO_DO[res.status] ?? ''}`.trimEnd() };
  } catch {
    return { problem: signal.aborted ? `GitHub did not answer within ${timeoutMs} ms.` : 'GitHub could not be reached.' };
  }
};

/* Only a command that says how many parts there are covers them all, however many a run splits into. */
export const coversEveryPart = (command: string) => !command.includes('{part}') || command.includes('{parts}');

/* What a run is told as it starts, of the mark it will leave: none when its repository declares no full command. */
export function markPromise(full: string | null | undefined, command: string): string {
  if (!full) return '';
  return command === full
    ? ` This is the repository's full test command: its end sets ${TESTS_CONTEXT} on the pinned commit.`
    : ` The repository's full test command is ${full}. Only a run of exactly that sets ${TESTS_CONTEXT}, so this one will not.`;
}

/* A run of the product's own environment that stands for the whole product: what GitHub would otherwise run again. Files that kept
   a green result of the release count as checked: its first run ran them. */
const wholeProduct = (run: Run): boolean => Boolean(run.environmentSnapshot && run.environmentRequest && runPurpose(run.environmentSnapshot, run.environmentRequest.suite) === 'final');

/* The open test run with this id, when it pinned a commit and either runs to the letter what its repository declared as the whole
   suite, or runs the whole product in its own environment. */
async function fullRun(db: Ctx['db'], runId: string): Promise<(Run & { commitSha: string }) | null> {
  const [found] = await db
    .select({ run: testRuns, full: departments.repoFullTestCommand })
    .from(testRuns)
    .innerJoin(departments, eq(departments.id, testRuns.departmentId))
    .where(and(eq(testRuns.id, runId), eq(testRuns.status, 'running'), eq(testRuns.kind, 'tests')));
  if (!found?.run.commitSha) return null;
  if (found.run.command !== found.full && !wholeProduct(found.run)) return null;
  return { ...found.run, commitSha: found.run.commitSha };
}

type Marking = Pick<Ctx, 'db' | 'config' | 'markCommit'>;

/* Where a person reads of the run. GitHub shows it as a link, so only over https. */
async function linkOf(ctx: Marking, run: Run): Promise<string | null> {
  const base = await publicUrl(ctx.db, ctx.config);
  return base.startsWith('https://') ? `${base}/tasks/${run.taskId}` : null;
}

async function setMark(ctx: Marking, run: Run & { commitSha: string }, status: 'passed' | 'failed', state: MarkState): Promise<MarkAnswer> {
  /* A token that can no longer be read says so here, as the run ended all the same. */
  const found = await repoAt(ctx, [run.departmentId]).catch(() => null);
  if (!found) return { problem: "Hornhoof could not read the repository's token." };
  return ctx.markCommit(found.repo, run.commitSha, { state, description: `Test run ${run.number} ${status} in Hornhoof.`, targetUrl: await linkOf(ctx, run) });
}

export type RunMark = { line: string; data: { run: number; commit: string; state: MarkState; set: boolean } };

/* The mark a full test run leaves on the commit it pinned, whatever its branch holds by now: said in words, as a mark that
   could not be set stops nothing and the run stands as it ended. Null when this run leaves none. */
export async function markRun(ctx: Marking, runId: string, status: 'passed' | 'failed'): Promise<RunMark | null> {
  const run = await fullRun(ctx.db, runId);
  if (!run) return null;
  const state: MarkState = status === 'passed' ? 'success' : 'failure';
  const answer = await setMark(ctx, run, status, state);
  const data = { run: run.number, commit: run.commitSha, state };
  if ('ok' in answer) return { line: `GitHub now shows ${TESTS_CONTEXT} = ${state} on ${run.commitSha}.`, data: { ...data, set: true } };
  return { line: `${TESTS_CONTEXT} was not set on ${run.commitSha}: ${answer.problem} The run stays ${status}. Without this mark GitHub runs the tests itself.`, data: { ...data, set: false } };
}
