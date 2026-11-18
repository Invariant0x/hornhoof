import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP, ask, at, DIGESTS, JQ, keeperSays, NODE_DIGESTS, refs, runOnce, stand, UPDATER_DIGESTS, type Stand } from './updater-fixture.js';

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

  /* Deleting a copy of the database cannot be undone, so no copy goes that a way back may still need. */
  describe('the copies it keeps', () => {
    const backups = (s: Stand) => join(s.server, 'backups');
    const copies = (s: Stand) => readdirSync(backups(s)).filter(name => name.endsWith('.sql.gz')).sort();
    const MIGRATED = { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' };
    /* Copies earlier updates left, the first the oldest by the time each file has. */
    const earlier = (s: Stand, ids: string[], times: (i: number) => Date) => {
      mkdirSync(backups(s), { recursive: true });
      return ids.map((id, i) => {
        const name = `hornhoof-2026010${i + 1}T000000Z-${id}.sql.gz`;
        writeFileSync(join(backups(s), name), gzipSync(`-- a dump of the hornhoof database\n-- migrations 20\n-- copy ${id}\n`));
        utimesSync(join(backups(s), name), times(i), times(i));
        return name;
      });
    };

    it('never deletes the copy its own update goes back to, whatever time the clock gave the others', async () => {
      const s = stand();
      /* Made while the clock ran years ahead, and set right since. */
      const [, second, third] = earlier(s, ['e1', 'e2', 'e3'], i => new Date(2099, 0, i + 1));
      const r = await runOnce(s, ask('k1'), MIGRATED);
      expect(r.status).toMatchObject({ id: 'k1', state: 'rolled_back', step: 'finished' });
      expect(readFileSync(join(s.dir, 'migrations'), 'utf8')).toBe('20');
      const own = copies(s).find(name => name.endsWith('-k1.sql.gz'));
      expect(own).toBeDefined();
      expect(copies(s)).toEqual([second, third, own].sort());
    });

    it('deletes none when the copy of the update did not load, since an older one may be the only one that does', async () => {
      const s = stand();
      const before = earlier(s, ['e1', 'e2', 'e3'], i => new Date(2026, 0, i + 1));
      const r = await runOnce(s, ask('k2'), { ...MIGRATED, STUB_RESTORE: 'fail' });
      expect(r.status).toMatchObject({ id: 'k2', state: 'failed' });
      expect(r.status.log).toContain('Could not put the database back from backups/');
      const own = copies(s).find(name => name.endsWith('-k2.sql.gz'))!;
      expect(copies(s)).toEqual([...before, own].sort());
      /* The next update that ends on a database that works keeps the newest three again. */
      expect((await runOnce(s, ask('k3'))).status.state).toBe('done');
      expect(copies(s)).toEqual([before[2], own, copies(s).find(name => name.endsWith('-k3.sql.gz'))].sort());
    });

    it('counts no copy a stop cut short, and removes what it left', async () => {
      const s = stand();
      const before = earlier(s, ['e1', 'e2'], i => new Date(2026, 0, i + 1));
      const stopped = await runOnce(s, ask('k4'), { STUB_STOP_IN: 'backup', STUB_MIGRATIONS: '0.4.0=20 0.4.1=22' });
      expect(stopped.status).toMatchObject({ id: 'k4', state: 'running', step: 'backup' });
      expect(copies(s)).toEqual(before);
      const r = await runOnce(s, null, { STUB_MIGRATIONS: '0.4.0=20 0.4.1=22' });
      expect(r.status).toMatchObject({ id: 'k4', state: 'done' });
      expect(readdirSync(backups(s)).filter(name => !name.endsWith('.sql.gz'))).toEqual([]);
      const own = copies(s).find(name => name.endsWith('-k4.sql.gz'))!;
      expect(copies(s)).toEqual([...before, own].sort());
      expect(gunzipSync(readFileSync(join(backups(s), own))).toString()).toContain('-- migrations 20\n');
    });
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

  /* What the keeper does while the updater waits a second: it writes down the step the updater is in, and answers the
     question of that step. */
  const answering = (id: string, more = '') =>
    `step=$(jq -r .step "$HORNHOOF_CONTROL_DIR/status.json"); echo "$step" >> "$STUB_STATE/steps"; ` +
    `case "$step" in promise) echo '{"id":"${id}","ok":true}' > "$HORNHOOF_CONTROL_DIR/promised.json" ;; ` +
    `backup) echo '{"id":"${id}","ok":true}' > "$HORNHOOF_CONTROL_DIR/settled.json"; echo 'keeper settled' >> "$STUB_LOG" ;; ${more}esac`;
  const stepsOf = (s: Stand) => (existsSync(join(s.dir, 'steps')) ? readFileSync(join(s.dir, 'steps'), 'utf8').trim().split('\n') : []);

  it('asks the copies before it saves the database', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u1'), { STUB_MIGRATIONS: '0.4.0=20 0.4.1=22', STUB_DURING_SLEEP: answering('u1') }, { keeper: false });
    expect(r.status).toMatchObject({ id: 'u1', state: 'done', step: 'finished', migrations: 2, restore: false });
    /* It waited in the step promise first, then in backup, each until its answer was there. */
    expect(stepsOf(s).filter((step, n, all) => step !== all[n - 1]).slice(0, 2)).toEqual(['promise', 'backup']);
    expect(r.status.log).toContain('Asking the copies to wait for the update.');
    /* The journal of the new build came with its installer. */
    expect(r.calls.some(c => c.startsWith('docker cp cid-0.4.1:/app/apps/server/drizzle/meta/_journal.json '))).toBe(true);
    /* The dump is taken only once the keeper said the copies hold every change, and the app stops only then. */
    const settled = r.calls.indexOf('keeper settled');
    expect(settled).toBeGreaterThanOrEqual(0);
    expect(at(r.calls, 'docker exec dbcid pg_dump')).toBeGreaterThan(settled);
    expect(r.calls.indexOf('docker compose stop app')).toBeGreaterThan(settled);
    /* A build that brings no migration says so. */
    const same = stand();
    expect((await runOnce(same, ask('u2'))).status).toMatchObject({ state: 'done', migrations: 0, restore: false });
  });

  it('ends when a copy does not promise', async () => {
    const s = stand();
    keeperSays(s, 'u1', { promised: { ok: false, why: 'Mac did not answer' } });
    const r = await runOnce(s, ask('u1'), {}, { keeper: false });
    expect(r.status).toMatchObject({ state: 'failed', step: 'promise' });
    expect(r.status.log).toContain('Mac did not answer, so nothing changed.');
    expect(r.calls.some(c => c.includes('pg_dump') || c.startsWith('installer') || c === 'docker compose stop app')).toBe(false);
  });

  it('ends when no keeper answers', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u1'), { HORNHOOF_PROMISE_WAIT: '1' }, { keeper: false });
    expect(r.status).toMatchObject({ state: 'failed', step: 'promise' });
    expect(r.status.log).toContain('The keeper did not answer, so nothing changed.');
    expect(r.calls.some(c => c.includes('pg_dump') || c.startsWith('installer'))).toBe(false);
    /* An answer about another update is none. */
    const other = stand();
    keeperSays(other, 'u0');
    const again = await runOnce(other, ask('u1'), { HORNHOOF_PROMISE_WAIT: '1' }, { keeper: false });
    expect(again.status.log).toContain('The keeper did not answer, so nothing changed.');
  });

  it('ends when the copies do not confirm', async () => {
    const s = stand();
    keeperSays(s, 'u1', { settled: { ok: false, why: 'The copies did not confirm the last changes' } });
    const r = await runOnce(s, ask('u1'), {}, { keeper: false });
    expect(r.status).toMatchObject({ state: 'failed', step: 'backup' });
    expect(r.status.log).toContain('The copies did not confirm the last changes, so nothing changed.');
    expect(r.calls.some(c => c.includes('pg_dump') || c.startsWith('installer') || c === 'docker compose stop app')).toBe(false);
    /* The same when the keeper says nothing of the dump in time. */
    const silent = stand();
    keeperSays(silent, 'u1', { settled: null });
    const late = await runOnce(silent, ask('u1'), { HORNHOOF_SETTLE_WAIT: '1' }, { keeper: false });
    expect(late.status.log).toContain('The copies did not confirm the last changes, so nothing changed.');
    expect(late.calls.some(c => c.includes('pg_dump'))).toBe(false);
  });

  it('waits for the slots before it restores', async () => {
    const env = { STUB_BROKEN: '0.4.1', STUB_MIGRATIONS: '0.4.0=20 0.4.1=21' };
    const restored = (calls: string[]) => calls.findIndex(c => c.includes('CREATE DATABASE hornhoof_restore'));
    const asked = (calls: string[]) => calls.findIndex(c => c.includes('count(*) FROM pg_replication_slots'));
    /* The keeper says the slots went: the updater looks itself, and puts the database back. */
    const s = stand();
    writeFileSync(join(s.dir, 'slots'), '');
    const r = await runOnce(s, ask('u1'), env);
    expect(r.status).toMatchObject({ state: 'rolled_back', migrations: 1, restore: true });
    expect(asked(r.calls)).toBeGreaterThanOrEqual(0);
    expect(restored(r.calls)).toBeGreaterThan(asked(r.calls));
    /* No word of the keeper's in time: the updater ends the readers and drops the slots itself, then restores. */
    const alone = stand();
    writeFileSync(join(alone.dir, 'slots'), 'copy_c0c0c0c0c0c0c0c0_1\n');
    keeperSays(alone, 'u1', { dropped: null });
    const own = await runOnce(alone, ask('u1'), { ...env, HORNHOOF_DROP_WAIT: '1' }, { keeper: false });
    expect(own.status).toMatchObject({ state: 'rolled_back', restore: true });
    const dropped = own.calls.findIndex(c => c.includes('pg_drop_replication_slot'));
    expect(own.calls.findIndex(c => c.includes('pg_terminate_backend(active_pid)'))).toBeLessThan(dropped);
    expect(restored(own.calls)).toBeGreaterThan(dropped);
    /* A slot that will not go: the database is not put back, and the build from before is not started on it. */
    const stuck = stand();
    writeFileSync(join(stuck.dir, 'slots'), 'copy_c0c0c0c0c0c0c0c0_1\n');
    const kept = await runOnce(stuck, ask('u1'), { ...env, HORNHOOF_DROP_WAIT: '1', STUB_SLOTS_STAY: '1' });
    expect(kept.status).toMatchObject({ state: 'failed', step: 'finished' });
    expect(kept.status.log).toContain("Could not drop the copies' slots, so the database was not put back.");
    expect(restored(kept.calls)).toBe(-1);
    expect(kept.calls.filter(c => c.startsWith('installer')).map(c => c.match(/HORNHOOF_VERSION=(\S+)/)![1])).toEqual(['0.4.1']);
  });

  it('starts over when stopped while asking', async () => {
    const s = stand();
    const stopped = await runOnce(s, ask('p1'), { STUB_STOP_IN: 'promise', HORNHOOF_PROMISE_WAIT: '5' }, { keeper: false });
    expect(stopped.status).toMatchObject({ id: 'p1', state: 'running', step: 'promise' });
    keeperSays(s, 'p1');
    const r = await runOnce(s, null);
    expect(r.status).toMatchObject({ id: 'p1', state: 'done', step: 'finished' });
    /* From the beginning: the build is downloaded again, and the database saved once. */
    expect(r.calls.filter(c => c === `docker pull ghcr.io/invariant0x/hornhoof@${DIGESTS['0.4.1']}`)).toHaveLength(2);
    expect(r.calls.filter(c => c.startsWith('docker exec dbcid pg_dump'))).toHaveLength(1);
    expect(r.calls.filter(c => c.startsWith('installer'))).toHaveLength(1);
  });

  it('goes on from the dump when stopped there', async () => {
    const s = stand();
    const stopped = await runOnce(s, ask('b1'), { STUB_STOP_IN: 'backup', STUB_MIGRATIONS: '0.4.0=20 0.4.1=22' });
    expect(stopped.status).toMatchObject({ id: 'b1', state: 'running', step: 'backup', migrations: 2 });
    const before = stopped.calls.length;
    const r = await runOnce(s, null, { STUB_MIGRATIONS: '0.4.0=20 0.4.1=22', STUB_DURING_SLEEP: 'jq -r .step "$HORNHOOF_CONTROL_DIR/status.json" >> "$STUB_STATE/steps"' });
    expect(r.status).toMatchObject({ id: 'b1', state: 'done', step: 'finished', migrations: 2 });
    /* Nothing is downloaded or asked again: the keeper's word about the dump stands, since the step never left backup.
       The installer is taken out of the image that is here already. */
    const fresh = r.calls.slice(before);
    expect(fresh.filter(c => c.startsWith('docker pull') || c.endsWith(' pull'))).toEqual([]);
    expect(stepsOf(s).some(step => step === 'pull' || step === 'promise')).toBe(false);
    expect(fresh.filter(c => c.startsWith('docker exec dbcid pg_dump'))).toHaveLength(1);
    expect(fresh.filter(c => c.startsWith('installer'))).toHaveLength(1);
  });

  it('marks an update it was stopped in as failed when it kept no note of it', async () => {
    const s = stand();
    writeFileSync(join(s.control, 'request.json'), JSON.stringify({ id: 'u7', version: '0.4.1', tag: '0.4.1' }));
    writeFileSync(join(s.control, 'status.json'), JSON.stringify({ id: 'u7', version: '0.4.1', state: 'running', step: 'install', log: '', at: '2026-10-30T00:00:00Z' }));
    const r = await runOnce(s, null);
    expect(r.status).toMatchObject({ id: 'u7', state: 'failed' });
    expect(r.status.log).toMatch(/stopped/);
  });

  it('refuses to update a Hornhoof that install.sh did not set up', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u8'), { HORNHOOF_SERVER_DIR: '' });
    expect(r.status).toMatchObject({ state: 'failed' });
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
  });
});
