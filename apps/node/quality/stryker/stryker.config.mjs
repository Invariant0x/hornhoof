export default {
  mutate: ['src/redact.ts'],
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.mjs' },
  concurrency: 1,
  incremental: true,
  incrementalFile: 'reports/incremental.json',
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation.json' },
  // This pilot measures test gaps; survivors are data, rather than a release gate.
  thresholds: { high: 100, low: 0, break: 0 },
};
