import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import { registerErrorHandling } from './errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { conversationRoutes } from './modules/conversation/routes.js';
import { departmentRoutes } from './modules/departments/routes.js';
import { EventBus } from './modules/events/bus.js';
import { streamRoutes } from './modules/events/stream.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { NodeHub } from './modules/nodes/hub.js';
import { handleNodeClose, handleNodeMessage } from './modules/nodes/messages.js';
import { nodeRoutes } from './modules/nodes/routes.js';
import { nodeSocket, SOCKET_OPTIONS } from './modules/nodes/socket.js';
import { orgRoutes } from './modules/org/routes.js';
import { peopleRoutes } from './modules/people/routes.js';
import { setupRoutes } from './modules/setup/routes.js';
import { subscriptionRoutes } from './modules/subscriptions/routes.js';
import { UpdateCheck } from './modules/updates/check.js';
import { archOf, registry } from './modules/updates/registry.js';
import { updateRoutes } from './modules/updates/routes.js';
import { mcpRoutes } from './modules/tools/mcp.js';
import { hasWebApp, serveWebApp, webAppRoutes } from './web.js';

export type { Db } from './db/client.js';
import type { Db } from './db/client.js';

/* logger is off unless given: tests stay quiet, main.ts turns it on so errors reach the container log. */
export type Deps = { db: Db; config: Config; logger?: FastifyServerOptions['logger'] };

/* What routes get: the deps, the live node connections, the live stream to browsers and the check for newer builds. */
export type Ctx = Deps & { hub: NodeHub; bus: EventBus; updates: UpdateCheck };

declare module 'fastify' {
  interface FastifyInstance {
    /* For tests and the few places outside a route that need the same context. */
    ctx: Ctx;
  }
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, disableRequestLogging: true });
  const web = hasWebApp(deps.config.webDist);
  registerErrorHandling(app, web ? webAppRoutes : undefined);
  const ctx = { ...deps, bus: new EventBus() } as Ctx;
  app.decorate('ctx', ctx);
  ctx.hub = new NodeHub({
    pingMs: deps.config.nodePingMs,
    onMessage: (id, msg) => handleNodeMessage(ctx, id, msg),
    onClose: id => handleNodeClose(ctx, id),
    onError: err => app.log.error(err),
  });
  app.addHook('onClose', async () => ctx.hub.stop());
  const { config } = deps;
  ctx.updates = new UpdateCheck({
    registry: registry({ image: config.image, arch: archOf(), base: config.registryUrl }),
    everyMs: config.updateCheckMs,
    onError: err => app.log.warn({ err }, 'Could not check for newer builds.'),
  });
  app.addHook('onReady', async () => ctx.updates.start());
  app.addHook('onClose', async () => ctx.updates.stop());
  await app.register(cookie);
  await app.register(websocket, SOCKET_OPTIONS);
  if (web) await serveWebApp(app, deps.config.webDist);
  const { version, commit, migrations } = deps.config;
  app.get('/api/health', async () => ({ ok: true, version, commit }));
  app.get('/api/version', async () => ({ version, commit, migrations }));
  setupRoutes(app, deps);
  authRoutes(app, deps);
  peopleRoutes(app, ctx);
  orgRoutes(app, ctx);
  subscriptionRoutes(app, ctx);
  nodeRoutes(app, ctx);
  nodeSocket(app, ctx);
  jobRoutes(app, ctx);
  streamRoutes(app, ctx);
  mcpRoutes(app, ctx);
  conversationRoutes(app, ctx);
  departmentRoutes(app, ctx);
  updateRoutes(app, ctx);
  return app;
}
