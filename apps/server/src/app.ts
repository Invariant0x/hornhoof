import type { ConversationEffects } from './modules/conversation/effects.js';
import type { CallEffects } from './modules/calls/effects.js';
import { fallbackMove } from './modules/subscriptions/fallback.js';
import { notifyFailure } from './modules/tasks/failures.js';
import { resumeOperatorProcess } from './modules/program-operator/recovery.js';
import { cancelJob, wakeAll } from './modules/tasks/wake.js';
import { inboxRoutes } from './modules/conversation/inbox-routes.js';
import { closeCheckQueue } from './modules/nodes/check-slots.js';
import type { Socket } from 'node:net';
import type { ProviderId } from '@hornhoof/protocol';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import { ApiError, loggable, registerErrorHandling } from './errors.js';
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
import { trackerRoutes } from './modules/tracker/routes.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { PublicLinks } from './modules/link/link.js';
import { linkRoutes } from './modules/link/routes.js';
import { nodeConnected, nodeDisconnected, serverStopping } from './modules/nodes/connections.js';
import { NodeHub, type NodeIdentity } from './modules/nodes/hub.js';
import type { ToolsCall } from './modules/tools/outside.js';
import { nameBuiltinWork } from './modules/nodes/builtin.js';
import { applyParkedMessages, handleNodeClose } from './modules/nodes/messages.js';
import { receiveNodeMessage } from './modules/nodes/lifecycle.js';
import { handleNumbered } from './modules/nodes/numbered.js';
import { nodeRoutes } from './modules/nodes/routes.js';
import { nodeSocket, SOCKET_OPTIONS } from './modules/nodes/socket.js';
import { startOperationsCheck } from './modules/operations/ensure.js';
import { startTrackerUpgrade } from './modules/tracker/upgrade.js';
import { orgRoutes } from './modules/org/routes.js';
import { mapLayoutRoutes } from './modules/org/layout.js';
import { peopleRoutes } from './modules/people/routes.js';
import { assistantSetupRoutes } from './modules/assistants/setup.js';
import { assistantMcpRoutes } from './modules/assistants/mcp.js';
import { assistantRoutes } from './modules/assistants/routes.js';
import { Assistants } from './modules/assistants/service.js';
import { setupRoutes } from './modules/setup/routes.js';
import { subscriptionRoutes } from './modules/subscriptions/routes.js';
import { signinRoutes } from './modules/subscriptions/signin.js';
import { loadTemplates, type Templates } from './modules/templates/load.js';
import { mcpRoutes } from './modules/tools/mcp.js';
import { UpdateCheck } from './modules/updates/check.js';
import { UpdaterControl } from './modules/updates/control.js';
import { refreshHolders } from './modules/backups/holders.js';
import { Restores } from './modules/backups/restore.js';
import { TotalLoss, totalLossRoutes } from './modules/backups/total-loss.js';
import { keptDatabases } from './modules/merge/kept.js';
import { Ranking } from './modules/copies/order.js';
import { copiesRoutes } from './modules/copies/routes.js';
import { LeftSlots } from './modules/copies/left-slots.js';
import { replicationOf, type Replication } from './modules/copies/slots.js';
import { Merger } from './modules/merge/merger.js';
import { mergeRoutes } from './modules/merge/routes.js';
import { backupRoutes } from './modules/backups/routes.js';
import { Computers } from './modules/computer/access.js';
import { computerRoutes } from './modules/computer/routes.js';
import { archOf, registry } from './modules/updates/registry.js';
import { updateRoutes } from './modules/updates/routes.js';
import { startNodeDrains } from './modules/updates/node-drain.js';
import { nodeUpdateRoutes } from './modules/updates/node-routes.js';
import { attachmentRoutes } from './modules/tasks/attachments.js';
import { partFileRoutes } from './modules/testruns/files.js';
import { harnessRoutes } from './modules/testruns/harness.js';
import { createBranch, readBranches, readCommit, readTags, type BranchCreator, type BranchReader, type CommitReader, type TagReader } from './modules/testruns/refs.js';
import { markCommit, type CommitMarker } from './modules/testruns/github-status.js';
import { poolRoutes } from './modules/testruns/pool.js';
import { taskRoutes } from './modules/tasks/routes.js';
import { TelegramBots } from './modules/telegram/bots.js';
import { telegramRoutes } from './modules/telegram/routes.js';
import { TerminalRelay } from './modules/terminals/relay.js';
import { terminalRoutes } from './modules/terminals/routes.js';
import { Challenges, challengeRoutes } from './modules/tls/challenges.js';
import { LinkTls } from './modules/tls/manager.js';
import { addSecurityHeaders, hasWebApp, pageBuild, serveWebApp, webAppRoutes } from './web.js';

