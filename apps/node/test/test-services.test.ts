import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openServices as openServiceRun,
  prepareServiceArtifacts,
  type OpenedServices,
  type ServiceArtifacts,
  type ServiceCommand,
  type ServiceContext,
  type ServiceDefinitions,
  type ServicePartContext,
  type ServicePrepareContext,
} from '../src/test-services.js';
import { eventually } from '../../../test-support/eventually.mjs';

const procVisibility = vi.hoisted(() => ({ readable: true, ending: '', reads: 0 }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: new Proxy(actual.readdirSync, { apply(target, receiver, args) {
    if (args[0] === '/proc' && !procVisibility.readable) throw Object.assign(new Error('Unrelated process inventory is unavailable'), { code: 'EACCES' });
    return Reflect.apply(target, receiver, args);
  } }), readFileSync: new Proxy(actual.readFileSync, { apply(target, receiver, args) {
    /* The kernel answers ESRCH to a read of a process that ended after its file in /proc was opened. */
    if (procVisibility.ending && args[0] === procVisibility.ending) {
      procVisibility.reads++;
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    }
    return Reflect.apply(target, receiver, args);
  } }) };
});

/* No verdict here rests on the real clock. Every deadline and grace is the largest timer delay, so none runs out during a
   test. A grace of 1 ms is given only where it must run out at once, to a process that never stops by itself, or where our
   code must not use it at all. A lock's deadline comes on a fake clock. */
const NEVER = 2_147_483_647;
const LASTING = { stopMs: NEVER, exitMs: NEVER, cleanupMs: NEVER };

const trackerDir = mkdtempSync(join(tmpdir(), 'hh-services-pids-'));
const pidLog = join(trackerDir, 'pids');
const socketLog = join(trackerDir, 'sockets');
const activeOpened: OpenedServices[] = [];
const roots: string[] = [];
let contextController: AbortController | undefined;
let root: string;
let bin: string;
let log: string[];
let secrets: string[];
let context: ServiceContext;
const definitions: ServiceDefinitions = {
  services: [{ id: 'pg', driver: 'postgres', runtime: 'postgres', profiles: ['final'], options: { database: 'hornhoof', locale: 'C.UTF-8', extensions: [] } }],
  prepare: [],
};

function takeTrackedLines(file: string): string[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
  writeFileSync(file, '');
  return [...new Set(lines)];
}

function killServiceProcessGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* Process or group has already exited. */
    }
  }
}

function killTrackedServicePids(): number[] {
  const pids = takeTrackedLines(pidLog).map(Number).filter(pid => Number.isInteger(pid) && pid > 1);
  for (const pid of pids) killServiceProcessGroup(pid);
  return pids;
}

function removeTrackedSockets(): void {
  for (const socket of takeTrackedLines(socketLog)) {
    if (socket.startsWith('/tmp/hhpg-')) rmSync(socket, { recursive: true, force: true });
  }
}

function emergencyServiceCleanup(): void {
  procVisibility.ending = '';
  contextController?.abort();
  killTrackedServicePids();
  removeTrackedSockets();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(trackerDir, { recursive: true, force: true });
}

process.once('exit', () => emergencyServiceCleanup());
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(signal, () => {
    const last = process.listenerCount(signal) === 0;
    emergencyServiceCleanup();
    if (last) process.kill(process.pid, signal);
  });
}

async function openServices(defs: ServiceDefinitions, artifacts: ServiceArtifacts, partContext: ServicePartContext): Promise<OpenedServices> {
  const opened = await openServiceRun(defs, artifacts, partContext);
  if (opened.env.PGHOST?.startsWith('/tmp/hhpg-')) {
    try {
      appendFileSync(socketLog, `${opened.env.PGHOST}\n`);
    } catch {
      /* Tracker directory may already be removed during process shutdown. */
    }
  }
  const entry: OpenedServices = {
    env: opened.env,
    async close() {
      const index = activeOpened.indexOf(entry);
      if (index >= 0) activeOpened.splice(index, 1);
      await opened.close();
    },
  };
  activeOpened.push(entry);
  return entry;
}

function executable(name: string, body: string): void {
  const file = join(bin, name);
  const prelude = [
    '(()=>{',
    "const fs=require('node:fs'),a=process.argv;",
    `try{fs.appendFileSync(${JSON.stringify(pidLog)},process.pid+'\\n');`,
    "const u=a.find(x=>x.startsWith('unix_socket_directories='))?.slice(24),s=u||process.env.PGHOST;",
    `if(s&&s.startsWith('/tmp/hhpg-'))fs.appendFileSync(${JSON.stringify(socketLog)},s+'\\n')}catch{}`,
    `const o=${process.pid};setInterval(()=>{try{process.kill(o,0)}catch(e){if(e&&e.code==='ESRCH')process.exit(1)}},50).unref();`,
    '})();',
  ].join('');
  writeFileSync(file, `#!/usr/bin/env node\n${prelude}\n${body}\n`);
  chmodSync(file, 0o755);
}

/* What every fake PostgreSQL program does first: it reads its arguments and answers --version as version 17. */
const common = `const fs=require('node:fs'); const p=require('node:path'); const a=process.argv.slice(2); if(a.includes('--version')) { console.log(p.basename(process.argv[1])+' (PostgreSQL) 17.4'); process.exit(0); }`;
function fakePostgres(): void {
  executable('initdb', `${common} if(process.env.INIT_MARKER) fs.appendFileSync(process.env.INIT_MARKER,'init\\n'); const dir=a[a.indexOf('-D')+1]; fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(p.join(dir,'PG_VERSION'),'17'); fs.writeFileSync(p.join(dir,'pg_hba.conf'),''); fs.writeFileSync(p.join(dir,'postgresql.conf'),'');`);
  executable('postgres', `${common} if(a.includes('--single')) {const swap=p.join(p.dirname(process.argv[1]),'link-hba-to'); if(fs.existsSync(swap)){const hba=p.join(a[a.indexOf('-D')+1],'pg_hba.conf'); fs.rmSync(hba); fs[fs.existsSync(swap+'.hard')?'linkSync':'symlinkSync'](fs.readFileSync(swap,'utf8'),hba);} process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));} else { if(process.env.SERVER_ARGS) fs.appendFileSync(process.env.SERVER_ARGS,JSON.stringify(a)+'\\n'); const dir=a[a.indexOf('-D')+1]; fs.writeFileSync(p.join(dir,'postmaster.pid'),String(process.pid)); process.on('SIGTERM',()=>{fs.unlinkSync(p.join(dir,'postmaster.pid'));process.exit(0)}); setInterval(()=>{},100); }`);
  executable('pg_ctl', `${common} const dir=a[a.indexOf('-D')+1]; const file=p.join(dir,'postmaster.pid'); if(fs.existsSync(file)) process.kill(Number(fs.readFileSync(file,'utf8')),'SIGTERM');`);
  executable('psql', `${common} let input=''; process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{if(process.env.SOCKET_TRACE) fs.writeFileSync(process.env.SOCKET_TRACE,process.env.PGHOST); if(process.env.FAIL_SQL==='1') {console.error('SQL failed '+process.env.PGPASSWORD);process.exit(9)} console.log(input.includes('SELECT 1')?'1':'OK');});`);
}

const HOUR = 3_600_000;
const onFakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
/* A server whose stop lasts an hour on the test's fake clock: it takes its first stop request, writes STOP_MARKER with its
   pid and stops only once the test writes STOP_RELEASE, after the clock has run through the hour. Later signals, but SIGKILL,
   do not hurry it. */
const HOUR_LONG_STOP = "let asked=false;const stopping=done=>{if(asked)return;asked=true;fs.writeFileSync(process.env.STOP_MARKER+'.tmp',JSON.stringify({pid:process.pid}));fs.renameSync(process.env.STOP_MARKER+'.tmp',process.env.STOP_MARKER);setInterval(()=>{if(fs.existsSync(process.env.STOP_RELEASE))done()},5)};";
/* PostgreSQL with such a stop, and a pg_ctl that does what the real one does: it asks the server for a fast stop and, with
   -W, returns at once. Otherwise it waits -t seconds (60 by default), and for a stop longer than that (STOP_MS) gives up at
   once, as the real one does once they have passed. It records its arguments in PG_CTL_CALLS. */
