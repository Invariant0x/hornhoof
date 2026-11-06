import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStagingFailureTests, type StagingFailureLog } from '../src/modules/tasks/staging-failures.js';

const vitestLog = readFileSync(new URL('./fixtures/staging-vitest-5.txt', import.meta.url), 'utf8');
const pytestLog = readFileSync(new URL('./fixtures/staging-pytest-8.txt', import.meta.url), 'utf8');
const nodeFile = 'apps/node/test/staging-git.test.ts', pythonFile = 'scripts/test/impact-python/test_pytest_impact.py';
const nodeScope = (log = vitestLog): StagingFailureLog => ({ adapter: 'vitest', suiteId: 'node', root: 'apps/node', files: [nodeFile], log });
const pythonScope = (log = pytestLog): StagingFailureLog => ({ adapter: 'pytest', suiteId: 'python', root: 'scripts/test/impact-python', files: [pythonFile], log });
const simple = ' RUN  v5.0.5 <checkout>\n FAIL  test/a.test.ts > totals > keeps totals\n Tests  1 failed | 1 passed (2)\n';

describe('conservative staging failure text decoding', () => {
  it('reads all six failures from actual Vitest RED844 without assertion text or native authority', () => {
    const tests = [
      'combines both pinned trees into one commit with only base B as parent, without publishing',
      'replays to the exact same candidate in a new bare cache',
      'uses the admitted old H after its task branch moves',
      'reports the conflicting submission without returning Git paths or stderr',
      'does not start Git after cancellation',
      'waits for an in-flight executor to settle before rejecting cancellation',
    ];
    expect(parseStagingFailureTests(nodeScope())).toEqual(tests.map(test => ({ suiteId: 'node', file: nodeFile, test: `staging candidate preparation on disposable Git remotes > ${test}` })));
  });
  it('reads all twenty actual pytest RED360 failures including parameterized node IDs', () => {
    const tests = [
      'test_transitive_relative_edges_select_only_dependents', 'test_selected_files_run_with_real_pytest',
      'test_changed_test_itself_is_selected', 'test_proven_unreferenced_module_has_no_tests',
      'test_uncertain_graph_is_unavailable[extra0]', 'test_uncertain_graph_is_unavailable[extra1]',
      'test_uncertain_graph_is_unavailable[extra2]', 'test_uncertain_graph_is_unavailable[extra3]',
      'test_uncertain_graph_is_unavailable[extra4]', 'test_uncertain_graph_is_unavailable[extra5]',
      'test_uncertain_graph_is_unavailable[extra6]', 'test_uncertain_graph_is_unavailable[extra7]',
      'test_uncertain_graph_is_unavailable[extra8]', 'test_unsafe_paths_do_not_open_files[../secret.py]',
      'test_unsafe_paths_do_not_open_files[/etc/passwd]', 'test_unsafe_paths_do_not_open_files[src/../a.py]',
      'test_symlink_cannot_import_outside_the_package', 'test_module_cycles_terminate_and_keep_all_dependents',
      'test_package_initializer_is_a_dependency', 'test_cli_emits_json_without_importing_repository_modules',
    ];
    expect(parseStagingFailureTests(pythonScope())).toEqual(tests.map(test => ({ suiteId: 'python', file: pythonFile, test })));
  });
  it('maps a suite rooted at the repository without inventing an absolute path', () => {
    expect(parseStagingFailureTests({ adapter: 'vitest', suiteId: 'unit', root: '.', files: ['test/a.test.ts'], log: simple })).toEqual([
      { suiteId: 'unit', file: 'test/a.test.ts', test: 'totals > keeps totals' },
    ]);
  });
  it('accepts CRLF transport without changing test labels', () => {
    expect(parseStagingFailureTests(nodeScope(vitestLog.replaceAll('\n', '\r\n')))).toHaveLength(6);
  });
  it.each([
    'fatal: could not fetch the pinned commit', 'exit code 1', 'No test files found', 'Tests 0 failed',
    '::hh-test-timing::{"kind":"test","failed":1,"test":"invented"}',
  ])('keeps non-test failure output unattributed: %s', log => {
    expect(parseStagingFailureTests(nodeScope(log))).toBeNull();
  });
  it.each([
    vitestLog.replace(/\s+Tests\s+6 failed[^\n]*/, ''),
    vitestLog.replace('Tests  6 failed', 'Tests  7 failed'),
    `${vitestLog}\n[512 bytes left out]\n`,
    `${vitestLog}\nUnhandled Errors\n`,
    `${vitestLog}\nUnhandled Rejection\n`,
    `${vitestLog}\nTests  6 failed\n`,
  ])('refuses incomplete, ambiguous or infrastructure-tainted Vitest output', log => {
    expect(parseStagingFailureTests(nodeScope(log))).toBeNull();
  });
  it('refuses a failed file without an actual failing test name', () => {
    const log = simple.replace('test/a.test.ts > totals > keeps totals', 'test/a.test.ts [ test/a.test.ts ]');
    expect(parseStagingFailureTests({ adapter: 'vitest', suiteId: 'unit', root: '.', files: ['test/a.test.ts'], log })).toBeNull();
  });
  it('refuses duplicated failure identities even if the failure count matches', () => {
    const log = simple.replace('Tests  1 failed', 'FAIL  test/a.test.ts > totals > keeps totals\nTests  2 failed');
    expect(parseStagingFailureTests({ adapter: 'vitest', suiteId: 'unit', root: '.', files: ['test/a.test.ts'], log })).toBeNull();
  });
  it.each([
    pytestLog.replace('20 failed, 1 passed', '21 failed, 1 passed'),
    pytestLog.replace('20 failed, 1 passed in 0.17s', ''),
    `${pytestLog}\nERROR test_pytest_impact.py::test_setup\n`,
    pytestLog.replace('20 failed, 1 passed', '20 failed, 1 error, 1 passed'),
    `${pytestLog}\n[12 bytes left out]\n`,
  ])('refuses incomplete or mixed setup-error pytest output', log => {
    expect(parseStagingFailureTests(pythonScope(log))).toBeNull();
  });
  it('does not guess pytest parameter boundaries containing spaces', () => {
    const log = 'short test summary info\nFAILED test_x.py::test_x[a - b] - AssertionError\n1 failed in 0.1s\n';
    expect(parseStagingFailureTests({ adapter: 'pytest', suiteId: 'py', root: '.', files: ['test_x.py'], log })).toBeNull();
  });
  it.each(['/private/test.ts', '../other.test.ts', 'test/../../other.test.ts', 'test\\other.test.ts', 'C:/test.ts'])('refuses an unsafe reported file %s', file => {
    const log = simple.replace('test/a.test.ts', file);
    expect(parseStagingFailureTests({ adapter: 'vitest', suiteId: 'unit', root: '.', files: [file], log })).toBeNull();
  });
  it('does not attribute a failure from an unselected file', () => {
    expect(parseStagingFailureTests({ ...nodeScope(), files: ['apps/node/test/other.test.ts'] })).toBeNull();
  });
  it.each([
    { root: '../private' }, { suiteId: '' }, { files: [] }, { files: [nodeFile, nodeFile] },
    { log: `${vitestLog}\u001b[31m` }, { log: `${vitestLog}\u0000` },
  ])('refuses malformed or unsafe decoder scope %j', change => {
    expect(parseStagingFailureTests({ ...nodeScope(), ...change })).toBeNull();
  });
});
