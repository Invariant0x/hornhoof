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

test('only the publish job can move a tag every machine reads', () => {
  for (const [name, text] of Object.entries(images)) {
    if (name !== 'publish') assert.doesNotMatch(text, /:latest\b|steps\.build\.outputs\.version\)?\s*\|\|.*tags|imagetools/, name);
  }
  assert.match(images.publish, /:latest/);
});

test('the publish job finds the images of its commit before it moves a tag, and looks at latest after', () => {
  const found = images.publish.indexOf('id: built');
  const moved = images.publish.indexOf('imagetools create');
  const again = images.publish.indexOf('Check that latest holds exactly those images');
  assert.ok(found > 0 && moved > found && again > moved, `${found} ${moved} ${again}`);
  assert.doesNotMatch(images.publish, /live-check|npm ci/);
});

test('the publish job reads each image of its commit by digest, and stops when one is missing', () => {
  const step = images.publish.slice(images.publish.indexOf('id: built'), images.publish.indexOf('Move the version and latest'));
  assert.match(step, /for part in app:hornhoof node:hornhoof-node updater:hornhoof-updater; do\n/);
  assert.match(step, /image="ghcr\.io\/invariant0x\/\$\{part#\*:\}:\$GITHUB_SHA"\n/);
  assert.match(step, /docker buildx imagetools inspect --format '\{\{json \.Manifest\}\}' "\$image"/);
  assert.match(step, /if ! \[\[ "\$digest" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]; then\n[^]*exit 1\n/);
  assert.match(step, /echo "\$\{part%%:\*\}=\$digest" >> "\$GITHUB_OUTPUT"\n/);
});

test('the publish job moves exactly those images, by digest, and the app image last, then finds them under latest', () => {
  for (const name of ['APP', 'NODE', 'UPDATER']) {
    const output = new RegExp(`${name}: \\$\\{\\{ steps\\.built\\.outputs\\.${name.toLowerCase()} \\}\\}\\n`, 'g');
    assert.equal(images.publish.match(output)?.length, 2, name);
  }
  assert.match(images.publish, /"ghcr\.io\/invariant0x\/\$1@\$2"; \}/);
  const moved = ['hornhoof-updater "', 'hornhoof-node "', 'hornhoof "'].map(name => images.publish.indexOf(`move ${name}`));
  assert.ok(moved[0] > 0 && moved[1] > moved[0] && moved[2] > moved[1], moved.join(' '));
  const held = ['hornhoof-updater "$UPDATER"', 'hornhoof-node "$NODE"', 'hornhoof "$APP"'].map(name => images.publish.indexOf(`held ${name}`));
  assert.ok(held[0] > moved[2] && held[1] > held[0] && held[2] > held[1], held.join(' '));
  assert.match(images.publish, /"ghcr\.io\/invariant0x\/\$1:latest" \| jq -r '\.digest \/\/ empty'[^]*if \[ "\$digest" != "\$2" \]; then\n[^]*exit 1\n/);
});

test('a commit on main whose version is out already moves nothing and fails nothing', () => {
  const steps = images.publish.split(/^ {6}- /m).slice(1);
  const look = steps.findIndex(step => /id: fresh\n/.test(step));
  assert.ok(look > 0, 'the publish job looks whether its version is out');
  assert.match(steps[look], /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/v\$version"/);
  assert.match(steps[look], /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.ok(images.publish.indexOf('id: fresh') < images.publish.indexOf('id: built'), 'it looks before it finds the images');
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

test('the publish job moves tags on the runner and with the BuildKit the build variables name, as the images are built', () => {
  assert.match(images.publish, /runs-on: \$\{\{ vars\.BUILD_RUNS_ON && fromJSON\(vars\.BUILD_RUNS_ON\) \|\| 'ubuntu-latest' \}\}\n/);
  assert.match(images.publish, /driver: \$\{\{ vars\.BUILDKIT_ENDPOINT && 'remote' \|\| 'docker-container' \}\}\n\s+endpoint: \$\{\{ vars\.BUILDKIT_ENDPOINT \}\}\n/);
});

test('the job that may move tags does not keep the checkout token', () => {
  assert.match(images.publish, /actions\/checkout@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+persist-credentials: false\n/);
});

test('images built with our own BuildKit keep their cache in it, and send none to GitHub', () => {
  assert.match(images.images, /cache-from: \$\{\{ !vars\.BUILDKIT_ENDPOINT && format\('type=gha,scope=\{0\}', matrix\.name\) \|\| '' \}\}\n/);
  assert.match(images.images, /cache-to: \$\{\{ !vars\.BUILDKIT_ENDPOINT && format\('type=gha,mode=max,scope=\{0\}', matrix\.name\) \|\| '' \}\}\n/);
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
