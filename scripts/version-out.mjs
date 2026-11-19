import { appendFileSync, readFileSync } from 'node:fs';
import { versionOut } from './github-tests/version-out.mjs';

/* The step of the images, publish and release jobs of .github/workflows/images.yml that looks whether the version of its
   commit is out: node scripts/version-out.mjs images|publish|release. It writes version=new for a job to build, move or
   release it, version=out to leave it, and fails with why when the version cannot be this commit's or it cannot tell. */

const JOBS = ['images', 'publish', 'release'];
const env = process.env;
const [job, ...extra] = process.argv.slice(2);

if (!JOBS.includes(job) || extra.length) {
  process.stderr.write('Usage: version-out.mjs images|publish|release\n');
  process.exit(1);
}

let version = '';
const outcome = await (async () => {
  version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  return versionOut({ job, event: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA, version });
})().catch(error => ({ verdict: 'stop', why: `Could not tell whether version ${version || 'of package.json'} is out: ${error.message}. This job stops; run it again.` }));

process.stdout.write(`${outcome.why}\n`);
if (outcome.verdict === 'stop') process.exit(1);
appendFileSync(env.GITHUB_OUTPUT, `version=${outcome.verdict}\n`);
