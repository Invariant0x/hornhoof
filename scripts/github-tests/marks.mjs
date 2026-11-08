import { execFileSync } from 'node:child_process';

/* global fetch, AbortSignal */

/* The status a passed test run leaves on the commit it checked, Hornhoof's own or GitHub's. */
export const CONTEXT = 'hornhoof/tests';
const READ_MS = 20_000;
const COMMIT = /^[0-9a-f]{40}$/;
const env = process.env;

export const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const headers = () => ({ accept: 'application/vnd.github+json', authorization: `Bearer ${env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28' });

/* The mark on a commit: its state, none without one. */
async function markOn(sha) {
  const res = await fetch(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/commits/${sha}/status?per_page=100`, { headers: headers(), signal: AbortSignal.timeout(READ_MS) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return (await res.json()).statuses.find(status => status.context === CONTEXT)?.state ?? null;
}

/* The second parent of a merge that holds exactly what that parent holds, so that its mark speaks for the merge. A merge
   that brings in anything more, as a conflict resolved by hand does, has no such parent. */
function sameAsSecondParent(sha) {
  const parents = git('rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);
  if (parents.length !== 2) return null;
  return git('rev-parse', `${sha}^{tree}`) === git('rev-parse', `${parents[1]}^{tree}`) ? parents[1] : null;
}

/* The commit's own mark says it all when it has one; only a commit without one looks at its second parent. */
export async function proved(sha) {
  const own = await markOn(sha);
  if (own) return { proved: own === 'success', why: `${sha} has ${CONTEXT} = ${own}.` };
  const parent = sameAsSecondParent(sha);
  if (!parent) return { proved: false, why: `${sha} has no ${CONTEXT}.` };
  const theirs = await markOn(parent);
  return { proved: theirs === 'success', why: `${sha} has the tree of its second parent ${parent}, which has ${CONTEXT} = ${theirs ?? 'nothing'}.` };
}

/* What the mark says: the whole suite passed, or the tests the change since a passed commit reaches did. Either way every
   test of the commit has passed, so the mark speaks for the commit whatever another run of it compares it with. */
function description(since) {
  if (!since) return 'GitHub ran the full tests and they passed.';
  if (!COMMIT.test(since)) throw new Error(`${since} is not a commit`);
  return `GitHub ran the tests the change since ${since.slice(0, 12)} reaches, and that commit had passed.`;
}

/* The mark GitHub's own tests leave once every part of them passed, linking the run that passed them. TESTS_SINCE names the
   passed commit a run of only the tests the change reaches stood on; it is empty after the whole suite. */
export async function leave() {
  const res = await fetch(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/statuses/${env.GITHUB_SHA}`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({
      state: 'success',
      context: CONTEXT,
      description: description(env.TESTS_SINCE),
      target_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    }),
    signal: AbortSignal.timeout(READ_MS),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const why = env.TESTS_SINCE ? `the tests the change since ${env.TESTS_SINCE} reaches passed` : 'the full tests passed';
  process.stdout.write(`${env.GITHUB_SHA} has ${CONTEXT} = success, as ${why}: another run of it skips the tests.\n`);
}
