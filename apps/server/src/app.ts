import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import { registerErrorHandling } from './errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { orgRoutes } from './modules/org/routes.js';
import { peopleRoutes } from './modules/people/routes.js';
import { setupRoutes } from './modules/setup/routes.js';
import { subscriptionRoutes } from './modules/subscriptions/routes.js';
import { hasWebApp, serveWebApp, webAppRoutes } from './web.js';

export type { Db } from './db/client.js';
import type { Db } from './db/client.js';

/* logger is off unless given: tests stay quiet, main.ts turns it on so errors reach the container log. */
export type Deps = { db: Db; config: Config; logger?: FastifyServerOptions['logger'] };

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, disableRequestLogging: true });
  const web = hasWebApp(deps.config.webDist);
  registerErrorHandling(app, web ? webAppRoutes : undefined);
  await app.register(cookie);
  if (web) await serveWebApp(app, deps.config.webDist);
  app.get('/api/health', async () => ({ ok: true }));
  setupRoutes(app, deps);
  authRoutes(app, deps);
  peopleRoutes(app, deps);
  orgRoutes(app, deps);
  subscriptionRoutes(app, deps);
  return app;
}
