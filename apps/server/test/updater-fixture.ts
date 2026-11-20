import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, onTestFinished } from 'vitest';
import { eventually } from '../../../test-support/eventually.mjs';

/* What the tests of the updater share: a server folder of its own, and one pass of updater.sh over it with stub docker and curl. */

export const SCRIPT = fileURLToPath(new URL('../../updater/updater.sh', import.meta.url));
/* The parts updater.sh is made of, in lib next to it. */
export const PARTS = fileURLToPath(new URL('../../updater/lib/', import.meta.url));
const REV1 = fileURLToPath(new URL('./updater-rev1.sh', import.meta.url));
const STUBS = fileURLToPath(new URL('./updater-stubs/', import.meta.url));
/* The statements of a restore, which the updater's image keeps next to it. */
export const SQL = fileURLToPath(new URL('../../updater/', import.meta.url));
/* The updater reads and writes its files with jq, so these tests take the jq of this machine, wherever it is. */
export const JQ = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
const TOOLS = mkdtempSync(join(tmpdir(), 'hh-updater-tools-'));
if (JQ) symlinkSync(JQ, join(TOOLS, 'jq'));

const stands = new Set<string>();
const activeChildren = new Set<ChildProcess>();

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (!existsSync('/proc')) return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ESRCH';
  }
}

export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* Process or group has already exited. */
    }
  }
}

function updaterGroupAlive(pgid: number | undefined): boolean {
  if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (!existsSync('/proc')) return true;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] !== 'Z' && Number(fields[2]) === pgid) return true;
    } catch {
      /* Process exited while scanning /proc. */
    }
  }
  return false;
}

function emergencyCleanup(): void {
  for (const child of activeChildren) killProcessGroup(child.pid);
  activeChildren.clear();
  for (const dir of stands) rmSync(dir, { recursive: true, force: true });
  stands.clear();
  rmSync(TOOLS, { recursive: true, force: true });
}

export async function cleanupUpdaterRuns(): Promise<void> {
  const children = [...activeChildren];
  activeChildren.clear();
  for (const child of children) killProcessGroup(child.pid);
  await Promise.allSettled(
    children.map(child => (child.exitCode === null && child.signalCode === null ? once(child, 'close') : Promise.resolve())),
  );
  await eventually(() => children.every(child => !updaterGroupAlive(child.pid)));
  for (const dir of stands) rmSync(dir, { recursive: true, force: true });
  stands.clear();
}

process.once('exit', () => emergencyCleanup());
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(signal, () => {
    const last = process.listenerCount(signal) === 0;
    emergencyCleanup();
    if (last) process.kill(process.pid, signal);
  });
}

try {
  afterEach(cleanupUpdaterRuns);
} catch {
  /* Standalone probe scripts import this module outside a Vitest suite and rely on process exit hooks. */
}

export function tempUpdaterDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  stands.add(dir);
  return dir;
}

export type Stand = { dir: string; control: string; computerControl: string; server: string; log: string };

/* The digest of each build as the registry has it now, and of the node and updater images made with it. The app asks
   for the build it read and for those images, by digest. */
export const APP = 'ghcr.io/invariant0x/hornhoof';
export const DIGESTS: Record<string, string> = { '0.4.0': `sha256:${'a'.repeat(64)}`, '0.4.1': `sha256:${'b'.repeat(64)}` };
export const NODE_DIGESTS: Record<string, string> = { '0.4.0': `sha256:${'c'.repeat(64)}`, '0.4.1': `sha256:${'d'.repeat(64)}` };
export const UPDATER_DIGESTS: Record<string, string> = { '0.4.0': `sha256:${'e'.repeat(64)}`, '0.4.1': `sha256:${'f'.repeat(64)}` };
export const ask = (id: string) => ({ id, version: '0.4.1', tag: '0.4.1', digest: DIGESTS['0.4.1'], nodeDigest: NODE_DIGESTS['0.4.1'], updaterDigest: UPDATER_DIGESTS['0.4.1'] });
/* The exact images of a build, as compose and the installer get them. */
export const refs = (tag: string) => `HORNHOOF_APP_REF=${APP}@${DIGESTS[tag]} HORNHOOF_NODE_REF=${APP}-node@${NODE_DIGESTS[tag]} HORNHOOF_UPDATER_REF=${APP}-updater@${UPDATER_DIGESTS[tag]}`;

