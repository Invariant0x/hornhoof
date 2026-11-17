import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { judgedAgain, keepJudges, mutateSources, mutatorArgs, outcomeOf, selectedSources, testCommand } from '../mutation/run.mjs';

const encodePlan = ({ sha, base, changes, hunks }) => JSON.stringify({ sha, base, changes, hunks: hunks ?? null });

const table = (killed, survived, uncovered, sites) => `name   ns  killed survived uncovered sites score\n-----\nfoo    a        ${killed}        ${survived}          ${uncovered}     ${sites}  50.0%\n-----\nTotal         ${killed}        ${survived}          ${uncovered}     ${sites}  50.0%\n\n`;

test('a survivor is a finding the note carries, not a failure', () => {
  assert.deepEqual(outcomeOf(3, table(2, 7, 0, 9)), { status: 'passed', note: '2 killed, 7 survived, 0 uncovered of 9 sites' });
  assert.deepEqual(outcomeOf(0, table(9, 0, 0, 9)), { status: 'passed', note: '9 killed, 0 survived, 0 uncovered of 9 sites' });
});

for (const [why, code, output] of [
  ['the tests fail unmutated', 2, table(0, 0, 0, 9)],
  ['the command is wrong', 1, ''],
  ['the tool could not start', null, ''],
  ['it found no source and still exits 0', 0, 'No source files to mutate.\n'],
  ['the file has nothing to mutate', 0, table(0, 0, 0, 0)],
]) {
  test(`a file fails when ${why}`, () => assert.deepEqual(outcomeOf(code, output), { status: 'failed' }));
}

test('the fast tests of each package run from that package', () => {
  assert.equal(testCommand(['apps/node/test/a.test.ts', 'apps/node/test/deep/b.test.ts']), 'npx --no-install vitest run --config ../../scripts/mutation/vitest.config.mjs --root apps/node test/a.test.ts test/deep/b.test.ts');
  assert.equal(testCommand(['apps/node/test/a.test.ts', 'apps/server/test/b.test.ts']), 'npx --no-install vitest run --config ../../scripts/mutation/vitest.config.mjs --root apps/node test/a.test.ts && npx --no-install vitest run --config ../../scripts/mutation/vitest.config.mjs --root apps/server test/b.test.ts');
});

test('the tool judges mutants by the counts of the mutation config, and the baseline keeps the full report', () => {
  const args = mutatorArgs('apps/node/src/a.ts', ['apps/node/test/a.test.ts'], false);
  assert.doesNotMatch(args[args.indexOf('--test-command') + 1], /--reporter/);
  assert.equal(testCommand(['apps/node/test/a.test.ts'], new Map()), 'npx --no-install vitest run --config ../../scripts/mutation/vitest.config.mjs --root apps/node --reporter=default test/a.test.ts');
});

/* The tool takes words like "Cannot find module" in its output for a broken runner, and Vitest prints the names of the
   passing tests of a failed file only where it sees no AI agent. What a mutant prints must be the same for both. */
