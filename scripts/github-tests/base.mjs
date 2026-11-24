/* The commit a run on GitHub chooses its tests against. Only one whose tests passed can be such a base: every test the change
   since it does not reach passed there on the same files, and those it reaches run now. A run of only those is then as good
   as the whole suite, and the mark it leaves says no more than that. */

/* How many commits back along the first parents a run looks for one whose tests passed. */
export const LOOK_BACK = 20;
const ZERO = /^0{40}$/;
const short = sha => sha.slice(0, 12);

/* Where the event says this commit comes from: the tip a push moved from, the base of a pull request, or the commit a run by
   hand left main at. Nothing for an event that names none. */
function startOf(name, event, sha, git) {
  if (name === 'push') return event.before && !ZERO.test(event.before) ? event.before : null;
  if (name === 'pull_request') return event.pull_request?.base?.sha ?? null;
  if (name === 'workflow_dispatch') return git('merge-base', sha, 'origin/main');
  return null;
}

function lineFrom(start, git) {
  try { return git('rev-list', '--first-parent', `--max-count=${LOOK_BACK}`, start).split('\n').filter(Boolean); } catch { return null; }
}

/* The nearest commit, from where the event says this one comes from back along its first parents, whose tests passed. A push
   of texts alone builds nothing and leaves no mark, so the commit before it may be the one. A run by hand of main itself starts
   at the commit and stands on the one before it that passed. Whatever this cannot tell, there is no base and the whole suite
   runs. A full run, which a release asks for, stands on no commit and reads no mark: a mark is a status, and any token with write
   access can post one, so a run that narrowed by it would prove less than the whole suite. */
export async function provedBase({ name, event, sha, full = false }, { git, proved }) {
  if (full) return { base: null, why: 'A full run was asked for: no commit narrows it.' };
  let start;
  try { start = startOf(name, event, sha, git); } catch { return { base: null, why: 'The commit this one left main at is not in the checkout.' }; }
  if (!start) return { base: null, why: `The ${name} event names no commit this one comes from.` };
  const line = lineFrom(start, git);
  if (!line) return { base: null, why: `${short(start)} is not in the checkout.` };
  try {
    for (const [back, commit] of line.entries()) if (await proved(commit)) return { base: commit, why: `${short(commit)} passed its tests, ${back ? `${back} commits before ${short(start)}, which this commit comes from` : 'and this commit comes from it'}.` };
  } catch (error) { return { base: null, why: `Could not read which commit passed: ${error.message}.` }; }
  return { base: null, why: `None of the ${line.length} commits up to ${short(start)} has passed tests.` };
}
