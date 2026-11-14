import { COMMIT_SHA, ownBranch } from '@hornhoof/protocol';

/* How long a repository may take to say where its branches are. */
const READ_MS = 30_000;
/* The most of a repository's answer the server reads: hundreds of thousands of refs. */
export const REFS_MAX_BYTES = 32 * 1024 * 1024;
const ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const HEADS = 'refs/heads/';

export type RepoAddress = { url: string; token: string };
/* A branch or tag by name, or the branch of a task. */
export type CommitWanted = { branch: string } | { task: number };
export type CommitAt = { branch: string; commitSha: string } | { problem: string };
export type CommitReader = (repo: RepoAddress, want: CommitWanted, timeoutMs?: number) => Promise<CommitAt>;
/* Every branch of a repository with the commit it is at now, by name. */
export type BranchesAt = { heads: Record<string, string> } | { problem: string };
export type BranchReader = (repo: RepoAddress, timeoutMs?: number) => Promise<BranchesAt>;

/* The refs in git's smart HTTP answer: lines that start with their length in bytes, in four hex digits, each an object
   name and a ref, the first with what the server can do after a NUL. A flush has a length and no line. */
function advertisedRefs(body: Buffer): Map<string, string> {
  const refs = new Map<string, string>();
  let at = 0;
  while (at + 4 <= body.length) {
    const size = Number.parseInt(body.toString('latin1', at, at + 4), 16);
    if (Number.isNaN(size)) break;
    if (size > 4) {
      const [sha, ref] = body.toString('utf8', at + 4, at + size).split('\0')[0]!.trimEnd().split(' ');
      if (ref && COMMIT_SHA.test(sha!)) refs.set(ref, sha!);
    }
    at += Math.max(size, 4);
  }
  return refs;
}

/* What git clone --branch would take: the branch, else the tag, and for an annotated tag the commit it points at. */
function commitIn(refs: Map<string, string>, want: CommitWanted): CommitAt {
  const names = () => [...refs.keys()].filter(ref => ref.startsWith(HEADS)).map(ref => ref.slice(HEADS.length));
  const found = 'branch' in want ? want : ownBranch(names(), want.task);
  if ('problem' in found) return found;
  const { branch } = found;
  const commitSha = refs.get(`${HEADS}${branch}`) ?? refs.get(`refs/tags/${branch}^{}`) ?? refs.get(`refs/tags/${branch}`);
  return commitSha ? { branch, commitSha } : { problem: `The repository has no branch ${branch}. Push it, or name the branch to test.` };
}

function refsAddress(url: string): URL {
  const at = new URL(url);
  at.pathname = `${at.pathname.replace(/\/+$/, '')}/info/refs`;
  at.search = '?service=git-upload-pack';
  return at;
}

/* The token goes as git sends it from a node. fetch drops it when a redirect leaves the repository's host. */
const headersFor = (token: string): Record<string, string> => ({
  accept: ADVERTISEMENT,
  'user-agent': 'git/hornhoof',
  ...(token ? { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {}),
});

/* An answer up to REFS_MAX_BYTES, read no further than that. */
async function within(res: Response): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > REFS_MAX_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/* The refs of a repository, asked of the repository itself. Git's own protocol over HTTP, as the server's image has no git.
   It says what went wrong rather than throw, and never with the token. */
async function refsOf(repo: RepoAddress, timeoutMs: number): Promise<Map<string, string> | { problem: string }> {
  const cannot = (why: string) => ({ problem: `Hornhoof could not read the branches of ${repo.url}: ${why}.` });
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(refsAddress(repo.url), { headers: headersFor(repo.token), signal });
    if (!res.ok) return cannot(`it answered ${res.status}`);
    if (!res.headers.get('content-type')?.startsWith(ADVERTISEMENT)) return cannot('the address is not a git repository');
    const body = await within(res);
    return body ? advertisedRefs(body) : cannot('its answer is too long');
  } catch {
    return cannot(signal.aborted ? `it did not answer within ${timeoutMs} ms` : 'it could not be reached');
  }
}

/* The commit a repository's branch is at now. */
export const readCommit = async (repo: RepoAddress, want: CommitWanted, timeoutMs = READ_MS): Promise<CommitAt> => {
  const refs = await refsOf(repo, timeoutMs);
  return refs instanceof Map ? commitIn(refs, want) : refs;
};

/* The branches in a repository's refs, by name; tags are no branches. */
export const headsIn = (refs: Map<string, string>): Record<string, string> =>
  Object.fromEntries([...refs].filter(([ref]) => ref.startsWith(HEADS)).map(([ref, sha]) => [ref.slice(HEADS.length), sha]));

/* Every branch a repository has now, with its commit. */
export const readBranches: BranchReader = async (repo, timeoutMs = READ_MS) => {
  const refs = await refsOf(repo, timeoutMs);
  return refs instanceof Map ? { heads: headsIn(refs) } : refs;
};
