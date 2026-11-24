#!/usr/bin/env node
/* Our warm PostgreSQL 17 for the test suites that need a real one (#2091), as .hornhoof/warm-services.json declares it: one
   cluster a machine, made once in {state} and listening on a socket there only, never on the network. A run's piece is a
   prefix: the databases and roles its tests make carry it (test/postgres/helpers.ts), and dropping the piece drops them.
   The migrated templates the tests copy stay, one for each set of migrations, so no run migrates what an earlier one did. */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [what, state, ...rest] = process.argv.slice(2);
const USER = 'hornhoof';
const PIECE = /^hh_[0-9a-f]{12}$/;
const data = join(state ?? '', 'data');

/* Where PostgreSQL 17's programs are: HH_PG_BIN, pg_config's, or where Debian and Homebrew put them. */
function bin() {
  const found = [process.env.HH_PG_BIN, '/usr/lib/postgresql/17/bin', '/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin']
    .filter(Boolean).find(dir => existsSync(join(dir, 'postgres')));
  if (found) return found;
  try {
    const dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    if (/ 17\./.test(execFileSync(join(dir, 'postgres'), ['--version'], { encoding: 'utf8' }))) return dir;
  } catch { /* No pg_config on PATH. */ }
  throw new Error('PostgreSQL 17 was not found: install it, or name its bin folder in HH_PG_BIN.');
}

const psql = (sql) => execFileSync(join(bin(), 'psql'), ['-h', state, '-U', USER, '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
const quoted = (name) => `"${name.replaceAll('"', '""')}"`;
function piece() {
  const [name] = rest.slice(-1);
  if (!PIECE.test(name ?? '')) throw new Error(`Not a piece: ${name}.`);
  return name;
}

switch (what) {
  case 'start': {
    if (!existsSync(join(data, 'PG_VERSION'))) {
      execFileSync(join(bin(), 'initdb'), ['-D', data, '-U', USER, '-A', 'trust', '-E', 'UTF8', '--locale=C.UTF-8', '--no-sync'], { stdio: ['ignore', 'inherit', 'inherit'] });
    }
    /* Test data need not outlive a crash, and the sessions of five runs at once fit. */
    const server = spawn(join(bin(), 'postgres'), ['-D', data, '-k', state, '-c', 'listen_addresses=', '-c', 'unix_socket_permissions=0700',
      '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=400', '-c', 'max_locks_per_transaction=256'], { stdio: 'inherit' });
    /* Stopped, it ends its sessions at once instead of waiting for them. */
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.kill('SIGINT'));
    server.once('exit', code => process.exit(code ?? 1));
    break;
  }
  case 'ready':
    try { execFileSync(join(bin(), 'pg_isready'), ['-h', state, '-U', USER, '-d', 'postgres', '-q']); }
    catch { process.exit(1); }
    break;
  case 'create': {
    const name = piece();
    const url = new URL(`postgresql://${USER}@localhost/postgres`);
    url.searchParams.set('host', state);
    process.stdout.write(`TEST_DATABASE_URL=${url}\nHH_TEST_PG_PIECE=${name}\n`);
    break;
  }
  case 'drop': {
    const name = piece(), like = `${name}\\_%`;
    for (const database of psql(`SELECT datname FROM pg_database WHERE datname LIKE '${like}'`).split('\n').filter(Boolean)) {
      psql(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
    }
    for (const role of psql(`SELECT rolname FROM pg_roles WHERE rolname LIKE '${like}'`).split('\n').filter(Boolean)) psql(`DROP ROLE IF EXISTS ${quoted(role)}`);
    break;
  }
  case 'list':
    process.stdout.write(psql("SELECT DISTINCT substring(datname from '^(hh_[0-9a-f]{12})_') FROM pg_database WHERE datname ~ '^hh_[0-9a-f]{12}_'"));
    break;
  default:
    process.stderr.write('Usage: postgres.mjs start|ready|create|drop|list STATE [DIGEST] [PIECE]\n');
    process.exit(2);
}
