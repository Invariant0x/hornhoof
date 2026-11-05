import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { redact } from './redact.js';
import type { JobUser } from './isolation.js';

export interface ServiceCommand { program: string; args: string[]; cwd: string }
interface ServiceBase { id: string; runtime: string; profiles: string[] }
export type ServiceDefinition = ServiceBase & (
  | { driver: 'postgres'; options: { database: string; locale?: string; extensions?: string[] } }
  | { driver: 'process'; options: { start: ServiceCommand; readiness: ServiceCommand; stop: { signal: 'SIGTERM' | 'SIGINT'; graceMs: number }; statePaths: string[] } }
);
export interface ServicePreparation { id: string; serviceIds: string[]; commands: ServiceCommand[] }
export interface ServiceDefinitions { services: ServiceDefinition[]; prepare?: ServicePreparation[] }
export interface ServiceContext {
  nodeOwner: JobUser; jobUser: JobUser; deadline: number; signal: AbortSignal;
  log: (line: string) => void; registerSecrets: (values: string[]) => void;
  env?: Record<string, string>; postgresBin?: string;
}
export interface ServicePrepareContext extends ServiceContext { cacheRoot: string; envKey: string; inputDigest: string }
export interface ServicePartContext extends ServiceContext { attemptRoot: string; checkout: string }
export interface ServiceArtifacts { paths: Record<string, string>; format: 'hornhoof-services-v1'; inputDigest: string }
export interface OpenedServices { env: Record<string, string>; close: () => Promise<void> }

const FORMAT = 'hornhoof-services-v1';
const PG_BIN = '/usr/lib/postgresql/17/bin';
const GRACE_MS = 2000;
const preparationLeases = new WeakMap<ServiceContext, number>();
// This literal runs as the node owner, outside the checkout. Job programs receive only descriptors 0, 1 and 2.
const LEASE_GUARDIAN = String.raw`
const {spawn}=require('node:child_process');
const {readdirSync,readFileSync}=require('node:fs');
let job, completed=false, disconnected=!process.connected, failed=false, code=1, hard, polling;
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
function signal(value) {
  if(!job?.pid)return;
  try{process.kill(-job.pid,value)}catch(error){if(error.code!=='ESRCH')throw error}
}
function alive() {
  try{process.kill(-job.pid,0)}catch(error){if(error.code==='ESRCH')return false;throw error}
  return readdirSync('/proc').filter(name=>/^\d+$/.test(name)).some(name=>{
    try{const stat=readFileSync('/proc/'+name+'/stat','utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return fields[0]!=='Z'&&Number(fields[2])===job.pid}
    catch(error){if(error.code==='ENOENT')return false;throw error}
  });
}
function finish() {
  completed=true;clearTimeout(hard);clearInterval(polling);
  process.stdin.destroy();process.exitCode=failed?1:code;
  if(process.connected)process.send({supervisionFailed:failed},()=>{if(process.connected)process.disconnect()});
}
function reap() {
  try{if(alive())return}catch{failed=true;signal('SIGKILL');return}
  finish();
}
function escalation(graceMs=2000) {
  hard??=setTimeout(()=>{failed=true;signal('SIGKILL')},graceMs);
}
function disconnect() {
  if(completed)return;
  disconnected=true;failed=true;
  if(!job){process.exitCode=1;process.stdin.destroy();if(process.connected)process.disconnect();return}
  signal('SIGTERM');escalation();
}
function control(message) {
  if(message.graceMs!==undefined){clearTimeout(hard);hard=undefined;escalation(message.graceMs)}
  if(job)signal(message.signal);else disconnect();
}
function observeJob() {
  job.stdin.on('error',()=>{});process.stdin.pipe(job.stdin);
  job.stdout.pipe(process.stdout,{end:false});job.stderr.pipe(process.stderr,{end:false});
  job.once('error',error=>{failed=true;process.stderr.write(error.message);});
  job.once('close',()=>{if(!job.pid){failed=true;finish()}});
  job.once('exit',value=>{code=value??1;escalation();polling=setInterval(reap,5);reap()});
}
function start(message) {
  if(job||disconnected||!process.connected)return disconnect();
  job=spawn(message.program,message.args,{cwd:message.cwd,env:message.env,uid:message.uid,gid:message.gid,detached:true,stdio:['pipe','pipe','pipe']});
  observeJob();
  if(disconnected||!process.connected)disconnect();
}
process.on('disconnect',disconnect);
process.on('SIGTERM',disconnect);process.on('SIGINT',disconnect);
process.on('message',message=>{if(message.signal)control(message);else start(message)});
`;
type Postgres = Extract<ServiceDefinition, { driver: 'postgres' }>;
interface Receipt { format: typeof FORMAT; inputDigest: string; definitions: string; runtime: string; checksums: Record<string, string> }
interface ChildResult { code: number | null; output: string }
interface Running { result: Promise<ChildResult>; stop: (signal?: NodeJS.Signals, graceMs?: number) => Promise<void>; assertRunning: () => void }
interface Active extends OpenedServices { state: string }

