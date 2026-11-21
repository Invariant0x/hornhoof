import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP, ask, at, DIGESTS, JQ, NODE_DIGESTS, refs, runOnce, stand, startLoop, UPDATER_DIGESTS, type Stand } from './updater-fixture.js';
import { until } from './helpers-basic.js';

/* A machine that keeps none of the company's data: its compose file with the overlay names the core alone, and the
   build that runs is the keeper's. */
const WORKER = {
  HORNHOOF_ROLE: 'worker',
  HORNHOOF_HEALTH_URL: 'http://keeper:7080/api/keeper',
  STUB_SERVICES: 'front keeper updater',
  STUB_RUNNING_IMAGES: `keeper=${APP}@${DIGESTS['0.4.0']} updater=${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`,
};
const LATER = Math.floor(Date.now() / 1000) + 900;
const word = (over: object = {}) => JSON.stringify({ id: 'w1', commit: '0.4.1', until: LATER, ...over });
/* What happens while the updater waits a second: the keeper passes on the server's word, as this command writes it. */
const during = (s: Stand, script: string) => ({ STUB_DURING_SLEEP: script.replaceAll('$C', s.control).replaceAll('$K', s.computerControl).replaceAll('$S', s.dir) });
const said = (s: Stand, name: string) => JSON.parse(readFileSync(join(s.dir, name), 'utf8')) as { state: string; step: string; log: string };

