import { loadConfig } from './config.js';
import { KEEPER_NAME, openDb } from './db/client.js';
import { Keeper } from './modules/keeper/keeper.js';

const config = loadConfig(process.env);
const db = config.databaseUrl ? openDb(config.databaseUrl, KEEPER_NAME, { statementTimeoutMs: 2000 }) : null;
const keeper = new Keeper({ config, db, app: { host: 'app', port: 8080 }, frontHost: 'front', log: line => console.log(line) });

await keeper.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void keeper.stop().then(() => process.exit(0)));
}
