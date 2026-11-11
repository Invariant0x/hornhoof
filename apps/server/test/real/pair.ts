import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDb } from '../../src/db/client.js';
import { PUBLIC_REVOKES } from '../../src/db/agent-sql.js';
import { APP_NAME, openDb } from '../../src/db/client.js';
import { CopyMaker, SCHEMA_DIR, SCHEMA_FILE } from '../../src/modules/keeper/copy.js';
import { LeaseHolder } from '../../src/modules/keeper/lease-holder.js';
import { keeperSql, leaseStore, type LeaseStore } from '../../src/modules/keeper/lease-store.js';
import { pgCatalog, SyncController } from '../../src/modules/keeper/sync.js';
import { fastWay } from '../../src/modules/merge/check.js';
import { peerSource } from '../../src/modules/merge/source.js';
import { Relay } from '../../src/modules/link/relay.js';
import { fakeRelay, type FakeRelay } from '../fake-relay.js';
import pg from 'pg';
import { ensurePublication, ensureReplica, REPLICA_ROLE, replicaPassword } from '../../src/modules/keeper/replica.js';
import { ENDLESS_LEASE } from '../prepare-environment.js';
import { poolOf, realCluster, run, type Platform, type RealCluster } from './pg.js';

export type Pair = {
  leader: RealCluster;
  copy: RealCluster;
  maker: CopyMaker;
  /* The password of the role the copy reads the leader with, and the id the copy's machine goes by. */
  password: string;
  networkId: string;
  /* The owner's way into a database of the copy by its name. */
  copyUrl(database: string): string;
  /* The updater's part for the request the maker left, when there is one: whether it loaded a schema. */
  playUpdater(): Promise<boolean>;
  /* Ticks, with the updater's part between them, until the copy says this or the time is up. */
  until(done: () => boolean | Promise<boolean>, ms?: number): Promise<void>;
  lines: string[];
  close(): Promise<void>;
};

const withDatabase = (url: string, database: string): string => {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.href;
};

/* Two Postgres servers on a Docker network of their own: a leader, migrated, with the role and the publication its
   keeper makes, and a machine that is to keep a copy, with the maker of that copy. The copy's database reaches the
   leader's by its name on that network, not through a keeper's door: the door's path is the lab's. */
