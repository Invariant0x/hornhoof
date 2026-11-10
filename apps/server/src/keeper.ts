import { loadConfig } from './config.js';
import { KEEPER_NAME, openDb } from './db/client.js';
import { publishedFrom } from './modules/keeper/identity.js';
import { Keeper } from './modules/keeper/keeper.js';
import { leaseOfMachine } from './modules/keeper/lease-store.js';

const config = loadConfig(process.env);
const db = config.databaseUrl ? openDb(config.databaseUrl, KEEPER_NAME, { statementTimeoutMs: 2000 }) : null;

/* Where this machine's database listens, for the peers that keep data too. */
function dbTargetOf(): { host: string; port: number } | null {
  if (!config.databaseUrl) return null;
  const { hostname, port } = new URL(config.databaseUrl);
  return { host: hostname, port: Number(port) || 5432 };
}

const keeper = new Keeper({ config, db, app: { host: 'app', port: 8080 }, frontHost: 'front', log: line => console.log(line), lease: leaseOfMachine(config, line => console.log(line)), published: publishedFrom(process.env), dbTarget: dbTargetOf() });

await keeper.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void keeper.stop().then(() => process.exit(0)));
}
