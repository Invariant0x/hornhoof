import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openServices, prepareServiceArtifacts, type ServiceCommand, type ServiceContext, type ServiceDefinitions } from '../src/test-services.js';

const procVisibility = vi.hoisted(() => ({ readable: true }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: new Proxy(actual.readdirSync, { apply(target, receiver, args) {
    if (args[0] === '/proc' && !procVisibility.readable) throw Object.assign(new Error('Unrelated process inventory is unavailable'), { code: 'EACCES' });
    return Reflect.apply(target, receiver, args);
  } }) };
});

const roots: string[] = [];
let root: string;
let bin: string;
let log: string[];
let secrets: string[];
let context: ServiceContext;
const definitions: ServiceDefinitions = {
  services: [{ id: 'pg', driver: 'postgres', runtime: 'postgres', profiles: ['final'], options: { database: 'hornhoof', locale: 'C.UTF-8', extensions: [] } }],
  prepare: [],
};

function executable(name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
}

function fakePostgres(): void {
  const common = `const fs=require('node:fs'); const p=require('node:path'); const a=process.argv.slice(2); if(a.includes('--version')) { console.log(p.basename(process.argv[1])+' (PostgreSQL) 17.4'); process.exit(0); }`;
  executable('initdb', `${common} if(process.env.INIT_MARKER) fs.appendFileSync(process.env.INIT_MARKER,'init\\n'); const dir=a[a.indexOf('-D')+1]; fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(p.join(dir,'PG_VERSION'),'17'); fs.writeFileSync(p.join(dir,'pg_hba.conf'),''); fs.writeFileSync(p.join(dir,'postgresql.conf'),'');`);
  executable('postgres', `${common} if(a.includes('--single')) {const swap=p.join(p.dirname(process.argv[1]),'link-hba-to'); if(fs.existsSync(swap)){const hba=p.join(a[a.indexOf('-D')+1],'pg_hba.conf'); fs.rmSync(hba); fs[fs.existsSync(swap+'.hard')?'linkSync':'symlinkSync'](fs.readFileSync(swap,'utf8'),hba);} process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));} else { const dir=a[a.indexOf('-D')+1]; fs.writeFileSync(p.join(dir,'postmaster.pid'),String(process.pid)); process.on('SIGTERM',()=>{fs.unlinkSync(p.join(dir,'postmaster.pid'));process.exit(0)}); setInterval(()=>{},100); }`);
  executable('pg_ctl', `${common} const dir=a[a.indexOf('-D')+1]; const file=p.join(dir,'postmaster.pid'); if(fs.existsSync(file)) process.kill(Number(fs.readFileSync(file,'utf8')),'SIGTERM');`);
  executable('psql', `${common} let input=''; process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{if(process.env.SOCKET_TRACE) fs.writeFileSync(process.env.SOCKET_TRACE,process.env.PGHOST); if(process.env.FAIL_SQL==='1') {console.error('SQL failed '+process.env.PGPASSWORD);process.exit(9)} console.log(input.includes('SELECT 1')?'1':'OK');});`);
}

