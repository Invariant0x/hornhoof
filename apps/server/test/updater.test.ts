import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../updater/updater.sh', import.meta.url));
/* The updater from before revision 2, which starts the update that moves an install in. */
const REV1 = fileURLToPath(new URL('./updater-rev1.sh', import.meta.url));
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

/* One run of an updater, with stub docker and curl first on PATH. */
function run(script: string, flag: string, s: Stand, env: Record<string, string>) {
  const res = spawnSync('bash', [script, flag], {
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
      STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.0']} node=${APP}-node@${NODE_DIGESTS['0.4.0']} updater=${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`,
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

/* One pass of an updater over request.json. */
function pass(script: string, s: Stand, request: object | null, env: Record<string, string>) {
  if (request) writeFileSync(join(s.control, 'request.json'), JSON.stringify(request));
  return run(script, '--once', s, env);
}

const runOnce = (s: Stand, request: object | null, env: Record<string, string> = {}) => pass(SCRIPT, s, request, env);
const runRev1 = (s: Stand, request: object | null, env: Record<string, string> = {}) => pass(REV1, s, request, env);
/* The helper container this build's installer starts when an older updater runs it. */
const takeOver = (s: Stand, env: Record<string, string> = {}) => run(SCRIPT, '--take-over', s, env);

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

  it('skips pulling the node image when the node container runs that exact digest already', () => {
    const s = stand();
    const r = runOnce(s, { ...ask('n1'), nodeDigest: NODE_DIGESTS['0.4.0'] }, { STUB_SERVICES: 'db app node tunnel updater' });
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
    const m = runOnce(missing, { ...ask('n2'), nodeDigest: NODE_DIGESTS['0.4.0'] }, { STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.0']} updater=${APP}-updater@${UPDATER_DIGESTS['0.4.0']}` });
    expect(m.status).toMatchObject({ id: 'n2', state: 'done', step: 'finished' });
    expect(m.calls.some(c => c.endsWith('/0.4.1/compose.yaml pull'))).toBe(true);
  });

  it('rolls back when the new server never answers', () => {
    const s = stand();
    const r = runOnce(s, ask('u2'), { STUB_BROKEN: '0.4.1' });
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

  it('goes back to the images of the build from before by its tag when Docker keeps no digest of them', () => {
    const s = stand();
    const r = runOnce(s, ask('u11'), { STUB_BROKEN: '0.4.1', STUB_RUNNING_IMAGES: '' });
    expect(r.status).toMatchObject({ id: 'u11', state: 'rolled_back', step: 'finished' });
    expect(r.calls.filter(c => c.startsWith('installer'))[1]).toContain(`HORNHOOF_APP_REF=${APP}:0.4.0 HORNHOOF_NODE_REF=${APP}-node:0.4.0 HORNHOOF_UPDATER_REF=${APP}-updater:0.4.0`);
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

  /* A link the company took on the new build is not in the saved database, while its name stays taken at hornhoof.org
     and its key is only in the tunnel's settings. */
  it("keeps the public link's settings next to the saved database before putting the database back", () => {
    const s = stand();
    const settings = JSON.stringify({ url: 'https://acme.hornhoof.org', name: 'acme', key: 'k'.repeat(32), tunnel: {} });
    writeFileSync(join(s.control, 'tunnel.json'), settings, { mode: 0o600 });
    const r = runOnce(s, ask('t1'), { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' });
    expect(r.status).toMatchObject({ id: 't1', state: 'rolled_back', step: 'finished' });
    const kept = readdirSync(join(s.server, 'backups')).filter(f => f.endsWith('.tunnel.json'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^hornhoof-\d{8}T\d{6}Z-t1\.tunnel\.json$/);
    expect(readFileSync(join(s.server, 'backups', kept[0]!), 'utf8')).toBe(settings);
    expect(statSync(join(s.server, 'backups', kept[0]!)).mode & 0o777).toBe(0o600);
    expect(r.status.log).toContain(`backups/${kept[0]}`);
    expect(r.status.log).toContain('guide/updates.md says how to take it back');
  });

  it("keeps no copy of the link's settings when the database stays as it is", () => {
    const s = stand();
    writeFileSync(join(s.control, 'tunnel.json'), '{}', { mode: 0o600 });
    const r = runOnce(s, ask('t2'), { STUB_BROKEN: '0.4.1' });
    expect(r.status.state).toBe('rolled_back');
    expect(readdirSync(join(s.server, 'backups')).filter(f => f.endsWith('.tunnel.json'))).toEqual([]);
  });

  it("lets a kept copy of the link's settings go with its database copy", () => {
    const s = stand();
    writeFileSync(join(s.control, 'tunnel.json'), '{}', { mode: 0o600 });
    runOnce(s, ask('t3'), { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' });
    const backups = join(s.server, 'backups');
    const first = readdirSync(backups).find(f => f.endsWith('.sql.gz'))!;
    utimesSync(join(backups, first), new Date(2026, 0, 1), new Date(2026, 0, 1));
    for (const id of ['t4', 't5', 't6']) expect(runOnce(s, ask(id)).status.state).toBe('done');
    expect(readdirSync(backups).filter(f => f.includes('-t3.'))).toEqual([]);
    expect(readdirSync(backups)).toHaveLength(3);
  });

  /* The build from before may not know a service of the new one, as the tunnel, which would carry the public link
     on to a server that knows nothing of it. */
  it('removes the containers of services the compose file of the build it went back to does not name', () => {
    const s = stand();
    const r = runOnce(s, ask('o1'), { STUB_BROKEN: '0.4.1' });
    expect(r.status.state).toBe('rolled_back');
    const old = r.calls.findIndex(c => c.startsWith('installer') && c.includes('HORNHOOF_VERSION=0.4.0'));
    const orphans = r.calls.lastIndexOf('docker compose up -d --no-build --remove-orphans db');
    expect(old).toBeGreaterThanOrEqual(0);
    expect(orphans).toBeGreaterThan(old);
  });

  /* Without an updater in it, compose would take this updater for one of them. */
  it('removes nothing when that compose file names no updater', () => {
    const s = stand();
    const r = runOnce(s, ask('o2'), { STUB_BROKEN: '0.4.1', STUB_SERVICES: 'db app node' });
    expect(r.status.state).toBe('rolled_back');
    expect(r.calls.some(c => c.includes('--remove-orphans'))).toBe(false);
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

  it('refuses a request whose node or updater image is not named by a digest', () => {
    const s = stand();
    for (const [id, extra] of [['d4', { nodeDigest: 'latest' }], ['d5', { updaterDigest: `sha256:${'f'.repeat(63)};` }]] as const) {
      const r = runOnce(s, { ...ask(id), ...extra });
      expect(r.status).toMatchObject({ id, state: 'failed', step: 'finished' });
      expect(r.status.log).toContain('The request does not name the exact build to install, so nothing changed.');
    }
    expect(readFileSync(s.log, 'utf8')).not.toMatch(/^docker /m);
  });

  it('installs the build Hornhoof read when its version points at another build by now', () => {
    const s = stand();
    const moved = `sha256:${'9'.repeat(64)}`;
    const r = runOnce(s, ask('d6'), { STUB_DIGESTS: `0.4.0=${DIGESTS['0.4.0']} 0.4.1=${moved} 0.4.1=${DIGESTS['0.4.1']}` });
    expect(r.status).toMatchObject({ id: 'd6', state: 'done', step: 'finished' });
    expect(r.calls.find(c => c.startsWith('installer'))).toContain(`HORNHOOF_APP_REF=${APP}@${DIGESTS['0.4.1']} `);
    expect(r.calls.some(c => c.includes(moved))).toBe(false);
  });

  it('takes the node and updater images by their tag for a build that has none by digest', () => {
    const s = stand();
    const r = runOnce(s, { ...ask('d7'), nodeDigest: '', updaterDigest: '' });
    expect(r.status).toMatchObject({ id: 'd7', state: 'done', step: 'finished' });
    const pinned = `HORNHOOF_APP_REF=${APP}@${DIGESTS['0.4.1']} HORNHOOF_NODE_REF=${APP}-node:0.4.1 HORNHOOF_UPDATER_REF=${APP}-updater:0.4.1`;
    expect(r.calls).toContain(`pull with HORNHOOF_VERSION=0.4.1 ${pinned}`);
    expect(r.calls.find(c => c.startsWith('installer'))).toContain(pinned);
    expect(r.calls.some(c => c.startsWith('docker run') && c.includes(`${APP}-updater:0.4.1 compose up -d --no-build updater`))).toBe(true);
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
    expect(r.calls.some(c => c.includes('compose up -d --no-build updater') && c.includes(`hornhoof-updater@${UPDATER_DIGESTS['0.4.1']}`))).toBe(true);
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
    /* Its note keeps the images that ran before, since they run no more by now. */
    expect(r.calls.filter(c => c.startsWith('installer'))[1]).toContain(refs('0.4.0'));
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

/* What revision 2 changes: the copy of the database, the services a build does not name, a time limit on each install,
   where health is asked, and an update an older updater began. */
describe('updater, revision 2', () => {
  /* 0.4.1 has moved in; 0.4.0 is a build from before front. */
  const BUILDS = { STUB_BUILD_SERVICES: '0.4.1=db,app,front,keeper,migrate,node,updater 0.4.0=db,app,node,tunnel,updater' };
  const TODAY = 'c-db=db c-app=app c-tunnel=tunnel c-up=updater';
  const MOVED_IN = `${TODAY} c-front=front c-keeper=keeper c-migrate=migrate`;
  /* An older updater runs an installer that hands the update over; the new build then does not answer. */
  const HAND_OVER = { ...BUILDS, STUB_HANDS_OVER: '0.4.1', STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21', STUB_PROJECT_CONTAINERS: TODAY };
  /* Once this build's updater runs the install, the containers of the new build are there too. */
  const NEW_UPDATER = { ...HAND_OVER, STUB_PROJECT_CONTAINERS: MOVED_IN };
  const GOES_ON = "This build's updater goes on with the update.";
  const NO_START = "This build's updater did not start, so the build from before goes back.";

  const installerOf = (calls: string[], tag: string) => calls.findIndex(c => c.startsWith('installer server') && c.includes(`HORNHOOF_VERSION=${tag} `));
  const installers = (calls: string[]) => calls.filter(c => c.startsWith('installer server')).map(c => c.match(/HORNHOOF_VERSION=(\S+)/)![1]);
  const curls = (calls: string[]) => calls.filter(c => c.startsWith('curl'));
  const removals = (calls: string[]) => calls.filter(c => c.startsWith('docker rm -f'));
  const readState = (s: Stand, name: string) => readFileSync(join(s.dir, name), 'utf8').trim();
  const envOf = (s: Stand) => readFileSync(join(s.server, '.env'), 'utf8');
  const noteOf = (s: Stand) => JSON.parse(readFileSync(join(s.server, 'backups', 'update.json'), 'utf8'));
  const statusFile = (s: Stand) => join(s.control, 'status.json');
  function editStatus(s: Stand, change: object) {
    writeFileSync(statusFile(s), JSON.stringify({ ...JSON.parse(readFileSync(statusFile(s), 'utf8')), ...change }));
  }
  /* An older updater began the update and its installer handed it over, so that updater is gone. */
  function handedOver(id: string, env: Record<string, string> = HAND_OVER) {
    const s = stand();
    const first = runRev1(s, ask(id), env);
    expect(first.status).toMatchObject({ id, state: 'running', step: 'install' });
    expect(first.calls).toContain('installer hands over');
    return { s, first };
  }

  it("tells each build's installer that this updater is revision 2", () => {
    const r = runOnce(stand(), ask('v1'), { ...BUILDS, STUB_BROKEN: '0.4.1', STUB_PROJECT_CONTAINERS: MOVED_IN });
    expect(installers(r.calls)).toEqual(['0.4.1', '0.4.0']);
    for (const line of r.calls.filter(c => c.startsWith('installer server'))) expect(line).toContain('HORNHOOF_UPDATER_REV=2');
  });

  it('keeps its revision in the note of the update', () => {
    const s = stand();
    const stopped = runOnce(s, ask('v2'), { ...BUILDS, STUB_STOP_IN: '0.4.1' });
    expect(stopped.status).toMatchObject({ state: 'running', step: 'install' });
    expect(noteOf(s).rev).toBe('2');
  });

  it('stops the app before it saves the database, and starts it again when the copy fails', () => {
    const ok = runOnce(stand(), ask('v3'), BUILDS);
    expect(ok.status.state).toBe('done');
    const stop = at(ok.calls, 'docker compose stop app');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(at(ok.calls, 'docker exec dbcid pg_dump'));
    expect(ok.calls).not.toContain('docker start appcid');

    const s = stand();
    const r = runOnce(s, ask('v4'), { ...BUILDS, STUB_DUMP: 'fail' });
    expect(r.status).toMatchObject({ id: 'v4', state: 'failed', step: 'backup' });
    expect(r.status.log).toContain('Could not save the database, so nothing changed.');
    expect(at(r.calls, 'docker start appcid')).toBeGreaterThan(at(r.calls, 'docker exec dbcid pg_dump'));
    expect(r.calls.some(c => c.startsWith('installer'))).toBe(false);
    expect(readdirSync(join(s.server, 'backups')).filter(f => f.endsWith('.sql.gz'))).toEqual([]);
  });

  /* The app is stopped for the copy, and starting over means nothing changed yet. A download that fails on the way
     says so, which would be untrue with the company's app left stopped. */
  it('starts the app it stopped again when it was stopped while saving the database', () => {
    const s = stand();
    const stopped = runOnce(s, ask('v5'), { STUB_STOP_IN: 'pull' });
    editStatus(s, { step: 'backup' });
    const r = runOnce(s, null, { STUB_PULL: 'fail' });
    expect(r.status).toMatchObject({ id: 'v5', state: 'failed', step: 'pull' });
    const calls = r.calls.slice(stopped.calls.length);
    expect(at(calls, 'docker start appcid')).toBeGreaterThanOrEqual(0);
    expect(at(calls, 'docker start appcid')).toBeLessThan(at(calls, 'docker pull'));
  });

  it('leaves the app alone when it was stopped before the copy began', () => {
    const s = stand();
    runOnce(s, ask('v6'), { STUB_STOP_IN: 'pull' });
    expect(runOnce(s, null).calls).not.toContain('docker start appcid');
  });

  it('removes the containers of services the new build does not name, before its installer runs', () => {
    const r = runOnce(stand(), ask('v7'), { ...BUILDS, STUB_PROJECT_CONTAINERS: TODAY });
    expect(r.status.state).toBe('done');
    const removed = r.calls.indexOf('docker rm -f c-tunnel');
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(removed).toBeLessThan(installerOf(r.calls, '0.4.1'));
    expect(removals(r.calls)).toEqual(['docker rm -f c-tunnel']);
  });

  it('looks for those containers in the compose project of this server', () => {
    const filter = (project: string) => `docker ps -a --filter label=com.docker.compose.project=${project} --format {{.ID}} {{.Label "com.docker.compose.service"}}`;
    const named = stand('HORNHOOF_SECRET=s\nHORNHOOF_VERSION=0.4.0\nCOMPOSE_PROJECT_NAME=hornhoof-acme\n');
    expect(runOnce(named, ask('p1'), { ...BUILDS, COMPOSE_PROJECT_NAME: 'hornhoof-other' }).calls).toContain(filter('hornhoof-acme'));
    expect(runOnce(stand(), ask('p2'), { ...BUILDS, COMPOSE_PROJECT_NAME: 'hornhoof-other' }).calls).toContain(filter('hornhoof-other'));
    expect(runOnce(stand(), ask('p3'), BUILDS).calls).toContain(filter('hornhoof'));
  });

  it('leaves alone a container that has no service, and one of a service the build names', () => {
    const r = runOnce(stand(), ask('v8'), { ...BUILDS, STUB_PROJECT_CONTAINERS: 'c-none= c-node=node' });
    expect(removals(r.calls)).toEqual([]);
  });

  it('says so and goes on with the install when a container cannot be removed', () => {
    const r = runOnce(stand(), ask('v9'), { ...BUILDS, STUB_PROJECT_CONTAINERS: TODAY, STUB_RM_FAILS: 'c-tunnel' });
    expect(r.status.state).toBe('done');
    expect(r.status.log).toContain('Could not remove the container of tunnel, a service this build does not name.');
    expect(installers(r.calls)).toEqual(['0.4.1']);
  });

  it('goes back to a build from before front even though front held the web port', () => {
    const r = runOnce(stand(), ask('v10'), { ...BUILDS, STUB_BROKEN: '0.4.1', STUB_PROJECT_CONTAINERS: MOVED_IN });
    expect(r.status).toMatchObject({ id: 'v10', state: 'rolled_back', step: 'finished' });
    const check = at(r.calls, 'curl');
    const old = installerOf(r.calls, '0.4.0');
    expect(check).toBeGreaterThanOrEqual(0);
    for (const id of ['c-front', 'c-keeper', 'c-migrate']) {
      expect(r.calls.indexOf(`docker rm -f ${id}`)).toBeGreaterThan(check);
      expect(r.calls.indexOf(`docker rm -f ${id}`)).toBeLessThan(old);
    }
  });

  it("removes nothing when the build's compose file names no updater", () => {
    const r = runOnce(stand(), ask('v11'), { STUB_BUILD_SERVICES: '0.4.1=db,app,node', STUB_PROJECT_CONTAINERS: TODAY });
    expect(r.status.state).toBe('done');
    expect(removals(r.calls)).toEqual([]);
  });

  it('checks health at front for a build that has it, and at the app for one that does not', () => {
    const r = runOnce(stand(), ask('v12'), { ...BUILDS, STUB_BROKEN: '0.4.1', STUB_PROJECT_CONTAINERS: MOVED_IN });
    expect(r.status.state).toBe('rolled_back');
    const asked = curls(r.calls);
    expect(asked[0]).toContain('http://front:8080/api/health');
    expect(asked.at(-1)).toContain('http://app:8080/api/health');
    expect(r.calls.findIndex(c => c.includes('http://app:8080'))).toBeGreaterThan(installerOf(r.calls, '0.4.0'));
  });

  it('asks the address it was given, when it was given one', () => {
    const r = runOnce(stand(), ask('v13'), { ...BUILDS, HORNHOOF_HEALTH_URL: 'http://192.0.2.10:9/api/health' });
    expect(r.status.state).toBe('done');
    expect(curls(r.calls).every(c => c.includes('http://192.0.2.10:9/api/health'))).toBe(true);
  });

  it('stops an installer that does not end, and goes back', () => {
    const s = stand();
    const r = runOnce(s, ask('v14'), { ...BUILDS, STUB_HANG: '0.4.1', HORNHOOF_INSTALL_WAIT: '2' });
    expect(r.status).toMatchObject({ id: 'v14', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).toContain('The installer of 0.4.1 did not end within 2 seconds, so it was stopped.');
    const stop = r.calls.indexOf('docker compose stop migrate app');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(installerOf(r.calls, '0.4.0'));
    expect(readState(s, 'running')).toBe('aaa');
    expect(envOf(s)).toContain('HORNHOOF_VERSION=0.4.0');
  });

  /* A compose command the installer left running would go on starting the new build while the old one goes back. */
  it('stops what a hung installer started, too', () => {
    const s = stand();
    runOnce(s, ask('v15'), { ...BUILDS, STUB_HANG: '0.4.1', HORNHOOF_INSTALL_WAIT: '1' });
    const child = Number(readState(s, 'hung-child'));
    expect(child).toBeGreaterThan(0);
    expect(() => process.kill(child, 0)).toThrow(/ESRCH/);
  });

  it('says what to do by hand when the install on the way back hangs too', () => {
    const r = runOnce(stand(), ask('v16'), { ...BUILDS, STUB_HANG: '0.4.1 0.4.0', HORNHOOF_INSTALL_WAIT: '1' });
    expect(r.status).toMatchObject({ id: 'v16', state: 'failed', step: 'finished' });
    expect(r.status.log).toContain('The installer of 0.4.0 did not end within 1 seconds, so it was stopped.');
    expect(r.status.log).toContain('Could not go back to 0.4.0 either.');
  });

  it('goes back when the installer fails, without waiting out its time', () => {
    const s = stand();
    /* Something else holds the web port, and only the build from before takes it over. */
    writeFileSync(join(s.dir, 'port-holder'), '');
    const started = Date.now();
    const r = runOnce(s, ask('v17'), { STUB_BUILD_SERVICES: '0.4.1=db,app,updater 0.4.0=db,app,front,updater', HORNHOOF_INSTALL_WAIT: '25' });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.status).toMatchObject({ id: 'v17', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).toContain('The installer of 0.4.1 failed: Bind for 0.0.0.0:8080 failed: port is already allocated');
    expect(r.status.log).not.toContain('did not end within');
  });

  it('moves in by handing over, and goes back to the old build when the new one fails', () => {
    const { s, first } = handedOver('h1');
    const r = runOnce(s, null, NEW_UPDATER);
    expect(r.status.log).toContain(GOES_ON);
    const calls = r.calls.slice(first.calls.length);
    /* The older updater's copy was taken while the app worked on, so this one takes its own. */
    const stop = at(calls, 'docker compose stop app');
    const dump = at(calls, 'docker exec dbcid pg_dump');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(dump);
    expect(readState(s, 'copies')).toBe('2');
    const install = calls.find(c => c.startsWith('installer server') && c.includes('HORNHOOF_VERSION=0.4.1 '));
    expect(install).toContain('HORNHOOF_UPDATER_REV=2');
    expect(curls(calls)[0]).toContain('http://front:8080/api/health');
    /* What the old app confirmed up to its stop comes back. */
    expect(readState(s, 'restored-copy')).toBe('2');
    const old = installerOf(calls, '0.4.0');
    const failedCheck = at(calls, 'curl');
    for (const id of ['c-front', 'c-keeper', 'c-migrate']) {
      expect(calls.indexOf(`docker rm -f ${id}`)).toBeGreaterThan(failedCheck);
      expect(calls.indexOf(`docker rm -f ${id}`)).toBeLessThan(old);
    }
    expect(r.status).toMatchObject({ id: 'h1', state: 'rolled_back', step: 'finished' });
    expect(curls(calls).at(-1)).toContain('http://app:8080/api/health');
    expect(readState(s, 'running')).toBe('aaa');
    expect(envOf(s)).toContain('HORNHOOF_VERSION=0.4.0');
    expect(readState(s, 'migrations')).toBe('20');
  });

  it('finishes the move-in under the new updater when the new build answers', () => {
    const env = { ...HAND_OVER, STUB_BROKEN: '' };
    const { s } = handedOver('h2', env);
    const r = runOnce(s, null, env);
    expect(r.status).toMatchObject({ id: 'h2', state: 'done', step: 'finished' });
    expect(readState(s, 'running')).toBe('bbb');
    expect(r.calls.some(c => c.startsWith('docker run') && c.includes(`${APP}-updater@${UPDATER_DIGESTS['0.4.1']} compose up -d --no-build updater`))).toBe(true);
  });

  /* A database that takes long to answer must not look like an updater that did not start: the helper waits a minute. */
  it('says it goes on before it asks the database anything', () => {
    const { s } = handedOver('h16');
    rmSync(join(s.dir, 'status-when-asked'));
    runOnce(s, null, NEW_UPDATER);
    expect(JSON.parse(readState(s, 'status-when-asked')).log).toContain(GOES_ON);
  });

  it('goes back when the second copy of the database fails, since the new installer wrote .env and compose.yaml already', () => {
    const { s, first } = handedOver('h3');
    const r = runOnce(s, null, { ...HAND_OVER, STUB_DUMP: 'fail' });
    const calls = r.calls.slice(first.calls.length);
    expect(r.status).toMatchObject({ id: 'h3', state: 'rolled_back', step: 'finished' });
    expect(installers(calls)).toEqual(['0.4.0']);
    expect(calls).toContain('docker start appcid');
    expect(envOf(s)).toContain('HORNHOOF_VERSION=0.4.0');
    expect(calls.some(c => c.includes('hornhoof_restore'))).toBe(false);
  });

  it('goes on with the copy it has when the new build changed the database already', () => {
    const { s, first } = handedOver('h4');
    writeFileSync(join(s.dir, 'migrations'), '21');
    const r = runOnce(s, null, NEW_UPDATER);
    expect(r.status).toMatchObject({ id: 'h4', state: 'rolled_back', step: 'finished' });
    expect(r.calls.slice(first.calls.length).some(c => c.includes('pg_dump'))).toBe(false);
    expect(readState(s, 'restored-copy')).toBe('1');
  });

  /* Starting over would download again and read the build to go back to anew, with .env and compose.yaml the new
     installer's by now. Going on keeps the note, and any failure from here goes back. */
  it('goes on from the hand-over when it was stopped during the second copy', () => {
    const { s, first } = handedOver('h5');
    editStatus(s, { step: 'backup' });
    const r = runOnce(s, null, { ...NEW_UPDATER, STUB_PULL: 'fail' });
    expect(r.status).toMatchObject({ id: 'h5', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).toContain(GOES_ON);
    expect(r.calls.slice(first.calls.length).some(c => c.startsWith('docker pull'))).toBe(false);
    expect(readState(s, 'copies')).toBe('2');
  });

  /* An older updater notes its copy only after it took it, so with no copy in the note nothing was handed over. */
  it('starts over when an older updater was stopped before it saved its own copy', () => {
    const s = stand();
    const first = runRev1(s, ask('h14'), { ...BUILDS, STUB_STOP_IN: 'pull' });
    editStatus(s, { step: 'backup' });
    const r = runOnce(s, null, BUILDS);
    expect(r.status).toMatchObject({ id: 'h14', state: 'done', step: 'finished' });
    expect(r.status.log).not.toContain(GOES_ON);
    expect(at(r.calls.slice(first.calls.length), 'docker pull')).toBeGreaterThanOrEqual(0);
  });

  it('copies the database once when it was stopped during an install it began itself', () => {
    const s = stand();
    const stopped = runOnce(s, ask('h6'), { ...BUILDS, STUB_STOP_IN: '0.4.1' });
    const r = runOnce(s, null, BUILDS);
    expect(r.status).toMatchObject({ id: 'h6', state: 'done' });
    expect(r.status.log).toContain('The updater stopped during the update and goes on with it.');
    expect(r.status.log).not.toContain(GOES_ON);
    expect(r.calls.slice(stopped.calls.length).some(c => c.includes('pg_dump'))).toBe(false);
  });

  it('stays on the old build, working, when the new installer cannot start the hand-over helper', () => {
    const s = stand();
    const r = runRev1(s, ask('h7'), { ...HAND_OVER, STUB_HANDOVER: 'fail' });
    expect(r.status).toMatchObject({ id: 'h7', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).toContain('Could not start the updater of this build, so nothing changed.');
    expect(removals(r.calls)).toEqual([]);
    expect(r.calls.some(c => c.includes('hornhoof_restore'))).toBe(false);
    expect(curls(r.calls).at(-1)).toContain('http://app:8080/api/health');
    expect(readState(s, 'running')).toBe('aaa');
    expect(envOf(s)).toContain('HORNHOOF_VERSION=0.4.0');
  });

  it("brings the older updater back to go back when this build's updater does not start", () => {
    const { s, first } = handedOver('h8');
    const t = takeOver(s, { ...HAND_OVER, STUB_UPDATER_UP: 'fail', HORNHOOF_TAKE_OVER_WAIT: '1' });
    expect(t.code).toBe(0);
    expect(t.status).toMatchObject({ id: 'h8', state: 'running', step: 'rollback' });
    expect(t.status.log).toContain(NO_START);
    expect(t.calls.slice(first.calls.length)).toContain(`updater up HORNHOOF_UPDATER_REF=${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`);
    const r = runRev1(s, null, HAND_OVER);
    expect(r.status).toMatchObject({ id: 'h8', state: 'rolled_back', step: 'finished' });
    expect(curls(r.calls).at(-1)).toContain('http://app:8080/api/health');
    expect(readState(s, 'running')).toBe('aaa');
    expect(envOf(s)).toContain('HORNHOOF_VERSION=0.4.0');
  });

  it("goes back under this build's updater too, once the helper marked the way back", () => {
    const { s } = handedOver('h15');
    takeOver(s, { ...HAND_OVER, STUB_UPDATER_UP: 'fail', HORNHOOF_TAKE_OVER_WAIT: '1' });
    const r = runOnce(s, null, HAND_OVER);
    expect(r.status).toMatchObject({ id: 'h15', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).not.toContain(GOES_ON);
    expect(readState(s, 'running')).toBe('aaa');
  });

  it("goes back the same way when this build's updater starts but never takes the update", () => {
    const { s } = handedOver('h9');
    const t = takeOver(s, { ...HAND_OVER, HORNHOOF_TAKE_OVER_WAIT: '1' });
    expect(t.calls).toContain('docker compose up -d --no-build --wait updater');
    expect(t.status).toMatchObject({ id: 'h9', state: 'running', step: 'rollback' });
    expect(t.status.log).toContain(NO_START);
    expect(t.calls).toContain(`updater up HORNHOOF_UPDATER_REF=${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`);
  });

  it('says what to do by hand when no updater can start', () => {
    const { s } = handedOver('h10');
    const t = takeOver(s, { ...HAND_OVER, STUB_UPDATER_UP: 'never', HORNHOOF_TAKE_OVER_WAIT: '1' });
    expect(t.status).toMatchObject({ id: 'h10', state: 'failed', step: 'finished' });
    expect(t.status.log).toContain(`No updater could start. Hornhoof still runs the build from before; run install.sh server in ${s.server}.`);
    expect(existsSync(join(s.server, 'backups', 'update.json'))).toBe(false);
  });

  it('changes nothing once the new updater has said it goes on', () => {
    const { s, first } = handedOver('h11');
    editStatus(s, { log: `Installing 0.4.1.\n${GOES_ON}\n` });
    const before = readFileSync(statusFile(s), 'utf8');
    const t = takeOver(s, HAND_OVER);
    expect(t.code).toBe(0);
    expect(t.calls.slice(first.calls.length).filter(c => c.startsWith('docker '))).toEqual(['docker compose up -d --no-build --wait updater']);
    expect(readFileSync(statusFile(s), 'utf8')).toBe(before);
  });

  it('waits for the new updater to say it goes on', () => {
    const { s } = handedOver('h12');
    const later = join(s.dir, 'status-later.json');
    writeFileSync(later, JSON.stringify({ ...JSON.parse(readFileSync(statusFile(s), 'utf8')), log: `${GOES_ON}\n` }));
    spawn('sh', ['-c', `sleep 1; mv "${later}" "${statusFile(s)}"`], { stdio: 'ignore', detached: true }).unref();
    const t = takeOver(s, { ...HAND_OVER, HORNHOOF_TAKE_OVER_WAIT: '10' });
    expect(t.status).toMatchObject({ id: 'h12', state: 'running', step: 'install' });
    expect(t.status.log).toContain(GOES_ON);
    expect(t.status.log).not.toContain(NO_START);
  });

  it('does nothing unless an update waits to be taken over', () => {
    const { s, first } = handedOver('h13');
    for (const change of [{ state: 'done' }, { state: 'running', step: 'health' }, { state: 'running', step: 'install', id: 'another' }]) {
      editStatus(s, change);
      const before = readFileSync(statusFile(s), 'utf8');
      const t = takeOver(s, HAND_OVER);
      expect(t.code).toBe(0);
      expect(t.calls.slice(first.calls.length)).toEqual([]);
      expect(readFileSync(statusFile(s), 'utf8')).toBe(before);
    }
  });

  it('does nothing when there is no status at all', () => {
    const t = takeOver(stand());
    expect(t.code).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.status).toBeNull();
  });
});

/* The orchestrator's commands on the server's computer, while the CEO keeps access to it open. */
describe('updater, the computer', () => {
  const HELPER = `${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`;
  const env = { HORNHOOF_COMPUTER_IMAGE: HELPER };
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

  it('runs a command as root on the computer, with its files at /host and its Docker, and answers with the output and exit code', () => {
    const s = stand();
    access(s, later());
    command(s, 'c1', 'uname -a');
    const r = runOnce(s, null, { ...env, STUB_COMPUTER_EXIT: '3' });
    /* Made first and then started, so the watch can always stop it. */
    const made = r.calls.indexOf(
      `docker create --rm --name hornhoof-computer-c1 --privileged --pid=host --network=host --ipc=host --uts=host -v /:/host -v /var/run/docker.sock:/var/run/docker.sock --entrypoint bash ${HELPER} -c uname -a`,
    );
    expect(made).toBeGreaterThanOrEqual(0);
    expect(r.calls.indexOf('docker start -a hornhoof-computer-c1')).toBeGreaterThan(made);
    expect(answer(s, 'c1')).toEqual({ id: 'c1', exit: 3, output: 'ran: uname -a\n' });
    expect(existsSync(join(s.control, 'computer', 'c1.started'))).toBe(false);
    /* An answered command does not run again: the stub's log keeps the first run only. */
    expect(runOnce(s, null, env).calls.filter(c => c.startsWith('docker start'))).toHaveLength(1);
  });

  it('runs nothing while access is closed or over, and says so', () => {
    const s = stand();
    access(s, Math.floor(Date.now() / 1000) - 1);
    command(s, 'c2', 'rm -rf /host/etc');
    const r = runOnce(s, null, env);
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
    expect(answer(s, 'c2')).toEqual({ id: 'c2', exit: 126, output: 'Access to the computer is closed.\n' });
    /* Closed while its container was being made: it never starts. */
    const u = stand();
    access(u, later());
    command(u, 'c8', 'rm -rf /host/var/lib/docker');
    const raced = runOnce(u, null, { ...env, STUB_CLOSE_ON_CREATE: '1' });
    expect(raced.calls).toContain('docker rm -f hornhoof-computer-c8');
    expect(raced.calls.filter(c => c.startsWith('docker start'))).toEqual([]);
    expect(answer(u, 'c8')).toMatchObject({ exit: 125, output: expect.stringContaining('Stopped: access to the computer was closed.') });
    const t = stand();
    command(t, 'c3', 'uname -a');
    expect(runOnce(t, null, env).calls.filter(c => c.startsWith('docker'))).toEqual([]);
    expect(answer(t, 'c3')).toMatchObject({ exit: 126 });
  });

  it('stops a command at its time', () => {
    const s = stand();
    access(s, later());
    command(s, 'c4', 'sleep 600', 1);
    const r = runOnce(s, null, { ...env, STUB_COMPUTER_SLEEP: '3' });
    expect(r.calls).toContain('docker rm -f hornhoof-computer-c4');
    expect(answer(s, 'c4')).toMatchObject({ id: 'c4', exit: 124, output: expect.stringContaining('Stopped after 1 seconds.') });
  });

  it('stops a running command when the CEO closes access', () => {
    const s = stand();
    access(s, later());
    command(s, 'c6', 'apt-get upgrade -y', 60);
    const r = runOnce(s, null, { ...env, STUB_COMPUTER_SLEEP: '3', STUB_COMPUTER_CLOSES: '1' });
    expect(r.calls).toContain('docker rm -f hornhoof-computer-c6');
    expect(answer(s, 'c6')).toMatchObject({ id: 'c6', exit: 125, output: expect.stringContaining('Stopped: access to the computer was closed.') });
  });

  it('runs no command a second time after it restarted, and stops what still runs of it', () => {
    const s = stand();
    access(s, later());
    command(s, 'c7', 'apt-get upgrade -y');
    writeFileSync(join(s.control, 'computer', 'c7.started'), '');
    const r = runOnce(s, null, env);
    expect(r.calls).toEqual(['docker rm -f hornhoof-computer-c7']);
    expect(answer(s, 'c7')).toMatchObject({ id: 'c7', exit: 125, output: expect.stringContaining('The updater restarted while this command ran') });
    expect(existsSync(join(s.control, 'computer', 'c7.started'))).toBe(false);
  });

  it('stops a command it started whose request the app took back', () => {
    const s = stand();
    mkdirSync(join(s.control, 'computer'));
    writeFileSync(join(s.control, 'computer', 'c9.started'), '');
    expect(runOnce(s, null, env).calls).toEqual(['docker rm -f hornhoof-computer-c9']);
    expect(readdirSync(join(s.control, 'computer'))).toEqual([]);
  });

  it('leaves alone a command file whose name is not a plain id', () => {
    const s = stand();
    access(s, later());
    command(s, 'c5;x', 'uname -a');
    expect(runOnce(s, null, env).calls.filter(c => c.startsWith('docker'))).toEqual([]);
  });
});
