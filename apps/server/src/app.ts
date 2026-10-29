import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import { registerErrorHandling } from './errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { NodeHub } from './modules/nodes/hub.js';
import { handleNodeClose, handleNodeMessage } from './modules/nodes/messages.js';
import { nodeRoutes } from './modules/nodes/routes.js';
import { nodeSocket, SOCKET_OPTIONS } from './modules/nodes/socket.js';
import { orgRoutes } from './modules/org/routes.js';
import { peopleRoutes } from './modules/people/routes.js';
import { setupRoutes } from './modules/setup/routes.js';
import { subscriptionRoutes } from './modules/subscriptions/routes.js';
import { hasWebApp, serveWebApp, webAppRoutes } from './web.js';

export type { Db } from './db/client.js';
import type { Db } from './db/client.js';

/* logger is off unless given: tests stay quiet, main.ts turns it on so errors reach the container log. */
export type Deps = { db: Db; config: Config; logger?: FastifyServerOptions['logger'] };

/* What routes get: the deps plus the live node connections. */
export type Ctx = Deps & { hub: NodeHub };

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, disableRequestLogging: true });
  const web = hasWebApp(deps.config.webDist);
  registerErrorHandling(app, web ? webAppRoutes : undefined);
  const ctx = { ...deps } as Ctx;
  ctx.hub = new NodeHub({
    pingMs: deps.config.nodePingMs,
    onMessage: (id, msg) => handleNodeMessage(ctx, id, msg),
    onClose: id => handleNodeClose(ctx, id),
    onError: err => app.log.error(err),
  });
  app.addHook('onClose', async () => ctx.hub.stop());
  await app.register(cookie);
  await app.register(websocket, SOCKET_OPTIONS);
  if (web) await serveWebApp(app, deps.config.webDist);
  app.get('/api/health', async () => ({ ok: true }));
  setupRoutes(app, deps);
  authRoutes(app, deps);
  peopleRoutes(app, ctx);
  orgRoutes(app, ctx);
  subscriptionRoutes(app, ctx);
  nodeRoutes(app, ctx);
  nodeSocket(app, ctx);
  jobRoutes(app, ctx);
  return app;
}
