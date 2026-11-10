import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* What the tests of the updater share: a server folder of its own, and one pass of updater.sh over it with stub docker and curl. */

const SCRIPT = fileURLToPath(new URL('../../updater/updater.sh', import.meta.url));
const STUBS = fileURLToPath(new URL('./updater-stubs/', import.meta.url));
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

/* One pass of the updater over request.json, with stub docker and curl first on PATH, and its own temporary files in the
   stand. It takes as long as it takes: only the runner's limit for the test ends one that never ends. */
export async function runOnce(s: Stand, request: object | null, env: Record<string, string> = {}) {
  if (request) writeFileSync(join(s.control, 'request.json'), JSON.stringify(request));
  const child = spawn('bash', [SCRIPT, '--once'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
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
      HORNHOOF_IMAGE: 'ghcr.io/invariant0x/hornhoof',
      HORNHOOF_HEALTH_WAIT: '1',
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text));
  child.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text));
  const [code] = (await once(child, 'close')) as [number | null];
  const calls = readFileSync(s.log, 'utf8').trim().split('\n').filter(Boolean);
  const status = existsSync(join(s.control, 'status.json')) ? JSON.parse(readFileSync(join(s.control, 'status.json'), 'utf8')) : null;
  return { code, out: stdout + stderr, calls, status };
}

export const at = (calls: string[], start: string) => calls.findIndex(c => c.startsWith(start));
