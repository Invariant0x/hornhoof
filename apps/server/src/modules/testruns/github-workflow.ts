import { z } from 'zod';
import { Absent, Sha, Unread, defaultBranchOf, runsAt, shown, type Json, type Run } from './github-api.js';
import type { RepoAddress } from './refs.js';

/* Which workflow of a repository is its release workflow, the one whose run on a commit says the commit may be released.
   Hornhoof does not guess: it is the workflow whose run was alive when the repository's latest published version release was
   made, which is the one that proves a version. Where there is no such release, or none was made by a run (a person made it),
   it is the one workflow that can be started by hand (workflow_dispatch) and whose latest run on the default branch was green.
   Where several still qualify, none is chosen and they are named. */
export type Wf = { id: number; name: string; path: string };
export type Chosen = { workflow: Wf } | { no: string };

/* The most active workflows of a repository read for the one that releases. */
const MAX_WORKFLOWS = 30;
/* A release is made inside its run: the run was going on within this much of the time the release was published. */
const SLACK_MS = 60_000;

const WorkflowList = z.object({
  total_count: z.number().int().nonnegative(),
  workflows: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1), path: z.string().min(1), state: z.string().min(1) })),
});
const Releases = z.array(z.object({ tag_name: z.string().min(1), draft: z.boolean(), prerelease: z.boolean(), published_at: z.string().nullable() }));
const Ref = z.object({ object: z.object({ type: z.string().min(1), sha: Sha }) });
const FileAt = z.object({ type: z.literal('file'), encoding: z.literal('base64'), content: z.string() });
const LastRun = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(z.object({ conclusion: z.string().nullable(), status: z.string().min(1) })),
});

export const nameOf = (workflow: Wf): string => shown(`${workflow.name} (${workflow.path})`);

/* Whether a workflow file starts on workflow_dispatch: the word, outside its comments, in its text. A file that only says it
   in a string is taken for one that does, and GitHub refuses it when it is started. */
