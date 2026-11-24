import { z } from 'zod';
import { Absent, Refused, Unread, jsonOf, linkOf, sendOf, shown, Sha, type Json, type Send } from './github-api.js';
import { nameOf, releaseWorkflowOf, type Wf } from './github-workflow.js';
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
const Dispatches = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(z.object({ id: z.number().int().positive(), workflow_id: z.number().int().positive(), head_sha: Sha, html_url: z.string().nullable().optional(), repository: z.object({ full_name: z.string().min(1) }) })),
});

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
async function runOf(json: Json, repo: RepoAddress, name: string, workflow: Wf, commit: string, pause: (ms: number) => Promise<void>, timeoutMs: number): Promise<{ run: number; url: string | null } | null> {
  for (let look = 0; look < LOOKS; look++) {
    if (look) await pause(LOOK_EVERY_MS);
    const parsed = Dispatches.safeParse(await json(repo, name, `actions/workflows/${workflow.id}/runs?event=workflow_dispatch&head_sha=${commit}&per_page=5`, timeoutMs));
    const own = parsed.success ? parsed.data.workflow_runs.find(run => run.head_sha === commit && run.workflow_id === workflow.id && run.repository.full_name.toLowerCase() === name.toLowerCase()) : undefined;
    if (own) return { run: own.id, url: linkOf(own.html_url) };
  }
  return null;
}

type Reach = { json: Json; send: Send; pause: (ms: number) => Promise<void> };

/* The request to start the workflow on the branch: null once GitHub took it, else what became of it. A refusal of GitHub that
   says no is a refusal; a failure that leaves it unknown whether it was started is unsure; the request limit is thrown. */
async function post(at: Reach, repo: RepoAddress, name: string, workflow: Wf, branch: string, timeoutMs: number): Promise<Dispatched | null> {
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
  const chosen = await releaseWorkflowOf(at.json, repo, name, true, timeoutMs);
  if ('no' in chosen) return { state: 'refused', why: chosen.no };
  const { workflow } = chosen;
  const failed = await post(at, repo, name, workflow, branch, timeoutMs);
  if (failed) return failed;
  const run = await runOf(at.json, repo, name, workflow, commit, at.pause, timeoutMs).catch(() => null);
  return { state: 'started', workflow: nameOf(workflow), run: run?.run ?? null, url: run?.url ?? null };
}

const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/* The dispatcher of a server: it starts the release workflow of the repository (github-workflow.ts says which) on the branch
   given, with the repository's token and the server's request limit. */
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