export type { Db } from './db/client.js';
import { fromOwnPages } from './auth/origin.js';
import { handOverSession, readCookieSession, requirePerson } from './auth/session.js';
import { registerRequestSources } from './modules/sources/requests.js';
import { keyRoutes } from './modules/computer/keys.js';
import { refreshBuild } from './modules/network/follow.js';
import { questionRoutes } from './modules/network/question-routes.js';
import { noteSwitch, switchedRoutes } from './modules/network/switched.js';
import { networkRoutes } from './modules/network/routes.js';
import { overLink } from './auth/tunnel.js';
import type { AgentSql } from './db/agent-sql.js';
import type { Db } from './db/client.js';

import { readCompare, readMerged, readTree, type CompareReader, type MergeReader, type TreeReader } from './modules/testruns/compare.js';
import { readGitAncestry, type GitAncestryReader } from './modules/testruns/git-ancestry.js';
import { GitHubLimits } from './modules/testruns/github-limit.js';
import { companies } from './db/schema.js';
import { idOnly } from './db/selections.js';
import { createOnGitHub } from './modules/departments/github-create.js';
import { openIssueOnGitHub, type IssueCreator } from './modules/feedback/github-issue.js';
import { RELEASED, type Released } from './modules/feedback/released.js';
import { feedbackRoutes } from './modules/feedback/routes.js';
import type { RepositoryCreator } from './modules/departments/repo-hosts.js';
import { googleSheetsRoutes } from './modules/google/routes.js';
import { vaultRoutes } from './modules/vault/routes.js';
import { phoneRoutes } from './modules/phones/routes.js';
import { closePhoneRequests } from './modules/phones/rpc.js';
import { startPhoneReadiness } from './modules/phones/readiness.js';
import { createOnGoogleSheets, type SpreadsheetCreator } from './modules/google/sheets.js';
import { modelsReader, type ModelsReader } from './modules/subscriptions/api-models.js';

/* logger is off unless given: tests stay quiet, main.ts turns it on so errors reach the container log. templates are read
   from config.templatesDir unless given: a test file reads them once for all its servers. onRoute is called for every
   route before any is added; a test uses it to ask each route what it tells a stranger. */
export type Deps = { db: Db; config: Config; logger?: FastifyServerOptions['logger']; agentSql?: AgentSql | null; onRoute?: (route: { method: string | string[]; url: string }) => void; vendorUrls?: Partial<Record<ProviderId, string>>; readCommit?: CommitReader; markCommit?: CommitMarker; readCompare?: CompareReader; readTree?: TreeReader; readBranches?: BranchReader; createBranch?: BranchCreator; readTags?: TagReader; readMerged?: MergeReader; readGitAncestry?: GitAncestryReader; createRepository?: RepositoryCreator; createSpreadsheet?: SpreadsheetCreator; createIssue?: IssueCreator; readModels?: ModelsReader; clock?: () => number; templates?: Templates; released?: readonly Released[] };

/* What routes get: the deps, the live node connections, the live stream to browsers, the terminals people watch, the
   check for newer builds, access to the computer the server runs on, the company's public link, its ACME answers and
   its certificate, the commit a repository's branch is at, the mark a full test run leaves on a commit and the heads'
   Telegram bots. */
