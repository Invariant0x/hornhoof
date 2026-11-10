import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP, ask, at, runOnce, runRev1, stand, takeOver, UPDATER_DIGESTS, type Stand } from './updater-fixture.js';


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
  async function handedOver(id: string, env: Record<string, string> = HAND_OVER) {
    const s = stand();
    const first = await runRev1(s, ask(id), env);
    expect(first.status).toMatchObject({ id, state: 'running', step: 'install' });
    expect(first.calls).toContain('installer hands over');
    return { s, first };
  }

  it("tells each build's installer that this updater is revision 2", async () => {
    const r = await runOnce(stand(), ask('v1'), { ...BUILDS, STUB_BROKEN: '0.4.1', STUB_PROJECT_CONTAINERS: MOVED_IN });
    expect(installers(r.calls)).toEqual(['0.4.1', '0.4.0']);
    for (const line of r.calls.filter(c => c.startsWith('installer server'))) expect(line).toContain('HORNHOOF_UPDATER_REV=2');
  });

  it('keeps its revision in the note of the update', async () => {
    const s = stand();
    const stopped = await runOnce(s, ask('v2'), { ...BUILDS, STUB_STOP_IN: '0.4.1' });
    expect(stopped.status).toMatchObject({ state: 'running', step: 'install' });
    expect(noteOf(s).rev).toBe('2');
  });

  it('stops the app before it saves the database, and starts it again when the copy fails', async () => {
    const ok = await runOnce(stand(), ask('v3'), BUILDS);
    expect(ok.status.state).toBe('done');
    const stop = at(ok.calls, 'docker compose stop app');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(at(ok.calls, 'docker exec dbcid pg_dump'));
    expect(ok.calls).not.toContain('docker start appcid');

    const s = stand();
    const r = await runOnce(s, ask('v4'), { ...BUILDS, STUB_DUMP: 'fail' });
    expect(r.status).toMatchObject({ id: 'v4', state: 'failed', step: 'backup' });
    expect(r.status.log).toContain('Could not save the database, so nothing changed.');
    expect(at(r.calls, 'docker start appcid')).toBeGreaterThan(at(r.calls, 'docker exec dbcid pg_dump'));
    expect(r.calls.some(c => c.startsWith('installer'))).toBe(false);
    expect(readdirSync(join(s.server, 'backups')).filter(f => f.endsWith('.sql.gz'))).toEqual([]);
  });

  /* The app is stopped for the copy, and starting over means nothing changed yet. A download that fails on the way
     says so, which would be untrue with the company's app left stopped. */
  it('starts the app it stopped again when it was stopped while saving the database', async () => {
    const s = stand();
    const stopped = await runOnce(s, ask('v5'), { STUB_STOP_IN: 'pull' });
    editStatus(s, { step: 'backup' });
    const r = await runOnce(s, null, { STUB_PULL: 'fail' });
    expect(r.status).toMatchObject({ id: 'v5', state: 'failed', step: 'pull' });
    const calls = r.calls.slice(stopped.calls.length);
    expect(at(calls, 'docker start appcid')).toBeGreaterThanOrEqual(0);
    expect(at(calls, 'docker start appcid')).toBeLessThan(at(calls, 'docker pull'));
  });

  it('leaves the app alone when it was stopped before the copy began', async () => {
    const s = stand();
    await runOnce(s, ask('v6'), { STUB_STOP_IN: 'pull' });
    expect((await runOnce(s, null)).calls).not.toContain('docker start appcid');
  });

  it('removes the containers of services the new build does not name, before its installer runs', async () => {
    const r = await runOnce(stand(), ask('v7'), { ...BUILDS, STUB_PROJECT_CONTAINERS: TODAY });
    expect(r.status.state).toBe('done');
    const removed = r.calls.indexOf('docker rm -f c-tunnel');
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(removed).toBeLessThan(installerOf(r.calls, '0.4.1'));
    expect(removals(r.calls)).toEqual(['docker rm -f c-tunnel']);
  });

  it('looks for those containers in the compose project of this server', async () => {
    const filter = (project: string) => `docker ps -a --filter label=com.docker.compose.project=${project} --format {{.ID}} {{.Label "com.docker.compose.service"}}`;
    const named = stand('HORNHOOF_SECRET=s\nHORNHOOF_VERSION=0.4.0\nCOMPOSE_PROJECT_NAME=hornhoof-acme\n');
    expect((await runOnce(named, ask('p1'), { ...BUILDS, COMPOSE_PROJECT_NAME: 'hornhoof-other' })).calls).toContain(filter('hornhoof-acme'));
    expect((await runOnce(stand(), ask('p2'), { ...BUILDS, COMPOSE_PROJECT_NAME: 'hornhoof-other' })).calls).toContain(filter('hornhoof-other'));
    expect((await runOnce(stand(), ask('p3'), BUILDS)).calls).toContain(filter('hornhoof'));
  });

  it('leaves alone a container that has no service, and one of a service the build names', async () => {
    const r = await runOnce(stand(), ask('v8'), { ...BUILDS, STUB_PROJECT_CONTAINERS: 'c-none= c-node=node' });
    expect(removals(r.calls)).toEqual([]);
  });

  it('says so and goes on with the install when a container cannot be removed', async () => {
    const r = await runOnce(stand(), ask('v9'), { ...BUILDS, STUB_PROJECT_CONTAINERS: TODAY, STUB_RM_FAILS: 'c-tunnel' });
    expect(r.status.state).toBe('done');
    expect(r.status.log).toContain('Could not remove the container of tunnel, a service this build does not name.');
    expect(installers(r.calls)).toEqual(['0.4.1']);
  });

  it('goes back to a build from before front even though front held the web port', async () => {
    const r = await runOnce(stand(), ask('v10'), { ...BUILDS, STUB_BROKEN: '0.4.1', STUB_PROJECT_CONTAINERS: MOVED_IN });
    expect(r.status).toMatchObject({ id: 'v10', state: 'rolled_back', step: 'finished' });
    const check = at(r.calls, 'curl');
    const old = installerOf(r.calls, '0.4.0');
    expect(check).toBeGreaterThanOrEqual(0);
    for (const id of ['c-front', 'c-keeper', 'c-migrate']) {
      expect(r.calls.indexOf(`docker rm -f ${id}`)).toBeGreaterThan(check);
      expect(r.calls.indexOf(`docker rm -f ${id}`)).toBeLessThan(old);
    }
  });

  it("removes nothing when the build's compose file names no updater", async () => {
    const r = await runOnce(stand(), ask('v11'), { STUB_BUILD_SERVICES: '0.4.1=db,app,node', STUB_PROJECT_CONTAINERS: TODAY });
    expect(r.status.state).toBe('done');
    expect(removals(r.calls)).toEqual([]);
  });

  it('checks health at front for a build that has it, and at the app for one that does not', async () => {
    const r = await runOnce(stand(), ask('v12'), { ...BUILDS, STUB_BROKEN: '0.4.1', STUB_PROJECT_CONTAINERS: MOVED_IN });
    expect(r.status.state).toBe('rolled_back');
    const asked = curls(r.calls);
    expect(asked[0]).toContain('http://front:8080/api/health');
    expect(asked.at(-1)).toContain('http://app:8080/api/health');
    expect(r.calls.findIndex(c => c.includes('http://app:8080'))).toBeGreaterThan(installerOf(r.calls, '0.4.0'));
  });

  it('asks the address it was given, when it was given one', async () => {
    const r = await runOnce(stand(), ask('v13'), { ...BUILDS, HORNHOOF_HEALTH_URL: 'http://192.0.2.10:9/api/health' });
    expect(r.status.state).toBe('done');
    expect(curls(r.calls).every(c => c.includes('http://192.0.2.10:9/api/health'))).toBe(true);
  });

  it('stops an installer that does not end, and goes back', async () => {
    const s = stand();
    const r = await runOnce(s, ask('v14'), { ...BUILDS, STUB_HANG: '0.4.1', HORNHOOF_INSTALL_WAIT: '2' });
    expect(r.status).toMatchObject({ id: 'v14', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).toContain('The installer of 0.4.1 did not end within 2 seconds, so it was stopped.');
    const stop = r.calls.indexOf('docker compose stop migrate app');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(installerOf(r.calls, '0.4.0'));
    expect(readState(s, 'running')).toBe('aaa');
    expect(envOf(s)).toContain('HORNHOOF_VERSION=0.4.0');
  });

  /* A compose command the installer left running would go on starting the new build while the old one goes back. */
  it('stops what a hung installer started, too', async () => {
    const s = stand();
    await runOnce(s, ask('v15'), { ...BUILDS, STUB_HANG: '0.4.1', HORNHOOF_INSTALL_WAIT: '1' });
    const child = Number(readState(s, 'hung-child'));
    expect(child).toBeGreaterThan(0);
    expect(() => process.kill(child, 0)).toThrow(/ESRCH/);
  });

  it('says what to do by hand when the install on the way back hangs too', async () => {
    const r = await runOnce(stand(), ask('v16'), { ...BUILDS, STUB_HANG: '0.4.1 0.4.0', HORNHOOF_INSTALL_WAIT: '1' });
    expect(r.status).toMatchObject({ id: 'v16', state: 'failed', step: 'finished' });
    expect(r.status.log).toContain('The installer of 0.4.0 did not end within 1 seconds, so it was stopped.');
    expect(r.status.log).toContain('Could not go back to 0.4.0 either.');
  });

  it('goes back when the installer fails, without waiting out its time', async () => {
    const s = stand();
    /* Something else holds the web port, and only the build from before takes it over. */
    writeFileSync(join(s.dir, 'port-holder'), '');
    const started = Date.now();
    const r = await runOnce(s, ask('v17'), { STUB_BUILD_SERVICES: '0.4.1=db,app,updater 0.4.0=db,app,front,updater', HORNHOOF_INSTALL_WAIT: '25' });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.status).toMatchObject({ id: 'v17', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).toContain('The installer of 0.4.1 failed: Bind for 0.0.0.0:8080 failed: port is already allocated');
    expect(r.status.log).not.toContain('did not end within');
  });

  it('moves in by handing over, and goes back to the old build when the new one fails', async () => {
    const { s, first } = await handedOver('h1');
    const r = await runOnce(s, null, NEW_UPDATER);
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

  it('finishes the move-in under the new updater when the new build answers', async () => {
    const env = { ...HAND_OVER, STUB_BROKEN: '' };
    const { s } = await handedOver('h2', env);
    const r = await runOnce(s, null, env);
    expect(r.status).toMatchObject({ id: 'h2', state: 'done', step: 'finished' });
    expect(readState(s, 'running')).toBe('bbb');
    expect(r.calls.some(c => c.startsWith('docker run') && c.includes(`${APP}-updater@${UPDATER_DIGESTS['0.4.1']} compose up -d --no-build updater`))).toBe(true);
  });

  /* A database that takes long to answer must not look like an updater that did not start: the helper waits a minute. */
  it('says it goes on before it asks the database anything', async () => {
    const { s } = await handedOver('h16');
    rmSync(join(s.dir, 'status-when-asked'));
    await runOnce(s, null, NEW_UPDATER);
    expect(JSON.parse(readState(s, 'status-when-asked')).log).toContain(GOES_ON);
  });

  it('goes back when the second copy of the database fails, since the new installer wrote .env and compose.yaml already', async () => {
    const { s, first } = await handedOver('h3');
    const r = await runOnce(s, null, { ...HAND_OVER, STUB_DUMP: 'fail' });
    const calls = r.calls.slice(first.calls.length);
    expect(r.status).toMatchObject({ id: 'h3', state: 'rolled_back', step: 'finished' });
    expect(installers(calls)).toEqual(['0.4.0']);
    expect(calls).toContain('docker start appcid');
    expect(envOf(s)).toContain('HORNHOOF_VERSION=0.4.0');
    expect(calls.some(c => c.includes('hornhoof_restore'))).toBe(false);
  });

  it('goes on with the copy it has when the new build changed the database already', async () => {
    const { s, first } = await handedOver('h4');
    writeFileSync(join(s.dir, 'migrations'), '21');
    const r = await runOnce(s, null, NEW_UPDATER);
    expect(r.status).toMatchObject({ id: 'h4', state: 'rolled_back', step: 'finished' });
    expect(r.calls.slice(first.calls.length).some(c => c.includes('pg_dump'))).toBe(false);
    expect(readState(s, 'restored-copy')).toBe('1');
  });

  /* Starting over would download again and read the build to go back to anew, with .env and compose.yaml the new
     installer's by now. Going on keeps the note, and any failure from here goes back. */
  it('goes on from the hand-over when it was stopped during the second copy', async () => {
    const { s, first } = await handedOver('h5');
    editStatus(s, { step: 'backup' });
    const r = await runOnce(s, null, { ...NEW_UPDATER, STUB_PULL: 'fail' });
    expect(r.status).toMatchObject({ id: 'h5', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).toContain(GOES_ON);
    expect(r.calls.slice(first.calls.length).some(c => c.startsWith('docker pull'))).toBe(false);
    expect(readState(s, 'copies')).toBe('2');
  });

  /* An older updater notes its copy only after it took it, so with no copy in the note nothing was handed over. */
  it('starts over when an older updater was stopped before it saved its own copy', async () => {
    const s = stand();
    const first = await runRev1(s, ask('h14'), { ...BUILDS, STUB_STOP_IN: 'pull' });
    editStatus(s, { step: 'backup' });
    const r = await runOnce(s, null, BUILDS);
    expect(r.status).toMatchObject({ id: 'h14', state: 'done', step: 'finished' });
    expect(r.status.log).not.toContain(GOES_ON);
    expect(at(r.calls.slice(first.calls.length), 'docker pull')).toBeGreaterThanOrEqual(0);
  });

  it('copies the database once when it was stopped during an install it began itself', async () => {
    const s = stand();
    const stopped = await runOnce(s, ask('h6'), { ...BUILDS, STUB_STOP_IN: '0.4.1' });
    const r = await runOnce(s, null, BUILDS);
    expect(r.status).toMatchObject({ id: 'h6', state: 'done' });
    expect(r.status.log).toContain('The updater stopped during the update and goes on with it.');
    expect(r.status.log).not.toContain(GOES_ON);
    expect(r.calls.slice(stopped.calls.length).some(c => c.includes('pg_dump'))).toBe(false);
  });

  it('stays on the old build, working, when the new installer cannot start the hand-over helper', async () => {
    const s = stand();
    const r = await runRev1(s, ask('h7'), { ...HAND_OVER, STUB_HANDOVER: 'fail' });
    expect(r.status).toMatchObject({ id: 'h7', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).toContain('Could not start the updater of this build, so nothing changed.');
    expect(removals(r.calls)).toEqual([]);
    expect(r.calls.some(c => c.includes('hornhoof_restore'))).toBe(false);
    expect(curls(r.calls).at(-1)).toContain('http://app:8080/api/health');
    expect(readState(s, 'running')).toBe('aaa');
    expect(envOf(s)).toContain('HORNHOOF_VERSION=0.4.0');
  });

  it("brings the older updater back to go back when this build's updater does not start", async () => {
    const { s, first } = await handedOver('h8');
    const t = await takeOver(s, { ...HAND_OVER, STUB_UPDATER_UP: 'fail', HORNHOOF_TAKE_OVER_WAIT: '1' });
    expect(t.code).toBe(0);
    expect(t.status).toMatchObject({ id: 'h8', state: 'running', step: 'rollback' });
    expect(t.status.log).toContain(NO_START);
    expect(t.calls.slice(first.calls.length)).toContain(`updater up HORNHOOF_UPDATER_REF=${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`);
    const r = await runRev1(s, null, HAND_OVER);
    expect(r.status).toMatchObject({ id: 'h8', state: 'rolled_back', step: 'finished' });
    expect(curls(r.calls).at(-1)).toContain('http://app:8080/api/health');
    expect(readState(s, 'running')).toBe('aaa');
    expect(envOf(s)).toContain('HORNHOOF_VERSION=0.4.0');
  });

  it("goes back under this build's updater too, once the helper marked the way back", async () => {
    const { s } = await handedOver('h15');
    await takeOver(s, { ...HAND_OVER, STUB_UPDATER_UP: 'fail', HORNHOOF_TAKE_OVER_WAIT: '1' });
    const r = await runOnce(s, null, HAND_OVER);
    expect(r.status).toMatchObject({ id: 'h15', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).not.toContain(GOES_ON);
    expect(readState(s, 'running')).toBe('aaa');
  });

  it("goes back the same way when this build's updater starts but never takes the update", async () => {
    const { s } = await handedOver('h9');
    const t = await takeOver(s, { ...HAND_OVER, HORNHOOF_TAKE_OVER_WAIT: '1' });
    expect(t.calls).toContain('docker compose up -d --no-build --wait updater');
    expect(t.status).toMatchObject({ id: 'h9', state: 'running', step: 'rollback' });
    expect(t.status.log).toContain(NO_START);
    expect(t.calls).toContain(`updater up HORNHOOF_UPDATER_REF=${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`);
  });

  it('says what to do by hand when no updater can start', async () => {
    const { s } = await handedOver('h10');
    const t = await takeOver(s, { ...HAND_OVER, STUB_UPDATER_UP: 'never', HORNHOOF_TAKE_OVER_WAIT: '1' });
    expect(t.status).toMatchObject({ id: 'h10', state: 'failed', step: 'finished' });
    expect(t.status.log).toContain(`No updater could start. Hornhoof still runs the build from before; run install.sh server in ${s.server}.`);
    expect(existsSync(join(s.server, 'backups', 'update.json'))).toBe(false);
  });

  it('changes nothing once the new updater has said it goes on', async () => {
    const { s, first } = await handedOver('h11');
    editStatus(s, { log: `Installing 0.4.1.\n${GOES_ON}\n` });
    const before = readFileSync(statusFile(s), 'utf8');
    const t = await takeOver(s, HAND_OVER);
    expect(t.code).toBe(0);
    expect(t.calls.slice(first.calls.length).filter(c => c.startsWith('docker '))).toEqual(['docker compose up -d --no-build --wait updater']);
    expect(readFileSync(statusFile(s), 'utf8')).toBe(before);
  });

  it('waits for the new updater to say it goes on', async () => {
    const { s } = await handedOver('h12');
    const later = join(s.dir, 'status-later.json');
    writeFileSync(later, JSON.stringify({ ...JSON.parse(readFileSync(statusFile(s), 'utf8')), log: `${GOES_ON}\n` }));
    spawn('sh', ['-c', `sleep 1; mv "${later}" "${statusFile(s)}"`], { stdio: 'ignore', detached: true }).unref();
    const t = await takeOver(s, { ...HAND_OVER, HORNHOOF_TAKE_OVER_WAIT: '10' });
    expect(t.status).toMatchObject({ id: 'h12', state: 'running', step: 'install' });
    expect(t.status.log).toContain(GOES_ON);
    expect(t.status.log).not.toContain(NO_START);
  });

  it('does nothing unless an update waits to be taken over', async () => {
    const { s, first } = await handedOver('h13');
    for (const change of [{ state: 'done' }, { state: 'running', step: 'health' }, { state: 'running', step: 'install', id: 'another' }]) {
      editStatus(s, change);
      const before = readFileSync(statusFile(s), 'utf8');
      const t = await takeOver(s, HAND_OVER);
      expect(t.code).toBe(0);
      expect(t.calls.slice(first.calls.length)).toEqual([]);
      expect(readFileSync(statusFile(s), 'utf8')).toBe(before);
    }
  });

  it('does nothing when there is no status at all', async () => {
    const t = await takeOver(stand());
    expect(t.code).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.status).toBeNull();
  });
});

/* The orchestrator's commands on the server's computer, while the CEO keeps access to it open. */
