/* The keeper of a machine. One that keeps the company's data and leads holds the lease, the link and the peer link; one
   that keeps a copy follows the leader and makes this machine's copy; a worker's reaches such a machine and serves the
   company on its own address. Each loads only its own modules, so a worker's never reads the company's settings, which
   it does not have. */
const log = (line: string): void => console.log(line);

type Running = { start(): Promise<unknown>; stop(): Promise<void> };

async function workerKeeper(): Promise<Running> {
  const { WorkerKeeper } = await import('./modules/keeper/worker.js');
  const { workerConfig } = await import('./modules/keeper/worker-config.js');
  return new WorkerKeeper({ config: workerConfig(process.env, log), frontHost: 'front', log });
}

async function dataKeeper(): Promise<Running> {
  const { loadConfig } = await import('./config.js');
  const { addressesIn } = await import('./modules/keeper/addresses.js');
  const { KEEPER_NAME, openDb } = await import('./db/client.js');
  const { publishedFrom } = await import('./modules/keeper/identity.js');
  const { Keeper } = await import('./modules/keeper/keeper.js');
  const { keeperSql, leaseOfMachine } = await import('./modules/keeper/lease-store.js');
  const { replicaPassword } = await import('./modules/keeper/replica.js');
  const config = loadConfig(process.env);
  const db = config.databaseUrl ? openDb(config.databaseUrl, KEEPER_NAME, { statementTimeoutMs: 2000 }) : null;
  /* Where this machine's database listens, for the peers that keep data too. */
  const dbTarget = (): { host: string; port: number } | null => {
    if (!config.databaseUrl) return null;
    const { hostname, port } = new URL(config.databaseUrl);
    return { host: hostname, port: Number(port) || 5432 };
  };
  return new Keeper({
    config, db, app: { host: 'app', port: 8080 }, frontHost: 'front', log, lease: leaseOfMachine(config, log),
    published: publishedFrom(process.env), dbTarget: dbTarget(), addresses: addressesIn(process.env), hostname: process.env.HORNHOOF_HOSTNAME || null,
    /* The role copies read this machine's database with, made on a connection of its own each time. */
    copies: { replica: config.databaseUrl ? { connect: () => keeperSql(config.databaseUrl!, { timeoutMs: 20_000 }), password: replicaPassword(config.secret) } : null },
  });
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
  const role = await keeperRole(process.env, process.env.HORNHOOF_CONTROL_DIR || '/control', followsAnother);
  return role === 'follow' ? followKeeper() : dataKeeper();
}

const keeper = await (process.env.HORNHOOF_ROLE === 'worker' ? workerKeeper() : dataOrFollowKeeper());

await keeper.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void keeper.stop().then(() => process.exit(0)));
}
