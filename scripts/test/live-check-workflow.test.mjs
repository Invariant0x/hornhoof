import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const read = name => readFileSync(fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url)), 'utf8');

/* Each job of a workflow as its text, by name. */
function jobs(workflow) {
  const body = workflow.slice(workflow.indexOf('\njobs:\n'));
  const parts = body.split(/^ {2}(?=[a-z][a-z-]*:$)/m).slice(1);
  return Object.fromEntries(parts.map(part => [part.slice(0, part.indexOf(':')), part]));
}

const images = jobs(read('images.yml'));
const proofs = jobs(read('live-check.yml'));

test('only the publish job can move a tag every machine reads', () => {
  for (const [name, text] of Object.entries(images)) {
    if (name !== 'publish') assert.doesNotMatch(text, /:latest\b|steps\.build\.outputs\.version\)?\s*\|\|.*tags|imagetools/, name);
  }
  assert.match(images.publish, /:latest/);
});

test('the publish job asks the live check before it moves a tag, and looks again after', () => {
  const asked = images.publish.indexOf('live-check-gate.js --commit "$GITHUB_SHA" --outputs');
  const moved = images.publish.indexOf('imagetools create');
  const again = images.publish.indexOf('live-check-gate.js --commit "$GITHUB_SHA" --tag latest');
  assert.ok(asked > 0 && moved > asked && again > moved, `${asked} ${moved} ${again}`);
});

test('the publish job moves exactly the images the gate judged, by digest, and the app image last', () => {
  assert.match(images.publish, /live-check-gate\.js --commit "\$GITHUB_SHA" --outputs "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(images.publish, /:\$GITHUB_SHA"/);
  const moved = ['hornhoof-updater "', 'hornhoof-node "', 'hornhoof "'].map(name => images.publish.indexOf(`move ${name}`));
  assert.ok(moved[0] > 0 && moved[1] > moved[0] && moved[2] > moved[1], moved.join(' '));
});

