import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyAgentCommand, classifyRunWork, COMMAND_LIMITS, encodeNativeDecision, localCommandFiles, refusalText, type CommandDenial, type CommandFiles, type NativeProgram } from '../src/command-guard.js';

/* The whole command is told before anything of it runs, on real files in a real folder. Nothing here is proof of a CLI's own
   hook path: that takes each program itself, and is not run here. */
let base: string;
let root: string;
let node: string;

const SCRIPTS: Record<string, string> = {
  test: 'vitest run',
  one: 'vitest run test/a.test.ts',
  hidden: 'npm run inner',
  inner: 'tsc --noEmit',
  guarded: 'vitest run test/a.test.ts',
  preguarded: 'npm ci',
  posted: 'echo done',
  postposted: 'eslint .',
  'cycle-a': 'npm run cycle-b',
  'cycle-b': 'npm run cycle-a',
  dyn: '$RUNNER test',
  dynamic: 'sh -c "$X"',
  broken: 'echo "unclosed',
  light: 'node tools/x.js',
  plain: 'echo hi',
  'behind-script': 'bash scripts/heavy.sh',
  lint: 'npm run build -w @fx/lib && npm run lint:part --workspaces --include-workspace-root --',
  'lint:part': 'eslint .',
  types: 'npm run build -w @fx/lib && tsc --noEmit',
  all: 'vitest run',
};

function file(path: string, text = ''): void {
  const at = join(root, path);
  mkdirSync(join(at, '..'), { recursive: true });
  writeFileSync(at, text);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'hh-guard-'));
  root = join(base, 'work');
  mkdirSync(root);
  node = join(root, 'apps/node');
  file('package.json', JSON.stringify({ workspaces: ['apps/*', 'packages/*'], scripts: SCRIPTS }));
  file('test/a.test.ts');
  file('test/b.test.ts');
  file('test/a_test.py');
  file('apps/node/package.json', JSON.stringify({ scripts: { nested: 'vitest run test/a.test.ts', nestedall: 'vitest run', 'lint:part': 'eslint src' } }));
  file('apps/node/test/a.test.ts');
  file('apps/plain/README.md', 'A folder of the workspaces glob with no manifest.');
  file('packages/lib/package.json', JSON.stringify({ name: '@fx/lib', scripts: { build: 'tsc -p tsconfig.json', test: 'vitest run', one: 'vitest run test/a.test.ts', 'lint:part': 'eslint src' } }));
  file('packages/lib/test/a.test.ts');
  for (const bin of ['vitest', 'jest', 'tsc', 'eslint', 'playwright', 'something-light']) file(`node_modules/.bin/${bin}`, '#!/bin/sh\n');
  file('scripts/heavy.sh', '#!/bin/sh\nset -e\nnpm ci\n');
  file('scripts/light.sh', '#!/bin/sh\necho hi\n');
  file('scripts/self.sh', '#!/bin/sh\nbash scripts/self.sh\n');
  file('scripts/noext', '#!/usr/bin/env bash\nvitest run\n');
  file('tools/program', '#!/usr/bin/env python3\nprint(1)\n');
  writeFileSync(join(base, 'outside.test.ts'), '');
  writeFileSync(join(base, 'heavy-outside.sh'), 'npm ci\n');
  symlinkSync(join(base, 'outside.test.ts'), join(root, 'test/escape.test.ts'));
  symlinkSync(join(root, 'test/a.test.ts'), join(root, 'test/inner-link.test.ts'));
  symlinkSync(base, join(root, 'away'));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const agent = (command: string | string[], cwd = root) => classifyAgentCommand({ command, cwd, workspaceRoot: root });
const work = (command: string | string[], cwd = root) => classifyRunWork({ command, cwd, workspaceRoot: root });
const denied = (code: CommandDenial['code']) => expect.objectContaining({ allow: false, code });

describe('checks of a change stay in its workspace', () => {
  it.each([
    'npm ci', 'npx tsc -p apps/server --noEmit', 'tsc --noEmit', 'vite build', 'eslint .',
    'mocha test/a.test.ts test/b.test.ts', 'bun test test/a.test.ts test/b.test.ts',
    'deno test test/a.test.ts test/b.test.ts',
    'prettier --check .', 'crapper test/a.test.ts', 'stryker run',
    'npx playwright test test/a.test.ts test/b.test.ts',
    'c8 vitest run test/a.test.ts test/b.test.ts',
    'vitest run --coverage test/a.test.ts test/b.test.ts',
    'npx vitest run test/a.test.ts test/b.test.ts', 'npm test -- test/a.test.ts',
  ])('allows %s', async command => {
    expect(await agent(command)).toMatchObject({ allow: true });
  });

  it.each([
    'npx vitest run', 'npm test', 'for f in *.test.ts; do npx vitest run $f; done',
    'npx vitest', 'turbo run test', 'tsc --watch', 'tsc -w', 'vite build --watch',
    'c8 vitest run', 'nyc mocha', 'npx --package=vitest vitest run',
    'npx vitest@1 run', 'vitest run test/a.test.ts unknown',
    'for f in a b; do vitest run test/a.test.ts; done',
    'vitest run --coverage', 'playwright test',
    'vitest run --coverage.include=src/** test/a.test.ts',
    'vitest run --browser.unknown test/a.test.ts',
    'pnpm dlx vitest run', 'yarn dlx vitest run',
    'c8 --reporter text vitest run',
    'npm install-test', 'npm it', 'npm cit', 'pnpm install-test',
    'bazel test //...', 'buck test //...', 'rake test', 'python -mpytest', 'python -um pytest',
  ])('refuses %s', async command => {
    expect(await agent(command)).toMatchObject({ allow: false, code: 'whole_suite_local' });
  });
});

describe('dependencies can be installed in the workspace', () => {
  it.each([
    'npm ci', 'npm install', 'npm i lodash', 'npm install --save-dev vitest', 'npm add x', 'npm --prefix apps/node ci', 'npm update',
    'pnpm install', 'pnpm i', 'pnpm add x', 'pnpm -C apps/node install', 'yarn', 'yarn install', 'yarn add x', 'bun install', 'bun add x',
    'pip install x', 'pip3 install -r requirements.txt', 'python -m pip install x', 'python3 -m pip install x', 'uv sync', 'uv add x', 'uv pip install x',
    'poetry install', 'poetry add x', 'pipenv install', 'conda install x', 'cargo add x', 'cargo fetch', 'go get x', 'go mod download', 'go mod tidy',
    'gem install x', 'bundle install', 'bundle', 'composer install', 'composer require x', 'apt-get install -y x', 'apt install x', 'apk add x',
    'brew install x', 'dnf install x', 'pacman -S x', 'dotnet restore', 'playwright install chromium', 'playwright install-deps',
    'pnpm dlx x', 'yarn dlx x', 'npm init x', 'npm create x', 'uvx ruff', 'pipx run x', 'npx -p x y', 'npx --package=x y',
    'npx not-here', 'npx vitest@1 run test/a.test.ts', 'bunx not-here',
  ])('%s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: true }));
  });

  it.each([
    'cat package.json', 'cat package-lock.json', 'sed -i s/a/b/ package.json', 'cat install.sh', 'cp install.md other.md', 'echo install', 'echo npm ci',
    'git diff -- package.json', 'git add package-lock.json', 'printf "%s" "npm install"', 'grep -rn "npm ci" apps', 'ls install',
    'npm view vitest version', 'npm ls', 'npm --version', 'pip list', 'pip show x', 'cargo --version', 'go version', 'gem list',
  ])('text and read-only calls stay ordinary work: %s', async command => {
    expect(await agent(command)).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
  });
});

