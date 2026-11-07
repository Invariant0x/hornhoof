/* What a mutant's fast tests need of a package's test setup: nothing that prepares a database or a report. */
export default { test: { include: ['test/**/*.test.ts'], env: { TZ: 'UTC' } } };
