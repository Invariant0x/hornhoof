import { closeCheckQueue } from './modules/nodes/check-slots.js';
import type { ProviderId } from '@hornhoof/protocol';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import { loggable, registerErrorHandling } from './errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { agentRoutes } from './modules/agents/routes.js';
import { conversationRoutes } from './modules/conversation/routes.js';
import { notebookRoutes } from './modules/notebook/routes.js';
import { briefingRoutes } from './modules/briefings/routes.js';
import { startTimers } from './modules/agents/timers.js';
import { departmentRoutes } from './modules/departments/routes.js';
import { EventBus } from './modules/events/bus.js';
import { streamRoutes } from './modules/events/stream.js';
import { improvementRoutes } from './modules/improvements/routes.js';
import { backlogRoutes } from './modules/backlog/routes.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { PublicLinks } from './modules/link/link.js';
import { linkRoutes } from './modules/link/routes.js';
import { outboundRoutes } from './modules/outbound/extension.js';
import { nodeConnected, nodeDisconnected, serverStopping } from './modules/nodes/connections.js';
import { NodeHub } from './modules/nodes/hub.js';
import { handleNodeClose } from './modules/nodes/messages.js';
import { receiveNodeMessage } from './modules/nodes/lifecycle.js';
import { nodeRoutes } from './modules/nodes/routes.js';
import { nodeSocket, SOCKET_OPTIONS } from './modules/nodes/socket.js';
import { startOperationsCheck } from './modules/operations/ensure.js';
import { orgRoutes } from './modules/org/routes.js';
import { mapLayoutRoutes } from './modules/org/layout.js';
import { peopleRoutes } from './modules/people/routes.js';
import { assistantSetupRoutes } from './modules/assistants/setup.js';
import { assistantRoutes } from './modules/assistants/routes.js';
import { Assistants } from './modules/assistants/service.js';
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
import { startNodeDrains } from './modules/updates/node-drain.js';
import { nodeUpdateRoutes } from './modules/updates/node-routes.js';
import { attachmentRoutes } from './modules/tasks/attachments.js';
import { partFileRoutes } from './modules/testruns/files.js';
import { harnessRoutes } from './modules/testruns/harness.js';
import { readCommit, type CommitReader } from './modules/testruns/refs.js';
import { markCommit, type CommitMarker } from './modules/testruns/github-status.js';
import { poolRoutes } from './modules/testruns/pool.js';
import { taskRoutes } from './modules/tasks/routes.js';
import { TelegramBots } from './modules/telegram/bots.js';
import { telegramRoutes } from './modules/telegram/routes.js';
import { TerminalRelay } from './modules/terminals/relay.js';
import { terminalRoutes } from './modules/terminals/routes.js';
import { addSecurityHeaders, hasWebApp, serveWebApp, webAppRoutes } from './web.js';

export type { Db } from './db/client.js';
import { fromOwnPages } from './auth/origin.js';
import type { AgentSql } from './db/agent-sql.js';
import type { Db } from './db/client.js';

import { readCompare, readTree, type CompareReader, type TreeReader } from './modules/testruns/compare.js';

/* logger is off unless given: tests stay quiet, main.ts turns it on so errors reach the container log. templates are read
   from config.templatesDir unless given: a test file reads them once for all its servers. */
export type Deps = { db: Db; config: Config; logger?: FastifyServerOptions['logger']; agentSql?: AgentSql | null; vendorUrls?: Partial<Record<ProviderId, string>>; readCommit?: CommitReader; markCommit?: CommitMarker; readCompare?: CompareReader; readTree?: TreeReader; templates?: Templates };

/* What routes get: the deps, the live node connections, the live stream to browsers, the terminals people watch, the
   check for newer builds, access to the computer the server runs on, the company's public link, the commit a
   repository's branch is at, the mark a full test run leaves on a commit and the heads' Telegram bots. */
