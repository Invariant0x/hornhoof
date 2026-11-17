import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openAgentSql } from './db/agent-sql.js';
import { APP_NAME, openDb } from './db/client.js';
import { loggable } from './errors.js';
import { migrateWhenAlone } from './migrate.js';
import { agentSqlFollowsMode } from './modules/keeper/app-mode.js';
import { KeeperServed } from './modules/keeper/served.js';
import { publicUrl } from './modules/link/link.js';
import { setupLink } from './modules/setup/code.js';
import { serverLog } from './modules/tools/logs.js';

function requireDbUrl(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL is not set.');
  return url;
}

const config = loadConfig(process.env);
const url = requireDbUrl(config.databaseUrl);
await migrateWhenAlone(config, url);
const db = openDb(url, APP_NAME, { fenced: config.keeper });
/* Where a keeper runs, the database may be empty when the app starts, as on a machine whose copy is still being made:
   the agents' roles get their rights, and the app says where it runs, once the keeper's word takes it out of off. */
const app = await buildApp({
  db,
  agentSql: config.keeper ? null : await openAgentSql(url),
  config,
  logger: { level: process.env.LOG_LEVEL || 'info', stream: serverLog },
});
const sayRunning = async (): Promise<void> => console.log(`Hornhoof is running at ${await publicUrl(db, config)}`);
if (config.keeper) {
  agentSqlFollowsMode({ mode: app.ctx.mode, holder: app.ctx, open: () => openAgentSql(url) });
  let said = false;
  app.ctx.mode.onChange(async from => {
    if (from !== 'off' || said) return;
    said = true;
    await sayRunning();
  });
}
await app.listen({ port: config.port, host: '0.0.0.0' });
/* The keeper ends the link's TLS, so without one nothing could serve a certificate and none is ordered. A machine that only
   reads must not order or renew one, so the manager's timers run only while the app leads. */
if (config.keeper) {
  void app.ctx.tls.serveOn(new KeeperServed({ dir: config.controlDir })).catch((err: unknown) => {
    app.log.warn({ error: loggable(err) }, "Could not ask the keeper about the link's certificate.");
  });
  app.ctx.mode.whenLead(() => app.ctx.tls.start(), () => app.ctx.tls.stop());
}
if (!config.keeper) await sayRunning();

/* Until a company exists, only the link with the setup code sets it up. Said once, on the first way into lead, since a
   server that does not lead yet may have a database still on its way there. */
let setupLinkSaid = false;
app.ctx.mode.whenLead(async () => {
  if (setupLinkSaid) return;
  setupLinkSaid = true;
  const link = await setupLink(db, config);
  if (link) console.log(`Open this link to set Hornhoof up: ${link}`);
}, () => undefined);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
