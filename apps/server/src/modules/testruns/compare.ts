import { z } from 'zod';
import type { RepoAddress } from './refs.js';
import { bodyWithin } from './bounded.js';
import { githubName, githubRateLimit, GitHubRateLimited, type GitHubLimits, type RateLimit } from './github-limit.js';
import { githubCiReader, type CiReader } from './github-ci.js';
import { githubCiDispatcher, type CiDispatcher } from './github-dispatch.js';

export type { CiAt, CiReader } from './github-ci.js';
export type { CiDispatcher } from './github-dispatch.js';

/* A file GitHub lists with its counts and shows no patch of, as it does for a large file such as a migration's snapshot. */
type OmittedPatch = { path: string; additions: number; deletions: number };
/* A commit between the two, with the commits it was made on: a merge has two or more. */
type ComparedCommit = { sha: string; parents: string[] };
/* What a comparison proves however many files it lists: that head holds base, and every commit between them. */
type Lineage = { baseSha: string; headSha: string; commits?: ComparedCommit[] };
/* A comparison GitHub could not list whole names no paths. Where its status and commits still prove the line, it keeps that
   lineage, which proves no change of any file. */
export type CompareResult = { complete: true; baseSha: string; headSha: string; paths: string[]; diff: string; omitted?: OmittedPatch[]; commits?: ComparedCommit[] } | { complete: false; reason: string; lineage?: Lineage; rateLimit?: RateLimit };
type CompareRefs = { base: string; head: string };
export type CompareReader = (repo: RepoAddress, refs: CompareRefs, timeoutMs?: number) => Promise<CompareResult>;
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const File = z.object({ filename: z.string().min(1), previous_filename: z.string().optional(), patch: z.string().optional(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() });
const Commit = z.object({ sha: Sha, parents: z.array(z.object({ sha: Sha })).default([]) });
const Comparison = z.object({ base_commit: z.object({ sha: Sha }), commits: z.array(Commit), total_commits: z.number().int().nonnegative(), status: z.enum(['ahead', 'behind', 'diverged', 'identical']), files: z.array(File) });
/* GitHub lists at most this many files of a comparison, so a list this long may be cut short. */
const FILES_LISTED = 300;
const MoreCommits = z.object({ commits: z.array(Commit), total_commits: z.number().int().nonnegative() });
/* GitHub lists at most this many commits on a page of a comparison, and the server reads no more pages than this. */
const COMMITS_PER_PAGE = 250;
const COMMIT_PAGES = 20;

/* A patch GitHub shows is whole when it holds every line its counts name. One it shows none of is named, never read as empty. */
function completePatch(file: z.infer<typeof File>): boolean {
  if (file.patch === undefined) return true;
  const lines = file.patch.split('\n');
  return lines.filter(line => line.startsWith('+')).length === file.additions && lines.filter(line => line.startsWith('-')).length === file.deletions;
}

function comparisonHead(data: z.infer<typeof Comparison>): string | null {
  return data.commits.at(-1)?.sha ?? (data.status === 'identical' ? data.base_commit.sha : null);
}

function comparedPaths(file: z.infer<typeof File>): string[] {
  return file.previous_filename ? [file.filename, file.previous_filename] : [file.filename];
}

const patchOrName = (file: z.infer<typeof File>): string =>
  file.patch ?? `GitHub shows no patch of ${file.filename}: ${file.additions} lines added, ${file.deletions} removed.`;

/* The line is proved by the status and every commit; the change only by a file list GitHub did not cap and whole patches. */
function parsedComparison(body: unknown): CompareResult {
  const parsed = Comparison.safeParse(body);
  if (!parsed.success || parsed.data.total_commits !== parsed.data.commits.length) return { complete: false, reason: 'incomplete-comparison' };
  const data = parsed.data;
  if (data.status !== 'ahead' && data.status !== 'identical') return { complete: false, reason: 'not-an-ancestor' };
  const headSha = comparisonHead(data);
  if (!headSha) return { complete: false, reason: 'incomplete-comparison' };
  const lineage = { baseSha: data.base_commit.sha, headSha, commits: data.commits.map(commit => ({ sha: commit.sha, parents: commit.parents.map(parent => parent.sha) })) };
  if (data.files.length >= FILES_LISTED) return { complete: false, reason: 'too-many-files', lineage };
  if (!data.files.every(completePatch)) return { complete: false, reason: 'incomplete-comparison', lineage };
  const omitted = data.files.filter(file => file.patch === undefined).map(file => ({ path: file.filename, additions: file.additions, deletions: file.deletions }));
  return { complete: true, ...lineage, paths: data.files.flatMap(comparedPaths), diff: data.files.map(patchOrName).join('\n'), omitted };
}

/* That head holds base, as a whole comparison of the two proves it, or one whose files GitHub listed only in part. */
export function heldLineage(result: CompareResult, base: string, head: string): Lineage | null {
  const lineage = result.complete ? result : result.lineage;
  return lineage?.baseSha === base && lineage.headSha === head ? lineage : null;
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
  if (!response.ok) {
    const limit = githubRateLimit(response);
    await response.body?.cancel().catch(() => {});
    if (limit) throw new GitHubRateLimited(limit);
    throw new Error('unavailable');
  }
  const body = await bodyWithin(response, GITHUB_MAX_BYTES);
  if (!body) throw new TooLarge('too-large');
  return { body: JSON.parse(body.toString('utf8')) as unknown };
}

type JsonReader = typeof githubJson;

/* The commits of the pages after the first, as GitHub gives a long comparison: the files come only with the first page. */
async function laterCommits(json: JsonReader, repo: RepoAddress, path: string, first: z.infer<typeof Comparison>, timeoutMs: number): Promise<z.infer<typeof Commit>[] | null> {
  const commits = [...first.commits];
  for (let page = 2; commits.length < first.total_commits; page++) {
    if (page > COMMIT_PAGES) return null;
    const answer = await json(repo, `${path}&page=${page}`, timeoutMs);
    const more = answer ? MoreCommits.safeParse(answer.body) : null;
    if (!more?.success || !more.data.commits.length || more.data.total_commits !== first.total_commits) return null;
    commits.push(...more.data.commits);
  }
  return commits;
}

/* GitHub caps comparisons at 300 files and may omit a large/binary patch. A cap or missing lines mean an unknown change,
   never a clean diff, though the line may still be proved. Every commit between the two is read, page by page. */
async function compareAt(json: JsonReader, repo: RepoAddress, refs: CompareRefs, timeoutMs: number): Promise<CompareResult> {
  try {
    const path = `compare/${encodeURIComponent(refs.base)}...${encodeURIComponent(refs.head)}?per_page=${COMMITS_PER_PAGE}`;
    const answer = await json(repo, path, timeoutMs);
    if (!answer) return { complete: false, reason: 'unsupported-repository' };
    const first = Comparison.safeParse(answer.body);
    /* Only a full first page has more after it; a short one that counts more is no whole inventory. */
    if (!first.success || first.data.commits.length < COMMITS_PER_PAGE || first.data.total_commits <= first.data.commits.length) return parsedComparison(answer.body);
    const commits = await laterCommits(json, repo, path, first.data, timeoutMs);
    return commits ? parsedComparison({ ...first.data, commits }) : { complete: false, reason: 'incomplete-comparison' };
  } catch (error) {
    return error instanceof GitHubRateLimited
      ? { complete: false, reason: 'github-rate-limit', rateLimit: error.limit }
      : failed(error, 'compare');
  }
}

/* Whether a branch's commit is in the main line: GitHub's compare of the main line with it says behind or identical once every
   commit of it is there. None where GitHub cannot tell or the repository is not on GitHub. */
export type MergeReader = (repo: RepoAddress, refs: CompareRefs, timeoutMs?: number) => Promise<boolean | null>;
const Status = z.object({ status: z.enum(['ahead', 'behind', 'diverged', 'identical']) });

export function mergedIn(body: unknown): boolean | null {
  const parsed = Status.safeParse(body);
  return parsed.success ? parsed.data.status === 'behind' || parsed.data.status === 'identical' : null;
}

async function mergedAt(json: JsonReader, repo: RepoAddress, refs: CompareRefs, timeoutMs: number): Promise<boolean | null> {
  try {
    const answer = await json(repo, `compare/${encodeURIComponent(refs.base)}...${encodeURIComponent(refs.head)}?per_page=1`, timeoutMs);
    return answer ? mergedIn(answer.body) : null;
  } catch (error) {
    if (error instanceof GitHubRateLimited) throw error;
    return null;
  }
}

/* The files of a commit, every one: GitHub cuts a long list short and says so, and a cut list is no list. entries names what
   each file and submodule holds, its mode and content, where GitHub named that for every one. */
type TreeEntry = { path: string; type: string; mode: string; sha: string };
export type TreeAt = { complete: true; paths: string[]; entries?: TreeEntry[] } | { complete: false; reason: string };
export type TreeReader = (repo: RepoAddress, commitSha: string, timeoutMs?: number) => Promise<TreeAt>;
const Tree = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string().min(1), type: z.string(), mode: z.string().min(1).optional(), sha: z.string().min(1).optional() })) });

