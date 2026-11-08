import { z } from 'zod';
import type { RepoAddress } from './refs.js';

export type CompareResult = { complete: true; baseSha: string; headSha: string; paths: string[]; diff: string } | { complete: false; reason: string };
export type CompareReader = (repo: RepoAddress, refs: { base: string; head: string }, timeoutMs?: number) => Promise<CompareResult>;
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const File = z.object({ filename: z.string().min(1), previous_filename: z.string().optional(), patch: z.string(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() });
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

function completePatch(file: z.infer<typeof File>): boolean {
  const lines = file.patch.split('\n');
  return lines.filter(line => line.startsWith('+')).length === file.additions && lines.filter(line => line.startsWith('-')).length === file.deletions;
}

function completeInventory(data: z.infer<typeof Comparison>): boolean {
  return data.total_commits === data.commits.length && data.files.every(completePatch);
}

function parsedComparison(body: unknown): CompareResult {
  const parsed = Comparison.safeParse(body);
  if (!parsed.success || !completeInventory(parsed.data)) return { complete: false, reason: 'incomplete-comparison' };
  const data = parsed.data;
  const headSha = data.commits.at(-1)?.sha ?? (data.status === 'identical' ? data.base_commit.sha : null);
  if (!headSha) return { complete: false, reason: 'incomplete-comparison' };
  return { complete: true, baseSha: data.base_commit.sha, headSha, paths: data.files.flatMap(f => f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]), diff: data.files.map(f => f.patch).join('\n') };
}

/* GitHub caps comparisons at 300 files and may omit a large/binary patch. A cap or
   missing lines mean unknown, never a clean diff. No redirect or remote error text
   can carry the repository token into a message. */
export const readCompare: CompareReader = async (repo, refs, timeoutMs = 10_000) => {
  const name = githubName(repo.url);
  if (!name) return { complete: false, reason: 'unsupported-repository' };
  try {
    const response = await fetch(`https://api.github.com/repos/${name}/compare/${encodeURIComponent(refs.base)}...${encodeURIComponent(refs.head)}`, {
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'hornhoof', 'x-github-api-version': '2022-11-28', ...(repo.token ? { authorization: `Bearer ${repo.token}` } : {}) },
    });
    if (!response.ok) { await response.body?.cancel(); return { complete: false, reason: 'compare-unavailable' }; }
    return parsedComparison(await response.json());
  } catch { return { complete: false, reason: 'compare-unavailable' }; }
};