function hourLongPostgres(): void {
  executable('postgres', `${common}${HOUR_LONG_STOP}if(a.includes('--single')){process.stdin.resume();process.stdin.on('end',()=>process.exit(0))}else{const pid=p.join(a[a.indexOf('-D')+1],'postmaster.pid');fs.writeFileSync(pid,String(process.pid));const stop=()=>stopping(()=>{fs.unlinkSync(pid);process.exit(0)});process.on('SIGINT',stop);process.on('SIGTERM',stop);setInterval(()=>{},100)}`);
  executable('pg_ctl', `${common}fs.appendFileSync(process.env.PG_CTL_CALLS,JSON.stringify(a)+'\\n');const pid=p.join(a[a.indexOf('-D')+1],'postmaster.pid');if(!fs.existsSync(pid)){console.error('pg_ctl: PID file does not exist');process.exit(1)}process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGINT');if(a.includes('-W')){console.log('server shutting down');process.exit(0)}const seconds=a.includes('-t')?Number(a[a.indexOf('-t')+1]):60;if(Number(process.env.STOP_MS)>seconds*1000){console.error('pg_ctl: server does not shut down');process.exit(1)}setInterval(()=>{if(!fs.existsSync(pid))process.exit(0)},5);`);
}
/* Starts what ends in a stop of an hour and returns once that stop has reached the server, with the server's pid. */
async function stopping<T>(start: () => Promise<T>, marker: string): Promise<{ running: Promise<T>; pid: number }> {
  const running = start();
  let ended = false;
  void running.then(() => { ended = true; }, () => { ended = true; });
  await eventually(() => ended || existsSync(marker));
  if (!existsSync(marker)) { await running; throw new Error('It ended before its stop reached the server'); }
  return { running, pid: (JSON.parse(readFileSync(marker, 'utf8')) as { pid: number }).pid };
}

beforeEach(() => {
  procVisibility.readable = true;
  procVisibility.ending = '';
  procVisibility.reads = 0;
  root = mkdtempSync(join(tmpdir(), 'hh-services-test-'));
  roots.push(root);
  bin = join(root, 'bin'); mkdirSync(bin);
  log = []; secrets = [];
  const uid = process.getuid!(); const gid = process.getgid!();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  contextController = new AbortController();
  context = { nodeOwner: { uid: 0, gid: 0 }, jobUser: { uid, gid }, signal: contextController.signal,
    deadline: Date.now() + NEVER, graces: LASTING, log: line => log.push(line), registerSecrets: values => secrets.push(...values), postgresBin: bin };
  fakePostgres();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  procVisibility.ending = '';
  contextController?.abort();
  const killed = killTrackedServicePids();
  await Promise.allSettled(activeOpened.splice(0).map(item => item.close()));
  const more = killTrackedServicePids();
  await eventually(() => [...killed, ...more].every(pid => !servicePidAlive(pid)));
  removeTrackedSockets();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* Execute the node's inline guardian as its child process would, with recorded process and /proc boundaries. The timers
   belong to the test's virtual clock; no program starts and no signal reaches the machine. */
function recordedGuardian(exitGraceMs?: number, proc: Record<string, string | Error> = { 456: '456 (recorded writer) S 1 123 0' }) {
  const source = readFileSync(new URL('../src/test-services.ts', import.meta.url), 'utf8');
  const script = /const LEASE_GUARDIAN = String.raw`([\s\S]*?)`;/.exec(source)?.[1];
  if (!script) throw new Error('The inline lease guardian is missing');
  const group = { alive: true };
  const signals: { pid: number; signal: NodeJS.Signals | number }[] = [];
  const messages: { supervisionFailed: boolean }[] = [];
  const job = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const guardian = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: undefined as number | undefined,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill(pid: number, signal: NodeJS.Signals | number) {
      if (!group.alive) throw Object.assign(new Error('No such process group'), { code: 'ESRCH' });
      signals.push({ pid, signal });
      if (signal === 'SIGKILL') group.alive = false;
    },
    send(message: { supervisionFailed: boolean }, done: () => void) { messages.push(message); done(); },
    disconnect() { guardian.connected = false; guardian.emit('disconnect'); },
  });
  runInNewContext(script, {
    process: guardian, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name: string) {
      if (name === 'node:child_process') return { spawn: () => job };
      if (name === 'node:fs') return { readdirSync: () => Object.keys(proc), readFileSync: (path: string) => {
        const stat = proc[path.split('/')[2]!]!;
        if (stat instanceof Error) throw stat;
        return stat;
      } };
      throw new Error(`Unexpected guardian dependency: ${name}`);
    },
  });
  guardian.emit('message', { program: 'recorded-service', args: [], cwd: '/recorded', env: {}, uid: 1001, gid: 1002, ...(exitGraceMs === undefined ? {} : { exitGraceMs }) });
  return { job, guardian, group, signals, messages };
}

