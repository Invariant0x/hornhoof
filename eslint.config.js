import tseslint from 'typescript-eslint';
import noDdlOnSharedDatabase from './scripts/no-ddl-on-shared-database.mjs';

/* The tsconfig that checks the files of each workspace. A file reaches only its own: eslint keeps every TypeScript
   program it builds until it exits, and the four together need more than the 2 GB node allows by default on a machine
   with less than 15 GB of memory. That is also why `npm run lint` runs one eslint for each workspace, and several for
   the server: its program takes about half of that before a file is linted, and the types eslint asks of its files the
   rest. Each part of the server leaves out exactly what the other parts name, so a new file is in one of them. */
const tsconfigs = {
  'packages/protocol': 'tsconfig.eslint.json',
  'apps/node': 'tsconfig.eslint.json',
  'apps/server': 'tsconfig.eslint.json',
  'apps/web': 'tsconfig.json',
};

const typedFiles = [
  'packages/*/{src,test}/**/*.ts',
  'packages/*/*.config.ts',
  'apps/*/{src,test}/**/*.{ts,tsx}',
  'apps/web/e2e/**/*.{ts,tsx}',
  'apps/web/scripts/**/*.ts',
  'apps/*/*.config.ts',
];

export default [
  {
    ignores: [
      '**/dist/**',
      '**/dist-check/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.metrics/**',
      '**/target/**',
      'apps/web/e2e/results/**',
      'apps/web/playwright-report/**',
    ],
  },
  {
    files: typedFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  ...Object.entries(tsconfigs).map(([workspace, tsconfig]) => ({
    files: typedFiles.map(pattern => [`${workspace}/**`, pattern]),
    languageOptions: { parserOptions: { project: [`./${workspace}/${tsconfig}`] } },
  })),
  {
    /* Postgres specs have private databases of their own. */
    files: ['apps/server/test/**/*.ts'],
    ignores: ['apps/server/test/postgres/**'],
    plugins: { hornhoof: { rules: { 'no-ddl-on-shared-database': noDdlOnSharedDatabase } } },
    rules: { 'hornhoof/no-ddl-on-shared-database': 'error' },
  },
  {
    files: ['scripts/**/*.mjs', 'vitest.config.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-constant-binary-expression': 'error',
    },
  },
];
