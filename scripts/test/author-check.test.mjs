import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { changedLines, countDuplicates, exitCodeOf, judgeFunctions, parseCrapEdn, parseLcov, parseTap, parseVitestJson, worstCrap } from '../author-check/judge.mjs';
import { buildPlan, decodePlan, encodePlan, grownFunctions, isCode, isDocument, isLintable, isSource, parseHunks, parseNameStatus } from '../author-check/plan.mjs';
import { adapterOf, impactEnvironment, selectTests } from '../author-check/select.mjs';
import { allUnavailable, runStages } from '../author-check/stages.mjs';
import { main, parseArgs, realPorts } from '../author-check/main.mjs';
import { complexityAt, prepare } from '../author-check/wired.mjs';
import { tracked } from './tracked-files.mjs';

const SHA = '1'.repeat(40), BASE = '2'.repeat(40);
const edn = (...rows) => `{:entries [\n${rows.map(([name, namespace, complexity, coverage, crap]) => `  {:name "${name.replaceAll('"', '\\"')}", :namespace "${namespace}", :complexity ${complexity}, :coverage ${coverage ?? 'nil'}, :crap ${crap ?? 'nil'}}`).join('\n')}\n]}\n`;
const vitestSuite = { id: 'node', root: 'apps/node', files: ['apps/node/test/**/*.test.ts'], run: { program: 'npx', args: ['--no-install', 'vitest', 'run'], cwd: 'apps/node' }, split: { kind: 'argv-files' }, finalChecks: [{ program: 'npx', args: ['--no-install', 'tsc', '-p', 'apps/node/tsconfig.json', '--noEmit'], cwd: '.' }] };
const opaqueSuite = { id: 'ruby', root: 'lib', files: ['lib/**/*_test.rb'], run: { program: 'sh', args: ['lib/run.sh'], cwd: '.' }, split: { kind: 'whole-package' }, finalChecks: [] };
const unit = file => ({ suiteId: 'node', file, selectionUnit: file });
const CHANGES = [{ path: 'apps/node/src/a.ts', kind: 'modified' }, { path: 'apps/node/test/a.test.ts', kind: 'added' }];
const REPORT = '/tmp/check/tests-node.json', LCOV = 'apps/node/coverage/lcov.info', CRAP = 'apps/node/.metrics/crap.edn';
const FILES = {
  [REPORT]: JSON.stringify({ numTotalTests: 5, numPassedTests: 4, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0 }),
  [LCOV]: 'TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nDA:3,4\nDA:9,1\nend_of_record\n',
  [CRAP]: edn(['a', 'a', 2, 100, 3]),
};
const grownIn = (cwd, name, cc, base = null) => ({ [cwd]: [{ namespace: 'a', name, cc, base }] });
function given({ changes = CHANGES, suites = [vitestSuite], selection, hunks = { 'apps/node/src/a.ts': [[1, 3]] }, grown = {}, scripts = {} } = {}) {
  return { sha: SHA, tmp: '/tmp/check', scripts, suites, plan: { sha: SHA, base: BASE, changes, hunks, grown },
    selection: selection ?? { packages: [{ packageId: 'node', mode: 'related', units: [unit('apps/node/test/a.test.ts')] }], notes: [] } };
}
function fake(answer = () => undefined, files = FILES) {
  const calls = [], lines = [], values = { ...files };
  return { calls, lines, log: line => lines.push(line), read: path => values[path] ?? null, write: (path, text) => { values[path] = text; }, mkdir: () => {},
    exec: async (program, args, options) => { calls.push({ program, args, cwd: options.cwd }); return answer(program, args) ?? { code: 0, output: '' }; } };
}
const stage = (result, name) => result.stages.find(item => item.name === name);
const named = (ports, program) => ports.calls.filter(call => call.program === program);
const isLine = (ports, pattern) => ports.lines.some(line => pattern.test(line));

test('a red lint is visible in its stage and the other stages still report', async () => {
  const ports = fake((program, args) => args.includes('eslint') ? { code: 1, output: '1 error' } : undefined);
  const result = await runStages(given(), ports);
  assert.deepEqual([stage(result, 'lint').status, stage(result, 'lint').exitCode], ['failed', 1]);
  assert.equal(stage(result, 'tests').status, 'passed');
  assert.equal(exitCodeOf(result.stages), 1);
  assert.ok(isLine(ports, /^STAGE lint failed exit=1/));
  assert.deepEqual(named(ports, 'npx').find(call => call.args.includes('eslint')).args, ['--no-install', 'eslint', 'apps/node/src/a.ts', 'apps/node/test/a.test.ts']);
});

test('a covered clean function does not fail, and a missing formatter is unavailable with its reason, not passed', async () => {
  const ports = fake();
  const result = await runStages(given(), ports);
  assert.deepEqual(result.stages.map(item => [item.name, item.status]), [['format', 'unavailable'], ['lint', 'passed'], ['types', 'passed'], ['tests', 'passed'], ['crapper', 'passed'], ['dryer', 'passed']]);
  assert.equal(exitCodeOf(result.stages), 0);
  assert.deepEqual(result.numbers, { tests: { passed: 4, failed: 0, skipped: 1, total: 5 }, changedLines: { covered: 2, total: 3 }, worstCrap: 3, dryerFlags: 0 });
  assert.ok(isLine(ports, /^STAGE format unavailable exit=null .*reason=repo_has_no_formatter/));
});

test('its record is exactly the shape the consumer of quality reads', async () => {
  const result = await runStages(given(), fake());
  const wanted = JSON.parse(readFileSync(new URL('./fixtures/author-check-record.json', import.meta.url)));
  assert.deepEqual(result.record, wanted);
});

test('a formatter the repository declares runs as the format stage', async () => {
  const ports = fake();
  const result = await runStages(given({ scripts: { 'format:check': 'x' } }), ports);
  assert.equal(stage(result, 'format').status, 'passed');
  assert.deepEqual(named(ports, 'npm')[0].args, ['run', '-s', 'format:check']);
});

test('CRAP of 10 or more on a new function fails with its numbers', async () => {
  const ports = fake(undefined, { ...FILES, [CRAP]: edn(['bad', 'a', 12, 40, 43.1], ['a', 'a', 2, 100, 3]) });
  const result = await runStages(given({ grown: grownIn('apps/node', 'bad', 12) }), ports);
  assert.deepEqual([stage(result, 'crapper').status, stage(result, 'crapper').exitCode], ['failed', 2]);
  assert.equal(result.numbers.worstCrap, 43.1);
  assert.equal(exitCodeOf(result.stages), 1);
  assert.ok(isLine(ports, /^FAILS a bad cc=12 base=new cov=40 crap=43\.1/));
});

test('CRAP of 10 or more fails when the complexity grew over the base', async () => {
  const ports = fake(undefined, { ...FILES, [CRAP]: edn(['bad', 'a', 12, 40, 43.1]) });
  const result = await runStages(given({ grown: grownIn('apps/node', 'bad', 12, 11) }), ports);
  assert.equal(stage(result, 'crapper').status, 'failed');
  assert.ok(isLine(ports, /^FAILS a bad cc=12 base=11 /));
});