export function stand(env = 'HORNHOOF_SECRET=s\nHORNHOOF_VERSION=0.4.0\n'): Stand {
  const dir = tempUpdaterDir('hh-updater-');
  const control = join(dir, 'control');
  const computerControl = join(dir, 'computer-control');
  const server = join(dir, 'srv');
  mkdirSync(control);
  mkdirSync(computerControl);
  mkdirSync(server);
  writeFileSync(join(server, '.env'), env);
  writeFileSync(join(dir, 'running'), 'aaa');
  writeFileSync(join(dir, 'migrations'), '20');
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  return { dir, control, computerControl, server, log };
}

export async function runUpdater(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const child = spawn('bash', [SCRIPT, ...args], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${STUBS}:${TOOLS}:/usr/bin:/bin`,
      STUB_OWNER: String(process.pid),
      ...env,
    },
  });
  return finished(child);
}

/* Waits for a run to exit, then ends whatever it left behind in its process group and waits until that is gone too, so
   no stub of one test still runs in the next. */
async function finished(child: ChildProcess & { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream }): Promise<{ code: number | null; out: string }> {
  activeChildren.add(child);
  let stdout = '';
  let stderr = '';
  let closed = false;
  const closeDone = once(child, 'close').then(() => {
    closed = true;
  });
  child.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text));
  child.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text));
  try {
    const [code] = (await once(child, 'exit')) as [number | null];
    killProcessGroup(child.pid);
    if (!closed) await closeDone;
    await eventually(() => !updaterGroupAlive(child.pid));
    return { code, out: stdout + stderr };
  } finally {
    killProcessGroup(child.pid);
    activeChildren.delete(child);
    await eventually(() => !updaterGroupAlive(child.pid));
  }
}

/* One run of an updater script, with stub docker and curl first on PATH, and its own temporary files in the stand. It
   takes as long as it takes: only the runner's limit for the test ends one that never ends. */
const standEnv = (s: Stand, env: Record<string, string>) => ({
  TMPDIR: s.dir,
  PATH: `${STUBS}:${TOOLS}:/usr/bin:/bin`,
  HOME: s.dir,
  STUB_OWNER: String(process.pid),
  STUB_LOG: s.log,
  STUB_STATE: s.dir,
  STUB_COMMITS: '0.4.0=aaa 0.4.1=bbb',
  STUB_MIGRATIONS: '0.4.0=20 0.4.1=20',
  STUB_DIGESTS: Object.entries(DIGESTS).map(([tag, digest]) => `${tag}=${digest}`).join(' '),
  STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.0']} node=${APP}-node@${NODE_DIGESTS['0.4.0']} updater=${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`,
  HORNHOOF_CONTROL_DIR: s.control,
  HORNHOOF_COMPUTER_CONTROL_DIR: s.computerControl,
  HORNHOOF_SERVER_DIR: s.server,
  /* A machine whose installer wrote its system down, as every machine set up by this build has: a Mac, where the updater
     looks at nothing of the computer. A test of what it learns by itself gives an empty system, or Linux. */
  HORNHOOF_HOST_OS: 'darwin',
  HORNHOOF_IMAGE: 'ghcr.io/invariant0x/hornhoof',
  HORNHOOF_HEALTH_WAIT: '1',
  HORNHOOF_SQL_DIR: SQL,
  ...env,
});

/* One step of the updater, as shell after its parts are loaded, with the same folders and stubs as a whole pass. */
export function runUpdaterStep(s: Stand, step: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const script = `
    CONTROL=$HORNHOOF_CONTROL_DIR
    SERVER_DIR=$HORNHOOF_SERVER_DIR
    IMAGE=$HORNHOOF_IMAGE
    NODE_IMAGE=$HORNHOOF_IMAGE-node
    UPDATER_IMAGE=$HORNHOOF_IMAGE-updater
    ROLE='' ONCE=1 UPDATER_REV=2 SQL_DIR=$HORNHOOF_SQL_DIR
    for part in "$1"*.sh; do . "$part"; done
    ${step}
  `;
  const child = spawn('bash', ['-euo', 'pipefail', '-c', script, 'updater-step', PARTS], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: standEnv(s, env) });
  endWith(child);
  return finished(child);
}

