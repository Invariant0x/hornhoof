import { createHash } from 'node:crypto';
import { COMMIT_SHA, ownBranch } from '@hornhoof/protocol';
import { bodyWithin } from './bounded.js';

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

/* An address of git's smart HTTP beside the repository: the refs it advertises for a service, or where a push goes. */
function gitAddress(url: string, path: string, search = ''): URL {
  const at = new URL(url);
  at.pathname = `${at.pathname.replace(/\/+$/, '')}/${path}`;
  at.search = search;
  return at;
}

const refsAddress = (url: string, service = 'git-upload-pack'): URL => gitAddress(url, 'info/refs', `?service=${service}`);

/* The token goes as git sends it from a node. fetch drops it when a redirect leaves the repository's host. */
const headersFor = (token: string, accept = ADVERTISEMENT): Record<string, string> => ({
  accept,
  'user-agent': 'git/hornhoof',
  ...(token ? { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {}),
});

/* The refs of a repository, asked of the repository itself. Git's own protocol over HTTP, as the server's image has no git.
   It says what went wrong rather than throw, and never with the token. */
async function refsOf(repo: RepoAddress, timeoutMs: number): Promise<Map<string, string> | { problem: string }> {
  const cannot = (why: string) => ({ problem: `Hornhoof could not read the branches of ${repo.url}: ${why}.` });
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(refsAddress(repo.url), { headers: headersFor(repo.token), signal });
    if (!res.ok) return cannot(`it answered ${res.status}`);
    if (!res.headers.get('content-type')?.startsWith(ADVERTISEMENT)) return cannot('the address is not a git repository');
    const body = await bodyWithin(res, REFS_MAX_BYTES);
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

/* Every tag a repository has now, with the commit it is on: for an annotated tag the commit it points at. */
export type TagsAt = { tags: Record<string, string> } | { problem: string };
export type TagReader = (repo: RepoAddress, timeoutMs?: number) => Promise<TagsAt>;
const TAGS = 'refs/tags/';
export const tagsIn = (refs: Map<string, string>): Record<string, string> => {
  const tags: Record<string, string> = {};
  for (const [ref, sha] of refs) {
    if (!ref.startsWith(TAGS)) continue;
    const name = ref.slice(TAGS.length);
    if (name.endsWith('^{}')) tags[name.slice(0, -3)] = sha;
    else tags[name] ??= sha;
  }
  return tags;
};
export const readTags: TagReader = async (repo, timeoutMs = READ_MS) => {
  const refs = await refsOf(repo, timeoutMs);
  return refs instanceof Map ? { tags: tagsIn(refs) } : refs;
};

/* What making a branch came to: it is there now at the commit asked for, or why it is not. */
export type BranchMade = { made: true } | { problem: string };
export type BranchCreator = (repo: RepoAddress, branch: string, commit: string, timeoutMs?: number) => Promise<BranchMade>;

const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
/* The most of a push's answer the server reads: a few lines on the one branch. */
const RESULT_MAX_BYTES = 64 * 1024;
/* A branch name git takes as one ref: no spaces, control characters or the forms git refuses. */
const BRANCH = /^(?!\/|.*(?:\/\/|\.\.|@\{|\/\.|\.lock(?:\/|$)|\/$|\.$))[A-Za-z0-9._/-]+$/;

const pktLine = (text: string): Buffer => {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0'), 'latin1'), bytes]);
};

/* The lines of git's answer in its smart HTTP, each without its length and line end. */
function pktLines(body: Buffer): string[] {
  const lines: string[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const size = Number.parseInt(body.toString('latin1', at, at + 4), 16);
    if (Number.isNaN(size)) break;
    if (size > 4) lines.push(body.toString('utf8', at + 4, at + size).replace(/\n$/, ''));
    at += Math.max(size, 4);
  }
  return lines;
}

/* A pack with no objects in it: the commit is in the repository already, and git takes a new branch only with a pack. */
function emptyPack(hash: 'sha1' | 'sha256'): Buffer {
  const head = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  return Buffer.concat([head, createHash(hash).update(head).digest()]);
}

/* The push that makes ref at commit and nothing else: its old value none, so git takes it only where there is no such ref. */
function pushOf(ref: string, commit: string): Buffer {
  const sha256 = commit.length === 64;
  const command = `${'0'.repeat(commit.length)} ${commit} ${ref}\0report-status${sha256 ? ' object-format=sha256' : ''}\n`;
  return Buffer.concat([pktLine(command), Buffer.from('0000', 'latin1'), emptyPack(sha256 ? 'sha256' : 'sha1')]);
}

/* What a repository answered, up to max bytes, or why it is no answer of the kind asked for. */
async function answerOf(address: URL, init: RequestInit, type: string, max: number): Promise<Buffer | string> {
  const res = await fetch(address, init);
  if (res.status >= 300 && res.status < 400) return 'it moved, so give the repository its new address';
  if (res.status === 401 || res.status === 403) return `it answered ${res.status}, so its token may not push to it`;
  if (!res.ok) return `it answered ${res.status}`;
  if (!res.headers.get('content-type')?.startsWith(type)) return 'the address is not a git repository that takes pushes';
  return await bodyWithin(res, max) ?? 'its answer is too long';
}

/* Why the push did not make ref, as git said it, or null where it did. */
function pushRefused(lines: string[], ref: string): string | null {
  if (lines.includes(`ok ${ref}`)) return null;
  const refused = lines.find(line => line.startsWith(`ng ${ref} `)) ?? lines.find(line => line.startsWith('unpack ') && line !== 'unpack ok');
  return refused ? `it refused: ${refused.replace(`ng ${ref} `, '')}` : 'its answer says nothing of the branch';
}

/* Makes the branch at the commit, only where the repository has no branch of that name: a push git itself takes, as a node's
   would, its old value none, so a branch that is there, or one made meanwhile by another, is never moved. Git's own protocol
   over HTTP, as the server's image has no git. It says what went wrong rather than throw, and never with the token. It follows
   no redirect with the push, so the token stays with the repository's host. */
export const createBranch: BranchCreator = async (repo, branch, commit, timeoutMs = READ_MS) => {
  const cannot = (why: string) => ({ problem: `Hornhoof could not create the branch ${branch} in ${repo.url}: ${why}.` });
  if (!BRANCH.test(branch) || !COMMIT_SHA.test(commit)) return cannot('the branch name or the commit is not one git takes');
  const ref = `${HEADS}${branch}`;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const advertised = await answerOf(refsAddress(repo.url, 'git-receive-pack'), { headers: headersFor(repo.token, RECEIVE_ADVERTISEMENT), signal }, RECEIVE_ADVERTISEMENT, REFS_MAX_BYTES);
    if (typeof advertised === 'string') return cannot(advertised);
    if (advertisedRefs(advertised).has(ref)) return cannot('it has that branch already');
    const pushed = await answerOf(gitAddress(repo.url, 'git-receive-pack'), {
      method: 'POST', redirect: 'manual', signal, body: new Uint8Array(pushOf(ref, commit)),
      headers: { ...headersFor(repo.token, RECEIVE_RESULT), 'content-type': 'application/x-git-receive-pack-request' },
    }, RECEIVE_RESULT, RESULT_MAX_BYTES);
    if (typeof pushed === 'string') return cannot(pushed);
    const refused = pushRefused(pktLines(pushed), ref);
    return refused ? cannot(refused) : { made: true };
  } catch {
    return cannot(signal.aborted ? `it did not answer within ${timeoutMs} ms` : 'it could not be reached');
  }
};