describe('local quality stages and bounded test selections', () => {
  it.each([
    'cmake --build .', 'tsc', 'tsc --noEmit', 'npx tsc -p apps/node', './node_modules/.bin/tsc', 'vue-tsc', 'mypy .', 'pyright', 'vite build', 'next build', 'webpack', 'rollup -c',
    'esbuild a.ts', 'cargo build', 'cargo check', 'cargo clippy', 'go build ./...', 'go vet ./...', 'dotnet build', 'docker build .', 'docker compose build', 'eslint .', 'eslint one.ts',
    'npx eslint .',
    'prettier --check .', 'biome check', 'ruff check .', 'flake8', 'pylint x', 'black .', 'isort .', 'gofmt -l .', 'rustfmt a.rs', 'rubocop',
    'crapper --use-existing-coverage a.ts', 'dryer a.ts', 'mutator a.ts', 'stryker run', 'mutmut run', 'c8 vitest run test/a.test.ts', 'coverage run x.py', 'python -m mypy .',
    'python3 -m ruff check .', 'python -m coverage run x.py', 'python -m black .',
  ])('allows: %s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: true }));
  });

  it.each([
    'turbo run build', 'nx build x', 'make', 'make test', 'ninja', 'mvn test', './gradlew test', 'gradle build', 'just test', 'nyc mocha', 'playwright test',
    'playwright test e2e/one.spec.ts', 'npx playwright test e2e/one.spec.ts', 'cypress run', 'wdio run x', 'nodemon a.js', 'node --watch a.js', 'tsx watch a.ts', 'mocha', 'ava', 'rspec',
    'phpunit', 'ctest', 'tox', 'nox', 'cargo test', 'go test ./...', 'bun test', 'bun test a.test.ts', 'deno test', 'dotnet test', 'python -m unittest',
  ])('refuses: %s', async command => {
    expect(await agent(command)).toEqual(denied('whole_suite_local'));
  });

  it.each([
    'vitest run test/a.test.ts test/b.test.ts', 'vitest run --coverage test/a.test.ts', 'vitest run --browser test/a.test.ts', 'vitest run --typecheck test/a.test.ts',
    'jest test/a.test.ts test/b.test.ts', 'jest --coverage test/a.test.ts', 'pytest test/a_test.py test/a_test.py', 'pytest --cov test/a_test.py', 'python -m pytest --cov=x test/a_test.py',
    'node --test test/a.test.ts test/b.test.ts', 'node --test --experimental-test-coverage test/a.test.ts', 'vitest run test/a.test.ts && vitest run test/b.test.ts',
    'vitest run test/a.test.ts; jest test/b.test.ts', 'NODE_V8_COVERAGE=out vitest run test/a.test.ts', 'export NODE_V8_COVERAGE=out; vitest run test/a.test.ts',
  ])('allows: %s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: true }));
  });

  it.each([
    'vitest', 'vitest run', 'vitest test/a.test.ts', 'vitest watch test/a.test.ts', 'vitest related test/a.test.ts', 'vitest bench', 'vitest list', 'vitest run test',
    'vitest run "test/*.test.ts"', 'vitest run test/*.test.ts', 'vitest run test/{a,b}.test.ts', 'vitest run test/[ab].test.ts', 'vitest run --changed',
    'vitest run --changed test/a.test.ts', 'vitest run --shard=1/2 test/a.test.ts', 'vitest run --watch test/a.test.ts', 'vitest run test/missing.test.ts', 'vitest run test/escape.test.ts',
    'vitest run test/inner-link.test.ts', 'vitest run ../outside.test.ts', 'vitest run away/outside.test.ts', 'jest', 'jest test', 'jest --watch test/a.test.ts', 'jest --watchAll',
    'jest --findRelatedTests a.ts', 'jest --onlyChanged', 'jest --shard=1/2 test/a.test.ts', 'pytest', 'pytest test', 'pytest -n 4 test/a_test.py', 'pytest --lf test/a_test.py',
    'python -m pytest', 'node --test', 'node --test test', 'node --test --watch test/a.test.ts', 'node --test --test-shard=1/2 test/a.test.ts',
    'while true; do vitest run test/a.test.ts; done', 'watch vitest run test/a.test.ts', 'env NODE_OPTIONS=--inspect vitest run test/a.test.ts', 'PYTEST_ADDOPTS=--cov pytest test/a_test.py',
    'cd /tmp && vitest run test/a.test.ts',
    `vitest run ${join('/tmp', 'a.test.ts')}`,
  ])('refuses: %s', async command => {
    expect(await agent(command)).toEqual(denied('whole_suite_local'));
  });
});

describe('literal test files run here', () => {
  it.each([
    'vitest run test/a.test.ts', 'vitest --run test/a.test.ts', 'vitest run ./test/a.test.ts', 'vitest run "test/a.test.ts"', 'vitest run test/a.test.ts -t "keeps words"', 'vitest run test/a.test.ts --reporter=verbose',
    './node_modules/.bin/vitest run test/a.test.ts', 'node node_modules/.bin/vitest run test/a.test.ts', 'npx vitest run test/a.test.ts', 'npx --no-install vitest run test/a.test.ts', 'npm exec -- vitest run test/a.test.ts', 'pnpm exec vitest run test/a.test.ts', 'yarn exec vitest run test/a.test.ts',
    'jest test/a.test.ts', 'jest --runTestsByPath test/a.test.ts', 'jest -t "x" test/a.test.ts', 'node --test test/a.test.ts', 'node --test --test-name-pattern=x test/a.test.ts',
    'pytest test/a_test.py', 'pytest test/a_test.py::test_x -q', 'pytest -x -vv --tb=short test/a_test.py', 'python -m pytest test/a_test.py', 'python3 -m pytest -q test/a_test.py',
    'npm run one', 'npm run -s one', 'npm test -- test/a.test.ts', 'pnpm run one', 'pnpm one', 'yarn one', 'yarn run one', 'bun run one',
    'CI=1 vitest run test/a.test.ts', 'env CI=1 vitest run test/a.test.ts', 'timeout 60 vitest run test/a.test.ts', 'time vitest run test/a.test.ts', 'nice -n 5 vitest run test/a.test.ts', 'sh -c "vitest run test/a.test.ts"', 'bash -lc "cd apps/node && vitest run test/a.test.ts"',
    'vitest run test/a.test.ts 2>&1 | tail -20', 'git status && vitest run test/a.test.ts', 'cd apps/node && npx vitest run test/a.test.ts', '(cd apps/node && vitest run test/a.test.ts)', 'npm --prefix apps/node run nested', 'npm -w apps/node run nested',
  ])('%s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: true, kind: 'test_files' }));
  });

  it('takes a folder that only starts with two dots for a folder of the workspace', async () => {
    file('..odd/package.json', JSON.stringify({ scripts: { odd: 'vitest run a.test.ts' } }));
    file('..odd/a.test.ts');
    expect(await agent('vitest run a.test.ts', join(root, '..odd'))).toEqual(expect.objectContaining({ kind: 'test_files' }));
    expect(await agent('npm run odd', join(root, '..odd'))).toEqual(expect.objectContaining({ kind: 'test_files' }));
  });

  it('counts from the folder the command stands in, tracked or not', async () => {
    expect(await agent('vitest run test/a.test.ts', node)).toEqual(expect.objectContaining({ kind: 'test_files' }));
    expect(existsSync(join(root, '.git'))).toBe(false);
    file('test/new-red.test.ts');
    expect(await agent('vitest run test/new-red.test.ts')).toEqual(expect.objectContaining({ kind: 'test_files' }));
  });

  it('keeps the folder only inside its own subshell', async () => {
    expect(await agent('(cd apps/node); vitest run test/a.test.ts')).toEqual(expect.objectContaining({ kind: 'test_files' }));
    expect(await agent('(cd test); vitest run a.test.ts')).toEqual(denied('whole_suite_local'));
    expect(await agent('cd test; vitest run a.test.ts')).toEqual(expect.objectContaining({ kind: 'test_files' }));
    expect(await agent('if true; then cd test; fi; vitest run a.test.ts')).toEqual(denied('whole_suite_local'));
  });
});

