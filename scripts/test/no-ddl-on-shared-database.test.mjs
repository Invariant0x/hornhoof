import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import rule from '../no-ddl-on-shared-database.mjs';

const linter = new Linter({ configType: 'flat' });
const config = {
  plugins: { hornhoof: { rules: { 'no-ddl-on-shared-database': rule } } },
  rules: { 'hornhoof/no-ddl-on-shared-database': 'error' },
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
};
/* The lines the rule points at, and nothing else that went wrong. */
function findings(source) {
  const messages = linter.verify(source, config);
  assert.deepEqual(messages.filter(message => message.fatal), [], source);
  return messages.map(message => message.line);
}

test('DDL is an error, whichever way it is written', () => {
  for (const text of [
    "run('create table notes (id int)')",
    "run('CREATE TEMP TABLE notes (id int)')",
    "run('create unique index notes_id on notes (id)')",
    "run('DROP TRIGGER hh_stop ON tasks')",
    "run('create or replace function stop() returns trigger')",
    "run('alter table tasks add column note text')",
    "run('create role helper')",
    "run('create schema other')",
    "run('grant select on tasks to helper')",
    "run('REVOKE ALL ON tasks FROM helper')",
    'run(`create\n  trigger ${name} before update on tasks`)',
    'run(sql`create function stop() returns trigger`)',
    "run(sql.raw('revoke select on tasks from helper'))",
    "const statement = 'drop table notes'",
    "expect(await take('drop table notes')).toBe(1)",
    "await expect(run('create table notes (id int)')).rejects.toThrow()",
  ]) assert.deepEqual(findings(text), [1], text);
});

test('asking for databases of its own at the top of the file lets it pass', () => {
  assert.deepEqual(findings("ownDatabases();\nrun('create table notes (id int)');"), []);
  assert.deepEqual(findings("run('create table notes (id int)');\nownDatabases();"), []);
});

test('asking anywhere but the top of the file, or for something else, does not count', () => {
  assert.deepEqual(findings("const later = () => ownDatabases();\nrun('create table notes (id int)');"), [2]);
  assert.deepEqual(findings("db.ownDatabases();\nrun('create table notes (id int)');"), [2]);
  assert.deepEqual(findings("otherDatabases();\nrun('create table notes (id int)');"), [2]);
  assert.deepEqual(findings("const asked = 1;\nrun('create table notes (id int)');"), [2]);
});

test('text a test only expects to read is no error', () => {
  for (const text of [
    "expect(rows).toEqual([{ indexdef: 'CREATE INDEX tasks_turn ON public.tasks USING btree (turn_id)' }])",
    "expect(file).toContain('CREATE TABLE baskets')",
    "expect(file).not.toContain('create table baskets')",
    "await expect(reading).resolves.toBe('drop table notes')",
  ]) assert.deepEqual(findings(text), [], text);
});

test('a matcher of something other than expect() does not make it expected text', () => {
  assert.deepEqual(findings("client.exec('create table notes (id int)')"), [1]);
  assert.deepEqual(findings("build().exec('create table notes (id int)')"), [1]);
  assert.deepEqual(findings("other(x).toEqual('create table notes (id int)')"), [1]);
});

test('words that are no DDL are no error', () => {
  for (const text of [
    "run('create a table of tasks')",
    "run('the role was revoked')",
    "run('select * from tasks')",
    'run(`select ${name} from tasks`)',
    'const number = 1',
  ]) assert.deepEqual(findings(text), [], text);
});
