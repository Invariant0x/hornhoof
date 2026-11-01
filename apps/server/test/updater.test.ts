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

/* The digest of each build as the registry has it now, and what the app asks for: the build it read, by digest. */
const DIGESTS: Record<string, string> = { '0.4.0': `sha256:${'a'.repeat(64)}`, '0.4.1': `sha256:${'b'.repeat(64)}` };
const ask = (id: string) => ({ id, version: '0.4.1', tag: '0.4.1', digest: DIGESTS['0.4.1'] });

function stand(env = 'HORNHOOF_SECRET=s\nHORNHOOF_VERSION=0.4.0\n'): Stand {
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
      STUB_MIGRATIONS: '0.4.0=20 0.4.1=20',
      STUB_DIGESTS: Object.entries(DIGESTS).map(([tag, digest]) => `${tag}=${digest}`).join(' '),
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

  it('downloads every image of the new build, then saves the database right before installing it', () => {
    const s = stand();
    const r = runOnce(s, ask('u1'));
    expect(r.status).toMatchObject({ id: 'u1', version: '0.4.1', state: 'done', step: 'finished' });
    expect(r.status.at).toEqual(expect.any(String));
    const exact = at(r.calls, `docker pull ghcr.io/invariant0x/hornhoof@${DIGESTS['0.4.1']}`);
    /* The installer that runs with the Docker socket, and the compose file, come from the exact build. */
    const create = at(r.calls, `docker create ghcr.io/invariant0x/hornhoof@${DIGESTS['0.4.1']}`);
    /* The new compose file names every image the new build runs; the server's .env fills it in. */
    const images = r.calls.findIndex(c => c.startsWith(`docker compose --project-directory ${s.server} -f `) && c.endsWith('/0.4.1/compose.yaml pull'));
    const dump = at(r.calls, 'docker exec dbcid pg_dump');
    const install = r.calls.findIndex(c => c.startsWith('installer server') && c.includes('HORNHOOF_VERSION=0.4.1 HORNHOOF_FROM_UPDATER=1'));
    expect([exact, create, images, dump, install].every(i => i >= 0)).toBe(true);
    expect(exact).toBeLessThan(create);
    expect(create).toBeLessThan(images);
    expect(r.calls[images + 1]).toBe('pull with HORNHOOF_VERSION=0.4.1');
    /* The old server keeps working through the downloads; what it does then is in the copy. */
    expect(images).toBeLessThan(dump);
    expect(dump).toBeLessThan(install);
    /* The installer starts the images the updater downloaded and downloads none again. */
    expect(r.calls[install]).toMatch(/ HORNHOOF_PULLED=1$/);
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
    const r = runOnce(s, ask('u2'), { STUB_BROKEN: '0.4.1' });
    expect(r.status).toMatchObject({ id: 'u2', state: 'rolled_back', step: 'finished' });
    const installs = r.calls.filter(c => c.startsWith('installer'));
    expect(installs).toHaveLength(2);
    expect(installs[0]).toContain('HORNHOOF_VERSION=0.4.1');
    expect(installs[1]).toContain('HORNHOOF_VERSION=0.4.0');
    expect(readFileSync(join(s.server, '.env'), 'utf8')).toContain('HORNHOOF_VERSION=0.4.0');
    expect(r.status.log).toMatch(/0\.4\.1 did not answer/);
    expect(r.calls.some(c => c.includes('compose up -d --no-build updater'))).toBe(false);
  });

  it('says what to do by hand when neither the new build nor the one before it answers', () => {
    const s = stand();
    const r = runOnce(s, ask('u9'), { STUB_BROKEN: '0.4.1 0.4.0' });
    expect(r.status).toMatchObject({ id: 'u9', state: 'failed', step: 'finished' });
    expect(r.calls.filter(c => c.startsWith('installer')).map(c => c.match(/HORNHOOF_VERSION=(\S+)/)![1])).toEqual(['0.4.1', '0.4.0']);
    expect(r.status.log).toMatch(/0\.4\.1 did not answer/);
    expect(r.status.log).toContain(`Could not go back to 0.4.0 either. Run install.sh server in ${s.server}, and see docker compose logs app.`);
    expect(r.calls.some(c => c.includes('compose up -d --no-build updater'))).toBe(false);
  });

  it('puts the database back before the build from before starts on it, when the new build changed it', () => {
    const s = stand();
    const r = runOnce(s, ask('m1'), { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' });
    expect(r.status).toMatchObject({ id: 'm1', state: 'rolled_back', step: 'finished' });
    expect(readFileSync(join(s.dir, 'migrations'), 'utf8')).toBe('20');
    const stop = at(r.calls, 'docker compose stop app');
    const load = r.calls.findIndex(c => c.startsWith('docker exec -i dbcid psql') && c.includes('-d hornhoof_restore'));
    const swap = r.calls.findIndex(c => c.startsWith('docker exec dbcid psql') && c.includes('ALTER DATABASE hornhoof_restore RENAME TO hornhoof'));
    const old = r.calls.findIndex(c => c.startsWith('installer') && c.includes('HORNHOOF_VERSION=0.4.0'));
    expect([stop, load, swap, old].every(i => i >= 0)).toBe(true);
    expect(stop).toBeLessThan(swap);
    expect(load).toBeLessThan(swap);
    expect(swap).toBeLessThan(old);
    expect(r.status.log).toContain('0.4.1 changed the database, so it goes back to the copy saved before the update.');
  });

  it('leaves the database as it is on the way back when the new build did not change it', () => {
    const s = stand();
    const r = runOnce(s, ask('m2'), { STUB_BROKEN: '0.4.1' });
    expect(r.status.state).toBe('rolled_back');
    expect(r.calls.some(c => c.startsWith('docker exec -i') || c.includes('hornhoof_restore'))).toBe(false);
  });

  it('does not start the build from before on a database it could not put back', () => {
    const s = stand();
    const r = runOnce(s, ask('m3'), { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21', STUB_RESTORE: 'fail' });
    expect(r.status).toMatchObject({ id: 'm3', state: 'failed', step: 'finished' });
    expect(r.calls.filter(c => c.startsWith('installer'))).toHaveLength(1);
    expect(r.calls.some(c => c.includes('RENAME TO hornhoof'))).toBe(false);
    expect(r.status.log).toMatch(/Could not put the database back from backups\/hornhoof-\d{8}T\d{6}Z-m3\.sql\.gz\./);
  });

  it('goes back to the build that ran when .env names none', () => {
    const s = stand('HORNHOOF_SECRET=s\n');
    const r = runOnce(s, ask('u3'), { STUB_BROKEN: '0.4.1', STUB_RUNNING_COMMIT: 'aaa', STUB_COMMITS: '0.4.0=aaa 0.4.1=bbb aaa=aaa' });
    expect(r.status.state).toBe('rolled_back');
    expect(r.calls.filter(c => c.startsWith('installer'))[1]).toContain('HORNHOOF_VERSION=aaa');
  });

  it('refuses a version that is not a version', () => {
    const s = stand();
    const r = runOnce(s, { ...ask('u4'), version: 'x', tag: '1.0;rm -rf /' });
    expect(r.status).toMatchObject({ id: 'u4', state: 'failed' });
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
  });

  it('refuses a request that does not name the exact build', () => {
    const s = stand();
    for (const [id, digest] of [['d1', undefined], ['d2', 'latest'], ['d3', `sha256:${'b'.repeat(63)};`]] as const) {
      const r = runOnce(s, { id, version: '0.4.1', tag: '0.4.1', ...(digest ? { digest } : {}) });
      expect(r.status).toMatchObject({ id, state: 'failed', step: 'finished' });
      expect(r.status.log).toContain('The request does not name the exact build to install, so nothing changed.');
    }
    expect(readFileSync(s.log, 'utf8')).not.toMatch(/^docker /m);
  });

  it('changes nothing when the version now points at another build than the one Hornhoof read', () => {
    const s = stand();
    const r = runOnce(s, ask('d4'), { STUB_DIGESTS: `0.4.0=${DIGESTS['0.4.0']} 0.4.1=sha256:${'c'.repeat(64)}` });
    expect(r.status).toMatchObject({ id: 'd4', state: 'failed', step: 'pull' });
    expect(r.status.log).toContain('0.4.1 in the registry is not the build Hornhoof checked, so nothing changed. Check for updates again, then update.');
    expect(r.calls.some(c => c.startsWith('docker create') || c.startsWith('installer'))).toBe(false);
  });

  it('changes nothing when the new build cannot be downloaded', () => {
    const s = stand();
    const r = runOnce(s, ask('u5'), { STUB_PULL: 'fail' });
    expect(r.status).toMatchObject({ state: 'failed', step: 'pull' });
    expect(r.calls.some(c => c.startsWith('installer'))).toBe(false);
  });

  it('changes nothing when the other images of the new build cannot be downloaded', () => {
    const s = stand();
    const r = runOnce(s, ask('u10'), { STUB_PULL: 'images' });
    expect(r.status).toMatchObject({ id: 'u10', state: 'failed', step: 'pull' });
    expect(r.status.log).toContain('Could not download the images of 0.4.1, so nothing changed.');
    expect(r.calls.some(c => c.startsWith('docker exec dbcid pg_dump') || c.startsWith('installer'))).toBe(false);
  });

  it('keeps three backups', () => {
    const s = stand();
    for (const id of ['b1', 'b2', 'b3', 'b4']) expect(runOnce(s, ask(id)).status.state).toBe('done');
    expect(readdirSync(join(s.server, 'backups'))).toHaveLength(3);
  });

  it('runs each request once', () => {
    const s = stand();
    runOnce(s, ask('u6'));
    const again = runOnce(s, null);
    expect(again.calls.filter(c => c.startsWith('installer'))).toHaveLength(1);
    expect(again.status.id).toBe('u6');
  });

  it('finishes an update it was stopped in while the new build was installing', () => {
    const s = stand();
    const stopped = runOnce(s, ask('r1'), { STUB_STOP_IN: '0.4.1' });
    expect(stopped.status).toMatchObject({ id: 'r1', state: 'running', step: 'install' });
    const r = runOnce(s, null);
    expect(r.status).toMatchObject({ id: 'r1', version: '0.4.1', state: 'done', step: 'finished' });
    expect(r.calls.filter(c => c.startsWith('installer')).map(c => c.match(/HORNHOOF_VERSION=(\S+)/)![1])).toEqual(['0.4.1']);
    expect(r.calls.some(c => c.includes('compose up -d --no-build updater') && c.includes('hornhoof-updater:0.4.1'))).toBe(true);
    expect(r.status.log).toContain('The updater stopped during the update and goes on with it.');
    /* The stub log keeps the calls of every run on this stand. */
    expect(runOnce(s, null).calls.filter(c => c.startsWith('installer'))).toHaveLength(1);
    expect(readdirSync(join(s.server, 'backups')).filter(f => !f.endsWith('.sql.gz'))).toEqual([]);
  });

  it('starts an update it was stopped in over when nothing had changed yet', () => {
    const s = stand();
    const stopped = runOnce(s, ask('r0'), { STUB_STOP_IN: 'pull' });
    expect(stopped.status).toMatchObject({ id: 'r0', state: 'running', step: 'pull' });
    /* It stopped while downloading, before it saved the database. */
    expect(stopped.calls.some(c => c.startsWith('docker exec dbcid pg_dump'))).toBe(false);
    const r = runOnce(s, null);
    expect(r.status).toMatchObject({ id: 'r0', state: 'done', step: 'finished' });
    expect(r.calls.filter(c => c.startsWith('docker exec dbcid pg_dump'))).toHaveLength(1);
    expect(r.calls.filter(c => c.startsWith('installer'))).toHaveLength(1);
  });

  it('goes back, with the saved database, from an update it was stopped in whose build does not answer', () => {
    const s = stand();
    const env = { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' };
    runOnce(s, ask('r2'), { ...env, STUB_STOP_IN: '0.4.1' });
    const r = runOnce(s, null, env);
    expect(r.status).toMatchObject({ id: 'r2', state: 'rolled_back', step: 'finished' });
    expect(readFileSync(join(s.dir, 'migrations'), 'utf8')).toBe('20');
    expect(r.calls.filter(c => c.startsWith('installer')).map(c => c.match(/HORNHOOF_VERSION=(\S+)/)![1])).toEqual(['0.4.1', '0.4.0']);
  });

  it('finishes going back when it was stopped on the way back', () => {
    const s = stand();
    const env = { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' };
    const stopped = runOnce(s, ask('r3'), { ...env, STUB_STOP_IN: '0.4.0' });
    expect(stopped.status).toMatchObject({ id: 'r3', state: 'running', step: 'rollback' });
    const r = runOnce(s, null, env);
    expect(r.status).toMatchObject({ id: 'r3', state: 'rolled_back', step: 'finished' });
    expect(readFileSync(join(s.dir, 'migrations'), 'utf8')).toBe('20');
    /* 0.4.1 went in on the first run; the second one only puts 0.4.0 in. */
    expect(r.calls.filter(c => c.startsWith('installer')).map(c => c.match(/HORNHOOF_VERSION=(\S+)/)![1])).toEqual(['0.4.1', '0.4.0']);
    expect(r.status.log).toContain('The database was saved before it.');
  });

  it('marks an update it was stopped in as failed when it kept no note of it', () => {
    const s = stand();
    writeFileSync(join(s.control, 'request.json'), JSON.stringify({ id: 'u7', version: '0.4.1', tag: '0.4.1' }));
    writeFileSync(join(s.control, 'status.json'), JSON.stringify({ id: 'u7', version: '0.4.1', state: 'running', step: 'install', log: '', at: '2026-10-30T00:00:00Z' }));
    const r = runOnce(s, null);
    expect(r.status).toMatchObject({ id: 'u7', state: 'failed' });
    expect(r.status.log).toMatch(/stopped/);
  });

  it('refuses to update a Hornhoof that install.sh did not set up', () => {
    const s = stand();
    const r = runOnce(s, ask('u8'), { HORNHOOF_SERVER_DIR: '' });
    expect(r.status).toMatchObject({ state: 'failed' });
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
  });
});