describe('one whole suite stage refuses the whole command before its first stage', () => {
  it.each([
    'echo a && vitest', 'vitest && echo a', 'true; vitest', 'false || vitest', 'ls | vitest', 'vitest | tail', '(vitest)', '( ( vitest ) )', '((vitest) ; echo a)', '((vitest) && (echo a) ; echo b)', '{ vitest; }', '! vitest', 'true & vitest', 'echo a\nvitest', 'ls \\\n  && vitest',
    'if vitest; then echo a; fi', 'if true; then vitest; fi', 'if true; then echo a; elif vitest; then echo b; fi', 'if true; then echo a; else vitest; fi',
    'for x in a b; do vitest; done', 'while vitest; do break; done', 'until false; do vitest; done', 'case a in a) vitest;; esac', 'case a in (a|b) echo x;; *) vitest;; esac',
    'echo $(vitest)', 'echo "$(vitest)"', 'echo `vitest`', 'echo "`vitest`"', 'echo ${X:-$(vitest)}', 'cat <(vitest)', 'echo a > >(vitest)', 'A=$(vitest) true', 'A=$(vitest)', 'cat > $(vitest)', 'echo $(echo $(vitest))',
    'f() { vitest; }', 'function f { vitest; }', 'for x in $(vitest); do echo $x; done', 'case $(vitest) in a) ;; esac', '[[ -n $(vitest) ]]',
    'cat <<EOF\n$(vitest)\nEOF', 'echo a # comment\nvitest', 'a=(1 $(vitest))',
  ])('%s', async command => {
    expect(await agent(command)).toEqual(denied('whole_suite_local'));
  });

  it('refuses an install, then a build, then a browser suite as one', async () => {
    expect(await agent('npm ci && npm run inner && playwright test')).toEqual(denied('whole_suite_local'));
    expect(await agent('echo a && npm ci')).toEqual(expect.objectContaining({ allow: true }));
  });

  it.each([
    'env CI=1 vitest', 'env -i vitest', 'env -u X vitest', 'env -C apps/node vitest', 'env vitest', 'time vitest', 'time -p vitest', 'nice vitest', 'nice -n 5 vitest', 'ionice -c 3 vitest', 'timeout 5 vitest', 'timeout -k 1 5 vitest', 'nohup vitest', 'command vitest', 'exec vitest',
    'stdbuf -oL vitest', 'setsid vitest', 'sudo vitest', 'sudo -u x vitest', 'xvfb-run -a vitest', 'watch vitest', 'cross-env A=1 vitest', 'hh-check vitest', 'hh-check -- vitest', 'HH_CHECK_SLOT=abc vitest', 'CI=1 vitest',
    'sh -c vitest', 'sh -c "vitest"', 'bash -c "echo a; vitest"', 'bash -lc vitest', 'sh -ec "vitest"', 'dash -c vitest', 'zsh -c vitest', 'sh -c "sh -c \'vitest\'"', 'eval vitest', 'eval "echo a; vitest"', 'bash <<EOF\nvitest\nEOF', 'bash <<< vitest',
    'xargs vitest', 'find . -name x -exec vitest {} +', 'find . -execdir vitest {} ;', 'parallel vitest',
    'npm exec -- vitest', 'npm exec vitest', 'npm x -- vitest', 'npm exec -c "vitest"', 'pnpm exec vitest', 'yarn exec vitest', 'npx --no-install vitest', 'npx -c "vitest"', 'poetry run vitest', 'pipenv run vitest', 'bundle exec vitest',
    'node node_modules/.bin/vitest', 'node node_modules/vitest/vitest.mjs', '/usr/local/bin/vitest', 'bash scripts/noext', './scripts/noext', 'sh scripts/noext', '. scripts/noext', 'source scripts/noext',
    'busybox sh -c vitest', 'env $X vitest', 'env "$X" CI=1 vitest', 'env -S "vitest"', 'env --split-string=vitest', 'bash -o pipefail -c "vitest"', 'bash -eo pipefail -c vitest', 'bash +e -c vitest', 'bash --norc -c vitest', 'command -p vitest',
  ])('a wrapper does not hide what it runs: %s', async command => {
    expect(await agent(command)).toEqual(denied('whole_suite_local'));
  });

  it.each(['bash scripts/heavy.sh', './scripts/heavy.sh', 'sh ./scripts/heavy.sh', '. scripts/heavy.sh', 'source scripts/heavy.sh', 'eval "npm ci"', 'sudo apt-get install -y x', 'env npm ci', 'npm run behind-script'])('nor a script file: %s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: true }));
  });

  it.each(['vitest run "$F"', 'vitest run $F', 'vitest $MODE test/a.test.ts', 'jest "$(cat list)"', 'vitest run test/a.test.ts $MORE', 'vitest run -t "$X" test/a.test.ts', 'pytest $F', 'node --test $F', 'xargs vitest run', 'find . -exec vitest run {} +', 'ls | xargs jest', 'cd $X && vitest run test/a.test.ts', 'cd - && vitest run test/a.test.ts', 'cd && vitest run test/a.test.ts', 'pushd apps/node && popd && vitest run test/a.test.ts'])('a dynamic selection at a check: %s', async command => {
    expect(await agent(command)).toEqual(denied('whole_suite_local'));
  });
});

