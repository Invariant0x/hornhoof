import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../../', import.meta.url));
const eslint = resolve(root, 'node_modules/eslint/bin/eslint.js');
const workspaces = JSON.parse(execFileSync('npm', ['query', '.workspace'], { cwd: root, encoding: 'utf8' }))
  .map(workspace => workspace.location);
const packageJson = path => JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'));

/* The files eslint lints from a folder, with the rules and TypeScript programs left out so that it takes seconds. */
async function lintedFiles(cwd, ignorePatterns = []) {
  const linter = new ESLint({
    cwd,
    ignorePatterns,
    ruleFilter: () => false,
    overrideConfig: { files: ['**/*.{ts,tsx}'], languageOptions: { parserOptions: { project: null } } },
  });
  return (await linter.lintFiles(['.'])).map(result => result.filePath);
}

test('ESLint rejects an unused variable in a server test instead of ignoring the file', t => {
  const dir = mkdtempSync(join(root, 'apps/server/test/eslint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'unused.test.ts');
  writeFileSync(file, 'const unused = 1;\nexport {};\n');
  const result = spawnSync(process.execPath, [eslint, file, '--format=json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const [report] = JSON.parse(result.stdout);
  assert.equal(report.warningCount, 0, result.stdout);
  assert.deepEqual(report.messages.map(message => message.ruleId), ['@typescript-eslint/no-unused-vars']);
});

test('tests and TypeScript configs keep every rule in server, node and protocol', t => {
  const files = [];
  for (const workspace of ['apps/server', 'apps/node', 'packages/protocol']) {
    const dir = mkdtempSync(join(root, workspace, 'test/eslint-'));
    const config = join(root, workspace, `${basename(dir)}.config.ts`);
    t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(config, { force: true }); });
    for (const file of [join(dir, 'rules.test.ts'), config]) {
      writeFileSync(file, `const unused = 1;
Promise.resolve();
await 42;
export const callback: () => void = async () => {};
export function label(kind: 'a' | 'b') { switch (kind) { case 'a': return kind; } }
`);
      files.push(file);
    }
  }
  const result = spawnSync(process.execPath, [eslint, ...files, '--format=json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, 6);
  for (const report of reports) {
    assert.equal(report.warningCount, 0, JSON.stringify(report));
    assert.deepEqual(report.messages.map(message => message.ruleId).sort(), [
      '@typescript-eslint/await-thenable',
      '@typescript-eslint/no-floating-promises',
      '@typescript-eslint/no-misused-promises',
      '@typescript-eslint/no-unused-vars',
      '@typescript-eslint/switch-exhaustiveness-check',
    ], JSON.stringify(report));
  }
});

test('a file builds only the TypeScript program of its own workspace, because eslint keeps every program it builds', async () => {
  const linter = new ESLint({ cwd: root });
  const files = (await lintedFiles(root)).filter(file => /\.tsx?$/.test(file));
  assert.ok(files.length > 0);
  for (const file of files) {
    const path = relative(root, file);
    const { project } = (await linter.calculateConfigForFile(file)).languageOptions.parserOptions;
    assert.equal(project?.length, 1, `${path}: ${project}`);
    assert.equal(dirname(normalize(project[0])), path.split('/').slice(0, 2).join('/'), path);
  }
});

test('npm run lint lints each workspace in a process of its own and leaves no file out', async () => {
  const { lint } = packageJson('.').scripts;
  assert.match(lint, /&& npm run lint --workspaces$/);
  for (const workspace of workspaces) assert.equal(packageJson(workspace).scripts.lint, 'eslint', workspace);
  const rest = [...lint.matchAll(/--ignore-pattern "([^"]+)"/g)].map(match => match[1]);
  const parts = [await lintedFiles(root, rest)];
  for (const workspace of workspaces) parts.push(await lintedFiles(join(root, workspace)));
  assert.ok(parts.every(files => files.length > 0));
  assert.deepEqual(parts.flat().sort(), (await lintedFiles(root)).sort());
});

test("a workspace's own lint finds the rules of the repository and fails on what it finds", t => {
  const dir = mkdtempSync(join(root, 'packages/protocol/test/eslint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'unused.test.ts'), 'const unused = 1;\nexport {};\n');
  const result = spawnSync('npm', ['run', '--silent', 'lint', '-w', '@hornhoof/protocol', '--', '--format=json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const reports = JSON.parse(result.stdout).filter(report => report.messages.length > 0);
  assert.deepEqual(reports.map(report => basename(report.filePath)), ['unused.test.ts']);
  assert.deepEqual(reports[0].messages.map(message => message.ruleId), ['@typescript-eslint/no-unused-vars']);
});
