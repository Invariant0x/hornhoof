import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentRole, PUBLIC_REVOKES, readerRole } from '../src/db/agent-sql.js';
import { isLeaseRefused } from '../src/db/net.js';
import { companies } from '../src/db/schema.js';
import { leaseStore } from '../src/modules/keeper/lease-store.js';
import { createTestSql, ownDatabases } from './helpers.js';

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

  it('names each fence that does not hold', async () => {
    const s = await store();
    const role = agentRole('postgres');
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- The file runs on databases of its own.
    await s.run.query(`ALTER TABLE companies DISABLE TRIGGER net_journal; ALTER TABLE net.journal DISABLE TRIGGER net_fence;
      GRANT EXECUTE ON FUNCTION net.attach_journal() TO PUBLIC; GRANT SELECT ON net_local.lease TO "${role}"; GRANT pg_signal_backend TO "${role}"`);
    expect(await s.lease.problems()).toEqual([
      'public.companies has no journal trigger',
      'net.journal has no fence trigger',
      'PUBLIC may still run net.attach_journal()',
      `${role} may signal other sessions`,
      `${role} may reach net_local.lease`,
      `${role} may run net.attach_journal()`,
      /* What PUBLIC may run, every role may. */
      `${readerRole('postgres')} may run net.attach_journal()`,
    ]);
  });

  it('prunes journal rows older than a week, a batch at a time, and only while this machine keeps the data alone', async () => {
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
    await s.run.query(`UPDATE net_local.lease SET sync = 'copy'`);
    expect(await s.lease.prune()).toBe(0);
  });

  it('ends no session where the app and the agents have none', async () => {
    const s = await store();
    expect(await s.lease.endSessions()).toBe(0);
  });
});
