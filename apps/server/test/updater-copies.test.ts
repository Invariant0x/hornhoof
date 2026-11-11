import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP, ask, DIGESTS, JQ, runOnce, stand, startLoop, UPDATER_DIGESTS, type Stand } from './updater-fixture.js';
import { until } from './helpers-basic.js';

/* A machine that joined the company. Once it keeps a copy, its compose files name the database and the app as well. */
const OWN_IMAGE = `${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`;
const WORKER = {
  HORNHOOF_ROLE: 'worker',
  HORNHOOF_HEALTH_URL: 'http://keeper:7080/api/keeper',
  STUB_SERVICES: 'front keeper db migrate app updater',
  STUB_RUNNING_IMAGES: `keeper=${APP}@${DIGESTS['0.4.0']} updater=${OWN_IMAGE}`,
  STUB_OWN_IMAGE: OWN_IMAGE,
  STUB_LOG_ROLE: '1',
};
const SECRETS = { HORNHOOF_SECRET: Buffer.alloc(32, 7).toString('base64'), NODE_KEY: 'n'.repeat(44), RELAY_URL: 'https://relay.hornhoof.test' };
const WORKER_ENV = 'COMPOSE_FILE=compose.yaml:compose.worker.yaml\nHORNHOOF_ROLE=worker\nHORNHOOF_SECRET=\nNODE_KEY=\nHORNHOOF_VERSION=0.4.0\n';
const FAILED_LINE = "The company's settings cannot be written here, so this machine stays a worker.";

