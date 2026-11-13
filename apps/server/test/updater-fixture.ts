import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';

/* What the tests of the updater share: a server folder of its own, and one pass of updater.sh over it with stub docker and curl. */

const SCRIPT = fileURLToPath(new URL('../../updater/updater.sh', import.meta.url));
const REV1 = fileURLToPath(new URL('./updater-rev1.sh', import.meta.url));
const STUBS = fileURLToPath(new URL('./updater-stubs/', import.meta.url));
/* The statements of a restore, which the updater's image keeps next to it. */
const SQL = fileURLToPath(new URL('../../updater/', import.meta.url));
/* The updater reads and writes its files with jq, so these tests take the jq of this machine, wherever it is. */
export const JQ = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
const TOOLS = mkdtempSync(join(tmpdir(), 'hh-updater-tools-'));
if (JQ) symlinkSync(JQ, join(TOOLS, 'jq'));

export type Stand = { dir: string; control: string; server: string; log: string };

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
  const dir = mkdtempSync(join(tmpdir(), 'hh-updater-'));
  const control = join(dir, 'control');
  const server = join(dir, 'srv');
  mkdirSync(control);
  mkdirSync(server);
  writeFileSync(join(server, '.env'), env);
  writeFileSync(join(dir, 'running'), 'aaa');
  writeFileSync(join(dir, 'migrations'), '20');
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  return { dir, control, server, log };
}

/* One run of an updater script, with stub docker and curl first on PATH, and its own temporary files in the stand. It
   takes as long as it takes: only the runner's limit for the test ends one that never ends. */
const standEnv = (s: Stand, env: Record<string, string>) => ({
  TMPDIR: s.dir,
  PATH: `${STUBS}:${TOOLS}:/usr/bin:/bin`,
  HOME: s.dir,
  STUB_LOG: s.log,
  STUB_STATE: s.dir,
  STUB_COMMITS: '0.4.0=aaa 0.4.1=bbb',
  STUB_MIGRATIONS: '0.4.0=20 0.4.1=20',
  STUB_DIGESTS: Object.entries(DIGESTS).map(([tag, digest]) => `${tag}=${digest}`).join(' '),
  STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.0']} node=${APP}-node@${NODE_DIGESTS['0.4.0']} updater=${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`,
  HORNHOOF_CONTROL_DIR: s.control,
  HORNHOOF_SERVER_DIR: s.server,
  /* A machine whose installer wrote its system down, as every machine set up by this build has: a Mac, where the updater
     looks at nothing of the computer. A test of what it learns by itself gives an empty system, or Linux. */
  HORNHOOF_HOST_OS: 'darwin',
  HORNHOOF_IMAGE: 'ghcr.io/invariant0x/hornhoof',
  HORNHOOF_HEALTH_WAIT: '1',
  HORNHOOF_SQL_DIR: SQL,
  ...env,
});

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
  onTestFinished(endWith(child));
  return { calls: () => callsOf(s), status: () => statusOf(s) };
}

/* Ends a run with everything it started. A run whose test gave up on it would otherwise go on by itself: its stubs wait
   for what the test never did, for as long as the computer is up. */
function endWith(child: { pid?: number }): () => void {
  return () => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* Gone already. */
    }
  };
}

async function run(script: string, flag: string, s: Stand, env: Record<string, string>) {
  const child = spawn('bash', [script, flag], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: standEnv(s, env) });
  onTestFinished(endWith(child));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text));
  child.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text));
  const [code] = (await once(child, 'close')) as [number | null];
  const calls = readFileSync(s.log, 'utf8').trim().split('\n').filter(Boolean);
  const status = existsSync(join(s.control, 'status.json')) ? JSON.parse(readFileSync(join(s.control, 'status.json'), 'utf8')) : null;
  return { code, out: stdout + stderr, calls, status };
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
/* The updater from before revision 2, which starts the update that moves an install in. */
export const runRev1 = (s: Stand, request: object | null, env: Record<string, string> = {}) => pass(REV1, s, request, env);
/* The helper container this build's installer starts when an older updater runs it. */
export const takeOver = (s: Stand, env: Record<string, string> = {}) => run(SCRIPT, '--take-over', s, env);

export const at = (calls: string[], start: string) => calls.findIndex(c => c.startsWith(start));