test('a function whose complexity did not grow is shown as touched and does not fail', async () => {
  const ports = fake(undefined, { ...FILES, [CRAP]: edn(['old', 'a', 12, 40, 43.1], ['a', 'a', 2, 100, 3]) });
  const result = await runStages(given(), ports);
  assert.equal(stage(result, 'crapper').status, 'passed');
  assert.equal(result.numbers.worstCrap, 3);
  assert.equal(exitCodeOf(result.stages), 0);
  assert.ok(isLine(ports, /^TOUCHED a old cc=12 base=kept cov=40 crap=43\.1/));
});

test('dryer flags are counted and never fail the check', async () => {
  const ports = fake(program => program === 'dryer' ? { code: 0, output: 'DUPLICATE score=1.00\n  a:1-5\n  b:1-5\nDUPLICATE score=0.90\n  a:6-9\n  c:1-4\n' } : undefined);
  const result = await runStages(given(), ports);
  assert.equal(stage(result, 'dryer').status, 'passed');
  assert.equal(result.numbers.dryerFlags, 2);
  assert.equal(exitCodeOf(result.stages), 0);
});

test('a broken or missing dryer is unavailable and still does not fail the check', async () => {
  for (const [code, reason] of [[3, 'dryer_failed'], [null, 'dryer_missing']]) {
    const ports = fake(program => program === 'dryer' ? { code, output: '' } : undefined);
    const result = await runStages(given(), ports);
    assert.deepEqual([stage(result, 'dryer').status, stage(result, 'dryer').exitCode], ['unavailable', code]);
    assert.equal(result.numbers.dryerFlags, null);
    assert.equal(exitCodeOf(result.stages), 0);
    assert.ok(isLine(ports, new RegExp(`reason=${reason}`)));
  }
});

test('a language without an adapter runs its whole package by one command, with unknown numbers and no pass from coverage', async () => {
  const changes = [{ path: 'lib/a.py', kind: 'modified' }];
  const selection = { packages: [{ packageId: 'ruby', mode: 'whole-package', units: [] }], notes: [] };
  const ports = fake(undefined, { 'lib/.metrics/crap.edn': edn(['a', 'x', 2]), '.metrics/crap.edn': edn(['a', 'lib.a', 2]) });
  const result = await runStages(given({ changes, suites: [opaqueSuite], selection, hunks: { 'lib/a.py': [[1, 1]] } }), ports);
  assert.deepEqual(named(ports, 'sh'), [{ program: 'sh', args: ['lib/run.sh'], cwd: '.' }]);
  assert.equal(stage(result, 'tests').status, 'passed');
  assert.deepEqual(result.record.scope, { kind: 'package', paths: ['lib/a.py'] });
  assert.deepEqual([result.numbers.tests, result.numbers.changedLines, result.numbers.worstCrap], [null, null, null]);
  assert.equal(named(ports, 'crapper')[0].args[0], '--no-coverage');
  assert.equal(stage(result, 'crapper').status, 'unavailable');
  assert.ok(isLine(ports, /^STAGE crapper unavailable .*reason=no_coverage_adapter/));
  assert.equal(exitCodeOf(result.stages), 0);
});

test('tests run once, on the selected files, and crapper reads the coverage of that run', async () => {
  const ports = fake();
  await runStages(given(), ports);
  const runs = named(ports, 'npx').filter(call => call.args.includes('vitest'));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cwd, 'apps/node');
  assert.ok(runs[0].args.includes('--coverage.include=src/a.ts'));
  assert.ok(runs[0].args.includes('--coverage.reportOnFailure=true'));
  assert.ok(runs[0].args.includes(`--outputFile.json=${REPORT}`));
  assert.equal(runs[0].args.at(-1), './test/a.test.ts');
  assert.deepEqual(named(ports, 'crapper'), [{ program: 'crapper', args: ['--use-existing-coverage', 'src/a.ts'], cwd: 'apps/node' }]);
});

test('Vitest coverage includes are relative to its project root when the command runs at the repository root', async () => {
  const suite = { ...vitestSuite, run: { ...vitestSuite.run, cwd: '.', args: ['--no-install', 'vitest', 'run', '--config', 'vitest.product.config.mjs', '--project=@hornhoof/node'] } };
  const ports = fake(undefined, { [REPORT]: FILES[REPORT], 'coverage/lcov.info': 'SF:apps/node/src/a.ts\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n', '.metrics/crap.edn': FILES[CRAP] });
  const result = await runStages(given({ suites: [suite] }), ports);
  const run = named(ports, 'npx').find(call => call.args.includes('vitest'));
  assert.ok(run.args.includes('--coverage.include=src/a.ts'));
  assert.equal(run.args.includes('--coverage.include=apps/node/src/a.ts'), false);
  assert.deepEqual(result.numbers.changedLines, { covered: 3, total: 3 });
});

test('a suite run by node has its own coverage and counts from the same run', async () => {
  const suite = { id: 'scripts', root: 'scripts', files: ['scripts/test/*.test.mjs'], run: { program: 'node', args: ['--test'], cwd: '.' }, split: { kind: 'argv-files' }, finalChecks: [] };
  const changes = [{ path: 'scripts/a.mjs', kind: 'modified' }];
  const selection = { packages: [{ packageId: 'scripts', mode: 'whole-package', units: [{ suiteId: 'scripts', file: 'scripts/test/a.test.mjs', selectionUnit: 'scripts/test/a.test.mjs' }] }], notes: [] };
  const files = { '/tmp/check/tests-scripts.tap': '# tests 3\n# suites 0\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n', 'coverage/lcov.info': 'SF:scripts/a.mjs\nDA:1,1\nend_of_record\n', '.metrics/crap.edn': edn(['a', 'scripts.a', 1, 100, 1]) };
  const ports = fake(program => program === 'node' ? { code: 1, output: '' } : undefined, files);
  const result = await runStages(given({ changes, suites: [suite], selection, hunks: { 'scripts/a.mjs': [[1, 1]] } }), ports);
  const run = named(ports, 'node')[0];
  for (const flag of ['--experimental-test-coverage', '--test-coverage-include=scripts/a.mjs', '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info', '--test-reporter-destination=/tmp/check/tests-scripts.tap']) assert.ok(run.args.includes(flag), flag);
  assert.equal(run.args.at(-1), './scripts/test/a.test.mjs');
  assert.deepEqual(result.numbers.tests, { passed: 2, failed: 1, skipped: 0, total: 3 });
  assert.deepEqual(result.numbers.changedLines, { covered: 1, total: 1 });
  assert.deepEqual([stage(result, 'tests').status, stage(result, 'tests').exitCode], ['failed', 1]);
});

