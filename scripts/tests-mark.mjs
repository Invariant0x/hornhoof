import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

/* global fetch, AbortSignal */

/* The first job of .github/workflows/images.yml: whether Hornhoof's own full test run already proved the commit this
   workflow runs for, so GitHub need not run the tests again. Whatever it cannot tell, the tests run. */

const CONTEXT = 'hornhoof/tests';
const READ_MS = 20_000;
const env = process.env;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/* A pull request from a fork never takes a mark. A fork that is gone counts as one. */
const fromFork = event => Boolean(event.pull_request) && event.pull_request.head?.repo?.full_name !== event.repository?.full_name;

/* The mark on a commit: its state, none without one. */
async function markOn(sha) {
  const res = await fetch(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/commits/${sha}/status?per_page=100`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(READ_MS),
  });
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
async function proved(sha) {
  const own = await markOn(sha);
  if (own) return { proved: own === 'success', why: `${sha} has ${CONTEXT} = ${own}.` };
  const parent = sameAsSecondParent(sha);
  if (!parent) return { proved: false, why: `${sha} has no ${CONTEXT}.` };
  const theirs = await markOn(parent);
  return { proved: theirs === 'success', why: `${sha} has the tree of its second parent ${parent}, which has ${CONTEXT} = ${theirs ?? 'nothing'}.` };
}

async function decide() {
  if (fromFork(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')))) return { proved: false, why: 'A pull request from a fork always runs the tests.' };
  return proved(env.GITHUB_SHA);
}

const outcome = await decide().catch(err => ({ proved: false, why: `Could not read the mark: ${err.message}.` }));
appendFileSync(env.GITHUB_OUTPUT, `proved=${outcome.proved}\n`);
process.stdout.write(`${outcome.why} The tests ${outcome.proved ? 'are skipped' : 'run'}.\n`);
