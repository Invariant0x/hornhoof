import net, { type AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { PUBLIC_REVOKES, readerRole } from '../src/db/agent-sql.js';
import { isLeaseRefused } from '../src/db/net.js';
import { companies } from '../src/db/schema.js';
import { keeperSql, leaseOfMachine, leaseStore, UNNAMED_MACHINE } from '../src/modules/keeper/lease-store.js';
import { createTestSql, ownDatabases, until } from './helpers.js';

/* These tests take and end leases, switch triggers off and change roles, which a truncate does not undo. */
ownDatabases();

const FAR = new Date('2999-01-01T00:00:00Z');
const PAST = new Date('2000-01-01T00:00:00Z');

async function store(machineId = 'machine-a') {
  const { db, sql: run } = await createTestSql();
  /* The app revokes these as it starts; the keeper only looks. */
  await run.query(PUBLIC_REVOKES);
  const leaseRow = async () => (await run.query<{ term_number: string; term_machine: string; kind: string; sync: string | null; ended: boolean }>(
    `SELECT term_number::text, term_machine, kind, sync, until = '-infinity' AS ended FROM net_local.lease`)).rows[0]!;
  const writes = () => db.insert(companies).values({ name: 'Acme' }).then(() => 'committed', err => (isLeaseRefused(err) ? 'refused' : Promise.reject(err)));
  return { db, run, lease: leaseStore(run, { machineId }), leaseRow, writes };
}

describe('the lease the keeper holds in the database', () => {
  it('takes a term above every term the database has seen, in the name of this machine', async () => {
    const s = await store();
    const term = await s.lease.take('normal', FAR);
    expect(term).toEqual({ number: 2, machine: 'machine-a', split: false });
    expect(await s.leaseRow()).toEqual({ term_number: '2', term_machine: 'machine-a', kind: 'normal', sync: 'alone', ended: false });
    expect((await s.run.query(`SELECT term_number::text, term_machine, machine FROM net_local.state`)).rows).toEqual([{ term_number: '2', term_machine: 'machine-a', machine: 'machine-a' }]);
    expect(await s.writes()).toBe('committed');
    expect(await s.lease.take('normal', FAR)).toEqual({ number: 3, machine: 'machine-a', split: false });
  });

  it('takes its first term in a database that never had a lease', async () => {
    const s = await store();
    await s.run.query('DELETE FROM net_local.lease; DELETE FROM net_local.state');
    expect(await s.lease.take('normal', FAR)).toEqual({ number: 1, machine: 'machine-a', split: false });
    expect(await s.writes()).toBe('committed');
  });

  it('renews only its own term while that term has not ended', async () => {
    const s = await store();
    const term = await s.lease.take('normal', FAR);
    expect(await s.lease.renew({ ...term, number: term.number + 1 }, 'normal', FAR, false)).toBe(false);
    expect(await s.lease.renew(term, 'maintenance', FAR, false)).toBe(true);
    expect((await s.leaseRow()).kind).toBe('maintenance');
    /* Under a maintenance lease the app's writes are refused: only the migration writes then. */
    expect(await s.writes()).toBe('refused');
    await s.run.query(`UPDATE net_local.lease SET until = $1`, [PAST]);
    expect(await s.lease.renew(term, 'normal', FAR, false)).toBe(false);
  });

  it('fences: the lease ends at once and no write commits until a new term is taken', async () => {
    const s = await store();
    await s.lease.take('normal', FAR);
    await s.lease.fence();
    expect((await s.leaseRow()).ended).toBe(true);
    expect(await s.writes()).toBe('refused');
    await s.lease.take('normal', FAR);
    expect(await s.writes()).toBe('committed');
  });

  it('finds no problem in a database as the migrations and the app leave it', async () => {
    const s = await store();
    expect(await s.lease.problems()).toEqual([]);
  });

  it('names the backups among what is fenced', async () => {
    const s = await store();
    await s.run.query('DROP TRIGGER net_fence ON net.backups');
    expect(await s.lease.problems()).toEqual(['net.backups has no fence trigger']);
  });

  it('names the merge records among what is fenced', async () => {
    const s = await store();
    await s.run.query('DROP TRIGGER net_fence ON net.merge_rows');
    expect(await s.lease.problems()).toEqual(['net.merge_rows has no fence trigger']);
  });

  it('names the pulse among what is fenced', async () => {
    const s = await store();
    expect(await s.lease.problems()).toEqual([]);
    await s.run.query('DROP TRIGGER net_fence ON net.pulse');
    expect(await s.lease.problems()).toEqual(['net.pulse has no fence trigger']);
  });

  it('names the ranking among what is fenced', async () => {
    const s = await store();
    expect(await s.lease.problems()).toEqual([]);
    await s.run.query('DROP TRIGGER net_fence ON net.ranking');
    expect(await s.lease.problems()).toEqual(['net.ranking has no fence trigger']);
  });

  it('names each fence that does not hold', async () => {
    const s = await store();
    const role = readerRole('postgres');
    await s.run.query(`ALTER TABLE companies DISABLE TRIGGER net_journal; ALTER TABLE net.journal DISABLE TRIGGER net_fence;
      GRANT EXECUTE ON FUNCTION net.attach_journal() TO PUBLIC; GRANT SELECT ON net_local.lease TO "${role}"; GRANT pg_signal_backend TO "${role}"; GRANT SELECT ON applied, tool_calls TO "${role}"`);
    expect(await s.lease.problems()).toEqual([
      'public.companies has no journal trigger',
      'net.journal has no fence trigger',
      'PUBLIC may still run net.attach_journal()',
      `${role} may signal other sessions`,
      `${role} may reach net_local.lease`,
      `${role} may reach public.applied`,
      `${role} may reach public.tool_calls`,
      /* What PUBLIC may run, every role may. */
      `${role} may run net.attach_journal()`,
    ]);
  });

  it('prunes journal rows older than a week, a batch at a time, and only while its lease stands under a flag', async () => {
    const s = await store();
    await s.lease.take('normal', FAR);
    /* A company is made and renamed twice: three rows of the journal, then a fourth that is new. */
    await s.db.insert(companies).values({ name: 'One' });
    await s.db.update(companies).set({ name: 'Two' });
    await s.db.update(companies).set({ name: 'Three' });
    await s.db.execute(sql`UPDATE net.journal SET at = now() - interval '8 days' WHERE tbl = 'companies'`);
    await s.db.update(companies).set({ name: 'New' });
    expect(await s.lease.prune(2)).toBe(2);
    expect(await s.lease.prune()).toBe(1);
    expect(await s.lease.prune()).toBe(0);
    await s.db.execute(sql`UPDATE net.journal SET at = now() - interval '8 days'`);
    /* With no flag nothing may be confirmed here, and a lease that ended is nobody's to prune under. */
    await s.run.query(`UPDATE net_local.lease SET sync = NULL`);
    expect(await s.lease.prune()).toBe(0);
    await s.run.query(`UPDATE net_local.lease SET sync = 'alone', until = '-infinity'`);
    expect(await s.lease.prune()).toBe(0);
  });

  it('prunes nothing while a merge waits', async () => {
    const s = await store();
    await s.lease.take('normal', FAR);
    await s.db.insert(companies).values({ name: 'One' });
    await s.db.execute(sql`UPDATE net.journal SET at = now() - interval '8 days'`);
    /* A merge that has not run, or whose check has not passed, still reads the journal from where the two parted. */
    await s.db.execute(sql`INSERT INTO net.merges (source, label) VALUES ('kept:hornhoof_before_t1', 'a database')`);
    expect(await s.lease.prune()).toBe(0);
    await s.db.execute(sql`UPDATE net.merges SET status = 'applied'`);
    expect(await s.lease.prune()).toBe(0);
    await s.db.execute(sql`UPDATE net.merges SET status = 'merged'`);
    expect(await s.lease.prune()).toBe(1);
  });

  it('prunes nothing on a lapsed lease', async () => {
    const s = await store();
    await s.lease.take('normal', FAR);
    await s.db.insert(companies).values({ name: 'One' });
    await s.db.execute(sql`UPDATE net.journal SET at = now() - interval '8 days'`);
    await s.run.query(`UPDATE net_local.lease SET until = now() - interval '1 minute'`);
    expect(await s.lease.prune()).toBe(0);
    await s.run.query(`UPDATE net_local.lease SET until = 'infinity'`);
    expect(await s.lease.prune()).toBe(1);
  });

  it('records the horizon', async () => {
    /* The migrated database comes from a cached dump that may be hours old when a test opens its copy. */
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3 * 3_600_000 });
    onTestFinished(() => { vi.useRealTimers(); });
    const s = await store();
    await s.lease.take('normal', FAR);
    const horizon = async (at: 'now()' | "(pg_stat_file('PG_VERSION')).modification" = 'now()') =>
      (await s.run.query<{ ago: number }>(`SELECT extract(epoch FROM ${at} - below)::float8 AS ago FROM net.horizon`)).rows[0]!.ago;
    /* A database is given one as it is migrated: whatever was pruned before is older than that. */
    expect(Math.abs((await horizon("(pg_stat_file('PG_VERSION')).modification")) - 7 * 86_400)).toBeLessThan(3600);
    await s.run.query(`UPDATE net.horizon SET below = '2000-01-01'`);
    await s.db.execute(sql`INSERT INTO net.merges (id, source, label, status) VALUES ('00000000-0000-4000-8000-00000000000a', 'kept:hornhoof_before_t1', 'a database', 'done')`);
    await s.db.execute(sql`INSERT INTO net.merge_consumed (journal, merge, at, how) VALUES
      (gen_random_uuid(), '00000000-0000-4000-8000-00000000000a', now() - interval '8 days', 'applied'), (gen_random_uuid(), '00000000-0000-4000-8000-00000000000a', now(), 'applied')`);
    /* A prune that deletes nothing moves nothing. */
    expect(await s.lease.prune()).toBe(0);
    expect(await horizon()).toBeGreaterThan(365 * 86_400);
    await s.db.insert(companies).values({ name: 'One' });
    await s.db.execute(sql`UPDATE net.journal SET at = now() - interval '8 days'`);
    expect(await s.lease.prune()).toBe(1);
    expect(Math.abs((await horizon()) - 7 * 86_400)).toBeLessThan(2);
    expect((await s.run.query<{ n: number }>(`SELECT count(*)::int AS n FROM net.merge_consumed`)).rows).toEqual([{ n: 1 }]);
  });

  it('prunes nothing in a database of the build before, which has no record of merges', async () => {
    const s = await store();
    await s.lease.take('normal', FAR);
    await s.db.insert(companies).values({ name: 'One' });
    await s.db.execute(sql`UPDATE net.journal SET at = now() - interval '8 days'`);
    await s.run.query('DROP TABLE net.merge_rows, net.merge_conflicts, net.merge_consumed, net.merges, net.restores, net.horizon');
    expect(await s.lease.prune()).toBe(0);
  });

  it('prunes old sources and the old calls of jobs that ended, while this machine keeps the data alone', async () => {
    const s = await store();
    await s.lease.take('normal', FAR);
    const RUNNING = '00000000-0000-4000-8000-000000000001';
    const ENDED = '00000000-0000-4000-8000-000000000002';
    /* Rows as a week of work leaves them, written past the checks that a company, a plan and an agent stand behind a job. */
    await s.run.query(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO jobs (id, company_id, subscription_id, prompt, timeout_ms, status) VALUES
        ('${RUNNING}', gen_random_uuid(), gen_random_uuid(), 'x', 1000, 'running'), ('${ENDED}', gen_random_uuid(), gen_random_uuid(), 'x', 1000, 'done');
      INSERT INTO applied (source, base, at) VALUES ('web:old:0', 'web:old', now() - interval '8 days'), ('web:old:1', 'web:old', now() - interval '8 days'), ('web:new:0', 'web:new', now());
      INSERT INTO tool_calls (id, job_id, at) VALUES
        (gen_random_uuid(), '${ENDED}', now() - interval '8 days'), (gen_random_uuid(), '${RUNNING}', now() - interval '8 days'), (gen_random_uuid(), '${ENDED}', now());
      COMMIT`);
    const left = async () => (await s.run.query<{ sources: number; calls: number }>(`SELECT (SELECT count(*)::int FROM applied) AS sources, (SELECT count(*)::int FROM tool_calls) AS calls`)).rows[0];

    /* With no flag on the lease nothing may be confirmed, and nothing is pruned either. */
    await s.run.query(`UPDATE net_local.lease SET sync = NULL`);
    expect(await s.lease.prune()).toBe(0);
    expect(await left()).toEqual({ sources: 3, calls: 3 });

    await s.run.query(`UPDATE net_local.lease SET sync = 'alone'`);
    expect(await s.lease.prune(1)).toBe(2);
    expect(await left()).toEqual({ sources: 2, calls: 2 });
    expect(await s.lease.prune()).toBe(1);
    expect(await left()).toEqual({ sources: 1, calls: 2 });
    expect((await s.run.query(`SELECT 1 FROM tool_calls WHERE job_id = '${RUNNING}'`)).rows).toHaveLength(1);
  });

  it('takes and renews a lease with the flag it is given', async () => {
    const s = await store();
    const term = await s.lease.take('normal', FAR, 'relay_off');
    expect((await s.leaseRow()).sync).toBe('relay_off');
    expect(await s.lease.renew(term, 'normal', FAR, false, 'copy')).toBe(true);
    expect((await s.leaseRow()).sync).toBe('copy');
    /* A renewal that names none keeps the lease's, as a keeper of the build before renews. */
    expect(await s.lease.renew(term, 'normal', FAR, false)).toBe(true);
    expect((await s.leaseRow()).sync).toBe('copy');
    expect((await s.lease.take('normal', FAR)).number).toBe(term.number + 1);
    expect((await s.leaseRow()).sync).toBe('alone');
  });

  it('takes the term it is given', async () => {
    const s = await store();
    /* A keeper that comes back in leads under the term its copy promised it: exactly that one, in the state and the lease. */
    const given = { number: 9, machine: 'machine-a', split: false };
    expect(await s.lease.take('normal', FAR, 'relay_off', given)).toEqual(given);
    expect(await s.leaseRow()).toEqual({ term_number: '9', term_machine: 'machine-a', kind: 'normal', sync: 'relay_off', ended: false });
    expect((await s.run.query(`SELECT term_number::text, term_machine FROM net_local.state`)).rows).toEqual([{ term_number: '9', term_machine: 'machine-a' }]);
    expect(await s.writes()).toBe('committed');
    /* A term that is not above the one the database stands under, or of another machine, throws and changes nothing:
       the lease that stood stands on. */
    for (const term of [{ ...given, number: 9 }, { ...given, number: 3 }, { ...given, number: 12, machine: 'machine-b' }, { ...given, number: 12, split: true }]) {
      await expect(s.lease.take('normal', FAR, 'relay_off', term), JSON.stringify(term)).rejects.toThrow(/term/);
      expect(await s.leaseRow()).toMatchObject({ term_number: '9', ended: false });
    }
    /* With none given, the next one above it. */
    expect(await s.lease.take('normal', FAR)).toEqual({ number: 10, machine: 'machine-a', split: false });
  });

  it('prunes only what every copy holds', async () => {
    const s = await store('a1b2c3d4'.repeat(4));
    await s.lease.take('normal', FAR, 'copy');
    await s.db.insert(companies).values({ name: 'One' });
    await s.db.execute(sql`UPDATE net.journal SET at = now() - interval '8 days'`);
    /* A machine that keeps a copy, written past the checks that a company and a person stand behind it. */
    const copy = (key: string, more: string) =>
      s.run.query(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO machines (company_id, person_id, machine_key, role, network_id, copy_state, copy_name, copy_at)
          VALUES (gen_random_uuid(), gen_random_uuid(), '${key}', 'data', '${key}', ${more}); COMMIT`);
    await copy('c1', `'ready', 'copy_c1_1', now() - interval '9 days'`);
    const journal = async () => (await s.run.query<{ n: number }>('SELECT count(*)::int AS n FROM net.journal')).rows[0]!.n;
    const before = await journal();
    /* The copy holds the leader only as far as nine days ago: what is newer stays for it. */
    expect(await s.lease.prune()).toBe(0);
    expect(await journal()).toBe(before);
    /* It holds the leader as of now: the old rows go. */
    await s.run.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE machines SET copy_at = now() WHERE machine_key = 'c1'; COMMIT`);
    expect(await s.lease.prune()).toBeGreaterThan(0);
    expect(await journal()).toBeLessThan(before);
    /* A copy that is still being made, or stopped, holds nothing back: it has no pulse of its own to go by. */
    await s.db.update(companies).set({ name: 'Two' });
    await s.db.execute(sql`UPDATE net.journal SET at = now() - interval '8 days'`);
    await copy('c2', `'making', 'copy_c2_1', NULL`);
    await copy('c3', `'stopped', 'copy_c3_1', now() - interval '30 days'`);
    expect(await s.lease.prune()).toBeGreaterThan(0);
  });

  it('knows when another machine holds the data', async () => {
    const s = await store('a1b2c3d4'.repeat(4));
    /* Machines as the network knows them, written past the checks that a company and a person stand behind each. */
    const machine = (key: string, role: string, networkId: string | null, revoked = false) =>
      s.run.query(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO machines (company_id, person_id, machine_key, role, network_id, revoked_at)
          VALUES (gen_random_uuid(), gen_random_uuid(), '${key}', '${role}', ${networkId ? `'${networkId}'` : 'NULL'}, ${revoked ? 'now()' : 'NULL'}); COMMIT`);
    expect(await s.lease.othersHoldData()).toBe(false);
    await machine('server:mine', 'data', 'a1b2c3d4'.repeat(4));
    await machine('worker', 'worker', 'f'.repeat(32));
    await machine('gone', 'data', 'e'.repeat(32), true);
    expect(await s.lease.othersHoldData()).toBe(false);
    await machine('other', 'data', 'd'.repeat(32));
    expect(await s.lease.othersHoldData()).toBe(true);
    await s.run.query(`UPDATE machines SET revoked_at = now() WHERE machine_key = 'other'`);
    expect(await s.lease.othersHoldData()).toBe(false);
  });

  it('leads alone on the schema of the build before the network, and cannot tell when the database does not answer', async () => {
    const s = await store();
    await s.run.query('ALTER TABLE machines DROP COLUMN role');
    expect(await s.lease.othersHoldData()).toBe(false);
    const broken = leaseStore({ query: () => Promise.reject(new Error('the database is away')) }, { machineId: 'machine-a' });
    expect(await broken.othersHoldData()).toBeNull();
  });

  it('ends no session where the app and the agents have none', async () => {
    const s = await store();
    expect(await s.lease.endSessions()).toBe(0);
  });
});

