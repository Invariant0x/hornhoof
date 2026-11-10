/* The keeper of a machine. One that keeps the company's data holds the lease, the link and the peer link; a worker's
   reaches such a machine and serves the company on its own address. Each loads only its own modules, so a worker's
   never reads the company's settings, which it does not have. */
const log = (line: string): void => console.log(line);

type Running = { start(): Promise<unknown>; stop(): Promise<void> };

async function workerKeeper(): Promise<Running> {
  const { WorkerKeeper } = await import('./modules/keeper/worker.js');
  const { workerConfig } = await import('./modules/keeper/worker-config.js');
  return new WorkerKeeper({ config: workerConfig(process.env), frontHost: 'front', log });
}

async function dataKeeper(): Promise<Running> {
  const { loadConfig } = await import('./config.js');
  const { addressesIn } = await import('./modules/keeper/addresses.js');
  const { KEEPER_NAME, openDb } = await import('./db/client.js');
  const { publishedFrom } = await import('./modules/keeper/identity.js');
  const { Keeper } = await import('./modules/keeper/keeper.js');
  const { leaseOfMachine } = await import('./modules/keeper/lease-store.js');
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
  });
}

const keeper = await (process.env.HORNHOOF_ROLE === 'worker' ? workerKeeper() : dataKeeper());

await keeper.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void keeper.stop().then(() => process.exit(0)));
}
