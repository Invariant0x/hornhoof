import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openAgentSql } from './db/agent-sql.js';
import { APP_NAME, openDb } from './db/client.js';
import { publicUrl } from './modules/link/link.js';
import { setupLink } from './modules/setup/code.js';
import { LINK_TLS_PORT, LinkListener } from './modules/tls/listener.js';

function requireDbUrl(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL is not set.');
  return url;
}

const config = loadConfig(process.env);
const url = requireDbUrl(config.databaseUrl);
const db = openDb(url, APP_NAME);
const app = await buildApp({
  db,
  agentSql: await openAgentSql(url),
  config,
  logger: { level: process.env.LOG_LEVEL || 'info' },
});
await app.listen({ port: config.port, host: '0.0.0.0' });
const listener = new LinkListener({ app, config, log: app.log });
await listener.listen(LINK_TLS_PORT);
await app.ctx.tls.serveOn(listener);
/* A machine that only reads must not order or renew a certificate, so the manager's timers run only while the app leads. */
app.ctx.mode.whenLead(() => app.ctx.tls.start(), () => app.ctx.tls.stop());
console.log(`Hornhoof is running at ${await publicUrl(db, config)}`);
/* Until a company exists, only the link with the setup code sets it up. */
const link = await setupLink(db, config);
if (link) console.log(`Open this link to set Hornhoof up: ${link}`);

/* The listener stops taking connections first; the app's close then ends the event streams and WebSockets on those it
   already has, which lets the listener finish. */
async function stop(): Promise<void> {
  const closing = listener.close();
  await app.close();
  await closing;
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void stop());
}
