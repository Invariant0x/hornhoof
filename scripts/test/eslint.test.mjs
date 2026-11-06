import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../../', import.meta.url));
const eslint = resolve(root, 'node_modules/eslint/bin/eslint.js');

/* These flags leave out the TypeScript programs and the rules that need them, so that eslint reads its files in seconds. */
const withoutPrograms = [
  '--parser-options=project:null',
  ...['await-thenable', 'no-floating-promises', 'no-misused-promises', 'switch-exhaustiveness-check']
    .flatMap(rule => ['--rule', `@typescript-eslint/${rule}: off`]),
  '--format=json',
];
const filesOfEachProcess = output => output.split('\n').filter(line => line.startsWith('['))
  .map(line => JSON.parse(line).map(report => report.filePath));
const wholeRepository = () => filesOfEachProcess(
  spawnSync(process.execPath, [eslint, ...withoutPrograms], { cwd: root, encoding: 'utf8' }).stdout,
).flat();

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

const DDL_RULE = 'hornhoof/no-ddl-on-shared-database';
function ddlFindings(t, folder, source) {
  const dir = mkdtempSync(join(root, folder, 'eslint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ddl.test.ts');
  writeFileSync(file, source);
  const result = spawnSync(process.execPath, [eslint, file, ...withoutPrograms], { cwd: root, encoding: 'utf8' });
  return JSON.parse(result.stdout)[0].messages.filter(message => message.ruleId === DDL_RULE).map(message => message.line);
}
const callOf = text => `import { sql } from 'drizzle-orm';\nimport { run } from './run.js';\nawait run(${text});\nexport { sql };\n`;

test('DDL in a server test on the shared database is an error, whichever way it is written', t => {
  for (const text of [
    "'create table notes (id int)'",
    "'DROP TRIGGER hh_stop ON tasks'",
    "'create or replace function stop() returns trigger'",
    "'alter table tasks add column note text'",
    "'create role helper'",
    "'grant select on tasks to helper'",
    "'REVOKE ALL ON tasks FROM helper'",
    '`create\n  trigger ${"stop"} before update on tasks`',
    'sql`create function stop() returns trigger`',
    "sql.raw('revoke select on tasks from helper')",
    'expect(await take(\'drop table notes\')).toBe(1)',
  ]) assert.deepEqual(ddlFindings(t, 'apps/server/test', callOf(text)), [3], text);
});

test('the same DDL passes in a file that asks for databases of its own', t => {
  assert.deepEqual(ddlFindings(t, 'apps/server/test', `import { ownDatabases } from './helpers-db.js';\nownDatabases();\n${callOf("'create table notes (id int)'")}`), []);
});

test('a call of that option anywhere but the top of the file does not count', t => {
  assert.deepEqual(ddlFindings(t, 'apps/server/test', `import { ownDatabases } from './helpers-db.js';\nexport const later = () => ownDatabases();\nawait run('create table notes (id int)');\n`), [3]);
});

test('text a test only expects, and words that are no DDL, are no error', t => {
  for (const text of [
    "expect(rows).toEqual([{ indexdef: 'CREATE INDEX tasks_turn ON public.tasks USING btree (turn_id)' }])",
    "expect(file).toContain('CREATE TABLE baskets')",
    "expect(file).not.toContain('create table baskets')",
    "'create a table of tasks'",
    "'the role was revoked'",
    "'select * from tasks'",
  ]) assert.deepEqual(ddlFindings(t, 'apps/server/test', callOf(text)), [], text);
});

test('real Postgres specs and other workspaces are outside the rule', t => {
  assert.deepEqual(ddlFindings(t, 'apps/server/test/postgres', callOf("'create table notes (id int)'")), []);
  assert.deepEqual(ddlFindings(t, 'apps/node/test', callOf("'create table notes (id int)'")), []);
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
  const files = wholeRepository().filter(file => /\.tsx?$/.test(file));
  assert.ok(files.length > 0);
  for (const file of files) {
    const path = relative(root, file);
    const { project } = (await linter.calculateConfigForFile(file)).languageOptions.parserOptions;
    assert.equal(project?.length, 1, `${path}: ${project}`);
    assert.equal(dirname(normalize(project[0])), path.split('/').slice(0, 2).join('/'), path);
  }
  for (const outside of ['apps/server/e2e/any.ts', 'packages/protocol/src/any.tsx', 'apps/node/tools/any.ts']) {
    assert.equal(await linter.calculateConfigForFile(join(root, outside)), undefined, outside);
  }
});

test('npm run lint runs every part in a process of its own even when one fails, and lints each file once', t => {
  const dir = mkdtempSync(join(root, 'scripts/eslint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'unused.mjs'), 'const unused = 1;\n');
  const result = spawnSync('npm', ['run', '--silent', 'lint', '--', ...withoutPrograms], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const processes = filesOfEachProcess(result.stdout);
  assert.ok(processes.length > 1 && processes.every(files => files.length > 0), result.stdout + result.stderr);
  assert.deepEqual(processes.flat().sort(), wholeRepository().sort());
});

test("a workspace's own lint finds the rules of the repository and fails on what it finds", t => {
  const dir = mkdtempSync(join(root, 'packages/protocol/test/eslint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'unused.test.ts'), 'const unused = 1;\nexport {};\n');
  const result = spawnSync('npm', ['run', '--silent', 'lint:part', '-w', '@hornhoof/protocol', '--', '--format=json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const reports = JSON.parse(result.stdout).filter(report => report.messages.length > 0);
  assert.deepEqual(reports.map(report => basename(report.filePath)), ['unused.test.ts']);
  assert.deepEqual(reports[0].messages.map(message => message.ruleId), ['@typescript-eslint/no-unused-vars']);
});
