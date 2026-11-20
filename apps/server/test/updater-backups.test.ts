import { spawnSync } from 'node:child_process';
import { chownSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { ask, at, JQ, runOnce, runUpdaterStep, stand, stubbed, type Stand } from './updater-fixture.js';

const ID = '0f0f0f0f-0000-4000-8000-00000000000a';
const dumps = (s: Stand) => join(s.control, 'dumps');
const mode = (path: string) => statSync(path).mode & 0o777;
/* The owner and group of the control folder, as the updater reads them: the keeper runs as that user. */
const owner = (s: Stand) => `${statSync(s.control).uid}:${statSync(s.control).gid}`;
const wants = (s: Stand, id: string) => writeFileSync(join(s.control, 'dump.json'), JSON.stringify({ id }));
const said = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { id: string; reason: string; at: string; migrations: number };

describe('updater, backups', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  it('dumps for the keeper, whole or not at all', async () => {
    const s = stand();
    wants(s, ID);
    const r = await runOnce(s, null);
    expect(r.code).toBe(0);
    /* The dump first, and only then the file that says it is whole. */
    expect(gunzipSync(readFileSync(join(dumps(s), `${ID}.sql.gz`))).toString()).toContain('-- a dump of the hornhoof database');
    expect(said(join(dumps(s), `${ID}.json`))).toMatchObject({ id: ID, reason: 'timer', migrations: 20 });
    expect(said(join(dumps(s), `${ID}.json`)).at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    /* For the keeper alone: it runs as the control folder's owner, and reads and deletes what root wrote. */
    expect([mode(dumps(s)), mode(join(dumps(s), `${ID}.sql.gz`)), mode(join(dumps(s), `${ID}.json`))]).toEqual([0o700, 0o600, 0o600]);
    /* The folder once it is entered, and each file in the private folder it is written in, before it is renamed into place. */
    for (const path of ['./keeper', `./${ID}.sql.gz`, `./${ID}.json`]) expect(r.calls).toContain(`chown ${owner(s)} ${path}`);
    expect(existsSync(join(s.control, 'dump.json'))).toBe(false);
    expect(readdirSync(dumps(s)).sort()).toEqual([`${ID}.json`, `${ID}.sql.gz`]);

    /* Asked again for a dump it made, it makes none. */
    wants(s, ID);
    const again = await runOnce(s, null);
    expect(again.calls.filter(call => call.includes('pg_dump'))).toHaveLength(1);
    expect(existsSync(join(s.control, 'dump.json'))).toBe(false);
  });

  it('dumps a database made of an upload for its fork bundle', async () => {
    const s = stand();
    const upload = 'hornhoof_upload_99bb2233aabbccdd_20261111t120005';
    writeFileSync(join(s.dir, `db-${upload}`), '20');
    writeFileSync(join(s.control, 'dump.json'), JSON.stringify({ id: ID, database: upload, reason: 'fork' }));
    const r = await runOnce(s, null);
    expect(r.calls.some(call => call.includes(`pg_dump -U hornhoof -d ${upload}`))).toBe(true);
    expect(said(join(dumps(s), `${ID}.json`))).toMatchObject({ id: ID, reason: 'fork', migrations: 20 });
    expect(gunzipSync(readFileSync(join(dumps(s), `${ID}.sql.gz`))).toString()).toContain(`-- a dump of the ${upload} database`);
  });

  it('dumps a kept database for its fork bundle', async () => {
    const s = stand();
    const kept = 'hornhoof_before_20261103_210000';
    /* A database a restore set aside, with its connections off, as of 19 migrations. */
    writeFileSync(join(s.dir, `db-${kept}`), '19');
    writeFileSync(join(s.dir, `closed-${kept}`), '');
    const asks = (said: object) => writeFileSync(join(s.control, 'dump.json'), JSON.stringify(said));
    asks({ id: ID, database: kept, reason: 'fork' });
    const r = await runOnce(s, null);
    expect(r.code).toBe(0);
    const [opened, dumped] = [r.calls.findIndex(call => call.includes(`ALTER DATABASE "${kept}" WITH ALLOW_CONNECTIONS true`)), r.calls.findIndex(call => call.includes(`pg_dump -U hornhoof -d ${kept}`))];
    expect([opened >= 0, dumped > opened]).toEqual([true, true]);
    expect(existsSync(join(s.dir, `closed-${kept}`))).toBe(false);
    expect(said(join(dumps(s), `${ID}.json`))).toMatchObject({ id: ID, reason: 'fork', migrations: 19 });
    expect(gunzipSync(readFileSync(join(dumps(s), `${ID}.sql.gz`))).toString()).toContain(`-- a dump of the ${kept} database`);
    expect([mode(join(dumps(s), `${ID}.sql.gz`)), mode(join(dumps(s), `${ID}.json`))]).toEqual([0o600, 0o600]);
    expect(existsSync(join(s.control, 'dump.json'))).toBe(false);

    /* No other database is ever dumped this way, and a name is never part of a command it could change. */
    const refused: object[] = [
      { database: 'hornhoof', reason: 'fork' }, { database: 'x;rm -rf /', reason: 'fork' }, { database: 'hornhoof_before_', reason: 'fork' }, { database: `hornhoof_before_${'a'.repeat(48)}`, reason: 'fork' },
      { reason: 'fork' }, { database: kept, reason: 'timer' }, { database: kept },
      { database: 'hornhoof_uploading_99bb2233aabbccdd_20261111t120005', reason: 'fork' }, { database: 'hornhoof_upload_99bb2233aabbccdd_x', reason: 'fork' },
    ];
    for (const [index, wrong] of refused.entries()) {
      const id = `0f0f0f0f-0000-4000-8000-0000000000${String(index + 10)}`;
      asks({ id, ...wrong });
      const again = await runOnce(s, null);
      /* The calls so far hold the one dump above, and no other is ever made. */
      expect([JSON.stringify(wrong), again.calls.filter(call => call.includes('pg_dump')).length]).toEqual([JSON.stringify(wrong), 1]);
      expect(readFileSync(join(dumps(s), `${id}.failed`), 'utf8').trim()).toBe('Not a kept database.');
      expect(existsSync(join(s.control, 'dump.json'))).toBe(false);
    }
  });

  it('dumps hornhoof on a copy only', async () => {
    /* A machine that led and follows another now: its keeper asks for its own database, to save what it did while it
       led before its copy is made again. */
    const copy = stand();
    writeFileSync(join(copy.control, 'replica.json'), JSON.stringify({ since: '2026-11-11T12:00:00.000Z' }));
    const asks = (s: typeof copy, said: object) => writeFileSync(join(s.control, 'dump.json'), JSON.stringify(said));
    asks(copy, { id: ID, database: 'hornhoof', reason: 'fork' });
    const r = await runOnce(copy, null, { HORNHOOF_ROLE: 'data' });
    expect(r.code).toBe(0);
    expect(r.calls.filter(call => call.includes('pg_dump -U hornhoof -d hornhoof'))).toHaveLength(1);
    expect(said(join(dumps(copy), `${ID}.json`))).toMatchObject({ id: ID, reason: 'fork', migrations: 20 });
    expect([mode(join(dumps(copy), `${ID}.sql.gz`)), existsSync(join(copy.control, 'dump.json'))]).toEqual([0o600, false]);
    /* A copy makes no other dump: neither one for a timer nor one of another database. */
    for (const [index, wrong] of [{}, { database: 'hornhoof', reason: 'timer' }, { database: 'hornhoof_before_20261103_210000', reason: 'fork' }, { database: 'postgres', reason: 'fork' }].entries()) {
      const id = `0f0f0f0f-0000-4000-8000-0000000000${String(index + 40)}`;
      asks(copy, { id, ...wrong });
      const again = await runOnce(copy, null, { HORNHOOF_ROLE: 'data' });
      expect([JSON.stringify(wrong), again.calls.filter(call => call.includes('pg_dump')).length]).toEqual([JSON.stringify(wrong), 1]);
      expect(readFileSync(join(dumps(copy), `${id}.failed`), 'utf8').trim()).toBe('Not a kept database.');
      expect(existsSync(join(copy.control, 'dump.json'))).toBe(false);
    }
    /* A machine that keeps no data has no database: its request stays, and nothing is dumped. */
    const worker = stand();
    asks(worker, { id: ID, database: 'hornhoof', reason: 'fork' });
    const none = await runOnce(worker, null, { HORNHOOF_ROLE: 'worker', STUB_SERVICES: 'front keeper updater', STUB_RUNNING_IMAGES: '' });
    expect([none.calls.some(call => call.includes('pg_dump')), existsSync(join(worker.control, 'dump.json'))]).toEqual([false, true]);
  });

  it('says so when the database cannot be dumped, and leaves nothing half made', async () => {
    const s = stand();
    wants(s, ID);
    const r = await runOnce(s, null, { STUB_DUMP: 'fail' });
    expect(r.code).toBe(0);
    expect(readdirSync(dumps(s))).toEqual([`${ID}.failed`]);
    expect(readFileSync(join(dumps(s), `${ID}.failed`), 'utf8').trim()).toBe('The database could not be dumped.');
    expect(mode(join(dumps(s), `${ID}.failed`))).toBe(0o600);
    expect(existsSync(join(s.control, 'dump.json'))).toBe(false);
    /* It is not tried again by itself: the keeper asks anew. */
    wants(s, ID);
    const again = await runOnce(s, null);
    expect(again.calls.filter(call => call.includes('pg_dump'))).toHaveLength(1);
    expect(existsSync(join(s.control, 'dump.json'))).toBe(false);
  });

  it('asks for no dump twice when it cannot even say that one failed', async () => {
    const s = stand();
    wants(s, ID);
    /* The dump fails, and so does the file that would say so: the folder is full, or not this user's. */
    mkdirSync(join(dumps(s), `${ID}.failed.new`), { recursive: true });
    const r = await runOnce(s, null, { STUB_DUMP: 'fail' });
    expect(r.code).toBe(0);
    expect(r.calls.filter(call => call.includes('pg_dump'))).toHaveLength(1);
    /* The request goes all the same, so the next pass does not dump again: the keeper asks anew in its own time. */
    expect(existsSync(join(s.control, 'dump.json'))).toBe(false);
    const again = await runOnce(s, null, { STUB_DUMP: 'fail' });
    expect(again.calls.filter(call => call.includes('pg_dump'))).toHaveLength(1);
  });

  it('deletes a dump nobody sealed within a day, also with no keeper to do it', async () => {
    const s = stand();
    mkdirSync(dumps(s));
    const old = new Date(Date.now() - 25 * 3_600_000);
    for (const name of ['old.sql.gz', 'old.json', 'old.sql.gz.part', 'fresh.sql.gz', 'fresh.json']) {
      writeFileSync(join(dumps(s), name), 'x');
      if (name.startsWith('old')) utimesSync(join(dumps(s), name), old, old);
    }
    const r = await runOnce(s, null);
    expect(r.code).toBe(0);
    expect(readdirSync(dumps(s)).sort()).toEqual(['fresh.json', 'fresh.sql.gz']);
    expect(r.out).toContain('Deleted a database dump that was not sealed within a day.');
    /* A machine with no such folder is left alone. */
    expect((await runOnce(stand(), null)).out).not.toContain('Deleted a database dump');
  });

  it('sweeps a stale direct file of another owner and leaves a direct link target intact', async () => {
    const s = stand();
    mkdirSync(dumps(s));
    const old = new Date(Date.now() - 25 * 3_600_000);
    const stale = join(dumps(s), 'old.sql.gz');
    const outside = join(s.dir, 'kept.sql.gz');
    for (const file of [stale, outside]) {
      writeFileSync(file, 'rows');
      utimesSync(file, old, old);
    }
    symlinkSync(outside, join(dumps(s), 'link.sql.gz'));
    /* A privileged fixture gives the stale file a real different UID. Otherwise model the keeper's UID. */
    const nativeOwner = process.getuid?.() === 0;
    if (nativeOwner) chownSync(stale, 1234, statSync(stale).gid);
    const keeper = nativeOwner ? statSync(dumps(s)).uid : 0;
    expect(statSync(stale).uid).not.toBe(keeper);
    const step = nativeOwner ? 'sweep_dumps' : "facts() { printf '%s\\n' '1 1 700 0'; }; sweep_dumps";
    const r = await runUpdaterStep(s, step);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('rows');
  });

  it('rejects a dumps directory owned by a different user', async () => {
    const s = stand();
    mkdirSync(dumps(s));
    const file = join(dumps(s), 'old.sql.gz');
    const old = new Date(Date.now() - 25 * 3_600_000);
    writeFileSync(file, 'rows');
    utimesSync(file, old, old);
    const r = await runUpdaterStep(s, `
      facts() {
        case "$(physical_dir)" in
          */dumps) printf '%s\\n' '1 1 700 1234' ;;
          *) printf '%s\\n' '2 1 700 1000' ;;
        esac
      }
      sweep_dumps
    `);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Refused dumps: it is not a keeper folder.');
    expect(readFileSync(file, 'utf8')).toBe('rows');
  });

  it('logs a dangling link in place of dumps and skips the sweep', async () => {
    const s = stand();
    symlinkSync(join(s.dir, 'missing'), dumps(s));
    const r = await runUpdaterStep(s, 'sweep_dumps');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Refused dumps: it is not a plain folder.');
  });

  it.each(['different', 'unavailable'])('keeps stale dumps when their mount identity is %s', async identity => {
    const s = stand();
    mkdirSync(dumps(s));
    const stale = join(dumps(s), 'old.sql.gz');
    writeFileSync(stale, 'rows');
    utimesSync(stale, new Date(0), new Date(0));
    const r = await runUpdaterStep(s, `
      directory_mount() {
        case "$(physical_dir)" in
          */dumps) ${identity === 'different' ? 'printf "%s\\n" 2' : 'return 1'} ;;
          *) printf '%s\\n' 1 ;;
        esac
      }
      sweep_dumps
    `);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Refused dumps: could not verify the control mount.');
    expect(readFileSync(stale, 'utf8')).toBe('rows');
  });

  it.each(['find', 'rm'])('reports a dump sweep failure from %s and continues', async command => {
    const s = stand();
    const tools = join(s.dir, 'sweep-tools');
    mkdirSync(tools);
    writeFileSync(join(tools, command), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    mkdirSync(dumps(s));
    const stale = join(dumps(s), 'old.sql.gz');
    writeFileSync(stale, 'rows');
    utimesSync(stale, new Date(0), new Date(0));
    const r = await runUpdaterStep(s, `
      export PATH="$SWEEP_TOOLS:$PATH"
      sweep_dumps
      printf 'Sweep returned.\\n'
    `, { SWEEP_TOOLS: tools });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Sweep returned.');
    expect(r.out).toContain('Could not check or remove one or more stale dump entries.');
    expect(r.out).not.toContain('Deleted a database dump');
    expect(readFileSync(stale, 'utf8')).toBe('rows');
  });

  /* The app can swap a folder in dumps for a link at any moment, also while the sweep runs, here right before rm does.
     The sweep deletes old files of dumps itself only, by their names there, so it never deletes through such a link. */
  it('deletes nothing through a folder of dumps swapped for a link', async () => {
    const s = stand();
    const outside = join(s.dir, 'outside');
    const sub = join(dumps(s), 'sub');
    const old = new Date(Date.now() - 25 * 3_600_000);
    mkdirSync(outside);
    mkdirSync(sub, { recursive: true });
    for (const file of [join(dumps(s), 'old.sql.gz'), ...[outside, sub].flatMap(dir => ['a.sql.gz', 'b.sql.gz'].map(name => join(dir, name)))]) {
      writeFileSync(file, 'x');
      utimesSync(file, old, old);
    }
    const r = await runOnce(s, null, { ...stubbed(s, 'rm', 'rm-swap'), RM_SWAP: `${sub}=${outside}` });
    expect(r.code, r.out).toBe(0);
    expect(readdirSync(outside).sort()).toEqual(['a.sql.gz', 'b.sql.gz']);
    expect(existsSync(join(dumps(s), 'old.sql.gz'))).toBe(false);
    expect(r.out).toContain('Deleted a database dump that was not sealed within a day.');
  });

  it('takes no name for a dump but a plain one, and dumps nothing on a machine with no database', async () => {
    const s = stand();
    for (const id of ['../x', 'a b', '', 'x/y']) {
      wants(s, id);
      const r = await runOnce(s, null);
      expect(r.calls.some(call => call.includes('pg_dump')), id).toBe(false);
    }
    expect(existsSync(dumps(s))).toBe(false);
    const worker = stand('HORNHOOF_ROLE=worker\nHORNHOOF_VERSION=0.4.0\n');
    wants(worker, ID);
    const r = await runOnce(worker, null, { HORNHOOF_ROLE: 'worker', STUB_SERVICES: 'front keeper updater' });
    expect(r.calls.some(call => call.includes('pg_dump'))).toBe(false);
  });

  it('hands the dump before an update to the keeper too', async () => {
    const s = stand();
    const r = await runOnce(s, ask('u1'));
    expect(r.status).toMatchObject({ id: 'u1', state: 'done' });
    const [backup] = readdirSync(join(s.server, 'backups')).filter(name => name.endsWith('.sql.gz'));
    expect(readFileSync(join(dumps(s), 'u1.sql.gz')).equals(readFileSync(join(s.server, 'backups', backup!)))).toBe(true);
    expect(said(join(dumps(s), 'u1.json'))).toMatchObject({ id: 'u1', reason: 'update', migrations: 20 });
    expect([mode(join(dumps(s), 'u1.sql.gz')), mode(join(dumps(s), 'u1.json'))]).toEqual([0o600, 0o600]);

    /* A copy that cannot be made is one line of the update's log, and the update goes on. */
    const full = stand();
    writeFileSync(dumps(full), '');
    const stuck = await runOnce(full, ask('u2'));
    expect(stuck.status).toMatchObject({ id: 'u2', state: 'done' });
    expect(stuck.status.log).toContain('Could not hand the database copy to the keeper for a backup.');
    expect(statSync(dumps(full)).isFile()).toBe(true);
  });
});

const ATTEMPT = 'a1a1a1a1-0000-4000-8000-000000000001';
/* What a restore says before each statement that follows the closing of the database in use. */
const ALONE = 'SET synchronous_commit = local';
const BUNDLE = 'b2b2b2b2-0000-4000-8000-000000000002';
const DUMPED = '2026-11-10T08:00:00.000Z';
/* The server's settings before a restore, and the three a backup brings. */
const OLD_ENV = `HORNHOOF_SECRET=${'B'.repeat(43)}=\nHORNHOOF_VERSION=0.4.0\nNODE_KEY=${'o'.repeat(40)}\n# a note\nHORNHOOF_PORT=8080\n`;
const NEW = { HORNHOOF_SECRET: `${'A'.repeat(43)}=`, NODE_KEY: 'k'.repeat(40), RELAY_URL: 'https://relay.hornhoof.test' };
const NEW_ENV = `HORNHOOF_SECRET=${NEW.HORNHOOF_SECRET}\nHORNHOOF_VERSION=0.4.0\nNODE_KEY=${NEW.NODE_KEY}\n# a note\nHORNHOOF_PORT=8080\nRELAY_URL=${NEW.RELAY_URL}\n`;
const CARRY = { people: [{ id: 'p1', status: 'disabled', passwordHash: 'h', scopeKind: 'company', isOwner: false, access: [] }], invites: [], machines: [], serials: ['aa01'], recoveryKeys: [] };
/* What the old database answers when it is asked who may get in now. */
const WITH_CARRY = { STUB_CARRY: JSON.stringify(CARRY) };
const STAMP = '20261110_090000';
/* The number the database server knows the database that was in use by, under whatever name. */
const OLD = '1001';
const BEFORE = `hornhoof_before_${STAMP}`;
const STOPPED = 'The updater stopped during the restore, so nothing changed.';

const file = (s: Stand, ...path: string[]) => join(s.control, ...path);
const rmHere = (path: string) => rmSync(path, { force: true });
const text = (path: string) => readFileSync(path, 'utf8');
const json = (path: string) => JSON.parse(text(path)) as Record<string, unknown>;
const envOf = (s: Stand) => text(join(s.server, '.env'));
const state = (s: Stand, name: string) => join(s.dir, name);
/* The database a name goes by, as the docker stub keeps them: how many migrations it has, or null when there is none. */
const database = (s: Stand, name: string) => {
  const path = state(s, name === 'hornhoof' ? 'migrations' : name === 'hornhoof_restore' ? 'restored' : `db-${name}`);
  return existsSync(path) ? text(path) : null;
};
const closed = (s: Stand, name: string) => existsSync(state(s, `closed-${name}`));
const statusOf = (s: Stand) => json(file(s, 'restore-status.json')) as { attempt: string; id: string; state: string; step: string; line: string; kept: string | null };

/* The keeper's order to restore a backup of a database with 18 migrations, with both files of it whole. */
function order(s: Stand, over: { attempt?: string; carry?: boolean; env?: Record<string, unknown> } = {}) {
  const attempt = over.attempt ?? ATTEMPT;
  mkdirSync(file(s, 'restore'), { recursive: true });
  writeFileSync(file(s, 'restore', `${attempt}.sql.gz`), gzipSync('-- a dump of the hornhoof database\n-- migrations 18\n-- copy 9\n'));
  writeFileSync(file(s, 'restore', `${attempt}.env.json`), JSON.stringify(over.env ?? NEW));
  writeFileSync(file(s, 'restore.json'), JSON.stringify({ attempt, id: BUNDLE, dumpedAt: DUMPED, carry: over.carry ?? true }));
}

/* Nothing of the restore is left, and the company is on the database and the settings it had. */
function expectAsBefore(s: Stand, calls: string[]) {
  expect([database(s, 'hornhoof'), database(s, 'hornhoof_restore'), closed(s, 'hornhoof')]).toEqual(['20', null, false]);
  expect(readdirSync(s.dir).filter(name => name.startsWith('db-') || name.startsWith('closed-'))).toEqual([]);
  expect(readdirSync(s.dir).filter(name => name.startsWith('oid-') && name !== 'oid-hornhoof')).toEqual([]);
  expect(envOf(s)).toBe(OLD_ENV);
  expect(existsSync(join(s.server, 'backups')) ? readdirSync(join(s.server, 'backups')) : []).toEqual([]);
  expect(readdirSync(file(s, 'restore'))).toEqual([]);
  for (const gone of ['restore.json', 'restore-journal.json', 'restore-carry.json']) expect(existsSync(file(s, gone)), gone).toBe(false);
  /* The company starts last, on the old database, with nothing of what was carried over for the restored one. */
  expect(calls.at(-1)).toBe('docker compose up -d --no-build app node');
}

describe('updater, restore', () => {
  it('swaps a restored database in and keeps the old one', async () => {
    const s = stand(OLD_ENV);
    order(s);
    writeFileSync(file(s, 'recovery-link.json'), '{}');
    const r = await runOnce(s, null, { STUB_TERM: '7', ...WITH_CARRY });
    expect(r.code).toBe(0);
    const status = statusOf(s);
    const kept = status.kept!;
    /* Digits and a line: the database server keeps such a name as it is, where it would fold letters. */
    expect(kept).toMatch(/^hornhoof_before_\d{8}_\d{6}$/);
    expect(status).toMatchObject({
      attempt: ATTEMPT, id: BUNDLE, state: 'done', step: 'start',
      line: `Restored the backup of ${DUMPED}. The database from before is kept on this machine as ${kept}.`,
    });
    /* The restored database has the name, and the old one is kept, closed. */
    expect([database(s, 'hornhoof'), database(s, kept), closed(s, kept), closed(s, 'hornhoof'), database(s, 'hornhoof_restore')]).toEqual(['18', '20', true, false, null]);
    /* The app and the node stopped first; the old database closed before it lost its name; the loaded one took what
       the old one went by before it took the name; and the company started last. */
    const order_ = [
      'docker compose stop app node', 'docker exec -i dbcid psql -U hornhoof -d hornhoof_restore -v ON_ERROR_STOP=1 -q', 'docker exec -i -e PGAPPNAME=hornhoof-cutover dbcid psql -U hornhoof -d hornhoof ',
      'cutover with the carry', 'docker exec -i dbcid psql -U hornhoof -d hornhoof_restore -v ON_ERROR_STOP=1 -q -v term=7 -v machine=m-old -v cluster=c-old',
      `docker exec dbcid psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q -c ${ALONE} -c ALTER DATABASE hornhoof RENAME TO ${kept}`,
      `docker exec dbcid psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q -c ${ALONE} -c ALTER DATABASE hornhoof_restore RENAME TO hornhoof`, 'docker compose up -d --no-build app node',
    ].map(start => at(r.calls, start));
    expect(order_).toEqual([...order_].sort((a, b) => a - b));
    /* Once the database in use is closed, the copy commits waited for has lost its connection with every other session:
       what the restore does from there waits for no copy, or it would stand still for good. */
    expect(r.calls.filter(call => call.includes('ALLOW_CONNECTIONS false'))).toEqual([`docker exec dbcid psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q -c ${ALONE} -c ALTER DATABASE hornhoof WITH ALLOW_CONNECTIONS false`]);
    expect(readFileSync(state(s, 'adopted'), 'utf8').split('\n')[0]).toBe(`${ALONE};`);
    expect(order_.every(index => index >= 0)).toBe(true);
    /* The backup's settings over their lines, the one that had none added, and every other line as it was. */
    expect(envOf(s)).toBe(NEW_ENV);
    expect(statSync(join(s.server, '.env')).mode & 0o777).toBe(0o600);
    const copy = join(s.server, 'backups', `env-before-${kept.slice('hornhoof_before_'.length)}`);
    expect([text(copy), statSync(copy).mode & 0o777]).toEqual([OLD_ENV, 0o600]);
    /* Who may get in now, for the keeper alone. */
    expect(json(file(s, 'restore-carry.json'))).toEqual({ attempt: ATTEMPT, carry: CARRY });
    expect(statSync(file(s, 'restore-carry.json')).mode & 0o777).toBe(0o600);
    expect(r.calls).toContain(`chown ${owner(s)} ./restore-carry.json`);
    expect(readdirSync(file(s, 'restore'))).toEqual([]);
    for (const gone of ['restore.json', 'restore-journal.json', 'recovery-link.json']) expect(existsSync(file(s, gone)), gone).toBe(false);
    /* No secret was on a command line. */
    expect(r.calls.filter(call => Object.values(NEW).slice(0, 2).some(secret => call.includes(secret)))).toEqual([]);
  });

  it('takes no carry for a total loss', async () => {
    const s = stand(OLD_ENV);
    order(s, { carry: false });
    const r = await runOnce(s, null);
    expect(statusOf(s)).toMatchObject({ state: 'done', step: 'start' });
    expect(r.calls).toContain('cutover alone');
    expect(r.calls).not.toContain('cutover with the carry');
    expect(existsSync(file(s, 'restore-carry.json'))).toBe(false);
  });

  it("keeps the dump's time in the restore's status", async () => {
    /* The order does not outlive the swap, and the restored database rarely holds its own bundle's record: the status
       says from when the restored database is, whether the restore went through or not. */
    const done = stand(OLD_ENV);
    order(done);
    await runOnce(done, null, { STUB_TERM: '7', ...WITH_CARRY });
    expect((statusOf(done) as { dumpedAt?: string }).dumpedAt).toBe(DUMPED);
    const failed = stand(OLD_ENV);
    order(failed);
    await runOnce(failed, null, { STUB_RESTORE: 'fail' });
    expect(statusOf(failed)).toMatchObject({ state: 'failed', dumpedAt: DUMPED });
  });

  it('changes nothing when the backup does not load or the database in use does not close', async () => {
    const s = stand(OLD_ENV);
    order(s);
    const r = await runOnce(s, null, { STUB_RESTORE: 'fail' });
    expect(statusOf(s)).toMatchObject({ attempt: ATTEMPT, id: BUNDLE, state: 'failed', step: 'load', line: 'The backup did not load, so nothing changed.', kept: null });
    expectAsBefore(s, r.calls);
    expect(r.calls.some(call => call.includes('PGAPPNAME=hornhoof-cutover'))).toBe(false);

    /* The session that reads never gets onto the database, or another session there does not end. */
    for (const how of ['fail', 'left']) {
      const closing = stand(OLD_ENV);
      order(closing);
      const run = await runOnce(closing, null, { STUB_CUTOVER: how });
      expect(statusOf(closing), how).toMatchObject({ state: 'failed', step: 'swap', line: 'The database in use could not be closed, so nothing changed.' });
      expectAsBefore(closing, run.calls);
      expect(run.calls.some(call => call.includes('RENAME TO')), how).toBe(false);
    }

    /* The loaded database cannot take what the old one went by, or its name. */
    const breaks: Record<string, string>[] = [{ STUB_ADOPT: 'fail' }, { STUB_RENAME: 'fail' }, { STUB_CARRY: 'not json' }];
    for (const env of breaks) {
      const swapping = stand(OLD_ENV);
      order(swapping);
      const run = await runOnce(swapping, null, { ...WITH_CARRY, ...env });
      expect(statusOf(swapping), JSON.stringify(env)).toMatchObject({ state: 'failed', step: 'swap', line: 'The databases could not change places, so nothing changed.' });
      expectAsBefore(swapping, run.calls);
    }
  });

  it('puts the old database back when the restored one does not answer', async () => {
    const s = stand(OLD_ENV);
    order(s);
    writeFileSync(state(s, 'running'), 'dead');
    const r = await runOnce(s, null, WITH_CARRY);
    expect(statusOf(s)).toMatchObject({ state: 'failed', step: 'start', line: 'The restored company did not start, so it is back as it was.', kept: null });
    expectAsBefore(s, r.calls);
    /* The restored company started with what was carried over for it; the old one, after it failed, without. */
    expect(r.calls.filter(call => call === 'up with the carry')).toHaveLength(1);
    /* The restored one went only while the old one was kept under its own name. */
    expect(at(r.calls, `docker exec dbcid psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q -c ${ALONE} -c DROP DATABASE hornhoof WITH (FORCE)`)).toBeGreaterThan(at(r.calls, 'docker compose up'));
  });

  /* The keeper's folder of a restore can be written by the app too. Both files of a backup are taken into the updater's
     own folder before anything stops: a named pipe or a link in the place of either, or a file with another name too,
     ends the restore while the company still runs, and nothing comes in from elsewhere. */
  function expectUntouched(s: Stand, calls: string[]) {
    expect([database(s, 'hornhoof'), database(s, 'hornhoof_restore'), closed(s, 'hornhoof')]).toEqual(['20', null, false]);
    expect(envOf(s)).toBe(OLD_ENV);
    expect(readdirSync(file(s, 'restore'))).toEqual([]);
    for (const gone of ['restore.json', 'restore-journal.json']) expect(existsSync(file(s, gone)), gone).toBe(false);
    expect(calls.filter(call => call.startsWith('docker compose stop') || call.startsWith('docker compose up'))).toEqual([]);
  }
  const DUMP_LINE = 'The backup cannot be read, so nothing changed.';
  const SETTINGS_LINE = "The backup's settings cannot be read, so nothing changed.";

  it('ends a restore whose dump is a named pipe at once, before anything stops', async () => {
    const s = stand(OLD_ENV);
    order(s);
    const dump = file(s, 'restore', `${ATTEMPT}.sql.gz`);
    rmSync(dump);
    expect(spawnSync('mkfifo', [dump]).status).toBe(0);
    const r = await runOnce(s, null, WITH_CARRY);
    expect(r.out).toContain(`Refused ${ATTEMPT}.sql.gz: it is not a plain file.`);
    expect(statusOf(s)).toMatchObject({ attempt: ATTEMPT, state: 'failed', step: 'load', line: DUMP_LINE });
    expectUntouched(s, r.calls);
  }, 10_000);

  it("takes no settings through a link in the place of the backup's, and stops nothing", async () => {
    const s = stand(OLD_ENV);
    order(s);
    const outside = join(s.dir, 'outside.json');
    writeFileSync(outside, JSON.stringify(NEW), { mode: 0o600 });
    const settings = file(s, 'restore', `${ATTEMPT}.env.json`);
    rmSync(settings);
    symlinkSync(outside, settings);
    const r = await runOnce(s, null, WITH_CARRY);
    expect(r.out).toContain(`Refused ${ATTEMPT}.env.json: it is not a plain file.`);
    expect(statusOf(s)).toMatchObject({ attempt: ATTEMPT, state: 'failed', step: 'load', line: SETTINGS_LINE });
    expectUntouched(s, r.calls);
    expect(readFileSync(outside, 'utf8')).toBe(JSON.stringify(NEW));
  });

  /* The updater's copy of the dump, a whole company's data, goes once the load ends, loaded or not: it is kept through
     neither the swap nor the way back. Its copy of the settings, which the swap still reads, is there to show the look saw
     the updater's own folder. */
  it.each([
    { what: 'it loaded', at: 'STUB_ON_CUTOVER', env: WITH_CARRY, state: 'done' },
    { what: 'it did not load', at: 'STUB_ON_UP', env: { STUB_RESTORE: 'fail' }, state: 'failed' },
  ])('keeps its copy of the dump no longer than the load, when $what', async ({ at, env, state }) => {
    const s = stand(OLD_ENV);
    order(s);
    const seen = join(s.dir, 'seen');
    await runOnce(s, null, { ...env, [at]: `find ${s.dir} -name restore.sql.gz -o -name env.json > ${seen}` });
    expect(statusOf(s)).toMatchObject({ attempt: ATTEMPT, state });
    expect(text(seen).trim().split('\n').map(path => path.split('/').at(-1))).toEqual(['env.json']);
  });

  it.each([
    { what: 'the dump', name: `${ATTEMPT}.sql.gz`, line: DUMP_LINE },
    { what: 'the settings', name: `${ATTEMPT}.env.json`, line: SETTINGS_LINE },
  ])('takes $what only with one name, and stops nothing otherwise', async ({ name, line }) => {
    const s = stand(OLD_ENV);
    order(s);
    linkSync(file(s, 'restore', name), join(s.dir, 'second-name'));
    const r = await runOnce(s, null, WITH_CARRY);
    expect(r.out).toContain(`Refused ${name}: it is not a plain file.`);
    expect(statusOf(s)).toMatchObject({ attempt: ATTEMPT, state: 'failed', step: 'load', line });
    expectUntouched(s, r.calls);
  });

  /* What loads and what goes into .env is what was looked at: files put at both names once the company stops change nothing. */
  it('restores the backup as it was taken, whatever stands at its names after', async () => {
    const s = stand(OLD_ENV);
    order(s);
    const other = { HORNHOOF_SECRET: `${'C'.repeat(43)}=`, NODE_KEY: 'q'.repeat(40), RELAY_URL: 'https://other.hornhoof.test' };
    writeFileSync(join(s.dir, 'other.sql.gz'), gzipSync('-- a dump of the hornhoof database\n-- migrations 5\n-- copy 9\n'));
    writeFileSync(join(s.dir, 'other.env.json'), JSON.stringify(other));
    const swap = `mv -f ${join(s.dir, 'other.sql.gz')} ${file(s, 'restore', `${ATTEMPT}.sql.gz`)} && mv -f ${join(s.dir, 'other.env.json')} ${file(s, 'restore', `${ATTEMPT}.env.json`)}`;
    const r = await runOnce(s, null, { ...WITH_CARRY, STUB_ON_STOP: swap });
    expect(r.code).toBe(0);
    expect(r.calls.some(call => call.startsWith('docker compose stop'))).toBe(true);
    /* The other files did take both names while the company stopped. */
    expect([existsSync(join(s.dir, 'other.sql.gz')), existsSync(join(s.dir, 'other.env.json'))]).toEqual([false, false]);
    expect(statusOf(s)).toMatchObject({ attempt: ATTEMPT, state: 'done' });
    expect(database(s, 'hornhoof')).toBe('18');
    expect(envOf(s)).toBe(NEW_ENV);
  });

  it('refuses settings it cannot write', async () => {
    const bad: Record<string, unknown>[] = [
      { ...NEW, NODE_KEY: `${'k'.repeat(20)}\nEVIL=${'k'.repeat(20)}` },
      { ...NEW, NODE_KEY: `${'k'.repeat(40)}\n` },
      { ...NEW, RELAY_URL: 'https://a.hornhoof.test\r' },
      { ...NEW, RELAY_URL: 'https://a.hornhoof.test\nEVIL=1' },
      { ...NEW, RELAY_URL: 'https://a.hornhoof.test/$NODE_KEY' },
      { ...NEW, HORNHOOF_SECRET: `${'A'.repeat(42)} =` },
      { ...NEW, HORNHOOF_SECRET: { a: 1 } },
      { ...NEW, NODE_KEY: `${'k'.repeat(40)}#` },
    ];
    for (const env of bad) {
      const s = stand(OLD_ENV);
      order(s, { env });
      const r = await runOnce(s, null);
      expect(statusOf(s), JSON.stringify(env)).toMatchObject({ state: 'failed', step: 'swap', line: "The backup's settings cannot be written, so nothing changed." });
      expectAsBefore(s, r.calls);
      expect(r.calls.some(call => call.includes('PGAPPNAME=hornhoof-cutover')), JSON.stringify(env)).toBe(false);
    }
    /* A setting the backup has none of leaves its line as it is. */
    const s = stand(OLD_ENV);
    order(s, { env: { HORNHOOF_SECRET: NEW.HORNHOOF_SECRET, NODE_KEY: '' } });
    await runOnce(s, null, WITH_CARRY);
    expect(statusOf(s)).toMatchObject({ line: expect.stringMatching(/^Restored the backup/), state: 'done' });
    expect(envOf(s)).toBe(OLD_ENV.replace(`${'B'.repeat(43)}=`, NEW.HORNHOOF_SECRET));
  });

  /* A restore as an updater that was stopped left it: the journal, the status, and the databases and settings as the
     change it had made last left them. */
  function stoppedAt(did: string | null, step = 'swap') {
    const s = stand(OLD_ENV);
    order(s);
    writeFileSync(file(s, 'restore-status.json'), JSON.stringify({ attempt: ATTEMPT, id: BUNDLE, state: 'running', step, line: '', at: DUMPED, kept: null }));
    writeFileSync(state(s, 'restored'), '18');
    writeFileSync(state(s, 'oid-hornhoof'), OLD);
    if (did === null) return s;
    writeFileSync(file(s, 'restore-journal.json'), JSON.stringify({ attempt: ATTEMPT, id: BUNDLE, dumpedAt: DUMPED, stamp: STAMP, old: OLD, did }));
    mkdirSync(join(s.server, 'backups'));
    writeFileSync(join(s.server, 'backups', `env-before-${STAMP}`), OLD_ENV, { mode: 0o600 });
    const reached = ['saved', 'closed', 'old_renamed', 'new_renamed', 'committed'].indexOf(did);
    if (reached >= 1) {
      writeFileSync(state(s, 'closed-hornhoof'), '');
      writeFileSync(file(s, 'restore-carry.json'), JSON.stringify({ attempt: ATTEMPT, carry: CARRY }));
    }
    if (reached >= 2) {
      writeFileSync(state(s, `db-${BEFORE}`), '20');
      writeFileSync(state(s, `closed-${BEFORE}`), '');
      writeFileSync(state(s, `oid-${BEFORE}`), OLD);
      for (const gone of ['migrations', 'closed-hornhoof', 'oid-hornhoof']) rmHere(state(s, gone));
    }
    if (reached >= 3) {
      writeFileSync(state(s, 'migrations'), '18');
      writeFileSync(state(s, 'oid-hornhoof'), '2001');
      rmHere(state(s, 'restored'));
      /* The settings may have been written already. */
      writeFileSync(join(s.server, '.env'), NEW_ENV);
    }
    if (reached >= 4) rmHere(file(s, 'restore', `${ATTEMPT}.env.json`));
    return s;
  }

  it('goes back from every change it was stopped at', async () => {
    for (const [did, step] of [[null, 'load'], [null, 'swap'], ['saved', 'swap'], ['closed', 'swap'], ['old_renamed', 'swap'], ['new_renamed', 'swap']] as const) {
      const s = stoppedAt(did, step);
      const r = await runOnce(s, null);
      expect(statusOf(s), `${did} ${step}`).toMatchObject({ attempt: ATTEMPT, id: BUNDLE, state: 'failed', step, line: STOPPED, kept: null });
      expectAsBefore(s, r.calls);
      /* Nothing is restored a second time by the order that was left. */
      expect(r.calls.some(call => call.includes('CREATE DATABASE')), `${did} ${step}`).toBe(false);
    }
  });

  it('keeps a committed restore that answers', async () => {
    const s = stoppedAt('committed', 'start');
    const r = await runOnce(s, null);
    expect(statusOf(s)).toMatchObject({
      attempt: ATTEMPT, id: BUNDLE, state: 'done', step: 'start', kept: BEFORE,
      line: `Restored the backup of ${DUMPED}. The database from before is kept on this machine as ${BEFORE}.`,
    });
    expect([database(s, 'hornhoof'), database(s, BEFORE), closed(s, BEFORE), envOf(s)]).toEqual(['18', '20', true, NEW_ENV]);
    expect(existsSync(file(s, 'restore-carry.json'))).toBe(true);
    for (const gone of ['restore.json', 'restore-journal.json']) expect(existsSync(file(s, gone)), gone).toBe(false);
    expect(r.calls.some(call => call.includes('DROP DATABASE'))).toBe(false);

    const silent = stoppedAt('committed', 'start');
    writeFileSync(state(silent, 'running'), 'dead');
    const back = await runOnce(silent, null);
    expect(statusOf(silent)).toMatchObject({ state: 'failed', step: 'start', line: 'The restored company did not start, so it is back as it was.' });
    expectAsBefore(silent, back.calls);
  });

  it('tries the way back again when it fails, and touches nothing by a journal it cannot read', async () => {
    const s = stoppedAt('new_renamed');
    const stuck = await runOnce(s, null, { STUB_BACK: 'fail' });
    expect(stuck.out).toContain('Could not put the database back as it was yet. The updater tries again.');
    expect(statusOf(s)).toMatchObject({ state: 'running', step: 'swap' });
    expect(existsSync(file(s, 'restore-journal.json'))).toBe(true);
    const r = await runOnce(s, null);
    expect(statusOf(s)).toMatchObject({ state: 'failed', line: STOPPED });
    expectAsBefore(s, r.calls);

    const odd: Record<string, string>[] = [
      { stamp: '' }, { stamp: '2026' }, { stamp: `${STAMP}; DROP DATABASE hornhoof` }, { stamp: '../../../../etc/passwd' }, { stamp: '20261110T090000Z' },
      { old: '' }, { old: '1001 OR true' },
    ];
    for (const over of odd) {
      const unread = stoppedAt('new_renamed');
      writeFileSync(file(unread, 'restore-journal.json'), JSON.stringify({ attempt: ATTEMPT, id: BUNDLE, dumpedAt: DUMPED, stamp: STAMP, old: OLD, did: 'new_renamed', ...over }));
      const run = await runOnce(unread, null);
      expect(run.out, JSON.stringify(over)).toContain('restore-journal.json cannot be read');
      expect(run.calls.filter(call => call.includes('psql')), JSON.stringify(over)).toEqual([]);
      expect(statusOf(unread), JSON.stringify(over)).toMatchObject({ state: 'running' });
    }
  });

  it('tells the database that was in use by its number, never by a name', async () => {
    /* A server that keeps the old database under a name spelled another way than it was asked. When the restored
       company does not answer, the way back finds the old one by its number, sees a name this never gave, and drops
       nothing: it never says the company is back while the restored database has its place. */
    const s = stand(OLD_ENV);
    order(s);
    writeFileSync(state(s, 'running'), 'dead');
    const r = await runOnce(s, null, { ...WITH_CARRY, STUB_FOLDS: '1' });
    expect(r.out).toContain('Could not put the database back as it was yet. The updater tries again.');
    expect(statusOf(s)).toMatchObject({ state: 'running', step: 'start' });
    expect(r.calls.filter(call => call.includes('DROP DATABASE hornhoof WITH'))).toEqual([]);
    const folded = readdirSync(s.dir).filter(name => name.startsWith('db-'));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatch(/^db-HORNHOOF_BEFORE_/);
    expect([text(state(s, folded[0]!)), text(state(s, folded[0]!.replace('db-', 'oid-'))), existsSync(file(s, 'restore-journal.json'))]).toEqual(['20', OLD, true]);

    /* The old database under a name this never gave, or nowhere at all: nothing is dropped, and it is tried again. */
    for (const where of ['elsewhere', null]) {
      const lost = stoppedAt('new_renamed');
      rmHere(state(lost, `db-${BEFORE}`));
      rmHere(state(lost, `oid-${BEFORE}`));
      if (where) for (const [name, content] of [[`db-${where}`, '20'], [`oid-${where}`, OLD]] as const) writeFileSync(state(lost, name), content);
      const run = await runOnce(lost, null);
      expect(run.out, String(where)).toContain('Could not put the database back as it was yet. The updater tries again.');
      expect(run.calls.filter(call => call.includes('DROP DATABASE') || call.includes('RENAME TO')), String(where)).toEqual([]);
      expect([database(lost, 'hornhoof'), existsSync(file(lost, 'restore-journal.json')), statusOf(lost).state], String(where)).toEqual(['18', true, 'running']);
    }
  });

  it('runs each restore once', async () => {
    const s = stand(OLD_ENV);
    order(s);
    await runOnce(s, null, WITH_CARRY);
    const first = statusOf(s).kept!;
    /* The same order again, as a keeper that did not see the end would write it. */
    order(s);
    const again = await runOnce(s, null, WITH_CARRY);
    expect(again.calls.filter(call => call.includes('CREATE DATABASE'))).toHaveLength(1);
    expect(existsSync(file(s, 'restore.json'))).toBe(false);
    /* A new attempt for the same backup runs, and keeps the database it replaces under another name. */
    const next = 'c3c3c3c3-0000-4000-8000-000000000003';
    order(s, { attempt: next });
    const third = await runOnce(s, null, WITH_CARRY);
    expect(third.calls.filter(call => call.includes('CREATE DATABASE'))).toHaveLength(2);
    expect(statusOf(s)).toMatchObject({ attempt: next, line: expect.stringMatching(/^Restored the backup/), state: 'done' });
    expect(statusOf(s).kept).not.toBe(first);
    expect([database(s, first), database(s, statusOf(s).kept!)]).toEqual(['20', '18']);

    /* An order with half its files, an odd attempt, or on a machine with no database waits or is left. */
    const half = stand(OLD_ENV);
    order(half);
    rmHere(file(half, 'restore', `${ATTEMPT}.env.json`));
    const waited = await runOnce(half, null);
    expect(waited.calls.some(call => call.includes('psql'))).toBe(false);
    expect(existsSync(file(half, 'restore-status.json'))).toBe(false);
    const odd = stand(OLD_ENV);
    order(odd, { attempt: 'x' });
    writeFileSync(file(odd, 'restore.json'), JSON.stringify({ attempt: '../x', id: BUNDLE, dumpedAt: DUMPED, carry: true }));
    expect((await runOnce(odd, null)).calls.some(call => call.includes('psql'))).toBe(false);
    const worker = stand('HORNHOOF_ROLE=worker\nHORNHOOF_VERSION=0.4.0\n');
    order(worker);
    expect((await runOnce(worker, null, { HORNHOOF_ROLE: 'worker', STUB_SERVICES: 'front keeper updater' })).calls.some(call => call.includes('psql'))).toBe(false);
  });
});
