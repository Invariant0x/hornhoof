import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../updater/updater.sh', import.meta.url));
const STUBS = fileURLToPath(new URL('./updater-stubs/', import.meta.url));
/* The updater reads and writes its files with jq, so these tests take the jq of this machine, wherever it is. */
const JQ = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
const TOOLS = mkdtempSync(join(tmpdir(), 'hh-updater-tools-'));
if (JQ) symlinkSync(JQ, join(TOOLS, 'jq'));

type Stand = { dir: string; control: string; server: string; log: string };

function stand(env = 'HORNHOOF_SECRET=s\nHORNHOOF_VERSION=0.4.0\n'): Stand {
  const dir = mkdtempSync(join(tmpdir(), 'hh-updater-'));
  const control = join(dir, 'control');
  const server = join(dir, 'srv');
  mkdirSync(control);
  mkdirSync(server);
  writeFileSync(join(server, '.env'), env);
  writeFileSync(join(dir, 'running'), 'aaa');
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  return { dir, control, server, log };
}

/* One pass of the updater over request.json, with stub docker and curl first on PATH. */
function runOnce(s: Stand, request: object | null, env: Record<string, string> = {}) {
  if (request) writeFileSync(join(s.control, 'request.json'), JSON.stringify(request));
  const res = spawnSync('bash', [SCRIPT, '--once'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: `${STUBS}:${TOOLS}:/usr/bin:/bin`,
      HOME: s.dir,
      STUB_LOG: s.log,
      STUB_STATE: s.dir,
      STUB_COMMITS: '0.4.0=aaa 0.4.1=bbb',
      HORNHOOF_CONTROL_DIR: s.control,
      HORNHOOF_SERVER_DIR: s.server,
      HORNHOOF_IMAGE: 'ghcr.io/invariant0x/hornhoof',
      HORNHOOF_HEALTH_WAIT: '1',
      ...env,
    },
  });
  const calls = readFileSync(s.log, 'utf8').trim().split('\n').filter(Boolean);
  const status = existsSync(join(s.control, 'status.json')) ? JSON.parse(readFileSync(join(s.control, 'status.json'), 'utf8')) : null;
  return { code: res.status, out: res.stdout + res.stderr, calls, status };
}

const at = (calls: string[], start: string) => calls.findIndex(c => c.startsWith(start));

