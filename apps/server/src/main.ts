import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openAgentSql } from './db/agent-sql.js';
import { createDb } from './db/client.js';
import { setupLink } from './modules/setup/code.js';

function requireDbUrl(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL is not set.');
  return url;
}

const config = loadConfig(process.env);
const url = requireDbUrl(config.databaseUrl);
const db = await createDb(url);
const app = await buildApp({
  db,
  agentSql: await openAgentSql(url),
  config,
  logger: { level: process.env.LOG_LEVEL || 'info' },
});
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Hornhoof is running at ${config.publicUrl}`);
/* Until a company exists, only the link with the setup code sets it up. */
const link = await setupLink(db, config);
if (link) console.log(`Open this link to set Hornhoof up: ${link}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
