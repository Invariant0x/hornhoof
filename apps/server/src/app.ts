import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import { loggable, registerErrorHandling } from './errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { agentRoutes } from './modules/agents/routes.js';
import { conversationRoutes } from './modules/conversation/routes.js';
import { notebookRoutes } from './modules/notebook/routes.js';
import { startTimers } from './modules/agents/timers.js';
import { departmentRoutes } from './modules/departments/routes.js';
import { EventBus } from './modules/events/bus.js';
import { streamRoutes } from './modules/events/stream.js';
import { improvementRoutes } from './modules/improvements/routes.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { PublicLinks } from './modules/link/link.js';
import { linkRoutes } from './modules/link/routes.js';
import { NodeHub } from './modules/nodes/hub.js';
import { handleNodeClose, handleNodeMessage } from './modules/nodes/messages.js';
import { nodeRoutes } from './modules/nodes/routes.js';
import { nodeSocket, SOCKET_OPTIONS } from './modules/nodes/socket.js';
import { orgRoutes } from './modules/org/routes.js';
import { peopleRoutes } from './modules/people/routes.js';
import { setupRoutes } from './modules/setup/routes.js';
import { subscriptionRoutes } from './modules/subscriptions/routes.js';
import { signinRoutes } from './modules/subscriptions/signin.js';
import { loadTemplates, type Templates } from './modules/templates/load.js';
import { mcpRoutes } from './modules/tools/mcp.js';
import { UpdateCheck } from './modules/updates/check.js';
import { UpdaterControl } from './modules/updates/control.js';
import { ComputerAccess } from './modules/computer/access.js';
import { computerRoutes } from './modules/computer/routes.js';
import { archOf, registry } from './modules/updates/registry.js';
import { updateRoutes } from './modules/updates/routes.js';
import { attachmentRoutes } from './modules/tasks/attachments.js';
import { partFileRoutes } from './modules/testruns/files.js';
import { poolRoutes } from './modules/testruns/pool.js';
import { taskRoutes } from './modules/tasks/routes.js';
import { TerminalRelay } from './modules/terminals/relay.js';
import { terminalRoutes } from './modules/terminals/routes.js';
import { addSecurityHeaders, hasWebApp, serveWebApp, webAppRoutes } from './web.js';

export type { Db } from './db/client.js';
import { fromOwnPages } from './auth/origin.js';
import type { AgentSql } from './db/agent-sql.js';
import type { Db } from './db/client.js';

/* logger is off unless given: tests stay quiet, main.ts turns it on so errors reach the container log. */
export type Deps = { db: Db; config: Config; logger?: FastifyServerOptions['logger']; agentSql?: AgentSql | null };

/* What routes get: the deps, the live node connections, the live stream to browsers, the terminals people watch, the
   check for newer builds, access to the computer the server runs on and the company's public link. */
export type Ctx = Deps & {
  log: FastifyBaseLogger;
  hub: NodeHub;
  bus: EventBus;
  terminals: TerminalRelay;
  updates: UpdateCheck;
  updater: UpdaterControl;
  computer: ComputerAccess;
  templates: Templates;
  links: PublicLinks;
};

declare module 'fastify' {
  interface FastifyInstance {
    /* For tests and the few places outside a route that need the same context. */
    ctx: Ctx;
  }
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, logController: new LogController({ disableRequestLogging: true }) });
  const web = hasWebApp(deps.config.webDist);
  addSecurityHeaders(app);
  registerErrorHandling(app, web ? webAppRoutes : undefined);
  const ctx = { ...deps, log: app.log, bus: new EventBus(), terminals: new TerminalRelay() } as Ctx;
  app.decorate('ctx', ctx);
  ctx.hub = new NodeHub({
    pingMs: deps.config.nodePingMs,
    onMessage: (id, msg) => handleNodeMessage(ctx, id, msg),
    onTerminal: (id, msg) => ctx.terminals.fromNode(id, msg),
    onClose: id => handleNodeClose(ctx, id),
    onError: err => app.log.error({ error: loggable(err) }, 'A node message failed.'),
  });
  app.addHook('onClose', async () => ctx.hub.stop());
  app.addHook('onClose', async () => ctx.agentSql?.close());
  const { config } = deps;
  ctx.updates = new UpdateCheck({
    registry: registry({ image: config.image, arch: archOf(), base: config.registryUrl }),
    everyMs: config.updateCheckMs,
    onError: err => app.log.warn({ err }, 'Could not check for newer builds.'),
  });
  ctx.updater = new UpdaterControl(config.controlDir);
  ctx.computer = new ComputerAccess(config.controlDir, ctx.updater);
  ctx.templates = loadTemplates(config.templatesDir);
  ctx.links = new PublicLinks(ctx);
  app.addHook('onReady', async () => ctx.updates.start());
  app.addHook('onClose', async () => ctx.updates.stop());
  app.addHook('onReady', async () => ctx.links.sync());
  await app.register(cookie);
  await app.register(websocket, SOCKET_OPTIONS);
  /* After the socket plugin, so a refused socket is closed by it. */
  app.addHook('onRequest', fromOwnPages(deps.config, deps.db));
  if (web) await serveWebApp(app, deps.config.webDist);
  const { version, commit, migrations } = deps.config;
  app.get('/api/health', async () => ({ ok: true, version, commit }));
  app.get('/api/version', async () => ({ version, commit, migrations }));
  setupRoutes(app, ctx);
  authRoutes(app, deps);
  peopleRoutes(app, ctx);
  orgRoutes(app, ctx);
  subscriptionRoutes(app, ctx);
  signinRoutes(app, ctx);
  nodeRoutes(app, ctx);
  nodeSocket(app, ctx);
  jobRoutes(app, ctx);
  streamRoutes(app, ctx);
  mcpRoutes(app, ctx);
  conversationRoutes(app, ctx);
  notebookRoutes(app, ctx);
  improvementRoutes(app, ctx);
  startTimers(app, ctx);
  terminalRoutes(app, ctx);
  agentRoutes(app, ctx);
  departmentRoutes(app, ctx);
  updateRoutes(app, ctx);
  computerRoutes(app, ctx);
  taskRoutes(app, ctx);
  attachmentRoutes(app, ctx);
  partFileRoutes(app, ctx);
  poolRoutes(app, ctx);
  linkRoutes(app, ctx);
  return app;
}
