import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyAgentCommand, classifyRunWork, COMMAND_LIMITS, localCommandFiles, refusalText, type CommandDenial, type CommandFiles } from '../src/command-guard.js';

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
  file('package.json', JSON.stringify({ scripts: SCRIPTS }));
  file('test/a.test.ts');
  file('test/b.test.ts');
  file('test/a_test.py');
  file('apps/node/package.json', JSON.stringify({ scripts: { nested: 'vitest run test/a.test.ts', nestedall: 'vitest run' } }));
  file('apps/node/test/a.test.ts');
  for (const bin of ['vitest', 'jest', 'tsc', 'eslint', 'playwright', 'something-light']) file(`node_modules/.bin/${bin}`, '#!/bin/sh\n');
  file('scripts/heavy.sh', '#!/bin/sh\nset -e\nnpm ci\n');
  file('scripts/light.sh', '#!/bin/sh\necho hi\n');
  file('scripts/self.sh', '#!/bin/sh\nbash scripts/self.sh\n');
  file('scripts/noext', '#!/usr/bin/env bash\ntsc --noEmit\n');
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

describe('every actual dependency install is refused here, whatever it is for', () => {
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
    expect(await agent(command)).toEqual(denied('dependency_install_local'));
  });

  it.each([
    'cat package.json', 'cat package-lock.json', 'sed -i s/a/b/ package.json', 'cat install.sh', 'cp install.md other.md', 'echo install', 'echo npm ci',
    'git diff -- package.json', 'git add package-lock.json', 'printf "%s" "npm install"', 'grep -rn "npm ci" apps', 'ls install',
    'npm view vitest version', 'npm ls', 'npm --version', 'pip list', 'pip show x', 'cargo --version', 'go version', 'gem list',
  ])('text and read-only calls stay ordinary work: %s', async command => {
    expect(await agent(command)).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
  });
});

describe('heavy checks are refused here', () => {
  it.each([
    'tsc', 'tsc --noEmit', 'npx tsc -p apps/node', './node_modules/.bin/tsc', 'vue-tsc', 'mypy .', 'pyright', 'vite build', 'next build', 'webpack', 'rollup -c',
    'esbuild a.ts', 'turbo run build', 'nx build x', 'cargo build', 'cargo check', 'cargo clippy', 'go build ./...', 'go vet ./...', 'dotnet build', 'make', 'make test',
    'cmake --build .', 'ninja', 'mvn test', './gradlew test', 'gradle build', 'docker build .', 'docker compose build', 'just test',
    'eslint .', 'eslint one.ts', 'npx eslint .', 'prettier --check .', 'biome check', 'ruff check .', 'flake8', 'pylint x', 'black .', 'isort .', 'gofmt -l .', 'rustfmt a.rs', 'rubocop',
    'crapper --use-existing-coverage a.ts', 'dryer a.ts', 'mutator a.ts', 'stryker run', 'mutmut run', 'c8 vitest run test/a.test.ts', 'nyc mocha', 'coverage run x.py',
    'playwright test', 'playwright test e2e/one.spec.ts', 'npx playwright test e2e/one.spec.ts', 'cypress run', 'wdio run x', 'nodemon a.js', 'node --watch a.js', 'tsx watch a.ts',
    'mocha', 'ava', 'rspec', 'phpunit', 'ctest', 'tox', 'nox', 'cargo test', 'go test ./...', 'bun test', 'bun test a.test.ts', 'deno test', 'dotnet test', 'python -m unittest',
    'python -m mypy .', 'python3 -m ruff check .', 'python -m coverage run x.py', 'python -m black .',
  ])('%s', async command => {
    expect(await agent(command)).toEqual(denied('heavy_check_local'));
  });

  it.each([
    'vitest', 'vitest run', 'vitest test/a.test.ts', 'vitest watch test/a.test.ts', 'vitest related test/a.test.ts', 'vitest bench', 'vitest list',
    'vitest run test/a.test.ts test/b.test.ts', 'vitest run test', 'vitest run "test/*.test.ts"', 'vitest run test/*.test.ts', 'vitest run test/{a,b}.test.ts', 'vitest run test/[ab].test.ts',
    'vitest run --changed', 'vitest run --changed test/a.test.ts', 'vitest run --shard=1/2 test/a.test.ts', 'vitest run --coverage test/a.test.ts', 'vitest run --watch test/a.test.ts', 'vitest run --browser test/a.test.ts',
    'vitest run --typecheck test/a.test.ts', 'vitest run test/missing.test.ts', 'vitest run test/escape.test.ts', 'vitest run test/inner-link.test.ts', 'vitest run ../outside.test.ts', 'vitest run away/outside.test.ts',
    'jest', 'jest test', 'jest test/a.test.ts test/b.test.ts', 'jest --watch test/a.test.ts', 'jest --watchAll', 'jest --coverage test/a.test.ts', 'jest --findRelatedTests a.ts', 'jest --onlyChanged', 'jest --shard=1/2 test/a.test.ts',
    'pytest', 'pytest test', 'pytest test/a_test.py test/a_test.py', 'pytest --cov test/a_test.py', 'pytest -n 4 test/a_test.py', 'pytest --lf test/a_test.py', 'python -m pytest', 'python -m pytest --cov=x test/a_test.py',
    'node --test', 'node --test test', 'node --test test/a.test.ts test/b.test.ts', 'node --test --experimental-test-coverage test/a.test.ts', 'node --test --watch test/a.test.ts', 'node --test --test-shard=1/2 test/a.test.ts',
    'vitest run test/a.test.ts && vitest run test/b.test.ts', 'vitest run test/a.test.ts; jest test/b.test.ts', 'while true; do vitest run test/a.test.ts; done', 'watch vitest run test/a.test.ts',
    'NODE_V8_COVERAGE=out vitest run test/a.test.ts', 'env NODE_OPTIONS=--inspect vitest run test/a.test.ts', 'PYTEST_ADDOPTS=--cov pytest test/a_test.py', 'export NODE_V8_COVERAGE=out; vitest run test/a.test.ts',
    'cd /tmp && vitest run test/a.test.ts', `vitest run ${join('/tmp', 'a.test.ts')}`,
  ])('a test scope other than one regular file: %s', async command => {
    expect(await agent(command)).toEqual(denied('heavy_check_local'));
  });
});