test('coverage of two selected suites sharing a working directory survives both executions', async () => {
  const node = { ...vitestSuite, run: { ...vitestSuite.run, cwd: '.' }, finalChecks: [] };
  const scripts = { id: 'scripts', root: 'scripts', run: { program: 'node', args: ['--test'], cwd: '.' }, split: { kind: 'argv-files' }, finalChecks: [] };
  const paths = ['apps/node/src/a.ts', 'scripts/a.mjs'];
  const selection = { packages: [{ packageId: 'node', mode: 'whole-package', units: [unit('apps/node/test/a.test.ts')] }, { packageId: 'scripts', mode: 'whole-package', units: [{ suiteId: 'scripts', file: 'scripts/test/a.test.mjs', selectionUnit: 'scripts/test/a.test.mjs' }] }], notes: [] };
  const ports = fake((program, args) => {
    if (args.includes('vitest')) ports.write('coverage/lcov.info', 'SF:apps/node/src/a.ts\nDA:1,1\nend_of_record\n');
    if (program === 'node') ports.write('coverage/lcov.info', 'SF:scripts/a.mjs\nDA:1,1\nend_of_record\n');
  }, { ...FILES, '/tmp/check/tests-scripts.tap': '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n', '.metrics/crap.edn': edn(['a', 'a', 2, 100, 2]) });
  const result = await runStages(given({ changes: paths.map(path => ({ path, kind: 'modified' })), suites: [node, scripts], selection, hunks: Object.fromEntries(paths.map(path => [path, [[1, 1]]])) }), ports);
  assert.deepEqual(result.numbers.changedLines, { covered: 2, total: 2 });
});

test('a mixed opaque suite keeps the total unknown while its execution can pass', async () => {
  const selection = { packages: [{ packageId: 'node', mode: 'related', units: [unit('apps/node/test/a.test.ts')] }, { packageId: 'ruby', mode: 'whole-package', units: [] }], notes: [] };
  const result = await runStages(given({ suites: [vitestSuite, opaqueSuite], selection }), fake());
  assert.equal(stage(result, 'tests').status, 'passed');
  assert.equal(result.numbers.tests, null);
});

test('a test report that cannot be read leaves the count unknown, never zero', async () => {
  const files = { ...FILES }; delete files[REPORT];
  const result = await runStages(given(), fake(undefined, files));
  assert.equal(result.numbers.tests, null);
  assert.equal(stage(result, 'tests').status, 'unavailable');
});

for (const [why, report] of [
  ['zero tests', { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 }],
  ['only skipped tests', { numTotalTests: 2, numPassedTests: 0, numFailedTests: 0, numPendingTests: 2, numTodoTests: 0 }],
  ['a reported failure with exit zero', { numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0 }],
]) {
  test(`the author check fails for ${why}`, async () => {
    const result = await runStages(given(), fake(undefined, { ...FILES, [REPORT]: JSON.stringify(report) }));
    assert.equal(stage(result, 'tests').status, 'failed');
    assert.equal(exitCodeOf(result.stages), 1);
  });
}

test('an empty package selection cannot fall through to the runner default suite', async () => {
  const input = given(); input.selection.packages[0].units = [];
  const ports = fake();
  const result = await runStages(input, ports);
  assert.equal(stage(result, 'tests').status, 'failed');
  assert.equal(ports.calls.filter(call => call.args.includes('vitest')).length, 0);
});

test('a changed source without any selected test scores on zero coverage of that fact', async () => {
  const selection = { packages: [], notes: [] };
  const files = { [CRAP]: edn(['bad', 'a', 4, 0, 20]) };
  const ports = fake(undefined, files);
  const result = await runStages(given({ selection, grown: grownIn('apps/node', 'bad', 4) }), ports);
  assert.equal(stage(result, 'tests').status, 'unavailable');
  assert.ok(isLine(ports, /^STAGE tests unavailable .*reason=nothing_selected/));
  assert.equal(stage(result, 'crapper').status, 'failed');
  assert.equal(result.numbers.changedLines, null);
  assert.equal(exitCodeOf(result.stages), 1);
});

test('when the selection could not run, crapper does not invent coverage and the check cannot pass', async () => {
  const ports = fake();
  const result = await runStages(given({ selection: { unavailable: 'selection_is_whole_suite', notes: [] } }), ports);
  assert.deepEqual([stage(result, 'tests').status, stage(result, 'crapper').status], ['unavailable', 'unavailable']);
  assert.ok(isLine(ports, /^STAGE crapper unavailable .*reason=no_coverage_measured/));
  assert.equal(named(ports, 'crapper').length, 0);
  assert.equal(exitCodeOf(result.stages), 2);
});

test('a missing or broken crapper leaves CRAP unknown and the check cannot pass', async () => {
  for (const [code, reason] of [[null, 'crapper_missing'], [3, 'crapper_failed']]) {
    const ports = fake(program => program === 'crapper' ? { code, output: '' } : undefined);
    const result = await runStages(given(), ports);
    assert.deepEqual([stage(result, 'crapper').status, stage(result, 'crapper').exitCode], ['unavailable', code]);
    assert.equal(result.numbers.worstCrap, null);
    assert.equal(exitCodeOf(result.stages), 2);
    assert.ok(isLine(ports, new RegExp(`reason=${reason}`)));
  }
});

test('a function whose CRAP is unknown leaves the stage unavailable with the worst number unknown', async () => {
  const ports = fake(undefined, { ...FILES, [CRAP]: edn(['a', 'a', 2, 100, 3], ['b', 'a', 2]) });
  const result = await runStages(given(), ports);
  assert.equal(stage(result, 'crapper').status, 'unavailable');
  assert.equal(result.numbers.worstCrap, null);
});

test('only what changed in code goes to each tool', async () => {
  const changes = [{ path: 'docs/a.md', kind: 'modified' }, { path: 'apps/node/src/gone.ts', kind: 'deleted' }, { path: 'apps/node/src/a.ts', kind: 'renamed', previousPath: 'apps/node/src/b.ts' }];
  const ports = fake();
  const result = await runStages(given({ changes }), ports);
  assert.deepEqual(named(ports, 'npx').find(call => call.args.includes('eslint')).args.slice(2), ['apps/node/src/a.ts']);
  assert.deepEqual(named(ports, 'dryer')[0].args, ['apps/node/src/a.ts']);
  assert.deepEqual(result.record.scope.paths, ['docs/a.md', 'apps/node/src/gone.ts', 'apps/node/src/a.ts']);
});

test('a change with no code has nothing to lint, type, score or compare, and that does not fail it', async () => {
  const ports = fake();
  const result = await runStages(given({ changes: [{ path: 'docs/a.md', kind: 'modified' }], hunks: {}, selection: { packages: [], notes: [] } }), ports);
  assert.deepEqual(result.stages.map(item => item.status), Array(6).fill('unavailable'));
  assert.equal(exitCodeOf(result.stages), 0);
  assert.equal(ports.calls.length, 0);
});

test('types run the checks of the suites touched and the test types once when TypeScript changed', async () => {
  const typecheck = { program: 'npm', args: ['run', 'typecheck:tests'], cwd: '.' };
  const suites = [{ ...vitestSuite, finalChecks: [...vitestSuite.finalChecks, typecheck] }];
  const ports = fake((program, args) => args.includes('tsc') ? { code: 2, output: '' } : undefined);
  const result = await runStages(given({ suites }), ports);
  assert.deepEqual(ports.calls.filter(call => call.args.includes('tsc') || call.args.includes('typecheck:tests')).map(call => call.args.at(-1)), ['--noEmit', 'typecheck:tests']);
  assert.deepEqual([stage(result, 'types').status, stage(result, 'types').exitCode], ['failed', 2]);
});

