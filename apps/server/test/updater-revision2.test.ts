import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP, ask, at, refs, runOnce, runRev1, stand, takeOver, UPDATER_DIGESTS, type Stand } from './updater-fixture.js';


/* What revision 2 changes: the copy of the database, the services a build does not name, where health is asked, and
   an update an older updater began. */
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
  async function handedOver(id: string, env: Record<string, string> = HAND_OVER, dotEnv?: string) {
    const s = stand(dotEnv);
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

  it('goes back when the installer fails', async () => {
    const s = stand();
    /* Something else holds the web port, and only the build from before takes it over. */
    writeFileSync(join(s.dir, 'port-holder'), '');
    const r = await runOnce(s, ask('v17'), { STUB_BUILD_SERVICES: '0.4.1=db,app,updater 0.4.0=db,app,front,updater' });
    expect(r.status).toMatchObject({ id: 'v17', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).toContain('The installer of 0.4.1 failed: Bind for 0.0.0.0:8080 failed: port is already allocated');
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
    /* The new updater says so while the helper waits its first second, not before it looks. */
    const t = await takeOver(s, { ...HAND_OVER, HORNHOOF_TAKE_OVER_WAIT: '10', STUB_DURING_SLEEP: `[ ! -f "${later}" ] || mv "${later}" "${statusFile(s)}"` });
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

  /* A server from before compose files named the networks' subnets, whose networks have the ones Docker gave them. */
  const PLAIN = {
    ...HAND_OVER,
    STUB_SUBNET_BUILDS: '0.4.1',
    STUB_NETWORKS: 'plain',
    STUB_DOCKER_NETWORKS: 'n-def|hornhoof_default|hornhoof|172.18.0.0/16|false| n-int|hornhoof_internal|hornhoof|172.19.0.0/16|true|',
  };
  /* The settings of such a server, which name its compose project as every install does. */
  const PLAIN_ENV = 'HORNHOOF_SECRET=s\nHORNHOOF_VERSION=0.4.0\nCOMPOSE_PROJECT_NAME=hornhoof\n';
  const REMADE = 'The networks of this server are made again with the subnets they have, so Hornhoof stops for a moment.';
  const DOWN = 'docker compose down --remove-orphans';
  const composeOf = (s: Stand) => readFileSync(join(s.server, 'compose.yaml'), 'utf8');
  /* This build's updater says it goes on while the helper waits its first second for it, after what the log says by then,
     as it reads the log it goes on with. */
  function goesOnMeanwhile(s: Stand) {
    const once = join(s.dir, 'goes-on-once');
    const status = statusFile(s);
    writeFileSync(once, '');
    return {
      HORNHOOF_TAKE_OVER_WAIT: '10',
      STUB_DURING_SLEEP: `[ ! -f "${once}" ] || { jq --arg l "${GOES_ON}" '.log |= (if . == "" or endswith("\\n") then . else . + "\\n" end) + $l + "\\n"' "${status}" > "${status}.new" && mv "${status}.new" "${status}" && rm "${once}"; }`,
    };
  }

  it("makes the networks of a server from before subnets again with the subnets they have, and this build's updater goes on", async () => {
    const { s, first } = await handedOver('n1', PLAIN, PLAIN_ENV);
    const t = await takeOver(s, { ...PLAIN, ...goesOnMeanwhile(s) });
    expect(t.status).toMatchObject({ id: 'n1', state: 'running', step: 'install' });
    expect(t.status.log).toContain(GOES_ON);
    expect(t.status.log).not.toContain(NO_START);
    const calls = t.calls.slice(first.calls.length);
    const down = calls.indexOf(DOWN);
    expect(down).toBeGreaterThan(calls.indexOf('docker exec nodecid node /app/apps/node/dist/main.js prepare-stop hornhoof_update'));
    expect(calls.indexOf('docker exec nodecid node /app/apps/node/dist/main.js prepare-stop hornhoof_update')).toBeGreaterThan(-1);
    expect(calls.indexOf('docker compose up -d --no-build --wait db updater')).toBeGreaterThan(down);
    expect(envOf(s)).toContain('\nHORNHOOF_SUBNET=172.18.0.0/16\n');
    expect(envOf(s)).toContain('\nHORNHOOF_INTERNAL_SUBNET=172.19.0.0/16\n');
    const r = await runOnce(s, null, { ...PLAIN, STUB_BROKEN: '', STUB_PROJECT_CONTAINERS: MOVED_IN });
    expect(r.status).toMatchObject({ id: 'n1', state: 'done', step: 'finished' });
    expect(readState(s, 'running')).toBe('bbb');
    expect(readState(s, 'migrations')).toBe('21');
  });

  it('goes back to the build from before on the networks made again, when the new build fails', async () => {
    const { s } = await handedOver('n2', PLAIN, PLAIN_ENV);
    await takeOver(s, { ...PLAIN, ...goesOnMeanwhile(s) });
    const r = await runOnce(s, null, { ...PLAIN, STUB_PROJECT_CONTAINERS: MOVED_IN });
    expect(r.status).toMatchObject({ id: 'n2', state: 'rolled_back', step: 'finished' });
    expect(readState(s, 'running')).toBe('aaa');
    expect(readState(s, 'migrations')).toBe('20');
    expect(composeOf(s)).toContain('# build 0.4.0');
    expect(composeOf(s)).toContain('subnet: ${HORNHOOF_SUBNET:-10.200.0.0/24}');
  });

  it.each([
    ['never takes the update', 'n3', {}],
    ['does not start', 'n4', { STUB_UPDATER_UP: 'never' }],
  ])("brings the build from before back whole, on networks as its own file makes them, when this build's updater %s", async (_, id, change) => {
    const { s, first } = await handedOver(id, PLAIN, PLAIN_ENV);
    const t = await takeOver(s, { ...PLAIN, ...change, HORNHOOF_TAKE_OVER_WAIT: '1' });
    expect(t.status).toMatchObject({ id, state: 'running', step: 'rollback' });
    expect(t.status.log).toContain(REMADE);
    expect(t.status.log).toContain(NO_START);
    const calls = t.calls.slice(first.calls.length);
    expect(calls.filter(c => c === DOWN)).toHaveLength(2);
    expect(calls.indexOf(`all up ${refs('0.4.0')}`)).toBeGreaterThan(calls.lastIndexOf(DOWN));
    expect(composeOf(s)).toContain('# build 0.4.0');
    expect(composeOf(s)).not.toContain('HORNHOOF_SUBNET');
    expect(envOf(s)).not.toContain('SUBNET=');
    const r = await runRev1(s, null, PLAIN);
    expect(r.status).toMatchObject({ id, state: 'rolled_back', step: 'finished' });
    expect(readState(s, 'running')).toBe('aaa');
    expect(readState(s, 'migrations')).toBe('20');
    expect(envOf(s)).toContain('HORNHOOF_VERSION=0.4.0');
  });

  it('says Hornhoof is stopped and what to do when the build from before does not start again either', async () => {
    const { s } = await handedOver('n5', PLAIN, PLAIN_ENV);
    const t = await takeOver(s, { ...PLAIN, STUB_UPDATER_UP: 'never', STUB_ALL_UP: 'fail', HORNHOOF_TAKE_OVER_WAIT: '1' });
    expect(t.status).toMatchObject({ id: 'n5', state: 'failed', step: 'finished' });
    expect(t.status.log).toContain(`No updater could start, and the build from before did not start again either, so Hornhoof is stopped. Run install.sh server in ${s.server}.`);
    expect(existsSync(join(s.server, 'backups', 'update.json'))).toBe(false);
  });

  it("writes why compose refused each updater into the log, cut short and without the server's secrets", async () => {
    const secret = 'Pw7dK2xQ9mZ4vR8sT1';
    const { s } = await handedOver('n6', HAND_OVER, `HORNHOOF_SECRET=s\nHORNHOOF_VERSION=0.4.0\nPOSTGRES_PASSWORD=${secret}\n`);
    const says = `level=error msg="password ${secret} refused" ${'x'.repeat(400)}`;
    const t = await takeOver(s, { ...HAND_OVER, STUB_UPDATER_UP: 'never', STUB_COMPOSE_SAYS: says, HORNHOOF_TAKE_OVER_WAIT: '1' });
    expect(t.status).toMatchObject({ id: 'n6', state: 'failed', step: 'finished' });
    const said = t.status.log.split('\n').filter((line: string) => line.includes('refused'));
    expect(said).toHaveLength(2);
    for (const line of said) {
      expect(line.startsWith('Compose said: level=error msg="password <hidden> refused" xxx')).toBe(true);
      expect(line.length).toBeLessThanOrEqual(240);
    }
    expect(t.status.log).not.toContain(secret);
  });

  /* Settings that name the subnets the networks have, as an install by hand of 0.24.0 wrote before it stopped: neither
     the settings nor Docker show that the networks were made with no subnets named, only compose's refusal does. */
  const NAMED_ENV = `${PLAIN_ENV}HORNHOOF_SUBNET=172.18.0.0/16\nHORNHOOF_INTERNAL_SUBNET=172.19.0.0/16\n`;
  const REFUSED = 'Compose said: Error response from daemon: error while removing network: network hornhoof_default id 3f1e9a has active endpoints';
  const PREPARE = 'docker exec nodecid node /app/apps/node/dist/main.js prepare-stop hornhoof_update';

  it('makes the networks again once compose says other containers are on them, when the settings name their subnets already', async () => {
    const { s, first } = await handedOver('n7', PLAIN, NAMED_ENV);
    const t = await takeOver(s, { ...PLAIN, ...goesOnMeanwhile(s) });
    expect(t.status).toMatchObject({ id: 'n7', state: 'running', step: 'install' });
    expect(t.status.log).toContain(GOES_ON);
    expect(t.status.log).not.toContain(NO_START);
    const log = t.status.log.split('\n');
    expect(log.filter((line: string) => line === REFUSED)).toHaveLength(1);
    expect(log.indexOf(REMADE)).toBeGreaterThan(log.indexOf(REFUSED));
    const calls = t.calls.slice(first.calls.length);
    const refused = calls.indexOf('docker compose up -d --no-build --wait updater');
    const down = calls.indexOf(DOWN);
    expect(refused).toBeGreaterThan(-1);
    expect(calls.indexOf(PREPARE)).toBeGreaterThan(refused);
    expect(down).toBeGreaterThan(calls.indexOf(PREPARE));
    expect(calls.indexOf('docker compose up -d --no-build --wait db updater')).toBeGreaterThan(down);
    expect(calls.filter(c => c === DOWN)).toHaveLength(1);
    expect(envOf(s)).toContain('\nHORNHOOF_SUBNET=172.18.0.0/16\n');
    expect(envOf(s)).toContain('\nHORNHOOF_INTERNAL_SUBNET=172.19.0.0/16\n');
    const r = await runOnce(s, null, { ...PLAIN, STUB_BROKEN: '', STUB_PROJECT_CONTAINERS: MOVED_IN });
    expect(r.status).toMatchObject({ id: 'n7', state: 'done', step: 'finished' });
    expect(readState(s, 'running')).toBe('bbb');
  });

  it('makes the networks again only once, and then brings the build from before back whole with why in the log', async () => {
    const { s, first } = await handedOver('n8', PLAIN, NAMED_ENV);
    const t = await takeOver(s, { ...PLAIN, STUB_UPDATER_UP: 'never', HORNHOOF_TAKE_OVER_WAIT: '1' });
    expect(t.status).toMatchObject({ id: 'n8', state: 'running', step: 'rollback' });
    const log = t.status.log.split('\n');
    expect(log.filter((line: string) => line === REFUSED)).toHaveLength(1);
    expect(log.filter((line: string) => line === REMADE)).toHaveLength(1);
    expect(log.indexOf(NO_START)).toBeGreaterThan(log.indexOf(REMADE));
    const calls = t.calls.slice(first.calls.length);
    expect(calls.filter(c => c === 'docker compose up -d --no-build --wait db updater')).toHaveLength(1);
    expect(calls.filter(c => c === DOWN)).toHaveLength(2);
    expect(calls.indexOf(`all up ${refs('0.4.0')}`)).toBeGreaterThan(calls.lastIndexOf(DOWN));
    expect(composeOf(s)).toContain('# build 0.4.0');
    /* The settings had the subnets before the update, so they keep them. */
    expect(envOf(s)).toContain('\nHORNHOOF_SUBNET=172.18.0.0/16\n');
    expect(envOf(s)).toContain('\nHORNHOOF_INTERNAL_SUBNET=172.19.0.0/16\n');
    const r = await runRev1(s, null, PLAIN);
    expect(r.status).toMatchObject({ id: 'n8', state: 'rolled_back', step: 'finished' });
    expect(readState(s, 'running')).toBe('aaa');
    expect(readState(s, 'migrations')).toBe('20');
  });

  it('makes the networks again before it starts anything, when the settings name another subnet than a network has', async () => {
    const moved = `${PLAIN_ENV}HORNHOOF_SUBNET=10.200.5.0/24\nHORNHOOF_INTERNAL_SUBNET=172.19.0.0/16\n`;
    const { s, first } = await handedOver('n9', { ...PLAIN, STUB_NETWORKS: 'subnets' }, moved);
    const t = await takeOver(s, { ...PLAIN, STUB_NETWORKS: 'subnets', ...goesOnMeanwhile(s) });
    expect(t.status.log).toContain(REMADE);
    expect(t.status.log).toContain(GOES_ON);
    const calls = t.calls.slice(first.calls.length);
    expect(calls.findIndex(c => c.startsWith('docker compose up'))).toBeGreaterThan(calls.indexOf(DOWN));
    expect(calls).not.toContain('docker compose up -d --no-build --wait updater');
    expect(envOf(s)).toContain('\nHORNHOOF_SUBNET=10.200.5.0/24\n');
  });

  it('leaves networks made with the subnets the settings name as they are, and the built-in node runs on', async () => {
    const { s, first } = await handedOver('n10', { ...PLAIN, STUB_NETWORKS: 'subnets' }, NAMED_ENV);
    const t = await takeOver(s, { ...PLAIN, STUB_NETWORKS: 'subnets', ...goesOnMeanwhile(s) });
    expect(t.status).toMatchObject({ id: 'n10', state: 'running', step: 'install' });
    expect(t.status.log).toContain(GOES_ON);
    expect(t.status.log).not.toContain(REMADE);
    const calls = t.calls.slice(first.calls.length);
    expect(calls.filter(c => c.startsWith('docker compose'))).toEqual(['docker compose up -d --no-build --wait updater']);
    expect(calls).not.toContain(PREPARE);
  });

  it('does nothing when there is no status at all', async () => {
    const t = await takeOver(stand());
    expect(t.code).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.status).toBeNull();
  });
});

/* The orchestrator's commands on the server's computer, while the CEO keeps access to it open. */