describe('one literal test file runs here', () => {
  it.each([
    'vitest run test/a.test.ts', 'vitest --run test/a.test.ts', 'vitest run ./test/a.test.ts', 'vitest run "test/a.test.ts"', 'vitest run test/a.test.ts -t "keeps words"', 'vitest run test/a.test.ts --reporter=verbose',
    './node_modules/.bin/vitest run test/a.test.ts', 'node node_modules/.bin/vitest run test/a.test.ts', 'npx vitest run test/a.test.ts', 'npx --no-install vitest run test/a.test.ts', 'npm exec -- vitest run test/a.test.ts', 'pnpm exec vitest run test/a.test.ts', 'yarn exec vitest run test/a.test.ts',
    'jest test/a.test.ts', 'jest --runTestsByPath test/a.test.ts', 'jest -t "x" test/a.test.ts', 'node --test test/a.test.ts', 'node --test --test-name-pattern=x test/a.test.ts',
    'pytest test/a_test.py', 'pytest test/a_test.py::test_x -q', 'pytest -x -vv --tb=short test/a_test.py', 'python -m pytest test/a_test.py', 'python3 -m pytest -q test/a_test.py',
    'npm run one', 'npm run -s one', 'npm test -- test/a.test.ts', 'pnpm run one', 'pnpm one', 'yarn one', 'yarn run one', 'bun run one',
    'CI=1 vitest run test/a.test.ts', 'env CI=1 vitest run test/a.test.ts', 'timeout 60 vitest run test/a.test.ts', 'time vitest run test/a.test.ts', 'nice -n 5 vitest run test/a.test.ts', 'sh -c "vitest run test/a.test.ts"', 'bash -lc "cd apps/node && vitest run test/a.test.ts"',
    'vitest run test/a.test.ts 2>&1 | tail -20', 'git status && vitest run test/a.test.ts', 'cd apps/node && npx vitest run test/a.test.ts', '(cd apps/node && vitest run test/a.test.ts)', 'npm --prefix apps/node run nested', 'npm -w apps/node run nested',
  ])('%s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: true, kind: 'single_test_file' }));
  });

  it('counts from the folder the command stands in, tracked or not', async () => {
    expect(await agent('vitest run test/a.test.ts', node)).toEqual(expect.objectContaining({ kind: 'single_test_file' }));
    expect(existsSync(join(root, '.git'))).toBe(false);
    file('test/new-red.test.ts');
    expect(await agent('vitest run test/new-red.test.ts')).toEqual(expect.objectContaining({ kind: 'single_test_file' }));
  });

  it('keeps the folder only inside its own subshell', async () => {
    expect(await agent('(cd apps/node); vitest run test/a.test.ts')).toEqual(expect.objectContaining({ kind: 'single_test_file' }));
    expect(await agent('(cd test); vitest run a.test.ts')).toEqual(denied('heavy_check_local'));
    expect(await agent('cd test; vitest run a.test.ts')).toEqual(expect.objectContaining({ kind: 'single_test_file' }));
    expect(await agent('if true; then cd test; fi; vitest run a.test.ts')).toEqual(denied('heavy_check_local'));
  });
});