export function treePaths(body: unknown): TreeAt {
  const parsed = Tree.safeParse(body);
  if (!parsed.success || parsed.data.truncated) return { complete: false, reason: 'incomplete-tree' };
  const paths = parsed.data.tree.filter(entry => entry.type === 'blob').map(entry => entry.path);
  const entries = parsed.data.tree.filter(entry => entry.type !== 'tree').map(({ path, type, mode, sha }) => mode && sha ? { path, type, mode, sha } : null);
  return entries.every((entry): entry is TreeEntry => entry !== null) ? { complete: true, paths, entries } : { complete: true, paths };
}

async function treeAt(json: JsonReader, repo: RepoAddress, commitSha: string, timeoutMs: number): Promise<TreeAt> {
  if (!Sha.safeParse(commitSha).success) return { complete: false, reason: 'incomplete-tree' };
  try {
    const answer = await json(repo, `git/trees/${commitSha}?recursive=1`, timeoutMs);
    return answer ? treePaths(answer.body) : { complete: false, reason: 'unsupported-repository' };
  } catch (error) { return failed(error, 'tree'); }
}

const READ_MS = 10_000;

/* A server shares one request limit across every REST reader, including each page of a comparison or of a commit's checks. */
export function githubReaders(limits?: GitHubLimits): { readCompare: CompareReader; readMerged: MergeReader; readTree: TreeReader; readCi: CiReader; dispatchCi: CiDispatcher } {
  const json: JsonReader = limits ? (repo, path, timeout) => limits.request(repo, () => githubJson(repo, path, timeout)) : githubJson;
  return {
    readCompare: (repo, refs, timeout = READ_MS) => compareAt(json, repo, refs, timeout),
    readMerged: (repo, refs, timeout = READ_MS) => mergedAt(json, repo, refs, timeout),
    readTree: (repo, commit, timeout = READ_MS) => treeAt(json, repo, commit, timeout),
    readCi: githubCiReader(limits),
    dispatchCi: githubCiDispatcher(limits),
  };
}

export const { readCompare, readMerged, readTree, readCi } = githubReaders();