describe('package scripts are read, not run', () => {
  it.each(['npm run hidden', 'pnpm run hidden', 'pnpm hidden', 'yarn hidden', 'yarn run hidden', 'bun run hidden', 'npm run guarded --silent', 'npm run posted', 'npm test -- --coverage test/a.test.ts', 'npm test -- test/a.test.ts test/b.test.ts'])('allows local script checks: %s', async command => {
    expect(await agent(command)).toMatchObject({ allow: true });
  });

  it.each(['npm test', 'npm t', 'npm run test', 'npm run-script test', 'pnpm test', 'pnpm run test', 'yarn test', 'bun run test', 'pnpm test --coverage'])('%s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: false }));
  });

  it('resolves a script of the nearest manifest, with its folder', async () => {
    expect(await agent('npm run nested', node)).toEqual(expect.objectContaining({ kind: 'test_files' }));
    expect(await agent('npm run nestedall', node)).toEqual(denied('whole_suite_local'));
    expect(await agent('npm run one', join(root, 'test'))).toEqual(expect.objectContaining({ kind: 'test_files' }));
  });

  it.each(['npm --workspaces test', 'npm test --workspaces', 'npm test -ws', 'pnpm -r test', 'pnpm --recursive test', 'pnpm --filter x test', 'pnpm -F x test', 'yarn workspaces foreach test', 'yarn workspaces run test'])('more than one package: %s', async command => {
    expect(await agent(command)).toEqual(denied('whole_suite_local'));
  });

  it.each(['npm run nothing', 'npm run cycle-a', 'npm run dyn', 'npm run dynamic', 'npm run broken', 'npm run $X', 'npm run "$X"', 'npm test -- $F', 'npm --prefix $D run one', 'npm --prefix /tmp run one', 'npm -w no-such-package run one', 'npm publish', 'npm pack', 'npm version patch'])('what cannot be told at a package boundary: %s', async command => {
    expect(await agent(command)).toEqual(denied('command_guard_unavailable'));
  });

  it('allows what a literal script holds, and says when that is opaque', async () => {
    expect(await agent('npm run plain')).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    expect(await agent('npm run light')).toEqual({ allow: true, kind: 'ordinary', coverage: 'opaque' });
    expect(await agent('npm run')).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
  });

  it('never reads a manifest through a link or above the workspace', async () => {
    expect(await agent('npm --prefix away run one')).toEqual(denied('command_guard_unavailable'));
    writeFileSync(join(base, 'package.json'), JSON.stringify({ scripts: { above: 'echo hi' } }));
    expect(await agent('npm run above', join(root, 'test'))).toEqual(denied('command_guard_unavailable'));
    rmSync(join(base, 'package.json'));
  });
});

describe('ordinary work keeps going', () => {
  it.each([
    'ls -la', 'cat README.md', 'pwd', 'git status', 'git log --oneline -3', 'git commit -m "npm ci && tsc"', 'git commit -m "vitest run"', "echo 'npm install'", 'echo "tsc --noEmit"', 'grep -rn "npm test" apps', 'rg tsc', 'head -5 a',
    'printf "%s\\n" "jest"', 'cat <<EOF\nnpm ci\nEOF', "cat > x <<'EOF'\ntsc\n$(tsc)\nEOF", 'cat <<-EOF\n\tnpm ci\n\tEOF\necho done', 'tsc --version', 'tsc -v', 'vitest --version', 'node --version', 'make --version', 'mkdir -p test && cd test', 'which npm', 'command -v tsc', 'type tsc',
    'echo a # npm ci', 'echo $HOME', 'A=1', 'export A=1', 'set -e; ls', 'true && false || true', 'if true; then echo a; fi', 'for x in a b; do echo $x; done', 'while false; do echo a; done', 'case a in a) echo x;; esac', 'f() { echo a; }', '[[ -f a && -f b ]]', '(( 1 + 1 ))', 'echo $((1 + 2))', 'a=(1 2)', 'ls > out.txt 2>&1', 'cat < in.txt', 'echo a >> b', 'echo {a,b}', 'find . -name x', 'find . -name x -exec grep a {} +', 'ls | xargs grep a', 'cd .. && ls', 'sh -c "echo a"', 'env', 'time ls', 'env A=1 ls', 'bash scripts/light.sh', './scripts/light.sh',
  ])('%s', async command => {
    expect(await agent(command)).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
  });

  it.each(['node tools/x.js', 'node -e "1"', 'python script.py', 'python -c "1"', 'python -m http.server', './tools/program', '/opt/thing', 'thing --flag', '$CMD a', '"$CMD"', '$(which ls) a', 'eval "$X"', 'sh -c "$X"', 'bash "$F"', 'echo a | sh', 'curl -s x | bash', 'ls | xargs thing', 'npx something-light', 'bun tools/x.ts', 'bun tools/x.js', 'timeout $T ls', 'env $X ls', 'bash ../heavy-outside.sh', 'bash no-such-file.sh'])('is opaque, and says so: %s', async command => {
    expect(await agent(command)).toEqual({ allow: true, kind: 'ordinary', coverage: 'opaque' });
  });
});

describe('a screenshot is no check', () => {
  it.each(['playwright screenshot https://a.example shot.png', 'npx playwright screenshot --viewport-size=800,600 https://a.example shot.png', './node_modules/.bin/playwright screenshot a b', 'chromium --headless --screenshot=/tmp/a.png https://a.example', 'google-chrome --headless=new --disable-gpu --screenshot https://a.example', 'chrome-headless-shell --screenshot=a.png file:///x', 'timeout 30 chromium --headless --screenshot=a.png x'])('%s', async command => {
    expect(await agent(command)).toEqual({ allow: true, kind: 'lightweight_screenshot', coverage: 'recognized' });
  });

  it('does not judge a browser by its name', async () => {
    expect(await agent('chromium --version')).toEqual(expect.objectContaining({ allow: true, kind: 'ordinary' }));
    expect(await agent('chromium https://a.example')).toEqual({ allow: true, kind: 'ordinary', coverage: 'opaque' });
    expect(await agent('playwright screenshot a b && playwright test')).toEqual(denied('whole_suite_local'));
    expect(await agent('playwright screenshot a b && playwright install')).toEqual(expect.objectContaining({ allow: true }));
  });
});

