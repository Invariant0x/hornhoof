import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import type { TestSuite } from '@hornhoof/protocol';
import { planTestParts } from '../src/modules/testruns/plan.js';

type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type VitestReport = { numTotalTests: number; numPassedTests: number; numFailedTests: number;
  testResults: { name: string; assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[] };
type Fixture = { root: string; suite: TestSuite; files: string[]; extension: 'json' | 'xml' };
const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const childDriver = fileURLToPath(new URL('./fixtures/run-planning/invoke.ts', import.meta.url));
const captures = join(repository, '.metrics/task-588/cli-captures');
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

async function folder(): Promise<string> {
  const base = join(repository, '.metrics/task-588/cli-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'project-')); folders.push(root);
  await mkdir(join(root, 'tests')); await mkdir(join(root, 'reports'));
  return root;
}
async function vitestFixture(): Promise<Fixture> {
  const root = await folder(), cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  await writeFile(join(root, 'vitest.config.mjs'), "export default { test: { include: ['tests/*.test.js'], environment: 'node', pool: 'forks', maxWorkers: 1 } };\n");
  const files = ['first', 'second', 'third'].map(name => `tests/${name}.test.js`);
  for (const name of ['first', 'second', 'third']) await writeFile(join(root, `tests/${name}.test.js`), `import { it, expect } from 'vitest';\nit('${name} selected case', () => expect(1).toBe(1));\n`);
  await writeFile(join(root, 'tests/unselected-guard.test.js'), "import { it, expect } from 'vitest';\nit('unselected guard must never run', () => expect(1).toBe(2));\n");
  return { root, files, extension: 'json', suite: { id: 'vitest', root: '.', files: ['tests/*.test.js'], profiles: ['fast'],
    split: { kind: 'argv-files' }, run: { program: process.execPath, args: [cli, 'run', '--config', 'vitest.config.mjs', '--root', '.', '--reporter=json'], cwd: '.' } } };
}
async function plannedVitestFixture(projects = false): Promise<Fixture> {
  const fixture = await vitestFixture();
  const sequencer = new URL('./planned-vitest-sequencer.ts', import.meta.url).href;
  const test = projects
    ? "projects: [{ test: { name: 'first', include: ['tests/*.test.js'], sequence: { groupOrder: 0 } } }, { test: { name: 'second', include: ['tests/*.test.js'], sequence: { groupOrder: 1 } } }],"
    : "include: ['tests/*.test.js'],";
  await writeFile(join(fixture.root, 'vitest.config.mjs'), `import PlannedVitestSequencer from ${JSON.stringify(sequencer)};\nexport default { test: { ${test} pool: 'forks', maxWorkers: 1, sequence: { sequencer: PlannedVitestSequencer } } };\n`);
  return { ...fixture, suite: { ...fixture.suite, split: { kind: 'json-file' }, run: { ...fixture.suite.run, args: [...fixture.suite.run.args, '--reporter=default'] } } };
}
function python(): string {
  if (!process.env.HH588_PYTHON) throw new Error('The authorcheck must prepare its fixture-local pytest interpreter.');
  return process.env.HH588_PYTHON;
}
async function pytestFixture(): Promise<Fixture> {
  const root = await folder(), files = ['first', 'second', 'third'].map(name => `tests/test_${name}.py`);
  await writeFile(join(root, 'pytest.ini'), '[pytest]\ntestpaths = tests\n');
  for (const name of ['first', 'second', 'third']) await writeFile(join(root, `tests/test_${name}.py`), `def test_${name}_selected_case():\n    assert 1 == 1\n`);
  await writeFile(join(root, 'tests/test_unselected_guard.py'), 'def test_unselected_guard_must_never_run():\n    assert 1 == 2\n');
  return { root, files, extension: 'xml', suite: { id: 'pytest', root: '.', files: ['tests/test_*.py'], profiles: ['fast'],
    split: { kind: 'argv-files' }, run: { program: python(), args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], cwd: '.' } } };
}
function fixturePlan(fixture: Fixture) {
  const units = fixture.files.map(file => ({ suiteId: fixture.suite.id, file, selectionUnit: file }));
  return planTestParts({ units, durations: units.map((unit, index) => ({ ...unit, ms: [900, 500, 400][index]! })),
    availableMachines: 2, costs: { setupMs: 10, collectMs: 1 }, unknownFileMs: 1000 });
}
async function invoke(fixture: Fixture, name: string, files: string[], options: string[] = []): Promise<ProcessResult & { report: string | null }> {
  const output = join(fixture.root, 'reports', name + '.' + fixture.extension), request = join(fixture.root, name + '.request.json');
  const outputFlag = fixture.extension === 'json' ? '--outputFile=' : '--junitxml=';
  const suite = { ...fixture.suite, run: { ...fixture.suite.run, args: [...fixture.suite.run.args, outputFlag + output, ...options] } };
  await writeFile(request, JSON.stringify({ suite, files, checkout: fixture.root, filesPath: join(fixture.root, name + '.files.json') }));
  const child = spawn(process.execPath, ['--import', 'tsx', childDriver, request], { cwd: repository, env: process.env });
  onTestFinished(() => { child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += String(bytes); }); child.stderr.on('data', bytes => { stderr += String(bytes); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const report = await readFile(output, 'utf8').catch(() => null);
  await mkdir(captures, { recursive: true });
  await writeFile(join(captures, name + '.json'), JSON.stringify({ fixtureOnly: true, framework: fixture.suite.id, ...result, stdout, stderr, report }, null, 2) + '\n');
  console.log('HH588_CLI_FIXTURE ' + JSON.stringify({ fixtureOnly: true, name, framework: fixture.suite.id, ...result, stdout, stderr, report }));
  return { ...result, stdout, stderr, report };
}
const reportOf = (result: { report: string | null }): VitestReport => JSON.parse(result.report!) as VitestReport;

describe('real framework invocations of planned fixture selections', () => {
  it('uses native --shard with the exact weighted JSON selection instead of sharding it twice', async () => {
    const fixture = await plannedVitestFixture(), plan = fixturePlan(fixture), seen: string[] = [];
    expect(plan.parts.map(part => part.units.map(unit => unit.file))).toEqual([['tests/first.test.js'], ['tests/second.test.js', 'tests/third.test.js']]);
    for (const [index, part] of plan.parts.entries()) {
      const result = await invoke(fixture, `vitest-planned-shard-${index + 1}`, part.units.map(unit => unit.file), [`--shard=${index + 1}/2`]);
      expect(result.code, result.stderr).toBe(0);
      const files = reportOf(result).testResults.map(file => relative(fixture.root, file.name)).sort();
      expect(files).toEqual(part.units.map(unit => unit.file).sort()); seen.push(...files);
    }
    expect(seen.sort()).toEqual([...fixture.files].sort());
  });

  it('retains both real project variants when Vitest calls the sequencer for separate groups', async () => {
    const fixture = await plannedVitestFixture(true);
    const result = await invoke(fixture, 'vitest-planned-projects', [fixture.files[0]!], ['--shard=1/2']);
    expect(result.code, result.stderr).toBe(0);
    expect(reportOf(result).numPassedTests).toBe(2);
    expect(reportOf(result).testResults.map(file => relative(fixture.root, file.name))).toEqual(['tests/first.test.js', 'tests/first.test.js']);
  });

  it('refuses a planned sequencer without --shard before the unselected failing file can run', async () => {
    const fixture = await plannedVitestFixture();
    const marker = join(fixture.root, 'body-executed');
    for (const file of [...fixture.files, 'tests/unselected-guard.test.js']) {
      const source = await readFile(join(fixture.root, file), 'utf8');
      await writeFile(join(fixture.root, file), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\n` + source);
    }
    const result = await invoke(fixture, 'vitest-planned-missing-shard', [fixture.files[0]!]);
    expect(result.code).toBe(1); expect(result.stderr).toContain('requires --shard');
    expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull();
  });

  it('refuses a CLI filename filter which excludes a file from the assigned selection', async () => {
    const fixture = await plannedVitestFixture();
    const result = await invoke(fixture, 'vitest-planned-filter-conflict', [fixture.files[0]!], ['--shard=1/2', 'tests/second.test.js', 'tests/third.test.js']);
    expect(result.code).toBe(1); expect(result.stderr).toContain('was not collected');
    expect(reportOf(result).numTotalTests).toBe(0);
  });

  it('runs the weighted Vitest file selections without discovering the failing unselected file', async () => {
    const fixture = await vitestFixture(), plan = fixturePlan(fixture), seen: string[] = [];
    expect(plan.parts.map(part => part.units.length).sort()).toEqual([1, 2]);
    for (const [index, part] of plan.parts.entries()) {
      const result = await invoke(fixture, `vitest-files-${index + 1}`, part.units.map(unit => unit.file));
      expect(result.code).toBe(0); const report = reportOf(result);
      expect(report.numTotalTests).toBe(part.units.length);
      seen.push(...report.testResults.map(file => relative(fixture.root, file.name)));
    }
    expect(seen.sort()).toEqual([...fixture.files].sort());
  });

  it('executes native Vitest --shard for both indices without counting it as weighted allocation', async () => {
    const fixture = await vitestFixture(), seen: string[] = [];
    for (const index of [1, 2]) {
      const result = await invoke(fixture, `vitest-native-shard-${index}`, fixture.files, [`--shard=${index}/2`]);
      expect(result.code).toBe(0);
      seen.push(...reportOf(result).testResults.map(file => relative(fixture.root, file.name)));
    }
    expect(seen.sort()).toEqual([...fixture.files].sort());
  });

  it('captures an actual Vitest assertion failure and the same case after restoration', async () => {
    const fixture = await vitestFixture(), file = fixture.files[0]!;
    await writeFile(join(fixture.root, file), "import { it, expect } from 'vitest';\nit('bound assertion case', () => expect(1).toBe(2));\n");
    const red = await invoke(fixture, 'vitest-assertion-red', [file]);
    expect(red.code).toBe(1); expect(reportOf(red).numFailedTests).toBe(1);
    expect(reportOf(red).testResults[0]!.assertionResults).toContainEqual(expect.objectContaining({ fullName: 'bound assertion case', status: 'failed' }));
    await writeFile(join(fixture.root, file), "import { it, expect } from 'vitest';\nit('bound assertion case', () => expect(1).toBe(1));\n");
    const green = await invoke(fixture, 'vitest-assertion-green', [file]);
    expect(green.code).toBe(0); expect(reportOf(green).numPassedTests).toBe(1);
  });

  it('keeps a Vitest setup failure distinct from an assertion case', async () => {
    const fixture = await vitestFixture();
    await writeFile(join(fixture.root, 'vitest.config.mjs'), "throw new Error('fixture setup blocked');\n");
    const result = await invoke(fixture, 'vitest-setup-failed', [fixture.files[0]!]);
    expect(result.code).toBe(1); expect(result.stderr).toContain('fixture setup blocked'); expect(result.report).toBeNull();
  });

  it('runs the weighted pytest file selections with the same canonical denominator', async () => {
    const fixture = await pytestFixture(), plan = fixturePlan(fixture); let count = 0;
    for (const [index, part] of plan.parts.entries()) {
      const result = await invoke(fixture, `pytest-files-${index + 1}`, part.units.map(unit => unit.file));
      expect(result.code).toBe(0); expect(result.report).not.toContain('<failure');
      count += (result.report!.match(/<testcase\b/g) ?? []).length;
    }
    expect(count).toBe(3); expect(plan.parts.map(part => part.units.length).sort()).toEqual([1, 2]);
  });

  it('captures an actual pytest assertion failure and the restored case in JUnit', async () => {
    const fixture = await pytestFixture(), file = fixture.files[0]!;
    await writeFile(join(fixture.root, file), 'def test_bound_assertion_case():\n    assert 1 == 2\n');
    const red = await invoke(fixture, 'pytest-assertion-red', [file]);
    expect(red.code).toBe(1); expect(red.report).toContain('test_bound_assertion_case'); expect(red.report).toContain('<failure');
    await writeFile(join(fixture.root, file), 'def test_bound_assertion_case():\n    assert 1 == 1\n');
    const green = await invoke(fixture, 'pytest-assertion-green', [file]);
    expect(green.code).toBe(0); expect(green.report).not.toContain('<failure');
  });

  it('keeps pytest collection errors separate from assertion failures', async () => {
    const fixture = await pytestFixture(), file = fixture.files[0]!;
    await writeFile(join(fixture.root, file), 'import missing_fixture_dependency_588\n');
    const result = await invoke(fixture, 'pytest-collection-failed', [file]);
    expect(result.code).toBe(2); expect(result.report).toContain('<error'); expect(result.report).not.toContain('<failure');
  });

  it('refuses an empty selection before either framework can discover unrelated tests', async () => {
    const fixture = await vitestFixture(), result = await invoke(fixture, 'empty-selection-refused', []);
    expect(result.code).toBe(1); expect(result.stderr).toContain('nonempty file inventory'); expect(result.report).toBeNull();
  });
});