describe('the updater of a worker', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  it('downloads the build, waits for its turn, and installs when the keeper passes on the word', async () => {
    const s = stand();
    /* A word from before this wait is for another request. */
    writeFileSync(join(s.computerControl, 'go.json'), word());
    /* While it waits: what it says, whether the old word is still there, and then the word. */
    const r = await runOnce(s, ask('w1'), {
      ...WORKER,
      ...during(s, `[ -f $S/in-wait ] || { cp $C/status.json $S/in-wait; [ -f $K/go.json ] && touch $S/old-word; }; printf '%s' '${word()}' > $K/go.json`),
    });
    expect(r.status).toMatchObject({ id: 'w1', version: '0.4.1', state: 'done', step: 'finished' });
    expect(said(s, 'in-wait')).toMatchObject({ state: 'running', step: 'wait' });
    expect(said(s, 'in-wait').log).toContain('Waiting for its turn to install.');
    expect(existsSync(join(s.dir, 'old-word'))).toBe(false);

    /* Both files of the build name what a worker runs, and the node image comes by itself. */
    const pull = r.calls.findIndex(c => c.startsWith(`docker compose --project-directory ${s.server} -f `) && c.endsWith(' pull'));
    expect(r.calls[pull]).toMatch(/-f \S+\/0\.4\.1\/compose\.yaml -f \S+\/0\.4\.1\/compose\.worker\.yaml pull$/);
    expect(r.calls[pull + 1]).toBe(`pull with HORNHOOF_VERSION=0.4.1 ${refs('0.4.1')}`);
    const node = at(r.calls, `docker pull ${APP}-node@${NODE_DIGESTS['0.4.1']}`);
    const install = r.calls.findIndex(c => c.startsWith('installer worker') && c.includes('HORNHOOF_VERSION=0.4.1 HORNHOOF_FROM_UPDATER=1'));
    const health = r.calls.findIndex(c => c.startsWith('curl') && c.includes('http://keeper:7080/api/keeper'));
    const swap = r.calls.findIndex(c => c.startsWith('docker run') && c.includes('compose up -d --no-build updater'));
    expect([pull, node, install, health, swap].every(i => i >= 0)).toBe(true);
    expect(pull).toBeLessThan(node);
    expect(node).toBeLessThan(install);
    expect(install).toBeLessThan(health);
    expect(health).toBeLessThan(swap);
    expect(r.calls[install]).toContain(`HORNHOOF_PULLED=1 ${refs('0.4.1')}`);
    /* It has no database: nothing is saved, and nothing but its keeper is named to compose. */
    expect(r.calls.filter(c => c.includes('pg_dump') || c.includes('psql') || c.includes('compose stop app'))).toEqual([]);
    expect(r.calls.some(c => c.startsWith('installer server'))).toBe(false);
    expect(r.calls).toContain('docker compose up -d --no-build --remove-orphans keeper');
    const kept = existsSync(join(s.server, 'backups')) ? readdirSync(join(s.server, 'backups')) : [];
    expect(kept.filter(name => name.endsWith('.sql.gz'))).toEqual([]);
  });

  it('takes no word that is for another request, another build or a moment that has passed', async () => {
    const s = stand();
    const past = Math.floor(Date.now() / 1000) - 5;
    const words = [word({ id: 'other' }), word({ commit: '0.4.0' }), word({ until: past }), '{}', 'not json'];
    /* Each wait brings the next of these, and none is taken, so the wait ends by itself. */
    const script = `n=$(cat $S/n 2> /dev/null || echo 0); case $n in ${words.map((w, i) => `${i}) printf '%s' '${w}' > $K/go.json ;;`).join(' ')} esac; echo $((n + 1)) > $S/n`;
    const r = await runOnce(s, ask('w1'), { ...WORKER, HORNHOOF_TURN_WAIT: '12', ...during(s, script) });
    expect(r.status).toMatchObject({ id: 'w1', state: 'failed', step: 'finished' });
    expect(r.status.log).toContain('The company server did not give this machine its turn within a day.');
    expect(Number(readFileSync(join(s.dir, 'n'), 'utf8'))).toBeGreaterThanOrEqual(words.length);
    expect(r.calls.some(c => c.startsWith('installer'))).toBe(false);
  });

  it('ignores a rollout approval planted in the app-writable control folder while waiting for its turn', async () => {
    const s = stand();
    const r = await runOnce(s, ask('w1'), {
      ...WORKER,
      HORNHOOF_TURN_WAIT: '4',
      ...during(s, `printf '%s' '${word()}' > $C/go.json`),
    });
    expect(r.status).toMatchObject({ id: 'w1', state: 'failed', step: 'finished' });
    expect(r.status.log).toContain('The company server did not give this machine its turn within a day.');
    expect(r.calls.some(c => c.startsWith('installer'))).toBe(false);
  });

  it('leaves a build that waits when a newer one is asked for', async () => {
    const s = stand();
    const newer = JSON.stringify({ ...ask('w2'), version: '0.4.2' });
    const r = await runOnce(s, ask('w1'), { ...WORKER, ...during(s, `printf '%s' '${newer}' > $C/request.json`) });
    expect(r.status).toMatchObject({ id: 'w1', state: 'failed', step: 'finished' });
    expect(r.status.log).toContain('A newer build came first, so this one was left.');
    expect(r.calls.some(c => c.startsWith('installer'))).toBe(false);
  });

  it('goes back without restoring anything when the new build does not answer', async () => {
    const s = stand();
    const r = await runOnce(s, ask('w1'), { ...WORKER, STUB_BROKEN: '0.4.1', ...during(s, `printf '%s' '${word()}' > $K/go.json`) });
    expect(r.status).toMatchObject({ id: 'w1', state: 'rolled_back', step: 'finished' });
    expect(r.status.log).toContain('This machine runs the build from before the update again.');
    const installs = r.calls.filter(c => c.startsWith('installer'));
    expect(installs.map(c => c.split(' ')[1])).toEqual(['worker', 'worker']);
    expect(installs[1]).toContain(`HORNHOOF_VERSION=0.4.0`);
    expect(installs[1]).toContain(`HORNHOOF_APP_REF=${APP}@${DIGESTS['0.4.0']}`);
    expect(r.calls.some(c => c.includes('pg_dump') || c.includes('psql') || c.includes('__drizzle_migrations'))).toBe(false);
    expect(r.calls.some(c => c.includes('compose up -d --no-build updater'))).toBe(false);
  });

  it('starts a build over when it was stopped while it waited', async () => {
    const s = stand();
    /* The updater's container goes while it waits, as with a restart of Docker; the next one finds the note. */
    const first = await runOnce(s, ask('w1'), { ...WORKER, ...during(s, 'kill -9 $(ps -o ppid= -p $PPID)') });
    expect(first.status).toMatchObject({ id: 'w1', state: 'running', step: 'wait' });
    const again = await runOnce(s, null, { ...WORKER, ...during(s, `printf '%s' '${word()}' > $K/go.json`) });
    expect(again.status).toMatchObject({ id: 'w1', state: 'done', step: 'finished' });
    /* It waited for its turn again: the word from before the stop would be for nobody. */
    expect(again.status.log).toContain('Waiting for its turn to install.');
    expect(again.calls.filter(c => c.startsWith('installer worker'))).toHaveLength(1);
  });

  /* A node whose work would not end while the core moved stays on its image; nothing else would ever move it. */
  it('looks at the nodes again by itself, with the installer of its own build and the images its settings name', async () => {
    const refs = `HORNHOOF_APP_REF=${APP}@${DIGESTS['0.4.1']}\nHORNHOOF_NODE_REF=${APP}-node@${NODE_DIGESTS['0.4.1']}\nHORNHOOF_UPDATER_REF=${APP}-updater@${UPDATER_DIGESTS['0.4.1']}\n`;
    const s = stand(`HORNHOOF_ROLE=worker\nHORNHOOF_VERSION=0.4.1\n${refs}`);
    const installer = join(s.dir, 'own-install.sh');
    writeFileSync(installer, `printf 'own installer %s nodes=%s dir=%s node=%s from=%s\\n' "$*" "$HORNHOOF_WORKER_NODES" "$HORNHOOF_SERVER_DIR" "$HORNHOOF_NODE_REF" "$HORNHOOF_FROM_UPDATER" >> "$STUB_LOG"\n`);
    const r = await runOnce(s, null, { ...WORKER, HORNHOOF_INSTALLER: installer });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`own installer worker nodes=1 dir=${s.server} node=${APP}-node@${NODE_DIGESTS['0.4.1']} from=1`);
    /* A server's updater asks its server about its nodes, as before, and runs no such installer. */
    const server = stand();
    const asServer = await runOnce(server, null, { HORNHOOF_INSTALLER: installer });
    expect(asServer.calls.some(call => call.startsWith('own installer'))).toBe(false);
    /* A core whose settings name no image of Hornhoof's own is left alone. */
    const odd = stand('HORNHOOF_ROLE=worker\nHORNHOOF_NODE_REF=ghcr.io/acme/other:latest\n');
    expect((await runOnce(odd, null, { ...WORKER, HORNHOOF_INSTALLER: installer })).calls.some(call => call.startsWith('own installer'))).toBe(false);
  });

  /* The installer waits there for a node's work to end, which may take hours. */
  it("reads a request while its look at the nodes waits for a node's work, and installs after that look", async () => {
    const s = stand(`HORNHOOF_ROLE=worker\nHORNHOOF_VERSION=0.4.0\n${refs('0.4.0').replaceAll(' ', '\n')}\n`);
    const installer = join(s.dir, 'own-install.sh');
    const release = join(s.dir, 'release');
    writeFileSync(installer, `printf 'own installer start\\n' >> "$STUB_LOG"\nuntil [ -e ${release} ] || [ ! -d ${s.dir} ]; do /bin/sleep 0.05; done\nprintf 'own installer end\\n' >> "$STUB_LOG"\n`);
    const loop = startLoop(s, { ...WORKER, HORNHOOF_INSTALLER: installer });
    await until(() => loop.calls().includes('own installer start'));
    writeFileSync(join(s.control, 'request.json'), JSON.stringify(ask('w1')));
    await until(() => loop.status()?.step === 'wait');
    /* Its turn comes while the look still waits: the install waits for the look, so no two installers move one node. */
    writeFileSync(join(s.computerControl, 'go.json'), word());
    await until(() => loop.status()?.log.includes("Waiting for the look at this machine's nodes to end.") ?? false);
    expect(loop.calls()).not.toContain('own installer end');
    expect(loop.calls().some(call => call.startsWith('installer worker'))).toBe(false);
    writeFileSync(release, '');
    await until(() => loop.status()?.state === 'done');
    const calls = loop.calls();
    expect(calls.indexOf('own installer end')).toBeLessThan(calls.findIndex(call => call.startsWith('installer worker')));
    /* One look at a time: none began while the first waited. */
    expect(calls.slice(0, calls.indexOf('own installer end')).filter(call => call === 'own installer start')).toHaveLength(1);
  });

  it("writes the machine's own addresses on Linux, and leaves them when it cannot read them", async () => {
    const s = stand();
    const interfaces = [
      '2: eth0    inet 192.0.2.4/24 brd 192.0.2.255 scope global eth0\\       valid_lft forever preferred_lft forever',
      '3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever',
      '4: br-1a2b3c4d5e6f    inet 172.18.0.1/16 brd 172.18.255.255 scope global br-1a2b3c4d5e6f\\       valid_lft forever preferred_lft forever',
      '7: veth0a1b2c    inet 169.254.9.9/16 scope global veth0a1b2c\\       valid_lft forever preferred_lft forever',
      '8: wlan0    inet 10.0.0.7/8 brd 10.255.255.255 scope global dynamic wlan0\\       valid_lft 86000sec preferred_lft 86000sec',
    ].join('\n');
    const r = await runOnce(s, null, { HORNHOOF_HOST_OS: 'linux', STUB_IP: interfaces });
    expect(r.calls.some(c => c.startsWith('docker run --rm --network host --entrypoint ip ') && c.endsWith(' -4 -o addr show scope global'))).toBe(true);
    const file = JSON.parse(readFileSync(join(s.control, 'addresses.json'), 'utf8')) as { at: number; addresses: string[] };
    expect(file.addresses).toEqual(['192.0.2.4', '10.0.0.7']);
    expect(Math.abs(file.at - Date.now() / 1000)).toBeLessThan(60);

    const failed = await runOnce(s, null, { HORNHOOF_HOST_OS: 'linux', STUB_IP: 'fail' });
    expect(failed.code).toBe(0);
    expect((JSON.parse(readFileSync(join(s.control, 'addresses.json'), 'utf8')) as { addresses: string[] }).addresses).toEqual(['192.0.2.4', '10.0.0.7']);

    /* On a Mac the installer writes the addresses down, and no container looks. */
    const mac = stand();
    const m = await runOnce(mac, null, { HORNHOOF_HOST_OS: 'darwin', STUB_IP: interfaces });
    expect(m.calls.some(c => c.includes('--entrypoint ip'))).toBe(false);
    expect(existsSync(join(mac.control, 'addresses.json'))).toBe(false);
  });

  it('learns from a plain Linux engine what the machine is, where no installer on the computer said', async () => {
    const interfaces = '2: eth0    inet 192.0.2.4/24 brd 192.0.2.255 scope global eth0\\       valid_lft forever preferred_lft forever';
    const hostOf = (control: string) => (existsSync(join(control, 'host.json')) ? (JSON.parse(readFileSync(join(control, 'host.json'), 'utf8')) as object) : null);
    /* A server that came to this build by Update: its .env names no system, and the engine is the computer's own. */
    const s = stand();
    const r = await runOnce(s, null, { HORNHOOF_HOST_OS: '', STUB_INFO: 'Debian GNU/Linux 12 (bookworm)|host-a', STUB_IP: interfaces });
    expect(r.code).toBe(0);
    expect(hostOf(s.control)).toEqual({ os: 'linux', hostname: 'host-a' });
    expect((JSON.parse(readFileSync(join(s.control, 'addresses.json'), 'utf8')) as { addresses: string[] }).addresses).toEqual(['192.0.2.4']);
    /* An engine in a machine of its own says nothing of the computer, and neither does one that does not answer. */
    for (const info of ['Docker Desktop|docker-desktop', 'OrbStack|orbstack', 'fail', '']) {
      const other = stand();
      const ran = await runOnce(other, null, { HORNHOOF_HOST_OS: '', STUB_INFO: info, STUB_IP: interfaces });
      expect([info, ran.code, hostOf(other.control), existsSync(join(other.control, 'addresses.json'))]).toEqual([info, 0, null, false]);
      expect(ran.calls.some(c => c.includes('--entrypoint ip')), info).toBe(false);
    }
    /* A name that is no host's name is left out, and the system still counts. */
    const odd = stand();
    await runOnce(odd, null, { HORNHOOF_HOST_OS: '', STUB_INFO: 'Ubuntu 24.04|not a name; rm -rf', STUB_IP: interfaces });
    expect(hostOf(odd.control)).toEqual({ os: 'linux', hostname: '' });
    /* What the installer wrote stands, and the engine is not asked. */
    const told = stand();
    const t = await runOnce(told, null, { HORNHOOF_HOST_OS: 'darwin', STUB_INFO: 'Ubuntu 24.04|host-a', STUB_IP: interfaces });
    expect([hostOf(told.control), t.calls.some(c => c.startsWith('docker info'))]).toEqual([null, false]);
  });
});