function check(context: ServiceContext): void {
  context.signal.throwIfAborted();
  if (Date.now() >= context.deadline) throw new Error('Service deadline exceeded');
}
function isolated(context: ServiceContext): void {
  check(context);
  if (context.jobUser.uid === 0 || context.nodeOwner.uid === context.jobUser.uid || process.getuid?.() !== context.nodeOwner.uid) {
    throw new Error('Service capability missing: an isolated unprivileged job UID is required');
  }
}
function safeId(value: string): string {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid service identifier');
  return value;
}
function inside(root: string, path: string): string {
  const target = resolve(root, path);
  if (isAbsolute(path) || target === root || !target.startsWith(resolve(root) + sep)) throw new Error('Service path escapes its root');
  return target;
}
function directory(path: string, context: ServiceContext): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  chownSync(path, context.jobUser.uid, context.jobUser.gid);
}
function ownTree(path: string, context: ServiceContext): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error('Service state cannot contain symlinks');
  chownSync(path, context.jobUser.uid, context.jobUser.gid);
  if (st.isDirectory()) for (const entry of readdirSync(path)) ownTree(join(path, entry), context);
}
function kill(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Service operation cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
function environment(context: ServiceContext, extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', ...context.env, ...extra };
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
function liveGroup(pid: number | undefined): boolean {
  if (!pid || !groupExists(pid)) return false;
  for (const entry of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(join('/proc', entry, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] !== 'Z' && Number(fields[2]) === pid) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}
async function waitGroup(pid: number | undefined, deadline: number): Promise<void> {
  while (liveGroup(pid)) {
    if (Date.now() >= deadline) {
      kill(pid, 'SIGKILL');
      throw new Error('Service required forced stop; state cannot be published');
    }
    await pause(5);
  }
}
function isSupervisionFailure(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'supervisionFailed' in message && message.supervisionFailed === true;
}
function assertGracefulStop(forced: boolean, supervisionFailed: boolean): void {
  if (forced || supervisionFailed) throw new Error('Service required forced stop; state cannot be published');
}
function serviceProcess(program: string, args: string[], cwd: string, env: Record<string, string>, context: ServiceContext) {
  const fd = preparationLeases.get(context);
  const child = fd === undefined
    ? spawn(program, args, { cwd, env: environment(context, env), uid: context.jobUser.uid, gid: context.jobUser.gid, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(process.execPath, ['-e', LEASE_GUARDIAN], { cwd: '/tmp', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, detached: true, stdio: ['pipe', 'pipe', 'pipe', fd, 'ipc'] });
  const send = (message: object) => { if (child.connected) child.send(message, () => { /* A completed guardian may already have closed IPC. */ }); };
  const stopChild = (signal: NodeJS.Signals, graceMs?: number) => { if (fd === undefined) kill(child.pid, signal); else send({ signal, graceMs }); };
  let supervisionFailed = false;
  child.on('message', message => {
    if (isSupervisionFailure(message)) supervisionFailed = true;
  });
  if (fd !== undefined) send({ program, args, cwd, env: environment(context, env), uid: context.jobUser.uid, gid: context.jobUser.gid });
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) throw new Error('Service subprocess pipes are unavailable');
  return { child, stdin, stdout, stderr, stopChild, supervisionFailed: () => supervisionFailed };
}
/* A service stays attached to its process group until close, including cancellation cleanup. SQL travels on stdin. */
function launch(program: string, args: string[], cwd: string, env: Record<string, string>, context: ServiceContext, hidden: string[], input = ''): Running {
  check(context);
  const { child, stdin, stdout, stderr, stopChild, supervisionFailed } = serviceProcess(program, args, cwd, env, context);
  let output = '';
  let failure: Error | undefined;
  let ended = false;
  let interrupted = false;
  let hard: NodeJS.Timeout | undefined;
  let drain: NodeJS.Timeout | undefined;
  const take = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-64 * 1024); };
  stdout.on('data', take); stderr.on('data', take);
  stdin.on('error', () => { /* A failed executable may close stdin before SQL is written. */ });
  stdin.end(input);
  const interrupt = () => {
    interrupted = true;
    stopChild('SIGTERM', GRACE_MS);
    hard ??= setTimeout(() => stopChild('SIGKILL'), GRACE_MS);
  };
  const timer = setTimeout(interrupt, Math.max(1, context.deadline - Date.now()));
  context.signal.addEventListener('abort', interrupt, { once: true });
  if (context.signal.aborted) interrupt();
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.once('error', error => { failure = error; });
    child.once('exit', () => {
      drain = setTimeout(() => {
        failure = new Error('Service descendants kept output open after leader exit');
        stopChild('SIGKILL'); stdout.destroy(); stderr.destroy();
      }, GRACE_MS);
    });
    child.once('close', code => {
      ended = true; clearTimeout(timer); clearTimeout(hard); clearTimeout(drain); context.signal.removeEventListener('abort', interrupt);
      const safe = redact(output, hidden);
      if (safe.trim()) context.log(safe);
      if (interrupted) reject(new Error('Service operation cancelled or deadline exceeded'));
      else if (failure) reject(new Error(redact(failure.message, hidden)));
      else resolve({ code, output: safe });
    });
  });
  /* Long-lived services can exit before readiness observes them. Keep the rejection handled until their owner awaits it. */
  void result.catch(() => undefined);
  let closing: Promise<void> | undefined;
  const stop = (signal: NodeJS.Signals = 'SIGTERM', graceMs = GRACE_MS) => closing ??= (async () => {
    let forced = false;
    const deadline = Date.now() + graceMs;
    stopChild(signal, graceMs);
    if (!ended) {
      const hardStop = setTimeout(() => { forced = true; stopChild('SIGKILL'); }, graceMs);
      try { await result; } catch { /* The original operation reports cancellation. */ }
      finally { clearTimeout(hardStop); }
    }
    await waitGroup(child.pid, deadline);
    assertGracefulStop(forced, supervisionFailed());
  })();
  return { result, stop, assertRunning: () => { if (ended) throw new Error(`Service exited before readiness: ${redact(output, hidden)}`); } };
}
async function command(program: string, args: string[], cwd: string, env: Record<string, string>, context: ServiceContext, hidden: string[], input = ''): Promise<string> {
  const child = launch(program, args, cwd, env, context, hidden, input);
  try {
    const result = await child.result;
    if (result.code !== 0) throw new Error(`Service command failed (${result.code}): ${result.output}`);
    return result.output.trim();
  } finally { await child.stop(); }
}
function cleanupContext(context: ServiceContext): ServiceContext {
  const cleanup = { ...context, signal: new AbortController().signal, deadline: Date.now() + 7000 };
  const fd = preparationLeases.get(context);
  if (fd !== undefined) preparationLeases.set(cleanup, fd);
  return cleanup;
}
async function binaries(context: ServiceContext): Promise<string> {
  const versions: string[] = [];
  for (const name of ['postgres', 'initdb', 'pg_ctl', 'psql']) {
    const program = join(context.postgresBin ?? PG_BIN, name);
    try {
      const version = await command(program, ['--version'], '/tmp', {}, context, []);
      if (!/\(PostgreSQL\) 17(?:\.\d+)*(?:\s|$)/.test(version)) throw new Error('Wrong major');
      versions.push(`${version}:${hash(readFileSync(program))}`);
    } catch (error) {
      if (context.signal.aborted) throw new Error('Service operation cancelled');
      throw new Error(`PostgreSQL 17 is required (${name}): ${String(error)}`);
    }
  }
  return hash(versions.join('\n'));
}
function hash(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function credentials(context: ServiceContext, hidden: string[]): { admin: string; test: string } {
  const admin = randomBytes(24).toString('base64url');
  const test = randomBytes(24).toString('base64url');
  const values = [admin, test];
  context.registerSecrets(values); hidden.push(...values);
  return { admin, test };
}
function sqlName(name: string): string { return '"' + name.replaceAll('"', '""') + '"'; }
function sqlValue(value: string): string { return "'" + value.replaceAll("'", "''") + "'"; }
function pgEnv(socket: string, database: string, password: string): Record<string, string> {
  const url = new URL(`postgresql://postgres:${password}@localhost:5432/${encodeURIComponent(database)}`);
  url.searchParams.set('host', socket);
  return { PGHOST: socket, PGPORT: '5432', PGDATABASE: database, PGUSER: 'postgres', PGPASSWORD: password, DATABASE_URL: url.href };
}
async function sql(text: string, env: Record<string, string>, cwd: string, context: ServiceContext, hidden: string[]): Promise<string> {
  return command(join(context.postgresBin ?? PG_BIN, 'psql'), ['-X', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-f', '-'], cwd, env, context, hidden, text + '\n');
}
function privateSocket(context: ServiceContext): string {
  const socket = mkdtempSync('/tmp/hhpg-');
  directory(socket, context);
  if (Buffer.byteLength(join(socket, '.s.PGSQL.5432')) >= 100) throw new Error('PostgreSQL Unix socket path is too long');
  return socket;
}
function hba(state: string, context: ServiceContext): void {
  writeFileSync(join(state, 'pg_hba.conf'), 'local all all scram-sha-256\n', { mode: 0o600 });
  chownSync(join(state, 'pg_hba.conf'), context.jobUser.uid, context.jobUser.gid);
}
async function ready(server: Running, env: Record<string, string>, cwd: string, context: ServiceContext, hidden: string[]): Promise<void> {
  for (;;) {
    check(context); server.assertRunning();
    try {
      if (await sql('SELECT 1;', env, cwd, context, hidden) !== '1') throw new Error('PostgreSQL readiness query returned an unexpected value');
      server.assertRunning(); return;
    } catch (error) {
      if (!String(error).includes('failed (2)')) throw error;
      await pause(25, context.signal);
    }
  }
}
async function stopPostgres(server: Running, state: string, socket: string, context: ServiceContext, hidden: string[]): Promise<void> {
  let failure: unknown;
  try {
    await command(join(context.postgresBin ?? PG_BIN, 'pg_ctl'), ['-D', state, 'stop', '-m', 'fast', '-w', '-t', '5'], '/tmp', {}, cleanupContext(context), hidden);
  } catch (error) { failure = error; }
  finally { try { await server.stop(); } finally { rmSync(socket, { recursive: true, force: true }); } }
  if (failure) throw failure;
  if (existsSync(join(state, 'postmaster.pid'))) throw new Error('PostgreSQL did not stop cleanly; template cannot be published');
}
function postgresLocale(service: Postgres): string {
  const locale = service.options.locale ?? 'C.UTF-8';
  if (locale !== 'C.UTF-8') throw new Error('PostgreSQL services require the deterministic locale C.UTF-8');
  return locale;
}
async function postgres(service: Postgres, state: string, context: ServiceContext, hidden: string[], fresh: boolean): Promise<Active> {
  const bin = context.postgresBin ?? PG_BIN;
  const locale = postgresLocale(service);
  const passwords = credentials(context, hidden);
  directory(state, context);
  if (fresh) {
    const pwfile = join(dirname(state), `.pw-${randomBytes(8).toString('hex')}`);
    writeFileSync(pwfile, passwords.admin + '\n', { mode: 0o600 }); ownTree(pwfile, context);
    try { await command(join(bin, 'initdb'), ['-D', state, '--username=postgres', `--locale=${locale}`, '--encoding=UTF8', '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', `--pwfile=${pwfile}`], '/tmp', {}, context, hidden); }
    finally { rmSync(pwfile, { force: true }); }
  } else {
    /* Single-user mode rotates stopped-template credentials before a socket can accept any connection. */
    await command(join(bin, 'postgres'), ['--single', '-D', state, 'template1'], '/tmp', {}, context, hidden,
      `SET password_encryption='scram-sha-256';\nALTER ROLE postgres PASSWORD ${sqlValue(passwords.admin)};\nALTER ROLE hornhoof_test PASSWORD ${sqlValue(passwords.test)};\n`);
  }
  hba(state, context);
  const socket = privateSocket(context);
  const env = pgEnv(socket, fresh ? 'postgres' : service.options.database, passwords.admin);
  const server = launch(join(bin, 'postgres'), ['-D', state, '-c', "listen_addresses=", '-c', `unix_socket_directories=${socket}`, '-c', 'unix_socket_permissions=0700', '-c', 'password_encryption=scram-sha-256'], '/tmp', {}, context, hidden);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= stopPostgres(server, state, socket, context, hidden);
  try {
    await ready(server, env, state, context, hidden);
    if (fresh) {
      await sql(`CREATE ROLE hornhoof_test LOGIN PASSWORD ${sqlValue(passwords.test)};\nCREATE DATABASE ${sqlName(service.options.database)};`, env, state, context, hidden);
      Object.assign(env, pgEnv(socket, service.options.database, passwords.admin));
      for (const extension of service.options.extensions ?? []) await sql(`CREATE EXTENSION ${sqlName(extension)};`, env, state, context, hidden);
    }
    return { state, env, close };
  } catch (error) {
    try { await close(); } catch { /* Preserve the readiness error after all children settle. */ }
    throw error;
  }
}

async function managedProcess(service: Extract<ServiceDefinition, { driver: 'process' }>, state: string, checkout: string, context: ServiceContext, hidden: string[]): Promise<Active> {
  directory(state, context);
  for (const path of service.options.statePaths) directory(inside(state, path), context);
  const env = { HH_SERVICE_STATE: state, [`HH_SERVICE_STATE_${service.id.toUpperCase()}`]: state };
  const start = service.options.start;
  const server = launch(start.program, start.args, commandCwd(checkout, start.cwd), env, context, hidden);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= server.stop(service.options.stop.signal, service.options.stop.graceMs);
  try {
    const readiness = service.options.readiness;
    await command(readiness.program, readiness.args, commandCwd(checkout, readiness.cwd), env, context, hidden);
    server.assertRunning();
    return { state, env, close };
  } catch (error) { await close(); throw error; }
}
function commandCwd(checkout: string, cwd: string): string {
  return cwd === '.' ? checkout : inside(checkout, cwd);
}
async function start(service: ServiceDefinition, state: string, checkout: string, context: ServiceContext, hidden: string[], fresh: boolean): Promise<Active> {
  safeId(service.id);
  if (service.driver === 'postgres') return postgres(service, state, context, hidden, fresh);
  return managedProcess(service, state, checkout, context, hidden);
}
async function closeAll(active: Active[]): Promise<void> {
  const results = await Promise.allSettled(active.reverse().map(service => service.close()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Service cleanup failed');
}
function payloadFiles(root: string, prefix = ''): Record<string, string> {
  if (!lstatSync(root).isDirectory()) throw new Error('Unsafe service artifact directory');
  const found: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name); const relative = join(prefix, name); const st = lstatSync(path);
    if (st.isDirectory()) Object.assign(found, payloadFiles(path, relative));
    else if (st.isFile() && st.nlink === 1) found[relative] = hash(readFileSync(path));
    else throw new Error('Unsafe service artifact: symlink, hardlink or special file');
  }
  return found;
}
function fsyncTree(path: string): void {
  const st = lstatSync(path);
  if (st.isDirectory()) for (const name of readdirSync(path)) fsyncTree(join(path, name));
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function receipt(root: string): Receipt {
  return JSON.parse(readFileSync(join(root, 'READY.json'), 'utf8')) as Receipt;
}
function validateArtifacts(root: string, definitions: ServiceDefinitions, inputDigest: string, runtime: string): void {
  const ready = receipt(root);
  if (ready.format !== FORMAT || ready.inputDigest !== inputDigest || ready.definitions !== hash(JSON.stringify(definitions)) || ready.runtime !== runtime) throw new Error('Service artifact integrity metadata mismatch');
  if (JSON.stringify(ready.checksums) !== JSON.stringify(payloadFiles(join(root, 'payload')))) throw new Error('Service artifact checksum mismatch');
}
function artifactPaths(root: string, definitions: ServiceDefinitions): Record<string, string> {
  return Object.fromEntries(definitions.services.map(service => [safeId(service.id), join(root, 'payload', service.id)]));
}
async function runtime(definitions: ServiceDefinitions, context: ServiceContext): Promise<string> {
  return definitions.services.some(service => service.driver === 'postgres') ? binaries(context) : 'process-v1';
}
function lockDescriptor(fd: number, context: ServiceContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['--exclusive', '3'], {
      cwd: '/tmp', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'pipe', fd],
    });
    let failure: Error | undefined;
    let output = '';
    child.stderr!.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4096); });
    const interrupt = () => {
      failure = new Error('Service lock cancelled or deadline exceeded');
      child.kill('SIGKILL');
    };
    const timer = setTimeout(interrupt, Math.max(1, context.deadline - Date.now()));
    context.signal.addEventListener('abort', interrupt, { once: true });
    if (context.signal.aborted) interrupt();
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer); context.signal.removeEventListener('abort', interrupt);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Service lock acquisition failed: ${output}`));
      else resolve();
    });
  });
}
async function acquire(path: string, context: ServiceContext): Promise<{ fd: number; release: () => void }> {
  check(context);
  if (existsSync(path) && lstatSync(path).isDirectory()) {
    throw new Error('Legacy directory service lock has no owner information. Remove it only after confirming that the node and all its writers have stopped.');
  }
  // flock and this process share one open file description. Keep the inode when releasing it.
  const fd = openSync(path, 'a', 0o600);
  try { await lockDescriptor(fd, context); check(context); }
  catch (error) { closeSync(fd); throw error; }
  return { fd, release: () => closeSync(fd) };
}
async function prepareCommands(definitions: ServiceDefinitions, checkout: string, env: Record<string, string>, context: ServiceContext, hidden: string[]): Promise<void> {
  for (const unit of definitions.prepare ?? []) {
    if (!unit.serviceIds.every(id => definitions.services.some(service => service.id === id))) throw new Error('Preparation references an unavailable service');
    for (const step of unit.commands) await command(step.program, step.args, commandCwd(checkout, step.cwd), env, context, hidden);
  }
}
function copyDeclaredState(service: ServiceDefinition, source: string, destination: string): void {
  if (service.driver === 'postgres') {
    cpSync(source, destination, { recursive: true, dereference: false, errorOnExist: true });
    return;
  }
  mkdirSync(destination, { mode: 0o700 });
  for (const path of service.options.statePaths) {
    const target = inside(destination, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(inside(source, path), target, { recursive: true, dereference: false, errorOnExist: true });
  }
}
async function buildArtifacts(definitions: ServiceDefinitions, checkout: string, root: string, context: ServicePrepareContext, fingerprint: string): Promise<void> {
  const work = mkdtempSync('/tmp/hhsp-'); directory(work, context);
  const stage = `${root}.staging-${randomBytes(8).toString('hex')}`;
  const active: Active[] = []; const hidden: string[] = [];
  try {
    for (const service of definitions.services) active.push(await start(service, join(work, safeId(service.id)), checkout, context, hidden, true));
    await prepareCommands(definitions, checkout, Object.assign({}, ...active.map(service => service.env)) as Record<string, string>, context, hidden);
    await closeAll(active); active.length = 0;
    check(context);
    mkdirSync(join(stage, 'payload'), { recursive: true, mode: 0o700 });
    for (const service of definitions.services) {
      const source = join(work, service.id);
      payloadFiles(source);
      copyDeclaredState(service, source, join(stage, 'payload', service.id));
    }
    const ready: Receipt = { format: FORMAT, inputDigest: context.inputDigest, definitions: hash(JSON.stringify(definitions)), runtime: fingerprint, checksums: payloadFiles(join(stage, 'payload')) };
    writeFileSync(join(stage, 'READY.json'), JSON.stringify(ready), { mode: 0o600 });
    fsyncTree(stage); check(context); renameSync(stage, root);
    const parent = openSync(dirname(root), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    try { await closeAll(active); } finally { rmSync(work, { recursive: true, force: true }); rmSync(stage, { recursive: true, force: true }); }
  }
}

export async function prepareServiceArtifacts(definitions: ServiceDefinitions, checkout: string, context: ServicePrepareContext): Promise<ServiceArtifacts> {
  check(context);
  if (!definitions.services.length) return { paths: {}, format: FORMAT, inputDigest: context.inputDigest };
  isolated(context);
  if (!/^[a-f0-9]{64}$/.test(context.envKey)) throw new Error('Invalid service environment key');
  const fingerprint = await runtime(definitions, context);
  mkdirSync(context.cacheRoot, { recursive: true, mode: 0o700 }); chmodSync(context.cacheRoot, 0o700);
  const root = join(context.cacheRoot, context.envKey);
  const lease = await acquire(`${root}.lock`, context);
  preparationLeases.set(context, lease.fd);
  try {
    if (!existsSync(join(root, 'READY.json'))) await buildArtifacts(definitions, checkout, root, context, fingerprint);
    validateArtifacts(root, definitions, context.inputDigest, fingerprint);
    return { paths: artifactPaths(root, definitions), format: FORMAT, inputDigest: context.inputDigest };
  } finally { preparationLeases.delete(context); lease.release(); }
}
async function validateForOpen(definitions: ServiceDefinitions, artifacts: ServiceArtifacts, context: ServiceContext): Promise<void> {
    if (artifacts.format !== FORMAT || Object.keys(artifacts.paths).length !== definitions.services.length) throw new Error('Service artifact integrity metadata mismatch');
    const first = Object.values(artifacts.paths)[0];
    if (first) {
      const root = dirname(dirname(first));
      validateArtifacts(root, definitions, artifacts.inputDigest, await runtime(definitions, context));
      if (JSON.stringify(artifacts.paths) !== JSON.stringify(artifactPaths(root, definitions))) throw new Error('Service artifact path mismatch');
    }
}
export async function openServices(definitions: ServiceDefinitions, artifacts: ServiceArtifacts, partContext: ServicePartContext): Promise<OpenedServices> {
  check(partContext);
  if (!definitions.services.length) return { env: {}, close: () => Promise.resolve() };
  isolated(partContext);
  const active: Active[] = []; const hidden: string[] = [];
  const state = join(partContext.attemptRoot, 'state');
  let ownsState = false;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { try { await closeAll(active); } finally { if (ownsState) rmSync(state, { recursive: true, force: true }); } })();
  try {
    await validateForOpen(definitions, artifacts, partContext);
    if (existsSync(state)) throw new Error('Attempt service state already exists');
    directory(partContext.attemptRoot, partContext);
    mkdirSync(state, { mode: 0o700 }); ownsState = true; directory(state, partContext);
    for (const service of definitions.services) {
      const destination = join(state, safeId(service.id));
      cpSync(artifacts.paths[service.id]!, destination, { recursive: true, dereference: false, errorOnExist: true });
      ownTree(destination, partContext);
      active.push(await start(service, destination, partContext.checkout, partContext, hidden, false));
    }
    return { env: Object.assign({}, ...active.map(service => service.env)) as Record<string, string>, close };
  } catch (error) {
    try { await close(); } catch { /* Preserve the opening error after all service groups are stopped. */ }
    throw error;
  }
}
