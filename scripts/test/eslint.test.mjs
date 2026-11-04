import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const eslint = resolve(root, 'node_modules/eslint/bin/eslint.js');

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
