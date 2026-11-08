import { LIVE_CHECK_REFUSALS, type LiveCheckVerdict } from '@hornhoof/protocol/live-check';
import { LIVE_CHECK_UNREAD } from '../updates/live-check.js';
import { FULL_SHA } from '../updates/registry.js';

/* What install.sh gets from a server CI did not build: no node image of that build is published. */
export const LOCAL_BUILD = 'local';
/* How long a person's curl waits for the registry before the installer gets the image by its tag. */
const WAIT_MS = 5_000;
/* A build without a yes goes nowhere, so its person's curl waits longer for one than the registry takes to answer most times. */
const PROOF_WAIT_MS = 20_000;
/* Anyone may read install.sh, so a registry that has given no digest is asked again this often at most. */
const ASK_AGAIN_MS = 60_000;

type Lookup = { image: string; commit: string; part?: 'node' | 'updater'; digestOf: (tag: string) => Promise<string>; onError: (err: unknown) => void };
type Proof = { commit: string; free: boolean; verdictOf: (commit: string) => Promise<LiveCheckVerdict>; onError: (err: unknown) => void };

/* The node image install.sh starts for this server: the one CI built from the server's own commit. CI pushes every build
   under its commit's tag, while a version's tag moves when that version is built again and a build from a branch has
   none. As the update button does, it goes by that tag's digest, and by the tag itself while the registry cannot say:
   an image that is not there yet then stops the installer on the machine, which never gets another build instead. A
   commit built again is the same code, so a digest once known is kept. The updater image of the build, which install.sh starts
   next to the nodes on another computer, goes the same way. */
export function nodeImageOfBuild({ image, commit, part = 'node', digestOf, onError }: Lookup): () => Promise<string> {
  if (!FULL_SHA.test(commit)) return async () => LOCAL_BUILD;
  const repository = `${image}-${part}`;
  const byTag = `${repository}:${commit}`;
  let current = byTag;
  const lookUp = askedRarely(() => digestOf(commit).then(digest => { if (digest) current = `${repository}@${digest}`; }).catch(onError), () => current === byTag, WAIT_MS);
  return async () => {
    await lookUp();
    return current;
  };
}

/* Why install.sh gives no node of this server's build, in words it can say, whether a machine joins or moves its nodes, now or
   not. What the registry cannot say is no yes. */
export function nodeRefusalOfBuild({ commit, free, verdictOf, onError }: Proof): () => Promise<string> {
  if (free) return async () => '';
  let refusal = LIVE_CHECK_UNREAD;
  const lookUp = askedRarely(() => verdictOf(commit).then(verdict => { refusal = verdict.ok ? '' : LIVE_CHECK_REFUSALS[verdict.reason]; }).catch(err => { refusal = LIVE_CHECK_UNREAD; onError(err); }), () => refusal !== '', PROOF_WAIT_MS);
  return async () => {
    await lookUp();
    return refusal;
  };
}

/* One who comes late waits only for what is left, as what is settled when the registry has answered or the wait is over. */
function askedRarely(ask: () => Promise<void>, unsettled: () => boolean, waitMs: number): () => Promise<void> {
  let asking = false;
  let askAt = Date.now();
  let answered: Promise<unknown> = Promise.resolve();
  return async () => {
    if (unsettled() && !asking && Date.now() >= askAt) {
      asking = true;
      const answer = ask().finally(() => {
        asking = false;
        askAt = Date.now() + ASK_AGAIN_MS;
      });
      answered = Promise.race([answer, new Promise(resolve => setTimeout(resolve, waitMs).unref())]);
    }
    await answered;
  };
}