beforeEach(() => {
  procVisibility.readable = true;
  root = mkdtempSync(join(tmpdir(), 'hh-services-test-'));
  roots.push(root);
  bin = join(root, 'bin'); mkdirSync(bin);
  log = []; secrets = [];
  const uid = process.getuid!(); const gid = process.getgid!();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  context = { nodeOwner: { uid: 0, gid: 0 }, jobUser: { uid, gid }, signal: new AbortController().signal,
    deadline: Date.now() + 15_000, log: line => log.push(line), registerSecrets: values => secrets.push(...values), postgresBin: bin };
  fakePostgres();
});
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
    await expect(prepareServiceArtifacts(definitions, root, { ...context, env: { SOCKET_TRACE: trace }, cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64) })).rejects.toThrow(/stop|cleanup|failed/i);
    expect(existsSync(readFileSync(trace, 'utf8'))).toBe(false);
    expect(existsSync(join(root, 'cache', 'a'.repeat(64), 'READY.json'))).toBe(false);
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
  function processDefinitions(graceMs = 100): ServiceDefinitions {
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
    expect(opened.env.HH_SERVICE_STATE).toContain(join('runs', 'process', 'state', 'worker'));
    await opened.close();
    expect(existsSync(opened.env.HH_SERVICE_STATE!)).toBe(false);
  });
  it('waits for descendant writers before snapshotting declared process state', async () => {
    const defs = processDefinitions(1000);
    const child = "const fs=require('node:fs'),p=require('node:path');const d=p.join(process.env.HH_SERVICE_STATE,'data');process.on('SIGINT',()=>setTimeout(()=>{fs.writeFileSync(p.join(d,'child-stopped'),'yes');if(process.env.CHILD_STOP_MARKER)fs.writeFileSync(process.env.CHILD_STOP_MARKER,'yes');process.exit(0)},500));fs.writeFileSync(p.join(d,'child-ready'),'yes');if(process.env.CHILD_STOP_MARKER)fs.writeFileSync(process.env.CHILD_STOP_MARKER+'.ready','yes');setInterval(()=>{},100)";
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
  it('stops earlier services when a later readiness command fails', async () => {
    const defs = processDefinitions();
    defs.services.unshift(definitions.services[0]!);
    const artifacts = await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'e'.repeat(64), inputDigest: 'f'.repeat(64) });
    await expect(openServices(defs, artifacts, { ...part('partial'), env: { BAD_READY: '1' } })).rejects.toThrow(/failed/);
    expect(existsSync(join(root, 'runs', 'partial', 'state'))).toBe(false);
  });
  it('honors a longer stop grace while descendants flush prepared state', async () => {
    const defs = processDefinitions(5000);
    const child = "const fs=require('node:fs'),p=require('node:path');const d=p.join(process.env.HH_SERVICE_STATE,'data');process.on('SIGINT',()=>setTimeout(()=>{fs.writeFileSync(p.join(d,'flushed'),'yes');process.exit(0)},3000));fs.writeFileSync(p.join(d,'child-ready'),'yes');setInterval(()=>{},100)";
    executable('service', `const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');const d=p.join(process.env.HH_SERVICE_STATE,'data');fs.mkdirSync(d,{recursive:true});cp.spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{if(fs.existsSync(p.join(d,'child-ready')))fs.writeFileSync(p.join(d,'value'),'ready')},5);process.on('SIGINT',()=>process.exit(0));`);
    const artifact = await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'd'.repeat(64) });
    expect(readFileSync(join(artifact.paths.worker!, 'data', 'flushed'), 'utf8')).toBe('yes');
  });
  it('never publishes state after the guardian forcibly stops a descendant', async () => {
    const defs = processDefinitions(5000);
    const child = "const fs=require('node:fs'),p=require('node:path');process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});fs.writeFileSync(p.join(process.env.HH_SERVICE_STATE,'data','child-ready'),'yes');setInterval(()=>{},100)";
    executable('service', `const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');const d=p.join(process.env.HH_SERVICE_STATE,'data');fs.mkdirSync(d,{recursive:true});cp.spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{if(fs.existsSync(p.join(d,'child-ready'))){fs.writeFileSync(p.join(d,'value'),'ready');process.exit(0)}},5);`);
    defs.prepare = [{ id: 'after-drain', serviceIds: ['worker'], commands: [{ program: process.execPath, args: ['-e', 'setTimeout(()=>{},3000)'], cwd: '.' }] }];
    await expect(prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'd'.repeat(64) })).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'Service required forced stop; state cannot be published' })],
    });
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
      stop: { signal: 'SIGINT', graceMs: 1000 }, statePaths: ['data'],
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
    const script = `import {prepareServiceArtifacts} from ${JSON.stringify(new URL('../src/test-services.ts', import.meta.url).href)};process.getuid=()=>0;const context=${JSON.stringify(ctx)};context.signal=new AbortController().signal;context.deadline=Date.now()+15000;context.log=()=>{};context.registerSecrets=()=>{};context.env.OWNER_PID=String(process.pid);await prepareServiceArtifacts(${JSON.stringify(defs)},${JSON.stringify(root)},context);`;
    const watcher = watch(root);
    const entered = new Promise<void>(resolve => watcher.on('change', () => { if (existsSync(ctx.env.ENTERED)) resolve(); }));
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('../../..', import.meta.url)), stdio: 'ignore' });
    const ended = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    try {
      await Promise.race([entered, ended.then(([code, signal]) => { throw new Error(`Owner exited before preparation: ${code ?? signal}`); })]);
      return { child, ended };
    } catch (error) { child.kill('SIGKILL'); await ended; throw error;
    } finally { watcher.close(); }
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
      const recovered = await prepareServiceArtifacts(defs, root, { ...preparationContext('recovered'), deadline: Date.now() + 2500 });
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
      await expect(prepareServiceArtifacts(defs, root, { ...preparationContext('contender'), deadline: Date.now() + 1000 })).rejects.toThrow(/deadline/i);
      expect(readFileSync(join(root, 'workers'), 'utf8').trim().split('\n')).toHaveLength(1);
      expect(existsSync(join(root, 'cache', key, 'READY.json'))).toBe(false);
      stopWorkers(); rmSync(join(root, 'hold'));
      const recovered = await prepareServiceArtifacts(defs, root, { ...preparationContext('recovered'), deadline: Date.now() + 2500 });
      expect(existsSync(join(recovered.paths.worker!, 'data'))).toBe(true);
    } finally { running.child.kill('SIGKILL'); await running.ended; stopWorkers(); }
  });
  it.each(['deadline', 'cancellation'])('does not steal a live owner lock or publish a second template after %s', async mode => {
    const defs = fixture();
    const running = await owner(defs);
    const controller = new AbortController();
    const timer = setTimeout(() => { if (mode === 'cancellation') controller.abort(); }, 100);
    try {
      await expect(prepareServiceArtifacts(defs, root, { ...preparationContext('contender'), signal: controller.signal,
        deadline: Date.now() + (mode === 'deadline' ? 300 : 2500) })).rejects.toThrow(/deadline|cancel/i);
      expect(readFileSync(join(root, 'workers'), 'utf8').trim().split('\n')).toHaveLength(1);
      expect(existsSync(join(root, 'cache', key, 'READY.json'))).toBe(false);
      rmSync(join(root, 'hold'));
      expect((await running.ended)[0]).toBe(0);
      const artifact = await prepareServiceArtifacts(defs, root, preparationContext('hit'));
      expect(existsSync(join(artifact.paths.worker!, 'data'))).toBe(true);
      expect(readFileSync(join(root, 'workers'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { clearTimeout(timer); running.child.kill('SIGKILL'); await running.ended; stopWorkers(); }
  });
  it('rejects ownerless legacy directory locks without changing them', async () => {
    const defs = fixture();
    const lock = join(root, 'cache', `${key}.lock`);
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    const inode = statSync(lock).ino;
    try {
      await expect(prepareServiceArtifacts(defs, root, { ...preparationContext('legacy'), deadline: Date.now() + 2500 })).rejects.toThrow(/legacy.*directory.*lock/i);
      expect(statSync(lock).ino).toBe(inode);
      expect(existsSync(join(root, 'workers'))).toBe(false);
      expect(existsSync(join(root, 'cache', key, 'READY.json'))).toBe(false);
    } finally { stopWorkers(); }
  });
});

async function pgliteProbe(body: string): Promise<Record<string, boolean | number>> {
  const script = `
    import assert from 'node:assert/strict';
    import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {PGlite} from '@electric-sql/pglite';
    import {preparePgliteTemplate,readPgliteTemplate} from './apps/server/test/prepare-environment.ts';
    import setup from './apps/server/test/global-setup.ts';
    process.stderr.write('probe-start\\n');
    const path=process.argv[1]; const started=Date.now();
    const provided=[]; const project={provide:(_,value)=>provided.push(value)};
    process.env.HH_PGLITE_TEMPLATE=path;
    ${body}
  `;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, join(root, 'pglite')], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)), timeout: 18000, killSignal: 'SIGKILL',
  });
  return JSON.parse(result.stdout) as Record<string, boolean | number>;
}
describe('prepared PGlite compatibility', () => {
  it('copies a validated migrated dump and rejects stale metadata or changed bytes', async () => {
    const measured = await pgliteProbe(`
      process.stderr.write('prepare-start\\n');
      await preparePgliteTemplate(path);
      process.stderr.write('prepare-done\\n');
      const bytes=readPgliteTemplate(path); assert(Buffer.isBuffer(bytes));
      process.stderr.write('setup-start\\n');
      const cleanup=await setup(project);
      process.stderr.write('setup-done\\n');
      try {assert(readFileSync(provided[0]).equals(bytes)); assert(!provided[0].startsWith(path));} finally {cleanup();}
      const file=join(path,'READY.json'); const metadata=JSON.parse(readFileSync(file,'utf8'));
      writeFileSync(file,JSON.stringify({...metadata,pgliteVersion:'0.0.0'})); assert.equal(readPgliteTemplate(path),null);
      writeFileSync(file,JSON.stringify({...metadata,inputDigest:'0'.repeat(64)})); assert.equal(readPgliteTemplate(path),null);
      writeFileSync(file,JSON.stringify(metadata)); writeFileSync(join(path,'migrated.tar'),'corrupt'); assert.equal(readPgliteTemplate(path),null);
      process.stdout.write(JSON.stringify({validCopy:true,staleRejected:true,bytes:bytes.length,elapsedMs:Date.now()-started}));
    `);
    expect(measured).toMatchObject({ validCopy: true, staleRejected: true });
    expect(measured.bytes).toBeGreaterThan(0);
  });
  it('falls back to standalone migrations when the optional artifact is corrupt', async () => {
    const measured = await pgliteProbe(`
      mkdirSync(path); writeFileSync(join(path,'READY.json'),'{}'); writeFileSync(join(path,'migrated.tar'),'corrupt');
      process.stderr.write('setup-start\\n');
      const cleanup=await setup(project);
      process.stderr.write('setup-done\\n');
      try {
        const client=new PGlite({loadDataDir:new Blob([readFileSync(provided[0])])});
        try {assert(Number((await client.query('SELECT count(*) AS n FROM drizzle.__drizzle_migrations')).rows[0].n)>0);} finally {await client.close();}
      } finally {cleanup();}
      process.stdout.write(JSON.stringify({fallback:true,elapsedMs:Date.now()-started}));
    `);
    expect(measured.fallback).toBe(true);
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
    expect(opened.env).toEqual({});
    await opened.close();
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
    await promisify(execFile)(run.program, [...list, selected], { cwd: join(checkout, run.cwd), timeout: 18000 });
    const files = JSON.parse(readFileSync(inventory, 'utf8')) as { file: string }[];
    expect(files.map(file => file.file)).toEqual([join(checkout, expected)]);
    if (id === 'node') {
      const reportFile = join(root, 'selected-run.json'), filesFile = join(root, 'selected-files.json');
      writeFileSync(filesFile, JSON.stringify([`./${expected}`]));
      const args = run.args.flatMap(arg => arg === 'run' ? ['run', '--reporter=json', `--outputFile=${reportFile}`, '--shard=1/1'] : [arg]);
      await promisify(execFile)(run.program, [...args, selected], { cwd: join(checkout, run.cwd), timeout: 18000, env: { ...process.env, HH_TEST_FILES: filesFile } });
      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { numTotalTests: number; testResults: { name: string }[] };
      expect(report.testResults.map(file => file.name)).toEqual([join(checkout, expected)]);
      expect(report.numTotalTests).toBeGreaterThan(0);
    }
  });
});

