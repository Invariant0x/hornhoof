/* The keeper of a machine. One that keeps the company's data and leads holds the lease, the link and the peer link; one
   that keeps a copy follows the leader and makes this machine's copy; a worker's reaches such a machine and serves the
   company on its own address. Each loads only its own modules, so a worker's never reads the company's settings, which
   it does not have. */
const log = (line: string): void => console.log(line);

type Running = { start(): Promise<unknown>; stop(): Promise<void> };

/* A keeper whose kind must change ends itself: its listeners close, the process ends with 0, and compose starts it
   again, as the kind its folders say then. */
let running: Running | null = null;
const exit = (): void => void (running?.stop() ?? Promise.resolve()).catch(() => undefined).then(() => process.exit(0));

async function workerKeeper(): Promise<Running> {
  const { WorkerKeeper } = await import('./modules/keeper/worker.js');
  const { workerConfig } = await import('./modules/keeper/worker-config.js');
  const { InternetMeasures } = await import('./modules/keeper/internet.js');
  const config = workerConfig(process.env, log);
  return new WorkerKeeper({ config, frontHost: 'front', log, internet: new InternetMeasures({ dir: config.dir, log }) });
}

async function dataKeeper(): Promise<Running> {
  const { loadConfig } = await import('./config.js');
  const { addressesIn } = await import('./modules/keeper/addresses.js');
  const { KEEPER_NAME, openDb } = await import('./db/client.js');
  const { publishedFrom } = await import('./modules/keeper/identity.js');
  const { Keeper } = await import('./modules/keeper/keeper.js');
  const { keeperSql, leaseOfMachine } = await import('./modules/keeper/lease-store.js');
  const { replicaPassword } = await import('./modules/keeper/replica.js');
  const { pgCatalog } = await import('./modules/keeper/sync.js');
  const { Relay } = await import('./modules/link/relay.js');
  const { statfsSync } = await import('node:fs');
  const { KEEPER_DIR } = await import('./modules/keeper/machine-keys.js');
  const { InternetMeasures } = await import('./modules/keeper/internet.js');
  const { commitProbe, Measures, PROBE_TIMEOUT_MS } = await import('./modules/keeper/measures.js');
  const { queryTimeoutMs } = await import('./modules/keeper/lease.js');
  const { pgSubscription, probeLink, Promoter } = await import('./modules/keeper/taking.js');
  const { othersFinished } = await import('./modules/keeper/proofs.js');
  const { termOf } = await import('./modules/keeper/promote.js');
  const { followFromHere } = await import('./modules/keeper/seed-view.js');
  const { Hander } = await import('./modules/keeper/handing.js');
  const { LeadUpdate } = await import('./modules/keeper/lead-update.js');
  const config = loadConfig(process.env);
  const db = config.databaseUrl ? openDb(config.databaseUrl, KEEPER_NAME, { statementTimeoutMs: 2000 }) : null;
  /* What the keeper measures of this machine, its disk's fsync p99 among it: what it reports, and what the keeper's
     own statements on the lease and the copies may take. The disk is the database's, timed by a commit on a session of
     its own; what it times while a backup keeps the disk busy is left out of the report, not out of the lease's view. */
  let keeper: { backupsBusy(): boolean } | null = null;
  const measures = new Measures({
    dir: KEEPER_DIR, filesDir: config.filesDir, internet: new InternetMeasures({ dir: KEEPER_DIR, log }),
    busy: () => keeper?.backupsBusy() ?? false,
    ...(config.databaseUrl ? { probe: commitProbe(keeperSql(config.databaseUrl, { timeoutMs: PROBE_TIMEOUT_MS })) } : {}),
  });
  const paced = (url: string) => keeperSql(url, { timeoutMs: () => queryTimeoutMs(measures.leaseFsyncP99()) });
  /* Where this machine's database listens, for the peers that keep data too. */
  const dbTarget = (): { host: string; port: number } | null => {
    if (!config.databaseUrl) return null;
    const { hostname, port } = new URL(config.databaseUrl);
    return { host: hostname, port: Number(port) || 5432 };
  };
  /* What the keeper keeps its copies in step with: its own Postgres, on a session whose commits wait for no copy and
     on one with patience for a checkpoint, and the relay. The free room of the keeper's own folder stands for the
     database's, which lies on the same disk. */
  const slow = config.databaseUrl ? keeperSql(config.databaseUrl, { timeoutMs: 120_000 }) : null;
  const diskFree = (): number | null => {
    try {
      const { bavail, bsize } = statfsSync(KEEPER_DIR);
      return bavail * bsize;
    } catch {
      return null;
    }
  };
  const sync =
    config.databaseUrl && config.machineId && slow
      ? { catalog: pgCatalog(paced(config.databaseUrl), slow, config.machineId), relay: new Relay(config.relayUrl), slots: { sql: slow, diskFree } }
      : undefined;
  return (keeper = new Keeper({
    config, db, app: { host: 'app', port: 8080 }, frontHost: 'front', log, lease: leaseOfMachine(config, log, paced),
    published: publishedFrom(process.env), dbTarget: dbTarget(), addresses: addressesIn(process.env), hostname: process.env.HORNHOOF_HOSTNAME || null,
    /* The role copies read this machine's database with, made on a connection of its own each time. */
    copies: { replica: config.databaseUrl ? { connect: () => keeperSql(config.databaseUrl!, { timeoutMs: 20_000 }), password: replicaPassword(config.secret) } : null },
    sync,
    measures,
    /* What its lease goes by once another machine holds a copy that finished: an answer of its own at the company's
       link or its copy's word each second, and its copy's promise or the relay's window to lead again. */
    proofs:
      config.databaseUrl && config.machineId
        ? (() => {
            const sql = keeperSql(config.databaseUrl!, { timeoutMs: 5000 });
            const relay = new Relay(config.relayUrl);
            return {
              needed: () => othersFinished(sql, config.machineId!),
              probe: async (nonce: string, link: { url: string } | null) => {
                const base = process.env.HORNHOOF_LINK_PROBE || link?.url;
                return base ? probeLink(base, nonce) : null;
              },
              ownTerm: async () => {
                const term = await termOf(sql);
                return term ? { number: term.number, machine: term.machine, split: term.split } : null;
              },
              poll: async (link: { name: string; key: string }) => {
                const sent = { wall: Date.now(), mono: performance.now() };
                const [route, health] = await Promise.all([relay.route(link.name, link.key, 2000), relay.health(2000)]);
                return { sent, replied: performance.now(), route, health: { up: health.up, relayStarted: health.relayStarted } };
              },
              follow: async () => {
                await followFromHere({ dir: KEEPER_DIR, controlDir: config.controlDir, sql, machineId: config.machineId!, secret: config.secret });
                exit();
              },
            };
          })()
        : undefined,
    /* Its part of a planned switch of the server to this machine: with nothing written down of one it leads at once,
       and tells an old leader that comes back late which machine leads now. */
    taking:
      config.databaseUrl && config.machineId
        ? parts => {
            const sql = keeperSql(config.databaseUrl!, { timeoutMs: 20_000 });
            const relay = new Relay(config.relayUrl);
            /* The one subscription this database follows the old leader with. */
            const subscribed = async (): Promise<string | null> =>
              (await sql.query<{ name: string }>('SELECT s.subname::text AS name FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() ORDER BY 1 LIMIT 1')).rows[0]?.name ?? null;
            return new Promoter({
              dir: KEEPER_DIR, controlDir: config.controlDir, sql, machine: { networkId: config.machineId! },
              registered: async () => {
                const link = parts.link();
                if (!link) return false;
                const route = await relay.route(link.name, link.key);
                return route.known && route.state === 'held' && route.client === link.client;
              },
              /* A keeper that took over by itself goes by the name's generation too. */
              name: async () => {
                const link = parts.link();
                if (!link) return null;
                const route = await relay.route(link.name, link.key);
                return route.known ? { state: route.state, mine: route.client === link.client, generation: route.generation } : null;
              },
              probe: async nonce => {
                const base = process.env.HORNHOOF_LINK_PROBE || parts.link()?.url;
                return base ? probeLink(base, nonce) : null;
              },
              tunnel: parts.tunnel, subscription: pgSubscription(sql, subscribed), appLeads: parts.appLeads, exit, log,
            });
          }
        : undefined,
    /* Its part of an update while other machines keep copies: they promise to wait, and the dump is taken once they
       hold every change. */
    updating:
      config.databaseUrl && config.machineId && sync
        ? parts => {
            if (!parts.sync) return { start: async () => undefined, stop: async () => undefined, busy: () => false };
            return new LeadUpdate({
              dir: KEEPER_DIR, controlDir: config.controlDir, sql: keeperSql(config.databaseUrl!, { timeoutMs: 20_000 }),
              sync: parts.sync, peer: parts.peer, hostname: parts.hostname, leads: parts.leads, maintenance: parts.maintenance, log,
            });
          }
        : undefined,
    /* Its part of a planned switch of the server away from this machine, where copies may follow it. */
    handing:
      config.databaseUrl && config.machineId && sync
        ? parts => {
            if (!parts.sync) return { start: async () => undefined, stop: async () => undefined, holds: () => false };
            return new Hander({
              dir: KEEPER_DIR, controlDir: config.controlDir, sql: keeperSql(config.databaseUrl!, { timeoutMs: 20_000 }), secret: config.secret, machine: { networkId: config.machineId! },
              lease: parts.lease, term: parts.term, sync: parts.sync, peer: parts.peer, front: parts.front, tunnel: parts.tunnel, leads: parts.leads, updating: parts.updating,
              exit, log,
            });
          }
        : undefined,
  }));
}