test('the test types of the repository run when TypeScript changed, whatever suite was touched', async () => {
  const ports = fake();
  await runStages(given({ scripts: { 'typecheck:tests': 'x' } }), ports);
  assert.equal(named(ports, 'npm').filter(call => call.args.includes('typecheck:tests')).length, 1);
  const quiet = fake();
  await runStages(given({ scripts: { 'typecheck:tests': 'x' }, changes: [{ path: 'apps/node/src/a.mjs', kind: 'modified' }] }), quiet);
  assert.equal(named(quiet, 'npm').length, 0);
});

test('a check that cannot even start is unavailable, not failed', async () => {
  const ports = fake((program, args) => args.includes('eslint') || args.includes('tsc') || args.includes('vitest') ? { code: null, output: '' } : undefined);
  const result = await runStages(given(), ports);
  assert.deepEqual(['lint', 'types', 'tests'].map(name => [stage(result, name).status, stage(result, name).exitCode]), Array(3).fill(['unavailable', null]));
  assert.equal(exitCodeOf(result.stages), 2);
});

test('notes of the selection reach the log', async () => {
  const ports = fake();
  const selection = { packages: [{ packageId: 'node', mode: 'related', units: [unit('apps/node/test/a.test.ts')] }], notes: ['migration_check_unsupported'] };
  await runStages(given({ selection }), ports);
  assert.ok(isLine(ports, /^NOTE migration_check_unsupported/));
});

test('selection evidence names the candidate, base, inventory and reasons separately from execution', async () => {
  const input = given(); input.selection.packages[0].reasons = [{ code: 'changed_test', path: 'apps/node/test/a.test.ts' }];
  const ports = fake();
  await runStages(input, ports);
  const line = ports.lines.find(item => item.startsWith('TEST_SELECTION '));
  assert.ok(line, 'the selection has a separate auditable receipt');
  const receipt = JSON.parse(line.slice('TEST_SELECTION '.length));
  assert.equal(receipt.commit, SHA); assert.equal(receipt.baseCommit, BASE);
  assert.equal(receipt.status, 'selected');
  assert.deepEqual(receipt.packages, input.selection.packages);
  assert.deepEqual(receipt.sourcePaths, CHANGES.map(change => change.path));
  assert.equal(receipt.fullSuiteComparator, 'unavailable');
  const unavailable = fake();
  await runStages(given({ selection: { unavailable: 'selection_failed', notes: [] } }), unavailable);
  assert.equal(JSON.parse(unavailable.lines.find(item => item.startsWith('TEST_SELECTION ')).slice('TEST_SELECTION '.length)).status, 'NOT_RUN');
});

test('stages with nothing to run can all be unavailable for one reason', () => {
  const result = allUnavailable(SHA, 'base_unreachable', [], line => assert.match(line, /reason=base_unreachable/));
  assert.deepEqual(result.stages.map(item => [item.status, item.exitCode]), Array(6).fill(['unavailable', null]));
  assert.deepEqual(result.numbers, { tests: null, changedLines: null, worstCrap: null, dryerFlags: null });
  assert.equal(exitCodeOf(result.stages), 2);
});

test('crap.edn entries read back with unknown numbers as null', () => {
  assert.deepEqual(parseCrapEdn(edn(['a', 'x.y', 2, 91.7, 9.25], ['b "q"', 'x', 1])), [
    { name: 'a', namespace: 'x.y', complexity: 2, coverage: 91.7, crap: 9.25 },
    { name: 'b "q"', namespace: 'x', complexity: 1, coverage: null, crap: null },
  ]);
  assert.deepEqual(parseCrapEdn('{:entries [\n]}\n'), []);
});

test('of functions of one name only the one that grew fails', () => {
  const judged = judgeFunctions([
    { name: 'f', namespace: 'x', complexity: 12, coverage: 0, crap: 150 },
    { name: 'f', namespace: 'x', complexity: 15, coverage: 0, crap: 240 },
    { name: 'g', namespace: 'x', complexity: 2, coverage: 100, crap: 2 },
    { name: 'h', namespace: 'x', complexity: 2, coverage: null, crap: null },
  ], [{ namespace: 'x', name: 'f', cc: 12, base: null }]);
  assert.deepEqual(judged.map(item => [item.name, item.complexity, item.verdict, item.baseCc]), [
    ['f', 12, 'fails', null], ['f', 15, 'touched', null], ['g', 2, 'ok', null], ['h', 2, 'unknown', null],
  ]);
  assert.equal(judgeFunctions([{ name: 'f', namespace: 'x', complexity: 12, coverage: 0, crap: 150 }], [{ namespace: 'x', name: 'f', cc: 12, base: 9 }])[0].baseCc, 9);
});

test('the worst number leaves out what is excused and is unknown when anything is', () => {
  const row = (crap, verdict) => ({ crap, verdict });
  assert.equal(worstCrap([row(5, 'ok'), row(40, 'touched')]), 5);
  assert.equal(worstCrap([row(5, 'ok'), row(40, 'fails')]), 40);
  assert.equal(worstCrap([row(5, 'ok'), row(null, 'unknown')]), null);
  assert.equal(worstCrap([row(40, 'touched')]), null);
  assert.equal(worstCrap([]), null);
});

test('changed lines count only what coverage calls executable', () => {
  const coverage = parseLcov('TN:\nSF:a.ts\nFNF:0\nDA:1,3\nDA:2,0\nDA:4,1\nend_of_record\nSF:b.ts\nDA:1,1\nend_of_record\n');
  assert.deepEqual(changedLines({ 'a.ts': [[1, 3]], 'b.ts': [[5, 1]] }, coverage, ['a.ts', 'b.ts']), { covered: 1, total: 2 });
  assert.equal(changedLines({ 'c.ts': [[1, 1]] }, coverage, ['c.ts']), null);
  assert.equal(changedLines({}, coverage, []), null);
});

test('without the lines of a plan the changed lines stay unknown', () => {
  assert.equal(changedLines(null, { 'a.ts': { 1: 1 } }, ['a.ts']), null);
});

test('test reports give counts or nothing', () => {
  assert.deepEqual(parseVitestJson('{"numTotalTests":7,"numPassedTests":4,"numFailedTests":1,"numPendingTests":1,"numTodoTests":1}'), { passed: 4, failed: 1, skipped: 2, total: 7 });
  assert.equal(parseVitestJson('not json'), null);
  assert.equal(parseVitestJson(null), null);
  assert.deepEqual(parseTap('# tests 6\n# pass 2\n# fail 1\n# cancelled 1\n# skipped 1\n# todo 1\n'), { passed: 2, failed: 2, skipped: 2, total: 6 });
  assert.equal(parseTap('# pass 2\n'), null);
  assert.equal(parseTap(null), null);
});

