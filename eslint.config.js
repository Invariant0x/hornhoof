import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.metrics/**',
      '**/target/**',
      'apps/web/e2e/results/**',
      'apps/web/playwright-report/**',
    ],
  },
  {
    files: [
      'packages/*/src/**/*.ts',
      'apps/*/src/**/*.{ts,tsx}',
      'apps/web/{test,e2e}/**/*.{ts,tsx}',
      'apps/web/*.config.ts',
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./packages/*/tsconfig.json', './apps/*/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
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
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-constant-binary-expression': 'error',
    },
  },
];
