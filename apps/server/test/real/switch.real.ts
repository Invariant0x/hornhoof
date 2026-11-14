import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyName } from '../../src/modules/keeper/copy.js';
import { keeperSql, leaseStore, type Sql } from '../../src/modules/keeper/lease-store.js';
import { applyRunning, dropSlots, dropSubscriptions, handoverOf, joinSlot, makeSlots, markHanded, raiseSequences, recordHandover, termOf, writeTerm } from '../../src/modules/keeper/promote.js';
import { ensurePublication, REPLICA_ROLE } from '../../src/modules/keeper/replica.js';
import { SWITCH_MS } from '../../src/modules/keeper/switch-step.js';
import { pgSubscription, Promoter, readTaking, writeTaking } from '../../src/modules/keeper/taking.js';
import { pair, type Pair } from './pair.js';
import type { RealCluster } from './pg.js';

const LONG = { timeout: 900_000 };
const COMPANY = randomUUID();
const OWNER = randomUUID();
const PLAN = randomUUID();
const DEPARTMENT = randomUUID();
const AGENT = randomUUID();
const TASK = randomUUID();
const LEADER_ID = 'a1b2c3d4'.repeat(8);

/* One of the two machines. sql: its keeper's own session. db: the owner's, for what the test writes and reads.
   attempt: the number its last copy's name ended with, none yet for a machine that never followed. follows: the name
   of its subscription and of its slot on the machine that leads, while it follows. */
type Side = { cluster: RealCluster; networkId: string; machine: string; sql: Sql & { close(): Promise<void> }; db: pg.Client; attempt: number; follows: string | null };

let p: Pair;
let lead: Side;
let follow: Side;
let tasks = 1;
const folders: string[] = [];

