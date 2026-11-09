import { z } from 'zod';
import type { RepoAddress } from './refs.js';

/* A file GitHub lists with its counts and shows no patch of, as it does for a large file such as a migration's snapshot. */
export type OmittedPatch = { path: string; additions: number; deletions: number };
export type CompareResult = { complete: true; baseSha: string; headSha: string; paths: string[]; diff: string; omitted?: OmittedPatch[] } | { complete: false; reason: string };
export type CompareReader = (repo: RepoAddress, refs: { base: string; head: string }, timeoutMs?: number) => Promise<CompareResult>;
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const File = z.object({ filename: z.string().min(1), previous_filename: z.string().optional(), patch: z.string().optional(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() });
const Comparison = z.object({ base_commit: z.object({ sha: Sha }), commits: z.array(z.object({ sha: Sha })), total_commits: z.number().int().nonnegative(), status: z.enum(['ahead', 'behind', 'diverged', 'identical']), files: z.array(File).max(299) });

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
  return { complete: true, baseSha: data.base_commit.sha, headSha, paths: data.files.flatMap(comparedPaths), diff: data.files.map(patchOrName).join('\n'), omitted };
}

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
  return { body: await response.json() };
}

/* GitHub caps comparisons at 300 files and may omit a large/binary patch. A cap or missing lines mean unknown, never a clean
   diff; an omitted patch keeps its path and is named in the diff. */
export const readCompare: CompareReader = async (repo, refs, timeoutMs = 10_000) => {
  try {
    const answer = await githubJson(repo, `compare/${encodeURIComponent(refs.base)}...${encodeURIComponent(refs.head)}`, timeoutMs);
    return answer ? parsedComparison(answer.body) : { complete: false, reason: 'unsupported-repository' };
  } catch { return { complete: false, reason: 'compare-unavailable' }; }
};

/* The files of a commit, every one: GitHub cuts a long list short and says so, and a cut list is no list. */
export type TreeAt = { complete: true; paths: string[] } | { complete: false; reason: string };
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
  } catch { return { complete: false, reason: 'tree-unavailable' }; }
};
