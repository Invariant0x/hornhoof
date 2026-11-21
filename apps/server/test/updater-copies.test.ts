import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    /* The profiles start its database and app, and its own built-in node, which runs the company's keys' work. */
    expect(env).toMatchObject({ ...SECRETS, HORNHOOF_ROLE: 'data', COMPOSE_PROFILES: 'data,builtin', COMPOSE_FILE: 'compose.yaml:compose.worker.yaml', HORNHOOF_VERSION: '0.4.0' });
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
      /* The settings of before come back. Where the database was started, its password stays with them: its volume
         was made with it, and the next try finds it there. */
      const started = env.STUB_UP === 'fail';
      const settings = readFileSync(join(s.server, '.env'), 'utf8');
      if (started) expect(settings, name).toMatch(new RegExp(`^${WORKER_ENV.replaceAll('.', '\\.')}POSTGRES_PASSWORD=[A-Za-z0-9]{24}\n$`));
      else expect(settings, name).toBe(WORKER_ENV);
      expect([has(s, 'role.json'), has(s, 'replica.json'), existsSync(join(s.server, '.env.before-data'))], name).toEqual([false, false, false]);
      expect(readFileSync(join(s.control, 'role.failed'), 'utf8').trim(), name).toBe(FAILED_LINE);
      expect(statSync(join(s.control, 'role.failed')).mode & 0o777, name).toBe(0o600);
      /* What may have started is taken away, and the worker's own two run as a worker's. */
      const rm = r.calls.findIndex(c => c === 'docker compose rm -sf db migrate app node');
      const up = upOf(r.calls, 'front keeper');
      expect(rm, name).toBeGreaterThanOrEqual(0);
      expect(up, name).toBeGreaterThan(rm);
      expect(r.calls[up + 1], name).toBe('up as HORNHOOF_ROLE=worker');
      expect(r.out, name).toContain('This machine stays a worker');
      expect(r.calls.some(c => c.includes('compose up -d --no-build updater')), name).toBe(false);
      expect(everything(s, r).includes(SECRETS.HORNHOOF_SECRET), name).toBe(false);
      if (!started) continue;
      /* The next try starts the database with the password its volume has. */
      const password = envOf(s).POSTGRES_PASSWORD!;
      expect([r.out, ...r.calls].join('\n').includes(password), name).toBe(false);
      rmSync(join(s.control, 'role.failed'));
      asked(s, secrets);
      await runOnce(s, null, WORKER);
      expect(envOf(s), name).toMatchObject({ POSTGRES_PASSWORD: password, HORNHOOF_ROLE: 'data' });
    }
  });

  it('finishes what a restart cut short', async () => {
    /* It stopped after the settings were written: the start and the swap run again, and the settings of before go. */
    const done = stand(`${WORKER_ENV.replace('HORNHOOF_ROLE=worker', 'HORNHOOF_ROLE=data')}COMPOSE_PROFILES=data,builtin\nPOSTGRES_PASSWORD=abc\n`);
    writeFileSync(join(done.server, '.env.before-data'), WORKER_ENV);
    writeFileSync(join(done.control, 'replica.json'), '{}');
    const r = await runOnce(done, null, WORKER);
    const up = upOf(r.calls, 'front keeper db migrate app');
    expect(up).toBeGreaterThanOrEqual(0);
    expect(r.calls.findIndex(c => c.includes('compose up -d --no-build updater'))).toBeGreaterThan(up);
    expect(existsSync(join(done.server, '.env.before-data'))).toBe(false);
    expect(envOf(done)).toMatchObject({ HORNHOOF_ROLE: 'data', COMPOSE_PROFILES: 'data,builtin' });
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
    const s = stand(`${WORKER_ENV.replace('HORNHOOF_ROLE=worker', 'HORNHOOF_ROLE=data')}COMPOSE_PROFILES=data,builtin\n`);
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
    const s = stand(`${WORKER_ENV.replace('HORNHOOF_ROLE=worker', 'HORNHOOF_ROLE=data')}COMPOSE_PROFILES=data,builtin\n`);
    writeFileSync(join(s.control, 'replica.json'), '{}');
    const later = Math.floor(Date.now() / 1000) + 900;
    const word = JSON.stringify({ id: 'w1', commit: '0.4.1', until: later });
    const r = await runOnce(s, ask('w1'), { ...WORKER, HORNHOOF_ROLE: 'data', STUB_DURING_SLEEP: `printf '%s' '${word}' > ${s.computerControl}/go.json` });
    expect(r.status).toMatchObject({ id: 'w1', state: 'done', step: 'finished' });
    expect(r.status.log).toContain('Waiting for its turn to install.');
    /* No copy of its database is saved and no migration is counted: its schema is the company server's. */
    expect(r.calls.filter(c => c.includes('pg_dump') || c.includes('__drizzle_migrations') || c.includes('compose stop app'))).toEqual([]);
    expect(r.calls.some(c => c.startsWith('installer worker'))).toBe(true);
    expect(r.calls.some(c => c.startsWith('installer server'))).toBe(false);
    const kept = existsSync(join(s.server, 'backups')) ? readdirSync(join(s.server, 'backups')) : [];
    expect(kept.filter(name => name.endsWith('.sql.gz'))).toEqual([]);
  });

  it("loads a copy's schema", async () => {
    const copy = `${WORKER_ENV.replace('HORNHOOF_ROLE=worker', 'HORNHOOF_ROLE=data')}COMPOSE_PROFILES=data,builtin\n`;
    const password = 'the-replica-password';
    const request = (s: Stand, over: object = {}) => {
      writeFileSync(join(s.control, 'replica.json'), '{}');
      writeFileSync(join(s.control, 'schema.json'), JSON.stringify({ attempt: 1, database: 'hornhoof', port: 7432, password, ...over }), { mode: 0o600 });
    };
    const env = { ...WORKER, HORNHOOF_ROLE: 'data' };
    const s = stand(copy);
    request(s);
    const r = await runOnce(s, null, env);
    /* The leader's schema and its count of migrations, read through the keeper's door as the role that only reads. */
    const dumps = r.calls.filter(c => c.includes(' pg_dump '));
    expect(dumps).toEqual([
      'docker exec -e PGPASSWORD dbcid pg_dump -h keeper -p 7432 -U hornhoof_replica --schema-only --no-owner --no-publications --no-subscriptions --no-privileges hornhoof',
      'docker exec -e PGPASSWORD dbcid pg_dump -h keeper -p 7432 -U hornhoof_replica --data-only --table=drizzle.__drizzle_migrations hornhoof',
    ]);
    expect(r.calls.filter(c => c === 'pg_dump had its password')).toHaveLength(2);
    const load = r.calls.findIndex(c => c === 'docker exec -i dbcid psql -U hornhoof -1 -v ON_ERROR_STOP=1 -d hornhoof');
    expect(load).toBeGreaterThan(r.calls.indexOf(dumps[1]!));
    /* The schema comes with no rights, since the leader's roles are not this machine's. A function is open to everyone
       until it is closed, and the keeper leads on no database whose network functions are: they are closed here as
       the leader's own migration closes them, so a copy that takes the server over may lead. */
    expect(readFileSync(join(s.dir, 'loaded'), 'utf8')).toBe('-- the schema of hornhoof\n-- the rows of drizzle.__drizzle_migrations\nREVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC;\n');
    /* The password the copy's subscription reads goes into the database's own folder, on standard input. */
    expect(readFileSync(join(s.dir, 'passfile'), 'utf8')).toBe(`*:*:*:hornhoof_replica:${password}\n`);
    expect(has(s, 'schema/1.done')).toBe(true);
    expect(statSync(join(s.control, 'schema')).mode & 0o777).toBe(0o700);
    expect(has(s, 'schema.json')).toBe(false);
    expect(readdirSync(join(s.control, 'schema'))).toEqual(['1.done']);
    expect([r.out, ...r.calls].join('\n').includes(password)).toBe(false);
    /* The same request again changes nothing: its answer is there. */
    request(s);
    const again = await runOnce(s, null, env);
    expect(again.calls.filter(c => c.includes(' pg_dump '))).toHaveLength(2);
    expect(has(s, 'schema.json')).toBe(false);

    /* A copy that joins a slot holds every table already: it asks for the password file alone, whatever was answered
       under that attempt before. */
    const joining = stand(copy);
    request(joining, { only: 'passfile' });
    mkdirSync(join(joining.control, 'schema'));
    writeFileSync(join(joining.control, 'schema', '1.failed'), 'An earlier try.\n');
    const alone = await runOnce(joining, null, { ...env, STUB_PUBLIC_TABLES: '3' });
    expect(alone.calls.some(c => c.includes('pg_dump') || c.includes('ON_ERROR_STOP'))).toBe(false);
    expect(readFileSync(join(joining.dir, 'passfile'), 'utf8')).toBe(`*:*:*:hornhoof_replica:${password}\n`);
    expect([has(joining, 'schema/1.done'), has(joining, 'schema.json')]).toEqual([true, false]);
    expect([alone.out, ...alone.calls].join('\n').includes(password)).toBe(false);
    /* Another word in its place asks for nothing. */
    const odd = stand(copy);
    request(odd, { only: 'everything' });
    const none = await runOnce(odd, null, env);
    expect(none.calls.some(c => c.includes('pg_dump') || c.includes('replica.pgpass'))).toBe(false);
    expect(has(odd, 'schema.json')).toBe(false);

    /* A database that holds tables already is left as it is. */
    const full = stand(copy);
    request(full);
    const refused = await runOnce(full, null, { ...env, STUB_PUBLIC_TABLES: '3' });
    expect(readFileSync(join(full.control, 'schema', '1.failed'), 'utf8').trim()).toBe('The database is not empty.');
    expect(refused.calls.some(c => c.includes('pg_dump') || c.includes('ON_ERROR_STOP'))).toBe(false);
    expect(has(full, 'schema.json')).toBe(false);

    /* A schema that cannot be read or loaded leaves a line, and nothing of the dump. The line of a load says what
       psql said, without the place in the dump, which no log would show otherwise. */
    for (const [fails, line] of [
      [{ STUB_SCHEMA: 'fail' }, "The company server's schema could not be read."],
      [{ STUB_RESTORE: 'fail' }, 'The schema could not be loaded into the database: psql: error: out of disk space'],
      [{ STUB_RESTORE: 'role', STUB_MISSING_ROLE: 'acme_reader' }, 'The schema could not be loaded into the database: ERROR:  role "acme_reader" does not exist'],
    ] as const) {
      const broken = stand(copy);
      request(broken, { attempt: 2 });
      await runOnce(broken, null, { ...env, ...fails });
      expect(readFileSync(join(broken.control, 'schema', '2.failed'), 'utf8').trim()).toBe(line);
      expect(readdirSync(join(broken.control, 'schema'))).toEqual(['2.failed']);
    }

    /* A request that names what no database or port is called is dropped, and nothing is asked. */
    for (const bad of [{ database: 'hornhoof; DROP' }, { port: '7432 -h evil' }, { attempt: '1/../x' }]) {
      const odd = stand(copy);
      request(odd, bad);
      const dropped = await runOnce(odd, null, env);
      expect(dropped.calls.some(c => c.includes('pg_dump') || c.includes('ON_ERROR_STOP')), JSON.stringify(bad)).toBe(false);
      expect(has(odd, 'schema.json'), JSON.stringify(bad)).toBe(false);
    }
  });

  /* The leader's app gives its own roles row policies as it runs, and its schema keeps them: a copy whose cluster has
     none of those roles yet could never load it whole. Each role a policy names is made first, with no login and no
     right, in the same transaction as the schema, so the copy keeps every policy the leader has. */
  it("makes the roles the leader's policies name, then loads the schema whole", async () => {
    const copy = `${WORKER_ENV.replace('HORNHOOF_ROLE=worker', 'HORNHOOF_ROLE=data')}COMPOSE_PROFILES=data,builtin\n`;
    const password = 'the-replica-password';
    const request = (s: Stand) => {
      writeFileSync(join(s.control, 'replica.json'), '{}');
      writeFileSync(join(s.control, 'schema.json'), JSON.stringify({ attempt: 3, database: 'hornhoof_next', port: 7432, password }), { mode: 0o600 });
    };
    const env = { ...WORKER, HORNHOOF_ROLE: 'data' };
    const s = stand(copy);
    request(s);
    const r = await runOnce(s, null, { ...env, STUB_POLICY_ROLES: 'acme_reader|acme_auditor' });
    /* Asked of the leader through the keeper's door, as the role that only reads, before the schema is read. */
    const roles = r.calls.findIndex(c => c === "docker exec -e PGPASSWORD dbcid psql -h keeper -p 7432 -U hornhoof_replica -d hornhoof -At -c SELECT DISTINCT r FROM pg_policies, unnest(roles) AS r WHERE r <> 'public' ORDER BY 1");
    expect(roles).toBeGreaterThan(-1);
    expect(roles).toBeLessThan(r.calls.findIndex(c => c.includes(' pg_dump ')));
    expect(r.calls.filter(c => c === 'psql had its password')).toHaveLength(1);
    expect(readFileSync(join(s.dir, 'loaded'), 'utf8')).toBe(
      [
        'DO $roles$ BEGIN',
        `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_reader') THEN CREATE ROLE "acme_reader" NOLOGIN; END IF;`,
        `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_auditor') THEN CREATE ROLE "acme_auditor" NOLOGIN; END IF;`,
        'END $roles$;',
        '-- the schema of hornhoof',
        '-- the rows of drizzle.__drizzle_migrations',
        'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC;',
        '',
      ].join('\n'),
    );
    expect(r.calls).toContain('docker exec -i dbcid psql -U hornhoof -1 -v ON_ERROR_STOP=1 -d hornhoof_next');
    expect(readdirSync(join(s.control, 'schema'))).toEqual(['3.done']);
    expect([r.out, ...r.calls].join('\n').includes(password)).toBe(false);

    /* A name that is not a plain role's stands in no statement: nothing is loaded, and the line says why. */
    for (const odd of ['acme" SUPERUSER; --', 'Acme', 'a reader', `x${'y'.repeat(63)}`]) {
      const bad = stand(copy);
      request(bad);
      const refused = await runOnce(bad, null, { ...env, STUB_POLICY_ROLES: `acme_reader|${odd}` });
      expect(readFileSync(join(bad.control, 'schema', '3.failed'), 'utf8').trim(), odd).toBe("The company server's schema names a role that is not a plain name.");
      expect(refused.calls.some(c => c.includes(' pg_dump ') || c.includes('ON_ERROR_STOP')), odd).toBe(false);
      expect(existsSync(join(bad.dir, 'loaded')), odd).toBe(false);
    }
    /* The leader that cannot be asked leaves the line of a schema that could not be read. */
    const deaf = stand(copy);
    request(deaf);
    await runOnce(deaf, null, { ...env, STUB_SCHEMA: 'fail' });
    expect(readFileSync(join(deaf.control, 'schema', '3.failed'), 'utf8').trim()).toBe("The company server's schema could not be read.");
  });
});