test('a commit on main whose version is out already moves nothing and fails nothing', () => {
  const steps = images.publish.split(/^ {6}- /m).slice(1);
  const look = steps.findIndex(step => /id: fresh\n/.test(step));
  assert.ok(look > 0, 'the publish job looks whether its version is out');
  assert.match(steps[look], /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/v\$version"/);
  assert.match(steps[look], /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.ok(images.publish.indexOf('id: fresh') < images.publish.indexOf('live-check-gate.js'), 'it looks before it asks the live check');
  for (const step of steps.slice(look + 1)) assert.match(step, /if: \$\{\{ steps\.fresh\.outputs\.version == 'new' \}\}/, step.split('\n')[0]);
});

test('the publish job runs only for a push to main, after the tests', () => {
  assert.match(images.publish, /if: \$\{\{ !cancelled\(\) && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && /);
  assert.match(images.publish, /needs: \[mark, test\]/);
});

test('images are built by hand only, under the tag of their commit alone', () => {
  assert.match(images.images, /if: \$\{\{ !cancelled\(\) && github\.event_name == 'workflow_dispatch' && /);
  assert.match(images.images, /tags: ghcr\.io\/invariant0x\/\$\{\{ matrix\.name \}\}:\$\{\{ github\.sha \}\}\n/);
});

test('a version is released only after its images went out', () => {
  assert.match(images.release, /needs: publish/);
});

test('a proof is published only from main, and only after the same door said yes', () => {
  assert.match(proofs.publish, /if: github\.ref == 'refs\/heads\/main'/);
  const judged = proofs.publish.indexOf('live-check-gate.js --commit');
  const pushed = proofs.publish.indexOf('--push');
  assert.ok(judged > 0 && pushed > judged, `${judged} ${pushed}`);
});

test('a proof is published on the runner and with the BuildKit the build variables name, as the images are', () => {
  assert.match(proofs.publish, /runs-on: \$\{\{ vars\.BUILD_RUNS_ON && fromJSON\(vars\.BUILD_RUNS_ON\) \|\| 'ubuntu-latest' \}\}\n/);
  assert.match(proofs.publish, /driver: \$\{\{ vars\.BUILDKIT_ENDPOINT && 'remote' \|\| 'docker-container' \}\}\n\s+endpoint: \$\{\{ vars\.BUILDKIT_ENDPOINT \}\}\n/);
});

test('the words of a proof never become part of a command', () => {
  assert.match(proofs.publish, /PROOF: \$\{\{ inputs\.proof \}\}/);
  assert.doesNotMatch(proofs.publish.replace(/PROOF: \$\{\{ inputs\.proof \}\}/, ''), /inputs\.proof/);
});

test('the jobs that may write to the registry build code without keeping the checkout token', () => {
  for (const job of [images.publish, proofs.publish]) {
    assert.match(job, /actions\/checkout@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+persist-credentials: false\n/);
  }
});

/* A BuildKit drops what it built once its store is full, and a new one starts empty: the cache beside each image brings
   back what a build made before, the layers the emulated platform takes long to make among them. */
test('images keep their build cache in the registry beside them, whatever BuildKit builds them, send none to GitHub, and fail no build that cannot write it', () => {
  const ref = 'type=registry,ref=ghcr.io/invariant0x/${{ matrix.name }}:buildcache';
  assert.ok(images.images.includes(`\n          cache-from: ${ref}\n`), 'cache-from');
  assert.ok(images.images.includes(`\n          cache-to: ${ref},mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true\n`), 'cache-to');
  assert.doesNotMatch(images.images, /type=gha/);
});

test('tests GitHub passed leave the mark on their commit, naming the passed commit they stood on when the change chose them', () => {
  const passed = images.passed;
  assert.ok(passed, 'a job named passed');
  assert.match(passed, /needs: \[mark, test\]\n/);
  assert.match(passed, /if: \$\{\{ needs\.test\.result == 'success' && github\.event_name != 'pull_request' \}\}\n/);
  assert.match(passed, /statuses: write\n/);
  assert.match(passed, /TESTS_SINCE: \$\{\{ needs\.mark\.outputs\.base \}\}\n/);
  assert.match(passed, /run: node scripts\/tests-mark\.mjs --leave\n/);
  for (const [name, text] of Object.entries(images)) {
    if (name !== 'passed') assert.doesNotMatch(text, /statuses: write/, name);
  }
});

/* Each step of a job as its text, in order. */
const steps = job => job.slice(job.indexOf('\n    steps:\n')).split(/(?<=\n) {6}- /).slice(1);

test('the first job chooses the tests only for a commit no mark proved, against the whole history, and a choice that fails leaves the whole suite', () => {
  const mark = images.mark;
  assert.match(mark, /fetch-depth: 0\n/);
  for (const name of ['parts', 'selection', 'base']) assert.match(mark, new RegExp(`\\n {6}${name}: \\$\\{\\{ steps\\.select\\.outputs\\.${name} \\}\\}\\n`));
  const [checkout, decide, node, prepare, select, ...rest] = steps(mark);
  assert.match(checkout, /^uses: actions\/checkout@/);
  assert.match(decide, /run: node scripts\/tests-mark\.mjs\n/);
  assert.match(node, /if: \$\{\{ steps\.mark\.outputs\.proved != 'true' \}\}\n[^]*uses: actions\/setup-node@/);
  assert.match(prepare, /if: \$\{\{ steps\.mark\.outputs\.proved != 'true' \}\}\n/);
  assert.match(prepare, /continue-on-error: true\n/);
  assert.match(prepare, /npm ci [^]*npm run build -w @hornhoof\/protocol\n[^]*npm run build -w @hornhoof\/node\n/);
  assert.doesNotMatch(prepare, /GITHUB_TOKEN/);
  assert.match(select, /id: select\n/);
  assert.match(select, /if: \$\{\{ steps\.prepare\.outcome == 'success' \}\}\n/);
  assert.match(select, /continue-on-error: true\n/);
  assert.match(select, /run: node scripts\/tests-select\.mjs\n/);
  assert.deepEqual(rest, []);
});

test('the tests run in the parts the first job chose, and as the whole suite in four parts when it chose none', () => {
  const test = images.test;
  assert.match(test, /part: \$\{\{ fromJSON\(needs\.mark\.outputs\.parts \|\| '\[1, 2, 3, 4\]'\) \}\}\n/);
  assert.match(test, /SELECTION: \$\{\{ needs\.mark\.outputs\.selection \}\}\n/);
  const named = Object.fromEntries(steps(test).filter(step => step.startsWith('name: ')).map(step => [step.slice(6, step.indexOf('\n')), step]));
  assert.deepEqual(Object.keys(named), ['Lint and release checks', 'Scripts and protocol', 'Server', 'Node', 'Web', 'The tests the change reaches']);
  assert.match(named['Lint and release checks'], /matrix\.part == 1 \}\}\n/);
  assert.match(named['Lint and release checks'], /run: \|\n {10}node scripts\/tests-select\.mjs --lint\n {10}npm run typecheck:tests\n {10}node scripts\/check-release\.mjs --local\n/);
  assert.match(named['Scripts and protocol'], /matrix\.part == 1 && !env\.SELECTION \}\}\n[^]*npm run test:release\n {10}npm test -w @hornhoof\/protocol\n/);
  for (const name of ['Server', 'Node', 'Web']) assert.match(named[name], /&& !env\.SELECTION \}\}\n[^]*--shard="\$PART"/, name);
  const chosen = named['The tests the change reaches'];
  assert.match(chosen, /if: \$\{\{ !cancelled\(\) && steps\.install\.outcome == 'success' && env\.SELECTION \}\}\n/);
  assert.match(chosen, /NUMBER: \$\{\{ matrix\.part \}\}\n/);
  assert.match(chosen, /npm run build -w @hornhoof\/node\n {10}node scripts\/tests-select\.mjs --run "\$NUMBER"\n/);
});