async function generatedProtocolProbe(body: string): Promise<void> {
  const { cpSync, symlinkSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const checkout = fileURLToPath(new URL('../../..', import.meta.url));
  const fixture = join(root, 'generated-protocol');
  for (const path of [
    'package.json', 'package-lock.json', 'tsconfig.base.json', 'apps/server/package.json', 'apps/server/drizzle',
    'apps/server/src/db', 'apps/server/test/prepare-environment.ts', 'apps/server/test/global-setup.ts',
    'packages/protocol/package.json', 'packages/protocol/dist',
  ]) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    cpSync(join(checkout, path), join(fixture, path), { recursive: true });
  }
  symlinkSync(join(checkout, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  mkdirSync(join(fixture, 'apps/server/node_modules/@hornhoof'), { recursive: true });
  symlinkSync(join(fixture, 'packages/protocol'), join(fixture, 'apps/server/node_modules/@hornhoof/protocol'), 'dir');
  const script = `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {preparePgliteTemplate,readPgliteTemplate} from './apps/server/test/prepare-environment.ts';
    const output=join(process.cwd(),'template'), dist=join(process.cwd(),'packages/protocol/dist'), file=join(dist,'index.js');
    const original=readFileSync(file);
    await preparePgliteTemplate(output);
    assert(Buffer.isBuffer(readPgliteTemplate(output)));
    ${body}
  `;
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: fixture, timeout: 18000, killSignal: 'SIGKILL' });
}

