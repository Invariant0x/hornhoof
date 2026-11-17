/* What the mutation tool reads of a run of fast tests: how many test files and tests passed or failed and the kind of each
   error, never the name or the data of a test. The tool takes words like "Cannot find module" anywhere in that output for a
   broken runner, and Vitest prints the names of the passing tests of a failed file only where it sees no AI agent, so a test
   that quotes such words would turn every mutant it kills into a failed baseline on a runner and nowhere else. */
const ORDER = ['failed', 'passed', 'skipped', 'pending', 'queued'];
const KIND = /^[A-Za-z][A-Za-z0-9]*$/;

/* A source that does not parse keeps Vite's own words, by which the tool tells a compile error from a kill. */
export function kindOf(error) {
  if (/^Transform failed\b/.test(String(error?.message ?? ''))) return 'Transform failed';
  return KIND.test(error?.name ?? '') ? error.name : 'Error';
}

export function tally(states) {
  if (!states.length) return 'no tests';
  const counts = Map.groupBy(states, state => state);
  const order = [...ORDER, ...[...counts.keys()].filter(state => !ORDER.includes(state)).sort()];
  return `${order.filter(state => counts.has(state)).map(state => `${counts.get(state).length} ${state}`).join(' | ')} (${states.length})`;
}

export default class CountsReporter {
  onTestRunEnd(modules, unhandledErrors = []) {
    const tests = modules.flatMap(module => [...module.children.allTests()]);
    const suites = modules.flatMap(module => [module, ...module.children.allSuites()]);
    const errors = [...suites.flatMap(suite => suite.errors()), ...tests.flatMap(test => test.result().errors ?? []), ...unhandledErrors];
    const lines = [` Test Files  ${tally(modules.map(module => module.state()))}`, `      Tests  ${tally(tests.map(test => test.result().state))}`];
    if (errors.length) lines.push(`     Errors  ${errors.length} (${[...new Set(errors.map(kindOf))].sort().join(', ')})`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}