describe('updater', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  it('updates to the asked version after saving the database', () => {
    const s = stand();
    const r = runOnce(s, { id: 'u1', version: '0.4.1', tag: '0.4.1' });
    expect(r.status).toMatchObject({ id: 'u1', version: '0.4.1', state: 'done', step: 'finished' });
    expect(r.status.at).toEqual(expect.any(String));
    const dump = at(r.calls, 'docker exec dbcid pg_dump');
    const pull = at(r.calls, 'docker pull ghcr.io/invariant0x/hornhoof:0.4.1');
    const create = at(r.calls, 'docker create ghcr.io/invariant0x/hornhoof:0.4.1');
    const install = r.calls.findIndex(c => c.startsWith('installer server') && c.includes('HORNHOOF_VERSION=0.4.1 HORNHOOF_FROM_UPDATER=1'));
    expect([dump, pull, create, install].every(i => i >= 0)).toBe(true);
    expect(dump).toBeLessThan(pull);
    expect(pull).toBeLessThan(install);
    expect(r.calls).toContain('docker cp cid-0.4.1:/app/scripts/install.sh ' + r.calls.find(c => c.includes(':/app/scripts/install.sh'))!.split(' ').pop());
    expect(r.calls.some(c => c.startsWith('docker cp cid-0.4.1:/app/compose.yaml '))).toBe(true);
    expect(r.calls.find(c => c.startsWith('installer'))).toContain(`HORNHOOF_SERVER_DIR=${s.server} HORNHOOF_COMPOSE_FILE=compose.yaml`);
    expect(r.calls.some(c => c.startsWith('curl') && c.includes('http://app:8080/api/health'))).toBe(true);
    const backups = readdirSync(join(s.server, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^hornhoof-\d{8}T\d{6}Z-u1\.sql\.gz$/);
    // The updater swaps itself last, from a helper container that outlives it.
    const swap = r.calls.findIndex(c => c.startsWith('docker run') && c.includes('compose up -d --no-build updater'));
    expect(swap).toBeGreaterThan(install);
    expect(r.calls[swap]).toContain('hornhoof-updater:0.4.1');
    expect(existsSync(join(s.control, 'alive'))).toBe(true);
  });

  it('rolls back when the new server never answers', () => {
    const s = stand();
    const r = runOnce(s, { id: 'u2', version: '0.4.1', tag: '0.4.1' }, { STUB_BROKEN: '0.4.1' });
    expect(r.status).toMatchObject({ id: 'u2', state: 'rolled_back', step: 'finished' });
    const installs = r.calls.filter(c => c.startsWith('installer'));
    expect(installs).toHaveLength(2);
    expect(installs[0]).toContain('HORNHOOF_VERSION=0.4.1');
    expect(installs[1]).toContain('HORNHOOF_VERSION=0.4.0');
    expect(readFileSync(join(s.server, '.env'), 'utf8')).toContain('HORNHOOF_VERSION=0.4.0');
    expect(r.status.log).toMatch(/0\.4\.1 did not answer/);
    expect(r.calls.some(c => c.includes('compose up -d --no-build updater'))).toBe(false);
  });

  it('goes back to the build that ran when .env names none', () => {
    const s = stand('HORNHOOF_SECRET=s\n');
    const r = runOnce(s, { id: 'u3', version: '0.4.1', tag: '0.4.1' }, { STUB_BROKEN: '0.4.1', STUB_RUNNING_COMMIT: 'aaa', STUB_COMMITS: '0.4.0=aaa 0.4.1=bbb aaa=aaa' });
    expect(r.status.state).toBe('rolled_back');
    expect(r.calls.filter(c => c.startsWith('installer'))[1]).toContain('HORNHOOF_VERSION=aaa');
  });

  it('refuses a version that is not a version', () => {
    const s = stand();
    const r = runOnce(s, { id: 'u4', version: 'x', tag: '1.0;rm -rf /' });
    expect(r.status).toMatchObject({ id: 'u4', state: 'failed' });
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
  });

  it('changes nothing when the new build cannot be downloaded', () => {
    const s = stand();
    const r = runOnce(s, { id: 'u5', version: '0.4.1', tag: '0.4.1' }, { STUB_PULL: 'fail' });
    expect(r.status).toMatchObject({ state: 'failed', step: 'pull' });
    expect(r.calls.some(c => c.startsWith('installer'))).toBe(false);
  });

  it('keeps three backups', () => {
    const s = stand();
    for (const id of ['b1', 'b2', 'b3', 'b4']) expect(runOnce(s, { id, version: '0.4.1', tag: '0.4.1' }).status.state).toBe('done');
    expect(readdirSync(join(s.server, 'backups'))).toHaveLength(3);
  });

  it('runs each request once', () => {
    const s = stand();
    runOnce(s, { id: 'u6', version: '0.4.1', tag: '0.4.1' });
    const again = runOnce(s, null);
    expect(again.calls.filter(c => c.startsWith('installer'))).toHaveLength(1);
    expect(again.status.id).toBe('u6');
  });

  it('marks an update it was stopped in as failed when it starts again', () => {
    const s = stand();
    writeFileSync(join(s.control, 'request.json'), JSON.stringify({ id: 'u7', version: '0.4.1', tag: '0.4.1' }));
    writeFileSync(join(s.control, 'status.json'), JSON.stringify({ id: 'u7', version: '0.4.1', state: 'running', step: 'install', log: '', at: '2026-10-30T00:00:00Z' }));
    const r = runOnce(s, null);
    expect(r.status).toMatchObject({ id: 'u7', state: 'failed' });
    expect(r.status.log).toMatch(/stopped/);
  });

  it('refuses to update a Hornhoof that install.sh did not set up', () => {
    const s = stand();
    const r = runOnce(s, { id: 'u8', version: '0.4.1', tag: '0.4.1' }, { HORNHOOF_SERVER_DIR: '' });
    expect(r.status).toMatchObject({ state: 'failed' });
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
  });
});