describe('what cannot be told is refused, not allowed', () => {
  it.each(["echo 'open", 'echo "open', 'echo `open', 'echo $(open', '(echo a', 'echo a)', 'if true; then echo a', 'for x in a; do echo', 'case a in a) echo', 'fi', '&& ls', '{ echo a;', 'echo ${open', 'echo $((1 + 2', '`'])('%s', async command => {
    expect(await agent(command)).toEqual(denied('command_guard_unavailable'));
  });

  it('holds every bound at its limit', async () => {
    const nested = (depth: number) => `${'( '.repeat(depth)}ls${' )'.repeat(depth)}`;
    expect(await agent(nested(COMMAND_LIMITS.nesting - 2))).toEqual(expect.objectContaining({ allow: true }));
    expect(await agent(nested(COMMAND_LIMITS.nesting + 1))).toEqual(denied('command_guard_unavailable'));
    const shells = (depth: number): string => (depth ? `sh -c ${`'${shells(depth - 1).replaceAll("'", "'\\''")}'`}` : 'ls');
    expect(await agent(shells(COMMAND_LIMITS.resolving - 1))).toEqual(expect.objectContaining({ allow: true }));
    expect(await agent(shells(COMMAND_LIMITS.resolving + 1))).toEqual(denied('command_guard_unavailable'));
    expect(await agent(`${'ls; '.repeat(COMMAND_LIMITS.stages - 1)}ls`)).toEqual(expect.objectContaining({ allow: true }));
    expect(await agent('ls; '.repeat(COMMAND_LIMITS.stages + 1))).toEqual(denied('command_guard_unavailable'));
    expect(await agent(`echo ${'a'.repeat(COMMAND_LIMITS.commandBytes)}`)).toEqual(denied('command_guard_unavailable'));
    expect(await agent(['echo', 'a'.repeat(COMMAND_LIMITS.commandBytes)])).toEqual(denied('command_guard_unavailable'));
    expect(await agent('echo a\0b')).toEqual(denied('command_guard_unavailable'));
  });

  it('stops scripts that fan out long before it has walked them all', async () => {
    const calls = (next: string) => Array.from({ length: 200 }, () => `npm run ${next}`).join('; ');
    const scripts = Object.fromEntries(Array.from({ length: COMMAND_LIMITS.resolving }, (_, i) => [`s${i}`, calls(`s${i + 1}`)]));
    file('wide/package.json', JSON.stringify({ scripts: { ...scripts, [`s${COMMAND_LIMITS.resolving}`]: 'echo end' } }));
    const started = Date.now();
    expect(await agent('npm run s0', join(root, 'wide'))).toEqual(denied('command_guard_unavailable'));
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('tells two commands at once apart', async () => {
    const told = await Promise.all([agent('tsc'), agent('ls'), agent('npm ci'), agent('vitest run test/a.test.ts'), agent('bash scripts/heavy.sh'), agent('bash scripts/light.sh')]);
    expect(told.map(verdict => (verdict.allow ? verdict.kind : verdict.code))).toEqual(['ordinary', 'ordinary', 'ordinary', 'test_files', 'ordinary', 'ordinary']);
  });

  it('refuses a script that calls itself and a chain past its limit', async () => {
    expect(await agent('bash scripts/self.sh')).toEqual(denied('command_guard_unavailable'));
    const chain = Object.fromEntries(Array.from({ length: COMMAND_LIMITS.resolving + 2 }, (_, i) => [`s${i}`, `npm run s${i + 1}`]));
    file('deep/package.json', JSON.stringify({ scripts: { ...chain, [`s${COMMAND_LIMITS.resolving + 2}`]: 'echo end' } }));
    expect(await agent('npm run s0', join(root, 'deep'))).toEqual(denied('command_guard_unavailable'));
  });

  it('reads a manifest only up to its limit, and only so many files', async () => {
    file('big/package.json', JSON.stringify({ scripts: { a: 'echo a' }, pad: 'x'.repeat(COMMAND_LIMITS.fileBytes) }));
    expect(await agent('npm run a', join(root, 'big'))).toEqual(denied('command_guard_unavailable'));
    file('bad/package.json', '{ not json');
    expect(await agent('npm run a', join(root, 'bad'))).toEqual(denied('command_guard_unavailable'));
    file('odd/package.json', JSON.stringify({ scripts: { a: 1 } }));
    expect(await agent('npm run a', join(root, 'odd'))).toEqual(denied('command_guard_unavailable'));
    const reads = Array.from({ length: COMMAND_LIMITS.fileReads + 1 }, (_, i) => {
      file(`many/s${i}.sh`, 'echo a\n');
      return `sh many/s${i}.sh`;
    });
    expect(await agent(reads.slice(0, COMMAND_LIMITS.fileReads).join(' && '))).toEqual(expect.objectContaining({ allow: true }));
    expect(await agent(reads.join(' && '))).toEqual(denied('command_guard_unavailable'));
  });

  it('answers a failing file port with a refusal and never throws', async () => {
    const failing: CommandFiles = { lstat: () => Promise.reject(new Error('no')), realpath: () => Promise.reject(new Error('no')), read: () => Promise.reject(new Error('no')), list: () => Promise.reject(new Error('no')) };
    await expect(classifyAgentCommand({ command: 'npm run one', cwd: root, workspaceRoot: root }, failing)).resolves.toEqual(denied('command_guard_unavailable'));
    await expect(classifyRunWork({ command: 'npm run one', cwd: root, workspaceRoot: root }, failing)).resolves.toEqual(denied('command_guard_unavailable'));
  });

  it('allows no test file without a workspace it can see', async () => {
    expect(await classifyAgentCommand({ command: 'vitest run test/a.test.ts', cwd: root, workspaceRoot: join(base, 'no-such-root') })).toEqual(denied('whole_suite_local'));
    expect(await classifyAgentCommand({ command: 'vitest run test/a.test.ts', cwd: 'relative', workspaceRoot: root })).toEqual(denied('whole_suite_local'));
  });
});

describe('a flag and its value in one word are told like two', () => {
  it.each(['env --chdir=apps/node npm run nested', 'env -Capps/node npm run nested', 'pnpm -Capps/node run nested', 'npm -wapps/node run nested', 'npm --prefix=apps/node run nested'])('moves to the folder it names: %s', async command => {
    expect(await agent(command)).toEqual({ allow: true, kind: 'test_files', coverage: 'recognized' });
  });

  it.each(['env --chdir=apps/node npm run nestedall', 'env -Capps/node npm run nestedall', 'pnpm -Capps/node run nestedall', 'npm -wapps/node run nestedall'])('and tells the script of that folder: %s', async command => {
    expect(await agent(command)).toEqual(denied('whole_suite_local'));
  });

  it.each(['pnpm -Fsome run one', 'pnpm --filter=some run one'])('works over many packages: %s', async command => {
    expect(await agent(command)).toEqual({ allow: false, code: 'whole_suite_local', category: 'package_scope' });
  });

  it('takes -ws for every workspace and not for a workspace named s', async () => {
    expect(await agent('npm -ws run nestedall --if-present')).toEqual({ allow: false, code: 'whole_suite_local', category: 'test_scope' });
    expect(await agent('npm -ws run nested --if-present')).toEqual(expect.objectContaining({ allow: true, kind: 'test_files' }));
  });

  it.each(['npx --call=tsc', 'npx -ctsc', "npx --call='tsc --noEmit'", 'python3 -mmypy x'])('runs what it carries: %s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: true }));
  });

  it.each(['npx -psomething tsc', 'python -mpip install x'])('fetches what it carries: %s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: true }));
  });

  it('stops at python -c, whose text is no module', async () => {
    expect(await agent('python -c "1" -m pytest')).toEqual({ allow: true, kind: 'ordinary', coverage: 'opaque' });
  });
});

describe('words the shell quotes its own way', () => {
  it('reads a word with no escape as the word it is', async () => {
    expect(await agent("$'tsc' --noEmit")).toMatchObject({ allow: true });
    expect(await agent("echo $'a'")).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
  });

  it('calls a word with an escape unknown, and reads past it', async () => {
    expect(await agent("$'ts\\x63'")).toEqual({ allow: true, kind: 'ordinary', coverage: 'opaque' });
    expect(await agent("echo $'a\\'b'; tsc")).toMatchObject({ allow: true });
  });

  it('refuses one left open', async () => {
    expect(await agent("echo $'open")).toEqual(denied('command_guard_unavailable'));
  });
});