const callsOf = (s: Stand) => readFileSync(s.log, 'utf8').trim().split('\n').filter(Boolean);
const statusOf = (s: Stand) => {
  try {
    return JSON.parse(readFileSync(join(s.control, 'status.json'), 'utf8')) as { id: string; state: string; step: string; log: string };
  } catch {
    /* Not written yet, or read while it was being moved into place. */
    return null;
  }
};

/* The updater as it runs in its container, looking again and again until the test stops it with everything it started.
   A wait of the updater takes a moment here, so its loops do not spin. */
export function startLoop(s: Stand, env: Record<string, string> = {}) {
  const child = spawn('bash', [SCRIPT], { stdio: 'ignore', detached: true, env: standEnv(s, { STUB_DURING_SLEEP: '/bin/sleep 0.05', ...env }) });
  activeChildren.add(child);
  endWith(child);
  return { calls: () => callsOf(s), status: () => statusOf(s) };
}

/* Ends a run with everything it started. A run whose test gave up on it would otherwise go on by itself: its stubs wait
   for what the test never did, for as long as the computer is up. */
function endWith(child: { pid?: number }): void {
  try {
    onTestFinished(() => killProcessGroup(child.pid));
  } catch {
    /* A standalone probe script runs this outside a test, where its exit hooks end the run instead. */
  }
}

async function run(script: string, flag: string, s: Stand, env: Record<string, string>) {
  const child = spawn('bash', [script, flag], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: standEnv(s, env) });
  endWith(child);
  const { code, out } = await finished(child);
  const calls = existsSync(s.log) ? callsOf(s) : [];
  const status = existsSync(join(s.control, 'status.json')) ? JSON.parse(readFileSync(join(s.control, 'status.json'), 'utf8')) : null;
  return { code, out, calls, status };
}

/* What the server's keeper answers its updater with, in the control folder: whether the copies promised to wait,
   whether the dump may be taken, and that the copies' slots went before a restore. */
export type KeeperSays = { promised?: object | null; settled?: object | null; dropped?: object | null };
export function keeperSays(s: Stand, id: string, says: KeeperSays = {}): void {
  const files = { 'promised.json': says.promised, 'settled.json': says.settled, 'slots-dropped.json': says.dropped };
  for (const [name, said] of Object.entries(files)) {
    if (said !== null) writeFileSync(join(s.control, name), JSON.stringify({ id, ok: true, ...said }));
  }
}

/* One pass of an updater over request.json. The keeper answers each of the updater's questions about this request
   with yes, as on a server whose copies are in step, unless the test answers them itself: keeper false. */
function pass(script: string, s: Stand, request: object | null, env: Record<string, string>, opts: { keeper?: boolean } = {}) {
  if (request) writeFileSync(join(s.control, 'request.json'), JSON.stringify(request));
  const id = (request as { id?: unknown } | null)?.id;
  if (typeof id === 'string' && opts.keeper !== false) keeperSays(s, id);
  return run(script, '--once', s, env);
}

export const runOnce = (s: Stand, request: object | null, env: Record<string, string> = {}, opts: { keeper?: boolean } = {}) => pass(SCRIPT, s, request, env, opts);
/* One pass of updater.sh from another place, as its image keeps it. */
export const runOnceFrom = (script: string, s: Stand, request: object | null, env: Record<string, string> = {}) => pass(script, s, request, env);
/* The text of updater.sh and of each of its parts. */
export const updaterSource = () =>
  [SCRIPT, ...readdirSync(PARTS).filter(name => name.endsWith('.sh')).sort().map(name => join(PARTS, name))].map(file => readFileSync(file, 'utf8')).join('\n');
/* The updater from before revision 2, which starts the update that moves an install in. */
export const runRev1 = (s: Stand, request: object | null, env: Record<string, string> = {}) => pass(REV1, s, request, env);
/* The helper container this build's installer starts when an older updater runs it. */
export const takeOver = (s: Stand, env: Record<string, string> = {}) => run(SCRIPT, '--take-over', s, env);

export const at = (calls: string[], start: string) => calls.findIndex(c => c.startsWith(start));
