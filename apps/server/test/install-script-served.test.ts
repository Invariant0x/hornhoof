import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { testApp } from './helpers.js';
import { CODE, IMAGE, SERVER, install } from './install-script-helpers.js';

describe('install.sh a server serves', () => {
  const COMMIT = 'c'.repeat(40);
  const DIGEST = `sha256:${'d'.repeat(64)}`;
  const BY_DIGEST = `ghcr.io/invariant0x/hornhoof-node@${DIGEST}`;
  const BY_TAG = `ghcr.io/invariant0x/hornhoof-node:${COMMIT}`;
  const NODE = 'hornhoof-claude-1c07dac4';
  const ON_MACHINE = { STUB_CONTAINERS: `${NODE}=${SERVER}` };
  const LOCAL_NOTE = 'no node image published for it';
  const NOT_PUBLISHED = 'may not be published yet';

  /* The script GET /install.sh answers on a server of this commit, whose registry knows this digest of the node image. */
  async function fromServer(digest: string, commit = COMMIT): Promise<string> {
    const { app } = await testApp({ HORNHOOF_VERSION: '0.7.3', HORNHOOF_COMMIT: commit });
    vi.spyOn(app.ctx.updates, 'siblings').mockResolvedValue({ node: digest, updater: '' });
    const file = join(mkdtempSync(join(tmpdir(), 'hh-served-')), 'install.sh');
    writeFileSync(file, (await app.inject({ url: '/install.sh' })).body);
    return file;
  }

  it("starts a joining machine's nodes on the digest of the server's build", async () => {
    const r = install({ script: await fromServer(DIGEST) });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker pull ${BY_DIGEST}`);
    /* The key of each of the two plans goes in, then its node starts. The updater of the nodes comes after them. */
    const runs = r.calls.filter(c => c.startsWith('docker run') && !c.includes(' start-nodes '));
    expect(runs).toHaveLength(4);
    for (const run of runs) expect(run).toContain(BY_DIGEST);
    expect(r.calls.join('\n')).not.toContain(':latest');
    expect(r.out).not.toContain(LOCAL_NOTE);
  });

  it('moves the nodes on this machine to that digest, also one too old to record why it stops', async () => {
    const r = install({ script: await fromServer(DIGEST), args: [], env: { ...ON_MACHINE, STUB_STOP_INTENT: 'unsupported' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker stop --time 5 ${NODE}`);
    expect(r.calls.find(c => c.startsWith('docker run -d'))!.endsWith(BY_DIGEST)).toBe(true);
    expect(r.calls.join('\n')).not.toContain(':latest');
  });

  it("goes by the commit's tag when the server has no digest yet, and starts on it once it can be downloaded", async () => {
    const r = install({ script: await fromServer('') });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker pull ${BY_TAG}`);
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(BY_TAG))).toBe(true);
    expect(r.calls.join('\n')).not.toContain(':latest');
  });

  it("stops before the join and leaves the machine's nodes alone when the image of the server's build cannot be downloaded", async () => {
    const r = install({ script: await fromServer(''), env: { ...ON_MACHINE, STUB_PULL: 'fail' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Could not download ${BY_TAG}`);
    expect(r.out).toContain(NOT_PUBLISHED);
    /* The command's code stays good, so the same command works once the image is out. */
    expect(r.calls.some(c => c.includes('/api/nodes/join'))).toBe(false);
    expect(r.calls.some(c => /^docker (run|rm|stop)/.test(c))).toBe(false);
    expect(r.calls.join('\n')).not.toContain(':latest');
  });

  it("uses that image from this computer when it cannot be downloaded but is here", async () => {
    const r = install({ script: await fromServer(''), env: { STUB_PULL: 'fail', STUB_IMAGE_LOCAL: '1' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Using the local image.');
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(BY_TAG))).toBe(true);
  });

  it('takes the latest image for a server CI did not build, and says so', async () => {
    const r = install({ script: await fromServer(DIGEST, 'local') });
    expect(r.code).toBe(0);
    expect(r.out).toContain(LOCAL_NOTE);
    expect(r.calls).toContain(`docker pull ${IMAGE}`);
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(IMAGE))).toBe(true);
  });

  it('says nothing about the node image where it starts no nodes', async () => {
    const script = await fromServer(DIGEST, 'local');
    const gone = install({ script, args: ['--uninstall'], tty: 'n\n', env: ON_MACHINE });
    expect(gone.code).toBe(0);
    expect(gone.out).not.toContain(LOCAL_NOTE);
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    const server = install({ script, args: ['server'], tty: '', env: { HORNHOOF_SERVER_DIR: dir } });
    expect(server.code).toBe(0);
    expect(server.out).not.toContain(LOCAL_NOTE);
  });

  it("leaves a server's own install to the build it picks", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    const r = install({ script: await fromServer(DIGEST), args: ['server'], tty: '', env: { HORNHOOF_SERVER_DIR: dir } });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toMatch(/^HORNHOOF_NODE_REF=ghcr\.io\/invariant0x\/hornhoof-node:latest$/m);
    expect(r.calls.join('\n')).not.toContain(DIGEST);
  });

  it('takes the image a person names on a server CI did not build, without a word about either', async () => {
    const own = 'registry.acme.test/node:own';
    const script = await fromServer(DIGEST, 'local');
    const r = install({ script, env: { HORNHOOF_NODE_IMAGE: own } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker pull ${own}`);
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(own))).toBe(true);
    expect(r.out).not.toContain(LOCAL_NOTE);
    const failed = install({ script, env: { HORNHOOF_NODE_IMAGE: own, STUB_PULL: 'fail' } });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain(`Could not download ${own}. Check the internet connection, then run this command again.`);
    expect(failed.out).not.toContain(NOT_PUBLISHED);
  });

  it('serves no word of a check, and a machine takes the nodes of the build whatever the registry says of anything else', async () => {
    const { app } = await testApp({ HORNHOOF_VERSION: '0.7.3', HORNHOOF_COMMIT: COMMIT });
    vi.spyOn(app.ctx.updates, 'siblings').mockResolvedValue({ node: DIGEST, updater: '' });
    const body = (await app.inject({ url: '/install.sh' })).body;
    expect(body).not.toContain('NO_NODE');
    const file = join(mkdtempSync(join(tmpdir(), 'hh-served-')), 'install.sh');
    writeFileSync(file, body);
    const r = install({ script: file, args: [], env: ON_MACHINE });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes('--entrypoint node'))).toBe(false);
    expect(r.calls.find(c => c.startsWith('docker run -d'))!.endsWith(BY_DIGEST)).toBe(true);
  });

  it('starts the nodes of a script from the repository on the latest image without asking the app image anything', () => {
    for (const args of [['--join', CODE], ['--urgent'], []]) {
      const r = install({ args, env: ON_MACHINE });
      expect(r.code).toBe(0);
      expect(r.calls).toContain(`docker pull ${IMAGE}`);
      expect(r.calls.some(c => c.includes('--entrypoint node') || c.startsWith('docker pull ghcr.io/invariant0x/hornhoof:'))).toBe(false);
    }
  });

  it('works as before when it comes from the repository and not from a server', () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker pull ${IMAGE}`);
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(IMAGE))).toBe(true);
    expect(r.out).not.toContain(LOCAL_NOTE);
    const failed = install({ env: { STUB_PULL: 'node' } });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain(`Could not download ${IMAGE}. Check the internet connection, then run this command again.`);
    expect(failed.out).not.toContain(NOT_PUBLISHED);
  });
});
