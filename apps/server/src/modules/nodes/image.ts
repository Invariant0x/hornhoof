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
   commit's tag does not move, so a digest once known is kept. */
export function nodeImageOfBuild({ image, commit, digestOf, onError }: Lookup): () => Promise<string> {
  if (!FULL_SHA.test(commit)) return async () => LOCAL_BUILD;
  const repository = `${image}-node`;
  let pinned: string | null = null;
  let asking: Promise<void> | null = null;
  let askAt = 0;

  const ask = () =>
    digestOf(commit)
      .then(digest => {
        if (digest) pinned = `${repository}@${digest}`;
      })
      .catch(onError)
      .finally(() => {
        asking = null;
        askAt = Date.now() + ASK_AGAIN_MS;
      });

  return async () => {
    if (!pinned && !asking && Date.now() >= askAt) asking = ask();
    if (asking) await Promise.race([asking, new Promise(resolve => setTimeout(resolve, WAIT_MS).unref())]);
    return pinned ?? `${repository}:${commit}`;
  };
}
