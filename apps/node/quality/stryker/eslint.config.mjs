export default [{
  ignores: ['node_modules/**', 'reports/**', '.stryker-tmp/**', 'coverage/**'],
}, {
  files: ['**/*.mjs'],
  languageOptions: { globals: { process: 'readonly', console: 'readonly', performance: 'readonly' } },
  rules: {
    'no-unused-vars': 'error',
    'no-undef': 'error',
    'no-unreachable': 'error',
    'no-constant-binary-expression': 'error',
  },
}];