describe('lease guardian after its leader exits', () => {
  it.each([
    { name: 'the unchanged default', given: undefined, expected: 2000 },
    { name: 'the configured grace', given: 321, expected: 321 },
  ])('marks forced supervision after $name expires, with no stop request', ({ given, expected }) => {
    vi.useFakeTimers();
    try {
      const recorded = recordedGuardian(given);
      recorded.job.emit('exit', 0);
      vi.advanceTimersByTime(expected - 1);
      expect(recorded.signals.filter(s => s.signal !== 0)).toEqual([]);
      expect(recorded.messages).toEqual([]);
      expect(recorded.guardian.connected).toBe(true);
      vi.advanceTimersByTime(1);
      expect(recorded.signals.filter(s => s.signal !== 0)).toEqual([{ pid: -123, signal: 'SIGKILL' }]);
      vi.advanceTimersByTime(5);
      expect(recorded.messages).toEqual([{ supervisionFailed: true }]);
      expect(recorded.guardian.exitCode).toBe(1);
      expect(recorded.guardian.connected).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('takes a process that ends while its state is read for gone, not for a failed supervision', () => {
    vi.useFakeTimers();
    try {
      const ended = Object.assign(new Error('No such process'), { code: 'ESRCH' });
      const recorded = recordedGuardian(undefined, { 455: ended, 456: '456 (recorded writer) S 1 123 0' });
      recorded.job.emit('exit', 0);
      vi.advanceTimersByTime(100);
      expect(recorded.signals.filter(s => s.signal !== 0)).toEqual([]);
      expect(recorded.messages).toEqual([]);
      recorded.group.alive = false;
      vi.advanceTimersByTime(5);
      expect(recorded.messages).toEqual([{ supervisionFailed: false }]);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { name: 'its signal', message: { signal: 'SIGINT', graceMs: null }, sent: [{ pid: -123, signal: 'SIGINT' }] },
    { name: 'no signal, as for a server pg_ctl asked to stop', message: { graceMs: null }, sent: [] },
  ])('waits for the whole group with no grace of its own on an ordinary stop with $name', ({ message, sent }) => {
    vi.useFakeTimers();
    try {
      const recorded = recordedGuardian(321);
      recorded.guardian.emit('message', message);
      recorded.job.emit('exit', 0);
      vi.advanceTimersByTime(60_000);
      expect(recorded.signals.filter(s => s.signal !== 0)).toEqual(sent);
      expect(recorded.messages).toEqual([]);
      expect(recorded.guardian.connected).toBe(true);
      recorded.group.alive = false;
      vi.advanceTimersByTime(5);
      expect(recorded.messages).toEqual([{ supervisionFailed: false }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('forces the group once a grace comes after an ordinary stop', () => {
    vi.useFakeTimers();
    try {
      const recorded = recordedGuardian();
      recorded.guardian.emit('message', { signal: 'SIGINT', graceMs: null });
      recorded.job.emit('exit', 0);
      recorded.guardian.emit('message', { signal: 'SIGTERM', graceMs: 10 });
      vi.advanceTimersByTime(9);
      expect(recorded.signals.filter(s => s.signal !== 0)).toEqual([{ pid: -123, signal: 'SIGINT' }, { pid: -123, signal: 'SIGTERM' }]);
      vi.advanceTimersByTime(1);
      expect(recorded.signals.filter(s => s.signal !== 0)).toEqual([{ pid: -123, signal: 'SIGINT' }, { pid: -123, signal: 'SIGTERM' }, { pid: -123, signal: 'SIGKILL' }]);
      vi.advanceTimersByTime(5);
      expect(recorded.messages).toEqual([{ supervisionFailed: true }]);
    } finally { vi.useRealTimers(); }
  });

  it('keeps the lease until descendants leave and clears escalation when they finish on their own', () => {
    vi.useFakeTimers();
    try {
      const recorded = recordedGuardian();
      recorded.job.emit('exit', 0);
      vi.advanceTimersByTime(100);
      expect(recorded.messages).toEqual([]);
      expect(recorded.guardian.connected).toBe(true);
      recorded.group.alive = false;
      vi.advanceTimersByTime(5);
      expect(recorded.messages).toEqual([{ supervisionFailed: false }]);
      expect(recorded.guardian.exitCode).toBe(0);
      expect(recorded.guardian.connected).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(recorded.signals.filter(s => s.signal !== 0)).toEqual([]);
      expect(recorded.messages).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
const prep = () => prepareServiceArtifacts(definitions, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) });
const part = (attempt: string) => ({ ...context, attemptRoot: join(root, 'runs', attempt), checkout: root });

describe('prepared native services', () => {
  it('rejects missing PostgreSQL 17 instead of substituting another engine', async () => {
    rmSync(join(bin, 'postgres'));
    await expect(prep()).rejects.toThrow(/PostgreSQL 17/);
    expect(existsSync(join(root, 'cache', 'a'.repeat(64), 'READY.json'))).toBe(false);
  });
  it.each(['16.9', '16.17', '18.17', '117.2'])('rejects PostgreSQL %s even when all executables exist', async version => {
    executable('psql', `console.log('psql (PostgreSQL) ${version}')`);
    await expect(prep()).rejects.toThrow(/PostgreSQL 17/);
  });
  it('rejects an unsupported locale instead of certifying a different configuration', async () => {
    const defs: ServiceDefinitions = { services: [{ ...definitions.services[0]!, driver: 'postgres', options: { database: 'hornhoof', locale: 'en_US.UTF-8' } }], prepare: [] };
    await expect(prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) })).rejects.toThrow(/C.UTF-8/);
    expect(existsSync(join(root, 'cache', 'a'.repeat(64), 'READY.json'))).toBe(false);
  });
  it('publishes stopped state and opens independent private SCRAM attempts', async () => {
    const artifacts = await prep();
    expect(existsSync(join(artifacts.paths.pg!, 'postmaster.pid'))).toBe(false);
    const one = await openServices(definitions, artifacts, part('one'));
    try {
      const two = await openServices(definitions, artifacts, part('two'));
      try {
        expect(one.env.PGHOST).not.toBe(two.env.PGHOST);
        expect(statSync(one.env.PGHOST!).mode & 0o777).toBe(0o700);
        expect(one.env.DATABASE_URL).not.toBe(two.env.DATABASE_URL);
        expect(one.env.DATABASE_URL).toContain('hornhoof');
        expect(secrets.length).toBeGreaterThanOrEqual(4);
        const state = join(root, 'runs', 'one', 'state', 'pg');
        expect(readFileSync(join(state, 'pg_hba.conf'), 'utf8')).toContain('scram-sha-256');
        expect(readFileSync(join(state, 'pg_hba.conf'), 'utf8')).not.toContain('trust');
        writeFileSync(join(state, 'PG_VERSION'), 'corrupt');
        expect(readFileSync(join(artifacts.paths.pg!, 'PG_VERSION'), 'utf8')).toBe('17');
        const ready = readFileSync(join(root, 'cache', 'a'.repeat(64), 'READY.json'), 'utf8');
        for (const secret of secrets) { expect(ready).not.toContain(secret); expect(log.join('\n')).not.toContain(secret); }
      } finally { await Promise.all([one.close(), two.close()]); }
      await one.close();
    } finally { await one.close(); }
    expect(existsSync(one.env.PGHOST!)).toBe(false);
    expect(existsSync(join(root, 'runs', 'one', 'state', 'pg'))).toBe(false);
  });
  it.each(['symlink', 'hardlink'])('writes access rules without changing an outside file reached by a %s', async kind => {
    const artifacts = await prep(), outside = join(root, 'outside');
    writeFileSync(outside, 'untouched');
    writeFileSync(join(bin, 'link-hba-to'), outside);
    if (kind === 'hardlink') writeFileSync(join(bin, 'link-hba-to.hard'), '');
    const opened = await openServices(definitions, artifacts, part('one'));
    try {
      expect(readFileSync(outside, 'utf8')).toBe('untouched');
      const file = join(root, 'runs', 'one', 'state', 'pg', 'pg_hba.conf');
      expect(lstatSync(file).isFile()).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('scram-sha-256');
    } finally { await opened.close(); }
  });
  it.each(['one', '.'])('gives no folder away through a link at %s', async target => {
    const artifacts = await prep(), elsewhere = join(root, 'elsewhere');
    mkdirSync(join(elsewhere, 'one'), { recursive: true, mode: 0o755 });
    if (target === 'one') mkdirSync(join(root, 'runs'));
    symlinkSync(elsewhere, join(root, 'runs', target));
    const opening = openServices(definitions, artifacts, part('one'));
    try { await expect(opening).rejects.toThrow(/link/); }
    finally { await opening.then(opened => opened.close(), () => {}); }
    expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
  });
  it('rejects modified immutable payload before opening a server', async () => {
    const artifacts = await prep();
    writeFileSync(join(artifacts.paths.pg!, 'PG_VERSION'), '16');
    await expect(openServices(definitions, artifacts, part('bad'))).rejects.toThrow(/checksum|integrity/);
  });
  it('keeps cache publication in its opened directory when preparation replaces the cache path', async () => {
    const cache = join(root, 'cache'), moved = join(root, 'moved-cache'), outside = join(root, 'outside');
    mkdirSync(outside);
    const defs: ServiceDefinitions = { ...definitions, prepare: [{ id: 'swap', serviceIds: ['pg'], commands: [{ program: process.execPath,
      args: ['-e', `const fs=require('node:fs');fs.renameSync(${JSON.stringify(cache)},${JSON.stringify(moved)});fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(cache)});`], cwd: '.' }] }] };
    await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: cache, envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) });
    expect(existsSync(join(outside, 'a'.repeat(64)))).toBe(false);
    expect(existsSync(join(moved, 'a'.repeat(64), 'READY.json'))).toBe(true);
  });
  it('never creates a lock target through a link in the cache', async () => {
    const cache = join(root, 'cache'), outside = join(root, 'outside');
    mkdirSync(cache); symlinkSync(outside, join(cache, 'a'.repeat(64) + '.lock'));
    await expect(prep()).rejects.toThrow();
    expect(existsSync(outside)).toBe(false);
  });
  it('cleans a failed preparation and never publishes READY', async () => {
    await expect(prepareServiceArtifacts(definitions, root, { ...context, env: { FAIL_SQL: '1' }, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) })).rejects.toThrow(/SQL failed/);
    expect(existsSync(join(root, 'cache', 'a'.repeat(64), 'READY.json'))).toBe(false);
    expect(log.join('\n')).not.toContain(secrets[0] ?? 'never-secret');
  });
  it('cancels an observed readiness query and removes both supervised processes and their socket', async () => {
    const controller = new AbortController();
    const marker = join(root, 'readiness');
    executable('psql', `const fs=require('node:fs'),p=require('node:path');if(process.argv.includes('--version')){console.log('psql (PostgreSQL) 17.4');process.exit(0)}if(!fs.existsSync(p.join(process.cwd(),'postmaster.pid')))process.exit(2);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,postgresPid:Number(fs.readFileSync(p.join(process.cwd(),'postmaster.pid'),'utf8')),host:process.env.PGHOST}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100);`);
    const watcher = watch(root);
    const entered = new Promise<{ pid: number; postgresPid: number; host: string }>(resolve => {
      watcher.on('change', () => {
        try { resolve(JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; postgresPid: number; host: string }); }
        catch { /* Creation can be observed before the marker's write finishes. */ }
      });
    });
    const running = prepareServiceArtifacts(definitions, root, { ...context, signal: controller.signal, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) });
    void running.catch(() => {});
    try {
      const observed = await Promise.race([entered, running.then(() => { throw new Error('Preparation ended without reaching readiness'); })]);
      expect(existsSync(observed.host)).toBe(true);
      controller.abort();
      await expect(running).rejects.toThrow(/cancel|abort/i);
      expect(existsSync(observed.host)).toBe(false);
      expect(() => process.kill(observed.pid, 0)).toThrow();
      expect(() => process.kill(observed.postgresPid, 0)).toThrow();
    } finally { watcher.close(); controller.abort(); await running.catch(() => {}); }
    expect(existsSync(join(root, 'cache', 'a'.repeat(64), 'READY.json'))).toBe(false);
  });
  it('removes a private socket even when PostgreSQL requires a forced stop', async () => {
    const version = "if(process.argv.includes('--version')){console.log('postgres (PostgreSQL) 17.4');process.exit(0)}";
    executable('postgres', `${version}const fs=require('node:fs'),p=require('node:path');const a=process.argv.slice(2);fs.writeFileSync(p.join(a[a.indexOf('-D')+1],'postmaster.pid'),String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);`);
    executable('pg_ctl', `${version}process.exit(1);`);
    const trace = join(root, 'socket');
    await expect(prepareServiceArtifacts(definitions, root, { ...context, graces: { ...LASTING, stopMs: 1 }, env: { SOCKET_TRACE: trace }, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) })).rejects.toThrow(/stop|cleanup|failed/i);
    expect(existsSync(readFileSync(trace, 'utf8'))).toBe(false);
    expect(existsSync(join(root, 'cache', 'a'.repeat(64), 'READY.json'))).toBe(false);
  });
  it('waits out an hour-long PostgreSQL stop on the fake clock, publishes the template and stops an attempt the same way', async () => {
    hourLongPostgres();
    const calls = join(root, 'pg_ctl');
    const env = (name: string) => ({ STOP_MS: String(HOUR), STOP_MARKER: join(root, `${name}-stopping`), STOP_RELEASE: join(root, `${name}-release`), PG_CTL_CALLS: calls });
    onFakeClock();
    try {
      /* The supervisor's own graces: no number of its own may end an ordinary stop. */
      const prepared = await stopping(() => prepareServiceArtifacts(definitions, root, { ...context, graces: undefined, env: env('prepared'), cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) }), env('prepared').STOP_MARKER);
      vi.advanceTimersByTime(HOUR);
      writeFileSync(env('prepared').STOP_RELEASE, '');
      const artifacts = await prepared.running;
      expect(existsSync(join(root, 'cache', 'a'.repeat(64), 'READY.json'))).toBe(true);
      const opened = await openServices(definitions, artifacts, { ...part('one'), graces: undefined, env: env('attempt') });
      try {
        const attempt = await stopping(() => opened.close(), env('attempt').STOP_MARKER);
        vi.advanceTimersByTime(HOUR);
        writeFileSync(env('attempt').STOP_RELEASE, '');
        await attempt.running;
      } finally {
        writeFileSync(env('attempt').STOP_RELEASE, '');
        vi.useRealTimers();
        await opened.close();
      }
    } finally { vi.useRealTimers(); }
    const stop = ['-D', expect.any(String), 'stop', '-m', 'fast', '-W'];
    expect(readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])).toEqual([stop, stop]);
  });
  it.each(['cancellation', 'deadline'] as const)('forces an unfinished PostgreSQL stop at its %s and publishes no template', async mode => {
    hourLongPostgres();
    const controller = new AbortController(), marker = join(root, 'stopping');
    let pid = 0;
    onFakeClock();
    try {
      const prepared = await stopping(() => prepareServiceArtifacts(definitions, root, { ...context, graces: undefined, signal: controller.signal, deadline: Date.now() + 2 * HOUR,
        env: { STOP_MS: String(HOUR), STOP_MARKER: marker, STOP_RELEASE: join(root, 'release'), PG_CTL_CALLS: join(root, 'pg_ctl') }, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) }), marker);
      pid = prepared.pid;
      if (mode === 'cancellation') controller.abort(); else vi.advanceTimersByTime(2 * HOUR);
      /* The supervisor's own stop grace, whatever it is, runs out on the fake clock. */
      vi.advanceTimersToNextTimer();
      await expect(prepared.running).rejects.toThrow();
    } finally { vi.useRealTimers(); }
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(root, 'cache', 'a'.repeat(64), 'READY.json'))).toBe(false);
  });
  it('starts the preparation server without fsync and the servers of attempts with it', async () => {
    const trace = join(root, 'servers');
    const artifacts = await prepareServiceArtifacts(definitions, root, { ...context, env: { SERVER_ARGS: trace }, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) });
    const opened = await openServices(definitions, artifacts, { ...part('one'), env: { SERVER_ARGS: trace } });
    await opened.close();
    const settings = readFileSync(trace, 'utf8').trim().split('\n').map(line => (JSON.parse(line) as string[]).filter((_, at, all) => all[at - 1] === '-c'));
    expect(settings).toHaveLength(2);
    expect(settings[0]).toContain('fsync=off');
    expect(settings[1]).not.toContain('fsync=off');
  });
  it('does not inspect unrelated processes after its own process groups have exited', async () => {
    procVisibility.readable = false;
    const artifacts = await prep();
    expect(readFileSync(join(artifacts.paths.pg!, 'PG_VERSION'), 'utf8')).toBe('17');
  });
  it('deduplicates concurrent preparation and keeps the stopped cache reusable', async () => {
    context.env = { INIT_MARKER: join(root, 'initializations') };
    const [one, two] = await Promise.all([prep(), prep()]);
    expect(one).toEqual(two);
    expect(readFileSync(join(root, 'initializations'), 'utf8')).toBe('init\n');
    expect(await prep()).toEqual(one);
  });
  it('redacts preparation command output and rejects missing referenced services', async () => {
    const defs = { ...definitions, prepare: [{ id: 'seed', serviceIds: ['pg'], commands: [{ program: process.execPath, args: ['-e', 'process.stdout.write(process.env.PGPASSWORD)'], cwd: '.' }] }] };
    await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'b'.repeat(64) });
    expect(log.join('\n')).toContain('[hidden]');
    for (const secret of secrets) expect(log.join('\n')).not.toContain(secret);
    defs.prepare[0]!.serviceIds = ['missing'];
    await expect(prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'd'.repeat(64), inputDigest: 'b'.repeat(64) })).rejects.toThrow(/unavailable service/);
  });
  it('rejects a node without an isolated service UID', async () => {
    await expect(prepareServiceArtifacts(definitions, root, { ...context, jobUser: context.nodeOwner, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) })).rejects.toThrow(/isolat/i);
  });
});