/* A machine that keeps a copy of the company's data and does not lead: it holds the company's secret and a database of
   its own, which follows the leader's. */
async function followKeeper(): Promise<Running> {
  const { loadConfig } = await import('./config.js');
  const { KEEPER_NAME, openDb } = await import('./db/client.js');
  const { FollowKeeper } = await import('./modules/keeper/follow.js');
  const { followConfig } = await import('./modules/keeper/follow-config.js');
  const { keeperSql } = await import('./modules/keeper/lease-store.js');
  const { tunnelSettings } = await import('./modules/link/link.js');
  const { InternetMeasures } = await import('./modules/keeper/internet.js');
  const { Relay } = await import('./modules/link/relay.js');
  const { probeLink } = await import('./modules/keeper/taking.js');
  const { bundleSecrets } = await import('./modules/keeper/keeper.js');
  const { commitProbe, PROBE_TIMEOUT_MS } = await import('./modules/keeper/measures.js');
  const config = followConfig(process.env, log);
  const whole = loadConfig(process.env);
  const db = openDb(config.databaseUrl, KEEPER_NAME, { statementTimeoutMs: 2000 });
  const { hostname, port } = new URL(config.databaseUrl);
  /* The same server and the same owner, on the database named. */
  const urlOf = (database: string): string => {
    const url = new URL(config.databaseUrl);
    url.pathname = `/${database}`;
    return url.href;
  };
  return new FollowKeeper({
    config, frontHost: 'front', app: { host: 'app', port: 8080 }, db: { host: hostname, port: Number(port) || 5432 }, log,
    sql: database => keeperSql(urlOf(database), { timeoutMs: 20_000 }),
    /* While the copy is being made its database has no link to read yet. */
    settings: () => tunnelSettings(db, whole).catch(() => undefined),
    /* Its disk is its database's, timed by a commit on a session of its own. */
    worker: { internet: new InternetMeasures({ dir: config.dir, log }), probe: commitProbe(keeperSql(config.databaseUrl, { timeoutMs: PROBE_TIMEOUT_MS })) },
    /* What its watch over the leader asks: hornhoof.org of the company's name, and the company's link of who answers there. */
    relay: new Relay(whole.relayUrl),
    probe: (nonce, url) => probeLink(process.env.HORNHOOF_LINK_PROBE || url, nonce),
    /* What a database of this machine that led is sealed with, when it has one to save. */
    secrets: () => bundleSecrets(whole),
    exit,
  });
}

