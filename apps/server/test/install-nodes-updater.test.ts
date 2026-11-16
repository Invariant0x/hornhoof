import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { testApp } from './helpers.js';
import { isNodeRun, SCRIPT, SERVER, install } from './install-script-helpers.js';

const COMMIT = 'c'.repeat(40);
const NODE_DIGEST = `sha256:${'d'.repeat(64)}`;
const UPDATER_DIGEST = `sha256:${'e'.repeat(64)}`;
const NODE = `ghcr.io/invariant0x/hornhoof-node@${NODE_DIGEST}`;
const UPDATER = `ghcr.io/invariant0x/hornhoof-updater@${UPDATER_DIGEST}`;
/* This computer's machine key, and the hash the server knows its own computer by when it runs here. */
const MACHINE = 'a'.repeat(32);
const HOST = createHash('sha256').update(`hornhoof-host:${MACHINE}`).digest('hex');
const ELSEWHERE = 'f'.repeat(64);
const CLAUDE = 'hornhoof-claude-1c07dac4';
const CODEX = 'hornhoof-codex-9f1e2d3c';
const START = `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ${UPDATER} start-nodes ${SERVER} ${UPDATER} ${HOST}`;

/* install.sh as a server serves it: the node and updater images of its build, and its own computer. */
function served(hostId = ELSEWHERE, updater = UPDATER): string {
  const file = join(mkdtempSync(join(tmpdir(), 'hh-nodes-updater-')), 'install.sh');
  writeFileSync(file, readFileSync(SCRIPT, 'utf8').replaceAll('__HORNHOOF_NODE_IMAGE__', NODE).replaceAll('__HORNHOOF_UPDATER_IMAGE__', updater)
    .replaceAll('__HORNHOOF_HOST_ID__', hostId));
  return file;
}

/* The installer's folder on a computer that joined before, with its machine key. */
function machine(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-machine-'));
  writeFileSync(join(dir, 'machine'), MACHINE);
  return dir;
}

const starts = (calls: string[]) => calls.filter(c => c.includes(' start-nodes '));