describe('managed process services', () => {
  function processDefinitions(graceMs = NEVER): ServiceDefinitions {
    executable('service', `const fs=require('node:fs'); const p=require('node:path'); const state=process.env.HH_SERVICE_STATE; fs.mkdirSync(p.join(state,'data'),{recursive:true}); fs.writeFileSync(p.join(state,'data','value'),'prepared'); fs.writeFileSync(p.join(state,'undeclared'),'private'); process.on('SIGINT',()=>{fs.writeFileSync(p.join(state,'data','stopped'),'yes');process.exit(0)}); setInterval(()=>{},100);`);
    executable('ready', `const fs=require('node:fs'); const p=require('node:path'); const t=setInterval(()=>{if(fs.existsSync(p.join(process.env.HH_SERVICE_STATE,'data','value'))){clearInterval(t);process.exit(process.env.BAD_READY==='1'?3:0)}},5);`);
    return { services: [{ id: 'worker', driver: 'process', runtime: 'node', profiles: ['fast'], options: {
      start: { program: join(bin, 'service'), args: [], cwd: '.' }, readiness: { program: join(bin, 'ready'), args: [], cwd: '.' },
      stop: { signal: 'SIGINT', graceMs }, statePaths: ['data'],
    } }], prepare: [] };
  }
  it('honors the stop policy before publishing only declared state', async () => {
    const defs = processDefinitions();
    const artifacts = await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'd'.repeat(64) });
    expect(readFileSync(join(artifacts.paths.worker!, 'data', 'stopped'), 'utf8')).toBe('yes');
    expect(existsSync(join(artifacts.paths.worker!, 'undeclared'))).toBe(false);
    const opened = await openServices(defs, artifacts, part('process'));
    try {
      expect(opened.env.HH_SERVICE_STATE).toContain(join('runs', 'process', 'state', 'worker'));
    } finally { await opened.close(); }
    expect(existsSync(opened.env.HH_SERVICE_STATE!)).toBe(false);
  });
  it('copies overlapping and repeated declared paths only once', async () => {
    const defs = processDefinitions();
    const service = defs.services[0]!;
    if (service.driver !== 'process') throw new Error('Expected a process fixture');
    service.options.statePaths = ['data/./', 'data', 'data/nested'];
    const artifacts = await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'd'.repeat(64) });
    expect(readFileSync(join(artifacts.paths.worker!, 'data', 'value'), 'utf8')).toBe('prepared');
    expect(readFileSync(join(artifacts.paths.worker!, 'data', 'stopped'), 'utf8')).toBe('yes');
  });
  it('waits for descendant writers before snapshotting declared process state', async () => {
    const defs = processDefinitions();
    const child = "const fs=require('node:fs'),p=require('node:path');const d=p.join(process.env.HH_SERVICE_STATE,'data');const leader=process.ppid;process.on('SIGINT',()=>setInterval(()=>{if(process.ppid===leader)return;fs.writeFileSync(p.join(d,'child-stopped'),'yes');if(process.env.CHILD_STOP_MARKER)fs.writeFileSync(process.env.CHILD_STOP_MARKER,'yes');process.exit(0)},5));fs.writeFileSync(p.join(d,'child-ready'),'yes');if(process.env.CHILD_STOP_MARKER)fs.writeFileSync(process.env.CHILD_STOP_MARKER+'.ready','yes');setInterval(()=>{},100)";
    executable('service', `const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');const d=p.join(process.env.HH_SERVICE_STATE,'data');fs.mkdirSync(d,{recursive:true});cp.spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});const t=setInterval(()=>{if(fs.existsSync(p.join(d,'child-ready'))){clearInterval(t);fs.writeFileSync(p.join(d,'value'),'ready')}},5);process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},100);`);
    executable('ready', "const fs=require('node:fs'),p=require('node:path');const marker=process.env.CHILD_STOP_MARKER?process.env.CHILD_STOP_MARKER+'.ready':p.join(process.env.HH_SERVICE_STATE,'data','value');setInterval(()=>{if(fs.existsSync(marker))process.exit(0)},5);");
    const artifacts = await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'b'.repeat(64) });
    expect(readFileSync(join(artifacts.paths.worker!, 'data', 'child-stopped'), 'utf8')).toBe('yes');
    const marker = join(root, 'runtime-child-stopped');
    const opened = await openServices(defs, artifacts, { ...part('descendant'), env: { CHILD_STOP_MARKER: marker } });
    await opened.close();
    expect(readFileSync(marker, 'utf8')).toBe('yes');
    expect(existsSync(opened.env.HH_SERVICE_STATE!)).toBe(false);
  });
  it('takes a process that ends while its state is read for gone while a descendant still writes', async () => {
    const defs = processDefinitions();
    const release = join(root, 'release');
    /* The descendant stays after its leader until the test lets it go, but only in the opened run, which is ready once it is. */
    const child = "const fs=require('node:fs'),p=require('node:path');const d=p.join(process.env.HH_SERVICE_STATE,'data');const leader=process.ppid;process.on('SIGINT',()=>setInterval(()=>{if(process.ppid===leader)return;if(process.env.RELEASE&&!fs.existsSync(process.env.RELEASE))return;process.exit(0)},5));fs.writeFileSync(p.join(d,'child-ready'),'yes');if(process.env.RELEASE)fs.writeFileSync(process.env.RELEASE+'.ready','yes');setInterval(()=>{},100)";
    executable('service', `const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');const d=p.join(process.env.HH_SERVICE_STATE,'data');fs.mkdirSync(d,{recursive:true});cp.spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});const t=setInterval(()=>{if(fs.existsSync(p.join(d,'child-ready'))){clearInterval(t);fs.writeFileSync(p.join(d,'value'),'ready')}},5);process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},100);`);
    executable('ready', "const fs=require('node:fs'),p=require('node:path');const marker=process.env.RELEASE?process.env.RELEASE+'.ready':p.join(process.env.HH_SERVICE_STATE,'data','value');setInterval(()=>{if(fs.existsSync(marker))process.exit(0)},5);");
    const artifacts = await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'e'.repeat(64) });
    const opened = await openServices(defs, artifacts, { ...part('ending'), env: { RELEASE: release } });
    try {
      procVisibility.ending = '/proc/1/stat';
      const closed = opened.close().then(() => 'closed', (error: Error) => error.message);
      await eventually(() => procVisibility.reads > 0);
      writeFileSync(release, 'yes');
      expect(await closed).toBe('closed');
    } finally {
      procVisibility.ending = '';
      writeFileSync(release, 'yes');
      await opened.close();
    }
  });

  it('stops earlier services when a later readiness command fails', async () => {
    const defs = processDefinitions();
    defs.services.unshift(definitions.services[0]!);
    const artifacts = await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'e'.repeat(64), inputDigest: 'f'.repeat(64) });
    await expect(openServices(defs, artifacts, { ...part('partial'), env: { BAD_READY: '1' } })).rejects.toThrow(/failed/);
    expect(existsSync(join(root, 'runs', 'partial', 'state'))).toBe(false);
  });
  it('lets descendants flush prepared state past the supervisor\'s stop grace', async () => {
    const defs = processDefinitions();
    const child = "const fs=require('node:fs'),p=require('node:path');const d=p.join(process.env.HH_SERVICE_STATE,'data');const leader=process.ppid;process.on('SIGINT',()=>setInterval(()=>{if(process.ppid===leader)return;fs.writeFileSync(p.join(d,'flushed'),'yes');process.exit(0)},5));fs.writeFileSync(p.join(d,'child-ready'),'yes');setInterval(()=>{},100)";
    executable('service', `const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');const d=p.join(process.env.HH_SERVICE_STATE,'data');fs.mkdirSync(d,{recursive:true});cp.spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{if(fs.existsSync(p.join(d,'child-ready')))fs.writeFileSync(p.join(d,'value'),'ready')},5);process.on('SIGINT',()=>process.exit(0));`);
    const artifact = await prepareServiceArtifacts(defs, root, { ...context, graces: { ...LASTING, stopMs: 1 }, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'd'.repeat(64) });
    expect(readFileSync(join(artifact.paths.worker!, 'data', 'flushed'), 'utf8')).toBe('yes');
  });
  it('keeps an ordinary stop waiting for a descendant that ignores it and publishes nothing once cancellation forces it', async () => {
    const defs = processDefinitions(1);
    const controller = new AbortController(), marker = join(root, 'asked');
    const child = "const fs=require('node:fs'),p=require('node:path');process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{fs.writeFileSync(process.env.STOP_MARKER+'.tmp',JSON.stringify({pid:process.pid}));fs.renameSync(process.env.STOP_MARKER+'.tmp',process.env.STOP_MARKER)});fs.writeFileSync(p.join(process.env.HH_SERVICE_STATE,'data','child-ready'),'yes');setInterval(()=>{},100)";
    executable('service', `const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');const d=p.join(process.env.HH_SERVICE_STATE,'data');fs.mkdirSync(d,{recursive:true});cp.spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{if(fs.existsSync(p.join(d,'child-ready'))){fs.writeFileSync(p.join(d,'value'),'ready');process.exit(0)}},5);`);
    onFakeClock();
    try {
      const prepared = await stopping(() => prepareServiceArtifacts(defs, root, { ...context, graces: { ...LASTING, stopMs: 1 }, signal: controller.signal, env: { STOP_MARKER: marker }, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'd'.repeat(64) }), marker);
      controller.abort();
      vi.advanceTimersToNextTimer();
      await expect(prepared.running).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: 'Service required forced stop; state cannot be published' })],
      });
    } finally { vi.useRealTimers(); }
    expect(existsSync(join(root, 'cache', 'c'.repeat(64), 'READY.json'))).toBe(false);
  });
  /* A service whose stop lasts an hour on the fake clock, with the longest stop grace a project may give it. */
  function hourLongProcess(): ServiceDefinitions {
    const defs = processDefinitions(30_000);
    executable('service', `const fs=require('node:fs'),p=require('node:path');${HOUR_LONG_STOP}const d=p.join(process.env.HH_SERVICE_STATE,'data');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'value'),'prepared');process.on('SIGTERM',()=>{});process.on('SIGINT',()=>stopping(()=>{fs.writeFileSync(p.join(d,'stopped'),'yes');process.exit(0)}));setInterval(()=>{},100);`);
    return defs;
  }
  it('waits out an hour-long stop of a process service on the fake clock and publishes its state', async () => {
    const defs = hourLongProcess(), marker = join(root, 'stopping'), release = join(root, 'release');
    onFakeClock();
    try {
      /* The supervisor's own graces: neither its numbers nor the service's grace may end an ordinary stop. */
      const prepared = await stopping(() => prepareServiceArtifacts(defs, root, { ...context, graces: undefined, env: { STOP_MARKER: marker, STOP_RELEASE: release }, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'd'.repeat(64) }), marker);
      vi.advanceTimersByTime(HOUR);
      writeFileSync(release, '');
      const artifacts = await prepared.running;
      expect(readFileSync(join(artifacts.paths.worker!, 'data', 'stopped'), 'utf8')).toBe('yes');
    } finally { vi.useRealTimers(); }
  });
  it.each(['cancellation', 'deadline'] as const)('forces an unfinished stop of a process service at its %s and publishes no state', async mode => {
    const defs = hourLongProcess(), controller = new AbortController(), marker = join(root, 'stopping');
    let pid = 0;
    onFakeClock();
    try {
      const prepared = await stopping(() => prepareServiceArtifacts(defs, root, { ...context, graces: undefined, signal: controller.signal, deadline: Date.now() + 2 * HOUR,
        env: { STOP_MARKER: marker, STOP_RELEASE: join(root, 'release') }, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'd'.repeat(64) }), marker);
      pid = prepared.pid;
      if (mode === 'cancellation') controller.abort(); else vi.advanceTimersByTime(2 * HOUR);
      /* The supervisor's own stop grace, whatever it is, runs out on the fake clock. */
      vi.advanceTimersToNextTimer();
      await expect(prepared.running).rejects.toThrow();
    } finally { vi.useRealTimers(); }
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(root, 'cache', 'c'.repeat(64), 'READY.json'))).toBe(false);
  });
});

