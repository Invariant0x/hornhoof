import { spawnSync } from 'node:child_process';
import { appendFileSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

function owner() {
  if (process.getuid() !== 0) return { uid: process.getuid(), gid: process.getgid() };
  const users = readFileSync('/etc/passwd', 'utf8').split('\n').map(line => line.split(':'));
  const user = ['postgres', 'node'].map(name => users.find(fields => fields[0] === name)).find(fields => fields && Number(fields[2]) > 0 && Number(fields[3]) > 0);
  if (!user) throw new Error('PostgreSQL smoke requires a trusted unprivileged postgres or node user');
  return { uid: Number(user[2]), gid: Number(user[3]) };
}

function run(program, args, identity) {
  const result = spawnSync(program, args, {
    ...identity, cwd: '/tmp', encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PGCONNECT_TIMEOUT: '5' },
  });
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0]} failed: ${result.error?.message ?? result.stderr.trim() ?? result.signal}`);
  return result.stdout.trim();
}

function checkVersions(identity) {
  for (const program of ['postgres', 'initdb', 'pg_ctl', 'psql']) {
    let version;
    try { version = run(program, ['--version'], identity); }
    catch (error) { throw new Error(`PostgreSQL 17 required: ${program}: ${error.message}`); }
    if (!/\(PostgreSQL\) 17(?:\.\d+)*(?:\s|$)/.test(version)) throw new Error(`PostgreSQL 17 required: ${program}: ${version}`);
  }
}

function privateDirectory(path, identity) {
  mkdirSync(path, { mode: 0o700 });
  chownSync(path, identity.uid, identity.gid);
}

function checkCluster(identity) {
  const root = mkdtempSync('/tmp/hh-pg-');
  const data = join(root, 'data');
  const socket = join(root, 's');
  chownSync(root, identity.uid, identity.gid);
  try {
    privateDirectory(socket, identity);
    run('initdb', ['-D', data, '--locale=C.UTF-8', '--encoding=UTF8', '--username=postgres', '--auth-local=trust', '--auth-host=reject'], identity);
    appendFileSync(join(data, 'postgresql.conf'), `\nlisten_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\nport = 5432\n`);
    run('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '20', 'start'], identity);
    const query = "SELECT current_setting('server_version_num')::int / 10000, 1 + 1, current_setting('listen_addresses');";
    const result = run('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-A', '-t', '-c', query], identity);
    if (result !== '17|2|') throw new Error(`Unexpected PostgreSQL smoke query: ${result}`);
  } finally {
    // Even a failed pg_ctl start can leave a server that must stop before removing its data.
    if (existsSync(join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '20', 'stop'], identity);
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  const identity = owner();
  checkVersions(identity);
  checkCluster(identity);
  process.stdout.write('PostgreSQL 17 runtime smoke passed\n');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
