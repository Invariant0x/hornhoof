import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
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
  executable('postgres', `${common} if(a.includes('--single')) {process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));} else { const dir=a[a.indexOf('-D')+1]; fs.writeFileSync(p.join(dir,'postmaster.pid'),String(process.pid)); process.on('SIGTERM',()=>{fs.unlinkSync(p.join(dir,'postmaster.pid'));process.exit(0)}); setInterval(()=>{},100); }`);
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
  it('rejects modified immutable payload before opening a server', async () => {
    const artifacts = await prep();
    writeFileSync(join(artifacts.paths.pg!, 'PG_VERSION'), '16');
    await expect(openServices(definitions, artifacts, part('bad'))).rejects.toThrow(/checksum|integrity/);
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
    const child = "const fs=require('node:fs'),p=require('node:path');const d=p.join(process.env.HH_SERVICE_STATE,'data');process.on('SIGINT',()=>setTimeout(()=>{fs.writeFileSync(p.join(d,'child-stopped'),'yes');process.exit(0)},500));fs.writeFileSync(p.join(d,'child-ready'),'yes');setInterval(()=>{},100)";
    executable('service', `const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');const d=p.join(process.env.HH_SERVICE_STATE,'data');fs.mkdirSync(d,{recursive:true});cp.spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});const t=setInterval(()=>{if(fs.existsSync(p.join(d,'child-ready'))){clearInterval(t);fs.writeFileSync(p.join(d,'value'),'ready')}},5);process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},100);`);
    const artifacts = await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'c'.repeat(64), inputDigest: 'b'.repeat(64) });
    expect(readFileSync(join(artifacts.paths.worker!, 'data', 'child-stopped'), 'utf8')).toBe('yes');
  });
  it('stops earlier services when a later readiness command fails', async () => {
    const defs = processDefinitions();
    defs.services.unshift(definitions.services[0]!);
    const artifacts = await prepareServiceArtifacts(defs, root, { ...context, cacheRoot: join(root, 'cache'), envKey: 'e'.repeat(64), inputDigest: 'f'.repeat(64) });
    await expect(openServices(defs, artifacts, { ...part('partial'), env: { BAD_READY: '1' } })).rejects.toThrow(/failed/);
    expect(existsSync(join(root, 'runs', 'partial', 'state'))).toBe(false);
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
      const reportFile = join(root, 'selected-run.json');
      const args = run.args.flatMap(arg => arg === 'run' ? ['run', '--reporter=json', `--outputFile=${reportFile}`] : [arg]);
      await promisify(execFile)(run.program, [...args, selected], { cwd: join(checkout, run.cwd), timeout: 18000 });
      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { numTotalTests: number; testResults: { name: string }[] };
      expect(report.testResults.map(file => file.name)).toEqual([join(checkout, expected)]);
      expect(report.numTotalTests).toBeGreaterThan(0);
    }
  });
});