describe('one heavy stage refuses the whole command before its first stage', () => {
  it.each([
    'echo a && tsc', 'tsc && echo a', 'true; tsc', 'false || tsc', 'ls | tsc', 'tsc | tail', '(tsc)', '( ( tsc ) )', '((tsc) ; echo a)', '((tsc) && (echo a) ; echo b)', '{ tsc; }', '! tsc', 'true & tsc', 'echo a\ntsc', 'ls \\\n  && tsc',
    'if tsc; then echo a; fi', 'if true; then tsc; fi', 'if true; then echo a; elif tsc; then echo b; fi', 'if true; then echo a; else tsc; fi',
    'for x in a b; do tsc; done', 'while tsc; do break; done', 'until false; do tsc; done', 'case a in a) tsc;; esac', 'case a in (a|b) echo x;; *) tsc;; esac',
    'echo $(tsc)', 'echo "$(tsc)"', 'echo `tsc`', 'echo "`tsc`"', 'echo ${X:-$(tsc)}', 'cat <(tsc)', 'echo a > >(tsc)', 'A=$(tsc) true', 'A=$(tsc)', 'cat > $(tsc)', 'echo $(echo $(tsc))',
    'f() { tsc; }', 'function f { tsc; }', 'for x in $(tsc); do echo $x; done', 'case $(tsc) in a) ;; esac', '[[ -n $(tsc) ]]',
    'cat <<EOF\n$(tsc)\nEOF', 'echo a # comment\ntsc', 'a=(1 $(tsc))',
  ])('%s', async command => {
    expect(await agent(command)).toEqual(denied('heavy_check_local'));
  });

  it('refuses an install, then a build, then a browser suite as one', async () => {
    expect(await agent('npm ci && npm run inner && playwright test')).toEqual(denied('heavy_check_local'));
    expect(await agent('echo a && npm ci')).toEqual(denied('dependency_install_local'));
  });

  it.each([
    'env CI=1 tsc', 'env -i tsc', 'env -u X tsc', 'env -C apps/node tsc', 'env tsc', 'time tsc', 'time -p tsc', 'nice tsc', 'nice -n 5 tsc', 'ionice -c 3 tsc', 'timeout 5 tsc', 'timeout -k 1 5 tsc', 'nohup tsc', 'command tsc', 'exec tsc',
    'stdbuf -oL tsc', 'setsid tsc', 'sudo tsc', 'sudo -u x tsc', 'xvfb-run -a tsc', 'watch tsc', 'cross-env A=1 tsc', 'hh-check tsc', 'hh-check -- tsc', 'HH_CHECK_SLOT=abc tsc', 'CI=1 tsc',
    'sh -c tsc', 'sh -c "tsc"', 'bash -c "echo a; tsc"', 'bash -lc tsc', 'sh -ec "tsc"', 'dash -c tsc', 'zsh -c tsc', 'sh -c "sh -c \'tsc\'"', 'eval tsc', 'eval "echo a; tsc"', 'bash <<EOF\ntsc\nEOF', 'bash <<< tsc',
    'xargs tsc', 'find . -name x -exec tsc {} +', 'find . -execdir tsc {} ;', 'parallel tsc',
    'npm exec -- tsc', 'npm exec tsc', 'npm x -- tsc', 'npm exec -c "tsc"', 'pnpm exec tsc', 'yarn exec tsc', 'npx --no-install tsc', 'npx -c "tsc"', 'poetry run mypy .', 'pipenv run mypy .', 'bundle exec rubocop',
    'node node_modules/.bin/tsc', 'node node_modules/typescript/bin/tsc', '/usr/local/bin/tsc', 'bash scripts/noext', './scripts/noext', 'sh scripts/noext', '. scripts/noext', 'source scripts/noext',
    'busybox sh -c tsc', 'bash -o pipefail -c "tsc"', 'bash -eo pipefail -c tsc', 'bash +e -c tsc', 'bash --norc -c tsc', 'command -p tsc',
  ])('a wrapper does not hide what it runs: %s', async command => {
    expect(await agent(command)).toEqual(denied('heavy_check_local'));
  });

  it.each(['bash scripts/heavy.sh', './scripts/heavy.sh', 'sh ./scripts/heavy.sh', '. scripts/heavy.sh', 'source scripts/heavy.sh', 'eval "npm ci"', 'sudo apt-get install -y x', 'env npm ci', 'npm run behind-script'])('nor a script file: %s', async command => {
    expect(await agent(command)).toEqual(denied('dependency_install_local'));
  });

  it.each(['vitest run "$F"', 'vitest run $F', 'vitest $MODE test/a.test.ts', 'jest "$(cat list)"', 'vitest run test/a.test.ts $MORE', 'vitest run -t "$X" test/a.test.ts', 'pytest $F', 'node --test $F', 'xargs vitest run', 'find . -exec vitest run {} +', 'ls | xargs jest', 'cd $X && vitest run test/a.test.ts', 'cd - && vitest run test/a.test.ts', 'cd && vitest run test/a.test.ts', 'pushd apps/node && popd && vitest run test/a.test.ts'])('a dynamic selection at a check: %s', async command => {
    expect(await agent(command)).toEqual(denied('heavy_check_local'));
  });
});

