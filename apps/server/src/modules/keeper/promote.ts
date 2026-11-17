import type { Term } from '../../db/net.js';
import type { Sql } from './lease-store.js';
import { ident, literal } from './sql-words.js';
import { PUBLICATION } from './replica.js';

/* The steps by which a copy becomes the leader and the old leader joins it, each on the keeper's own session and each
   doing nothing when its work is already done, so a keeper that starts again in the middle goes on. */


/* The term this database stands under, and the position its time as the leader ended at, when it handed the server over. */
export async function termOf(sql: Sql): Promise<(Term & { handedLsn: string | null }) | null> {
  const [row] = (await sql.query<{ number: string; machine: string; split: boolean; handed: string | null }>('SELECT term_number::text AS number, term_machine AS machine, term_split AS split, handed_lsn AS handed FROM net_local.state')).rows;
  return row ? { number: Number(row.number), machine: row.machine, split: row.split, handedLsn: row.handed } : null;
}

/* The term of the machine that takes the server: one above the old leader's, above every term its journal names and
   above this database's own, unsplit, with this database's cluster. A term of this machine that stands above the old
   leader's and ended in no handover is this attempt's own, written before a restart, and stays. Else the one row is
   written over, and what it said of a handover goes: a machine that handed the server over takes it back. */
export async function writeTerm(sql: Sql, o: { above: number; machine: string }): Promise<Term> {
  const mine = await termOf(sql);
  if (mine && mine.machine === o.machine && mine.handedLsn === null && mine.number > o.above) return { number: mine.number, machine: mine.machine, split: false };
  const { rows } = await sql.query<{ number: string }>(
    `WITH next AS (
       SELECT GREATEST($1::bigint, COALESCE((SELECT max(term_number) FROM net.journal), 0), COALESCE((SELECT max(term_number) FROM net_local.state), 0)) + 1 AS number
     )
     INSERT INTO net_local.state (term_number, term_machine, term_split, machine, cluster)
     SELECT next.number, $2, false, $2, (SELECT system_identifier::text FROM pg_control_system()) FROM next
     ON CONFLICT (id) DO UPDATE SET term_number = EXCLUDED.term_number, term_machine = EXCLUDED.term_machine, term_split = false, machine = EXCLUDED.machine,
       cluster = EXCLUDED.cluster, handed_to = NULL, handed_lsn = NULL, handed_at = NULL
     RETURNING term_number::text AS number`,
    [o.above, o.machine],
  );
  return { number: Number(rows[0]!.number), machine: o.machine, split: false };
}

type Subscription = { name: string };

/* Every subscription of this database is disabled, detached from its slot and dropped, in that order: a subscription
   dropped with its slot still named would drop the slot on the other side. The names. */
export async function dropSubscriptions(sql: Sql): Promise<string[]> {
  const { rows } = await sql.query<Subscription>(`SELECT s.subname::text AS name FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() ORDER BY s.subname`);
  for (const { name } of rows) {
    await sql.query(`ALTER SUBSCRIPTION ${ident(name)} DISABLE`);
    await sql.query(`ALTER SUBSCRIPTION ${ident(name)} SET (slot_name = NONE)`);
    await sql.query(`DROP SUBSCRIPTION ${ident(name)}`);
  }
  return rows.map(row => row.name);
}

/* Every sequence a column of a table in public owns is set far above that column's highest value, unless it already
   stands higher: a copy's sequences never moved, and the numbers the old leader gave out last may not have reached it
   as sequence values. The names it set. */
export async function raiseSequences(sql: Sql, room = 1000): Promise<string[]> {
  const { rows } = await sql.query<{ seq: string; tbl: string; col: string }>(
    `SELECT s.oid::regclass::text AS seq, c.relname::text AS tbl, a.attname::text AS col
       FROM pg_class s
       JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
       JOIN pg_class c ON c.oid = d.refobjid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
      WHERE s.relkind = 'S' AND n.nspname = 'public'
      ORDER BY 1`,
  );
  const set: string[] = [];
  for (const { seq, tbl, col } of rows) {
    const [top] = (await sql.query<{ top: string }>(`SELECT COALESCE(max(${ident(col)}), 0)::text AS top FROM public.${ident(tbl)}`)).rows;
    const [now] = (await sql.query<{ last: string }>(`SELECT last_value::text AS last FROM ${seq}`)).rows;
    const wanted = BigInt(top?.top ?? '0') + BigInt(room);
    if (wanted <= BigInt(now?.last ?? '0')) continue;
    await sql.query('SELECT setval($1::regclass, $2::bigint)', [seq, wanted.toString()]);
    set.push(seq);
  }
  return set;
}

/* A slot for each machine that follows this one from now on, unless it is there. A slot is there only once it is
   whole. Postgres lists one from the moment its making begins, and that making waits for every transaction that was
   open then: a keeper that gave up waiting for the answer finds the slot listed the next time, and what it wrote
   before the slot is whole would never reach the machine that joins it. Such a slot is none yet, and this fails
   until it is whole or gone. */
export async function makeSlots(sql: Sql, names: string[]): Promise<void> {
  for (const name of names) {
    const [slot] = (await sql.query<{ whole: boolean }>('SELECT confirmed_flush_lsn IS NOT NULL AS whole FROM pg_replication_slots WHERE slot_name = $1::text', [name])).rows;
    if (slot?.whole) continue;
    if (slot) throw new Error(`the slot ${name} is still being made`);
    await sql.query(`SELECT pg_create_logical_replication_slot($1::text, 'pgoutput')`, [name]);
  }
}

