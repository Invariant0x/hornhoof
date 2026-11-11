import { closeCheckQueue } from './modules/nodes/check-slots.js';
import type { ProviderId } from '@hornhoof/protocol';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import { loggable, registerErrorHandling } from './errors.js';
import { AppMode, modeGate, whileLeading } from './modules/keeper/app-mode.js';
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
import { handleNumbered } from './modules/nodes/numbered.js';
import { nodeRoutes } from './modules/nodes/routes.js';
import { nodeSocket, SOCKET_OPTIONS } from './modules/nodes/socket.js';
import { startOperationsCheck } from './modules/operations/ensure.js';
import { orgRoutes } from './modules/org/routes.js';
import { peopleRoutes } from './modules/people/routes.js';
import { setupRoutes } from './modules/setup/routes.js';
import { subscriptionRoutes } from './modules/subscriptions/routes.js';
import { signinRoutes } from './modules/subscriptions/signin.js';
import { loadTemplates, type Templates } from './modules/templates/load.js';
import { mcpRoutes } from './modules/tools/mcp.js';
import { UpdateCheck } from './modules/updates/check.js';
import { UpdaterControl } from './modules/updates/control.js';
import { Computers } from './modules/computer/access.js';
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
import { TerminalRelay } from './modules/terminals/relay.js';
import { terminalRoutes } from './modules/terminals/routes.js';
import { Challenges, challengeRoutes } from './modules/tls/challenges.js';
import { LinkTls } from './modules/tls/manager.js';
import { addSecurityHeaders, hasWebApp, serveWebApp, webAppRoutes } from './web.js';

export type { Db } from './db/client.js';
import { fromOwnPages } from './auth/origin.js';
import { handOverSession, requirePerson } from './auth/session.js';
import { registerRequestSources } from './modules/sources/requests.js';
import { keyRoutes } from './modules/computer/keys.js';
import { refreshBuild } from './modules/network/follow.js';
import { networkRoutes } from './modules/network/routes.js';
import { overLink } from './auth/tunnel.js';
import type { AgentSql } from './db/agent-sql.js';
import type { Db } from './db/client.js';

import { readCompare, readTree, type CompareReader, type TreeReader } from './modules/testruns/compare.js';

/* logger is off unless given: tests stay quiet, main.ts turns it on so errors reach the container log. templates are read
   from config.templatesDir unless given: a test file reads them once for all its servers. onRoute is called for every
   route before any is added; a test uses it to ask each route what it tells a stranger. */
export type Deps = { db: Db; config: Config; logger?: FastifyServerOptions['logger']; agentSql?: AgentSql | null; onRoute?: (route: { method: string | string[]; url: string }) => void; vendorUrls?: Partial<Record<ProviderId, string>>; readCommit?: CommitReader; markCommit?: CommitMarker; readCompare?: CompareReader; readTree?: TreeReader; templates?: Templates };

/* What routes get: the deps, the live node connections, the live stream to browsers, the terminals people watch, the
   check for newer builds, access to the computer the server runs on, the company's public link, its ACME answers and
   its certificate, the commit a repository's branch is at and the mark a full test run leaves on a commit. */
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
  computer: Computers;
  templates: Templates;
  links: PublicLinks;
  challenges: Challenges;
  tls: LinkTls;
  mode: AppMode;
};

declare module 'fastify' {
  interface FastifyInstance {
    /* For tests and the few places outside a route that need the same context. */
    ctx: Ctx;
  }
  interface FastifyRequest {
    /* The request came over the public link: its session cookie is the __Host- one. Set by the first onRequest hook. */
    overLink: boolean;
  }
}

/* The few routes that answer without a session. Over the link they say nothing a stranger could use to tell which
   company or which build is behind the name. The health answer is 503 while the app is off, so a check can tell it has
   not started. */
function publicRoutes(app: FastifyInstance, { config, db, mode }: Ctx): void {
  const { version, commit, migrations } = config;
  app.get('/api/health', async (req, reply) => {
    const ok = mode.current() !== 'off';
    if (!ok) reply.code(503);
    return req.overLink ? { ok } : { ok, version, commit, mode: mode.current() };
  });
  app.get('/api/version', async req => {
    if (req.overLink) await requirePerson(req, db);
    return { version, commit, migrations };
  });
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n'));
}

