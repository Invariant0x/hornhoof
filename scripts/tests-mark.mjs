import { appendFileSync, readFileSync } from 'node:fs';
import { leave, proved } from './github-tests/marks.mjs';

/* The first job of .github/workflows/images.yml: whether a passed test run already proved the commit this workflow runs
   for, so GitHub need not run the tests again. Whatever it cannot tell, the tests run. Hornhoof's own full run leaves
   the mark, and so does GitHub's, through --leave, once all its parts passed. */

const env = process.env;

/* A pull request from a fork never takes a mark. A fork that is gone counts as one. */
const fromFork = event => Boolean(event.pull_request) && event.pull_request.head?.repo?.full_name !== event.repository?.full_name;

/* A full run, which a release asks for with the input full, runs every test whatever a mark says: a mark is a status, which any
   token with write access can post. */
const fullAsked = () => env.FULL_RUN === 'true';

async function decide() {
  if (fullAsked()) return { proved: false, why: 'A full run was asked for: it reads no mark.' };
  if (fromFork(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')))) return { proved: false, why: 'A pull request from a fork always runs the tests.' };
  return proved(env.GITHUB_SHA);
}

if (process.argv.includes('--leave')) {
  await leave().catch(err => { process.stderr.write(`Could not leave the mark: ${err.message}.\n`); process.exit(1); });
  process.exit(0);
}

const outcome = await decide().catch(err => ({ proved: false, why: `Could not read the mark: ${err.message}.` }));
appendFileSync(env.GITHUB_OUTPUT, `proved=${outcome.proved}\n`);
process.stdout.write(`${outcome.why} The tests ${outcome.proved ? 'are skipped' : 'run'}.\n`);