export async function pair(opts: { leader?: Platform; copy?: Platform } = {}): Promise<Pair> {
  const tag = randomBytes(4).toString('hex');
  const network = `hh-pair-${tag}`;
  await run('docker', ['network', 'create', network]);
  const made: RealCluster[] = [];
  const folders = [mkdtempSync(join(tmpdir(), 'hh-pair-control-')), mkdtempSync(join(tmpdir(), 'hh-pair-keeper-'))] as const;
  const close = async (): Promise<void> => {
    await maker?.stop();
    for (const cluster of made) await cluster.close();
    await run('docker', ['network', 'rm', network]).catch(() => undefined);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  };
  let maker: CopyMaker | undefined;
  try {
    const leader = await realCluster({ network, name: `hh-pair-${tag}-leader`, platform: opts.leader });
    made.push(leader);
    const copy = await realCluster({ network, name: `hh-pair-${tag}-copy`, platform: opts.copy });
    made.push(copy);
    await migrateDb(leader.url);
    await leader.admin.query(ENDLESS_LEASE);
    const password = replicaPassword(randomBytes(32));
    await ensureReplica(() => keeperSql(leader.url, { timeoutMs: 20_000 }), password);
    const sql = keeperSql(leader.url, { timeoutMs: 20_000 });
    await ensurePublication(sql);
    await sql.close();
    const [controlDir, dir] = folders;
    const networkId = randomBytes(32).toString('hex');
    const lines: string[] = [];
    const copyUrl = (database: string) => withDatabase(copy.url, database);
    maker = new CopyMaker({
      admin: keeperSql(copyUrl('postgres'), { timeoutMs: 20_000 }),
      db: database => keeperSql(copyUrl(database), { timeoutMs: 20_000 }),
      controlDir, dir, networkId, password,
      diskFree: () => 100 * 2 ** 30,
      log: line => lines.push(line),
      publisher: { host: leader.host, port: 5432 },
    });
    /* What updater.sh does for schema.json, by the same commands, in the copy's own container. */
    const playUpdater = async (): Promise<boolean> => {
      const request = join(controlDir, SCHEMA_FILE);
      if (!existsSync(request)) return false;
      const asked = JSON.parse(readFileSync(request, 'utf8')) as { attempt: number; database: string; port: number; password: string };
      const dump = (flags: string[]) => copy.exec(['pg_dump', '-h', leader.host, '-p', '5432', '-U', REPLICA_ROLE, ...flags, 'hornhoof'], { env: { PGPASSWORD: asked.password }, pass: ['PGPASSWORD'] });
      const schema = (await dump(['--schema-only', '--no-owner', '--no-publications', '--no-subscriptions', '--no-privileges'])) + (await dump(['--data-only', '--table=drizzle.__drizzle_migrations']));
      await copy.exec(['psql', '-U', 'hornhoof', '-1', '-v', 'ON_ERROR_STOP=1', '-d', asked.database], { stdin: schema });
      await copy.exec(['sh', '-c', 'umask 077 && cat > "$PGDATA/replica.pgpass"'], { stdin: `*:*:*:${REPLICA_ROLE}:${asked.password}\n` });
      mkdirSync(join(controlDir, SCHEMA_DIR), { recursive: true });
      writeFileSync(join(controlDir, SCHEMA_DIR, `${asked.attempt}.done`), '');
      rmSync(request);
      return true;
    };
    const made0 = maker;
    const until = async (done: () => boolean | Promise<boolean>, ms = 120_000): Promise<void> => {
      const end = Date.now() + ms;
      for (;;) {
        await made0.tick({ slot: 'ok', leaderSize: 50 * 2 ** 20, migrations: null, old: null, upload: null });
        await playUpdater();
        if (await done()) return;
        if (Date.now() > end) throw new Error(`The copy did not get there in time. It says ${JSON.stringify(made0.report())}, and its keeper said: ${lines.join(' | ') || 'nothing'}`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    };
    return { leader, copy, maker, password, networkId, copyUrl, playUpdater, until, lines, close };
  } catch (err) {
    await close();
    throw err;
  }
}

const LINK = { name: 'acme', key: 'k'.repeat(32), client: 'acme-ab12cd34-link' };

export type SyncedPair = Pair & {
  relay: FakeRelay;
  controller: SyncController;
  holder: LeaseHolder;
  lease: LeaseStore;
  /* The row of the copy's machine on the leader. */
  machine: string;
  /* What the relay holds of which machine has the latest changes. */
  record(): { state: 'on' | 'off'; copy: string | null; epoch: number } | null;
  /* A connection to the leader as the app makes its own: fenced, so each of its commits stands on the lease, and ended
     when the lease ends. */
  app(): Promise<pg.Client>;
  /* Whether the copy's own keeper goes on: its maker, which also enables a subscription that stopped. */
  keeping(on: boolean): void;
  /* The copy's whole server stands still, and goes on. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /* The leader's checkpointer stands still, and goes on. */
  holdCheckpointer(): Promise<void>;
  releaseCheckpointer(): Promise<void>;
  /* Waits for what a test names, while the keeper's loops run by themselves. */
  wait(done: () => boolean | Promise<boolean>, ms?: number, what?: string): Promise<void>;
};

/* A pair with what the keeper of the leader runs beside it: the lease it holds under the flag of its sync controller,
   the controller with the leader's real catalog and a relay of the test's, and the copy's maker, each on its own
   pace, until the pair is closed. The copy's machine has its row on the leader, kept as its keeper's reports keep it. */
export async function syncedPair(opts: { leader?: Platform; copy?: Platform } = {}): Promise<SyncedPair> {
  const p = await pair(opts);
  const relay = await fakeRelay({ keep: true });
  const timers: NodeJS.Timeout[] = [];
  const sessions: { close(): Promise<void> }[] = [];
  const apps: pg.Client[] = [];
  const close = async (): Promise<void> => {
    for (const timer of timers) clearInterval(timer);
    await controller?.stop();
    for (const app of apps) await app.end().catch(() => undefined);
    for (const session of sessions) await session.close().catch(() => undefined);
    await relay.close();
    await p.close();
  };
  let controller: SyncController | undefined;
  try {
    relay.bindings.set(LINK.name, { key: LINK.key });
    relay.register(LINK.name, LINK.client);
    /* The company, a person who sees it whole, and that person's machine, which keeps the copy. */
    await p.leader.admin.query(`INSERT INTO companies (name) VALUES ('Acme')`);
    const person = await p.leader.admin.query<{ id: string }>(`INSERT INTO people (company_id, name, email, status, scope_kind, is_owner) SELECT id, 'Ivan', 'ivan@acme.test', 'active', 'company', true FROM companies RETURNING id`);
    const machine = (
      await p.leader.admin.query<{ id: string }>(
        `INSERT INTO machines (company_id, person_id, machine_key, hostname, role, network_id, server_order) SELECT id, $1, 'copy-machine', 'copy', 'data', $2, 2 FROM companies RETURNING id`,
        [person.rows[0]!.id, p.networkId],
      )
    ).rows[0]!.id;
    /* What the app takes from everyone as it starts, which the keeper's look at the fences asks for. */
    await p.leader.admin.query(PUBLIC_REVOKES);
    /* From here on the lease is the keeper's own, taken under the controller's flag: the fixture's endless one goes. */
    await p.leader.admin.query('DELETE FROM net_local.lease; DELETE FROM net_local.state');
    const leaderId = 'a1b2c3d4'.repeat(8);
    const fast = keeperSql(p.leader.url);
    const slow = keeperSql(p.leader.url, { timeoutMs: 120_000 });
    const leaseSql = keeperSql(p.leader.url);
    sessions.push(fast, slow, leaseSql);
    const lease = leaseStore(leaseSql, { machineId: leaderId });
    let holder: LeaseHolder | undefined;
    controller = new SyncController({
      catalog: pgCatalog(fast, slow, leaderId),
      relay: new Relay(relay.url),
      link: async () => LINK,
      /* The copy's database reaches the leader's without a keeper's door here, so no bytes are counted for it. */
      dbBytes: () => 0,
      leads: () => holder?.mode() === 'lead',
      log: line => p.lines.push(line),
    });
    holder = new LeaseHolder({ lease, updaterBusy: () => false, sync: controller, log: line => p.lines.push(line) });
    const made = controller;
    const held = holder;
    await held.guard();
    await made.start();
    await held.tick();
    await held.look();
    let ticking = false;
    timers.push(
      setInterval(() => {
        if (ticking) return;
        ticking = true;
        void held
          .guard()
          .then(() => held.tick())
          .then(() => held.look())
          .finally(() => (ticking = false));
      }, 1000),
    );
    /* The leader's part for a copy that was made again: its old database, read as the role that only reads, is merged
       by its ids when it never wrote. The copy's own port on this computer stands in for the keeper's door. */
    const leaderDb = openDb(p.leader.url, 'hornhoof-pair-merge');
    sessions.push({ close: () => poolOf(leaderDb).end() });
    const copyPort = Number(new URL(p.copy.url).port);
    let oldMerged: number | null = null;
    const oldOf = async (attempt: number | undefined): Promise<'waiting' | 'merged' | null> => {
      if (attempt === undefined) return null;
      if (oldMerged === attempt) return 'merged';
      const source = await peerSource(copyPort, p.password, "the copy's old database", '127.0.0.1');
      try {
        if ((await fastWay(leaderDb, source)).way === 'fast') oldMerged = attempt;
      } finally {
        await source.close();
      }
      return oldMerged === attempt ? 'merged' : 'waiting';
    };
    /* The copy's keeper: its maker, the updater's part, and its report into the machine's row on the leader. */
    let making = false;
    let keeps = true;
    const said = { text: '' };
    timers.push(
      setInterval(() => {
        if (making || !keeps) return;
        making = true;
        void (async () => {
          const slot = await p.leader.admin.query<{ status: string | null }>('SELECT wal_status AS status FROM pg_replication_slots WHERE slot_name = $1', [p.maker.report().name]);
          const lost = slot.rows[0]?.status === 'lost';
          const old = await oldOf(p.maker.report().old?.attempt);
          await p.maker.tick({ slot: lost ? 'lost' : slot.rows.length ? 'ok' : 'missing', leaderSize: 50 * 2 ** 20, migrations: null, old, upload: null });
          await p.playUpdater();
          const report = p.maker.report();
          const text = JSON.stringify(report);
          if (text === said.text) return;
          said.text = text;
          await p.leader.admin.query('UPDATE machines SET copy_state = $2, copy_name = $3, copy_at = $4, copy_progress = $5, copy_error = $6 WHERE id = $1', [machine, report.state, report.name, report.at, report.progress, report.error]);
        })()
          .catch((err: Error) => void p.lines.push(`The test's keeper of the copy failed: ${err.message}`))
          .finally(() => (making = false));
      }, 250),
    );
    const wait = async (done: () => boolean | Promise<boolean>, ms = 120_000, what = 'what the test waits for'): Promise<void> => {
      const end = Date.now() + ms;
      while (!(await done())) {
        if (Date.now() > end) throw new Error(`Did not see ${what} in time. The copy says ${JSON.stringify(p.maker.report())}; the relay holds ${JSON.stringify(relay.syncs.get(LINK.name) ?? null)}; the flag is ${String(made.flag())}; said: ${p.lines.join(' | ') || 'nothing'}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    const app = async (): Promise<pg.Client> => {
      const client = new pg.Client({ connectionString: p.leader.url, application_name: APP_NAME, options: '-c hornhoof.fenced=on' });
      client.on('error', () => undefined);
      await client.connect();
      apps.push(client);
      return client;
    };
    const checkpointer = async (signal: string): Promise<void> => {
      const pid = (await p.leader.admin.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE backend_type = 'checkpointer'`)).rows[0]!.pid;
      await p.leader.exec(['kill', signal, String(pid)]);
    };
    /* The lease is taken once the relay stored that this machine alone holds the latest changes; a term that is taken
       ends the app's sessions, so none is opened before. */
    await wait(() => held.mode() === 'lead', 120_000, 'the leader leading');
    return {
      ...p, close, relay, controller: made, holder: held, lease, machine, wait, app,
      keeping: on => void (keeps = on),
      record: () => relay.syncs.get(LINK.name) ?? null,
      pause: async () => void (await run('docker', ['pause', p.copy.host])),
      resume: async () => void (await run('docker', ['unpause', p.copy.host])),
      holdCheckpointer: () => checkpointer('-STOP'),
      releaseCheckpointer: () => checkpointer('-CONT'),
    };
  } catch (err) {
    await close();
    throw err;
  }
}
