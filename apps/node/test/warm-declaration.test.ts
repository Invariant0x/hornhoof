import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { servicesNeeded, WarmServices, type WarmService } from '../src/warm-declaration.js';

/* #2091: which checks need a declared service is the repository's word: its programs, its test files and those it leaves out. */

const command = { program: 'svc', args: [], cwd: '.' };
const db: WarmService = {
  id: 'db', start: command, ready: command, piece: { create: command, drop: command, list: command, env: ['DB_URL'] },
  uses: { programs: ['vitest'], files: ['apps/server/test/**/*.test.ts'], without: ['apps/server/test/pure/**'] },
};
const declared = WarmServices.parse({ version: 1, services: [db] });
const repo = mkdtempSync(join(tmpdir(), 'hh-warm-declared-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
for (const file of ['apps/server/test/a.test.ts', 'apps/server/test/pure/b.test.ts', 'apps/node/test/c.test.ts']) {
  mkdirSync(join(repo, file, '..'), { recursive: true });
  writeFileSync(join(repo, file), '');
}
const vitest = (...args: string[]) => ['node', '/r/node_modules/vitest/vitest.mjs', 'run', ...args];
const needs = (cwd: string, words: string[]) => servicesNeeded(declared, repo, join(repo, cwd), words).map(service => service.id);

describe('the checks that need a declared service', () => {
  it.each([
    ['a test file of the service', 'apps/server', vitest('test/a.test.ts'), ['db']],
    ['the same file named from the repository', '', vitest('apps/server/test/a.test.ts'), ['db']],
    ['a file it leaves out', 'apps/server', vitest('test/pure/b.test.ts'), []],
    ['one it leaves out and one it needs', 'apps/server', vitest('test/pure/b.test.ts', 'test/a.test.ts'), ['db']],
    ['every test of its folder', 'apps/server', vitest(), ['db']],
    ['every test of the repository', '', vitest(), ['db']],
    ['a filter that names no file', 'apps/server', vitest('checkout'), ['db']],
    ['every test of a folder without its files', 'apps/node', vitest(), []],
    ['a file of another folder', 'apps/node', vitest('test/c.test.ts'), []],
    ['another program', 'apps/server', ['node', '/r/node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], []],
    ['a program it names, through npx', 'apps/server', ['npx', 'vitest', 'run', 'test/a.test.ts'], ['db']],
  ])('%s', (_what, cwd, words, ids) => {
    expect(needs(cwd, words)).toEqual(ids);
  });

  it('refuses a declaration with two services of one name or a variable not in capitals', () => {
    expect(WarmServices.safeParse({ version: 1, services: [db, db] }).success).toBe(false);
    expect(WarmServices.safeParse({ version: 1, services: [{ ...db, piece: { ...db.piece, env: ['db_url'] } }] }).success).toBe(false);
    expect(WarmServices.safeParse({ version: 1, services: [{ ...db, ready: undefined }] }).success).toBe(false);
    expect(WarmServices.safeParse({ version: 1, services: [{ ...db, start: undefined, ready: undefined }] }).success).toBe(true);
  });
});