describe('service preparation lock ownership', () => {
  const key = '9'.repeat(64);
  function fixture(persistentWriter = false): ServiceDefinitions {
    const ownerCheck = "try{process.kill(Number(process.env.OWNER_PID),0)}catch{process.exit(1)}";
    executable('worker', `const fs=require('node:fs'),p=require('node:path');fs.mkdirSync(p.join(process.env.HH_SERVICE_STATE,'data'),{recursive:true});fs.appendFileSync(process.env.WORKERS,process.pid+'\\n');process.on('SIGINT',()=>process.exit(0));${persistentWriter ? "process.on('SIGTERM',()=>{});" : ''}setInterval(()=>{${persistentWriter ? "process.stdout.write('writer\\n');fs.writeFileSync(p.join(process.env.HH_SERVICE_STATE,'data','value'),String(Date.now()))" : ownerCheck}},10);`);
    executable('worker-ready', "const fs=require('node:fs'),p=require('node:path');setInterval(()=>{if(fs.existsSync(p.join(process.env.HH_SERVICE_STATE,'data')))process.exit(0)},5);");
    executable('barrier', `const fs=require('node:fs');fs.writeFileSync(process.env.ENTERED,'yes');setInterval(()=>{${ownerCheck};if(!fs.existsSync(process.env.HOLD))process.exit(0)},10);`);
    return { services: [{ id: 'worker', driver: 'process', runtime: 'node', profiles: ['fast'], options: {
      start: { program: join(bin, 'worker'), args: [], cwd: '.' },
      readiness: { program: join(bin, 'worker-ready'), args: [], cwd: '.' },
      stop: { signal: 'SIGINT', graceMs: NEVER }, statePaths: ['data'],
    } }], prepare: [{ id: 'barrier', serviceIds: ['worker'], commands: [{ program: join(bin, 'barrier'), args: [], cwd: '.' }] }] };
  }
  function preparationContext(name: string) {
    return { ...context, cacheRoot: join(root, 'cache'), envKey: key, inputDigest: 'd'.repeat(64), env: {
      OWNER_PID: String(process.pid), WORKERS: join(root, 'workers'), HOLD: join(root, 'hold'), ENTERED: join(root, name),
    } };
  }
  async function owner(defs: ServiceDefinitions): Promise<{ child: ChildProcess; ended: Promise<[number | null, NodeJS.Signals | null]> }> {
    const ctx = preparationContext('entered');
    writeFileSync(ctx.env.HOLD, 'hold');
    const script = `import {prepareServiceArtifacts} from ${JSON.stringify(new URL('../src/test-services.ts', import.meta.url).href)};process.getuid=()=>0;const context=${JSON.stringify(ctx)};context.signal=new AbortController().signal;context.deadline=Date.now()+${NEVER};context.log=()=>{};context.registerSecrets=()=>{};context.env.OWNER_PID=String(process.pid);await prepareServiceArtifacts(${JSON.stringify(defs)},${JSON.stringify(root)},context);`;
    const watcher = watch(root);
    const entered = new Promise<void>(resolve => watcher.on('change', () => { if (existsSync(ctx.env.ENTERED)) resolve(); }));
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('../../..', import.meta.url)), stdio: 'ignore' });
    if (child.pid) {
      try {
        appendFileSync(pidLog, `${child.pid}\n`);
      } catch {
        /* Tracker directory may already be removed during process shutdown. */
      }
    }
    const ended = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    try {
      await Promise.race([entered, ended.then(([code, signal]) => { throw new Error(`Owner exited before preparation: ${code ?? signal}`); })]);
      return { child, ended };
    } catch (error) { child.kill('SIGKILL'); await ended; throw error;
    } finally { watcher.close(); }
  }
  /* A contender for a held lock, on a fake clock: once it waits for the lock, its deadline comes or it is cancelled by the
     test's hand, never by the real clock. Returns why it gave up. */
  async function contend(defs: ServiceDefinitions, ctx: ServicePrepareContext, mode: 'deadline' | 'cancellation'): Promise<unknown> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const controller = new AbortController();
      const running = prepareServiceArtifacts(defs, root, { ...ctx, signal: controller.signal, deadline: Date.now() + 60_000 });
      void running.catch(() => {});
      await eventually(() => vi.getTimerCount() === 1);
      if (mode === 'cancellation') controller.abort();
      else {
        vi.advanceTimersByTime(59_999);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(1);
      }
      return await running.then(() => { throw new Error('The contender took a held lock'); }, (error: unknown) => error);
    } finally { vi.useRealTimers(); }
  }
  function stopWorkers(): void {
    if (!existsSync(join(root, 'workers'))) return;
    for (const pid of readFileSync(join(root, 'workers'), 'utf8').trim().split('\n')) {
      try { process.kill(-Number(pid), 'SIGKILL'); } catch { /* Fixture already exited after its owner. */ }
    }
  }
  it('recovers preparation after the lock owner is killed', async () => {
    const defs = fixture();
    const running = await owner(defs);
    try {
      running.child.kill('SIGKILL');
      expect((await running.ended)[1]).toBe('SIGKILL');
      rmSync(join(root, 'hold'));
      const recovered = await prepareServiceArtifacts(defs, root, preparationContext('recovered'));
      expect(existsSync(join(recovered.paths.worker!, 'data'))).toBe(true);
      expect(existsSync(join(root, 'cache', key, 'READY.json'))).toBe(true);
    } finally { running.child.kill('SIGKILL'); await running.ended; stopWorkers(); }
  });
  it('keeps the lease after parent death until its surviving writer has stopped', async () => {
    const defs = fixture(true);
    const running = await owner(defs);
    try {
      const writer = Number(readFileSync(join(root, 'workers'), 'utf8').trim());
      running.child.kill('SIGKILL'); await running.ended;
      expect(() => process.kill(writer, 0)).not.toThrow();
      expect(await contend(defs, preparationContext('contender'), 'deadline')).toMatchObject({ message: expect.stringMatching(/deadline/i) });
      expect(readFileSync(join(root, 'workers'), 'utf8').trim().split('\n')).toHaveLength(1);
      expect(existsSync(join(root, 'cache', key, 'READY.json'))).toBe(false);
      stopWorkers(); rmSync(join(root, 'hold'));
      const recovered = await prepareServiceArtifacts(defs, root, preparationContext('recovered'));
      expect(existsSync(join(recovered.paths.worker!, 'data'))).toBe(true);
    } finally { running.child.kill('SIGKILL'); await running.ended; stopWorkers(); }
  });
  it.each(['deadline', 'cancellation'] as const)('does not steal a live owner lock or publish a second template after %s', async mode => {
    const defs = fixture();
    const running = await owner(defs);
    try {
      expect(await contend(defs, preparationContext('contender'), mode)).toMatchObject({ message: expect.stringMatching(/deadline|cancel/i) });
      expect(readFileSync(join(root, 'workers'), 'utf8').trim().split('\n')).toHaveLength(1);
      expect(existsSync(join(root, 'cache', key, 'READY.json'))).toBe(false);
      rmSync(join(root, 'hold'));
      expect((await running.ended)[0]).toBe(0);
      const artifact = await prepareServiceArtifacts(defs, root, preparationContext('hit'));
      expect(existsSync(join(artifact.paths.worker!, 'data'))).toBe(true);
      expect(readFileSync(join(root, 'workers'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { running.child.kill('SIGKILL'); await running.ended; stopWorkers(); }
  });
  it('rejects ownerless legacy directory locks without changing them', async () => {
    const defs = fixture();
    const lock = join(root, 'cache', `${key}.lock`);
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    const inode = statSync(lock).ino;
    try {
      await expect(prepareServiceArtifacts(defs, root, preparationContext('legacy'))).rejects.toThrow(/legacy.*directory.*lock/i);
      expect(statSync(lock).ino).toBe(inode);
      expect(existsSync(join(root, 'workers'))).toBe(false);
      expect(existsSync(join(root, 'cache', key, 'READY.json'))).toBe(false);
    } finally { stopWorkers(); }
  });
});

interface PgliteTemplateBoundary {
  root?: string;
  pgliteVersion?: string;
  dump?: () => Promise<Buffer> | Buffer;
}

interface PrepareEnvironmentModule {
  preparePgliteTemplate: (output: string, options?: PgliteTemplateBoundary) => Promise<void>;
  readPgliteTemplate: (path: string, options?: Omit<PgliteTemplateBoundary, 'dump'>) => Buffer | null;
}

interface GlobalSetupModule {
  default: (
    project: { provide: (key: 'migratedDataDir' | 'databaseMetadataFile', value: string) => void },
    options?: PgliteTemplateBoundary & { templatePath?: string; metadata?: (dump: Buffer) => Promise<string> | string },
  ) => Promise<() => void>;
}

const RECORDED_PGLITE_DUMP = Buffer.from('hornhoof-recorded-pglite-migrated-dump-v1\n', 'utf8');
const STANDALONE_PGLITE_DUMP = Buffer.from('hornhoof-standalone-pglite-migrated-dump-v1\n', 'utf8');

function createPgliteInputFixture(dir: string): string {
  const files: Record<string, string> = {
    'apps/server/drizzle/0000_initial.sql': 'select 1;\n',
    'apps/server/drizzle/meta/_journal.json': '{"entries":[{"tag":"0000_initial"}]}\n',
    'apps/server/src/db/schema.ts': 'export const schemaVersion = 1;\n',
    'apps/server/src/db/client.ts': 'export const clientVersion = 1;\n',
    'apps/server/src/db/agent-sql.ts': 'export const agentSqlVersion = 1;\n',
    'apps/server/test/prepare-environment.ts': 'export const prepareVersion = 1;\n',
    'apps/server/test/global-setup.ts': 'export const setupVersion = 1;\n',
    'apps/server/package.json': '{"name":"@hornhoof/server"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'packages/protocol/dist/index.js': 'export const protocolVersion = 1;\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

async function loadPgliteEnvironment(): Promise<PrepareEnvironmentModule & { setup: GlobalSetupModule['default'] }> {
  const [prepareEnv, globalSetup] = await Promise.all([
    vi.importActual<PrepareEnvironmentModule>(fileURLToPath(new URL('../../server/test/prepare-environment.ts', import.meta.url))),
    vi.importActual<GlobalSetupModule>(fileURLToPath(new URL('../../server/test/global-setup.ts', import.meta.url))),
  ]);
  return { ...prepareEnv, setup: globalSetup.default };
}

describe('prepared PGlite compatibility', () => {
  let previousTemplate: string | undefined;

  beforeEach(() => { previousTemplate = process.env.HH_PGLITE_TEMPLATE; });
  afterEach(() => {
    if (previousTemplate === undefined) delete process.env.HH_PGLITE_TEMPLATE;
    else process.env.HH_PGLITE_TEMPLATE = previousTemplate;
  });

  it('copies a validated migrated dump and rejects stale metadata or changed bytes', async () => {
    const { preparePgliteTemplate, readPgliteTemplate, setup } = await loadPgliteEnvironment();
    const fixture = createPgliteInputFixture(join(root, 'pglite-inputs'));
    const templateDir = join(root, 'pglite');
    const dumpSpy = vi.fn(() => RECORDED_PGLITE_DUMP);
    const fallbackSpy = vi.fn(() => STANDALONE_PGLITE_DUMP);
    await preparePgliteTemplate(templateDir, { root: fixture, dump: dumpSpy });
    expect(dumpSpy).toHaveBeenCalledTimes(1);
    const bytes = readPgliteTemplate(templateDir, { root: fixture });
    expect(bytes).toEqual(RECORDED_PGLITE_DUMP);

    const provided: Record<string, string> = {};
    process.env.HH_PGLITE_TEMPLATE = templateDir;
    const metadata = vi.fn(() => 'recorded schema metadata');
    const cleanup = await setup({ provide: (key, value) => { provided[key] = value; } }, { root: fixture, dump: fallbackSpy, metadata });
    try {
      expect(fallbackSpy).not.toHaveBeenCalled();
      expect(Object.keys(provided).sort()).toEqual(['databaseMetadataFile', 'migratedDataDir']);
      expect(readFileSync(provided.migratedDataDir!)).toEqual(RECORDED_PGLITE_DUMP);
      expect(readFileSync(provided.databaseMetadataFile!, 'utf8')).toBe('recorded schema metadata');
      expect(metadata).toHaveBeenCalledWith(RECORDED_PGLITE_DUMP);
      expect(provided.migratedDataDir!.startsWith(templateDir)).toBe(false);
    } finally {
      cleanup();
    }
    expect(existsSync(dirname(provided.migratedDataDir!))).toBe(false);

    const readyFile = join(templateDir, 'READY.json');
    const readyMetadata = JSON.parse(readFileSync(readyFile, 'utf8')) as {
      format: string; pgliteVersion: string; inputDigest: string; dumpDigest: string; inputs: Record<string, string>;
    };
    writeFileSync(readyFile, JSON.stringify({ ...readyMetadata, format: 'hornhoof-pglite-v0' }));
    expect(readPgliteTemplate(templateDir, { root: fixture })).toBeNull();
    writeFileSync(readyFile, JSON.stringify({ ...readyMetadata, pgliteVersion: '0.0.0' }));
    expect(readPgliteTemplate(templateDir, { root: fixture })).toBeNull();
    writeFileSync(readyFile, JSON.stringify({ ...readyMetadata, inputDigest: '0'.repeat(64) }));
    expect(readPgliteTemplate(templateDir, { root: fixture })).toBeNull();
    writeFileSync(readyFile, JSON.stringify({ ...readyMetadata, inputs: { ...readyMetadata.inputs, 'package-lock.json': '0'.repeat(64) } }));
    expect(readPgliteTemplate(templateDir, { root: fixture })).toBeNull();
    writeFileSync(readyFile, JSON.stringify(readyMetadata));
    const migrationFile = join(fixture, 'apps/server/drizzle/0000_initial.sql');
    const migrationOriginal = readFileSync(migrationFile);
    writeFileSync(migrationFile, 'select 2;\n');
    expect(readPgliteTemplate(templateDir, { root: fixture })).toBeNull();
    writeFileSync(migrationFile, migrationOriginal);
    expect(readPgliteTemplate(templateDir, { root: fixture })).toEqual(RECORDED_PGLITE_DUMP);
    writeFileSync(join(templateDir, 'migrated.tar'), 'corrupt');
    expect(readPgliteTemplate(templateDir, { root: fixture })).toBeNull();
  });

  it('falls back to standalone migrations when the optional artifact is corrupt', async () => {
    const { setup } = await loadPgliteEnvironment();
    const fixture = createPgliteInputFixture(join(root, 'pglite-inputs'));
    const templateDir = join(root, 'pglite-corrupt');
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, 'READY.json'), '{}');
    writeFileSync(join(templateDir, 'migrated.tar'), 'corrupt');
    process.env.HH_PGLITE_TEMPLATE = templateDir;

    const provided: Record<string, string> = {};
    const fallbackSpy = vi.fn(async () => STANDALONE_PGLITE_DUMP);
    const cleanup = await setup({ provide: (key, value) => { provided[key] = value; } }, { root: fixture, dump: fallbackSpy, metadata: () => 'standalone schema metadata' });
    try {
      expect(fallbackSpy).toHaveBeenCalledTimes(1);
      expect(Object.keys(provided).sort()).toEqual(['databaseMetadataFile', 'migratedDataDir']);
      expect(readFileSync(provided.migratedDataDir!)).toEqual(STANDALONE_PGLITE_DUMP);
      expect(readFileSync(provided.databaseMetadataFile!, 'utf8')).toBe('standalone schema metadata');
      expect(provided.migratedDataDir!.startsWith(templateDir)).toBe(false);
    } finally {
      cleanup();
    }
    expect(existsSync(dirname(provided.migratedDataDir!))).toBe(false);

    const failedProvided: string[] = [];
    await expect(
      setup(
        { provide: (_, value) => { failedProvided.push(value); } },
        { root: fixture, dump: () => { throw new Error('standalone migration failed'); } },
      ),
    ).rejects.toThrow('standalone migration failed');
    expect(failedProvided).toEqual([]);
  });

  it('publishes no paths when describing the copied dump fails', async () => {
    const { setup } = await loadPgliteEnvironment();
    const fixture = createPgliteInputFixture(join(root, 'pglite-inputs'));
    const provided: string[] = [];
    await expect(setup({ provide: (_, value) => { provided.push(value); } }, {
      root: fixture, dump: () => RECORDED_PGLITE_DUMP,
      metadata: () => { throw new Error('schema description failed'); },
    })).rejects.toThrow('schema description failed');
    expect(provided).toEqual([]);
  });
});

describe('service ownership boundaries', () => {
  it('does not remove state belonging to an existing attempt', async () => {
    const artifacts = await prep();
    const state = join(root, 'runs', 'existing', 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'owner'), 'earlier attempt');
    await expect(openServices(definitions, artifacts, part('existing'))).rejects.toThrow(/already exists/);
    expect(readFileSync(join(state, 'owner'), 'utf8')).toBe('earlier attempt');
  });
  it('requests no service capability and creates no state for an empty service list', async () => {
    const empty = { services: [], prepare: [] };
    const noIsolation = { ...context, nodeOwner: context.jobUser };
    const artifacts = await prepareServiceArtifacts(empty, root, { ...noIsolation, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) });
    const opened = await openServices(empty, artifacts, { ...part('empty'), ...noIsolation });
    try {
      expect(opened.env).toEqual({});
    } finally { await opened.close(); }
    expect(existsSync(join(root, 'runs', 'empty'))).toBe(false);
  });
});