/* A server that takes every connection and never says a word, as a database that hangs does. */
async function silentServer() {
  const open = new Set<net.Socket>();
  let opened = 0;
  const server = net.createServer(socket => {
    opened++;
    open.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => open.delete(socket));
    /* It reads what comes, or it would never see the other end close. */
    socket.resume();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => {
    for (const socket of open) socket.destroy();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { url: `postgres://u:p@127.0.0.1:${port}/d`, opened: () => opened, openNow: () => open.size };
}

/* A server that lets each connection in as a database does, and then never answers a statement, as a database whose
   disk hangs does. */
async function hangingServer() {
  const open = new Set<net.Socket>();
  let asked = 0;
  const server = net.createServer(socket => {
    open.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => open.delete(socket));
    let started = false;
    socket.on('data', () => {
      if (started) return void (asked += 1);
      started = true;
      /* AuthenticationOk, then ReadyForQuery while idle. */
      socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => {
    for (const socket of open) socket.destroy();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { url: `postgres://u:p@127.0.0.1:${port}/d`, asked: () => asked };
}

/* Waits for what the sockets bring, a turn of the event loop at a time, and moves no clock: vi.waitFor would move a
   faked one. */
async function turnsUntil(done: () => boolean): Promise<void> {
  while (!done()) await new Promise<void>(resolve => setImmediate(resolve));
}

/* Whether a promise has settled yet, either way. */
function settling(answer: Promise<unknown>): { done: boolean } {
  const seen = { done: false };
  answer.then(() => void (seen.done = true), () => void (seen.done = true));
  return seen;
}

describe("the keeper's connection", () => {
  it('gives up on a database that never answers, and opens a new connection for the next query', async () => {
    const silent = await silentServer();
    const run = keeperSql(silent.url, { timeoutMs: 50 });
    onTestFinished(() => run.close());
    await expect(run.query('SELECT 1')).rejects.toThrow();
    await expect(run.query('SELECT 1')).rejects.toThrow();
    expect(silent.opened()).toBe(2);
  });

  it('sends its queries one after another, each on a connection the one before has given up', async () => {
    const silent = await silentServer();
    const run = keeperSql(silent.url, { timeoutMs: 50 });
    onTestFinished(() => run.close());
    const first = run.query('SELECT 1');
    const rest = Promise.allSettled([run.query('SELECT 2'), run.query('SELECT 3')]);
    await expect(first).rejects.toThrow();
    /* The two behind it have not connected while the first one waited. */
    expect(silent.opened()).toBe(1);
    expect((await rest).map(answer => answer.status)).toEqual(['rejected', 'rejected']);
    expect(silent.opened()).toBe(3);
    await until(() => silent.openNow() === 0);
  });

  it('gives a connection and each statement the time the disk asks for at that moment', async () => {
    const silent = await silentServer();
    const hanging = await hangingServer();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    let ms = 3000;
    /* A connection to a database that never answers waits as long as the disk asks, and no longer. */
    const connecting = keeperSql(silent.url, { timeoutMs: () => ms });
    onTestFinished(() => connecting.close());
    const first = settling(connecting.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(2999);
    expect(first.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await turnsUntil(() => first.done);
    /* A statement on a connection that came in waits as long as the disk asks when it is sent, read anew each time. */
    const asking = keeperSql(hanging.url, { timeoutMs: () => ms });
    onTestFinished(() => asking.close());
    for (const [round, wait] of [[1, 3000], [2, 5000]] as const) {
      ms = wait;
      const answer = settling(asking.query('SELECT 1'));
      await turnsUntil(() => hanging.asked() === round);
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect([round, answer.done]).toEqual([round, false]);
      await vi.advanceTimersByTimeAsync(1);
      await turnsUntil(() => answer.done);
    }
  });
});

describe('the lease of a machine as its keeper starts', () => {
  const said = (config: { databaseUrl: string | null; machineId: string | null }) => {
    const lines: string[] = [];
    const lease = leaseOfMachine(config, line => lines.push(line));
    onTestFinished(() => lease?.close());
    return { lease, lines };
  };

  it('is none without a database, and says so', () => {
    expect(said({ databaseUrl: null, machineId: 'a1b2c3d4'.repeat(4) })).toEqual({ lease: null, lines: ['The keeper takes no lease: DATABASE_URL is not set.'] });
  });

  /* A company started from the compose file by hand has no machine id in its .env. It must lead all the same. */
  it('is held under a name of its own by a machine that was given no id, which leads alone and joins no network', async () => {
    const { db, sql: run } = await createTestSql();
    const lines: string[] = [];
    const lease = leaseOfMachine({ databaseUrl: 'postgres://nowhere.invalid/x', machineId: null }, line => lines.push(line), () => run);
    expect(lines).toEqual(['HORNHOOF_MACHINE_ID is not set, so this machine leads under a name of its own and joins no network. Run the install command to give it one.']);
    expect(await lease!.take('normal', FAR)).toMatchObject({ machine: UNNAMED_MACHINE });
    await expect(db.insert(companies).values({ name: 'Acme' })).resolves.toBeDefined();
  });

  it('is held under the id of a machine that has one, without a word', () => {
    const { lease, lines } = said({ databaseUrl: 'postgres://nowhere.invalid/x', machineId: 'a1b2c3d4'.repeat(4) });
    expect(lease).not.toBeNull();
    expect(lines).toEqual([]);
  });
});
