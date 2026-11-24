import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseName } from './helpers.js';

/* #2091: our declared warm PostgreSQL 17, run as the node runs it. A piece is a prefix of database and role names, and
   dropping it drops what a run made under it and nothing else. */

const SCRIPT = fileURLToPath(new URL('../warm/postgres.mjs', import.meta.url));
const run = promisify(execFile);
const state = mkdtempSync(join(tmpdir(), 'hh-warm-pg-'));
const service = (what: string, ...args: string[]) => run(process.execPath, [SCRIPT, what, state, ...args], { encoding: 'utf8' });
let server: ReturnType<typeof spawn>;

beforeAll(async () => {
  server = spawn(process.execPath, [SCRIPT, 'start', state], { stdio: 'inherit', detached: true });
  for (;;) {
    if (await service('ready').then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});
afterAll(async () => {
  const ended = new Promise(resolve => server.once('exit', resolve));
  process.kill(-server.pid!, 'SIGTERM');
  await ended;
  rmSync(state, { recursive: true, force: true });
});

const env = (stdout: string) => Object.fromEntries(stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const PIECE = 'hh_0123456789ab', OTHER = 'hh_ba9876543210';

it('gives a run a socket address and its prefix, and drops only what its tests made under it', async () => {
  const given = env((await service('create', '', PIECE)).stdout);
  expect(given).toEqual({ TEST_DATABASE_URL: expect.stringMatching(/^postgresql:\/\/hornhoof@localhost\/postgres\?host=/), HH_TEST_PG_PIECE: PIECE });
  const admin = new pg.Pool({ connectionString: given.TEST_DATABASE_URL, max: 1 });
  try {
    expect(Math.floor(Number((await admin.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]!.server_version_num) / 10000)).toBe(17);
    const mine = [databaseName(PIECE), databaseName(PIECE)], theirs = databaseName(OTHER), plain = databaseName('');
    expect(mine[0]).toMatch(/^hh_0123456789ab_[0-9a-f]{16}$/);
    expect(plain).toMatch(/^hh_pg_[0-9a-f]{24}$/);
    for (const name of [...mine, theirs, plain]) await admin.query(`CREATE DATABASE "${name}"`);
    await admin.query(`CREATE ROLE "${mine[0]}_reader"`);
    expect((await service('list')).stdout.trim().split('\n').sort()).toEqual([PIECE, OTHER].sort());

    await service('drop', PIECE);

    const left = (await admin.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'hh\\_%' ORDER BY 1")).rows.map(row => row.datname);
    expect(left).toEqual([theirs, plain].sort());
    expect((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [`${mine[0]}_reader`])).rowCount).toBe(0);
    expect((await service('list')).stdout.trim()).toBe(OTHER);
  } finally { await admin.end(); }
});

it('refuses a piece that is not one of the node\'s names', async () => {
  await expect(service('drop', "x' OR 1=1 --")).rejects.toThrow(/Not a piece/);
});
