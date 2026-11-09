import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

/* The digest of each build as the registry has it now, and of the node and updater images made with it. The app asks
   for the build it read and for those images, by digest. */
const APP = 'ghcr.io/invariant0x/hornhoof';
const DIGESTS: Record<string, string> = { '0.4.0': `sha256:${'a'.repeat(64)}`, '0.4.1': `sha256:${'b'.repeat(64)}` };
const NODE_DIGESTS: Record<string, string> = { '0.4.0': `sha256:${'c'.repeat(64)}`, '0.4.1': `sha256:${'d'.repeat(64)}` };
const UPDATER_DIGESTS: Record<string, string> = { '0.4.0': `sha256:${'e'.repeat(64)}`, '0.4.1': `sha256:${'f'.repeat(64)}` };
const ask = (id: string) => ({ id, version: '0.4.1', tag: '0.4.1', digest: DIGESTS['0.4.1'], nodeDigest: NODE_DIGESTS['0.4.1'], updaterDigest: UPDATER_DIGESTS['0.4.1'] });
/* The exact images of a build, as compose and the installer get them. */
const refs = (tag: string) => `HORNHOOF_APP_REF=${APP}@${DIGESTS[tag]} HORNHOOF_NODE_REF=${APP}-node@${NODE_DIGESTS[tag]} HORNHOOF_UPDATER_REF=${APP}-updater@${UPDATER_DIGESTS[tag]}`;

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

/* One pass of the updater over request.json, with stub docker and curl first on PATH, and its own temporary files in the
   stand. It takes as long as it takes: only the runner's limit for the test ends one that never ends. */
