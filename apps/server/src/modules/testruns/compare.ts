import { z } from 'zod';
import type { RepoAddress } from './refs.js';
import { bodyWithin } from './bounded.js';

/* A file GitHub lists with its counts and shows no patch of, as it does for a large file such as a migration's snapshot. */
type OmittedPatch = { path: string; additions: number; deletions: number };
/* A commit between the two, with the commits it was made on: a merge has two or more. */
type ComparedCommit = { sha: string; parents: string[] };
export type CompareResult = { complete: true; baseSha: string; headSha: string; paths: string[]; diff: string; omitted?: OmittedPatch[]; commits?: ComparedCommit[] } | { complete: false; reason: string };
export type CompareReader = (repo: RepoAddress, refs: { base: string; head: string }, timeoutMs?: number) => Promise<CompareResult>;
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const File = z.object({ filename: z.string().min(1), previous_filename: z.string().optional(), patch: z.string().optional(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() });
const Commit = z.object({ sha: Sha, parents: z.array(z.object({ sha: Sha })).default([]) });
const Comparison = z.object({ base_commit: z.object({ sha: Sha }), commits: z.array(Commit), total_commits: z.number().int().nonnegative(), status: z.enum(['ahead', 'behind', 'diverged', 'identical']), files: z.array(File).max(299) });
const MoreCommits = z.object({ commits: z.array(Commit), total_commits: z.number().int().nonnegative() });
/* GitHub lists at most this many commits on a page of a comparison, and the server reads no more pages than this. */
const COMMITS_PER_PAGE = 250;
const COMMIT_PAGES = 20;

function trustedHost(at: URL): boolean {
  return at.protocol === 'https:' && at.host === 'github.com' && !at.username && !at.password && !at.search && !at.hash;
}

function githubName(url: string): string | null {
  try {
    const at = new URL(url);
    if (!trustedHost(at)) return null;
    const parts = at.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '').split('/');
    return parts.length === 2 && parts.every(p => /^[a-z0-9][a-z0-9_.-]*$/i.test(p)) ? parts.join('/') : null;
  } catch { return null; }
}

/* A patch GitHub shows is whole when it holds every line its counts name. One it shows none of is named, never read as empty. */
function completePatch(file: z.infer<typeof File>): boolean {
  if (file.patch === undefined) return true;
  const lines = file.patch.split('\n');
  return lines.filter(line => line.startsWith('+')).length === file.additions && lines.filter(line => line.startsWith('-')).length === file.deletions;
}

function completeInventory(data: z.infer<typeof Comparison>): boolean {
  return data.total_commits === data.commits.length && data.files.every(completePatch);
}

function comparisonHead(data: z.infer<typeof Comparison>): string | null {
  return data.commits.at(-1)?.sha ?? (data.status === 'identical' ? data.base_commit.sha : null);
}

function comparedPaths(file: z.infer<typeof File>): string[] {
  return file.previous_filename ? [file.filename, file.previous_filename] : [file.filename];
}

const patchOrName = (file: z.infer<typeof File>): string =>
  file.patch ?? `GitHub shows no patch of ${file.filename}: ${file.additions} lines added, ${file.deletions} removed.`;

function parsedComparison(body: unknown): CompareResult {
  const parsed = Comparison.safeParse(body);
  if (!parsed.success || !completeInventory(parsed.data)) return { complete: false, reason: 'incomplete-comparison' };
  const data = parsed.data;
  if (data.status !== 'ahead' && data.status !== 'identical') return { complete: false, reason: 'not-an-ancestor' };
  const headSha = comparisonHead(data);
  if (!headSha) return { complete: false, reason: 'incomplete-comparison' };
  const omitted = data.files.filter(file => file.patch === undefined).map(file => ({ path: file.filename, additions: file.additions, deletions: file.deletions }));
  return { complete: true, baseSha: data.base_commit.sha, headSha, paths: data.files.flatMap(comparedPaths), diff: data.files.map(patchOrName).join('\n'), omitted,
    commits: data.commits.map(commit => ({ sha: commit.sha, parents: commit.parents.map(parent => parent.sha) })) };
}

/* GitHub's answers are read no further than this, as a repository's refs are: a larger one is too large to take. */
const GITHUB_MAX_BYTES = 32 * 1024 * 1024;
class TooLarge extends Error {}

/* Why an answer could not be taken: too large, or not there at all. */
const failed = (error: unknown, what: 'compare' | 'tree') => ({ complete: false as const, reason: `${what}-${error instanceof TooLarge ? 'too-large' : 'unavailable'}` });

/* A GitHub API answer for this repository, or null where it has none to give. No redirect or remote error text can carry the
   repository token into a message. */