test('malformed test counts cannot become passing execution evidence', async () => {
  for (const report of [
    { numTotalTests: 2 },
    { numTotalTests: 2, numPassedTests: 3, numFailedTests: 0 },
    { numTotalTests: 2, numPassedTests: -1, numFailedTests: 0 },
    { numTotalTests: 2, numPassedTests: '2', numFailedTests: 0 },
  ]) {
    assert.equal(parseVitestJson(JSON.stringify(report)), null);
    const result = await runStages(given(), fake(undefined, { ...FILES, [REPORT]: JSON.stringify(report) }));
    assert.equal(stage(result, 'tests').status, 'unavailable');
    assert.equal(exitCodeOf(result.stages), 2);
  }
  for (const report of ['# tests 2\n# pass 2\n', '# tests 2\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n']) assert.equal(parseTap(report), null);
});

test('dryer output counts its findings', () => {
  assert.equal(countDuplicates('No duplicate candidates found.\n'), 0);
  assert.equal(countDuplicates('Wrote x\nDUPLICATE score=1.00\n  a\n  b\n'), 1);
});

test('name status of a diff reads without shell quoting', () => {
  assert.deepEqual(parseNameStatus('M\0a b.ts\0A\0c.ts\0D\0d.ts\0R097\0old.ts\0new.ts\0T\0e.ts\0'), [
    { kind: 'modified', path: 'a b.ts' }, { kind: 'added', path: 'c.ts' }, { kind: 'deleted', path: 'd.ts' },
    { kind: 'renamed', path: 'new.ts', previousPath: 'old.ts' }, { kind: 'modified', path: 'e.ts' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

test('hunks of a zero-context diff give the new side, and changed text is never taken for a header', () => {
  const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1 @@', '-a', '-b', '+++ b/fake.ts', '@@ -9 +8,2 @@', '-c', '+@@ -1 +1 @@', '+e', '@@ -20 +19,0 @@', '-f', 'diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-g', ''].join('\n');
  assert.deepEqual(parseHunks(diff), { 'x.ts': [[1, 1], [8, 2]] });
});

test('which paths are code, sources, lintable or documents', () => {
  assert.deepEqual(['a.ts', 'a.py', 'a.md', 'a.json'].map(isCode), [true, true, false, false]);
  assert.deepEqual(['src/a.ts', 'src/a.test.ts', 'test/a.ts', 'apps/x/tests/a.mjs', 'a.spec.tsx', 'a.md'].map(isSource), [true, false, false, false, false, false]);
  assert.deepEqual(['a.tsx', 'a.mjs', 'a.py'].map(isLintable), [true, true, false]);
  assert.deepEqual(['docs/a.md', 'README.md', 'templates/a.md', 'a.ts'].map(isDocument), [true, true, false, false]);
});

test('only what is new or grew, and could ever reach CRAP 10, counts as grown', () => {
  const row = (name, complexity) => ({ namespace: 'x', name, complexity });
  assert.deepEqual(grownFunctions([row('small', 2), row('fresh', 3), row('same', 9), row('more', 7), row('less', 4)], [row('same', 9), row('more', 6), row('less', 5)]), [
    { namespace: 'x', name: 'more', cc: 7, base: 6 }, { namespace: 'x', name: 'fresh', cc: 3, base: null },
  ]);
});

test('functions of one name are paired with the base from the most complex down', () => {
  const row = complexity => ({ namespace: 'x', name: 'f', complexity });
  assert.deepEqual(grownFunctions([row(12), row(15)], [row(15)]), [{ namespace: 'x', name: 'f', cc: 12, base: null }]);
});

test('a plan compares the commit with its base, with a moved file under its new path', () => {
  const asked = [];
  const git = args => {
    asked.push(args);
    if (args.includes('--name-status')) return 'M\0apps/node/src/a.ts\0A\0apps/node/src/new.ts\0D\0apps/node/src/gone.ts\0R100\0apps/node/src/old.ts\0apps/node/src/moved.ts\0M\0apps/node/test/a.test.ts\0M\0other.ts\0';
    if (args.includes('-U0')) return '--- a/apps/node/src/a.ts\n+++ b/apps/node/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    throw new Error('unexpected');
  };
  const groups = [];
  const complexity = (cwd, commit, files) => {
    groups.push([cwd, commit === SHA ? 'sha' : 'base', files]);
    return commit === SHA ? [{ namespace: 'a', name: 'f', complexity: 5 }] : [{ namespace: 'a', name: 'f', complexity: cwd === '.' ? 5 : 4 }];
  };
  const plan = buildPlan({ sha: SHA, base: BASE, cwdOf: path => path.startsWith('apps/node/') ? 'apps/node' : '.' }, { git, complexity });
  assert.deepEqual(plan.hunks, { 'apps/node/src/a.ts': [[1, 1]] });
  assert.deepEqual(groups, [
    ['apps/node', 'sha', [{ path: 'src/a.ts', from: 'apps/node/src/a.ts' }, { path: 'src/new.ts', from: 'apps/node/src/new.ts' }, { path: 'src/moved.ts', from: 'apps/node/src/moved.ts' }]],
    ['apps/node', 'base', [{ path: 'src/a.ts', from: 'apps/node/src/a.ts' }, { path: 'src/moved.ts', from: 'apps/node/src/old.ts' }]],
    ['.', 'sha', [{ path: 'other.ts', from: 'other.ts' }]],
    ['.', 'base', [{ path: 'other.ts', from: 'other.ts' }]],
  ]);
  assert.deepEqual(plan.grown, { 'apps/node': [{ namespace: 'a', name: 'f', cc: 5, base: 4 }] });
  assert.deepEqual([plan.sha, plan.base, plan.changes.length], [SHA, BASE, 6]);
  assert.ok(asked.every(args => args.includes(BASE) && args.includes(SHA)));
});

test('a plan of new files only never asks for a base it does not need', () => {
  const git = args => (args.includes('--name-status') ? 'A\0a.ts\0' : '');
  const commits = [];
  buildPlan({ sha: SHA, base: BASE, cwdOf: () => '.' }, { git, complexity: (_cwd, commit) => { commits.push(commit); return []; } });
  assert.deepEqual(commits, [SHA]);
});

const FULL_PLAN = {
  sha: SHA, base: BASE,
  changes: [{ kind: 'modified', path: 'apps/node/src/a b.ts' }, { kind: 'added', path: 'apps/node/test/a.test.ts' }, { kind: 'deleted', path: 'docs/gone.md' }, { kind: 'renamed', previousPath: 'x/old.ts', path: 'x/new.ts' }],
  hunks: { 'apps/node/src/a b.ts': [[1, 3], [20, 1]], 'apps/node/test/a.test.ts': [[1, 9]], 'x/new.ts': [[5, 2]] },
  grown: { 'apps/node': [{ namespace: 'a b', name: 'f', cc: 12, base: 9 }, { namespace: 'a b', name: 'g', cc: 3, base: null }, { namespace: 'c', name: 'Guard.run', cc: 4, base: null }] },
};

test('a plan is plain words an agent can copy, and reads back', () => {
  const text = encodePlan(FULL_PLAN);
  assert.ok(text.startsWith(`v1 ${SHA.slice(0, 12)} ${BASE.slice(0, 12)};M apps/node/src/a b.ts @1+3,20;A apps/node/test/a.test.ts;D docs/gone.md;R x/old.ts>x/new.ts @5+2;`), text);
  assert.ok(text.includes(';G apps/node a b f=12<9,g=3;G apps/node c Guard.run=4;#'), text);
  const plan = decodePlan(text);
  assert.deepEqual(plan.changes, FULL_PLAN.changes);
  assert.deepEqual(plan.hunks, { 'apps/node/src/a b.ts': [[1, 3], [20, 1]], 'x/new.ts': [[5, 2]] });
  assert.deepEqual(plan.grown, FULL_PLAN.grown);
  assert.deepEqual([plan.sha, plan.base], [SHA.slice(0, 12), BASE.slice(0, 12)]);
});

test('a plan without lines says so, so changed lines stay unknown', () => {
  const plan = decodePlan(encodePlan({ ...FULL_PLAN, hunks: null }));
  assert.equal(plan.hunks, null);
  assert.deepEqual(plan.changes, FULL_PLAN.changes);
});

test('any change to the words of a plan is refused', () => {
  const text = encodePlan(FULL_PLAN);
  for (const broken of [text.replace('@1+3', '@1+4'), text.replace(/#.*$/, '#00000000'), text.replace(';#', ';'), 'nonsense', '', text.replace('v1', 'v2').replace(/#.*$/, '#')]) assert.throws(() => decodePlan(broken), /plan_invalid/, broken);
});

test('a broken body with a right digest is refused too', () => {
  const sign = body => `${body};#${createHash('sha256').update(body).digest('hex').slice(0, 8)}`;
  for (const body of ['v2 111111111111 222222222222', `v1 ${'1'.repeat(12)} ${'2'.repeat(12)};Q what`, `v1 ${'1'.repeat(12)} ${'2'.repeat(12)};G apps/node a nothing`]) assert.throws(() => decodePlan(sign(body)), /plan_invalid/, body);
});

test('a name a plan cannot hold is refused when it is made, not read wrong later', () => {
  for (const path of ["a'b.ts", 'a;b.ts', 'a>b.ts', 'a@b.ts']) assert.throws(() => encodePlan({ ...FULL_PLAN, changes: [{ kind: 'modified', path }] }), /plan_unsupported/, path);
  assert.throws(() => encodePlan({ ...FULL_PLAN, grown: { '.': [{ namespace: 'a', name: 'b,c', cc: 3, base: null }] } }), /plan_unsupported/);
});

test('arguments need exact commits', () => {
  assert.deepEqual(parseArgs(['--sha', SHA, '--base', BASE]), { sha: SHA, base: BASE, plan: null, allowWhole: false });
  assert.deepEqual(parseArgs(['--sha', SHA, '--base', BASE, '--plan', 'p', '--allow-whole']), { sha: SHA, base: BASE, plan: 'p', allowWhole: true });
  for (const bad of [[], ['--sha', 'abc', '--base', BASE], ['--sha', SHA], ['--sha', SHA, '--base', BASE, '--what'], ['--sha', SHA, '--base', BASE, '--plan']]) assert.equal(parseArgs(bad), null, bad.join(' '));
});

const MANIFEST = {
  defaultProfile: 'fast', profiles: [{ id: 'fast', requiredSuiteIds: ['node', 'scripts', 'ruby'] }, { id: 'final', requiredSuiteIds: ['node', 'scripts', 'ruby', 'pg'] }],
  impact: { adapter: 'typescript', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'x' } },
  mutation: { status: 'unsupported', language: 'typescript', reason: 'x' },
  suites: [vitestSuite, { id: 'scripts', root: 'scripts', files: ['scripts/test/*.test.mjs'], run: { program: 'node', args: ['--test'], cwd: '.' }, split: { kind: 'argv-files' }, finalChecks: [] }, opaqueSuite,
    { id: 'pg', root: 'apps/node', files: ['apps/node/test/**/*.pg.ts'], run: { program: 'npx', args: ['--no-install', 'vitest', 'run'], cwd: 'apps/node' }, split: { kind: 'argv-files' }, finalChecks: [] }],
};
const UNITS = [unit('apps/node/test/a.test.ts'), { suiteId: 'scripts', file: 'scripts/test/a.test.mjs', selectionUnit: 'scripts/test/a.test.mjs' }, { suiteId: 'ruby', file: 'lib/a_test.rb', selectionUnit: 'lib' }, { suiteId: 'pg', file: 'apps/node/test/a.pg.ts', selectionUnit: 'apps/node/test/a.pg.ts' }];
function selector(answer = {}) {
  const seen = { collected: [], select: [], collectCalls: 0 };
  return { seen, listTestUnits: () => UNITS,
    collectVitestImpact: async (input, collect) => { seen.vitest = input; if (input.changed.length) await collect(input.changed[0]); return { adapter: 'vitest-related', status: 'ready', units: [] }; },
    collect: async changed => { seen.collectCalls += 1; seen.collected = changed; return { projects: [], all: [], selected: [] }; },
    selectAffectedTests: input => { seen.select.push(input); return { status: 'ready', problems: [], packages: input.changes.length ? [{ packageId: 'node', mode: 'related', units: [UNITS[0]], reasons: [] }] : [], ...answer }; } };
}

test('the fast profile decides the suites and their kinds', () => {
  const environment = impactEnvironment(MANIFEST, UNITS);
  assert.deepEqual(environment.packages.map(item => [item.id, item.language]), [['node', 'typescript'], ['scripts', 'typescript'], ['ruby', 'sh']]);
  assert.equal(environment.inventory.some(item => item.suiteId === 'pg'), false);
  assert.deepEqual([adapterOf(vitestSuite.run), adapterOf({ program: 'node', args: ['--test'] }), adapterOf(opaqueSuite.run)], ['vitest', 'node-test', null]);
});

test('the selector gets the code changes and one collection for all of them', async () => {
  const ports = selector();
  const changes = [{ path: 'apps/node/src/a.ts', kind: 'modified' }, { path: 'apps/node/src/b.ts', kind: 'modified' }, { path: 'apps/node/src/c.ts', kind: 'deleted' }, { path: 'docs/a.md', kind: 'modified' }];
  const result = await selectTests({ changes, manifest: MANIFEST, tracked: [], allowWhole: false }, ports);
  assert.deepEqual(ports.seen.select[0].changes.map(change => change.path), ['apps/node/src/a.ts', 'apps/node/src/b.ts', 'apps/node/src/c.ts']);
  assert.deepEqual(ports.seen.vitest.changed, ['apps/node/src/a.ts', 'apps/node/src/b.ts']);
  assert.deepEqual(ports.seen.vitest.requiredSuiteIds, ['node']);
  assert.equal(ports.seen.collectCalls, 1);
  assert.deepEqual(ports.seen.collected, ['apps/node/src/a.ts', 'apps/node/src/b.ts']);
  assert.deepEqual(result.packages.map(item => item.packageId), ['node']);
  assert.ok(result.notes.some(note => note.includes('docs/a.md')));
});

test('a change in a package without an adapter takes that package whole and nothing else', async () => {
  const ports = selector();
  const result = await selectTests({ changes: [{ path: 'lib/a.rb', kind: 'modified' }], manifest: MANIFEST, tracked: [], allowWhole: false }, ports);
  assert.deepEqual(result.packages.map(item => [item.packageId, item.mode]), [['ruby', 'whole-package']]);
  assert.deepEqual(ports.seen.select[0].changes, []);
  assert.equal(ports.seen.select[0].environment.packages.some(item => item.id === 'ruby'), false);
});

test('a changed node-test file takes its package without asking the Vitest graph to collect it', async () => {
  const ports = selector();
  const changes = [{ path: 'apps/node/src/a.ts', kind: 'modified' }, { path: 'scripts/test/a.test.mjs', kind: 'modified' }];
  const result = await selectTests({ changes, manifest: MANIFEST, tracked: [], allowWhole: false }, ports);
  assert.deepEqual(result.packages.map(item => [item.packageId, item.mode]), [['node', 'related'], ['scripts', 'whole-package']]);
  assert.deepEqual(ports.seen.vitest.changed, ['apps/node/src/a.ts']);
});

test('a policy and a changed node-test file select the same package only once', async () => {
  const scripts = { packageId: 'scripts', mode: 'whole-package', units: [UNITS[1]], reasons: [{ code: 'full_package_rule', path: 'apps/node/src/a.ts' }] };
  const result = await selectTests({ changes: [{ path: 'apps/node/src/a.ts', kind: 'modified' }, { path: 'scripts/test/a.test.mjs', kind: 'modified' }], manifest: MANIFEST, tracked: [], allowWhole: false }, selector({ packages: [scripts] }));
  assert.equal(result.packages.length, 1);
  assert.deepEqual(result.packages[0].units, [UNITS[1]]);
});

test('a selection of the whole suite stays unavailable until it is asked for', async () => {
  const whole = { packages: ['node', 'scripts', 'ruby'].map(packageId => ({ packageId, mode: 'whole-package', units: [] })) };
  const changes = [{ path: 'package.json', kind: 'modified' }];
  assert.equal((await selectTests({ changes, manifest: MANIFEST, tracked: [], allowWhole: false }, selector(whole))).unavailable, 'selection_is_whole_suite');
  assert.equal((await selectTests({ changes, manifest: MANIFEST, tracked: [], allowWhole: true }, selector(whole))).packages.length, 3);
});

test('a problem of the selection makes tests unavailable, and a migration without a check is only a note', async () => {
  const changes = [{ path: 'apps/node/src/a.ts', kind: 'modified' }];
  assert.equal((await selectTests({ changes, manifest: MANIFEST, tracked: [], allowWhole: false }, selector({ status: 'blocked', problems: [{ code: 'new_test_unmapped' }] }))).unavailable, 'new_test_unmapped');
  const noted = await selectTests({ changes, manifest: MANIFEST, tracked: [], allowWhole: false }, selector({ status: 'blocked', problems: [{ code: 'migration_check_unsupported' }] }));
  assert.equal(noted.unavailable, undefined);
  assert.ok(noted.notes.includes('migration_check_unsupported'));
});

function runner(overrides = {}) {
  const lines = [], calls = [];
  return { lines, calls, log: line => lines.push(line), head: () => SHA, hasCommit: () => false, exists: () => true,
    exec: async (program, args) => { calls.push([program, ...args]); return { code: 0, output: '' }; },
    prepare: async () => null, makePlan: () => ({ sha: SHA, base: BASE, changes: [], hunks: {}, grown: {} }),
    check: async () => ({ code: 0 }), ...overrides };
}
const ARGS = ['--sha', SHA, '--base', BASE];
const ON_RUN = { HH_TEST_PART: '1' };
const recordOf = lines => JSON.parse(lines.find(line => line.startsWith('AUTHOR_CHECK ')).slice('AUTHOR_CHECK '.length));

test('outside run_tests the command checks nothing and prints the line to run there', async () => {
  const ports = runner();
  assert.equal(await main(ARGS, {}, ports), 0);
  assert.deepEqual(ports.calls, []);
  const printed = ports.lines.find(line => line.startsWith('npm run -s check:author -- '));
  assert.ok(printed.includes(`--sha ${SHA} --base ${BASE} --plan '`));
  assert.ok(printed.endsWith("'"));
  assert.ok(printed.length < 4000);
});

test('a plan too long for one command is refused with the reason', async () => {
  const big = Array.from({ length: 4000 }, (_, index) => ({ path: `apps/node/src/${index}-${Math.random()}.ts`, kind: 'modified' }));
  const ports = runner({ makePlan: () => ({ sha: SHA, base: BASE, changes: big, hunks: {}, grown: {} }) });
  assert.equal(await main(ARGS, {}, ports), 2);
  assert.ok(ports.lines.some(line => line.includes('plan_too_long')));
  assert.equal(ports.lines.some(line => line.startsWith('npm run')), false);
});

test('a plan too long with its lines goes without them, and says what that costs', async () => {
  const hunks = { 'src/a.ts': Array.from({ length: 2000 }, (_, index) => [index * 3 + 1, 1]) };
  const ports = runner({ makePlan: () => ({ sha: SHA, base: BASE, changes: [{ kind: 'modified', path: 'src/a.ts' }], hunks, grown: {} }) });
  assert.equal(await main(ARGS, {}, ports), 0);
  assert.ok(ports.lines.some(line => line.includes('changedLines')));
  const printed = ports.lines.find(line => line.startsWith('npm run -s check:author -- '));
  assert.ok(printed.includes(' nolines;M src/a.ts;#'));
});

test('a plan that cannot be written is reported', async () => {
  const ports = runner({ makePlan: () => ({ sha: SHA, base: BASE, changes: [{ kind: 'modified', path: "a'b.ts" }], hunks: {}, grown: {} }) });
  assert.equal(await main(ARGS, {}, ports), 2);
  assert.ok(ports.lines.some(line => line.includes('plan_unsupported')));
});

test('a plan that cannot be made outside the run is reported', async () => {
  const ports = runner({ makePlan: () => { throw new Error('crapper_unavailable'); } });
  assert.equal(await main(ARGS, {}, ports), 2);
  assert.ok(ports.lines.some(line => line.includes('crapper_unavailable')));
});

test('bad arguments say how to use the command', async () => {
  const ports = runner();
  assert.equal(await main([], ON_RUN, ports), 2);
  assert.ok(ports.lines.some(line => line.includes('--sha')));
});

test('on a run any other commit than the one asked for checks nothing', async () => {
  const ports = runner({ head: () => BASE, check: async () => assert.fail('must not check') });
  assert.equal(await main(ARGS, ON_RUN, ports), 2);
  assert.ok(ports.lines.some(line => line.includes('reason=sha_mismatch')));
  assert.equal(recordOf(ports.lines).checkCommit, SHA);
});

test('on a run with neither a base nor a plan every stage is unavailable and it is not a pass', async () => {
  const ports = runner({ check: async () => assert.fail('must not check') });
  assert.equal(await main(ARGS, ON_RUN, ports), 2);
  assert.ok(ports.lines.some(line => /^STAGE tests unavailable .*reason=base_unreachable/.test(line)));
  assert.deepEqual(recordOf(ports.lines).stages.map(item => item.status), Array(6).fill('unavailable'));
});

test('on a run a plan for another commit or base is refused', async () => {
  for (const other of [{ sha: BASE }, { base: SHA }]) {
    const plan = encodePlan({ sha: SHA, base: BASE, changes: [], hunks: {}, grown: {}, ...other });
    const ports = runner({ check: async () => assert.fail('must not check') });
    assert.equal(await main([...ARGS, '--plan', plan], ON_RUN, ports), 2);
    assert.ok(ports.lines.some(line => line.includes('reason=plan_invalid')), JSON.stringify(other));
  }
});

test('on a run a reachable base needs no plan', async () => {
  let given_ = null;
  const ports = runner({ hasCommit: () => true, check: async (args, plan) => { given_ = [args.sha, plan.base]; return { code: 0 }; } });
  assert.equal(await main(ARGS, ON_RUN, ports), 0);
  assert.deepEqual(given_, [SHA, BASE]);
});

test('on a run the plan given reaches the check and the code of the check is the code of the command', async () => {
  const plan = encodePlan({ sha: SHA, base: BASE, changes: CHANGES, hunks: {}, grown: {} });
  let seen = null;
  const ports = runner({ check: async (args, value) => { seen = value; return { code: 1 }; } });
  assert.equal(await main([...ARGS, '--plan', plan], ON_RUN, ports), 1);
  assert.deepEqual(seen.changes, CHANGES);
  assert.deepEqual([seen.sha, seen.base], [SHA, BASE]);
});

test('on a run a failed preparation leaves every stage unavailable', async () => {
  const plan = encodePlan({ sha: SHA, base: BASE, changes: CHANGES, hunks: {}, grown: {} });
  const ports = runner({ prepare: async () => 'prepare_failed', check: async () => assert.fail('must not check') });
  assert.equal(await main([...ARGS, '--plan', plan], ON_RUN, ports), 2);
  assert.ok(ports.lines.some(line => line.includes('reason=prepare_failed')));
  assert.deepEqual(recordOf(ports.lines).scope.paths, CHANGES.map(change => change.path));
});

test('the real command runner reports the exit code, its output, and a program that does not start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-author-'));
  try {
    const seen = [];
    const ports = realPorts(dir, text => seen.push(text));
    const done = await ports.exec(process.execPath, ['-e', 'console.log("hello"); process.exit(3)'], { cwd: '.' });
    assert.deepEqual([done.code, done.output.trim()], [3, 'hello']);
    assert.match(seen.join(''), /hello/);
    assert.equal((await ports.exec('no-such-program-at-all', [], { cwd: '.' })).code, null);
    writeFileSync(join(dir, 'x.txt'), 'text');
    assert.equal(ports.read('x.txt'), 'text');
    assert.equal(ports.read('none.txt'), null);
    assert.equal(ports.exists('x.txt'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real git port reads commits, a plan of a real repository included', { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-author-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    git('init', '-q');
    writeFileSync(join(dir, 'a.md'), 'one\n');
    git('add', '.'); git('commit', '-qm', 'one');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'a.md'), 'one\ntwo\n');
    git('add', '.'); git('commit', '-qm', 'two');
    const sha = git('rev-parse', 'HEAD');
    const ports = realPorts(dir, () => {});
    assert.equal(ports.head(), sha);
    assert.equal(ports.hasCommit(base), true);
    assert.equal(ports.hasCommit('3'.repeat(40)), false);
    const plan = buildPlan({ sha, base, cwdOf: () => '.' }, { git: ports.git, complexity: () => assert.fail('no source changed') });
    assert.deepEqual(plan.grown, {});
    assert.deepEqual(plan.changes, [{ kind: 'modified', path: 'a.md' }]);
    assert.deepEqual(plan.hunks, { 'a.md': [[2, 1]] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preparing a run does only what the harness left undone', async () => {
  const asked = [];
  const ports = have => ({ exists: path => have.includes(path), exec: async (program, args) => { asked.push([program, ...args].join(' ')); return { code: 0 }; } });
  const preparing = async have => { asked.length = 0; assert.equal(await prepare(ports(have)), null); return [...asked]; };
  assert.deepEqual(await preparing([]), ['npm ci --ignore-scripts', 'npm run -s prepare', 'npm run -s build -w @hornhoof/protocol', 'npm run -s build -w @hornhoof/node']);
  assert.deepEqual(await preparing(['node_modules']), ['npm run -s build -w @hornhoof/protocol', 'npm run -s build -w @hornhoof/node']);
  assert.deepEqual(await preparing(['node_modules', 'packages/protocol/dist']), ['npm run -s build -w @hornhoof/node']);
  assert.deepEqual(await preparing(['node_modules', 'packages/protocol/dist', 'apps/node/dist']), []);
  assert.equal(await prepare({ exists: () => false, exec: async () => ({ code: 1 }) }), 'prepare_failed');
  assert.equal(await prepare({ exists: () => false, exec: async () => ({ code: null }) }), 'prepare_failed');
});

test('the tracked files of the index keep paths with spaces', () => {
  assert.deepEqual(tracked(() => '100644 aaa 0\ta b.ts\0' + '120000 bbb 0\tlink\0'), [{ path: 'a b.ts', mode: '100644', oid: 'aaa' }, { path: 'link', mode: '120000', oid: 'bbb' }]);
});

const hasCrapper = spawnSync('crapper', ['--help'], { stdio: 'ignore' }).status === 0;

test('the complexity of a commit is read at the path the file has now', { skip: !hasCrapper }, () => {
  const source = 'export function f(x: number) {\n  if (x > 1) return 1;\n  if (x > 2) return 2;\n  return 3;\n}\n';
  const shown = [];
  const entries = complexityAt(args => { shown.push(args); return source; })('apps/node', BASE, [{ path: 'src/deep/moved.ts', from: 'apps/node/src/old.ts' }]);
  assert.deepEqual(shown, [['show', `${BASE}:apps/node/src/old.ts`]]);
  assert.deepEqual(entries.map(({ name, namespace, complexity }) => [name, namespace, complexity]), [['f', 'deep.moved', 3]]);
});

test('a missing tool for the plan is said, not taken for a simple commit', () => {
  assert.throws(() => complexityAt(() => 'x', 'no-such-tool-at-all')('.', BASE, [{ path: 'a.ts', from: 'a.ts' }]), /crapper_unavailable/);
});

for (const path of ['AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'apps/server/test/fixtures/deep/README.md']) {
  test(`checked Markdown ${path} participates in author selection`, async () => {
    const ports = selector();
    const result = await selectTests({ changes: [{ path, kind: 'modified' }], manifest: MANIFEST, tracked: [], allowWhole: false }, ports);
    assert.ok(result.packages.length > 0);
    assert.ok(!result.notes.some(note => note === `document without tests: ${path}`));
  });
}

test('moving a checked fixture to ordinary docs still checks its former readers', async () => {
  const ports = selector();
  const result = await selectTests({ changes: [{ path: 'docs/moved.md', previousPath: 'apps/node/test/fixtures/README.md', kind: 'renamed' }], manifest: MANIFEST, tracked: [], allowWhole: false }, ports);
  assert.ok(result.packages.length > 0);
});
