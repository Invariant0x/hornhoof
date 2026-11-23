import { COMMIT_SHA } from '@hornhoof/protocol';
import {
  RECEIVE_ADVERTISEMENT, RECEIVE_RESULT, READ_MS, REFS_MAX_BYTES, RESULT_MAX_BYTES,
  answerOf, emptyPack, gitAddress, headersFor, pktLine, pktLines, refsAddress, type RepoAddress,
} from '../testruns/refs.js';

/* One ref of a repository to change: old is where the caller saw it (none where it makes the ref), next where it goes (none
   where it deletes the ref). The repository takes the change only while the ref is still at old. */
export type RefUpdate = { ref: string; old: string | null; next: string | null };
/* What each ref came to: none where it was changed, or why it was not. A problem is a push that came to nothing at all. */
export type Pushed = { refs: Record<string, string | null> } | { problem: string };
/* The same bound to one repository: what a caller that only pushes holds. */
export type Push = (updates: readonly RefUpdate[], options?: { pack?: Buffer }) => Promise<Pushed>;
export type RefPusher = (repo: RepoAddress, updates: readonly RefUpdate[], options?: { pack?: Buffer; timeoutMs?: number }) => Promise<Pushed>;

/* A branch, or a ref under Hornhoof's own refs/hornhoof/: never a tag, and no form git refuses. */
const REF = /^refs\/(?:heads|hornhoof)\/(?!\/|.*(?:\/\/|\.\.|@\{|\/\.|\.lock(?:\/|$)|\/$|\.$))[A-Za-z0-9._/-]+$/;
/* The main line is never deleted (#84). */
const MAIN = /^refs\/heads\/(?:main|master)$/;
/* One push carries this many refs at most: the answer to it is read whole. */
export const REFS_PER_PUSH = 100;

/* Why the push is no push Hornhoof makes, or null. */
function refused(updates: readonly RefUpdate[]): string | null {
  if (!updates.length) return 'There is nothing to change.';
  if (updates.length > REFS_PER_PUSH) return `A push changes ${REFS_PER_PUSH} refs at most.`;
  for (const { ref, old, next } of updates) {
    if (!REF.test(ref)) return `${JSON.stringify(ref)} is not a ref Hornhoof changes: only a branch, or a ref under refs/hornhoof/, never a tag.`;
    if (old === null && next === null) return `There is nothing to change in ${ref}.`;
    if ([old, next].some(sha => sha !== null && !COMMIT_SHA.test(sha))) return `${ref}: a commit is not one git takes.`;
    if (next === null && MAIN.test(ref)) return `${ref}: main is never deleted.`;
  }
  return null;
}

/* Why a push did not change a ref, or null where it did: a ref its answer does not name was not changed. */
export function refusalOf(pushed: Pushed, ref: string): string | null {
  if ('problem' in pushed) return pushed.problem;
  const reason = pushed.refs[ref];
  return reason === undefined ? 'its answer says nothing of this ref' : reason;
}

/* The pushed commands, the first with what the push asks of the repository: its answer per ref, and deleting where it says it
   can. A pack follows unless every command deletes, as git sends it. */
function requestOf(updates: readonly RefUpdate[], canDelete: boolean, pack?: Buffer): Buffer {
  const sha = updates.flatMap(u => [u.old, u.next]).find((s): s is string => s !== null)!;
  const zero = '0'.repeat(sha.length);
  const capabilities = `report-status${canDelete ? ' delete-refs' : ''}${sha.length === 64 ? ' object-format=sha256' : ''}`;
  const commands = updates.map(({ ref, old, next }, index) => pktLine(`${old ?? zero} ${next ?? zero} ${ref}${index === 0 ? `\0${capabilities}` : ''}\n`));
  const flush = Buffer.from('0000', 'latin1');
  const deletesOnly = updates.every(u => u.next === null);
  return Buffer.concat([...commands, flush, ...(deletesOnly ? [] : [pack ?? emptyPack(sha.length === 64 ? 'sha256' : 'sha1')])]);
}

/* What git said of each ref, or why it took none: its report names the pack first, then each ref ok or ng with its reason. */
function resultOf(lines: string[], updates: readonly RefUpdate[]): Pushed {
  const unpacked = lines.find(line => line.startsWith('unpack '));
  if (unpacked !== 'unpack ok') return { problem: `it refused: ${unpacked ?? 'it did not say it took the pack'}` };
  const refs: Record<string, string | null> = {};
  for (const { ref } of updates) {
    const refusal = lines.find(line => line.startsWith(`ng ${ref} `));
    refs[ref] = lines.includes(`ok ${ref}`) ? null : refusal ? refusal.slice(`ng ${ref} `.length) : 'its answer says nothing of this ref';
  }
  return { refs };
}

/* Changes the refs by a push git takes, as a node's would: its old value is named for each ref, so a ref that moved since the
   caller saw it is kept, not overwritten. Git's own protocol over HTTP, as the server's image has no git. It says what went
   wrong rather than throw, and never with the token, and follows no redirect with the push. */
export const pushRefs: RefPusher = async (repo, updates, { pack, timeoutMs = READ_MS } = {}) => {
  const why = refused(updates);
  if (why) return { problem: why };
  const cannot = (reason: string): Pushed => ({ problem: `Hornhoof could not change refs in ${repo.url}: ${reason}.` });
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const advertised = await answerOf(refsAddress(repo.url, 'git-receive-pack'), { headers: headersFor(repo.token, RECEIVE_ADVERTISEMENT), signal }, RECEIVE_ADVERTISEMENT, REFS_MAX_BYTES);
    if (typeof advertised === 'string') return cannot(advertised);
    const body = new Uint8Array(requestOf(updates, advertised.includes('delete-refs'), pack));
    const pushed = await answerOf(gitAddress(repo.url, 'git-receive-pack'), {
      method: 'POST', redirect: 'manual', signal, body,
      headers: { ...headersFor(repo.token, RECEIVE_RESULT), 'content-type': 'application/x-git-receive-pack-request' },
    }, RECEIVE_RESULT, RESULT_MAX_BYTES);
    if (typeof pushed === 'string') return cannot(pushed);
    const result = resultOf(pktLines(pushed), updates);
    return 'problem' in result ? cannot(result.problem) : result;
  } catch {
    return cannot(signal.aborted ? `it did not answer within ${timeoutMs} ms` : 'it could not be reached');
  }
};