const NO_COPY_TRIES = 20;
const NO_COPY_WAIT_MS = 100;

/* A database that begins to lead waits for no copy. A name left in its setting from a time it led before names a copy
   that follows it no more, and every commit of the promotion would wait for that copy for good. The sync controller
   names one again once this machine leads. */
export async function waitForNoCopy(sql: Sql): Promise<void> {
  const named = async (): Promise<boolean> => ((await sql.query<{ names: string }>(`SELECT current_setting('synchronous_standby_names') AS names`)).rows[0]?.names ?? '') !== '';
  if (!(await named())) return;
  await sql.query('ALTER SYSTEM RESET synchronous_standby_names');
  await sql.query('SELECT pg_reload_conf()');
  /* The reload reaches a session a moment later. */
  for (let tries = 0; tries < NO_COPY_TRIES && (await named()); tries++) await new Promise(resolve => setTimeout(resolve, NO_COPY_WAIT_MS));
}

/* The record of a planned switch, under the switch's id, and the end of the request it answers, in one commit. A
   record of that id already there counts as done, and a request made since stays. */
type Handover = {
  id: string; from: string; term: Term; applied: string; to: string; at: Date; slots: Record<string, string>;
  /* A planned switch when left out. For a takeover and the CEO's choice: when the old leader was last heard, how far
     the new leader's own changes reached, and why the old leader stopped, when it said so. */
  kind?: 'planned' | 'takeover' | 'ceo'; heardAt?: Date | null; reach?: Date | null; reason?: 'disk_full' | null;
};

export async function recordHandover(sql: Sql, h: Handover): Promise<void> {
  await sql.query(
    `WITH made AS (
       INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, slots, kind, heard_at, reach, reason)
       VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5, $6::uuid, $7::timestamptz, $8::jsonb, $9, $10::timestamptz, $11::timestamptz, $12)
       ON CONFLICT (id) DO NOTHING RETURNING id
     )
     DELETE FROM net.move WHERE request = $1::uuid AND EXISTS (SELECT 1 FROM made)`,
    [h.id, h.from, h.term.number, h.term.machine, h.applied, h.to, h.at.toISOString(), JSON.stringify(h.slots), h.kind ?? 'planned', h.heardAt?.toISOString() ?? null, h.reach?.toISOString() ?? null, h.reason ?? null],
  );
}

/* The handover recorded under that switch's id: who led before, under which term, and the slot made for each machine. */
export async function handoverOf(sql: Sql, id: string): Promise<{ from: string; term: Term; slots: Record<string, string> } | null> {
  const [row] = (await sql.query<{ from: string; number: string; machine: string; slots: Record<string, string> }>(
    'SELECT from_machine_id::text AS "from", term_number::text AS number, term_machine AS machine, slots FROM net.handovers WHERE id = $1::uuid', [id])).rows;
  return row ? { from: row.from, term: { number: Number(row.number), machine: row.machine, split: false }, slots: row.slots } : null;
}

/* This database's time as the leader ended here: to which machine it handed the server, at which position, and when. */
export async function markHanded(sql: Sql, o: { to: string; lsn: string; at: Date }): Promise<void> {
  await sql.query('UPDATE net_local.state SET handed_to = $1, handed_lsn = $2, handed_at = $3::timestamptz', [o.to, o.lsn, o.at.toISOString()]);
}

/* Every slot of this database goes: the walsender that reads it is ended first, since a slot that is read cannot be
   dropped. The names. */
export async function dropSlots(sql: Sql, tries = 50): Promise<string[]> {
  const slots = async () => (await sql.query<{ name: string; pid: number | null }>('SELECT slot_name::text AS name, active_pid AS pid FROM pg_replication_slots WHERE database = current_database() ORDER BY 1')).rows;
  const dropped: string[] = [];
  for (let round = 0; round < tries; round++) {
    const left = await slots();
    if (left.length === 0) break;
    for (const slot of left) {
      if (slot.pid !== null) {
        await sql.query('SELECT pg_terminate_backend($1::int)', [slot.pid]);
        continue;
      }
      await sql.query('SELECT pg_drop_replication_slot($1::text)', [slot.name]);
      dropped.push(slot.name);
    }
    if (left.some(slot => slot.pid !== null)) await new Promise(resolve => setTimeout(resolve, 100));
  }
  return dropped;
}

/* Whether the subscription is enabled and its apply worker runs. */
export async function applyRunning(sql: Sql, subscription: string): Promise<boolean> {
  const [row] = (await sql.query<{ running: boolean }>(
    `SELECT s.subenabled AND EXISTS (SELECT 1 FROM pg_stat_subscription st WHERE st.subid = s.oid AND st.relid IS NULL AND st.pid IS NOT NULL) AS running
       FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() AND s.subname = $1`, [subscription])).rows;
  return row?.running === true;
}

/* Joins the machine that leads now over the slot it made for this one, taking no row again: this database holds
   everything up to the position the slot starts at. A subscription of that name already there counts as made. */
export async function joinSlot(sql: Sql, o: { name: string; conninfo: string }): Promise<void> {
  const { rows } = await sql.query('SELECT 1 FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() AND s.subname = $1', [o.name]);
  if (rows.length > 0) return;
  await sql.query(
    `CREATE SUBSCRIPTION ${ident(o.name)} CONNECTION ${literal(o.conninfo)} PUBLICATION ${ident(PUBLICATION)} WITH (create_slot = false, slot_name = ${literal(o.name)}, copy_data = false, synchronous_commit = 'local', binary = false, streaming = off, disable_on_error = true)`,
  );
}
