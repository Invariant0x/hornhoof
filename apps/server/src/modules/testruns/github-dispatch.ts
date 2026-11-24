import { z } from 'zod';
import { Absent, Refused, Unread, defaultBranchOf, jsonOf, linkOf, sendOf, shown, Sha, type Json, type Send } from './github-ci.js';
import { githubName, GitHubRateLimited, type GitHubLimits, type RateLimit } from './github-limit.js';
import type { RepoAddress } from './refs.js';

/* Starting the release workflow of a repository on a commit of a turn branch. GitHub runs a workflow_dispatch workflow on the
   head of a branch, so the run that comes of it is read again, by the exact commit it ran on, before CI says anything of it.
   started: the request was taken; run is the one that came of it where GitHub listed it already. refused: GitHub or the
   repository said no, and nothing was started. unsure: the request went out and what became of it is not known, so it is not
   sent again. unsupported, unread and limited are as the reader of CI has them, and start nothing. */
export type Dispatched =
  | { state: 'started'; workflow: string; run: number | null; url: string | null }
  | { state: 'refused'; why: string }
  | { state: 'unsure'; workflow: string; why: string }
  | { state: 'unsupported'; why: string }
  | { state: 'unread'; why: string }
  | { state: 'limited'; limit: RateLimit };
export type CiDispatcher = (repo: RepoAddress, branch: string, commit: string, timeoutMs?: number) => Promise<Dispatched>;

const READ_MS = 10_000;
const LOOKS = 4;
const LOOK_EVERY_MS = 1_500;
/* The most active workflows of a repository read for the one that releases. */
const MAX_WORKFLOWS = 30;

const WorkflowList = z.object({
  total_count: z.number().int().nonnegative(),
  workflows: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1), path: z.string().min(1), state: z.string().min(1) })),
});
const FileAt = z.object({ type: z.literal('file'), encoding: z.literal('base64'), content: z.string() });
const LastRun = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(z.object({ conclusion: z.string().nullable(), status: z.string().min(1) })),
});
const Dispatches = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(z.object({ id: z.number().int().positive(), workflow_id: z.number().int().positive(), head_sha: Sha, html_url: z.string().nullable().optional(), repository: z.object({ full_name: z.string().min(1) }) })),
});

type Workflow = z.infer<typeof WorkflowList>['workflows'][number];

const nameOf = (workflow: Workflow): string => shown(`${workflow.name} (${workflow.path})`);

/* Whether a workflow file starts on workflow_dispatch: the word, outside its comments, in its text. A file that only says it
   in a string is taken for one that does, and GitHub refuses it when it is started. */