export const startsByHand = (text: string): boolean => /\bworkflow_dispatch\b/.test(text.replace(/#.*$/gm, ''));

/* The active workflows of the repository, all of them. */
async function activeWorkflows(json: Json, repo: RepoAddress, name: string, timeoutMs: number): Promise<Wf[]> {
  const listed = WorkflowList.safeParse(await json(repo, name, 'actions/workflows?per_page=100', timeoutMs));
  if (!listed.success || listed.data.workflows.length !== listed.data.total_count) throw new Unread('its list of workflows was incomplete');
  const active = listed.data.workflows.filter(workflow => workflow.state === 'active');
  if (active.length > MAX_WORKFLOWS) throw new Unread(`it has more than ${MAX_WORKFLOWS} active workflows`);
  return active;
}

async function textOf(json: Json, repo: RepoAddress, name: string, workflow: Wf, head: string, timeoutMs: number): Promise<string | null> {
  try {
    const file = FileAt.safeParse(await json(repo, name, `contents/${workflow.path.split('/').map(encodeURIComponent).join('/')}?ref=${head}`, timeoutMs));
    return file.success ? Buffer.from(file.data.content.replace(/\s/g, ''), 'base64').toString('utf8') : null;
  } catch (error) {
    if (error instanceof Absent) return null;
    throw error;
  }
}

/* Whether the workflow's latest finished run on the default branch ended with success. */
async function greenOnDefault(json: Json, repo: RepoAddress, name: string, workflow: Wf, branch: string, timeoutMs: number): Promise<boolean> {
  const parsed = LastRun.safeParse(await json(repo, name, `actions/workflows/${workflow.id}/runs?branch=${encodeURIComponent(branch)}&status=completed&exclude_pull_requests=true&per_page=1`, timeoutMs));
  if (!parsed.success) throw new Unread('its runs of a workflow were not readable');
  return parsed.data.workflow_runs[0]?.conclusion === 'success';
}

/* Whether the workflow can be started by hand, by its file on the default branch's head. */
async function canStartByHand(json: Json, repo: RepoAddress, name: string, workflow: Wf, head: string, timeoutMs: number): Promise<boolean> {
  const text = await textOf(json, repo, name, workflow, head, timeoutMs);
  return text !== null && startsByHand(text);
}

/* The workflows that can be started by hand and whose latest run on the default branch was green. */
async function qualifying(json: Json, repo: RepoAddress, name: string, active: Wf[], timeoutMs: number): Promise<Wf[]> {
  const main = await defaultBranchOf(json, repo, name, timeoutMs);
  const found: Wf[] = [];
  for (const workflow of active) {
    if (await canStartByHand(json, repo, name, workflow, main.head, timeoutMs) && await greenOnDefault(json, repo, name, workflow, main.branch, timeoutMs)) found.push(workflow);
  }
  return found;
}

/* The one workflow of found, or why there is none: not one that qualifies, or more than one, which is not chosen between. */
function oneOf(found: Wf[]): Chosen {
  if (!found.length) {
    return { no: 'No workflow of the repository can be started by hand (workflow_dispatch) with a latest run that was green on its default branch, and none made the latest version release, so Hornhoof has no release workflow. Add workflow_dispatch to the workflow that checks a release and let it go green on the default branch.' };
  }
  if (found.length > 1) {
    return { no: `More than one workflow can be started by hand and was green on the default branch last: ${found.map(nameOf).join('; ')}. Hornhoof does not guess which one releases. Until a repository can name its release workflow, only one workflow may have workflow_dispatch and a green latest run on the default branch.` };
  }
  return { workflow: found[0]! };
}

/* The commit a version tag names, where the tag is a lightweight one or an annotated one. None where the tag is gone. */
async function tagCommit(json: Json, repo: RepoAddress, name: string, tag: string, timeoutMs: number): Promise<string | null> {
  try {
    const ref = Ref.safeParse(await json(repo, name, `git/ref/tags/${tag.split('/').map(encodeURIComponent).join('/')}`, timeoutMs));
    if (!ref.success) throw new Unread('a version tag was not readable');
    if (ref.data.object.type === 'commit') return ref.data.object.sha;
    const annotated = Ref.safeParse(ref.data.object.type === 'tag' ? await json(repo, name, `git/tags/${ref.data.object.sha}`, timeoutMs) : null);
    return annotated.success && annotated.data.object.type === 'commit' ? annotated.data.object.sha : null;
  } catch (error) {
    if (error instanceof Absent) return null;
    throw error;
  }
}

/* The newest published release of a version, v1.2.3 or v2026.11.0, not a draft or a pre-release: its tag and when it came out. */
async function latestVersionRelease(json: Json, repo: RepoAddress, name: string, timeoutMs: number): Promise<{ tag: string; at: number } | null> {
  const listed = Releases.safeParse(await json(repo, name, 'releases?per_page=30', timeoutMs));
  if (!listed.success) throw new Unread('its list of releases was not readable');
  const versions = listed.data
    .filter(release => !release.draft && !release.prerelease && /^v\d/.test(release.tag_name))
    .map(release => ({ tag: release.tag_name, at: Date.parse(release.published_at ?? '') }))
    .filter(release => Number.isFinite(release.at));
  return versions.sort((a, b) => b.at - a.at)[0] ?? null;
}

/* Whether a run was going on when a release came out, give or take a minute. */
function wasGoingOn(run: Run, at: number): boolean {
  const [from, to] = [Date.parse(run.run_started_at ?? run.created_at ?? ''), Date.parse(run.updated_at ?? '')];
  return Number.isFinite(from) && Number.isFinite(to) && from - SLACK_MS <= at && at <= to + SLACK_MS;
}

/* The workflows with a run on the commit of the latest version release that was going on when the release was published. */
async function madeLatestRelease(json: Json, repo: RepoAddress, name: string, timeoutMs: number): Promise<number[]> {
  const release = await latestVersionRelease(json, repo, name, timeoutMs);
  const commit = release ? await tagCommit(json, repo, name, release.tag, timeoutMs) : null;
  if (!release || !commit) return [];
  const runs = await runsAt(json, repo, name, commit, '&status=success', timeoutMs);
  return [...new Set(runs.filter(run => wasGoingOn(run, release.at)).map(run => run.workflow_id))];
}

/* The release workflow of the repository. byHand is for starting it: it must then also be startable by hand. */
export async function releaseWorkflowOf(json: Json, repo: RepoAddress, name: string, byHand: boolean, timeoutMs: number): Promise<Chosen> {
  const active = await activeWorkflows(json, repo, name, timeoutMs);
  const ids = new Set(await madeLatestRelease(json, repo, name, timeoutMs));
  const made = active.filter(workflow => ids.has(workflow.id));
  return made.length ? await ofRelease(json, repo, name, made, byHand, timeoutMs) : oneOf(await qualifying(json, repo, name, active, timeoutMs));
}

/* The workflow that made the latest release: the one, or the several that were going on, named. */
async function ofRelease(json: Json, repo: RepoAddress, name: string, made: Wf[], byHand: boolean, timeoutMs: number): Promise<Chosen> {
  if (made.length > 1) return { no: `More than one workflow was going on when the latest version release was made: ${made.map(nameOf).join('; ')}. Hornhoof does not guess which one releases.` };
  const workflow = made[0]!;
  if (byHand && !(await canStartByHand(json, repo, name, workflow, (await defaultBranchOf(json, repo, name, timeoutMs)).head, timeoutMs))) {
    return { no: `${nameOf(workflow)} made the latest version release, but it cannot be started by hand: add workflow_dispatch to it, so that Hornhoof can start it for a release.` };
  }
  return { workflow };
}
