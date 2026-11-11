import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLeaseRefused } from '../../src/db/net.js';
import { copyName } from '../../src/modules/keeper/copy.js';
import { keeperSql } from '../../src/modules/keeper/lease-store.js';
import { sweepSlots } from '../../src/modules/keeper/slots.js';
import { syncedPair, type SyncedPair } from './pair.js';
import type { Platform } from './pg.js';

/* The processor of this computer and the other one: each pair runs a leader on one and its copy on the other. The
   cases of a pair run in the order they stand in, each from where the one before left the pair. */
const HOST: Platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
const OTHER: Platform = HOST === 'linux/arm64' ? 'linux/amd64' : 'linux/arm64';
const LONG = { timeout: 600_000 };
const NOTE = (n: number | string) => `INSERT INTO notebook_notes (company_id, number, text) SELECT id, ${n}, 'note ${n}' FROM companies`;

/* fenced: as the app's own sessions are, so every commit stands on the lease. */
async function connected(url: string, fenced = false): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, ...(fenced ? { options: '-c hornhoof.fenced=on' } : {}) });
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/* Whether a promise is still open after this long. */
const pending = (work: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([work.then(() => false, () => false), new Promise<boolean>(resolve => setTimeout(() => resolve(true), ms))]);

describe.each([[HOST, OTHER], [OTHER, HOST]] as const)('a leader on %s with its copy on %s', (leader, copy) => {
  let p: SyncedPair;
  let onCopy: pg.Client;
  let notes = 0;
  const count = async (on: pg.Client): Promise<number> => (await on.query<{ n: number }>('SELECT count(*)::int AS n FROM notebook_notes')).rows[0]!.n;
  /* The copy holds every note the leader holds. */
  const caughtUp = () => p.wait(async () => (await count(onCopy)) === (await count(p.leader.admin)), 300_000, 'every note of the leader on the copy');
  const setting = async (): Promise<string> => (await p.leader.admin.query<{ synchronous_standby_names: string }>('SHOW synchronous_standby_names')).rows[0]!.synchronous_standby_names;
  /* The copy is the one commits wait for, and the relay was told so. */
  const named = () => p.wait(async () => p.record()?.state === 'on' && (await setting()) !== '', 300_000, 'the copy named at the relay');

  beforeAll(async () => {
    p = await syncedPair({ leader, copy });
  }, 900_000);

  afterAll(async () => {
    await onCopy?.end().catch(() => undefined);
    await p?.close();
  }, 300_000);

  it('makes the first copy while the leader writes', LONG, async () => {
    const term = async () => (await p.leader.admin.query<{ term: string }>('SELECT term_number::text AS term FROM net_local.lease WHERE until > clock_timestamp()')).rows[0]?.term;
    const first = await term();
    expect(first).toBeDefined();
    const app = await p.app();
    /* Twenty changes a second, all through the making. */
    let writing = true;
    const writer = (async () => {
      while (writing) {
        await app.query(NOTE(++notes));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })();
    await p.wait(() => p.maker.report()?.state === 'ready', 540_000, 'the copy ready');
    writing = false;
    await writer;
    /* The lease was renewed all along: the same term still stands. */
    expect(await term()).toBe(first);
    onCopy = await connected(p.copyUrl('hornhoof'));
    await caughtUp();
    expect(await count(onCopy)).toBe(notes);
    expect(notes).toBeGreaterThan(20);
    expect(p.lines.filter(line => line.startsWith('The lease ended'))).toEqual([]);
  });

  it('carries files and the journal, not sequences', LONG, async () => {
    /* A file of 50 MB, written past the checks that an agent stands behind it. */
    await p.leader.admin.query(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO attachments (company_id, agent_id, media_type, bytes, size)
        SELECT id, gen_random_uuid(), 'application/octet-stream', decode(repeat(md5(random()::text), 3276800), 'hex'), 52428800 FROM companies; COMMIT`);
    const hash = 'SELECT octet_length(bytes) AS length, md5(bytes) AS hash FROM attachments';
    const file = (await p.leader.admin.query(hash)).rows;
    expect(file[0].length).toBe(52_428_800);
    await p.wait(async () => (await onCopy.query('SELECT 1 FROM attachments')).rows.length === 1, 300_000, 'the file on the copy');
    expect((await onCopy.query(hash)).rows).toEqual(file);
    /* Two changes of one transaction come together, each with its row of the journal. */
    const app = await p.app();
    await app.query(`BEGIN; ${NOTE(++notes)}; ${NOTE(++notes)}; COMMIT`);
    await caughtUp();
    const journal = `SELECT count(*)::int AS n FROM net.journal WHERE tbl = 'notebook_notes'`;
    expect((await onCopy.query(journal)).rows).toEqual((await p.leader.admin.query(journal)).rows);
    /* A sequence the leader moved stays on the copy where its schema left it. */
    const sequence = `SELECT last_value::int AS last, is_called AS called FROM agent_events_seq_seq`;
    await p.leader.admin.query(`SELECT nextval('agent_events_seq_seq'), nextval('agent_events_seq_seq')`);
    expect((await p.leader.admin.query(sequence)).rows).toEqual([{ last: 2, called: true }]);
    expect((await onCopy.query(sequence)).rows).toEqual([{ last: 1, called: false }]);
  });

  it('waits for the checkpointer before W', LONG, async () => {
    /* The copy is not named yet: it has to keep pace for half a minute first. With the checkpointer standing still the
       setting is made, and nothing can show that commits wait by it. */
    expect(p.record()).toMatchObject({ state: 'off' });
    await p.holdCheckpointer();
    try {
      await p.wait(async () => (await setting()) !== '', 300_000, 'the setting');
      await new Promise(resolve => setTimeout(resolve, 5000));
      expect(p.record()).toMatchObject({ state: 'off' });
    } finally {
      await p.releaseCheckpointer();
    }
    await named();
    expect(p.controller.flag()).toBe('copy');
    /* From here on a commit does wait for the copy. */
    const app = await p.app();
    await p.pause();
    try {
      const commit = app.query(NOTE(++notes));
      expect(await pending(commit, 1000)).toBe(true);
      await p.resume();
      await commit;
    } finally {
      await p.resume().catch(() => undefined);
    }
  });

  it('confirms only what the copy holds', LONG, async () => {
    await named();
    const app = await p.app();
    for (let n = 0; n < 200; n++) await app.query(NOTE(++notes));
    const confirmed = await count(p.leader.admin);
    /* Each of those came back only once the copy held it. */
    expect(await count(onCopy)).toBeGreaterThanOrEqual(confirmed);
    await p.pause();
    let late: Promise<unknown>;
    try {
      late = app.query(NOTE(++notes));
      expect(await pending(late, 1000)).toBe(true);
    } finally {
      await p.resume();
    }
    await late!;
    await caughtUp();
  });

  it('goes on alone when the copy stops', LONG, async () => {
    await named();
    const app = await p.app();
    /* The copy's subscription stops, and its keeper is not there to start it again: its connection to the leader is gone. */
    p.keeping(false);
    try {
      await p.copy.admin.query(`ALTER SUBSCRIPTION ${p.maker.report()?.name} DISABLE`);
      await p.wait(async () => p.record()?.state === 'off' && (await setting()) === '', 60_000, 'the copy dropped from sync');
      expect(p.controller.flag()).toBe('relay_off');
      await app.query(NOTE(++notes));
      expect(p.holder.mode()).toBe('lead');
    } finally {
      p.keeping(true);
    }
    /* Its keeper enables it again by itself, and it catches up. */
    await caughtUp();
  });

  it('waits when neither the copy nor the relay answers', LONG, async () => {
    await named();
    const app = await p.app();
    p.relay.down = true;
    await p.pause();
    try {
      const commit = app.query(NOTE('-1')).then(() => 'committed', (err: Error) => `ended: ${err.message}`);
      /* The copy cannot be dropped, since the relay cannot be told: the lease is renewed no more, and ends. */
      await p.wait(() => !p.controller.renew(), 120_000, 'the keeper stopping its renewals');
      expect(await setting()).not.toBe('');
      const how = await commit;
      /* The session that waited was ended with the lease, and its caller heard so. */
      expect(how).toMatch(/^ended: /);
      expect(p.lines.some(line => line.startsWith('The lease ended'))).toBe(true);
      expect(p.holder.mode()).toBe('read');
    } finally {
      p.relay.down = false;
      await p.resume();
    }
    await p.wait(() => p.holder.mode() === 'lead', 120_000, 'the leader leading again');
  });

  it('keeps fence 3', LONG, async () => {
    /* With no flag on its lease the leader confirms nothing: the change and the flag's loss go back together. */
    const writer = await connected(p.leader.url, true);
    try {
      const refused = await writer.query(`BEGIN; UPDATE net_local.lease SET sync = NULL; ${NOTE('-2')}; COMMIT`).then(() => null, (err: unknown) => err);
      expect(isLeaseRefused(refused)).toBe(true);
      await writer.query('ROLLBACK').catch(() => undefined);
      expect((await writer.query(`SELECT 1 FROM notebook_notes WHERE number = -2`)).rows).toEqual([]);
    } finally {
      await writer.end();
    }
    /* The copy holds no lease at all, and takes no change of anyone's but the leader's. */
    const there = await connected(p.copyUrl('hornhoof'), true);
    try {
      const refused = await there.query(NOTE('-3')).then(() => null, (err: unknown) => err);
      expect(isLeaseRefused(refused)).toBe(true);
    } finally {
      await there.end();
    }
  });

  it('drops a stale slot even while its copy reads', LONG, async () => {
    /* A slot of a machine that holds no data any more, with a reader on it. */
    const stale = 'copy_eeeeeeeeeeeeeeee_1';
    await p.leader.exec(['sh', '-c', `pg_recvlogical -d hornhoof -U hornhoof --slot ${stale} --create-slot --start -f /dev/null -P pgoutput -o proto_version=1 -o publication_names=hornhoof > /dev/null 2>&1 < /dev/null &`]);
    const slot = async () => (await p.leader.admin.query<{ active: boolean }>('SELECT active FROM pg_replication_slots WHERE slot_name = $1', [stale])).rows;
    await p.wait(async () => (await slot())[0]?.active === true, 60_000, 'the stale slot with its reader');
    const sql = keeperSql(p.leader.url, { timeoutMs: 20_000 });
    try {
      const lines: string[] = [];
      await p.wait(async () => (await sweepSlots(sql, line => lines.push(line), new Map(), 0)).includes(stale) || (await slot()).length === 0, 60_000, 'the stale slot dropped');
      expect(await slot()).toEqual([]);
      /* The copy's own slot stays: its machine names that attempt. */
      expect((await p.leader.admin.query('SELECT 1 FROM pg_replication_slots WHERE slot_name = $1', [p.maker.report()?.name])).rows).toHaveLength(1);
    } finally {
      await sql.close();
    }
  });

  it('loses a slot to the WAL limit', LONG, async () => {
    const name = p.maker.report()?.name;
    await p.leader.admin.query(`ALTER SYSTEM SET max_slot_wal_keep_size = '1MB'`);
    await p.leader.admin.query('SELECT pg_reload_conf()');
    await p.pause();
    try {
      /* The leader drops the silent copy from sync first, so its own writes go on. */
      await p.wait(async () => (await setting()) === '', 60_000, 'the copy dropped from sync');
      /* Well over the limit: five segments of the log, each closed with a change in it. */
      for (let n = 0; n < 5; n++) {
        await p.leader.admin.query(`SELECT pg_logical_emit_message(false, 'hornhoof-test', 'x')`);
        await p.leader.admin.query('SELECT pg_switch_wal()');
      }
      await p.leader.admin.query('CHECKPOINT');
      await p.wait(async () => (await p.leader.admin.query<{ status: string }>('SELECT wal_status AS status FROM pg_replication_slots WHERE slot_name = $1', [name])).rows[0]?.status === 'lost', 60_000, 'the slot lost');
    } finally {
      await p.resume();
    }
  });

  it('remakes after its slot is lost', LONG, async () => {
    const first = copyName(p.networkId, 1);
    const second = copyName(p.networkId, 2);
    await p.leader.admin.query('ALTER SYSTEM RESET max_slot_wal_keep_size');
    await p.leader.admin.query('SELECT pg_reload_conf()');
    /* The copy makes itself again beside the old database, the leader reads the old one by its ids, and the two change
       places. */
    await p.wait(() => p.maker.report()?.name === second && p.maker.report()?.state === 'ready' && p.maker.report()?.old === null && p.maker.mode() === 'read', 540_000, 'the copy made again and in place');
    await onCopy.end().catch(() => undefined);
    onCopy = await connected(p.copyUrl('hornhoof'));
    await caughtUp();
    const databases = (await onCopy.query<{ name: string }>(`SELECT datname AS name FROM pg_database WHERE datname LIKE 'hornhoof%' ORDER BY 1`)).rows.map(row => row.name);
    expect(databases).toEqual(['hornhoof']);
    expect((await onCopy.query<{ name: string }>('SELECT subname AS name FROM pg_subscription')).rows).toEqual([{ name: second }]);
    /* The leader drops the slot of the attempt that was given up: its machine names the next one now. */
    const sql = keeperSql(p.leader.url, { timeoutMs: 20_000 });
    try {
      await p.wait(async () => {
        await sweepSlots(sql, () => undefined, new Map(), 0);
        return (await p.leader.admin.query('SELECT 1 FROM pg_replication_slots WHERE slot_name = $1', [first])).rows.length === 0;
      }, 120_000, 'the old slot dropped');
    } finally {
      await sql.close();
    }
    expect((await p.leader.admin.query<{ active: boolean }>('SELECT active FROM pg_replication_slots WHERE slot_name = $1', [second])).rows).toEqual([{ active: true }]);
    expect(p.lines.filter(line => line.startsWith("This machine's copy is made again"))).toHaveLength(1);
  });
});