const envOf = (s: Stand): Record<string, string> =>
  Object.fromEntries(readFileSync(join(s.server, '.env'), 'utf8').split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const has = (s: Stand, name: string) => existsSync(join(s.control, name));
const asked = (s: Stand, secrets: object = SECRETS) => {
  writeFileSync(join(s.control, 'replica.json'), JSON.stringify({ since: '2026-11-11T12:00:00.000Z' }));
  writeFileSync(join(s.control, 'role.json'), JSON.stringify({ id: 'r1', secrets }), { mode: 0o600 });
};
/* Every word any command was given, and everything the updater said. */
const everything = (s: Stand, r: { out: string; calls: string[] }) => [r.out, ...r.calls, ...readdirSync(s.control).map(name => (statSync(join(s.control, name)).isFile() ? readFileSync(join(s.control, name), 'utf8') : ''))].join('\n');
const upOf = (calls: string[], services: string) => calls.findIndex(c => c === `docker compose up -d --no-build ${services}`);

describe('the updater of a worker that is given the data', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  it('makes a worker a data machine', async () => {
    const s = stand(WORKER_ENV);
    asked(s);
    const r = await runOnce(s, null, WORKER);
    const env = envOf(s);
    expect(env).toMatchObject({ ...SECRETS, HORNHOOF_ROLE: 'data', COMPOSE_PROFILES: 'data', COMPOSE_FILE: 'compose.yaml:compose.worker.yaml', HORNHOOF_VERSION: '0.4.0' });
    expect(env.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(statSync(join(s.server, '.env')).mode & 0o777).toBe(0o600);
    /* Everything but the updater starts, as a data machine, whatever role the updater itself was started with. */
    const up = upOf(r.calls, 'front keeper db migrate app');
    expect(up).toBeGreaterThanOrEqual(0);
    expect(r.calls[up + 1]).toBe('up as HORNHOOF_ROLE=data');
    /* Then the updater itself, on the image it runs: no update was asked for. */
    const swap = r.calls.findIndex(c => c.startsWith('docker run') && c.includes(`--entrypoint docker ${OWN_IMAGE} compose up -d --no-build updater`));
    expect(swap).toBeGreaterThan(up);
    expect(has(s, 'role.json')).toBe(false);
    expect(has(s, 'role.failed')).toBe(false);
    expect(has(s, 'replica.json')).toBe(true);
    expect(existsSync(join(s.server, '.env.before-data'))).toBe(false);
    /* No secret is said or handed to a command. */
    const all = everything(s, r);
    for (const secret of [SECRETS.HORNHOOF_SECRET, SECRETS.NODE_KEY, env.POSTGRES_PASSWORD!]) expect(all.includes(secret)).toBe(false);
  });

  it('keeps a password that is there, and a node key the company has none of', async () => {
    const s = stand(`${WORKER_ENV}POSTGRES_PASSWORD=abc\n`);
    asked(s, { ...SECRETS, NODE_KEY: '' });
    await runOnce(s, null, WORKER);
    expect(envOf(s)).toMatchObject({ POSTGRES_PASSWORD: 'abc', NODE_KEY: '', HORNHOOF_SECRET: SECRETS.HORNHOOF_SECRET, HORNHOOF_ROLE: 'data' });
  });

  it('stays a worker when it cannot', async () => {
    const cases: [string, object, Record<string, string>][] = [
      ['a node key that cannot stand in the settings', { ...SECRETS, NODE_KEY: 'two words' }, {}],
      ['no secret', { ...SECRETS, HORNHOOF_SECRET: '' }, {}],
      ['a relay address with a line of its own', { ...SECRETS, RELAY_URL: 'https://relay.hornhoof.test\nX=1' }, {}],
      ['a database that does not start', SECRETS, { STUB_UP: 'fail' }],
    ];
    for (const [name, secrets, env] of cases) {
      const s = stand(WORKER_ENV);
      asked(s, secrets);
      const r = await runOnce(s, null, { ...WORKER, ...env });
      expect(readFileSync(join(s.server, '.env'), 'utf8'), name).toBe(WORKER_ENV);
      expect([has(s, 'role.json'), has(s, 'replica.json'), existsSync(join(s.server, '.env.before-data'))], name).toEqual([false, false, false]);
      expect(readFileSync(join(s.control, 'role.failed'), 'utf8').trim(), name).toBe(FAILED_LINE);
      expect(statSync(join(s.control, 'role.failed')).mode & 0o777, name).toBe(0o600);
      /* What may have started is taken away, and the worker's own two run as a worker's. */
      const rm = r.calls.findIndex(c => c === 'docker compose rm -sf db migrate app');
      const up = upOf(r.calls, 'front keeper');
      expect(rm, name).toBeGreaterThanOrEqual(0);
      expect(up, name).toBeGreaterThan(rm);
      expect(r.calls[up + 1], name).toBe('up as HORNHOOF_ROLE=worker');
      expect(r.out, name).toContain('This machine stays a worker');
      expect(r.calls.some(c => c.includes('compose up -d --no-build updater')), name).toBe(false);
      expect(everything(s, r).includes(SECRETS.HORNHOOF_SECRET), name).toBe(false);
    }
  });

  it('finishes what a restart cut short', async () => {
    /* It stopped after the settings were written: the start and the swap run again, and the settings of before go. */
    const done = stand(`${WORKER_ENV.replace('HORNHOOF_ROLE=worker', 'HORNHOOF_ROLE=data')}COMPOSE_PROFILES=data\nPOSTGRES_PASSWORD=abc\n`);
    writeFileSync(join(done.server, '.env.before-data'), WORKER_ENV);
    writeFileSync(join(done.control, 'replica.json'), '{}');
    const r = await runOnce(done, null, WORKER);
    const up = upOf(r.calls, 'front keeper db migrate app');
    expect(up).toBeGreaterThanOrEqual(0);
    expect(r.calls.findIndex(c => c.includes('compose up -d --no-build updater'))).toBeGreaterThan(up);
    expect(existsSync(join(done.server, '.env.before-data'))).toBe(false);
    expect(envOf(done)).toMatchObject({ HORNHOOF_ROLE: 'data', COMPOSE_PROFILES: 'data' });
    expect(has(done, 'replica.json')).toBe(true);

    /* It stopped while it wrote them: the settings of before come back whole, and the machine stays a worker. */
    const half = stand(`${WORKER_ENV}HORNHOOF_SECRET=${SECRETS.HORNHOOF_SECRET}\n`);
    writeFileSync(join(half.server, '.env.before-data'), WORKER_ENV);
    writeFileSync(join(half.control, 'replica.json'), '{}');
    writeFileSync(join(half.control, 'role.json'), JSON.stringify({ id: 'r1', secrets: SECRETS }));
    const back = await runOnce(half, null, WORKER);
    expect(readFileSync(join(half.server, '.env'), 'utf8')).toBe(WORKER_ENV);
    expect([has(half, 'role.json'), has(half, 'replica.json'), existsSync(join(half.server, '.env.before-data'))]).toEqual([false, false, false]);
    expect(readFileSync(join(half.control, 'role.failed'), 'utf8').trim()).toBe(FAILED_LINE);
    expect(upOf(back.calls, 'front keeper')).toBeGreaterThanOrEqual(0);
  });

  it('swaps itself when its role is not the one its settings name', async () => {
    const s = stand(`${WORKER_ENV.replace('HORNHOOF_ROLE=worker', 'HORNHOOF_ROLE=data')}COMPOSE_PROFILES=data\n`);
    writeFileSync(join(s.control, 'replica.json'), '{}');
    /* Each wait of the loop leaves a mark, so the test counts the rounds that passed and no clock does. */
    const loop = startLoop(s, { ...WORKER, STUB_DURING_SLEEP: `echo round >> ${s.dir}/rounds; /bin/sleep 0.02` });
    const swaps = () => loop.calls().filter(c => c.startsWith('docker run') && c.includes('compose up -d --no-build updater'));
    const rounds = () => (existsSync(join(s.dir, 'rounds')) ? readFileSync(join(s.dir, 'rounds'), 'utf8').split('\n').length : 0);
    await until(() => swaps().length > 0);
    expect(swaps()[0]).toContain(`--entrypoint docker ${OWN_IMAGE} compose`);
    /* A swap that did not take is tried again a minute later at the soonest: the rounds in between try none. */
    const before = rounds();
    await until(() => rounds() > before + 20);
    expect(swaps()).toHaveLength(1);
    /* A server's own settings name no role, and its updater leaves itself alone. */
    const server = stand();
    const r = await runOnce(server, null, { STUB_OWN_IMAGE: OWN_IMAGE });
    expect(r.calls.some(c => c.includes('compose up -d --no-build updater'))).toBe(false);
  });

  it('updates a copy as a worker', async () => {
    const s = stand(`${WORKER_ENV.replace('HORNHOOF_ROLE=worker', 'HORNHOOF_ROLE=data')}COMPOSE_PROFILES=data\n`);
    writeFileSync(join(s.control, 'replica.json'), '{}');
    const later = Math.floor(Date.now() / 1000) + 900;
    const word = JSON.stringify({ id: 'w1', commit: '0.4.1', until: later });
    const r = await runOnce(s, ask('w1'), { ...WORKER, HORNHOOF_ROLE: 'data', STUB_DURING_SLEEP: `printf '%s' '${word}' > ${s.control}/go.json` });
    expect(r.status).toMatchObject({ id: 'w1', state: 'done', step: 'finished' });
    expect(r.status.log).toContain('Waiting for its turn to install.');
    /* No copy of its database is saved and no migration is counted: its schema is the company server's. */
    expect(r.calls.filter(c => c.includes('pg_dump') || c.includes('__drizzle_migrations') || c.includes('compose stop app'))).toEqual([]);
    expect(r.calls.some(c => c.startsWith('installer worker'))).toBe(true);
    expect(r.calls.some(c => c.startsWith('installer server'))).toBe(false);
    const kept = existsSync(join(s.server, 'backups')) ? readdirSync(join(s.server, 'backups')) : [];
    expect(kept.filter(name => name.endsWith('.sql.gz'))).toEqual([]);
  });
});
