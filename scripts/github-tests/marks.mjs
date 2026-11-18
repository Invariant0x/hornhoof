import { execFileSync } from 'node:child_process';
import { checkRelease } from '../release/check.mjs';
import { readProject } from '../release/project.mjs';
import { beyondVersionAndNotes } from './release-commit.mjs';

/* global fetch, AbortSignal */

/* The status a passed test run leaves on the commit it checked, Hornhoof's own or GitHub's. */
export const CONTEXT = 'hornhoof/tests';
const READ_MS = 20_000;
const COMMIT = /^[0-9a-f]{40}$/;
const env = process.env;

/* What git prints, whole: a file's text keeps its last line ending, so a change there counts. */
const gitText = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
export const git = (...args) => gitText(...args).trim();

const headers = () => ({ accept: 'application/vnd.github+json', authorization: `Bearer ${env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28' });

/* The mark on a commit: its state, none without one. */
async function markOn(sha) {
  const res = await fetch(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/commits/${sha}/status?per_page=100`, { headers: headers(), signal: AbortSignal.timeout(READ_MS) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return (await res.json()).statuses.find(status => status.context === CONTEXT)?.state ?? null;
}

const parentsOf = sha => git('rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);

/* The second parent of a merge that holds exactly what that parent holds, so that its mark speaks for the merge. A merge
   that brings in anything more, as a conflict resolved by hand does, has no such parent. */
function sameAsSecondParent(sha, parents) {
  if (parents.length !== 2) return null;
  return git('rev-parse', `${sha}^{tree}`) === git('rev-parse', `${parents[1]}^{tree}`) ? parents[1] : null;
}

/* Each path the commit changes over its parent with the letter git gives it. A moved file is one deleted and one added. */
function changesOver(parent, sha) {
  const fields = gitText('diff', '--name-status', '-z', '--no-renames', parent, sha).split('\0');
  const changes = [];
  for (let at = 0; at + 1 < fields.length; at += 2) changes.push({ status: fields[at], path: fields[at + 1] });
  return changes;
}

/* The release check reads the versions and the notes, the only files such a commit changes, and runs in the tests' first
   part: so it runs here instead, in the checkout of exactly that commit. Null when it passed. */
function releaseCheckProblem(sha) {
  if (git('rev-parse', 'HEAD') !== sha) return `the checkout is not ${sha}, so its release check cannot run`;
  try {
    checkRelease(readProject(process.cwd()), { local: true });
    return null;
  } catch (error) {
    return `its release check fails: ${error.message}`;
  }
}

/* The one parent of a commit that changes only the versions and the release notes, so that its mark speaks for the release
   commit too; otherwise why not. A merge never has one: what it brings in was checked against another parent. */
function releaseParent(sha, parents) {
  if (parents.length !== 1) return { why: parents.length ? 'it is a merge' : 'it is the first commit' };
  const [parent] = parents;
  const beyond = beyondVersionAndNotes(changesOver(parent, sha), path => ({ before: gitText('show', `${parent}:${path}`), after: gitText('show', `${sha}:${path}`) }));
  if (beyond) return { why: beyond };
  const problem = releaseCheckProblem(sha);
  return problem ? { why: problem } : { parent };
}

async function borrowed(how, parent) {
  const theirs = await markOn(parent);
  return { proved: theirs === 'success', why: `${how} ${parent}, which has ${CONTEXT} = ${theirs ?? 'nothing'}.` };
}

/* The commit's own mark says it all when it has one. Only a commit without one takes the mark of the commit its tests stand
   on: the second parent of a merge with its tree, or the parent of a release commit. */
export async function proved(sha) {
  const own = await markOn(sha);
  if (own) return { proved: own === 'success', why: `${sha} has ${CONTEXT} = ${own}.` };
  const parents = parentsOf(sha);
  const second = sameAsSecondParent(sha, parents);
  if (second) return borrowed(`${sha} has the tree of its second parent`, second);
  const release = releaseParent(sha, parents);
  if (release.parent) return borrowed(`${sha} changes only versions and release notes, and its release check passed, over its parent`, release.parent);
  return { proved: false, why: `${sha} has no ${CONTEXT}, and takes none from a parent: ${release.why}.` };
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
