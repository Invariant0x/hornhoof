/* The server's own build, as a worker installs it: the image of the server's commit and the node and updater images of
   the same commit, each by its digest. */
export type LeaderBuild = { version: string; tag: string; digest: string; nodeDigest: string; updaterDigest: string; commit: string };
/* The server's word that a worker may install now. until: when the word ends, in ISO, by the server's clock. leftMs: how
   long it still stands, so a machine whose clock differs from the server's counts the same stretch by its own. */
export type Go = { commit: string; until: string; leftMs: number };

/* How long a worker has to install once it was told to, and how long after a try that failed or ran out the same build
   is tried again. Both sides go by these, the server's app and a worker's keeper, so they live apart from either. */
export const FOLLOW_TURN_MS = 15 * 60_000;
export const FOLLOW_RETRY_MS = 6 * 3_600_000;