/* A node or a terminal connected while leading sends nothing more once the app stops leading; 1012 tells it to come back. */
function closeOpenSockets(app: FastifyInstance): void {
  for (const client of app.websocketServer.clients) client.close(1012, 'Hornhoof takes no changes now.');
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, logController: new LogController({ disableRequestLogging: true }) });
  const web = hasWebApp(deps.config.webDist);
  if (deps.onRoute) app.addHook('onRoute', deps.onRoute);
  app.decorateRequest('overLink', false);
  app.addHook('onRequest', async req => {
    req.overLink = await overLink(req, deps.config);
  });
  addSecurityHeaders(app);
  registerErrorHandling(app, web ? webAppRoutes : undefined);
  const ctx = { startedAt: new Date(), readCommit, markCommit, readCompare, readTree, ...deps, log: app.log, bus: new EventBus(), terminals: new TerminalRelay() } as Ctx;
  app.decorate('ctx', ctx);
  ctx.mode = new AppMode({ dir: deps.config.controlDir, fromKeeper: deps.config.keeper, log: line => app.log.info(line) });
  ctx.hub = new NodeHub({
    pingMs: deps.config.nodePingMs,
    onMessage: whileLeading(ctx.mode, (id, msg, transport) => receiveNodeMessage(ctx, id, msg, transport)),
    /* Outside lead nothing handles a message, so nothing is confirmed, and the node sends it again. */
    onNumbered: async (id, stream, msg, transport) => ctx.mode.current() === 'lead' && (await handleNumbered(ctx, id, stream, msg, transport)),
    onTerminal: (id, msg) => ctx.terminals.fromNode(id, msg),
    onClose: whileLeading(ctx.mode, id => handleNodeClose(ctx, id)),
    onConnected: whileLeading(ctx.mode, (id, link, at) => nodeConnected(ctx, id, link, at)),
    onDisconnected: whileLeading(ctx.mode, (id, end) => nodeDisconnected(ctx, id, end)),
    onError: err => app.log.error({ error: loggable(err) }, 'A node message failed.'),
  });
  /* Before the socket plugin's, which closes the sockets, and while the database still answers. */
  app.addHook('preClose', async () => {
    await serverStopping(ctx).catch(err => app.log.error({ error: loggable(err) }, 'Writing that the server stopped into the history of node connections failed.'));
    /* What the nodes already sent finishes here, before their sockets close and before the database does. */
    await ctx.hub.stop();
  });
  app.addHook('onClose', async () => { closeCheckQueue(ctx); await ctx.hub.stop(); });
  app.addHook('onClose', async () => ctx.agentSql?.close());
  const { config } = deps;
  ctx.updates = new UpdateCheck({
    registry: registry({ image: config.image, arch: archOf(), base: config.registryUrl }),
    everyMs: config.updateCheckMs,
    onError: err => app.log.warn({ err }, 'Could not check for newer builds.'),
  });
  ctx.updater = new UpdaterControl(config.controlDir);
  ctx.computer = new Computers(ctx);
  ctx.computer.moveLegacy(config.controlDir);
  ctx.templates = deps.templates ?? loadTemplates(config.templatesDir);
  ctx.links = new PublicLinks(ctx);
  ctx.challenges = new Challenges();
  ctx.tls = new LinkTls(ctx);
  app.addHook('onClose', async () => ctx.tls.stop());
  ctx.mode.whenLead(() => ctx.updates.start(), () => ctx.updates.stop());
  /* Its own build, for the machines that follow it, asked for off the path of any request. A server told to ask the
     registry only when asked waits for the first machine that wants to know. */
  ctx.mode.whenLead(() => void (config.updateCheckMs > 0 && refreshBuild(ctx)), () => undefined);
  ctx.mode.whenLead(() => ctx.links.sync(), () => undefined);
  /* The first time this app leads it takes over the server's own computer access as an app from before left it, and
     tries again every second while that fails and it still leads. */
  const takeOverAccess = (): void =>
    void ctx.computer.importLegacy(config.controlDir).catch((err: unknown) => {
      ctx.log.warn({ error: loggable(err) }, "Could not take over the computer access an older build left. Computer access is not served until it is.");
      if (ctx.mode.current() === 'lead') setTimeout(takeOverAccess, 1000).unref();
    });
  ctx.mode.whenLead(takeOverAccess, () => undefined);
  ctx.mode.whenLeaving(() => closeOpenSockets(app));
  app.addHook('onReady', async () => {
    ctx.mode.start();
    await ctx.mode.settled();
  });
  app.addHook('onClose', async () => ctx.mode.stop());
  await app.register(cookie);
  await app.register(websocket, SOCKET_OPTIONS);
  /* Needs the cookies, so after the cookie plugin; a socket upgrade is skipped by the hand-over itself. */
  app.addHook('onRequest', async (req, reply) => {
    if (ctx.mode.current() === 'lead') await handOverSession(req, reply, deps.db, deps.config);
  });
  /* After the socket plugin, so a refused socket is closed by it. */
  app.addHook('onRequest', modeGate(ctx.mode));
  /* Again after the routes' own checks, which wait for the database: a socket that passed the gate above and crossed a
     step-down there is refused here, and from here to its upgrade nothing waits, so none opens outside lead. */
  app.addHook('preHandler', modeGate(ctx.mode));
  registerRequestSources(app, deps.db);
  app.addHook('onRequest', fromOwnPages(deps.config, deps.db));
  if (web) await serveWebApp(app, deps.config.webDist);
  publicRoutes(app, ctx);
  setupRoutes(app, ctx);
  authRoutes(app, ctx);
  peopleRoutes(app, ctx);
  orgRoutes(app, ctx);
  subscriptionRoutes(app, ctx);
  signinRoutes(app, ctx);
  nodeRoutes(app, ctx);
  startNodeDrains(ctx);
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
  networkRoutes(app, ctx);
  keyRoutes(app, ctx);
  outboundRoutes(app, ctx);
  challengeRoutes(app, ctx.challenges);
  return app;
}