describe('a word is only a word, whatever it is called', () => {
  it.each(['cargo constructor', 'playwright constructor', 'rustup __proto__', 'pip toString'])('%s', async command => {
    expect(await agent(command)).toEqual({ allow: false, code: 'command_guard_unavailable', category: 'package_boundary' });
  });

  it('calls the program behind it opaque where the rest of its words are', async () => {
    expect(await agent('go toString')).toEqual({ allow: true, kind: 'ordinary', coverage: 'opaque' });
    expect(await agent('docker constructor')).toEqual({ allow: true, kind: 'ordinary', coverage: 'opaque' });
  });

  it('reads a package script of that name like any other', async () => {
    file('named/package.json', JSON.stringify({ scripts: { constructor: 'tsc' } }));
    expect(await agent('npm run constructor', join(root, 'named'))).toMatchObject({ allow: true });
    expect(await agent('pnpm toString', join(root, 'named'))).toEqual(denied('command_guard_unavailable'));
  });
});

describe('the rest of what programs take', () => {
  it.each([
    'xargs -n 1 tsc', 'xargs -0 tsc', 'parallel -j 2 tsc', 'poetry run tsc', 'poetry run -- tsc', 'docker compose build', 'python -W ignore -m mypy x',
    'tsx --test test/a.test.ts test/b.test.ts', 'npx -- tsc', 'pnpm exec tsc', 'bunx tsc', 'npx --no-install tsc', 'NODE_V8_COVERAGE=x vitest run test/a.test.ts',
  ])('allows: %s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: true }));
  });

  it.each([
    'python -X utf8 -m pytest', 'tsx --test', 'playwright $X', 'vitest run --reporter $X test/a.test.ts', 'while true; do vitest run test/a.test.ts; done',
  ])('refuses: %s', async command => {
    expect(await agent(command)).toEqual(denied('whole_suite_local'));
  });

  it.each(['pip $X', 'npx $X', 'npx -c "$X"', 'npm run "$X"', 'npm run one "$X"', 'pip --quiet'])('cannot be told: %s', async command => {
    const told = await agent(command);
    expect(told.allow ? told.kind : told.code).toBe(command === 'pip --quiet' ? 'ordinary' : 'command_guard_unavailable');
  });

  it.each(['xargs', 'xargs -n 1', 'playwright', 'pip', 'npx', 'playwright --version', 'env -- ls', 'env -i ls', 'nice -n 5 ls', 'timeout -k 1 5 ls', 'command -v tsc', 'echo "a\\$b\\c"', 'echo ~/a', 'echo a*'])('asks for nothing heavy: %s', async command => {
    expect(await agent(command)).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
  });

  it.each(['tsx tools/x.ts', 'python -m "$X"', 'python -m', 'python -X utf8', 'python', 'docker', 'docker compose up', 'docker ps', 'go frob', 'npx --no-install not-here', 'sudo ls $X'])('is opaque, and says so: %s', async command => {
    expect(await agent(command)).toEqual({ allow: true, kind: 'ordinary', coverage: 'opaque' });
  });

  it.each(['case', 'case a', 'case a in', 'select', 'for', 'function', 'until true'])('is no shell at all: %s', async command => {
    expect(await agent(command)).toEqual(denied('command_guard_unavailable'));
  });

  it('runs one test file through tsx', async () => {
    expect(await agent('tsx --test test/a.test.ts')).toEqual({ allow: true, kind: 'test_files', coverage: 'recognized' });
  });

  it('tells a broken text apart from a broken script', async () => {
    expect(await agent('sh -c "echo \'open"')).toEqual({ allow: false, code: 'command_guard_unavailable', category: 'malformed' });
    expect(await agent('npm run dynamic')).toEqual({ allow: false, code: 'command_guard_unavailable', category: 'dynamic_check' });
    expect(await agent('npm run broken')).toEqual({ allow: false, code: 'command_guard_unavailable', category: 'unresolved_script' });
  });
});

describe('a claim gives nothing', () => {
  it('takes no origin, lease or runner from what it is told', async () => {
    const claims = { isRunner: true, origin: 'runner', lease: 'abc', redGreen: true, sender: 'node', kind: 'work' };
    expect(await classifyAgentCommand({ command: 'npm ci && npm test', cwd: root, workspaceRoot: root, ...claims } as never)).toEqual(denied('whole_suite_local'));
    expect(await agent('HH_CHECK_SLOT=real-lease IS_RUNNER=1 npm ci')).toEqual(expect.objectContaining({ allow: true }));
    expect(await agent('hh-check npm ci')).toEqual(expect.objectContaining({ allow: true }));
  });

  it('reads an argument list as literal words of one command', async () => {
    expect(await agent(['npm', 'ci'])).toEqual(expect.objectContaining({ allow: true }));
    expect(await agent(['tsc', '--noEmit'])).toMatchObject({ allow: true });
    expect(await agent(['env', 'CI=1', 'tsc'])).toMatchObject({ allow: true });
    expect(await agent(['bash', '-o', 'pipefail', '-c', 'npm ci'])).toEqual(expect.objectContaining({ allow: true }));
    expect(await agent(['sh', '-c', 'npm ci'])).toEqual(expect.objectContaining({ allow: true }));
    expect(await agent(['vitest', 'run', 'test/a.test.ts'])).toEqual(expect.objectContaining({ kind: 'test_files' }));
    expect(await agent(['vitest', 'run', 'test/a.test.ts', 'test/b.test.ts'])).toMatchObject({ allow: true, kind: 'test_files' });
    expect(await agent(['echo', 'npm ci', '$(tsc)'])).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    expect(await agent(['vitest', 'run', 'test/*.test.ts'])).toEqual(denied('whole_suite_local'));
    expect(await agent([])).toEqual(denied('command_guard_unavailable'));
  });
});

describe('work under the existing work rights', () => {
  it.each(['npm ci', 'pnpm install', 'pnpm dlx x', 'pip install -r requirements.txt', 'npm ci && pip install x', 'npm ci && ls', 'sh -c "npm ci"', 'playwright install chromium', 'cd apps/node && npm ci'])('prepares dependencies: %s', async command => {
    expect(await work(command)).toEqual(expect.objectContaining({ allow: true, kind: 'dependency_preparation' }));
  });

  it.each(['vitest run test/a.test.ts', 'npm test', 'npm ci && npm test', 'npm ci && tsc', 'npm install && playwright test', 'npm ci; eslint .', 'npm run one', 'crapper a.ts', 'sh -c "npm ci && vitest run test/a.test.ts"', 'hh-check tsc'])('gives any check to run_tests: %s', async command => {
    expect(await work(command)).toEqual(denied('whole_suite_local'));
  });

  it('keeps ordinary work, honestly opaque too, and refuses what it cannot tell', async () => {
    expect(await work('ls')).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    expect(await work('node tools/x.js')).toEqual({ allow: true, kind: 'ordinary', coverage: 'opaque' });
    expect(await work('playwright screenshot a b')).toEqual({ allow: true, kind: 'lightweight_screenshot', coverage: 'recognized' });
    expect(await work('npm ci && node tools/x.js')).toEqual({ allow: true, kind: 'dependency_preparation', coverage: 'opaque' });
    expect(await work('echo "open')).toEqual(denied('command_guard_unavailable'));
  });
});