describe('manifest argv selection', () => {
  it.each([
    { id: 'node', selected: 'test/redact.test.ts', expected: 'apps/node/test/redact.test.ts' },
    { id: 'server-postgres', selected: 'test/postgres/race.pg.spec.ts', expected: 'apps/server/test/postgres/race.pg.spec.ts' },
  ])('collects only the selected file for $id before execution', async ({ id, selected, expected }) => {
    const checkout = fileURLToPath(new URL('../../..', import.meta.url));
    const manifest = JSON.parse(readFileSync(join(checkout, '.hornhoof/test-environment.json'), 'utf8')) as { suites: { id: string; run: ServiceCommand }[] };
    const run = manifest.suites.find(suite => suite.id === id)!.run;
    const inventory = join(root, `${id}-inventory.json`);
    const list = run.args.flatMap(arg => arg === 'run' ? ['list', '--filesOnly', `--json=${inventory}`] : [arg]);
    await promisify(execFile)(run.program, [...list, selected], { cwd: join(checkout, run.cwd) });
    const files = JSON.parse(readFileSync(inventory, 'utf8')) as { file: string }[];
    expect(files.map(file => file.file)).toEqual([join(checkout, expected)]);
    if (id === 'node') {
      const reportFile = join(root, 'selected-run.json'), filesFile = join(root, 'selected-files.json');
      writeFileSync(filesFile, JSON.stringify([`./${expected}`]));
      const args = run.args.flatMap(arg => arg === 'run' ? ['run', '--reporter=json', `--outputFile=${reportFile}`, '--shard=1/1'] : [arg]);
      await promisify(execFile)(run.program, [...args, selected], { cwd: join(checkout, run.cwd), env: { ...process.env, HH_TEST_FILES: filesFile } });
      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { numTotalTests: number; testResults: { name: string }[] };
      expect(report.testResults.map(file => file.name)).toEqual([join(checkout, expected)]);
      expect(report.numTotalTests).toBeGreaterThan(0);
    }
  });
});