async function runOnce(s: Stand, request: object | null, env: Record<string, string> = {}) {
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

const at = (calls: string[], start: string) => calls.findIndex(c => c.startsWith(start));

describe('updater', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  it('downloads every image of the new build, then saves the database right before installing it', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u1'));
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
    /* Compose gets the exact images Hornhoof read, so a tag that moves meanwhile changes nothing. */
    expect(r.calls[images + 1]).toBe(`pull with HORNHOOF_VERSION=0.4.1 ${refs('0.4.1')}`);
    /* The old server keeps working through the downloads; what it does then is in the copy. */
    expect(images).toBeLessThan(dump);
    expect(dump).toBeLessThan(install);
    /* The installer starts the images the updater downloaded and downloads none again. */
    expect(r.calls[install]).toContain(`HORNHOOF_PULLED=1 ${refs('0.4.1')}`);
    expect(r.calls.filter(c => /hornhoof(-node|-updater)?:0\.4\.1/.test(c))).toEqual([]);
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
    expect(r.calls[swap]).toContain(`--entrypoint docker ${APP}-updater@${UPDATER_DIGESTS['0.4.1']} compose up -d --no-build updater`);
    expect(existsSync(join(s.control, 'alive'))).toBe(true);
  });

  it('skips pulling the node image when the node container runs that exact digest already', async () => {
    const s = stand();
    const r = await runOnce(s, { ...ask('n1'), nodeDigest: NODE_DIGESTS['0.4.0'] }, { STUB_SERVICES: 'db app node tunnel updater' });
    expect(r.status).toMatchObject({ id: 'n1', version: '0.4.1', state: 'done', step: 'finished' });
    const pull = r.calls.find(c => c.startsWith(`docker compose --project-directory ${s.server} -f `) && c.includes('/0.4.1/compose.yaml pull'));
    expect(pull).toMatch(/\/0\.4\.1\/compose\.yaml pull db app tunnel updater$/);
    expect(r.calls.some(c => c.startsWith('docker pull') && c.includes('hornhoof-node'))).toBe(false);
    expect(r.calls.find(c => c.startsWith('installer'))).toContain(
      `HORNHOOF_PULLED=1 HORNHOOF_APP_REF=${APP}@${DIGESTS['0.4.1']} HORNHOOF_NODE_REF=${APP}-node@${NODE_DIGESTS['0.4.0']} HORNHOOF_UPDATER_REF=${APP}-updater@${UPDATER_DIGESTS['0.4.1']}`,
    );
    expect(r.calls.some(c => c.startsWith('docker run') && c.includes(`${APP}-updater@${UPDATER_DIGESTS['0.4.1']} compose up -d --no-build updater`))).toBe(true);

    /* Without a running node container on that digest, the node image is pulled with the rest. */
    const missing = stand();
    const m = await runOnce(missing, { ...ask('n2'), nodeDigest: NODE_DIGESTS['0.4.0'] }, { STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.0']} updater=${APP}-updater@${UPDATER_DIGESTS['0.4.0']}` });
    expect(m.status).toMatchObject({ id: 'n2', state: 'done', step: 'finished' });
    expect(m.calls.some(c => c.endsWith('/0.4.1/compose.yaml pull'))).toBe(true);
  });

  it('rolls back when the new server never answers', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u2'), { STUB_BROKEN: '0.4.1' });
    expect(r.status).toMatchObject({ id: 'u2', state: 'rolled_back', step: 'finished' });
    const installs = r.calls.filter(c => c.startsWith('installer'));
    expect(installs).toHaveLength(2);
    expect(installs[0]).toContain('HORNHOOF_VERSION=0.4.1');
    expect(installs[1]).toContain('HORNHOOF_VERSION=0.4.0');
    /* The images that ran before, as Docker keeps them by digest. */
    expect(installs[1]).toContain(`HORNHOOF_PULLED=1 ${refs('0.4.0')}`);
    expect(r.calls).toContain(`docker create ${APP}@${DIGESTS['0.4.0']}`);
    expect(readFileSync(join(s.server, '.env'), 'utf8')).toContain('HORNHOOF_VERSION=0.4.0');
    expect(r.status.log).toMatch(/0\.4\.1 did not answer/);
    expect(r.calls.some(c => c.includes('compose up -d --no-build updater'))).toBe(false);
  });

  it('goes back to the images of the build from before by its tag when Docker keeps no digest of them', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u11'), { STUB_BROKEN: '0.4.1', STUB_RUNNING_IMAGES: '' });
    expect(r.status).toMatchObject({ id: 'u11', state: 'rolled_back', step: 'finished' });
    expect(r.calls.filter(c => c.startsWith('installer'))[1]).toContain(`HORNHOOF_APP_REF=${APP}:0.4.0 HORNHOOF_NODE_REF=${APP}-node:0.4.0 HORNHOOF_UPDATER_REF=${APP}-updater:0.4.0`);
  });

  it('says what to do by hand when neither the new build nor the one before it answers', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u9'), { STUB_BROKEN: '0.4.1 0.4.0' });
    expect(r.status).toMatchObject({ id: 'u9', state: 'failed', step: 'finished' });
    expect(r.calls.filter(c => c.startsWith('installer')).map(c => c.match(/HORNHOOF_VERSION=(\S+)/)![1])).toEqual(['0.4.1', '0.4.0']);
    expect(r.status.log).toMatch(/0\.4\.1 did not answer/);
    expect(r.status.log).toContain(`Could not go back to 0.4.0 either. Run install.sh server in ${s.server}, and see docker compose logs app.`);
    expect(r.calls.some(c => c.includes('compose up -d --no-build updater'))).toBe(false);
  });

  it('puts the database back before the build from before starts on it, when the new build changed it', async () => {
    const s = stand();
    const r = await runOnce(s, ask('m1'), { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' });
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

  /* A link the company took on the new build is not in the saved database, while its name stays taken at hornhoof.org
     and its key is only in the tunnel's settings. */
  it("keeps the public link's settings next to the saved database before putting the database back", async () => {
    const s = stand();
    const settings = JSON.stringify({ url: 'https://acme.hornhoof.org', name: 'acme', key: 'k'.repeat(32), tunnel: {} });
    writeFileSync(join(s.control, 'tunnel.json'), settings, { mode: 0o600 });
    const r = await runOnce(s, ask('t1'), { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' });
    expect(r.status).toMatchObject({ id: 't1', state: 'rolled_back', step: 'finished' });
    const kept = readdirSync(join(s.server, 'backups')).filter(f => f.endsWith('.tunnel.json'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^hornhoof-\d{8}T\d{6}Z-t1\.tunnel\.json$/);
    expect(readFileSync(join(s.server, 'backups', kept[0]!), 'utf8')).toBe(settings);
    expect(statSync(join(s.server, 'backups', kept[0]!)).mode & 0o777).toBe(0o600);
    expect(r.status.log).toContain(`backups/${kept[0]}`);
    expect(r.status.log).toContain('guide/updates.md says how to take it back');
  });

  it("keeps no copy of the link's settings when the database stays as it is", async () => {
    const s = stand();
    writeFileSync(join(s.control, 'tunnel.json'), '{}', { mode: 0o600 });
    const r = await runOnce(s, ask('t2'), { STUB_BROKEN: '0.4.1' });
    expect(r.status.state).toBe('rolled_back');
    expect(readdirSync(join(s.server, 'backups')).filter(f => f.endsWith('.tunnel.json'))).toEqual([]);
  });

  it("lets a kept copy of the link's settings go with its database copy", async () => {
    const s = stand();
    writeFileSync(join(s.control, 'tunnel.json'), '{}', { mode: 0o600 });
    await runOnce(s, ask('t3'), { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' });
    const backups = join(s.server, 'backups');
    const first = readdirSync(backups).find(f => f.endsWith('.sql.gz'))!;
    utimesSync(join(backups, first), new Date(2026, 0, 1), new Date(2026, 0, 1));
    for (const id of ['t4', 't5', 't6']) expect((await runOnce(s, ask(id))).status.state).toBe('done');
    expect(readdirSync(backups).filter(f => f.includes('-t3.'))).toEqual([]);
    expect(readdirSync(backups)).toHaveLength(3);
  });

  /* The build from before may not know a service of the new one, as the tunnel, which would carry the public link
     on to a server that knows nothing of it. */
  it('removes the containers of services the compose file of the build it went back to does not name', async () => {
    const s = stand();
    const r = await runOnce(s, ask('o1'), { STUB_BROKEN: '0.4.1' });
    expect(r.status.state).toBe('rolled_back');
    const old = r.calls.findIndex(c => c.startsWith('installer') && c.includes('HORNHOOF_VERSION=0.4.0'));
    const orphans = r.calls.lastIndexOf('docker compose up -d --no-build --remove-orphans db');
    expect(old).toBeGreaterThanOrEqual(0);
    expect(orphans).toBeGreaterThan(old);
  });

  /* Without an updater in it, compose would take this updater for one of them. */
  it('removes nothing when that compose file names no updater', async () => {
    const s = stand();
    const r = await runOnce(s, ask('o2'), { STUB_BROKEN: '0.4.1', STUB_SERVICES: 'db app node' });
    expect(r.status.state).toBe('rolled_back');
    expect(r.calls.some(c => c.includes('--remove-orphans'))).toBe(false);
  });

  it('leaves the database as it is on the way back when the new build did not change it', async () => {
    const s = stand();
    const r = await runOnce(s, ask('m2'), { STUB_BROKEN: '0.4.1' });
    expect(r.status.state).toBe('rolled_back');
    expect(r.calls.some(c => c.startsWith('docker exec -i') || c.includes('hornhoof_restore'))).toBe(false);
  });

  it('does not start the build from before on a database it could not put back', async () => {
    const s = stand();
    const r = await runOnce(s, ask('m3'), { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21', STUB_RESTORE: 'fail' });
    expect(r.status).toMatchObject({ id: 'm3', state: 'failed', step: 'finished' });
    expect(r.calls.filter(c => c.startsWith('installer'))).toHaveLength(1);
    expect(r.calls.some(c => c.includes('RENAME TO hornhoof'))).toBe(false);
    expect(r.status.log).toMatch(/Could not put the database back from backups\/hornhoof-\d{8}T\d{6}Z-m3\.sql\.gz\./);
  });

  it('goes back to the build that ran when .env names none', async () => {
    const s = stand('HORNHOOF_SECRET=s\n');
    const r = await runOnce(s, ask('u3'), { STUB_BROKEN: '0.4.1', STUB_RUNNING_COMMIT: 'aaa', STUB_COMMITS: '0.4.0=aaa 0.4.1=bbb aaa=aaa' });
    expect(r.status.state).toBe('rolled_back');
    expect(r.calls.filter(c => c.startsWith('installer'))[1]).toContain('HORNHOOF_VERSION=aaa');
  });

  it('refuses a version that is not a version', async () => {
    const s = stand();
    const r = await runOnce(s, { ...ask('u4'), version: 'x', tag: '1.0;rm -rf /' });
    expect(r.status).toMatchObject({ id: 'u4', state: 'failed' });
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
  });

  it('refuses a request that does not name the exact build', async () => {
    const s = stand();
    for (const [id, digest] of [['d1', undefined], ['d2', 'latest'], ['d3', `sha256:${'b'.repeat(63)};`]] as const) {
      const r = await runOnce(s, { id, version: '0.4.1', tag: '0.4.1', ...(digest ? { digest } : {}) });
      expect(r.status).toMatchObject({ id, state: 'failed', step: 'finished' });
      expect(r.status.log).toContain('The request does not name the exact build to install, so nothing changed.');
    }
    expect(readFileSync(s.log, 'utf8')).not.toMatch(/^docker /m);
  });

  it('refuses a request whose node or updater image is not named by a digest', async () => {
    const s = stand();
    for (const [id, extra] of [['d4', { nodeDigest: 'latest' }], ['d5', { updaterDigest: `sha256:${'f'.repeat(63)};` }]] as const) {
      const r = await runOnce(s, { ...ask(id), ...extra });
      expect(r.status).toMatchObject({ id, state: 'failed', step: 'finished' });
      expect(r.status.log).toContain('The request does not name the exact build to install, so nothing changed.');
    }
    expect(readFileSync(s.log, 'utf8')).not.toMatch(/^docker /m);
  });

  it('installs the build Hornhoof read when its version points at another build by now', async () => {
    const s = stand();
    const moved = `sha256:${'9'.repeat(64)}`;
    const r = await runOnce(s, ask('d6'), { STUB_DIGESTS: `0.4.0=${DIGESTS['0.4.0']} 0.4.1=${moved} 0.4.1=${DIGESTS['0.4.1']}` });
    expect(r.status).toMatchObject({ id: 'd6', state: 'done', step: 'finished' });
    expect(r.calls.find(c => c.startsWith('installer'))).toContain(`HORNHOOF_APP_REF=${APP}@${DIGESTS['0.4.1']} `);
    expect(r.calls.some(c => c.includes(moved))).toBe(false);
  });

  it('takes the node and updater images by their tag for a build that has none by digest', async () => {
    const s = stand();
    const r = await runOnce(s, { ...ask('d7'), nodeDigest: '', updaterDigest: '' });
    expect(r.status).toMatchObject({ id: 'd7', state: 'done', step: 'finished' });
    const pinned = `HORNHOOF_APP_REF=${APP}@${DIGESTS['0.4.1']} HORNHOOF_NODE_REF=${APP}-node:0.4.1 HORNHOOF_UPDATER_REF=${APP}-updater:0.4.1`;
    expect(r.calls).toContain(`pull with HORNHOOF_VERSION=0.4.1 ${pinned}`);
    expect(r.calls.find(c => c.startsWith('installer'))).toContain(pinned);
    expect(r.calls.some(c => c.startsWith('docker run') && c.includes(`${APP}-updater:0.4.1 compose up -d --no-build updater`))).toBe(true);
  });

  it('changes nothing when the new build cannot be downloaded', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u5'), { STUB_PULL: 'fail' });
    expect(r.status).toMatchObject({ state: 'failed', step: 'pull' });
    expect(r.calls.some(c => c.startsWith('installer'))).toBe(false);
  });

  it('changes nothing when the other images of the new build cannot be downloaded', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u10'), { STUB_PULL: 'images' });
    expect(r.status).toMatchObject({ id: 'u10', state: 'failed', step: 'pull' });
    expect(r.status.log).toContain('Could not download the images of 0.4.1, so nothing changed.');
    expect(r.calls.some(c => c.startsWith('docker exec dbcid pg_dump') || c.startsWith('installer'))).toBe(false);
  });

  it('keeps three backups', async () => {
    const s = stand();
    for (const id of ['b1', 'b2', 'b3', 'b4']) expect((await runOnce(s, ask(id))).status.state).toBe('done');
    expect(readdirSync(join(s.server, 'backups'))).toHaveLength(3);
  });

  it('runs each request once', async () => {
    const s = stand();
    await runOnce(s, ask('u6'));
    const again = await runOnce(s, null);
    expect(again.calls.filter(c => c.startsWith('installer'))).toHaveLength(1);
    expect(again.status.id).toBe('u6');
  });

  it('finishes an update it was stopped in while the new build was installing', async () => {
    const s = stand();
    const stopped = await runOnce(s, ask('r1'), { STUB_STOP_IN: '0.4.1' });
    expect(stopped.status).toMatchObject({ id: 'r1', state: 'running', step: 'install' });
    const r = await runOnce(s, null);
    expect(r.status).toMatchObject({ id: 'r1', version: '0.4.1', state: 'done', step: 'finished' });
    expect(r.calls.filter(c => c.startsWith('installer')).map(c => c.match(/HORNHOOF_VERSION=(\S+)/)![1])).toEqual(['0.4.1']);
    expect(r.calls.some(c => c.includes('compose up -d --no-build updater') && c.includes(`hornhoof-updater@${UPDATER_DIGESTS['0.4.1']}`))).toBe(true);
    expect(r.status.log).toContain('The updater stopped during the update and goes on with it.');
    /* The stub log keeps the calls of every run on this stand. */
    expect((await runOnce(s, null)).calls.filter(c => c.startsWith('installer'))).toHaveLength(1);
    expect(readdirSync(join(s.server, 'backups')).filter(f => !f.endsWith('.sql.gz'))).toEqual([]);
  });

  it('starts an update it was stopped in over when nothing had changed yet', async () => {
    const s = stand();
    const stopped = await runOnce(s, ask('r0'), { STUB_STOP_IN: 'pull' });
    expect(stopped.status).toMatchObject({ id: 'r0', state: 'running', step: 'pull' });
    /* It stopped while downloading, before it saved the database. */
    expect(stopped.calls.some(c => c.startsWith('docker exec dbcid pg_dump'))).toBe(false);
    const r = await runOnce(s, null);
    expect(r.status).toMatchObject({ id: 'r0', state: 'done', step: 'finished' });
    expect(r.calls.filter(c => c.startsWith('docker exec dbcid pg_dump'))).toHaveLength(1);
    expect(r.calls.filter(c => c.startsWith('installer'))).toHaveLength(1);
  });

  it('goes back, with the saved database, from an update it was stopped in whose build does not answer', async () => {
    const s = stand();
    const env = { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' };
    await runOnce(s, ask('r2'), { ...env, STUB_STOP_IN: '0.4.1' });
    const r = await runOnce(s, null, env);
    expect(r.status).toMatchObject({ id: 'r2', state: 'rolled_back', step: 'finished' });
    expect(readFileSync(join(s.dir, 'migrations'), 'utf8')).toBe('20');
    expect(r.calls.filter(c => c.startsWith('installer')).map(c => c.match(/HORNHOOF_VERSION=(\S+)/)![1])).toEqual(['0.4.1', '0.4.0']);
    /* Its note keeps the images that ran before, since they run no more by now. */
    expect(r.calls.filter(c => c.startsWith('installer'))[1]).toContain(refs('0.4.0'));
  });

  it('finishes going back when it was stopped on the way back', async () => {
    const s = stand();
    const env = { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' };
    const stopped = await runOnce(s, ask('r3'), { ...env, STUB_STOP_IN: '0.4.0' });
    expect(stopped.status).toMatchObject({ id: 'r3', state: 'running', step: 'rollback' });
    const r = await runOnce(s, null, env);
    expect(r.status).toMatchObject({ id: 'r3', state: 'rolled_back', step: 'finished' });
    expect(readFileSync(join(s.dir, 'migrations'), 'utf8')).toBe('20');
    /* 0.4.1 went in on the first run; the second one only puts 0.4.0 in. */
    expect(r.calls.filter(c => c.startsWith('installer')).map(c => c.match(/HORNHOOF_VERSION=(\S+)/)![1])).toEqual(['0.4.1', '0.4.0']);
    expect(r.status.log).toContain('The database was saved before it.');
  });

  it('marks an update it was stopped in as failed when it kept no note of it', async () => {
    const s = stand();
    writeFileSync(join(s.control, 'request.json'), JSON.stringify({ id: 'u7', version: '0.4.1', tag: '0.4.1' }));
    writeFileSync(join(s.control, 'status.json'), JSON.stringify({ id: 'u7', version: '0.4.1', state: 'running', step: 'install', log: '', at: '2026-10-30T00:00:00Z' }));
    const r = await runOnce(s, null);
    expect(r.status).toMatchObject({ id: 'u7', state: 'failed' });
    expect(r.status.log).toMatch(/stopped/);
  });

  describe('nodes on another image than the build names', () => {
    const KEY = 'the-built-in-node-key';
    const builtOn041 = `HORNHOOF_SECRET=s\nNODE_KEY=${KEY}\nHORNHOOF_VERSION=0.4.1\n${refs('0.4.1').replace(/ /g, '\n')}\n`;
    /* What an update from before this leaves behind: the new app and its .env, and the node on the old image. */
    const behind = () => stand(builtOn041);
    const running041 = { STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.1']} node=${APP}-node@${NODE_DIGESTS['0.4.0']}`, STUB_COMMITS: '0.4.0=aaa 0.4.1=bbb' };
    const installs = (calls: string[]) => calls.filter(c => c.startsWith('installer server'));
    const asked = (calls: string[], method: string) => calls.filter(c => c.startsWith('curl') && c.includes('/api/nodes/update') && c.includes(`-X ${method}`));

    it('changes nothing while their work runs, and keeps the key off the command line', async () => {
      const s = behind();
      const r = await runOnce(s, null, { ...running041, STUB_NODES: 'waiting' });
      expect(r.code).toBe(0);
      expect(asked(r.calls, 'POST')).toHaveLength(1);
      expect(asked(r.calls, 'POST')[0]).toContain('http://app:8080/api/nodes/update');
      expect(asked(r.calls, 'POST')[0]).toContain('{"scope":"server","nodes":["builtin"]}');
      expect(installs(r.calls)).toEqual([]);
      expect(r.calls.join('\n')).not.toContain(KEY);
      expect(readFileSync(join(s.dir, 'curl-config'), 'utf8')).toBe(`header = "Authorization: Bearer ${KEY}"\n`);
      expect(asked(r.calls, 'DELETE')).toEqual([]);
    });

    it('changes nothing either when the wait ran out, and asks on, so the update repeats by itself', async () => {
      const s = behind();
      expect(installs((await runOnce(s, null, { ...running041, STUB_NODES: 'postponed' })).calls)).toEqual([]);
      expect(installs((await runOnce(s, null, { ...running041, STUB_NODES: 'ready' })).calls)).toHaveLength(1);
    });

    it('finishes the step from 0.6.1: the new updater replaces them through that build\'s installer once they are free, and lets go of them', async () => {
      const s = behind();
      const r = await runOnce(s, null, { ...running041, STUB_NODES: 'ready' });
      expect(r.code).toBe(0);
      expect(r.calls).toContain('installer told the nodes are free');
      expect(at(r.calls, `docker create ${APP}@${DIGESTS['0.4.1']}`)).toBeGreaterThanOrEqual(0);
      const [install] = installs(r.calls) as [string];
      expect(install).toContain(`HORNHOOF_VERSION=0.4.1 HORNHOOF_FROM_UPDATER=1`);
      expect(install).toContain(refs('0.4.1'));
      expect(at(r.calls, 'curl')).toBeLessThan(r.calls.indexOf('installer told the nodes are free'));
      expect(r.calls.indexOf(asked(r.calls, 'DELETE')[0]!)).toBeGreaterThan(r.calls.indexOf(install));
      expect(r.status).toBeNull();
    });

    it('lets go of them when the installer fails, and stays up', async () => {
      const s = behind();
      const r = await runOnce(s, null, { ...running041, STUB_NODES: 'ready', STUB_INSTALLER_FAILS: '1' });
      expect(r.code).toBe(0);
      expect(asked(r.calls, 'DELETE')).toHaveLength(1);
      expect(r.out).toContain('Could not replace the nodes');
    });

    it('asks nothing when the built-in node runs the image the build names', async () => {
      const s = behind();
      const r = await runOnce(s, null, { STUB_RUNNING_IMAGES: `node=${APP}-node@${NODE_DIGESTS['0.4.1']}` });
      expect(asked(r.calls, 'POST')).toEqual([]);
      expect(installs(r.calls)).toEqual([]);
    });

    it('asks nothing when no built-in node runs', async () => {
      const r = await runOnce(behind(), null, { STUB_NO_NODE: '1' });
      expect(asked(r.calls, 'POST')).toEqual([]);
    });

    it('asks nothing for a server that install.sh did not set up, or whose .env names no node image', async () => {
      expect(asked((await runOnce(stand(), null, running041)).calls, 'POST')).toEqual([]);
    });

    it('leaves them and their turns on a server from before this wait, and says why', async () => {
      const r = await runOnce(behind(), null, { ...running041, STUB_NODES: 'old' });
      expect(r.code).toBe(0);
      expect(installs(r.calls)).toEqual([]);
      expect(r.out).toContain('This server is from before nodes wait for their work');
    });

    it.each(['down', 'refused'])('leaves them and their turns when the server is %s, and stays up', async state => {
      const r = await runOnce(behind(), null, { ...running041, STUB_NODES: state });
      expect(r.code).toBe(0);
      expect(installs(r.calls)).toEqual([]);
    });

    it('never starts an image that is not its own from what .env names', async () => {
      const s = stand(builtOn041.replace(`${APP}@`, 'ghcr.io/acme/other@'));
      const r = await runOnce(s, null, { ...running041, STUB_NODES: 'ready' });
      expect(r.code).toBe(0);
      expect(asked(r.calls, 'POST')).toEqual([]);
      expect(installs(r.calls)).toEqual([]);
    });

    describe('each by itself', () => {
      const OLD = `${APP}-node@${NODE_DIGESTS['0.4.0']}`;
      const NEW = `${APP}-node@${NODE_DIGESTS['0.4.1']}`;
      const CLAUDE = '11111111-1111-4111-8111-111111111111';
      const GOOGLE = '22222222-2222-4222-8222-222222222222';
      const onNew = { STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.1']} node=${NEW}` };
      const plans = (claude: string, google: string) => ({ STUB_PLAN_NODES: `hornhoof-claude-1=${CLAUDE}=${claude} hornhoof-antigravity-2=${GOOGLE}=${google}` });
      const only = (calls: string[]) => calls.filter(c => c.startsWith('installer told only'));
      const body = (names: string[]) => JSON.stringify({ scope: 'server', nodes: names });

      it('replaces the free ones at once and leaves the one with a long turn to its wait, asking of each', async () => {
        const r = await runOnce(behind(), null, { ...running041, ...plans(OLD, OLD), STUB_NODES: 'each', STUB_FREE: `builtin ${CLAUDE}` });
        expect(r.code).toBe(0);
        expect(asked(r.calls, 'POST')[0]).toContain(body(['builtin', CLAUDE, GOOGLE]));
        expect(only(r.calls)).toEqual([`installer told only builtin ${CLAUDE}`]);
        expect(installs(r.calls)).toHaveLength(1);
        expect(installs(r.calls)[0]).toContain(refs('0.4.1'));
      });

      it('lets go only of those it replaced, so the one that waits keeps its deadline', async () => {
        const r = await runOnce(behind(), null, { ...running041, ...plans(OLD, OLD), STUB_NODES: 'each', STUB_FREE: `builtin ${CLAUDE}` });
        expect(asked(r.calls, 'DELETE')).toHaveLength(1);
        expect(asked(r.calls, 'DELETE')[0]).toContain(body(['builtin', CLAUDE]));
        expect(r.calls.indexOf(asked(r.calls, 'DELETE')[0]!)).toBeGreaterThan(r.calls.indexOf(installs(r.calls)[0]!));
      });

      it('asks on about the one that waits and no more about those on the new image, which take work again', async () => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(NEW, OLD), STUB_NODES: 'each', STUB_FREE: '' });
        expect(asked(r.calls, 'POST')[0]).toContain(body([GOOGLE]));
        expect(installs(r.calls)).toEqual([]);
        expect(asked(r.calls, 'DELETE')).toEqual([]);
      });

      it('replaces a node behind though the built-in node runs the new image', async () => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(NEW, OLD), STUB_NODES: 'each', STUB_FREE: GOOGLE });
        expect(only(r.calls)).toEqual([`installer told only ${GOOGLE}`]);
      });

      it('asks nothing when every node runs the image the build names', async () => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(NEW, NEW), STUB_NODES: 'each' });
        expect(asked(r.calls, 'POST')).toEqual([]);
      });

      it('replaces only what it found behind itself, whatever the server names', async () => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(OLD, NEW), STUB_NODES: 'each', STUB_FREE: `${CLAUDE} ${GOOGLE} builtin a-plan-of-another-server ;reboot` });
        expect(only(r.calls)).toEqual([`installer told only ${CLAUDE}`]);
        expect(asked(r.calls, 'DELETE')[0]).toContain(body([CLAUDE]));
      });

      it('installs nothing and lets go of nothing when the server names none, as for nodes that are not its own', async () => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(OLD, OLD), STUB_NODES: 'each', STUB_FREE: '' });
        expect(r.code).toBe(0);
        expect(installs(r.calls)).toEqual([]);
        expect(asked(r.calls, 'DELETE')).toEqual([]);
      });

      it('never asks about a label that is not a plain id', async () => {
        const r = await runOnce(behind(), null, { ...onNew, STUB_PLAN_NODES: `hornhoof-odd-1=a;reboot=${OLD} hornhoof-claude-1=${CLAUDE}=${OLD}`, STUB_NODES: 'each', STUB_FREE: CLAUDE });
        expect(asked(r.calls, 'POST')[0]).toContain(body([CLAUDE]));
        expect(r.calls.join('\n')).not.toContain('reboot');
      });

      it('lets go of those it tried when the installer fails, stays up, and leaves the others to their wait', async () => {
        const r = await runOnce(behind(), null, { ...running041, ...plans(OLD, OLD), STUB_NODES: 'each', STUB_FREE: 'builtin', STUB_INSTALLER_FAILS: '1' });
        expect(r.code).toBe(0);
        expect(asked(r.calls, 'DELETE')).toHaveLength(1);
        expect(asked(r.calls, 'DELETE')[0]).toContain(body(['builtin']));
        expect(r.out).toContain('Could not replace the nodes');
      });

      it('replaces them all together on a server from before this, which says only that all are free', async () => {
        const r = await runOnce(behind(), null, { ...running041, ...plans(OLD, OLD), STUB_NODES: 'ready' });
        expect(r.calls).toContain('installer told the nodes are free');
        expect(only(r.calls)).toEqual([]);
        expect(asked(r.calls, 'DELETE')[0]).toContain('{"scope":"server"}');
      });

      it.each(['ready', 'waiting'])('lets go of them on a server from before this that says %s when the built-in node is on the new image: its installer would move none', async state => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(OLD, OLD), STUB_NODES: state });
        expect(r.code).toBe(0);
        expect(installs(r.calls)).toEqual([]);
        expect(asked(r.calls, 'DELETE')).toHaveLength(1);
        expect(asked(r.calls, 'DELETE')[0]).toContain('{"scope":"server"}');
      });
    });
  });

  describe('the nodes during an update', () => {
    const told = 'installer told the nodes are free';

    it('leaves them to the wait in a planned update', async () => {
      const r = await runOnce(stand(), ask('p1'));
      expect(r.status).toMatchObject({ state: 'done' });
      expect(r.calls).not.toContain(told);
    });

    it.each([['urgent', { urgent: true }], ['confirmed', { immediate: true }]])('replaces them with the app in an %s update', async (_name, flag) => {
      const r = await runOnce(stand(), { ...ask('n1'), ...flag });
      expect(r.status).toMatchObject({ state: 'done' });
      expect(r.calls.indexOf(told)).toBeGreaterThanOrEqual(0);
      expect(r.calls.indexOf(told)).toBeLessThan(at(r.calls, 'installer server'));
    });

    it('still replaces them when it goes on with such an update after being stopped', async () => {
      const s = stand();
      await runOnce(s, { ...ask('n2'), urgent: true }, { STUB_STOP_IN: '0.4.1' });
      writeFileSync(s.log, '');
      const r = await runOnce(s, null);
      expect(r.status).toMatchObject({ id: 'n2', state: 'done' });
      expect(r.calls).toContain(told);
    });

    it('puts the nodes from before back too when such an update goes back', async () => {
      const r = await runOnce(stand(), { ...ask('n3'), urgent: true }, { STUB_BROKEN: '0.4.1' });
      expect(r.status).toMatchObject({ state: 'rolled_back' });
      expect(r.calls.filter(c => c === told)).toHaveLength(2);
    });

    it('does not carry that over to a later planned update', async () => {
      const s = stand();
      await runOnce(s, { ...ask('n4'), urgent: true });
      writeFileSync(s.log, '');
      const r = await runOnce(s, { ...ask('n5') });
      expect(r.status).toMatchObject({ id: 'n5', state: 'done' });
      expect(r.calls).not.toContain(told);
    });
  });

  it('refuses to update a Hornhoof that install.sh did not set up', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u8'), { HORNHOOF_SERVER_DIR: '' });
    expect(r.status).toMatchObject({ state: 'failed' });
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
  });
});