describe('package scripts are read, not run', () => {
  it.each(['npm test', 'npm t', 'npm run test', 'npm run-script test', 'pnpm test', 'pnpm run test', 'yarn test', 'bun run test', 'npm run hidden', 'pnpm run hidden', 'pnpm hidden', 'yarn hidden', 'yarn run hidden', 'bun run hidden', 'npm run guarded --silent', 'npm run posted', 'npm test -- --coverage test/a.test.ts', 'npm test -- test/a.test.ts test/b.test.ts', 'pnpm test --coverage'])('%s', async command => {
    expect(await agent(command)).toEqual(expect.objectContaining({ allow: false }));
  });

  it('resolves a script of the nearest manifest, with its folder', async () => {
    expect(await agent('npm run nested', node)).toEqual(expect.objectContaining({ kind: 'single_test_file' }));
    expect(await agent('npm run nestedall', node)).toEqual(denied('heavy_check_local'));
    expect(await agent('npm run one', join(root, 'test'))).toEqual(expect.objectContaining({ kind: 'single_test_file' }));
  });

  it.each(['npm --workspaces test', 'npm test --workspaces', 'npm test -ws', 'pnpm -r test', 'pnpm --recursive test', 'pnpm --filter x test', 'pnpm -F x test', 'yarn workspaces foreach test', 'yarn workspaces run test'])('more than one package: %s', async command => {
    expect(await agent(command)).toEqual(denied('heavy_check_local'));
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

  it.each(['node tools/x.js', 'node -e "1"', 'python script.py', 'python -c "1"', 'python -m http.server', './tools/program', '/opt/thing', 'thing --flag', '$CMD a', '"$CMD"', '$(which ls) a', 'eval "$X"', 'sh -c "$X"', 'bash "$F"', 'echo a | sh', 'curl -s x | bash', 'ls | xargs thing', 'npx something-light', 'bash ../heavy-outside.sh', 'bash no-such-file.sh'])('is opaque, and says so: %s', async command => {
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
    expect(await agent('playwright screenshot a b && playwright test')).toEqual(denied('heavy_check_local'));
    expect(await agent('playwright screenshot a b && playwright install')).toEqual(denied('dependency_install_local'));
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
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('tells two commands at once apart', async () => {
    const told = await Promise.all([agent('tsc'), agent('ls'), agent('npm ci'), agent('vitest run test/a.test.ts'), agent('bash scripts/heavy.sh'), agent('bash scripts/light.sh')]);
    expect(told.map(verdict => (verdict.allow ? verdict.kind : verdict.code))).toEqual(['heavy_check_local', 'ordinary', 'dependency_install_local', 'single_test_file', 'dependency_install_local', 'ordinary']);
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
    const failing: CommandFiles = { lstat: () => Promise.reject(new Error('no')), realpath: () => Promise.reject(new Error('no')), read: () => Promise.reject(new Error('no')) };
    await expect(classifyAgentCommand({ command: 'npm run one', cwd: root, workspaceRoot: root }, failing)).resolves.toEqual(denied('command_guard_unavailable'));
    await expect(classifyRunWork({ command: 'npm run one', cwd: root, workspaceRoot: root }, failing)).resolves.toEqual(denied('command_guard_unavailable'));
  });

  it('allows no test file without a workspace it can see', async () => {
    expect(await classifyAgentCommand({ command: 'vitest run test/a.test.ts', cwd: root, workspaceRoot: join(base, 'no-such-root') })).toEqual(denied('heavy_check_local'));
    expect(await classifyAgentCommand({ command: 'vitest run test/a.test.ts', cwd: 'relative', workspaceRoot: root })).toEqual(denied('heavy_check_local'));
  });
});

describe('a claim gives nothing', () => {
  it('takes no origin, lease or runner from what it is told', async () => {
    const claims = { isRunner: true, origin: 'runner', lease: 'abc', redGreen: true, sender: 'node', kind: 'work' };
    expect(await classifyAgentCommand({ command: 'npm ci && tsc', cwd: root, workspaceRoot: root, ...claims } as never)).toEqual(denied('heavy_check_local'));
    expect(await agent('HH_CHECK_SLOT=real-lease IS_RUNNER=1 npm ci')).toEqual(denied('dependency_install_local'));
    expect(await agent('hh-check npm ci')).toEqual(denied('dependency_install_local'));
  });

  it('reads an argument list as literal words of one command', async () => {
    expect(await agent(['npm', 'ci'])).toEqual(denied('dependency_install_local'));
    expect(await agent(['tsc', '--noEmit'])).toEqual(denied('heavy_check_local'));
    expect(await agent(['env', 'CI=1', 'tsc'])).toEqual(denied('heavy_check_local'));
    expect(await agent(['bash', '-o', 'pipefail', '-c', 'npm ci'])).toEqual(denied('dependency_install_local'));
    expect(await agent(['sh', '-c', 'npm ci'])).toEqual(denied('dependency_install_local'));
    expect(await agent(['vitest', 'run', 'test/a.test.ts'])).toEqual(expect.objectContaining({ kind: 'single_test_file' }));
    expect(await agent(['vitest', 'run', 'test/a.test.ts', 'test/b.test.ts'])).toEqual(denied('heavy_check_local'));
    expect(await agent(['echo', 'npm ci', '$(tsc)'])).toEqual({ allow: true, kind: 'ordinary', coverage: 'recognized' });
    expect(await agent(['vitest', 'run', 'test/*.test.ts'])).toEqual(denied('heavy_check_local'));
    expect(await agent([])).toEqual(denied('command_guard_unavailable'));
  });
});

describe('work under the existing work rights', () => {
  it.each(['npm ci', 'pnpm install', 'pip install -r requirements.txt', 'npm ci && pip install x', 'npm ci && ls', 'sh -c "npm ci"', 'playwright install chromium', 'cd apps/node && npm ci'])('prepares dependencies: %s', async command => {
    expect(await work(command)).toEqual(expect.objectContaining({ allow: true, kind: 'dependency_preparation' }));
  });

  it.each(['vitest run test/a.test.ts', 'npm test', 'npm ci && npm test', 'npm ci && tsc', 'npm install && playwright test', 'npm ci; eslint .', 'npm run one', 'crapper a.ts', 'sh -c "npm ci && vitest run test/a.test.ts"', 'hh-check tsc'])('gives any check to run_tests: %s', async command => {
    expect(await work(command)).toEqual(denied('heavy_check_local'));
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

  it.each(['npm ci', 'tsc', 'npm run nothing', 'echo "open'])('starts with the same line: %s', async command => {
    expect(refusalText(await verdict(command)).split('\n')[0]).toBe('запусти через run_tests');
  });

  it('says what it stopped, within bounds, and copies nothing of the command', async () => {
    const text = refusalText(await verdict('NPM_TOKEN=s3cret npm ci --registry=https://me:s3cret@a.example'));
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('a.example');
    expect(text.length).toBeLessThan(400);
    expect(text.split('\n').length).toBeGreaterThan(1);
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