async function connected(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  /* Dropping a database ends every session on it: the next query on it fails, and nothing else comes of it. */
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

async function until(done: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`Did not see ${what} within ${ms / 1000} s.`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/* The tables of the two schemas a copy follows. */
const TABLES = `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname IN ('public', 'net') ORDER BY 1`;
/* Every row of a table as one hash, whatever order they lie in. */
const hashOf = async (on: pg.Client, table: string): Promise<string> =>
  (await on.query<{ hash: string }>(`SELECT count(*) || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS hash FROM ${table} t`)).rows[0]!.hash;

/* The tables that do not hold the same rows on both machines. */
async function differing(a: Side, b: Side): Promise<string[]> {
  const tables = (await a.db.query<{ name: string }>(TABLES)).rows.map(row => row.name);
  expect((await b.db.query<{ name: string }>(TABLES)).rows.map(row => row.name)).toEqual(tables);
  const found: string[] = [];
  for (const table of tables) if ((await hashOf(a.db, table)) !== (await hashOf(b.db, table))) found.push(table);
  return found;
}

/* A task, an event of a task and an event of an agent, each in a commit of its own. The task event's id. */
async function write(on: Side): Promise<bigint> {
  const number = ++tasks;
  await on.db.query('INSERT INTO tasks (company_id, number, title, department_id) VALUES ($1, $2, $3, $4)', [COMPANY, number, `Task ${number}`, DEPARTMENT]);
  const event = await on.db.query<{ id: string }>(`INSERT INTO task_events (company_id, task_id, kind) VALUES ($1, $2, 'comment') RETURNING id::text`, [COMPANY, TASK]);
  await on.db.query(`INSERT INTO agent_events (company_id, agent_id, kind, data) VALUES ($1, $2, 'text', $3::jsonb)`, [COMPANY, AGENT, JSON.stringify({ task: number })]);
  return BigInt(event.rows[0]!.id);
}

const holds = async (on: Side, number: number): Promise<boolean> =>
  (await on.db.query(`SELECT 1 FROM agent_events WHERE agent_id = $1 AND data = $2::jsonb`, [AGENT, JSON.stringify({ task: number })])).rows.length === 1;

const logEnd = async (on: Side): Promise<string> => (await on.db.query<{ lsn: string }>('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0]!.lsn;

/* Whether the slot of that name on this machine confirmed that position. */
const confirmed = async (on: Side, slot: string, lsn: string): Promise<boolean> =>
  (await on.db.query<{ at: boolean }>('SELECT confirmed_flush_lsn >= $2::pg_lsn AS at FROM pg_replication_slots WHERE slot_name = $1', [slot, lsn])).rows[0]?.at === true;

/* The machine that leads stops writing, the one that follows it reaches the end of its log and is promoted, and the
   old leader joins it over the slot made for it: the steps of a planned switch, in their order, each by the function
   the keepers run. checkpoint: a checkpoint is the last thing in the old leader's log. promoter: the promotion is
   the taking keeper's own, from what it wrote down at the go. */
async function handOver(opts: { checkpoint?: boolean; promoter?: boolean } = {}): Promise<void> {
  const [a, b] = [lead, follow];
  const followed = b.follows!;
  const id = randomUUID();
  await a.db.query(`INSERT INTO net.move (request, machine_id, from_machine_id, asked_by, asked_at, state) VALUES ($1, $2, $3, $4, clock_timestamp(), 'switching')`, [id, b.machine, a.machine, OWNER]);
  const last = await write(a);
  const led = (await termOf(a.sql))!;

  /* The old leader's lease ends, and where its log ends then is W. */
  await leaseStore(a.sql, { machineId: a.networkId }).fence();
  if (opts.checkpoint) await a.db.query('CHECKPOINT');
  const w = await logEnd(a);
  await until(() => confirmed(a, followed, w), opts.checkpoint ? 10_000 : 60_000, 'the slot of the machine that follows at W');
  /* At that moment, with no further wait, the machine that follows holds every row. */
  expect(await differing(a, b)).toEqual([]);
  if (opts.checkpoint) {
    /* Nothing was there to apply after the last commit, so what the follower applied ends before W. */
    expect((await b.db.query<{ behind: boolean }>('SELECT remote_lsn < $1::pg_lsn AS behind FROM pg_replication_origin_status', [w])).rows).toEqual([{ behind: true }]);
    expect(await applyRunning(b.sql, followed)).toBe(true);
  }

  /* The promotion. */
  const slot = copyName(a.networkId, a.attempt + 1);
  const slots = { [a.networkId]: slot };
  const at = new Date();
  if (opts.promoter) {
    /* As the keeper that started again after the go: the name is its own, its nonce comes back, and it promotes. */
    const [dir, controlDir] = [mkdtempSync(join(tmpdir(), 'hh-switch-keeper-')), mkdtempSync(join(tmpdir(), 'hh-switch-control-'))];
    folders.push(dir, controlDir);
    writeTaking(dir, {
      switch: id, from: { networkId: a.networkId, hostname: 'the old leader' }, term: { number: led.number, machine: led.machine, split: false },
      at: Date.now(), deadline: Date.now() + SWITCH_MS, phase: 'go', w, copies: [], slots: null, why: null,
    });
    const lines: string[] = [];
    const promoter = new Promoter({
      dir, controlDir, sql: b.sql, machine: { networkId: b.networkId },
      registered: async () => true,
      probe: async nonce => ({ machine: b.networkId, nonce }),
      tunnel: { start: () => undefined, stop: async () => undefined },
      subscription: pgSubscription(b.sql, async () => followed),
      appLeads: () => false, exit: () => lines.push('exit'), log: line => lines.push(line),
    });
    await promoter.look();
    expect(promoter.leads()).toBe(false);
    await promoter.look();
    expect(lines).toEqual([]);
    expect([promoter.leads(), readTaking(dir)]).toEqual([true, expect.objectContaining({ phase: 'promoted', slots })]);
    expect(await dropSubscriptions(b.sql)).toEqual([]);
  } else {
    expect(await dropSubscriptions(b.sql)).toEqual([followed]);
    const written = await writeTerm(b.sql, { above: led.number, machine: b.networkId });
    expect((await raiseSequences(b.sql)).filter(name => name.endsWith('task_events_id_seq'))).toHaveLength(1);
    await ensurePublication(b.sql);
    await makeSlots(b.sql, [slot]);
    await recordHandover(b.sql, { id, from: a.machine, term: led, applied: w, to: b.machine, at, slots });
    expect(written.number).toBeGreaterThan(led.number);
  }
  const term = (await termOf(b.sql))!;
  expect(term).toEqual({ number: expect.any(Number) as number, machine: b.networkId, split: false, handedLsn: null });
  expect(term.number).toBeGreaterThan(led.number);
  /* Each step again changes nothing: a keeper that starts again in the middle goes on. */
  expect(await writeTerm(b.sql, { above: led.number, machine: b.networkId })).toEqual({ number: term.number, machine: term.machine, split: false });
  expect(await dropSubscriptions(b.sql)).toEqual([]);
  expect(await raiseSequences(b.sql)).toEqual([]);
  await makeSlots(b.sql, [slot]);
  await recordHandover(b.sql, { id, from: a.machine, term: led, applied: w, to: b.machine, at, slots });
  expect(await handoverOf(b.sql, id)).toEqual({ from: a.machine, term: { number: led.number, machine: led.machine, split: false }, slots });
  expect((await b.db.query('SELECT 1 FROM net.move')).rows).toEqual([]);
  expect((await b.db.query('SELECT 1 FROM net.handovers WHERE id = $1', [id])).rows).toHaveLength(1);

  /* The old leader follows: its time as the leader is marked ended, its slots go, and it joins the slot made for it. */
  await markHanded(a.sql, { to: b.networkId, lsn: w, at });
  expect(await termOf(a.sql)).toMatchObject({ number: led.number, handedLsn: w });
  expect(await dropSlots(a.sql)).toEqual([followed]);
  await a.cluster.exec(['sh', '-c', 'umask 077 && cat > "$PGDATA/replica.pgpass"'], { stdin: `*:*:*:${REPLICA_ROLE}:${p.password}\n` });
  await a.db.query(`ALTER SYSTEM SET wal_receiver_status_interval = '1s'`);
  await a.db.query('SELECT pg_reload_conf()');
  const dir = (await a.db.query<{ data_directory: string }>('SHOW data_directory')).rows[0]!.data_directory;
  const conninfo = `host=${b.cluster.host} port=5432 dbname=hornhoof user=${REPLICA_ROLE} passfile=${dir}/replica.pgpass`;
  await joinSlot(a.sql, { name: slot, conninfo });
  await joinSlot(a.sql, { name: slot, conninfo });
  a.follows = slot;
  a.attempt += 1;
  b.follows = null;
  [lead, follow] = [b, a];

  /* What the new leader writes reaches the old one, and its numbers stand above every one the old leader gave out. */
  const made = await write(b);
  expect(made > last).toBe(true);
  /* As the old leader's keeper reports the copy it follows with now. */
  await b.db.query('UPDATE machines SET copy_name = $1 WHERE id = $2', [slot, a.machine]);
  await until(() => holds(a, tasks), 10_000, "the new leader's rows on the old one");
  await until(() => applyRunning(a.sql, slot), 10_000, 'the old leader applying');
  expect(await differing(b, a)).toEqual([]);
  expect((await a.db.query('SELECT 1 FROM net.move')).rows).toEqual([]);
  expect((await a.db.query('SELECT 1 FROM net.handovers WHERE id = $1', [id])).rows).toHaveLength(1);
}

beforeAll(async () => {
  p = await pair({ leader: 'linux/amd64', copy: 'linux/arm64' });
  await p.leader.admin.query(`INSERT INTO companies (id, name) VALUES ('${COMPANY}', 'Acme');
    INSERT INTO people (id, company_id, name, email, status, scope_kind, is_owner) VALUES ('${OWNER}', '${COMPANY}', 'Ivan', 'ivan@acme.test', 'active', 'company', true);
    INSERT INTO subscriptions (id, company_id, provider, kind, label, owner_person_id, status) VALUES ('${PLAN}', '${COMPANY}', 'claude', 'personal', 'Plan', '${OWNER}', 'ready');
    INSERT INTO departments (id, company_id, name, role_code) VALUES ('${DEPARTMENT}', '${COMPANY}', 'Development', 'DEV');
    INSERT INTO agents (id, company_id, kind, name, model, department_id, subscription_id) VALUES ('${AGENT}', '${COMPANY}', 'worker', 'Ana', '', '${DEPARTMENT}', '${PLAN}');
    INSERT INTO tasks (id, company_id, number, title, department_id) VALUES ('${TASK}', '${COMPANY}', 1, 'One', '${DEPARTMENT}')`);
  const machine = async (key: string, networkId: string, order: number): Promise<string> =>
    (
      await p.leader.admin.query<{ id: string }>(
        `INSERT INTO machines (company_id, person_id, machine_key, hostname, role, network_id, server_order) VALUES ($1, $2, $3, $3, 'data', $4, $5) RETURNING id`,
        [COMPANY, OWNER, key, networkId, order],
      )
    ).rows[0]!.id;
  const machines = [await machine('leader', LEADER_ID, 1), await machine('copy', p.networkId, 2)] as const;
  await p.until(() => p.maker.report()?.state === 'ready');
  /* As the copy's keeper reports the copy it made. */
  await p.leader.admin.query('UPDATE machines SET copy_name = $1 WHERE id = $2', [copyName(p.networkId, 1), machines[1]]);
  lead = { cluster: p.leader, networkId: LEADER_ID, machine: machines[0], sql: keeperSql(p.leader.url, { timeoutMs: 120_000 }), db: await connected(p.leader.url), attempt: 0, follows: null };
  follow = { cluster: p.copy, networkId: p.networkId, machine: machines[1], sql: keeperSql(p.copyUrl('hornhoof'), { timeoutMs: 120_000 }), db: await connected(p.copyUrl('hornhoof')), attempt: 1, follows: copyName(p.networkId, 1) };
}, 900_000);

afterAll(async () => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  for (const side of [lead, follow]) {
    await side?.sql.close().catch(() => undefined);
    await side?.db.end().catch(() => undefined);
  }
  await p?.close();
}, 120_000);

describe('a planned switch between two Postgres servers', () => {
  it('promotes a copy and the old leader joins it', LONG, async () => {
    for (let n = 0; n < 20; n++) await write(lead);
    await handOver();
    expect(lead.cluster).toBe(p.copy);
  });

  it('reaches W when only a checkpoint follows', LONG, async () => {
    /* Back the way it came: the machine that handed the server over takes it again, under a term above both. */
    for (let n = 0; n < 5; n++) await write(lead);
    await handOver({ checkpoint: true, promoter: true });
    expect(lead.cluster).toBe(p.leader);
    expect(await termOf(lead.sql)).toMatchObject({ machine: LEADER_ID, handedLsn: null });
  });

  it('takes nothing as applied before it is', LONG, async () => {
    const total = 50_000;
    const count = async (on: Side): Promise<number> => (await on.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_events WHERE data = '{"many": true}'::jsonb`)).rows[0]!.n;
    await lead.db.query(`INSERT INTO agent_events (company_id, agent_id, kind, data) SELECT $1, $2, 'text', '{"many": true}'::jsonb FROM generate_series(1, $3::int)`, [COMPANY, AGENT, total]);
    const w = await logEnd(lead);
    /* The slot is looked at first: once it says W, every row must be there already. */
    let early = 0;
    for (;;) {
      const at = await confirmed(lead, follow.follows!, w);
      const there = await count(follow);
      if (!at) {
        if (there < total) early += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        continue;
      }
      expect(there).toBe(total);
      break;
    }
    /* The looks before that saw the transaction on its way, so the wait was a real one. */
    expect(early).toBeGreaterThan(0);
  });

  it('refuses to drop a database with an active slot, and drops it once the slots went', LONG, async () => {
    const outside = new URL(lead.cluster.url);
    outside.pathname = '/postgres';
    const admin = await connected(outside.href);
    try {
      await until(() => applyRunning(follow.sql, follow.follows!), 10_000, 'the follower applying');
      await expect(admin.query('DROP DATABASE hornhoof WITH (FORCE)')).rejects.toMatchObject({ code: '55006', message: expect.stringContaining('active logical replication slot') as string });
      await follow.db.query(`ALTER SUBSCRIPTION ${follow.follows!} DISABLE`);
      expect(await dropSlots(lead.sql)).toEqual([follow.follows!]);
      await lead.sql.close();
      await admin.query('DROP DATABASE hornhoof WITH (FORCE)');
      expect((await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'hornhoof'`)).rows).toEqual([]);
    } finally {
      await admin.end().catch(() => undefined);
    }
  });
});
