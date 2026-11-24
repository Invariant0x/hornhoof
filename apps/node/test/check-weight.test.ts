import { describe, expect, it } from 'vitest';
import { lightCheck } from '../src/check-weight.js';

describe('which commands are light checks', () => {
  it.each([
    ['tsc', '-p', 'apps/node/tsconfig.json', '--noEmit'],
    ['eslint', 'apps/node/src/check-client.ts'],
    ['vitest', 'run', 'apps/node/test/check-client.test.ts'],
    ['jest', 'src/a.test.js'],
    ['/work/hornhoof/node_modules/.bin/tsc', '--noEmit'],
    [process.execPath, '/work/hornhoof/node_modules/typescript/bin/tsc', '-p', 'x'],
    [process.execPath, '/work/hornhoof/node_modules/eslint/bin/eslint.js', 'a.ts'],
    [process.execPath, '/work/hornhoof/node_modules/vitest/vitest.mjs', 'run', 'a.test.ts'],
    [process.execPath, '--max-old-space-size=4096', '/work/hornhoof/node_modules/typescript/bin/tsc'],
    ['node', '--', '/work/hornhoof/node_modules/vitest/vitest.mjs'],
    ['npx', 'tsc', '--noEmit'],
    ['npx', '--no-install', 'vitest', 'run'],
    ['npx', '--', 'tsc'],
    ['bunx', 'eslint', '.'],
    ['pnpm', 'exec', 'tsc'],
    ['npm', 'exec', '--', 'eslint', 'a.ts'],
    ['mypy', 'src'],
    ['ruff', 'check', '.'],
    ['python3', '-m', 'mypy', '.'],
    ['python', '-m', 'ruff', 'check', 'a.py'],
    ['pytest', 'tests/test_a.py'],
    ['prettier', '--check', 'a.ts'],
    ['black', '.'],
    ['crapper', 'a.ts'],
    ['dryer', 'a.ts'],
    ['biome', 'lint', '.'],
  ])('light: %s', (...command) => {
    expect(lightCheck(command)).toBe(true);
  });

  it.each([
    ['playwright', 'test', 'e2e/a.spec.ts'],
    [process.execPath, '/work/hornhoof/node_modules/playwright/cli.js', 'test'],
    ['npx', 'playwright', 'test'],
    ['vitest', 'run', '--browser'],
    ['vitest', 'run', '--browser.enabled'],
    ['npm', 'ci'],
    ['npm', 'install'],
    ['npm', 'run', 'build'],
    ['npm', 'test'],
    ['npx', 'vite', 'build'],
    ['docker', 'build', '.'],
    ['cargo', 'build'],
    ['make'],
    ['node', 'scripts/check-release.mjs'],
    ['node', '-e', 'process.exit(0)'],
    ['bash', '-c', 'tsc'],
    ['npx', '-p', 'typescript', 'tsc'],
    ['tsc-watch'],
    ['webpack', '--mode', 'production'],
    ['stryker', 'run'],
    ['mutator', 'a.ts'],
    ['kcov', 'out', 'a'],
    ['python', '-m', 'build'],
    ['python', 'setup.py'],
    ['xtsc'],
    [],
  ])('heavy: %s', (...command) => {
    expect(lightCheck(command)).toBe(false);
  });
});