describe('generated protocol inputs in prepared PGlite templates', () => {
  it('hashes actual generated bytes and accepts the same bytes after a rebuild', async () => {
    const { preparePgliteTemplate, readPgliteTemplate } = await loadPgliteEnvironment();
    const fixture = createPgliteInputFixture(join(root, 'generated-protocol'));
    const output = join(fixture, 'template');
    const dist = join(fixture, 'packages/protocol/dist');
    const file = join(dist, 'index.js');
    const original = readFileSync(file);

    await preparePgliteTemplate(output, { root: fixture, dump: () => RECORDED_PGLITE_DUMP });
    expect(readPgliteTemplate(output, { root: fixture })).toEqual(RECORDED_PGLITE_DUMP);

    const metadata = JSON.parse(readFileSync(join(output, 'READY.json'), 'utf8')) as { inputs: Record<string, string> };
    expect(metadata.inputs['packages/protocol/dist/index.js']).toBe(createHash('sha256').update(original).digest('hex'));

    writeFileSync(file, Buffer.concat([original, Buffer.from('\n// changed generated bytes\n')]));
    expect(readPgliteTemplate(output, { root: fixture })).toBeNull();

    rmSync(file);
    writeFileSync(file, original);
    expect(readPgliteTemplate(output, { root: fixture })).toEqual(RECORDED_PGLITE_DUMP);

    mkdirSync(join(dist, 'nested'));
    writeFileSync(join(dist, 'nested', 'extra.js'), 'export const extra = 1;\n');
    expect(readPgliteTemplate(output, { root: fixture })).toBeNull();

    rmSync(join(dist, 'nested'), { recursive: true });
    expect(readPgliteTemplate(output, { root: fixture })).toEqual(RECORDED_PGLITE_DUMP);
  });

  it('fails preparation explicitly for absent or empty generated output', async () => {
    const { preparePgliteTemplate, readPgliteTemplate } = await loadPgliteEnvironment();
    const fixture = createPgliteInputFixture(join(root, 'generated-protocol-missing'));
    const output = join(fixture, 'template');
    const dist = join(fixture, 'packages/protocol/dist');
    const dumpSpy = vi.fn(() => RECORDED_PGLITE_DUMP);

    await preparePgliteTemplate(output, { root: fixture, dump: dumpSpy });
    expect(readPgliteTemplate(output, { root: fixture })).toEqual(RECORDED_PGLITE_DUMP);
    expect(dumpSpy).toHaveBeenCalledTimes(1);

    rmSync(dist, { recursive: true });
    await expect(preparePgliteTemplate(join(fixture, 'absent'), { root: fixture, dump: dumpSpy }))
      .rejects.toThrow(/Missing required generated protocol artifact: packages\/protocol\/dist/);
    expect(readPgliteTemplate(output, { root: fixture })).toBeNull();
    expect(dumpSpy).toHaveBeenCalledTimes(1);

    mkdirSync(join(dist, 'empty-subdir'), { recursive: true });
    await expect(preparePgliteTemplate(join(fixture, 'empty'), { root: fixture, dump: dumpSpy }))
      .rejects.toThrow(/Missing required generated protocol artifact: packages\/protocol\/dist/);
    expect(readPgliteTemplate(output, { root: fixture })).toBeNull();
    expect(dumpSpy).toHaveBeenCalledTimes(1);
  });
});

