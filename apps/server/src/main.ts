import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

function requireDbUrl(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL is not set.');
  return url;
}

const config = loadConfig(process.env);
const app = await buildApp({ db: await createDb(requireDbUrl(config.databaseUrl)), config });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Hornhoof is running at ${config.publicUrl}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