describe('install.sh and the updater of the nodes on a computer that is not the server\'s', () => {
  it('starts it after a join, with the Docker socket, on the updater image of the server\'s build', () => {
    const r = install({ script: served(), env: { HORNHOOF_HOME: machine() } });
    expect(r.code).toBe(0);
    expect(starts(r.calls)).toEqual([START]);
    const nodes = r.calls.map((c, i) => (isNodeRun(c) ? i : -1)).filter(i => i >= 0);
    expect(nodes).toHaveLength(2);
    expect(r.calls.indexOf(START)).toBeGreaterThan(Math.max(...nodes));
    expect(r.out).toContain('Starting the updater of these nodes');
  });

  it('starts it when the install line updates the nodes on this machine', () => {
    const r = install({ script: served(), args: [], env: { HORNHOOF_HOME: machine(), STUB_CONTAINERS: `${CLAUDE}=${SERVER}` } });
    expect(r.code).toBe(0);
    expect(starts(r.calls)).toEqual([START]);
  });

  it('keeps the one that runs, so there is one for each server and it is never stopped in the middle of a node', () => {
    const r = install({ script: served(), args: [], env: { HORNHOOF_HOME: machine(), STUB_CONTAINERS: `${CLAUDE}=${SERVER}`, STUB_NODES_UPDATER: 'updater-cid' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker ps -q --filter label=hornhoof.updater=nodes --filter label=hornhoof.server=${SERVER}`);
    expect(starts(r.calls)).toEqual([]);
    expect(r.calls.some(c => c.startsWith('docker rm') && c.includes('updater-cid'))).toBe(false);
  });

  it('starts none on the server\'s own computer, where the updater next to the server moves the nodes', () => {
    const r = install({ script: served(HOST), env: { HORNHOOF_HOME: machine() } });
    expect(r.code).toBe(0);
    expect(starts(r.calls)).toEqual([]);
  });

  it('starts none for a server on localhost, which runs on this computer', () => {
    const r = install({ script: served(), env: { HORNHOOF_HOME: machine(), HORNHOOF_SERVER: 'http://localhost:8080' } });
    expect(r.code).toBe(0);
    expect(starts(r.calls)).toEqual([]);
  });

  it('starts none for a build that has no updater image published', () => {
    const r = install({ script: served(ELSEWHERE, 'local'), env: { HORNHOOF_HOME: machine() } });
    expect(r.code).toBe(0);
    expect(starts(r.calls)).toEqual([]);
  });

  it('starts none, and says so, while the server can name its updater image only by its tag', () => {
    const r = install({ script: served(ELSEWHERE, `ghcr.io/invariant0x/hornhoof-updater:${COMMIT}`), env: { HORNHOOF_HOME: machine() } });
    expect(r.code).toBe(0);
    expect(starts(r.calls)).toEqual([]);
    expect(r.out).toContain('only when you run this command again');
  });

  it('removes it with the nodes on --uninstall, and keeps it while the nodes stay', () => {
    const gone = install({ script: served(), args: ['--uninstall'], tty: 'y\nn\n', env: { STUB_CONTAINERS: `${CLAUDE}=${SERVER}`, STUB_NODES_UPDATER: 'updater-cid' } });
    expect(gone.code).toBe(0);
    expect(gone.calls).toContain(`docker ps -aq --filter label=hornhoof.updater=nodes --filter label=hornhoof.server=${SERVER}`);
    expect(gone.calls).toContain('docker rm -f updater-cid');
    const kept = install({ script: served(), args: ['--uninstall'], tty: 'n\n', env: { STUB_CONTAINERS: `${CLAUDE}=${SERVER}`, STUB_NODES_UPDATER: 'updater-cid' } });
    expect(kept.calls.some(c => c.startsWith('docker rm'))).toBe(false);
  });

  it('removes it on --uninstall also when no node of the server is left', () => {
    const r = install({ script: served(), args: ['--uninstall'], env: { STUB_NODES_UPDATER: 'updater-cid' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('docker rm -f updater-cid');
  });
});

describe('install.sh as the updater of the nodes runs it', () => {
  const fromUpdater = (env: Record<string, string> = {}) => install({
    script: served(),
    args: [],
    env: { HORNHOOF_FROM_UPDATER: '1', HORNHOOF_NODES_ONLY: `id-of-${CLAUDE}`, HORNHOOF_TTY: '/dev/null', STUB_CONTAINERS: `${CLAUDE}=${SERVER} ${CODEX}=${SERVER}`, ...env },
  });

  it('replaces only the node it names, once it is free, and leaves the other with what it runs', () => {
    const r = fromUpdater({ STUB_REMOVED: CODEX });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.startsWith('docker run --rm') && c.includes(`-v ${CLAUDE}:/data:ro`) && c.endsWith(`${NODE} wait-update`))).toBe(true);
    expect(r.calls.some(c => c.startsWith(`docker rm -f ${CLAUDE}-old-`))).toBe(true);
    expect(r.calls.find(c => c.startsWith('docker run -d'))!.endsWith(NODE)).toBe(true);
    expect(r.calls.filter(c => c.includes(CODEX) && !c.startsWith('docker ps'))).toEqual([]);
  });

  it('asks nobody to sign in and starts no updater of its own', () => {
    const r = fromUpdater({ STUB_STATUS: 'needs_login' });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker exec -it'))).toEqual([]);
    expect(starts(r.calls)).toEqual([]);
    expect(r.calls.some(c => c.includes('hornhoof.updater=nodes'))).toBe(false);
  });

  it('keeps what a Mac told the node it replaces, which it cannot see from its container', () => {
    const r = fromUpdater({ STUB_NODE_ENV: 'PATH=/usr/bin\\nHORNHOOF_HOST_CPU=Apple M2 Pro\\nHORNHOOF_HOST_MEMORY=17179869184\\n' });
    expect(r.code).toBe(0);
    const run = r.calls.find(c => c.startsWith('docker run -d'))!;
    expect(run).toContain('-e HORNHOOF_HOST_CPU=Apple M2 Pro -e HORNHOOF_HOST_MEMORY=17179869184 ');
    expect(run).not.toContain('PATH=');
  });

  it('leaves the node as it is when it cannot learn when the node is free', () => {
    const r = fromUpdater({ STUB_WAIT_UPDATE: '1' });
    expect(r.code).toBe(1);
    expect(r.calls.some(c => c.startsWith('docker rm'))).toBe(false);
  });
});

describe('install.sh a server serves, for the updater of the nodes', () => {
  async function fromServer(env: Record<string, string>): Promise<string> {
    const { app } = await testApp({ HORNHOOF_VERSION: '0.8.4', HORNHOOF_COMMIT: COMMIT, ...env });
    vi.spyOn(app.ctx.updates, 'siblings').mockResolvedValue({ node: NODE_DIGEST, updater: UPDATER_DIGEST });
    const file = join(mkdtempSync(join(tmpdir(), 'hh-served-')), 'install.sh');
    writeFileSync(file, (await app.inject({ url: '/install.sh' })).body);
    return file;
  }

  it('names the updater image of its build by digest, so a computer that joins starts that updater', async () => {
    const r = install({ script: await fromServer({ HORNHOOF_HOST_ID: ELSEWHERE }), env: { HORNHOOF_HOME: machine() } });
    expect(r.code).toBe(0);
    expect(starts(r.calls)).toEqual([START]);
  });

  it('names its own computer, where a join starts none', async () => {
    const r = install({ script: await fromServer({ HORNHOOF_HOST_ID: HOST }), env: { HORNHOOF_HOME: machine() } });
    expect(r.code).toBe(0);
    expect(starts(r.calls)).toEqual([]);
  });
});
