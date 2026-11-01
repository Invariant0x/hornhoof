import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openAgentSql } from './db/agent-sql.js';
import { createDb } from './db/client.js';

function requireDbUrl(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL is not set.');
  return url;
}

const config = loadConfig(process.env);
const url = requireDbUrl(config.databaseUrl);
const app = await buildApp({
  db: await createDb(url),
  agentSql: await openAgentSql(url),
  config,
  logger: { level: process.env.LOG_LEVEL || 'info' },
});
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Hornhoof is running at ${config.publicUrl}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
