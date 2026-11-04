import { FULL_SHA } from '../updates/registry.js';

/* What install.sh gets from a server CI did not build: no node image of that build is published. */
export const LOCAL_BUILD = 'local';
/* How long a person's curl waits for the registry before the installer gets the image by its tag. */
const WAIT_MS = 5_000;
/* Anyone may read install.sh, so a registry that has given no digest is asked again this often at most. */
const ASK_AGAIN_MS = 60_000;

type Lookup = { image: string; commit: string; digestOf: (tag: string) => Promise<string>; onError: (err: unknown) => void };

/* The node image install.sh starts for this server: the one CI built from the server's own commit. CI pushes every build
   under its commit's tag, while a version's tag moves when that version is built again and a build from a branch has
   none. As the update button does, it goes by that tag's digest, and by the tag itself while the registry cannot say:
   an image that is not there yet then stops the installer on the machine, which never gets another build instead. A
   commit built again is the same code, so a digest once known is kept. */
export function nodeImageOfBuild({ image, commit, digestOf, onError }: Lookup): () => Promise<string> {
  if (!FULL_SHA.test(commit)) return async () => LOCAL_BUILD;
  const repository = `${image}-node`;
  const byTag = `${repository}:${commit}`;
  let current = byTag;
  let asking = false;
  let askAt = Date.now();
  /* Settled when the registry has answered or the wait is over, so one who comes late waits only for what is left. */
  let answered: Promise<unknown> = Promise.resolve();

  const ask = () => {
    asking = true;
    const answer = digestOf(commit)
      .then(digest => {
        if (digest) current = `${repository}@${digest}`;
      })
      .catch(onError)
      .finally(() => {
        asking = false;
        askAt = Date.now() + ASK_AGAIN_MS;
      });
    answered = Promise.race([answer, new Promise(resolve => setTimeout(resolve, WAIT_MS).unref())]);
  };

  return async () => {
    if (current === byTag && !asking && Date.now() >= askAt) ask();
    await answered;
    return current;
  };
}