/* The orchestrator's commands on the server's computer, while the CEO keeps access to it open. */
describe('updater, the computer', () => {
  const HELPER = `${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`;
  /* The watch over a command counts its seconds as the stubs let them pass, with no clock. */
  const env = { HORNHOOF_COMPUTER_IMAGE: HELPER, STUB_WATCH: '1' };
  function access(s: Stand, untilSec: number) {
    writeFileSync(join(s.control, 'computer.json'), JSON.stringify({ untilSec, until: new Date(untilSec * 1000).toISOString(), asked: null }));
  }
  function command(s: Stand, id: string, run: string, timeout = 60) {
    mkdirSync(join(s.control, 'computer'), { recursive: true });
    writeFileSync(join(s.control, 'computer', `${id}.json`), JSON.stringify({ id, command: run, timeout }));
  }
  const answer = (s: Stand, id: string) => {
    const file = join(s.control, 'computer', `${id}.out.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const later = () => Math.floor(Date.now() / 1000) + 3600;

  it('runs a command as root on the computer, with its files at /host and its Docker, and answers with the output and exit code', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c1', 'uname -a');
    const r = await runOnce(s, null, { ...env, STUB_COMPUTER_EXIT: '3' });
    /* Made first and then started, so the watch can always stop it. */
    const made = r.calls.indexOf(
      `docker create --rm --name hornhoof-computer-c1 --privileged --pid=host --network=host --ipc=host --uts=host -v /:/host -v /var/run/docker.sock:/var/run/docker.sock --entrypoint bash ${HELPER} -c uname -a`,
    );
    expect(made).toBeGreaterThanOrEqual(0);
    expect(r.calls.indexOf('docker start -a hornhoof-computer-c1')).toBeGreaterThan(made);
    expect(answer(s, 'c1')).toEqual({ id: 'c1', exit: 3, output: 'ran: uname -a\n' });
    expect(existsSync(join(s.control, 'computer', 'c1.started'))).toBe(false);
    /* An answered command does not run again: the stub's log keeps the first run only. */
    expect((await runOnce(s, null, env)).calls.filter(c => c.startsWith('docker start'))).toHaveLength(1);
  });

  it('runs nothing while access is closed or over, and says so', async () => {
    const s = stand();
    access(s, Math.floor(Date.now() / 1000) - 1);
    command(s, 'c2', 'rm -rf /host/etc');
    const r = await runOnce(s, null, env);
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
    expect(answer(s, 'c2')).toEqual({ id: 'c2', exit: 126, output: 'Access to the computer is closed.\n' });
    /* Closed while its container was being made: it never starts. */
    const u = stand();
    access(u, later());
    command(u, 'c8', 'rm -rf /host/var/lib/docker');
    const raced = await runOnce(u, null, { ...env, STUB_CLOSE_ON_CREATE: '1' });
    expect(raced.calls).toContain('docker rm -f hornhoof-computer-c8');
    expect(raced.calls.filter(c => c.startsWith('docker start'))).toEqual([]);
    expect(answer(u, 'c8')).toMatchObject({ exit: 125, output: expect.stringContaining('Stopped: access to the computer was closed.') });
    const t = stand();
    command(t, 'c3', 'uname -a');
    expect((await runOnce(t, null, env)).calls.filter(c => c.startsWith('docker'))).toEqual([]);
    expect(answer(t, 'c3')).toMatchObject({ exit: 126 });
  });

  it('stops a command at its time', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c4', 'sleep 600', 1);
    const r = await runOnce(s, null, { ...env, STUB_COMPUTER_RUNS: '1' });
    expect(r.calls).toContain('docker rm -f hornhoof-computer-c4');
    expect(answer(s, 'c4')).toMatchObject({ id: 'c4', exit: 124, output: expect.stringContaining('Stopped after 1 seconds.') });
  });

  it('stops a running command when the CEO closes access', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c6', 'apt-get upgrade -y', 60);
    const r = await runOnce(s, null, { ...env, STUB_COMPUTER_RUNS: '1', STUB_COMPUTER_CLOSES: '1' });
    expect(r.calls).toContain('docker rm -f hornhoof-computer-c6');
    expect(answer(s, 'c6')).toMatchObject({ id: 'c6', exit: 125, output: expect.stringContaining('Stopped: access to the computer was closed.') });
  });

  it('runs no command a second time after it restarted, and stops what still runs of it', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c7', 'apt-get upgrade -y');
    writeFileSync(join(s.control, 'computer', 'c7.started'), '');
    const r = await runOnce(s, null, env);
    expect(r.calls).toEqual(['docker rm -f hornhoof-computer-c7']);
    expect(answer(s, 'c7')).toMatchObject({ id: 'c7', exit: 125, output: expect.stringContaining('The updater restarted while this command ran') });
    expect(existsSync(join(s.control, 'computer', 'c7.started'))).toBe(false);
  });

  it('stops a command it started whose request the app took back', async () => {
    const s = stand();
    mkdirSync(join(s.control, 'computer'));
    writeFileSync(join(s.control, 'computer', 'c9.started'), '');
    expect((await runOnce(s, null, env)).calls).toEqual(['docker rm -f hornhoof-computer-c9']);
    expect(readdirSync(join(s.control, 'computer'))).toEqual([]);
  });

  it('leaves alone a command file whose name is not a plain id', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c5;x', 'uname -a');
    expect((await runOnce(s, null, env)).calls.filter(c => c.startsWith('docker'))).toEqual([]);
  });
});
