import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { companies, departments, machines, people } from '../src/db/schema.js';
import * as apply from '../src/modules/merge/apply.js';
import { CHOICE_FILE, type KeptDatabases } from '../src/modules/merge/kept.js';
import { forkWanted, MERGE_EVERY_MS, Merger, RETRY_MAX_MS } from '../src/modules/merge/merger.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { appOn, ownDatabases, setUpCompany } from './helpers.js';
import { openTestDb } from './helpers-db.js';
import { forkOf, pgliteSource, type Side } from './merge-fixture.js';

/* Each test forks its database, which a shared one would not survive. */
ownDatabases();

type MergeRow = { id: string; source: string; label: string; status: string; path: string | null; fork: string | null; tries: number; tried_at: string | null; error: string | null; machine: string | null; counts: { added?: number } };

const rowsOf = async <T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(query)) as unknown as { rows: T[] }).rows;

/* An app that leads on a company, a control folder, and kept databases that are forks of the app's own. */
async function stand(env: NodeJS.ProcessEnv = {}) {
  const opened = await openTestDb();
  onTestFinished(() => opened.client.close());
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const { app, db } = await appOn(opened.client, { HORNHOOF_CONTROL_DIR: control, ...env });
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const databases = new Map<string, Side>();
  const dropped: string[] = [];
  let failing = 0;
  let now = Date.now();
  const kept: KeptDatabases = {
    list: async () => [...databases.keys()],
    open: async (name, label) => {
      if (failing > 0) {
        failing -= 1;
        throw new Error('could not connect');
      }
      return pgliteSource(databases.get(name)!.client, label);
    },
    drop: async name => {
      dropped.push(name);
      databases.delete(name);
    },
  };
  const merger = new Merger(app.ctx, kept, { now: () => new Date(now) });
  /* A database a restore set aside, as it is now; what the test then writes into it is what came after. */
  const keep = async (name: string): Promise<Side> => {
    const side = await forkOf(opened.client);
    databases.set(name, side);
    return side;
  };
  const merges = () => rowsOf<MergeRow>(db, sql`SELECT * FROM net.merges ORDER BY created_at, source`);
  const restored = async (name: string, at = '2026-11-10T08:00:00.000Z') => {
    const attempt = randomUUID();
    await db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, kept) VALUES (${attempt}, ${randomUUID()}, ${at}, ${name})`);
    return attempt;
  };
  const backup = (id: string) =>
    db.execute(sql`INSERT INTO net.backups (id, company_id, dumped_at, made_at, reason, size, sha256, signer, serial, recipients, migrations, head)
      VALUES (${id}, ${acme!.id}, now(), now(), 'fork', 10, ${'a'.repeat(64)}, ${randomUUID()}, 'ab', '{}', 107, '{}')`);
  return { app, db, acme: acme!, control, databases, dropped, merger, keep, merges, restored, backup, later: (ms: number) => void (now += ms), fail: (times: number) => void (failing = times), opened };
}

describe('the databases a restore set aside', () => {
  it('brings back the database from before a restore', async () => {
    const s = await stand();
    await s.restored('hornhoof_before_t1');
    const kept = await s.keep('hornhoof_before_t1');
    const [later] = await kept.db.insert(departments).values({ companyId: s.acme.id, name: 'Later', roleCode: 'LATER' }).returning();
    await s.merger.discover();
    const [found] = await s.merges();
    expect(found).toMatchObject({ source: 'kept:hornhoof_before_t1', status: 'pending', label: 'the database from before the restore of 10 Nov 08:00 UTC', tries: 0 });
    expect(found!.fork).toMatch(/^[0-9a-f-]{36}$/);
    expect(await s.merger.pending()).toBe(true);
    const heard: string[] = [];
    s.app.ctx.bus.subscribe(s.acme.id, message => heard.push(message.type));
    await s.merger.tick();
    const [merged] = await s.merges();
    expect(merged).toMatchObject({ status: 'merged', path: 'compare', error: null, tries: 1 });
    expect(merged!.counts.added).toBe(1);
    expect(await s.db.select().from(departments).where(eq(departments.id, later!.id))).toHaveLength(1);
    /* The screens are told once to read again. */
    expect(heard).toEqual(['org']);
    expect(await s.merger.pending()).toBe(false);
    /* Discovered once. */
    await s.merger.discover();
    expect(await s.merges()).toHaveLength(1);
  });

  it('brings back the record of a planned switch', async () => {
    const s = await stand();
    await s.restored('hornhoof_before_t1');
    const kept = await s.keep('hornhoof_before_t1');
    /* The database that was set aside saw the server move between two machines after the backup was made. */
    const [owner] = await kept.db.select().from(people).where(eq(people.isOwner, true));
    const [from, to] = await kept.db.insert(machines).values([{ companyId: s.acme.id, personId: owner!.id, machineKey: 'from' }, { companyId: s.acme.id, personId: owner!.id, machineKey: 'to' }]).returning();
    const handover = (id: string, toMachine: string) =>
      kept.db.execute(sql`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, slots)
        VALUES (${id}, ${from!.id}, 4, ${'0f'.repeat(16)}, '0/3000000', ${toMachine}, now(), '{"0f0f": "copy_0f0f0f0f0f0f0f0f_2"}'::jsonb)`);
    const [moved, lost] = [randomUUID(), randomUUID()];
    await handover(moved, to!.id);
    /* One that names a machine no database has any more is left where it is, and the rest comes all the same. */
    await kept.client.exec('SET session_replication_role = replica');
    await handover(lost, randomUUID());
    await kept.client.exec('SET session_replication_role = origin');
    await s.merger.discover();
    await s.merger.tick();
    expect((await s.merges())[0]).toMatchObject({ status: 'merged', error: null });
    const held = () => rowsOf<{ id: string; applied: string; slots: object }>(s.db, sql`SELECT id, applied, slots FROM net.handovers`);
    expect(await held()).toEqual([{ id: moved, applied: '0/3000000', slots: { '0f0f': 'copy_0f0f0f0f0f0f0f0f_2' } }]);
  });

  it('leaves it out when the CEO chose so', async () => {
    const s = await stand();
    const attempt = await s.restored('hornhoof_before_t1');
    await s.keep('hornhoof_before_t1');
    writeFileSync(join(s.control, CHOICE_FILE), JSON.stringify({ attempt, bringBack: false }));
    const run = vi.spyOn(apply, 'runMerge');
    await s.merger.discover();
    expect(await s.merges()).toMatchObject([{ status: 'removing' }]);
    expect(existsSync(join(s.control, CHOICE_FILE))).toBe(false);
    await s.merger.tick();
    expect(run).not.toHaveBeenCalled();
    /* Kept until its backup is made. */
    expect([s.dropped, (await s.merges())[0]!.status]).toEqual([[], 'removing']);
    run.mockRestore();
  });

  it('keeps the choice until it is written', async () => {
    const s = await stand();
    const attempt = await s.restored('hornhoof_before_t1');
    await s.keep('hornhoof_before_t1');
    const file = join(s.control, CHOICE_FILE);
    writeFileSync(file, JSON.stringify({ attempt, bringBack: false }));
    s.fail(1);
    await s.merger.discover();
    expect([existsSync(file), await s.merges()]).toEqual([true, []]);
    await s.merger.discover();
    expect([existsSync(file), (await s.merges()).map(row => row.status)]).toEqual([false, ['removing']]);
    /* A file of another attempt stays for the next restore to write over. */
    await s.restored('hornhoof_before_t2');
    await s.keep('hornhoof_before_t2');
    writeFileSync(file, JSON.stringify({ attempt: randomUUID(), bringBack: false }));
    await s.merger.discover();
    expect([existsSync(file), (await s.merges()).map(row => row.status)]).toEqual([true, ['removing', 'pending']]);
  });

  it('waits for a restore that still runs', async () => {
    const s = await stand();
    await s.keep('hornhoof_before_t1');
    const attempt = randomUUID();
    const backup = randomUUID();
    const status = (state: string, kept: string | null) => writeFileSync(join(s.control, 'restore-status.json'), JSON.stringify({ attempt, id: backup, state, step: 'start', line: '', at: new Date().toISOString(), kept, dumpedAt: '2026-11-10T08:00:00.000Z' }));
    /* The updater has not said yet which database it kept: nothing is told of one before it has. */
    status('running', null);
    await s.merger.discover();
    expect(await s.merges()).toEqual([]);
    status('done', 'hornhoof_before_t1');
    await s.merger.discover();
    expect(await s.merges()).toMatchObject([{ source: 'kept:hornhoof_before_t1', label: 'the database from before the restore of 10 Nov 08:00 UTC', status: 'pending' }]);
    expect(await rowsOf(s.db, sql`SELECT attempt, backup, kept FROM net.restores`)).toEqual([{ attempt, backup, kept: 'hornhoof_before_t1' }]);
  });

  it('names a database kept before this release', async () => {
    const s = await stand();
    await s.keep('hornhoof_before_t9');
    await s.merger.discover();
    expect(await s.merges()).toMatchObject([{ label: 'the database kept as hornhoof_before_t9', status: 'pending' }]);
  });

  it('removes an empty database without a backup', async () => {
    const s = await stand();
    const empty = await s.keep('hornhoof_before_t1');
    await empty.client.exec('SET session_replication_role = replica; DELETE FROM companies; SET session_replication_role = DEFAULT');
    await s.merger.discover();
    expect(await s.merges()).toMatchObject([{ status: 'removing', fork: null }]);
    await s.merger.tick();
    expect([s.dropped, (await s.merges())[0]!.status]).toEqual([['hornhoof_before_t1'], 'done']);
  });

  it('drops only what is merged and saved', async () => {
    const s = await stand();
    await s.keep('hornhoof_before_t1');
    await s.merger.discover();
    await s.merger.tick();
    const [merged] = await s.merges();
    expect([merged!.status, s.dropped]).toEqual(['merged', []]);
    await s.merger.tick();
    expect(s.dropped).toEqual([]);
    /* Once its bundle is recorded it goes, once. */
    await s.backup(merged!.fork!);
    await s.merger.tick();
    await s.merger.tick();
    expect([s.dropped, (await s.merges())[0]!.status]).toEqual([['hornhoof_before_t1'], 'done']);
    /* One that waits or was only applied never goes, and nothing that is no kept database is ever touched. */
    await s.keep('hornhoof_before_t2');
    await s.merger.discover();
    const waiting = (await s.merges()).find(row => row.source === 'kept:hornhoof_before_t2')!;
    await s.backup(waiting.fork!);
    for (const status of ['pending', 'applied']) {
      await s.db.execute(sql`UPDATE net.merges SET status = ${status}, tried_at = now(), tries = 20 WHERE id = ${waiting.id}`);
      await s.merger.tick();
      expect(s.dropped).toEqual(['hornhoof_before_t1']);
    }
    s.databases.set('hornhoof', s.opened as unknown as Side);
    await s.merger.discover();
    await s.merger.tick();
    expect([(await s.merges()).map(row => row.source), s.dropped]).toEqual([['kept:hornhoof_before_t1', 'kept:hornhoof_before_t2'], ['hornhoof_before_t1']]);
  });

  it('merges an upload and asks for its fork bundle', async () => {
    const s = await stand();
    const [owner] = await s.db.select().from(people).where(eq(people.isOwner, true));
    const [machine] = await s.db
      .insert(machines)
      .values({ companyId: s.acme.id, personId: owner!.id, machineKey: 'left-machine', hostname: 'dev-mac', role: 'worker', networkId: `99bb2233aabbccdd${'2'.repeat(48)}`, uploadState: 'waiting', dataLeftAt: new Date() })
      .returning();
    const stateOf = async () => (await s.db.select().from(machines).where(eq(machines.id, machine!.id)))[0]!.uploadState;
    const name = 'hornhoof_upload_99bb2233aabbccdd_20261111t120005';
    /* What the machine held: a copy that never led, with a department the leader lost since. */
    const upload = await s.keep(name);
    await upload.client.exec('DELETE FROM net_local.lease; DELETE FROM net_local.state');
    /* One the updater is still loading is no source yet. */
    await s.keep('hornhoof_uploading_99bb2233aabbccdd_20261111t120009');
    await s.merger.discover();
    await s.merger.discover();
    const [found, ...others] = await s.merges();
    expect(others).toEqual([]);
    expect(found).toMatchObject({ source: `upload:${name}`, status: 'pending', machine: machine!.id, label: "dev-mac's copy, uploaded 11 Nov 12:00 UTC" });
    expect(found!.fork).toMatch(/^[0-9a-f-]{36}$/);
    expect(await stateOf()).toBe('received');
    /* Its bundle is asked of the keeper as that of a database a restore kept. */
    expect(await forkWanted(s.db)).toEqual({ id: found!.fork, database: name });
    /* The bundle recorded while the merge is only applied: nothing is told the machine yet. */
    await s.backup(found!.fork!);
    await s.db.execute(sql`UPDATE net.merges SET status = 'applied', tried_at = now(), tries = 20 WHERE id = ${found!.id}`);
    await s.merger.tick();
    expect([await stateOf(), s.dropped]).toEqual(['received', []]);
    /* Merged and saved: the machine may wipe, the database goes and the merge is done. */
    await s.db.execute(sql`UPDATE net.merges SET status = 'pending', tried_at = NULL, tries = 0 WHERE id = ${found!.id}`);
    await s.merger.tick();
    expect((await s.merges())[0]).toMatchObject({ status: 'merged', error: null });
    await s.merger.tick();
    expect([await stateOf(), s.dropped, (await s.merges())[0]!.status]).toEqual(['kept', [name], 'done']);
  });

  it('waits for the bundle of an upload, and asks a machine again whose upload is gone', async () => {
    const s = await stand();
    const [owner] = await s.db.select().from(people).where(eq(people.isOwner, true));
    const [machine] = await s.db
      .insert(machines)
      .values({ companyId: s.acme.id, personId: owner!.id, machineKey: 'left-machine', hostname: 'dev-mac', role: 'worker', networkId: `99bb2233aabbccdd${'2'.repeat(48)}`, uploadState: 'waiting', dataLeftAt: new Date() })
      .returning();
    const stateOf = async () => (await s.db.select().from(machines).where(eq(machines.id, machine!.id)))[0]!.uploadState;
    const name = 'hornhoof_upload_99bb2233aabbccdd_20261111t120005';
    const upload = await s.keep(name);
    await upload.client.exec('DELETE FROM net_local.lease; DELETE FROM net_local.state');
    await s.merger.tick();
    await s.merger.tick();
    /* Merged, and not saved as a bundle yet: the machine keeps what it holds. */
    expect([(await s.merges())[0]!.status, await stateOf(), s.dropped]).toEqual(['merged', 'received', []]);
    /* A database that went before it was read: the machine is asked for it again. */
    const again = 'hornhoof_upload_99bb2233aabbccdd_20261111t130000';
    await s.keep(again);
    await s.merger.discover();
    s.databases.delete(again);
    await s.merger.discover();
    const lost = (await s.merges()).find(row => row.source === `upload:${again}`)!;
    expect(lost).toMatchObject({ status: 'done', error: 'The database is not on this server any more, so nothing of it was brought back.' });
    expect(await stateOf()).toBe('waiting');
  });

  it('goes on with the check after a stop', async () => {
    const s = await stand();
    const kept = await s.keep('hornhoof_before_t1');
    await kept.db.insert(departments).values({ companyId: s.acme.id, name: 'Later', roleCode: 'LATER' });
    await s.merger.discover();
    const [row] = await s.merges();
    /* The app stopped between the merge and its check. */
    const source = await pgliteSource(kept.client, row!.label);
    await apply.runMerge(s.db, { id: row!.id, label: row!.label, kept: true, companyId: s.acme.id }, source, { log: () => undefined });
    await source.close();
    expect((await s.merges())[0]!.status).toBe('applied');
    const run = vi.spyOn(apply, 'runMerge');
    await s.merger.tick();
    expect(run).not.toHaveBeenCalled();
    expect((await s.merges())[0]).toMatchObject({ status: 'merged', error: null });
    run.mockRestore();
  });

  it('tries a failed merge again, less often', async () => {
    const s = await stand();
    const kept = await s.keep('hornhoof_before_t1');
    await s.merger.discover();
    await kept.client.exec(`SET session_replication_role = replica; UPDATE companies SET id = '${randomUUID()}'; SET session_replication_role = DEFAULT`);
    await s.merger.tick();
    expect((await s.merges())[0]).toMatchObject({ status: 'pending', error: 'This database is of another company.', tries: 1 });
    /* Not again within a minute; then again, and each time after twice as long, an hour at most. */
    s.later(MERGE_EVERY_MS - 1000);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(1);
    s.later(2000);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(2);
    s.later(MERGE_EVERY_MS + 1000);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(2);
    s.later(MERGE_EVERY_MS);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(3);
    await s.db.execute(sql`UPDATE net.merges SET tries = 30`);
    s.later(RETRY_MAX_MS - 1000);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(30);
    s.later(2000);
    await s.merger.tick();
    expect((await s.merges())[0]!.tries).toBe(31);
  });

  it('lets go of a merge whose database is not there any more', async () => {
    const s = await stand();
    /* As a backup restored later brings back the record of a merge that was still waiting when it was made. */
    await s.db.execute(sql`INSERT INTO net.merges (source, label, fork) VALUES ('kept:hornhoof_before_t7', 'a database long gone', gen_random_uuid())`);
    expect(await s.merger.pending()).toBe(true);
    await s.merger.tick();
    expect(await s.merges()).toMatchObject([{ status: 'done', error: 'The database is not on this server any more, so nothing of it was brought back.' }]);
    expect([await s.merger.pending(), s.dropped]).toEqual([false, []]);
  });

  it('holds no update for a merge that can never run', async () => {
    const s = await stand();
    const kept = await s.keep('hornhoof_before_t1');
    await s.merger.discover();
    expect(await s.merger.pending()).toBe(true);
    /* A database of another shape never merges: it waits for the CEO to leave it out, and holds nothing else up. */
    await kept.client.exec('ALTER TABLE teams ADD COLUMN nickname text');
    await s.merger.tick();
    expect((await s.merges())[0]).toMatchObject({ status: 'pending', error: 'The two databases are of different versions.' });
    expect(await s.merger.pending()).toBe(false);
  });

  it('says what is not complete yet, and stays applied', async () => {
    const s = await stand();
    const kept = await s.keep('hornhoof_before_t1');
    const [later] = await kept.db.insert(departments).values({ companyId: s.acme.id, name: 'Later', roleCode: 'LATER' }).returning();
    await s.merger.discover();
    const run = vi.spyOn(apply, 'runMerge').mockImplementation(async (db, merge) => {
      /* A merge that applied and left a row behind. */
      await (db as Db).execute(sql`UPDATE net.merges SET status = 'applied', path = 'compare', applied_at = now() WHERE id = ${merge.id}`);
      return { path: 'compare', counts: {} as apply.Counts, tasks: [], code: [], from: null, to: null, heldMs: 0 };
    });
    await s.merger.tick();
    run.mockRestore();
    const [row] = await s.merges();
    expect(row).toMatchObject({ status: 'applied', tries: 1 });
    expect(row!.error).toBe(`Not complete yet: departments ${JSON.stringify({ id: later!.id })}`);
    expect(s.dropped).toEqual([]);
  });

  it('merges one at a time, only while leading', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
    const keeperSays = (mode: 'lead' | 'read') => writeKeeperState(control, { mode, at: new Date().toISOString(), link: null });
    keeperSays('lead');
    const s = await stand({ HORNHOOF_CONTROL_DIR: control, HORNHOOF_KEEPER: 'on' });
    /* A live keeper says its word every second, and the app obeys only a recent one: the test says it again before each
       step, however long what came before took, and the app reads it at once. */
    const modeAfter = async (mode: 'lead' | 'read') => {
      keeperSays(mode);
      await s.app.ctx.mode.check();
      expect(s.app.ctx.mode.current()).toBe(mode);
    };
    for (const name of ['hornhoof_before_t1', 'hornhoof_before_t2']) await s.keep(name);
    await modeAfter('lead');
    await s.merger.discover();
    await s.merger.tick();
    expect((await s.merges()).map(row => row.status).sort()).toEqual(['merged', 'pending']);
    /* Two ticks at once are one. */
    await modeAfter('lead');
    await Promise.all([s.merger.tick(), s.merger.tick()]);
    expect((await s.merges()).map(row => row.status)).toEqual(['merged', 'merged']);
    await s.keep('hornhoof_before_t3');
    await modeAfter('read');
    await s.merger.tick();
    expect(await s.merges()).toHaveLength(2);
  });

  it('writes the choice for the swap to find', async () => {
    const s = await stand();
    const file = join(s.control, CHOICE_FILE);
    expect(existsSync(file)).toBe(false);
    const { writeChoice } = await import('../src/modules/merge/kept.js');
    writeChoice(s.control, { attempt: 'a1', bringBack: false });
    expect([JSON.parse(readFileSync(file, 'utf8')), statSync(file).mode & 0o777]).toEqual([{ attempt: 'a1', bringBack: false }, 0o600]);
  });
});
