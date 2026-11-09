import { wiredPorts } from './author-check/wired.mjs';

/* Puts this checkout's dependencies and builds in place, as the author check does before it checks: nothing that is there
   already, the packages of its clone for a worktree of the same lockfile, else an install from the lockfile. */
const failed = await wiredPorts(process.cwd()).prepare();
if (failed) {
  process.stderr.write(`deps: ${failed}\n`);
  process.exitCode = 1;
}