export type Ctx = Deps & {
  /* When this server came up: it did not hear of any machine before then. */
  startedAt: Date;
  conversationEffects: ConversationEffects;
  callEffects: CallEffects;
  readCommit: CommitReader;
  githubLimits: GitHubLimits;
  markCommit: CommitMarker;
  /* Creates a repository on a git host with a key the company saved. */
  createRepository: RepositoryCreator;
  /* Creates a spreadsheet on Google Sheets with a key the company saved. */
  createSpreadsheet: SpreadsheetCreator;
  /* Opens an issue on GitHub with a key the company saved, for a card of the feedback inbox. */
  createIssue: IssueCreator;
  /* What the releases up to this build say about reports installations sent: their issues and the versions that fixed them. */
  released: readonly Released[];
  /* Asks an API at an address a person gave for its models, never into the internal network the operator did not allow. */
  readModels: ModelsReader;
  /* The time limits are counted on, which tests move. */
  clock: () => number;
  log: FastifyBaseLogger;
  hub: NodeHub;
  bus: EventBus;
  terminals: TerminalRelay;
  updates: UpdateCheck;
  updater: UpdaterControl;
  /* Restores of the company from a backup, and what follows one. */
  restores: Restores;
  /* A restore from a recovery file on a server that has no company yet. */
  totalLoss: TotalLoss;
  /* The merges of the databases that came back. */
  merger: Merger;
  /* The numbering of the machines that may hold the company's data. */
  ranking: Ranking;
  /* The slots of the copies in this server's Postgres. */
  replication: Replication;
  /* True while the agents' database roles are still on their way: where a keeper runs they get their rights once the
     app comes out of off, and until then the database tool says the server is starting. */
  agentSqlPending?: boolean;
  /* The network ids of the machines whose database a merge is to read: the keeper opens a door to each. */
  doorsWanted: () => Promise<string[]>;
  /* The leader's slots of tables whose first copy broke off, as the copies named them, for this machine's keeper to drop. */
  leftSlots: LeftSlots;
  /* Applies what nodes said of jobs whose rows were on a machine the server was taken from, once those rows are
     here; how many messages it applied. */
  applyParked: () => Promise<number>;
  /* Answers what an agent's program sent to its tools with no turn running, which its node handed on. Set with /mcp. */
  toolsOutside?: (node: NodeIdentity, call: ToolsCall) => Promise<void>;
  computer: Computers;
  templates: Templates;
  links: PublicLinks;
  challenges: Challenges;
  tls: LinkTls;
  mode: AppMode;
  telegram: TelegramBots;
  assistants: Assistants;
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
   company or which build is behind the name beyond what the page at / already shows. The health answer is 503 while the
   app is off, so a check can tell it has not started. */
function publicRoutes(app: FastifyInstance, { config, db, mode }: Ctx): void {
  const { version, commit, migrations } = config;
  const build = pageBuild(config.webDist);
  app.get('/api/health', async (req, reply) => {
    const ok = mode.current() !== 'off';
    if (!ok) reply.code(503);
    return req.overLink ? { ok } : { ok, version, commit, mode: mode.current() };
  });
  app.get('/api/version', async req => {
    if (req.overLink) await requirePerson(req, db);
    return { version, commit, migrations };
  });
  /* No more than the page at / tells anyone: a signed-out page learns from it that it is not the page served now. */
  if (build) app.get('/api/build', async (_req, reply) => reply.header('cache-control', 'no-store').send({ build }));
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n'));
}

/* A node or a terminal connected while leading sends nothing more once the app stops leading; 1012 tells it to come back. */
function closeOpenSockets(app: FastifyInstance): void {
  for (const client of app.websocketServer.clients) client.close(1012, 'Hornhoof takes no changes now.');
}

/* How often the holders of the newest bundles are looked at again. */
const HOLDERS_EVERY_MS = 3_600_000;
/* The look for the server's own machine's row grows slower up to this, and says so once after this many looks. */
/* How soon the carry of a restore is tried again after it could not be applied. */
const RESTORE_RETRY_MS = 10_000;
/* For how long a connection that has sent nothing is waited for once the app closes. */
const SILENT_CONNECTION_MS = 1000;

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
  const bus = new EventBus();
  const githubLimits = new GitHubLimits(deps.clock ?? Date.now,
    limit => app.log.warn({ remaining: limit.remaining, resetAt: limit.resetAt === null ? null : new Date(limit.resetAt).toISOString() }, 'GitHub REST request limit exhausted.'),
    () => {
      void deps.db.select(idOnly(companies)).from(companies).then(rows => {
        for (const { id } of rows) bus.publish(id, { type: 'requests', spot: { departmentId: null, parentId: null } });
      }).catch((error: unknown) => app.log.error({ error: loggable(error) }, 'Refreshing GitHub limit cards failed.'));
    });
  const ctx = {
    startedAt: new Date(),
    readCommit,
    markCommit,
    readCompare,
    readTree,
    readBranches,
    createBranch,
    readTags,
    readMerged,
    readGitAncestry,
    githubLimits,
    createRepository: createOnGitHub(),
    createSpreadsheet: createOnGoogleSheets(deps.config.googleTokenUrl, deps.config.googleSheetsUrl, deps.config.googleDriveUrl),
    createIssue: openIssueOnGitHub(),
    readModels: modelsReader({ allowed: deps.config.apiInternalHosts }),
    clock: Date.now,
    released: RELEASED,
    ...deps,
    log: app.log,
    bus,
    terminals: new TerminalRelay(),
  } as Ctx;
  ctx.conversationEffects = { beforeDispatch: fallbackMove, resumeProgram: resumeOperatorProcess, notifyHold: notifyFailure };
  ctx.callEffects = { wakeAll, cancelJob };
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
  /* A connection nobody has asked anything on yet is not idle to Node: it keeps the server from closing until its first
     request comes or a minute has passed. A client's pool leaves such connections behind. Once the app closes, each
     connection that is open, and each that still comes while its parts stop, gets a moment for words already on their
     way to arrive, and goes if it has sent none by then; one that has sent anything is left to end as it will. */
  const connections = new Set<Socket>();
  let closing = false;
  const endIfSilent = (socket: Socket): void => {
    const timer = setTimeout(() => socket.bytesRead === 0 && socket.destroy(), SILENT_CONNECTION_MS);
    socket.once('close', () => clearTimeout(timer));
  };
  app.server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    if (closing) endIfSilent(socket);
  });
  app.addHook('preClose', async () => {
    closing = true;
    for (const socket of connections) endIfSilent(socket);
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
  ctx.restores = new Restores(ctx);
  ctx.totalLoss = new TotalLoss(ctx);
  ctx.merger = new Merger(ctx, keptDatabases(deps.db, deps.config));
  ctx.ranking = new Ranking(ctx);
  ctx.replication = replicationOf(deps.db);
  ctx.doorsWanted = () => ctx.merger.doors();
  ctx.leftSlots = new LeftSlots();
  ctx.applyParked = () => applyParkedMessages(ctx);
  ctx.computer = new Computers(ctx);
  ctx.templates = deps.templates ?? loadTemplates(config.templatesDir);
  ctx.links = new PublicLinks(ctx);
  ctx.challenges = new Challenges();
  ctx.tls = new LinkTls(ctx);
  app.addHook('onClose', async () => ctx.tls.stop());
  ctx.telegram = new TelegramBots(ctx);
  ctx.assistants = new Assistants(ctx);
  /* First of what a leader does: the work its one built-in node ran before each machine had its own is named as this
     machine's, before anything else looks at it. A failure is one line, and the next time it leads tries again. */
  ctx.mode.whenLead(() => nameBuiltinWork(ctx).catch((err: unknown) => ctx.log.warn({ error: loggable(err) }, "Could not name the built-in node's earlier work as this machine's.")), () => undefined);
  ctx.mode.whenLead(() => ctx.updates.start(), () => ctx.updates.stop());
  /* The heads' bots listen only while this app leads: a message one takes is written down, and two apps asking
     Telegram for the same bot's messages would take them from each other. A bot stops before the database and the
     nodes go, so a message it is taking reaches its agent first. */
  ctx.mode.whenLead(() => ctx.telegram.start(), () => ctx.telegram.stop());
  app.addHook('preClose', async () => ctx.telegram.stop());
  /* What Hornhoof does for assistants writes what it collects, so it runs only while this app leads, as the heads' bots
     do. */
  ctx.mode.whenLead(() => ctx.assistants.start(), () => ctx.assistants.stop());
  app.addHook('preClose', async () => ctx.assistants.stop());
  /* A database that was restored takes over who may get in now before this app serves anybody on it: the first thing
     it does when it first leads. Until that has gone through, every request but for its health is turned away as
     while it starts, in whatever mode, since the sessions the backup brought back would else still read; a failure is
     one line, and is tried again every ten seconds while it leads. Then what was sent for a recovery goes. */
  let carryTimer: NodeJS.Timeout | undefined;
  const settleRestore = async (): Promise<void> => {
    if (ctx.restores.ready()) return;
    try {
      await ctx.restores.afterSwap();
    } catch (err) {
      ctx.log.warn({ error: loggable(err) }, 'Could not carry over who may get in to the restored database. Nobody is served until it is.');
      if (ctx.mode.current() === 'lead') carryTimer = setTimeout(() => void settleRestore(), RESTORE_RETRY_MS).unref();
      return;
    }
    await ctx.totalLoss.tidy().catch((err: unknown) => ctx.log.warn({ error: loggable(err) }, 'Could not clear what was sent for a recovery.'));
  };
  ctx.mode.whenLead(settleRestore, () => clearTimeout(carryTimer));
  /* What the databases that came back hold is brought back while this app leads, a look a minute. */
  ctx.mode.whenLead(() => ctx.merger.start(), () => ctx.merger.stop());
  /* On a machine that just took the server over, the orchestrator hears of it once and tells the CEO. */
  ctx.mode.whenLead(() => noteSwitch(ctx).catch((err: unknown) => ctx.log.warn({ error: loggable(err) }, 'Could not tell the orchestrator that the server moved.')), () => undefined);
  app.addHook('onClose', async () => ctx.merger.stop());
  /* The machines that may hold the data are numbered while this app leads, at once and then each minute. */
  ctx.mode.whenLead(() => ctx.ranking.start(), () => ctx.ranking.stop());
  app.addHook('onClose', async () => ctx.ranking.stop());
  app.addHook('onClose', async () => clearTimeout(carryTimer));
  /* Its own build, for the machines that follow it, asked for off the path of any request. A server told to ask the
     registry only when asked waits for the first machine that wants to know. */
  ctx.mode.whenLead(() => void (config.updateCheckMs > 0 && refreshBuild(ctx)), () => undefined);
  ctx.mode.whenLead(() => ctx.links.sync(), () => undefined);
  /* Every hour while it leads, the app looks again at who holds the newest bundles. */
  let holdersTimer: NodeJS.Timeout | undefined;
  ctx.mode.whenLead(
    () => {
      holdersTimer = setInterval(() => void refreshHolders(ctx.db).catch((err: unknown) => ctx.log.warn({ error: loggable(err) }, 'Could not look again at which machines hold the backups.')), HOLDERS_EVERY_MS);
      holdersTimer.unref();
    },
    () => clearInterval(holdersTimer),
  );
  app.addHook('onClose', async () => clearInterval(holdersTimer));
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
  /* A person who signed in while this machine only read: served as themselves, and given a session once it leads. */
  app.addHook('onRequest', async (req, reply) => {
    const mode = ctx.mode.current();
    if (mode !== 'off') await readCookieSession(req, reply, deps.db, deps.config, mode === 'lead');
  });
  /* After the socket plugin, so a refused socket is closed by it. */
  app.addHook('onRequest', modeGate(ctx.mode));
  app.addHook('onRequest', async req => {
    const path = req.url.split('?')[0]!;
    if (ctx.restores.holds(ctx.mode.current()) && (path.startsWith('/api/') || path === '/mcp') && path !== '/api/health') {
      throw new ApiError(503, 'unavailable', 'Hornhoof is starting.', 'starting');
    }
  });
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
  assistantSetupRoutes(app, ctx);
  orgRoutes(app, ctx);
  mapLayoutRoutes(app, ctx);
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
  feedbackRoutes(app, ctx);
  backlogRoutes(app, ctx);
  startTimers(app, ctx);
  startOperationsCheck(app, ctx);
  startTrackerUpgrade(app, ctx);
  terminalRoutes(app, ctx);
  agentRoutes(app, ctx);
  inboxRoutes(app, ctx);
  departmentRoutes(app, ctx);
  updateRoutes(app, ctx);
  computerRoutes(app, ctx);
  taskRoutes(app, ctx);
  trackerRoutes(app, ctx);
  attachmentRoutes(app, ctx);
  partFileRoutes(app, ctx);
  harnessRoutes(app, ctx);
  poolRoutes(app, ctx);
  linkRoutes(app, ctx);
  networkRoutes(app, ctx);
  questionRoutes(app, ctx);
  switchedRoutes(app, ctx);
  copiesRoutes(app, ctx);
  keyRoutes(app, ctx);
  backupRoutes(app, ctx);
  totalLossRoutes(app, ctx);
  mergeRoutes(app, ctx);
  challengeRoutes(app, ctx.challenges);
  telegramRoutes(app, ctx);
  googleSheetsRoutes(app, ctx);
  vaultRoutes(app, ctx);
  phoneRoutes(app, ctx);
  startPhoneReadiness(app, ctx);
  app.addHook('onClose', async () => { closePhoneRequests(ctx); });
  assistantRoutes(app, ctx);
  assistantMcpRoutes(app, ctx);
  return app;
}