function procTaskState(pid: number): string {
  if (!existsSync('/proc')) return 'R';
  try {
    const text = readFileSync(join('/proc', String(pid), 'stat'), 'utf8');
    return text.slice(text.lastIndexOf(')') + 2).split(' ', 1)[0] ?? '';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? 'X' : 'R';
  }
}

function servicePidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  const state = procTaskState(pid);
  return state !== 'Z' && state !== 'X';
}

describe('service test cleanup on failure or abort', () => {
  const leakedPids = new Set<number>();
  const leakedPaths = new Set<string>();

  afterEach(() => {
    for (const pid of leakedPids) killServiceProcessGroup(pid);
    leakedPids.clear();
    for (const path of leakedPaths) rmSync(path, { recursive: true, force: true });
    leakedPaths.clear();
  });

  it.each(['afterEach', 'exit', 'sigterm'] as const)('stops fake postgres from runs/one/state/pg when a test ends by %s', async mode => {
    const checkout = fileURLToPath(new URL('../../..', import.meta.url));
    const recordFile = join(root, `abort-${mode}.json`);
    const probeConfig = join(root, `vitest.probe.${mode}.config.mjs`);
    writeFileSync(
      probeConfig,
      [
        'export default {',
        `  root: ${JSON.stringify(checkout)},`,
        "  test: { pool: 'forks', maxWorkers: 1, testTimeout: 20000, reporters: ['default'], include: ['apps/node/test/test-services.test.ts'] },",
        '};',
        '',
      ].join('\n'),
    );
    const child = spawn(
      process.execPath,
      [join(checkout, 'node_modules/vitest/vitest.mjs'), 'run', '--config', probeConfig, 'apps/node/test/test-services.test.ts', '-t', 'service postgres abort probe'],
      {
        cwd: checkout,
        env: {
          ...process.env,
          VITEST: '',
          VITEST_WORKER_ID: '',
          VITEST_POOL_ID: '',
          HH_TEST_REPORT: '',
          HH_TEST_PART: '',
          HH_TEST_FILES: '',
          HH_SERVICES_ABORT_MODE: mode,
          HH_SERVICES_ABORT_FILE: recordFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let childOut = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { childOut += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { childOut += chunk; });
    try {
      await once(child, 'exit');
    } finally {
      if (existsSync(recordFile)) {
        const saved = JSON.parse(readFileSync(recordFile, 'utf8')) as { pid: number; root: string; socket: string };
        if (saved.pid > 1) leakedPids.add(saved.pid);
        if (saved.root) leakedPaths.add(saved.root);
        if (saved.socket) leakedPaths.add(saved.socket);
      }
    }
    if (!existsSync(recordFile)) throw new Error(`Probe wrote no record:\n${childOut}`);
    const observed = JSON.parse(readFileSync(recordFile, 'utf8')) as {
      pid: number; root: string; socket: string; aliveAfterEach?: boolean; rootAfterEach?: boolean;
    };
    if (observed.pid <= 1) throw new Error(`Probe recorded no postgres pid:\n${childOut}`);
    if (mode === 'afterEach') {
      expect(observed.aliveAfterEach).toBe(false);
      expect(observed.rootAfterEach).toBe(false);
      return;
    }
    await eventually(() => !servicePidAlive(observed.pid));
    expect(existsSync(observed.root)).toBe(false);
    expect(existsSync(observed.socket)).toBe(false);
  });
});

if (process.env.HH_SERVICES_ABORT_MODE && process.env.HH_SERVICES_ABORT_FILE) {
  describe('service postgres abort probe', () => {
    const mode = process.env.HH_SERVICES_ABORT_MODE;
    const recordFile = process.env.HH_SERVICES_ABORT_FILE!;
    let saved = { pid: 0, root: '', socket: '' };

    it('opens fake postgres in runs/one/state/pg and aborts without closing it', async () => {
      hourLongPostgres();
      const env = { STOP_MS: String(HOUR), STOP_MARKER: join(root, 'stop-marker'), STOP_RELEASE: join(root, 'stop-release'), PG_CTL_CALLS: join(root, 'pg_ctl') };
      writeFileSync(env.STOP_RELEASE, '');
      const artifacts = await prepareServiceArtifacts(definitions, root, { ...context, env, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) });
      rmSync(env.STOP_RELEASE);
      const opened = await openServices(definitions, artifacts, { ...part('one'), env });
      const pidFile = join(root, 'runs', 'one', 'state', 'pg', 'postmaster.pid');
      await eventually(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8').trim()) > 1);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      saved = { pid, root, socket: opened.env.PGHOST! };
      writeFileSync(recordFile, JSON.stringify(saved));
      if (mode === 'exit') process.exit(1);
      if (mode === 'sigterm') {
        process.kill(process.pid, 'SIGTERM');
        await new Promise(() => {});
      }
      throw new Error('simulated failure after opening postgres');
    });

    if (mode === 'afterEach') {
      it('observes cleanup right after afterEach in the same worker', () => {
        writeFileSync(recordFile, JSON.stringify({ ...saved, aliveAfterEach: servicePidAlive(saved.pid), rootAfterEach: existsSync(saved.root) }));
        expect(saved.pid).toBeGreaterThan(1);
      });
    }
  });
}
