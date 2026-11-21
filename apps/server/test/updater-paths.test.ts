import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP, ask, DIGESTS, JQ, runOnce, stand, UPDATER_DIGESTS, type Stand } from './updater-fixture.js';

/* What a machine is now decides how it updates: whether it leads, keeps a copy or keeps none of the data picks the
   steps, and whether it joined the company or the company was installed on it picks the installer and its files. */
const ALL = 'front keeper db migrate app node updater';
const OWN_IMAGE = `${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`;
const KEEPER = `keeper=${APP}@${DIGESTS['0.4.0']} app=${APP}@${DIGESTS['0.4.0']} updater=${OWN_IMAGE}`;
const SERVER_ENV = 'HORNHOOF_SECRET=s\nPOSTGRES_PASSWORD=p\nHORNHOOF_VERSION=0.4.0\n';
const JOINED_ENV = `COMPOSE_FILE=compose.yaml:compose.worker.yaml\nHORNHOOF_ROLE=data\nCOMPOSE_PROFILES=data,builtin\nHORNHOOF_JOIN_SERVER=https://acme.hornhoof.test\n${SERVER_ENV}`;
const KEEPER_HEALTH = 'http://keeper:7080/api/keeper';
const LATER = Math.floor(Date.now() / 1000) + 900;
/* While the updater waits a second, the keeper passes on the server's word for this request. */
const turn = (s: Stand, id: string) => ({ STUB_DURING_SLEEP: `printf '%s' '${JSON.stringify({ id, commit: '0.4.1', until: LATER })}' > ${s.computerControl}/go.json` });
const copies = (s: Stand) => writeFileSync(join(s.control, 'replica.json'), JSON.stringify({ since: '2026-11-11T12:00:00.000Z' }));
const envOf = (s: Stand): Record<string, string> =>
  Object.fromEntries(readFileSync(join(s.server, '.env'), 'utf8').split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

/* What one update did, as far as its path and its installer show. */
function took(r: { calls: string[]; status: { state: string; log: string } }) {
  const pull = r.calls.find(c => c.startsWith('docker compose --project-directory ') && c.endsWith(' pull')) ?? '';
  return {
    state: r.status.state,
    promise: r.status.log.includes('Asking the copies to wait for the update.'),
    dump: r.calls.some(c => c.includes('pg_dump')),
    wait: r.status.log.includes('Waiting for its turn to install.'),
    installer: r.calls.find(c => c.startsWith('installer '))?.split(' ')[1],
    overlay: pull.includes('compose.worker.yaml'),
    health: [...new Set(r.calls.filter(c => c.startsWith('curl') && /\/api\/(health|keeper)$/.test(c)).map(c => c.split(' ').at(-1)))],
  };
}

describe('the updater by what its machine is now', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  it('picks its path and installer', async () => {
    /* The machine the company was installed on, which leads: it asks the copies, saves the database and runs a server's installer. */
    const server = stand(SERVER_ENV);
    expect(took(await runOnce(server, ask('p1'), { HORNHOOF_ROLE: 'data', STUB_SERVICES: ALL }))).toEqual({
      state: 'done', promise: true, dump: true, wait: false, installer: 'server', overlay: false, health: ['http://front:8080/api/health'],
    });

    /* The same machine once it follows another: a copy waits for its turn and saves nothing, with a server's files, and
       its own keeper says whether the build runs. */
    const follows = stand(SERVER_ENV);
    copies(follows);
    const followed = await runOnce(follows, ask('p2'), { HORNHOOF_ROLE: 'data', STUB_SERVICES: ALL, STUB_RUNNING_IMAGES: KEEPER, ...turn(follows, 'p2') });
    expect(took(followed)).toEqual({ state: 'done', promise: false, dump: false, wait: true, installer: 'server', overlay: false, health: [KEEPER_HEALTH] });
    expect(followed.calls.some(c => c.includes('compose.worker.yaml'))).toBe(false);

    /* A machine that joined and leads now: a leader's steps, with a joined machine's files, and the health of the app. */
    const leads = stand(JOINED_ENV);
    const led = await runOnce(leads, ask('p3'), { HORNHOOF_ROLE: 'data', HORNHOOF_HEALTH_URL: KEEPER_HEALTH, STUB_SERVICES: ALL });
    expect(took(led)).toEqual({ state: 'done', promise: true, dump: true, wait: false, installer: 'worker', overlay: true, health: ['http://front:8080/api/health'] });
    expect(led.calls.some(c => c.startsWith('docker cp cid-0.4.1:/app/apps/server/drizzle/meta/_journal.json '))).toBe(true);

    /* A machine that joined and keeps a copy: as before. */
    const joined = stand(JOINED_ENV);
    copies(joined);
    const kept = await runOnce(joined, ask('p4'), { HORNHOOF_ROLE: 'data', HORNHOOF_HEALTH_URL: KEEPER_HEALTH, STUB_SERVICES: ALL, STUB_RUNNING_IMAGES: KEEPER, ...turn(joined, 'p4') });
    expect(took(kept)).toEqual({ state: 'done', promise: false, dump: false, wait: true, installer: 'worker', overlay: true, health: [KEEPER_HEALTH] });
  });

  it('keeps the path it began with when the machine changes in the middle', async () => {
    /* A copy that waits for its turn is promoted meanwhile: its marker goes. It ends the update as it began it, with
       nothing saved and nothing put back. */
    const s = stand(JOINED_ENV);
    copies(s);
    const r = await runOnce(s, ask('p5'), {
      HORNHOOF_ROLE: 'data', HORNHOOF_HEALTH_URL: KEEPER_HEALTH, STUB_SERVICES: ALL, STUB_RUNNING_IMAGES: KEEPER, STUB_BROKEN: '0.4.1',
      STUB_DURING_SLEEP: `rm -f ${s.control}/replica.json; ${turn(s, 'p5').STUB_DURING_SLEEP}`,
    });
    expect(r.status).toMatchObject({ state: 'rolled_back' });
    expect(r.status.log).toContain('This machine runs the build from before the update again.');
    expect(r.calls.some(c => c.includes('pg_dump') || c.includes('hornhoof_restore') || c.includes('pg_drop_replication_slot'))).toBe(false);
    expect(r.calls.filter(c => c.startsWith('installer ')).map(c => c.split(' ')[1])).toEqual(['worker', 'worker']);
  });

  /* The stub names what is left with no profile on, but for the node. */
  const COPY = { HORNHOOF_ROLE: 'data', STUB_SERVICES: 'front keeper db migrate app updater', STUB_RUNNING_IMAGES: KEEPER, STUB_OWN_IMAGE: OWN_IMAGE };
  const wipe = (s: Stand, more: object) => writeFileSync(join(s.control, 'wipe.json'), JSON.stringify({ id: randomUUID(), ...more }), { mode: 0o600 });

  it("wipes a server's install into a worker", async () => {
    const s = stand(SERVER_ENV);
    copies(s);
    wipe(s, { server: 'https://acme.hornhoof.test' });
    const r = await runOnce(s, null, COPY);
    expect(existsSync(join(s.control, 'wiped.json')), r.out).toBe(true);
    /* Its settings name a joined machine's files and the company to reach, with what every wipe leaves. */
    expect(envOf(s)).toEqual({
      HORNHOOF_SECRET: '', POSTGRES_PASSWORD: '', HORNHOOF_VERSION: '0.4.0', HORNHOOF_ROLE: 'worker',
      COMPOSE_FILE: 'compose.yaml:compose.worker.yaml', HORNHOOF_JOIN_SERVER: 'https://acme.hornhoof.test',
    });
    /* The overlay came from the build that runs here, before the settings named it. */
    expect(readFileSync(join(s.server, 'compose.worker.yaml'), 'utf8')).toContain('# build 0.4.0');
    expect(r.calls).toContain('docker compose up -d --no-build --remove-orphans front keeper');
    expect(existsSync(join(s.control, 'replica.json'))).toBe(false);

    /* Without the company's address a worker here could reach nobody: nothing goes. */
    for (const server of ['http://x', 'https://', 'https://acme.hornhoof.test/path', 'https://a b', undefined]) {
      const refused = stand(SERVER_ENV);
      copies(refused);
      wipe(refused, server === undefined ? {} : { server });
      const kept = await runOnce(refused, null, COPY);
      expect(readFileSync(join(refused.server, '.env'), 'utf8'), String(server)).toBe(SERVER_ENV);
      expect(kept.calls.some(c => c.includes(' rm -sf ') || c.startsWith('docker volume rm'))).toBe(false);
      expect(kept.out.split('\n').filter(line => line.includes('names no address of the company'))).toHaveLength(1);
      expect([existsSync(join(refused.control, 'wiped.json')), existsSync(join(refused.control, 'replica.json'))]).toEqual([false, true]);
    }

    /* A machine that joined needs none: its settings name the company already. */
    const joined = stand(JOINED_ENV);
    copies(joined);
    wipe(joined, {});
    await runOnce(joined, null, COPY);
    expect(existsSync(join(joined.control, 'wiped.json'))).toBe(true);
    expect(envOf(joined)).toMatchObject({ HORNHOOF_ROLE: 'worker', COMPOSE_FILE: 'compose.yaml:compose.worker.yaml', HORNHOOF_JOIN_SERVER: 'https://acme.hornhoof.test' });

    /* A company server that leads is never wiped, whatever the request names. */
    const leader = stand(SERVER_ENV);
    wipe(leader, { server: 'https://acme.hornhoof.test' });
    const left = await runOnce(leader, null, { HORNHOOF_ROLE: 'data', STUB_SERVICES: ALL });
    expect(left.calls.some(c => c.includes(' rm -sf ') || c.includes('volume'))).toBe(false);
    expect([existsSync(join(leader.control, 'wipe.json')), readFileSync(join(leader.server, '.env'), 'utf8')]).toEqual([false, SERVER_ENV]);
  });
});