export type Ctx = Deps & {
  /* When this server came up: it did not hear of any machine before then. */
  startedAt: Date;
  readCommit: CommitReader;
  markCommit: CommitMarker;
  log: FastifyBaseLogger;
  hub: NodeHub;
  bus: EventBus;
  terminals: TerminalRelay;
  updates: UpdateCheck;
  updater: UpdaterControl;
  computer: ComputerAccess;
  templates: Templates;
  links: PublicLinks;
  telegram: TelegramBots;
  assistants: Assistants;
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
  const ctx = { startedAt: new Date(), readCommit, markCommit, readCompare, readTree, ...deps, log: app.log, bus: new EventBus(), terminals: new TerminalRelay() } as Ctx;
  app.decorate('ctx', ctx);
  ctx.hub = new NodeHub({
    pingMs: deps.config.nodePingMs,
    onMessage: (id, msg, transport) => receiveNodeMessage(ctx, id, msg, transport),
    onTerminal: (id, msg) => ctx.terminals.fromNode(id, msg),
    onClose: id => handleNodeClose(ctx, id),
    onConnected: (id, link, at) => nodeConnected(ctx, id, link, at),
    onDisconnected: (id, end) => nodeDisconnected(ctx, id, end),
    onError: err => app.log.error({ error: loggable(err) }, 'A node message failed.'),
  });
  /* Before the socket plugin's, which closes the sockets, and while the database still answers. */
  app.addHook('preClose', async () => serverStopping(ctx).catch(err => app.log.error({ error: loggable(err) }, 'Writing that the server stopped into the history of node connections failed.')));
  app.addHook('onClose', async () => { closeCheckQueue(ctx); ctx.hub.stop(); });
  app.addHook('onClose', async () => ctx.agentSql?.close());
  const { config } = deps;
  ctx.updates = new UpdateCheck({
    registry: registry({ image: config.image, arch: archOf(), base: config.registryUrl }),
    everyMs: config.updateCheckMs,
    onError: err => app.log.warn({ err }, 'Could not check for newer builds.'),
  });
  ctx.updater = new UpdaterControl(config.controlDir);
  ctx.computer = new ComputerAccess(config.controlDir, ctx.updater);
  ctx.templates = deps.templates ?? loadTemplates(config.templatesDir);
  ctx.links = new PublicLinks(ctx);
  ctx.telegram = new TelegramBots(ctx);
  ctx.assistants = new Assistants(ctx);
  app.addHook('onReady', async () => ctx.updates.start());
  app.addHook('onClose', async () => ctx.updates.stop());
  app.addHook('onReady', async () => ctx.links.sync());
  /* A bot stops before the database and the nodes go, so a message it is taking reaches its agent first. */
  app.addHook('onReady', async () => ctx.telegram.start());
  app.addHook('preClose', async () => ctx.telegram.stop());
  app.addHook('onReady', async () => ctx.assistants.start());
  app.addHook('preClose', async () => ctx.assistants.stop());
  await app.register(cookie);
  await app.register(websocket, SOCKET_OPTIONS);
  /* After the socket plugin, so a refused socket is closed by it. */
  app.addHook('onRequest', fromOwnPages(deps.config, deps.db));
  if (web) await serveWebApp(app, deps.config.webDist);
  const { version, commit, migrations } = deps.config;
  app.get('/api/health', async () => ({ ok: true, version, commit }));
  app.get('/api/version', async () => ({ version, commit, migrations }));
  setupRoutes(app, ctx);
  authRoutes(app, ctx);
  peopleRoutes(app, ctx);
  assistantSetupRoutes(app, ctx);
  orgRoutes(app, ctx);
  mapLayoutRoutes(app, ctx);
  subscriptionRoutes(app, ctx);
  signinRoutes(app, ctx);
  nodeRoutes(app, ctx);
  startNodeDrains(app, ctx);
  nodeUpdateRoutes(app, ctx);
  nodeSocket(app, ctx);
  jobRoutes(app, ctx);
  streamRoutes(app, ctx);
  mcpRoutes(app, ctx);
  conversationRoutes(app, ctx);
  notebookRoutes(app, ctx);
  briefingRoutes(app, ctx);
  improvementRoutes(app, ctx);
  backlogRoutes(app, ctx);
  startTimers(app, ctx);
  startOperationsCheck(app, ctx);
  terminalRoutes(app, ctx);
  agentRoutes(app, ctx);
  departmentRoutes(app, ctx);
  updateRoutes(app, ctx);
  computerRoutes(app, ctx);
  taskRoutes(app, ctx);
  attachmentRoutes(app, ctx);
  partFileRoutes(app, ctx);
  harnessRoutes(app, ctx);
  poolRoutes(app, ctx);
  linkRoutes(app, ctx);
  outboundRoutes(app, ctx);
  telegramRoutes(app, ctx);
  assistantRoutes(app, ctx);
  return app;
}
