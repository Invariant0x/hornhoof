import { loadConfig } from './config.js';
import { KEEPER_NAME, openDb } from './db/client.js';
import { Keeper } from './modules/keeper/keeper.js';
import { keeperSql, leaseStore, type LeaseStore } from './modules/keeper/lease-store.js';

const config = loadConfig(process.env);
const db = config.databaseUrl ? openDb(config.databaseUrl, KEEPER_NAME, { statementTimeoutMs: 2000 }) : null;

/* The lease is held in this machine's name, in this machine's database: without either there is none to hold. */
function leaseOf(): LeaseStore | null {
  if (!config.databaseUrl) return (console.log('The keeper takes no lease: DATABASE_URL is not set.'), null);
  if (!config.machineId) return (console.log('The keeper takes no lease: HORNHOOF_MACHINE_ID is not set. Run the install command again.'), null);
  return leaseStore(keeperSql(config.databaseUrl), { machineId: config.machineId });
}

const keeper = new Keeper({ config, db, app: { host: 'app', port: 8080 }, frontHost: 'front', log: line => console.log(line), lease: leaseOf() });

await keeper.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void keeper.stop().then(() => process.exit(0)));
}