export const startsByHand = (text: string): boolean => /\bworkflow_dispatch\b/.test(text.replace(/#.*$/gm, ''));

async function textOf(json: Json, repo: RepoAddress, name: string, workflow: Workflow, head: string, timeoutMs: number): Promise<string | null> {
  try {
    const file = FileAt.safeParse(await json(repo, name, `contents/${workflow.path.split('/').map(encodeURIComponent).join('/')}?ref=${head}`, timeoutMs));
    return file.success ? Buffer.from(file.data.content.replace(/\s/g, ''), 'base64').toString('utf8') : null;
  } catch (error) {
    if (error instanceof Absent) return null;
    throw error;
  }
}

/* Whether the workflow's latest finished run on the default branch ended with success. */
async function greenOnDefault(json: Json, repo: RepoAddress, name: string, workflow: Workflow, branch: string, timeoutMs: number): Promise<boolean> {
  const parsed = LastRun.safeParse(await json(repo, name, `actions/workflows/${workflow.id}/runs?branch=${encodeURIComponent(branch)}&status=completed&exclude_pull_requests=true&per_page=1`, timeoutMs));
  if (!parsed.success) throw new Unread('its runs of a workflow were not readable');
  return parsed.data.workflow_runs[0]?.conclusion === 'success';
}

/* The workflows that can be started by hand and whose latest run on the default branch was green. */
async function qualifying(json: Json, repo: RepoAddress, name: string, timeoutMs: number): Promise<Workflow[]> {
  const main = await defaultBranchOf(json, repo, name, timeoutMs);
  const listed = WorkflowList.safeParse(await json(repo, name, 'actions/workflows?per_page=100', timeoutMs));
  if (!listed.success || listed.data.workflows.length !== listed.data.total_count) throw new Unread('its list of workflows was incomplete');
  const active = listed.data.workflows.filter(workflow => workflow.state === 'active');
  if (active.length > MAX_WORKFLOWS) throw new Unread(`it has more than ${MAX_WORKFLOWS} active workflows`);
  const found: Workflow[] = [];
  for (const workflow of active) {
    const text = await textOf(json, repo, name, workflow, main.head, timeoutMs);
    if (text !== null && startsByHand(text) && await greenOnDefault(json, repo, name, workflow, main.branch, timeoutMs)) found.push(workflow);
  }
  return found;
}

/* Why GitHub refused to start the workflow, in its own words where it said them: one short line. */
function whyRefused(error: Refused | Absent): string {
  const said = (() => { try { return z.object({ message: z.string() }).parse(JSON.parse(error instanceof Refused ? error.said : error.message)).message; } catch { return ''; } })();
  const status = error instanceof Refused ? error.status : 404;
  const hint = status === 404 || status === 403 || status === 401
    ? ' The repository token cannot start workflows: it needs the permission actions: write (or the workflow or the branch is not there).'
    : '';
  return `GitHub refused to start the workflow (${status}${said ? `: ${shown(said)}` : ''}).${hint}`;
}

/* The run that came of the request, by the exact commit it ran on: none until GitHub lists it. */
async function runOf(json: Json, repo: RepoAddress, name: string, workflow: Workflow, commit: string, pause: (ms: number) => Promise<void>, timeoutMs: number): Promise<{ run: number; url: string | null } | null> {
  for (let look = 0; look < LOOKS; look++) {
    if (look) await pause(LOOK_EVERY_MS);
    const parsed = Dispatches.safeParse(await json(repo, name, `actions/workflows/${workflow.id}/runs?event=workflow_dispatch&head_sha=${commit}&per_page=5`, timeoutMs));
    const own = parsed.success ? parsed.data.workflow_runs.find(run => run.head_sha === commit && run.workflow_id === workflow.id && run.repository.full_name.toLowerCase() === name.toLowerCase()) : undefined;
    if (own) return { run: own.id, url: linkOf(own.html_url) };
  }
  return null;
}

type Reach = { json: Json; send: Send; pause: (ms: number) => Promise<void> };

/* The one workflow to start, or why none is: none that qualifies, or more than one, which Hornhoof does not choose between. */
function oneOf(found: Workflow[]): { workflow: Workflow } | { no: Dispatched } {
  if (!found.length) {
    return { no: { state: 'refused', why: 'No workflow of the repository can be started by hand (workflow_dispatch) with a latest run that was green on its default branch, so Hornhoof has none to start for this release. Add workflow_dispatch to the workflow that checks a release and let it go green on the default branch.' } };
  }
  if (found.length > 1) {
    return { no: { state: 'refused', why: `More than one workflow can be started by hand and was green on the default branch last: ${found.map(nameOf).join('; ')}. Hornhoof does not guess which one releases. Until a repository can name its release workflow, only one workflow may have workflow_dispatch and a green latest run on the default branch.` } };
  }
  return { workflow: found[0]! };
}

/* The request to start the workflow on the branch: null once GitHub took it, else what became of it. A refusal of GitHub that
   says no is a refusal; a failure that leaves it unknown whether it was started is unsure; the request limit is thrown. */
async function post(at: Reach, repo: RepoAddress, name: string, workflow: Workflow, branch: string, timeoutMs: number): Promise<Dispatched | null> {
  try {
    await at.send(repo, name, `actions/workflows/${workflow.id}/dispatches`, { method: 'POST', body: { ref: branch } }, timeoutMs);
    return null;
  } catch (error) {
    if (error instanceof GitHubRateLimited) throw error;
    if (error instanceof Absent || (error instanceof Refused && error.status >= 400 && error.status < 500)) return { state: 'refused', why: whyRefused(error) };
    return { state: 'unsure', workflow: nameOf(workflow), why: "GitHub didn't answer whether the workflow was started" };
  }
}

async function start(at: Reach, repo: RepoAddress, name: string, branch: string, commit: string, timeoutMs: number): Promise<Dispatched> {
  const chosen = oneOf(await qualifying(at.json, repo, name, timeoutMs));
  if ('no' in chosen) return chosen.no;
  const { workflow } = chosen;
  const failed = await post(at, repo, name, workflow, branch, timeoutMs);
  if (failed) return failed;
  const run = await runOf(at.json, repo, name, workflow, commit, at.pause, timeoutMs).catch(() => null);
  return { state: 'started', workflow: nameOf(workflow), run: run?.run ?? null, url: run?.url ?? null };
}

const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/* The dispatcher of a server: it starts the one workflow of the repository that can be started by hand and was last green on
   the default branch, on the branch given, with the repository's token and the server's request limit. */
export function githubCiDispatcher(limits?: GitHubLimits, pause: (ms: number) => Promise<void> = later): CiDispatcher {
  const at: Reach = { json: jsonOf(limits), send: sendOf(limits), pause };
  return async (repo, branch, commit, timeout = READ_MS) => {
    const name = githubName(repo.url);
    if (!name) return { state: 'unsupported', why: 'the repository is not on github.com, the only host whose CI is read' };
    if (!Sha.safeParse(commit).success) return { state: 'unread', why: 'the commit is not a full commit id' };
    try {
      return await start(at, repo, name, branch, commit, timeout);
    } catch (error) {
      if (error instanceof GitHubRateLimited) return { state: 'limited', limit: error.limit };
      if (error instanceof Unread) return { state: 'unread', why: error.message };
      return { state: 'unread', why: "GitHub didn't answer while the release workflow was looked for" };
    }
  };
}
