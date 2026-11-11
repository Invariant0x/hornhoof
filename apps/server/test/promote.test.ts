import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handoverOf, markHanded, recordHandover, termOf, writeTerm } from '../src/modules/keeper/promote.js';
import { createTestSql, ownDatabases } from './helpers.js';

/* These tests write the term a database stands under, which a truncate does not undo. */
ownDatabases();

const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);

async function database() {
  const { sql } = await createTestSql();
  /* No company, person or machine stands behind the rows of these tests, which the check of that is told to let pass. */
  await sql.query('SET session_replication_role = replica');
  await sql.query('DELETE FROM net_local.lease; DELETE FROM net_local.state');
  const state = async () => (await sql.query<{ number: string; machine: string; split: boolean; to: string | null; lsn: string | null; at: Date | null }>(
    'SELECT term_number::text AS number, term_machine AS machine, term_split AS split, handed_to AS "to", handed_lsn AS lsn, handed_at AS at FROM net_local.state')).rows;
  return { sql, state };
}

describe('the steps of a promotion', () => {
  it('writes the term above every one seen', async () => {
    const d = await database();
    /* The copy holds the old leader's journal, with a term above the one the old leader said it stands under. */
    await d.sql.query(`INSERT INTO net.journal (xact, term_number, term_machine, term_split, machine, tbl, op, key, cols) VALUES (gen_random_uuid(), 7, '${A}', false, '${A}', 'tasks', 'insert', '{}'::jsonb, '{}')`);
    expect(await termOf(d.sql)).toBeNull();
    expect(await writeTerm(d.sql, { above: 5, machine: B })).toEqual({ number: 8, machine: B, split: false });
    expect(await d.state()).toEqual([{ number: '8', machine: B, split: false, to: null, lsn: null, at: null }]);
    /* A keeper that starts again in the middle finds its own term and keeps it. */
    expect(await writeTerm(d.sql, { above: 5, machine: B })).toEqual({ number: 8, machine: B, split: false });
    await d.sql.query('UPDATE net_local.state SET term_number = 9');
    expect(await writeTerm(d.sql, { above: 5, machine: B })).toMatchObject({ number: 9 });
    expect(await termOf(d.sql)).toEqual({ number: 9, machine: B, split: false, handedLsn: null });
    /* A term of another machine, or one not above the old leader's, is not this attempt's. */
    expect(await writeTerm(d.sql, { above: 12, machine: B })).toMatchObject({ number: 13 });
    expect(await writeTerm(d.sql, { above: 5, machine: A })).toMatchObject({ number: 14, machine: A });
  });

  it('marks a database handed, and takes the server back under a new term', async () => {
    const d = await database();
    await writeTerm(d.sql, { above: 0, machine: A });
    const at = new Date('2026-11-11T12:00:00Z');
    await markHanded(d.sql, { to: B, lsn: '0/3000000', at });
    expect(await d.state()).toEqual([{ number: '1', machine: A, split: false, to: B, lsn: '0/3000000', at }]);
    expect(await termOf(d.sql)).toMatchObject({ number: 1, handedLsn: '0/3000000' });
    /* The machine that handed the server over takes it back later: its old term is not this attempt's. */
    expect(await writeTerm(d.sql, { above: 0, machine: A })).toEqual({ number: 2, machine: A, split: false });
    expect(await d.state()).toEqual([{ number: '2', machine: A, split: false, to: null, lsn: null, at: null }]);
  });

  it('records a handover and ends the request', async () => {
    const d = await database();
    const [from, to, person, id] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await d.sql.query(`INSERT INTO net.move (request, machine_id, from_machine_id, asked_by, asked_at, state) VALUES ('${id}', '${to}', '${from}', '${person}', now(), 'switching')`);
    const handover = { id, from, term: { number: 7, machine: A, split: false }, applied: '0/3000000', to, at: new Date('2026-11-11T12:00:00Z'), slots: { [A]: 'copy_a0a0a0a0a0a0a0a0_3' } };
    expect(await handoverOf(d.sql, id)).toBeNull();
    await recordHandover(d.sql, handover);
    expect((await d.sql.query('SELECT 1 FROM net.move')).rows).toEqual([]);
    expect(await handoverOf(d.sql, id)).toEqual({ from, term: handover.term, slots: handover.slots });
    /* Once more, as a keeper that started again does: one record, and a request made since stays. */
    await d.sql.query(`INSERT INTO net.move (machine_id, from_machine_id, asked_by, asked_at, state) VALUES ('${from}', '${to}', '${person}', now(), 'preparing')`);
    await recordHandover(d.sql, { ...handover, applied: '0/9999999' });
    expect((await d.sql.query<{ applied: string }>('SELECT applied FROM net.handovers')).rows).toEqual([{ applied: '0/3000000' }]);
    expect((await d.sql.query('SELECT 1 FROM net.move')).rows).toHaveLength(1);
  });
});