describe('generated protocol inputs in prepared PGlite templates', () => {
  it('hashes actual generated bytes and accepts the same bytes after a rebuild', async () => {
    await generatedProtocolProbe(`
      const metadata=JSON.parse(readFileSync(join(output,'READY.json'),'utf8'));
      assert.equal(metadata.inputs['packages/protocol/dist/index.js'],createHash('sha256').update(original).digest('hex'));
      writeFileSync(file,Buffer.concat([original,Buffer.from('\\n// changed generated bytes\\n')]));
      assert(readPgliteTemplate(output)===null,'Changed generated protocol bytes must invalidate the template');
      rmSync(file); writeFileSync(file,original);
      assert(Buffer.isBuffer(readPgliteTemplate(output)),'The same generated bytes after rebuilding must keep the template valid');
      mkdirSync(join(dist,'nested')); writeFileSync(join(dist,'nested','extra.js'),'export const extra = 1;\\n');
      assert(readPgliteTemplate(output)===null,'New nested generated bytes must invalidate the template');
      rmSync(join(dist,'nested'),{recursive:true});
      assert(Buffer.isBuffer(readPgliteTemplate(output)));
    `);
  });
  it('fails preparation explicitly for absent or empty generated output', async () => {
    await generatedProtocolProbe(`
      rmSync(dist,{recursive:true});
      await assert.rejects(preparePgliteTemplate(join(process.cwd(),'absent')),/Missing required generated protocol artifact: packages\\/protocol\\/dist/);
      mkdirSync(dist);
      await assert.rejects(preparePgliteTemplate(join(process.cwd(),'empty')),/Missing required generated protocol artifact: packages\\/protocol\\/dist/);
      assert(readPgliteTemplate(output)===null,'Missing generated bytes must reject the optional template');
    `);
  });
});