async function githubJson(repo: RepoAddress, path: string, timeoutMs: number): Promise<{ body: unknown } | null> {
  const name = githubName(repo.url);
  if (!name) return null;
  const response = await fetch(`https://api.github.com/repos/${name}/${path}`, {
    redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'hornhoof', 'x-github-api-version': '2022-11-28', ...(repo.token ? { authorization: `Bearer ${repo.token}` } : {}) },
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('unavailable'); }
  const body = await bodyWithin(response, GITHUB_MAX_BYTES);
  if (!body) throw new TooLarge('too-large');
  return { body: JSON.parse(body.toString('utf8')) as unknown };
}

/* The commits of the pages after the first, as GitHub gives a long comparison: the files come only with the first page. */
async function laterCommits(repo: RepoAddress, path: string, first: z.infer<typeof Comparison>, timeoutMs: number): Promise<z.infer<typeof Commit>[] | null> {
  const commits = [...first.commits];
  for (let page = 2; commits.length < first.total_commits; page++) {
    if (page > COMMIT_PAGES) return null;
    const answer = await githubJson(repo, `${path}&page=${page}`, timeoutMs);
    const more = answer ? MoreCommits.safeParse(answer.body) : null;
    if (!more?.success || !more.data.commits.length || more.data.total_commits !== first.total_commits) return null;
    commits.push(...more.data.commits);
  }
  return commits;
}

/* GitHub caps comparisons at 300 files and may omit a large/binary patch. A cap or
   missing lines mean unknown, never a clean diff. Every commit between the two is read, page by page. */
export const readCompare: CompareReader = async (repo, refs, timeoutMs = 10_000) => {
  try {
    const path = `compare/${encodeURIComponent(refs.base)}...${encodeURIComponent(refs.head)}?per_page=${COMMITS_PER_PAGE}`;
    const answer = await githubJson(repo, path, timeoutMs);
    if (!answer) return { complete: false, reason: 'unsupported-repository' };
    const first = Comparison.safeParse(answer.body);
    /* Only a full first page has more after it; a short one that counts more is no whole inventory. */
    if (!first.success || first.data.commits.length < COMMITS_PER_PAGE || first.data.total_commits <= first.data.commits.length) return parsedComparison(answer.body);
    const commits = await laterCommits(repo, path, first.data, timeoutMs);
    return commits ? parsedComparison({ ...first.data, commits }) : { complete: false, reason: 'incomplete-comparison' };
  } catch (error) { return failed(error, 'compare'); }
};

/* Whether a branch's commit is in the main line: GitHub's compare of the main line with it says behind or identical once every
   commit of it is there. None where GitHub cannot tell or the repository is not on GitHub. */
export type MergeReader = (repo: RepoAddress, refs: { base: string; head: string }, timeoutMs?: number) => Promise<boolean | null>;
const Status = z.object({ status: z.enum(['ahead', 'behind', 'diverged', 'identical']) });

export function mergedIn(body: unknown): boolean | null {
  const parsed = Status.safeParse(body);
  return parsed.success ? parsed.data.status === 'behind' || parsed.data.status === 'identical' : null;
}

export const readMerged: MergeReader = async (repo, refs, timeoutMs = 10_000) => {
  try {
    const answer = await githubJson(repo, `compare/${encodeURIComponent(refs.base)}...${encodeURIComponent(refs.head)}?per_page=1`, timeoutMs);
    return answer ? mergedIn(answer.body) : null;
  } catch { return null; }
};

/* The files of a commit, every one: GitHub cuts a long list short and says so, and a cut list is no list. */
type TreeAt = { complete: true; paths: string[] } | { complete: false; reason: string };
export type TreeReader = (repo: RepoAddress, commitSha: string, timeoutMs?: number) => Promise<TreeAt>;
const Tree = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string().min(1), type: z.string() })) });

export function treePaths(body: unknown): TreeAt {
  const parsed = Tree.safeParse(body);
  if (!parsed.success || parsed.data.truncated) return { complete: false, reason: 'incomplete-tree' };
  return { complete: true, paths: parsed.data.tree.filter(entry => entry.type === 'blob').map(entry => entry.path) };
}

export const readTree: TreeReader = async (repo, commitSha, timeoutMs = 10_000) => {
  if (!Sha.safeParse(commitSha).success) return { complete: false, reason: 'incomplete-tree' };
  try {
    const answer = await githubJson(repo, `git/trees/${commitSha}?recursive=1`, timeoutMs);
    return answer ? treePaths(answer.body) : { complete: false, reason: 'unsupported-repository' };
  } catch (error) { return failed(error, 'tree'); }
};