describe('telling runs nothing', () => {
  it.each(['touch SENT && npm ci', 'npm ci; touch SENT', 'echo $(touch SENT) && tsc', 'bash scripts/sent.sh', 'sh -c "touch SENT; tsc"', 'npm run sent', 'touch SENT', 'eval "touch SENT"', 'cat <(touch SENT)'])('%s leaves no trace', async command => {
    file('scripts/sent.sh', 'touch SENT\ntsc\n');
    file('sent/package.json', JSON.stringify({ scripts: { sent: 'touch SENT && tsc' } }));
    await agent(command);
    await agent(command, join(root, 'sent'));
    await work(command);
    expect(existsSync(join(root, 'SENT'))).toBe(false);
    expect(existsSync(join(root, 'sent/SENT'))).toBe(false);
  });

  it('stands alone: nothing to spawn, no network, no package of the project', () => {
    const source = readFileSync(new URL('../src/command-guard.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
    expect(imports.every(name => name?.startsWith('node:'))).toBe(true);
    expect(imports.filter(name => /child_process|net|http|https|dns|tls|dgram|worker/.test(name!))).toEqual([]);
    expect(source).not.toMatch(/(?<![.\w])(?:fetch|require|eval|spawn|exec|execFile)\(/);
  });
});

describe('the refusal', () => {
  const verdict = async (command: string) => (await agent(command)) as CommandDenial;

  it.each(['npm test', 'vitest', 'npm run nothing', 'echo "open'])('starts with the same line: %s', async command => {
    expect(refusalText(await verdict(command)).split('\n')[0]).toBe('запусти через run_tests');
  });

  it('says what it stopped, within bounds, and copies nothing of the command', async () => {
    const text = refusalText(await verdict('NPM_TOKEN=s3cret vitest run --unknown=https://me:s3cret@a.example'));
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('a.example');
    expect(text.length).toBeLessThan(400);
    expect(text.split('\n').length).toBeGreaterThan(1);
  });
});

/* What each program's own documentation says it reads. None of this shows that an installed version respects it. */
describe('the answer to a program that asked', () => {
  const FIRST_LINE = 'запусти через run_tests';
  const denied: CommandDenial = { allow: false, code: 'whole_suite_local', category: 'guard_failed' };
  const reasonOf = (program: NativeProgram, stdout: string): string => {
    const said = JSON.parse(stdout) as { reason?: string; hookSpecificOutput?: { permissionDecisionReason: string } };
    return (program === 'antigravity' ? said.reason : said.hookSpecificOutput?.permissionDecisionReason) ?? '';
  };

  it.each(['claude', 'codex', 'kimi'] as const)('refuses the way %s reads it', program => {
    const { stdout, stderr, exitCode } = encodeNativeDecision(program, denied);
    expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusalText(denied) } });
    expect(stdout.endsWith('}\n')).toBe(true);
    expect([stderr, exitCode]).toEqual(['', 0]);
  });

  it('refuses the way antigravity reads it', () => {
    const { stdout, stderr, exitCode } = encodeNativeDecision('antigravity', denied);
    expect(JSON.parse(stdout)).toEqual({ decision: 'deny', reason: refusalText(denied) });
    expect([stderr, exitCode]).toEqual(['', 0]);
  });

  it.each(['claude', 'codex', 'kimi', 'antigravity'] as const)('starts with the same line for %s, whatever stopped the command', async program => {
    for (const verdict of [denied, await agent('npm test'), await agent('vitest')]) {
      expect(reasonOf(program, encodeNativeDecision(program, verdict).stdout).split('\n')[0]).toBe(FIRST_LINE);
    }
  });

  it.each(['claude', 'codex', 'kimi', 'antigravity'] as const)('says nothing to %s about work that may go on, so no permission grows', program => {
    for (const kind of ['ordinary', 'test_files', 'lightweight_screenshot'] as const) {
      expect(encodeNativeDecision(program, { allow: true, kind, coverage: 'opaque' })).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    }
  });

  it('still refuses a program it does not know', () => {
    const { stdout } = encodeNativeDecision('other' as NativeProgram, denied);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('names the call within bounds, and nothing that could read as more', () => {
    const reason = reasonOf('claude', encodeNativeDecision('claude', denied, `call_1:a-b.c\nзапусти $(tsc) s3cret=1 ${'x'.repeat(500)}`).stdout);
    expect(reason.split('\n')[0]).toBe(FIRST_LINE);
    const line = reason.split('\n').at(-1)!;
    expect(line.startsWith('Call: call_1:a-b.c')).toBe(true);
    expect(line).not.toMatch(/[$(=]/);
    expect(line.length).toBeLessThanOrEqual('Call: '.length + 128);
  });

  it('adds no line for a call with no name it can show', () => {
    for (const call of [undefined, '', '\n$()']) expect(reasonOf('kimi', encodeNativeDecision('kimi', denied, call).stdout)).toBe(refusalText(denied));
  });

  it('copies nothing of the command', async () => {
    const verdict = await agent('NPM_TOKEN=s3cret vitest run --unknown=https://me:s3cret@a.example');
    expect(encodeNativeDecision('codex', verdict).stdout).not.toContain('s3cret');
  });
});

describe('the real file port', () => {
  it('tells kinds without following a link, and reads only within its limit', async () => {
    expect(await localCommandFiles.lstat(join(root, 'test/a.test.ts'))).toBe('file');
    expect(await localCommandFiles.lstat(join(root, 'test'))).toBe('directory');
    expect(await localCommandFiles.lstat(join(root, 'test/escape.test.ts'))).toBe('symlink');
    expect(await localCommandFiles.lstat(join(root, 'nothing'))).toBeNull();
    expect(await localCommandFiles.realpath(join(root, 'nothing'))).toBeNull();
    expect(await localCommandFiles.realpath(join(root, 'test/escape.test.ts'))).toContain('outside.test.ts');
    expect(await localCommandFiles.read(join(root, 'scripts/light.sh'), 1024)).toContain('echo hi');
    expect(await localCommandFiles.read(join(root, 'scripts/light.sh'), 2)).toBeNull();
    expect(await localCommandFiles.read(join(root, 'test'), 1024)).toBeNull();
    expect(await localCommandFiles.read(join(root, 'test/escape.test.ts'), 1024)).toBeNull();
    expect(await localCommandFiles.read(join(root, 'nothing'), 1024)).toBeNull();
  });
});

describe('a test run of a change keeps the options that pick its project', () => {
  it.each([
    'vitest run --config vitest.config.mjs --project=@hornhoof/server test/a.test.ts',
    'npx --no-install vitest run --config vitest.config.mjs --project @hornhoof/server test/a.test.ts test/b.test.ts',
    'vitest run -c vitest.config.mjs --root . --dir test test/a.test.ts',
  ])('allows %s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: true, kind: 'test_files' }));
  });

  it.each(['vitest run --config vitest.config.mjs --project=@hornhoof/server', 'vitest run --config vitest.config.mjs --project=x --shard=1/2 test/a.test.ts'])('refuses %s', async command => {
    expect(await agent(command)).toEqual(denied('whole_suite_local'));
  });
});

describe('a workspace is found by its name, as npm finds it', () => {
  it('reads the script of the workspace a name stands for', async () => {
    expect(await agent('npm run build -w @fx/lib')).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    expect(await agent('npm run one --workspace @fx/lib')).toEqual(expect.objectContaining({ allow: true, kind: 'test_files' }));
    expect(await agent('npm run one --workspace=@fx/lib')).toEqual(expect.objectContaining({ allow: true, kind: 'test_files' }));
    expect(await agent('npm run test -w @fx/lib')).toEqual(denied('whole_suite_local'));
  });

  it('allows whole-project types and lint that build a workspace by name and lint every workspace and the root', async () => {
    expect(await agent('npm run types')).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    expect(await agent('npm run lint')).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    expect(await agent('npm run lint:part --workspaces --include-workspace-root --', node)).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
  });

  it('refuses a workspaces run when one workspace refuses, and one without the script unless --if-present', async () => {
    expect(await agent('npm test --workspaces')).toEqual(denied('whole_suite_local'));
    expect(await agent('npm run nestedall --workspaces --if-present')).toEqual(denied('whole_suite_local'));
    expect(await agent('npm run nested --workspaces')).toEqual({ allow: false, code: 'command_guard_unavailable', category: 'unresolved_script' });
    expect(await agent('npm run nested --workspaces --if-present')).toEqual(expect.objectContaining({ allow: true, kind: 'test_files' }));
    expect(await agent('npm run lint:part --workspaces --if-present --include-workspace-root')).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    expect(await agent('npm run nested -w @fx/lib -w apps/node --if-present')).toEqual(expect.objectContaining({ allow: true, kind: 'test_files' }));
    expect(await agent('npm run nestedall -w @fx/lib -w apps/node --if-present')).toEqual(denied('whole_suite_local'));
  });

  it('reads each switch of workspaces as npm does: on alone, the true or false in its word or the next, the opposite behind --no-', async () => {
    const off = ['--workspaces=false', '--workspaces false', '--no-workspaces', '-ws=false', '-ws false', '--workspaces --no-workspaces', '--no-workspaces=true', '--workspaces --workspaces=false'];
    for (const flags of off) expect(await agent(`npm run all ${flags} --if-present`), flags).toEqual(denied('whole_suite_local'));
    for (const flags of ['--workspaces=true', '--workspaces true', '--no-workspaces --workspaces', '--no-workspaces=false']) {
      expect(await agent(`npm run all ${flags} --if-present`), flags).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    }
    for (const flags of ['--include-workspace-root', '--include-workspace-root=true', '--include-workspace-root true']) {
      expect(await agent(`npm run all --workspaces --if-present ${flags}`), flags).toEqual(denied('whole_suite_local'));
    }
    for (const flags of ['--include-workspace-root=false', '--include-workspace-root false', '--no-include-workspace-root']) {
      expect(await agent(`npm run all --workspaces --if-present ${flags}`), flags).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    }
    for (const flags of ['--if-present=false', '--if-present false', '--no-if-present']) {
      expect(await agent(`npm run nested --workspaces ${flags}`), flags).toEqual({ allow: false, code: 'command_guard_unavailable', category: 'unresolved_script' });
    }
    expect(await agent('npm run nested --workspaces --if-present=true')).toEqual(expect.objectContaining({ allow: true, kind: 'test_files' }));
  });

  it('cannot tell a switch of workspaces whose value is no true or false, and runs nothing over every workspace beside a script', async () => {
    for (const flags of ['--workspaces=maybe', '--workspaces=', '--include-workspace-root=1', '--if-present=yes', '--workspaces "$X"']) {
      expect(await agent(`npm run all ${flags}`), flags).toEqual({ allow: false, code: 'command_guard_unavailable', category: 'dynamic_check' });
    }
    expect(await agent('npm -ws exec tsc')).toEqual({ allow: false, code: 'whole_suite_local', category: 'package_scope' });
    expect(await agent('npm exec --workspaces=false -- vitest run test/a.test.ts')).toEqual(expect.objectContaining({ allow: true, kind: 'test_files' }));
  });

  it('reads no more manifests and folders than its limits allow', async () => {
    const many = join(base, 'many');
    mkdirSync(many);
    writeFileSync(join(many, 'package.json'), JSON.stringify({ workspaces: ['p/*'] }));
    for (let i = 0; i <= COMMAND_LIMITS.fileReads; i++) {
      mkdirSync(join(many, `p/w${i}`), { recursive: true });
      writeFileSync(join(many, `p/w${i}/package.json`), JSON.stringify({ name: `w${i}`, scripts: { check: 'tsc --noEmit' } }));
    }
    const at = (command: string) => classifyAgentCommand({ command, cwd: many, workspaceRoot: many });
    expect(await at('npm run check --workspaces')).toEqual({ allow: false, code: 'command_guard_unavailable', category: 'over_budget' });
    expect(await at('npm run check -w w3')).toEqual({ allow: false, code: 'command_guard_unavailable', category: 'over_budget' });
    expect(await at('npm run check -w p/w3')).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
  });

  it('reads the workspaces npm reads, and cannot tell those it cannot list', async () => {
    const odd = join(base, 'odd-workspaces');
    mkdirSync(join(odd, 'a/b'), { recursive: true });
    writeFileSync(join(odd, 'a/b/package.json'), JSON.stringify({ name: 'deep', scripts: { check: 'tsc --noEmit' } }));
    const told = async (workspaces: unknown) => {
      writeFileSync(join(odd, 'package.json'), JSON.stringify({ workspaces }));
      return classifyAgentCommand({ command: 'npm run check -w deep', cwd: odd, workspaceRoot: odd });
    };
    for (const workspaces of [['a/*'], ['a/b'], { packages: ['a/*'] }]) expect(await told(workspaces), JSON.stringify(workspaces)).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    for (const workspaces of [['a/**'], ['!a/*'], ['../*'], 'a/*', [7]]) {
      expect(await told(workspaces), JSON.stringify(workspaces)).toEqual({ allow: false, code: 'command_guard_unavailable', category: 'unresolved_script' });
    }
  });
});

describe('a workspace named after the script name is the folder whose script runs', () => {
  it('runs the named workspace script', async () => {
    expect(await agent('npm run nested -w apps/node')).toEqual(expect.objectContaining({ kind: 'test_files' }));
    expect(await agent('npm run nested --workspace=apps/node')).toEqual(expect.objectContaining({ kind: 'test_files' }));
  });

  it('refuses the named workspace script that runs its whole suite', async () => {
    expect(await agent('npm run nestedall -w apps/node')).toEqual(denied('whole_suite_local'));
  });
});