test('a killed mutant reads the same with or without an agent, and no test names or data reach the tool', t => {
  const folder = mkdtempSync(join(tmpdir(), 'hh-mutation-words-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const write = (path, text) => { mkdirSync(join(folder, path, '..'), { recursive: true }); writeFileSync(join(folder, path), text); };
  write('package.json', '{"private":true}');
  mkdirSync(join(folder, 'scripts/mutation'), { recursive: true });
  for (const file of ['vitest.config.mjs', 'counts-reporter.mjs']) if (existsSync(join(repository, 'scripts/mutation', file))) copyFileSync(join(repository, 'scripts/mutation', file), join(folder, 'scripts/mutation', file));
  symlinkSync(join(repository, 'node_modules'), join(folder, 'node_modules'));
  write('apps/a/test/words.test.ts', `import { describe, expect, it } from 'vitest';
describe('words', () => {
  it("leaves ordinary words as they are: Error: Cannot find module '/data/tools/cli.js'", () => expect(1).toBe(1));
  it('hides a token', () => expect('key=sk-fixture-secret').toBe('key=[hidden]'));
});
`);
  write('apps/a/src/broken.ts', "export const words = 'Cannot find module' || || 'sk-fixture-secret';\n");
  write('apps/a/test/broken.test.ts', "import { expect, it } from 'vitest';\nimport { words } from '../src/broken.js';\nit('reads words', () => expect(words).toBe(''));\n");
  const run = (file, extra = {}) => {
    try { execFileSync('sh', ['-c', testCommand([file])], { cwd: folder, env: { PATH: process.env.PATH, HOME: folder, npm_config_update_notifier: 'false', ...extra }, encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { return { code: error.status, output: `${error.stdout}${error.stderr}` }; }
    return { code: 0, output: '' };
  };
  const runner = run('apps/a/test/words.test.ts'), agent = run('apps/a/test/words.test.ts', { CLAUDECODE: '1', AI_AGENT: 'fixture' });
  assert.equal(runner.code, 1, runner.output);
  assert.equal(runner.output, agent.output);
  assert.match(runner.output, /Tests {2}1 failed \| 1 passed \(2\)/);
  assert.match(runner.output, /AssertionError/);
  assert.doesNotMatch(runner.output, /Cannot find module|ordinary words|hides a token|sk-fixture-secret/i);
  const broken = run('apps/a/test/broken.test.ts');
  assert.equal(broken.code, 1, broken.output);
  assert.match(broken.output, /Tests {2}no tests\n.*Transform failed/s, 'a mutant that does not parse stays a compile error, not a kill');
  assert.doesNotMatch(broken.output, /Cannot find module|sk-fixture-secret|reads words/i);
});

test('a path reaches the shell as one word', () => {
  assert.match(testCommand(["apps/node/test/a b;'c.test.ts"]), /--root apps\/node 'test\/a b;'\\''c\.test\.ts'$/);
});

test('a run takes what it was given, and everything when run by hand', () => {
  const mutation = { sourcePaths: ['a/one.ts', 'a/two.ts'] };
  assert.deepEqual(selectedSources('["./a/two.ts"]', mutation), ['a/two.ts']);
  assert.deepEqual(selectedSources(undefined, mutation), ['a/one.ts', 'a/two.ts']);
});

test('a source no fast test reaches fails without running, and the others still run', async () => {
  const ran = [];
  const files = await mutateSources(['a/none.ts', 'a/some.ts'], new Map([['a/none.ts', []], ['a/some.ts', ['a/test/some.test.ts']]]), {
    testsPass: async () => true,
    mutate: async (source, tests) => {
      ran.push([source, tests]);
      return { code: 3, output: table(1, 1, 0, 2) };
    },
  });
  assert.deepEqual(ran, [['a/some.ts', ['a/test/some.test.ts']]]);
  assert.ok(files.every(file => file.ms >= 0));
  assert.deepEqual(files.map(file => ({ ...file, ms: 0 })), [{ file: 'a/none.ts', status: 'failed', ms: 0 }, { file: 'a/some.ts', status: 'passed', note: '1 killed, 1 survived, 0 uncovered of 2 sites', ms: 0 }]);
});

test('a source whose tests fail unmutated fails without mutating: from its snapshot the tool would call every mutant killed', async () => {
  const ran = [];
  const files = await mutateSources(['a/red.ts', 'a/green.ts'], new Map([['a/red.ts', ['a/test/red.test.ts']], ['a/green.ts', ['a/test/green.test.ts']]]), {
    testsPass: async tests => tests[0] === 'a/test/green.test.ts',
    mutate: async source => {
      ran.push(source);
      return { code: 0, output: table(1, 0, 0, 1) };
    },
  });
  assert.deepEqual(ran, ['a/green.ts']);
  assert.deepEqual(files.map(file => [file.file, file.status]), [['a/red.ts', 'failed'], ['a/green.ts', 'passed']]);
});

test('what the tool runs says to mutate everything only when asked', () => {
  assert.ok(!mutatorArgs('a/one.ts', ['a/test/one.test.ts'], false).includes('--mutate-all'));
  assert.ok(mutatorArgs('a/one.ts', ['a/test/one.test.ts'], true).includes('--mutate-all'));
  assert.deepEqual(mutatorArgs('a/one.ts', ['a/test/one.test.ts'], false).slice(0, 4), ['--root', '.', '--source-root', 'a/one.ts']);
});

test('a narrow mutator command carries only the selected function lines', () => {
  const args = mutatorArgs('a/one.ts', ['a/test/one.test.ts'], true, [3, 1, 2, 2]);
  assert.equal(args[args.indexOf('--lines') + 1], '1,2,3');
  assert.throws(() => mutatorArgs('a/one.ts', ['a/test/one.test.ts'], true, []), /lines/i);
});

test('duplicate source selections produce one outcome and one mutation', async () => {
  const calls = [];
  const files = await mutateSources(['a/one.ts', 'a/one.ts'], new Map([['a/one.ts', ['a/test/one.test.ts']]]), {
    testsPass: async () => true, mutate: async source => { calls.push(source); return { code: 0, output: table(1, 0, 0, 1) }; },
  });
  assert.equal(files.length, 1); assert.deepEqual(calls, ['a/one.ts']);
});

test('current mutator totals keep compile errors and timeouts separate from kills', () => {
  assert.deepEqual(outcomeOf(0, 'Total 3 0 0 0 0 3 100.0%\n'), { status: 'passed', note: '3 killed, 0 survived, 0 uncovered, 0 compile_error, 0 timeout of 3 sites' });
  for (const totals of ['Total 0 0 0 1 0 1 n/a\n', 'Total 0 0 0 0 1 1 n/a\n']) {
    const outcome = outcomeOf(0, totals);
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.note, /compile_error.*timeout/);
  }
});

function deltaRepository(t) {
  const folder = mkdtempSync(join(tmpdir(), 'hh-mutation-delta-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const root = join(folder, 'repo'), bin = join(folder, 'bin'), calls = join(folder, 'calls'), report = join(folder, 'report.json'), selected = join(folder, 'selected.json');
  mkdirSync(root); mkdirSync(bin);
  const write = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const source = 'apps/a/src/pure.ts', unsafe = 'apps/a/src/process.ts', untouched = 'apps/a/src/untouched.ts', fast = 'apps/a/test/pure.test.ts', unsafeFast = 'apps/a/test/process.test.ts';
  const code = 'export function changed(value: number) {\n return value + 1;\n}\nexport function untouched(value: number) {\n return value + 2;\n}\n';
  const mutation = { status: 'supported', language: 'typescript', tool: join(bin, 'mutator'), sourcePaths: [source, unsafe, untouched], fastTestPaths: [fast, unsafeFast] };
  write('.hornhoof/test-environment.json', JSON.stringify({ mutation, dependencies: { inputs: [], install: [] }, prepare: [], suites: [{ id: 'a', root: 'apps/a' }, { id: 'mutation', root: 'scripts/mutation' }] }));
  write(untouched, 'export function unchanged(value: number) { return value + 5; }\n');
  write('package.json', '{}'); write(source, code); write(unsafe, "import { spawn } from 'node:child_process';\nexport function processWork() { return spawn('true'); }\n");
  write(fast, "import { changed } from '../src/pure.js';\nimport { it, expect } from 'vitest';\nit('changes', () => expect(changed(1)).toBe(2));\n");
  write(unsafeFast, "import { processWork } from '../src/process.js';\nimport { it, expect } from 'vitest';\nit('runs', () => expect(processWork()).toBeDefined());\n");
  write('scripts/mutation/vitest.config.mjs', 'export default {};');
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env node\nconst fs=require('node:fs'); const arg=process.argv.find(a=>a.startsWith('--outputFile.json=')); if(arg) fs.writeFileSync(arg.slice('--outputFile.json='.length),JSON.stringify({numTotalTests:process.env.HH_FIXTURE_ZERO==='1'?0:1,numPassedTests:process.env.HH_FIXTURE_ZERO==='1'?0:1,numFailedTests:0}));\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'mutator'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n'); process.stdout.write('Total 1 0 0 1 100.0%\\n');\n`, { mode: 0o755 });
  git('init', '--quiet'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('add', '.'); git('commit', '--quiet', '-m', 'Base');
  const base = git('rev-parse', 'HEAD'); write(source, code.replace('return value + 1;', 'return value > 0 ? value : 0;')); write(unsafe, "import { spawn } from 'node:child_process';\nexport function processWork() { return spawn('false'); }\n");
  git('add', '.'); git('commit', '--quiet', '-m', 'Candidate');
  const head = git('rev-parse', 'HEAD');
  const run = (args = ['--base', base, '--head', head], files = [source, source], extra = {}, cwd = root) => {
    writeFileSync(selected, JSON.stringify(files));
    try {
      const output = execFileSync(process.execPath, [fileURLToPath(new URL('../mutation/run.mjs', import.meta.url)), ...args], { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HH_TEST_FILES: files === null ? '' : selected, HH_TEST_REPORT: report, ...extra }, encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, output, report: JSON.parse(readFileSync(report, 'utf8')) };
    } catch (error) { return { code: error.status, output: String(error.stdout), report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null }; }
  };
  return { root, folder, source, unsafe, base, head, run, calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
}

test('the narrow CLI mutates changed pure lines, reports its scope and keeps whole judges separate', t => {
  const fixture = deltaRepository(t), result = fixture.run();
  assert.equal(result.code, 0, result.output);
  assert.equal(result.report.files.length, 1);
  const args = fixture.calls()[0];
  assert.equal(args[args.indexOf('--lines') + 1], '1,2,3');
  assert.equal(fixture.calls().length, 1);
  assert.equal(result.report.selection.baseCommit, fixture.base); assert.equal(result.report.selection.commit, fixture.head);
  assert.equal(result.report.selection.fullSuiteComparator, 'unavailable');
  assert.equal(existsSync(join(fixture.root, '.metrics/mutate/judges', fixture.source.replaceAll('/', '__'))), false);
});

test('the narrow CLI with a whole inventory runs only changed pure sources', t => {
  const fixture = deltaRepository(t), result = fixture.run(['--base', fixture.base, '--head', fixture.head], null);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.report.files.map(file => [file.file, file.status]), [[fixture.source, 'passed']]);
  assert.equal(fixture.calls().length, 1);
  assert.equal(result.report.selection.excluded.some(item => item.file === fixture.unsafe), true);
});

for (const failure of ['unsafe', 'stale-head', 'zero-tests']) {
  test(`the narrow CLI rejects ${failure} before any mutation`, t => {
    const fixture = deltaRepository(t);
    const args = ['--base', fixture.base, '--head', failure === 'stale-head' ? fixture.base : fixture.head];
    const result = fixture.run(args, [failure === 'unsafe' ? fixture.unsafe : fixture.source], failure === 'zero-tests' ? { HH_FIXTURE_ZERO: '1' } : {});
    assert.equal(result.code, 1, result.output); assert.deepEqual(fixture.calls(), []);
  });
}

test('a bound delta plan works on a shallow worker without its base object', t => {
  const fixture = deltaRepository(t), shallow = join(fixture.folder, 'shallow');
  execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${fixture.root}`, shallow], { stdio: 'pipe' });
  const plan = encodePlan({ sha: fixture.head, base: fixture.base, changes: [{ path: fixture.source, kind: 'modified' }], hunks: { [fixture.source]: [[2, 1]] }, grown: {} });
  const result = fixture.run(['--base', fixture.base, '--head', fixture.head, '--plan', plan], [fixture.source], {}, shallow);
  assert.equal(result.code, 0, result.output); assert.equal(fixture.calls()[0].includes('--lines'), true);
  assert.equal(result.report.selection.deltaSource, 'plan');
});

test('a private bound delta file works on a shallow mutation worker', t => {
  const fixture = deltaRepository(t), shallow = join(fixture.folder, 'shallow');
  execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${fixture.root}`, shallow], { stdio: 'pipe' });
  const planFile = join(fixture.folder, 'candidate-delta.json');
  writeFileSync(planFile, encodePlan({ sha: fixture.head, base: fixture.base, changes: [{ path: fixture.source, kind: 'modified' }], hunks: { [fixture.source]: [[2, 1]] } }), { mode: 0o600 });
  const result = fixture.run(['--base', fixture.base, '--head', fixture.head, '--plan-file', planFile], [fixture.source], {}, shallow);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.report.selection.deltaSource, 'plan');
  assert.equal(fixture.calls().length, 1);
  assert.equal(fixture.calls()[0][fixture.calls()[0].indexOf('--lines') + 1], '1,2,3');
});

test('a mutation delta file cannot bypass its source binding or size limit', t => {
  const fixture = deltaRepository(t), shallow = join(fixture.folder, 'shallow');
  execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${fixture.root}`, shallow], { stdio: 'pipe' });
  const planFile = join(fixture.folder, 'candidate-delta.json');
  for (const text of [encodePlan({ sha: fixture.head, base: 'f'.repeat(40), changes: [], hunks: {} }), ' '.repeat(513 * 1024)]) {
    writeFileSync(planFile, text);
    const result = fixture.run(['--base', fixture.base, '--head', fixture.head, '--plan-file', planFile], [fixture.source], {}, shallow);
    assert.equal(result.code, 1);
    assert.deepEqual(result.report.files, []);
  }
  assert.deepEqual(fixture.calls(), []);
});

test('invalid candidate CLI arguments fail before any mutation', t => {
  const fixture = deltaRepository(t);
  for (const args of [
    ['--base', fixture.base], ['--base', 'short', '--head', fixture.head],
    ['--base', fixture.base, '--head', fixture.head, '--base', fixture.base],
    ['--base', fixture.base, '--head', fixture.head, '--unknown', 'value'],
    ['--base', fixture.base, '--head', fixture.head, '--plan'],
  ]) {
    const result = fixture.run(args);
    assert.equal(result.code, 1); assert.deepEqual(result.report.files, []);
  }
  assert.deepEqual(fixture.calls(), []);
});

test('a shallow candidate refuses a missing, mismatched or lineless delta plan', t => {
  const fixture = deltaRepository(t), shallow = join(fixture.folder, 'shallow');
  execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${fixture.root}`, shallow], { stdio: 'pipe' });
  const plan = { sha: fixture.head, base: fixture.base, changes: [{ path: fixture.source, kind: 'modified' }], hunks: { [fixture.source]: [[2, 1]] }, grown: {} };
  const requests = [[], ['--plan', encodePlan({ ...plan, base: '3'.repeat(40) })], ['--plan', encodePlan({ ...plan, sha: '4'.repeat(40) })], ['--plan', encodePlan({ ...plan, hunks: undefined })]];
  for (const extra of requests) {
    const result = fixture.run(['--base', fixture.base, '--head', fixture.head, ...extra], [fixture.source], {}, shallow);
    assert.equal(result.code, 1); assert.deepEqual(result.report.files, []);
  }
  assert.deepEqual(fixture.calls(), []);
});

test('a source is judged again by tests that changed, and keeps what it was judged by only once it went well', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'hh-judges-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const source = 'apps/a/src/one.ts';
  assert.equal(judgedAgain(folder, source, 'first-print'), true);
  keepJudges(folder, source, 'first-print');
  assert.equal(judgedAgain(folder, source, 'first-print'), false);
  assert.equal(judgedAgain(folder, source, 'changed-print'), true);
  assert.equal(judgedAgain(folder, source, undefined), true);
  assert.equal(judgedAgain(folder, 'apps/a/src/two.ts', 'first-print'), true);
});

/* Run the real cache/runner with tiny command stand-ins. No mutants or database are needed to observe --mutate-all. */
for (const changed of ['helper', 'config', 'mode', 'source', 'unknown', 'unknown-config', 'runtime']) {
  test(`saved mutation judges invalidate ${changed} changes without editing the test`, t => {
    const folder = mkdtempSync(join(tmpdir(), 'hh-mutation-judges-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const root = join(folder, 'repo'), bin = join(folder, 'bin'), calls = join(folder, 'calls'), conditions = join(folder, 'conditions.cjs');
    mkdirSync(root); mkdirSync(bin);
    const write = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    const source = 'apps/a/src/one.ts', helper = 'apps/a/test/helper.ts', config = 'scripts/mutation/vitest.config.mjs';
    const mutation = { status: 'supported', tool: join(bin, 'mutator'), sourcePaths: [source], fastTestPaths: ['apps/a/test/one.test.ts'] };
    write('.hornhoof/test-environment.json', JSON.stringify({ mutation, dependencies: { inputs: [], install: [] }, prepare: [], suites: [{ id: 'a', root: 'apps/a' }, { id: 'mutation', root: 'scripts/mutation' }] }));
    write('package.json', '{}');
    write(source, 'export const one = 1;');
    write('apps/a/test/one.test.ts', "import { one } from '../src/one.js';\nimport './helper.js';\nexport { one };");
    write(helper, changed === 'unknown' ? "const name = './unknown.js';\nawait import(name);" : "import './deep.js';");
    write('apps/a/test/deep.ts', 'export const allowed = true;');
    write(config, changed === 'unknown-config' ? 'const config = process.env.JUDGE_CONFIG;\nexport default await import(config);' : "import './config-helper.mjs';\nexport default {};");
    write('apps/b/judge-options.json', '{"strict":true}');
    write('scripts/mutation/config-helper.mjs', 'export const strict = true;');
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'mutator'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nprintf 'Total 1 0 0 1 100.0%%\\n'\n`, { mode: 0o755 });
    const setConditions = version => writeFileSync(conditions, `const original=process.report.getReport.bind(process.report); process.report.getReport=()=>{const report=original(); return {...report,header:{...report.header,glibcVersionRuntime:${JSON.stringify(version)}}};};`);
    if (changed === 'runtime') setConditions('fixture-before');
    git('init', '--quiet'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('add', '.'); git('commit', '--quiet', '-m', 'First');
    const run = () => {
      execFileSync(process.execPath, [fileURLToPath(new URL('../mutation/run.mjs', import.meta.url))], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HH_TEST_FILES: '', HH_TEST_REPORT: '', ...(changed === 'runtime' ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${conditions}` } : {}) }, stdio: 'pipe' });
      return readFileSync(calls, 'utf8').trim().split('\n').at(-1).includes('--mutate-all');
    };
    assert.equal(run(), true);
    assert.equal(run(), false, 'unchanged judges retain the saved snapshot');
    if (changed === 'helper') write('apps/a/test/deep.ts', 'export const allowed = false;');
    if (changed === 'config') write('scripts/mutation/config-helper.mjs', 'export const strict = false;');
    if (changed === 'source') write(source, 'export const one = 2;');
    if (changed === 'mode') chmodSync(join(root, helper), 0o755);
    if (changed === 'unknown') write('apps/a/test/unknown.ts', 'export const skipped = true;');
    if (changed === 'unknown-config') write('apps/b/judge-options.json', '{"strict":false}');
    if (changed === 'runtime') setConditions('fixture-after');
    else { git('add', '.'); git('commit', '--quiet', '-m', 'Judges changed'); }
    assert.equal(run(), true, `${changed} invalidates the persisted judges receipt`);
  });
}