/* Whether this machine's database follows another one now: the keeper of such a machine follows, and never leads. */
async function followsAnother(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const { keeperSql } = await import('./modules/keeper/lease-store.js');
  const { ENABLED_SUBSCRIPTION } = await import('./modules/keeper/role.js');
  const sql = keeperSql(process.env.DATABASE_URL, { timeoutMs: 5000 });
  try {
    return (await sql.query<{ follows: boolean }>(ENABLED_SUBSCRIPTION)).rows[0]?.follows === true;
  } finally {
    await sql.close().catch(() => undefined);
  }
}

async function dataOrFollowKeeper(): Promise<Running> {
  const { keeperRole } = await import('./modules/keeper/role.js');
  const { KEEPER_DIR } = await import('./modules/keeper/machine-keys.js');
  const role = await keeperRole(process.env, process.env.HORNHOOF_CONTROL_DIR || '/control', KEEPER_DIR, followsAnother);
  /* One that takes the server over, or hands it over, is a leading keeper that goes on from what it wrote down. */
  return role === 'follow' ? followKeeper() : dataKeeper();
}

const keeper = await (process.env.HORNHOOF_ROLE === 'worker' ? workerKeeper() : dataOrFollowKeeper());
running = keeper;

await keeper.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void keeper.stop().then(() => process.exit(0)));
}
