import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MACHINE_KINDS } from '@hornhoof/protocol';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { seesAgentId, viewerOf } from '../../auth/agent-view.js';
import { requirePerson } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { agents, companies, machines, nodeCodes, nodes, people, subscriptions, tasks, testParts, testRuns, type Provider } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError, loggable } from '../../errors.js';
import { runningAgents } from '../agents/running.js';
import { linkOf, publicUrl } from '../link/link.js';
import { buildSoon, type LeaderBuild } from '../network/follow.js';
import { companyFolder, isServerComputer, issueTicket } from '../network/join.js';
import { seenAccess } from '../computer/seen.js';
import { replicasOf } from '../copies/measured.js';
import { askMove, cancelMove, moveView } from '../copies/move.js';
import { setPriority } from '../copies/priority.js';
import { holding } from '../copies/view.js';
import { findThisMachine } from '../network/store.js';
import { machineNodes, machineState, together } from '../testruns/load.js';
import { pumpTests } from '../testruns/runs.js';
import { createInstallCommand } from './command.js';
import { nodeCommandRoutes } from './command-routes.js';
import { connectionRoutes } from './connection-routes.js';
import { disconnectMachines, refuseLeader, removalWarnings } from './disconnect.js';
import { nodeIdentity, ownBuiltin, ownMachine as machineOfServer, type NodeHub } from './hub.js';
import { nodeImageOfBuild } from './image.js';
import { machineFolders } from './machine-disk.js';
import { builtinMachine, isServerInstall, liveNode, otherBuild, settlePlans, shownMachine } from './nodes.js';
import { machineProgramNodes, machineProgramState, machineProgramRoutes, programsFor } from './programs.js';
import { machineDrain, nodeDrain } from '../updates/drain.js';

const JoinBody = z.object({
  code: z.string().min(1).max(200),
  machineId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  hostname: z.string().trim().min(1).max(120),
  os: z.enum(['linux', 'darwin']),
  arch: z.enum(['arm64', 'x86_64']),
  kind: z.enum(MACHINE_KINDS).default('computer'),
  /* An installer that can set up the company's core on the computer asks for it. */
  core: z.boolean().default(false),
});

/* A machine whose nodes were heard from within a day is about, and can be offered the company's core. */
const CORE_OFFER_MS = 24 * 60 * 60 * 1000;
/* The port a server's web door has when its keeper has reported none. */
const WEB_PORT = 8080;
/* What an installer needs for the core: nothing but the port when the computer is the server's own, which has all of
   Hornhoof already. */
type CoreAnswer = { folder: string; ticket: string; port: number; company: string } | { here: true; port: number };
const coreLine = (core: CoreAnswer): string => ('here' in core ? `core-here ${core.port}\n` : `core ${core.folder} ${core.ticket} ${core.port} ${core.company}\n`);

/* A machine that comes back after a Disconnect is the same row, but has no place in the company's network until its
   keeper redeems a new ticket: the key it had before is let in by nothing. A machine that was never disconnected keeps
   its place when a command runs there again. */
const keptWhileConnected = (column: AnyPgColumn) => sql`CASE WHEN ${machines.revokedAt} IS NULL THEN ${column} END`;
const NO_PLACE_AFTER_DISCONNECT = { role: keptWhileConnected(machines.role), signKey: keptWhileConnected(machines.signKey), networkId: keptWhileConnected(machines.networkId) };

/* The three images of the server's build, each by its digest, as the installer pulls them. */
const buildLine = (image: string, build: LeaderBuild): string => `build ${build.tag} ${image}@${build.digest} ${image}-node@${build.nodeDigest} ${image}-updater@${build.updaterDigest}\n`;

const IdParams = z.object({ id: z.uuid() });
export const LendBody = z.object({ lendsTests: z.boolean() }).strict();
/* The ticks of a machine's card: whether it takes the company's test runs, and whether it keeps the company's backups. */
const TicksBody = z
  .object({ lendsTests: z.boolean().optional(), keepsBackups: z.boolean().optional() })
  .strict()
  .refine(ticks => ticks.lendsTests !== undefined || ticks.keepsBackups !== undefined, 'Say which tick to change.');
const PlanBody = z.object({ subscription: z.uuid() }).strict();
/* A machine's place by hand: null for none, 'none' to keep it from the server, or the place, from 2. */
const PriorityBody = z.object({ pin: z.union([z.null(), z.literal('none'), z.number().int().min(2).max(999)]) }).strict();

const codeUsed = () => new ApiError(410, 'gone', 'This install command was already used or has expired. Get a new one in Hornhoof.', 'code_used');
const alreadyThere = () => new ApiError(409, 'conflict', 'This machine runs it already.', 'already_on_machine');

/* The node of this plan, or this machine's own, on this machine with a new key. One that was here before keeps its id,
   so the installer finds its container and sign-in again. A plan's first node takes the plan's id, as nodes had before
   they had rows of their own. None while the node has a key: a machine key and a command are all a join shows, so a
   second command must not take a working node over. */
async function keyNode(tx: Db, at: { companyId: string; machineId: string; subscriptionId: string | null }, keyHash: string): Promise<string | null> {
  const [had] = at.subscriptionId ? await tx.select(idOnly(nodes)).from(nodes).where(eq(nodes.subscriptionId, at.subscriptionId)).limit(1) : [];
  const [node] = await tx
    .insert(nodes)
    .values({ ...(at.subscriptionId && !had ? { id: at.subscriptionId } : {}), ...at, keyHash, status: 'needs_login' })
    .onConflictDoUpdate({ target: [nodes.machineId, nodes.subscriptionId], set: { keyHash, status: 'needs_login' }, setWhere: isNull(nodes.keyHash) })
    .returning({ id: nodes.id });
  return node?.id ?? null;
}

function closeJoined(hub: NodeHub, made: { nodeId: string }[]): void {
  for (const node of made) hub.close(node.nodeId, 4001);
}

export function nodeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config, hub } = ctx;
  machineProgramRoutes(app, ctx, ownMachine);
  /* The installer calls this with the code from the command. The code is the only credential, and it works once. */
  app.post('/api/nodes/join', async (req, reply) => {
    const body = JoinBody.parse(req.body);
    const codeHash = hashToken(body.code);
    const [code] = await db.select().from(nodeCodes).where(eq(nodeCodes.codeHash, codeHash));
    if (!code) throw new ApiError(404, 'not_found', 'This install command is not valid. Copy it again from Hornhoof.', 'code_unknown');
    /* A person who was disabled after getting the command cannot connect machines with it. */
    const [owner] = await db.select(only(people, 'status')).from(people).where(eq(people.id, code.personId));
    if (owner?.status !== 'active') throw codeUsed();
    /* A command to add plans to one machine is left unused on any other. */
    if (code.machineId) {
      const [meant] = await db.select().from(machines).where(eq(machines.id, code.machineId));
      if (!meant || meant.machineKey !== body.machineId || meant.personId !== code.personId) {
        throw new ApiError(409, 'conflict', `This command is for the machine ${meant?.hostname ?? ''}. Run it there.`, 'other_machine');
      }
    }

    /* The core comes to an installer that asks for it, and with a command made for it. The server's own computer needs
       no ticket. */
    const wantsCore = body.core || code.core;
    const here = wantsCore && isServerComputer(config, body.machineId);
    /* The server's own build, so the core comes up on the build the server runs. This answer is the one to name it, so a
       server that knows none asks the registry: before the command is used up, and for a moment only. */
    const build = wantsCore ? await buildSoon(ctx) : null;

    const joined = await db.transaction(async tx => {
      const used = await tx
        .update(nodeCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(nodeCodes.codeHash, codeHash), isNull(nodeCodes.usedAt), gt(nodeCodes.expiresAt, new Date())))
        .returning({ codeHash: nodeCodes.codeHash });
      if (used.length === 0) throw codeUsed();

      /* A command made for one machine puts its plan there as well as on the machines it has. Any other takes only plans
         that wait for a machine, so one that joined elsewhere keeps its machines and nothing else. Two commands for one
         plan that join at once take turns here, so the second sees the first one's node. */
      if (code.subscriptionIds.length) {
        await tx.select(idOnly(subscriptions)).from(subscriptions).where(inArray(subscriptions.id, code.subscriptionIds)).orderBy(asc(subscriptions.id)).for('update');
      }
      const subs = await tx
        .select({ id: subscriptions.id, provider: subscriptions.provider })
        .from(subscriptions)
        .where(
          and(
            inArray(subscriptions.id, code.subscriptionIds),
            eq(subscriptions.ownerPersonId, code.personId),
            eq(subscriptions.kind, 'personal'),
            isNull(subscriptions.removedAt),
            code.machineId ? undefined : sql`not exists (select 1 from ${nodes} where ${nodes.subscriptionId} = ${subscriptions.id} and ${nodes.keyHash} is not null)`,
          ),
        );
      /* A code with no subscriptions connects the machine alone. */
      const alone = code.subscriptionIds.length === 0;
      if (!alone && subs.length === 0) throw codeUsed();

      const details = { hostname: body.hostname, os: body.os, arch: body.arch, kind: body.kind };
      const [machine] = await tx
        .insert(machines)
        .values({ companyId: code.companyId, personId: code.personId, machineKey: body.machineId, ...details })
        .onConflictDoUpdate({ target: [machines.personId, machines.machineKey], set: { ...details, revokedAt: null, ...NO_PLACE_AFTER_DISCONNECT } })
        .returning({ id: machines.id });

      const ticket = wantsCore && !here ? await issueTicket(tx, machine!.id) : null;
      /* A command for the core brings no node: the machine has its nodes, and they move to the core by themselves. */
      if (code.core) return { machine: { id: machine!.id }, nodes: [], ticket };

      /* The machine's own node has no plan: it takes test runs, and the machine its owner's plans later. */
      if (alone) {
        const key = newToken();
        const nodeId = await keyNode(tx, { companyId: code.companyId, machineId: machine!.id, subscriptionId: null }, hashToken(key));
        if (!nodeId) throw alreadyThere();
        return { machine: { id: machine!.id }, nodes: [{ nodeId, subscriptionId: null, provider: 'machine' as const, key }], ticket };
      }

      /* Each plan signs in on this machine by itself, with a key of its own; one that runs here already is left as it is. */
      const made: { nodeId: string; subscriptionId: string | null; provider: Provider | 'machine'; key: string }[] = [];
      for (const sub of subs) {
        const key = newToken();
        const nodeId = await keyNode(tx, { companyId: code.companyId, machineId: machine!.id, subscriptionId: sub.id }, hashToken(key));
        if (nodeId) made.push({ nodeId, subscriptionId: sub.id, provider: sub.provider, key });
      }
      if (!made.length) throw code.machineId ? alreadyThere() : codeUsed();
      await settlePlans(tx, made.map(n => n.subscriptionId));
      return { machine: { id: machine!.id }, nodes: made, ticket };
    });
    closeJoined(hub, joined.nodes);
    const core = wantsCore ? await coreFor(joined.ticket, code.companyId) : null;

    /* The build's line and the core's first, then one line per node: the installer names its container after the node. */
    if (req.headers.accept?.includes('text/plain')) {
      const first = (core && build ? buildLine(config.image, build) : '') + (core ? coreLine(core) : '');
      return reply.type('text/plain; charset=utf-8').send(first + joined.nodes.map(n => `${n.nodeId} ${n.provider} ${n.key}\n`).join(''));
    }
    return { machine: joined.machine, nodes: joined.nodes, core, build: core ? build : null };
  });

  /* The core lives in a folder named after the company and takes the server's own web port first, so the company opens
     at the same address on every machine. */
  async function coreFor(ticket: string | null, companyId: string): Promise<CoreAnswer> {
    const port = (await findThisMachine(db, config))?.webPort ?? WEB_PORT;
    if (!ticket) return { here: true, port };
    return { folder: companyFolder((await linkOf(db))?.name ?? null, companyId), ticket, port, company: companyId };
  }

  /* A command for a machine of one's own that joins without a plan. */
  app.post('/api/machines/command', async (req, reply) => {
    const me = await requirePerson(req, db);
    reply.code(201);
    return createInstallCommand(db, config, me, { companyId: me.companyId, personId: me.id, subscriptionIds: [] });
  });

  /* One of the owner's own plans on one more of their machines: the command starts the plan's node there and signs in
     there, and works only on that machine. */
  app.post('/api/machines/:id/plans', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { subscription } = PlanBody.parse(req.body);
    const [machine] = await db.select().from(machines).where(and(eq(machines.id, id), isNull(machines.revokedAt), shownMachine(config)));
    if (!machine) throw new ApiError(404, 'not_found', 'This machine does not exist.', 'machine_unknown');
    if (machine.personId !== me.id) throw new ApiError(403, 'forbidden', 'Only the owner of this machine can do this.', 'not_owner');
    const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, subscription), eq(subscriptions.kind, 'personal'), isNull(subscriptions.removedAt)));
    if (!sub) throw new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
    if (sub.ownerPersonId !== me.id) throw new ApiError(403, 'forbidden', 'Only the owner of this subscription can do this.', 'not_owner');
    const [there] = await db.select(idOnly(nodes)).from(nodes).where(and(eq(nodes.machineId, machine.id), eq(nodes.subscriptionId, sub.id), liveNode));
    if (there) throw new ApiError(409, 'conflict', 'This subscription is on this machine already.', 'already_on_machine');
    reply.code(201);
    return createInstallCommand(db, config, me, { companyId: me.companyId, personId: me.id, subscriptionIds: [sub.id], machineId: machine.id });
  });

  /* The company's core for a machine joined before machines had one: a command for that machine alone, which brings
     the core and no node. Only the machine's owner may put Hornhoof's core on their computer. */
  app.post('/api/machines/:id/core', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const [machine] = await db.select().from(machines).where(and(eq(machines.id, id), isNull(machines.revokedAt), shownMachine(config), eq(machines.kind, 'computer')));
    if (!machine) throw new ApiError(404, 'not_found', 'This machine does not exist.', 'machine_unknown');
    if (machine.personId !== me.id) throw new ApiError(403, 'forbidden', 'Only the owner of this machine can do this.', 'not_owner');
    if (machine.networkId || isServerComputer(config, machine.machineKey)) {
      throw new ApiError(409, 'conflict', 'This machine is a full machine of the company already.', 'core_present');
    }
    reply.code(201);
    return createInstallCommand(db, config, me, { companyId: me.companyId, personId: me.id, subscriptionIds: [], machineId: machine.id, core: true });
  });

  nodeCommandRoutes(app, ctx);
  connectionRoutes(app, ctx);

  app.get('/api/machines', async req => {
    const me = await requirePerson(req, db);
    const live = and(eq(machines.companyId, me.companyId), isNull(machines.revokedAt), shownMachine(config));
    const rows = await db
      .select({ id: machines.id, hostname: machines.hostname, os: machines.os, arch: machines.arch, kind: machines.kind, lendsTests: machines.lendsTests, ownerId: people.id, ownerName: people.name, machineKey: machines.machineKey, networkId: machines.networkId, webPort: machines.webPort, path: machines.path, keepsBackups: machines.keepsBackups, heldBackups: machines.heldBackups, role: machines.role, uploadState: machines.uploadState })
      .from(machines)
      .innerJoin(people, eq(people.id, machines.personId))
      .where(me.scopeKind === 'company' ? live : and(live, eq(machines.personId, me.id)))
      .orderBy(machines.createdAt);
    const served = await machineNodes(db, me.companyId);
    const on = (machineId: string) => served.filter(n => n.machineId === machineId);
    const latest = (seen: (Date | null)[]) => seen.reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);
    /* What runs on each machine now: the employees whose program lives there, busy while a turn of theirs runs, and the
       parts of test and work runs it takes. A company key's employees are on the built-in node. */
    const placed = await runningAgents(ctx, me);
    const programHost = await builtinMachine(db, config.hostId, me.companyId, config.machineId);
    /* The built-in node of the machine this app runs on, and whether work that names a built-in node's machine, or none,
       as from before those were told apart, is on it. */
    const own = ownBuiltin(config);
    const onOwn = (machine: string | null): boolean => !machine || machine === machineOfServer(config);
    /* The server's own place in the network, as its keeper reported it, and the workers on its own network that said
       within the last day that they could not reach it there. */
    const refusing = () =>
      db
        .select(only(machines, 'hostname'))
        .from(machines)
        .where(and(live, eq(machines.role, 'worker'), eq(machines.directFails, true), gt(machines.reportAt, new Date(Date.now() - CORE_OFFER_MS))))
        .orderBy(machines.createdAt);
    const [ownRow, refused] = me.scopeKind === 'company' ? await Promise.all([findThisMachine(db, config), refusing()]) : [null, []];
    const refusedBy = refused.map(row => row.hostname);
    /* A computer joined before machines had the company's core is offered one by its owner, while its nodes are about. */
    const seenLately = (machineId: string) => on(machineId).some(n => n.lastSeenAt !== null && Date.now() - n.lastSeenAt.getTime() < CORE_OFFER_MS);
    const needsCore = (m: (typeof rows)[number]) => m.ownerId === me.id && m.kind === 'computer' && !m.networkId && !isServerComputer(config, m.machineKey) && seenLately(m.id);
    const serverMachine = me.scopeKind === 'company' ? programHost : null;
    /* Who holds the company's data, and each machine's part in it: for those who see the whole company. The card of
       the computer the server itself runs on says what the server's own row says. */
    const held = me.scopeKind === 'company' ? await holding(ctx) : null;
    const dataOf = (machineId: string) => held?.views.get(serverMachine?.id === machineId && ownRow ? ownRow.id : machineId) ?? null;
    const [company] = held ? await db.select(only(companies, 'name')).from(companies).where(eq(companies.id, me.companyId)) : [];
    const machineReplicas = (m: (typeof rows)[number]) => {
      if (!company) return undefined;
      const leads = m.id === ownRow?.id || m.id === serverMachine?.id;
      return replicasOf(ctx, m.id, !leads && (m.role === 'data' || m.uploadState !== null), company.name);
    };
    /* Each machine's computer access as this person sees it; the server's card carries its own machine's. */
    const access = await seenAccess(ctx, me);
    const accessOf = (machineId: string | undefined) => access.find(view => view.machine.id === machineId) ?? null;
    const sight = await viewerOf(db, me);
    const allParts = await db
      .select({ machineId: testParts.machineId, builtin: testParts.builtin, builtinMachine: testParts.builtinMachine, runBy: testRuns.agentId, run: testRuns.number, kind: testRuns.kind, task: tasks.number, part: testParts.part, parts: testRuns.parts, agent: agents.name, startedAt: testParts.startedAt })
      .from(testParts)
      .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
      .leftJoin(tasks, eq(tasks.id, testRuns.taskId))
      .leftJoin(agents, eq(agents.id, testRuns.agentId))
      .where(and(eq(testParts.companyId, me.companyId), eq(testParts.status, 'running')))
      .orderBy(asc(testParts.startedAt), asc(testRuns.number), asc(testParts.part));
    const parts = allParts.filter(p => seesAgentId(sight, p.runBy));
    const running = (holds: (a: (typeof placed)[number]) => boolean, runs: (p: (typeof parts)[number]) => boolean) => ({
      agents: placed.filter(holds).map(a => a.view),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip placement keys used only for filtering
      parts: parts.filter(runs).map(({ machineId: _, builtin: __, builtinMachine: ____, runBy: ___, ...p }) => p),
    });
    return {
      /* The node that comes with the server runs the company's API keys and test runs too, and names the company's machine
         it runs on, when the server is on one. */
      builtin:
        me.scopeKind === 'company'
          ? {
              online: hub.isOnline(own),
              load: together([hub.loadOf(own)]),
              replicas: { count: 0, bytes: 0, companies: [] },
              running: running(a => a.builtin && onOwn(a.builtinMachine), p => p.builtin && onOwn(p.builtinMachine)),
              machine: serverMachine,
              drain: nodeDrain(ctx, own),
              programs: programsFor(hub, [own]),
              browserError: hub.browserErrorOf(own),
              checkError: hub.checkErrorOf(own),
              webPort: ownRow?.webPort ?? null,
              refusedBy,
              access: accessOf(ownRow?.id),
            }
          : null,
      machines: rows.map(m => ({
        id: m.id,
        hostname: m.hostname,
        os: m.os,
        arch: m.arch,
        kind: m.kind,
        owner: { id: m.ownerId, name: m.ownerName },
        /* The machine the company was installed on, while the server runs on another: no computer someone joined. */
        serverInstall: isServerInstall(m.machineKey),
        ...machineState(hub, on(m.id).map(n => n.id)),
        ...machineProgramState(hub, on(m.id).map(n => n.id), m.id, programHost, own),
        otherBuild: otherBuild(hub, on(m.id).map(n => n.id), config.nodeBuild),
        lastSeenAt: latest(on(m.id).map(n => n.lastSeenAt)),
        plans: on(m.id).flatMap(n => (n.subscriptionId && n.provider ? [{ id: n.subscriptionId, provider: n.provider, status: n.status, online: hub.isOnline(nodeIdentity(n.id)) }] : [])),
        folders: machineFolders(hub, on(m.id)),
        lendsTests: m.lendsTests,
        /* Where the company opens on that machine, and how the machine reaches the server; none without the core. */
        core: m.networkId ? { webPort: m.webPort, path: m.path } : null,
        needsCore: needsCore(m),
        access: accessOf(m.id),
        ...(held ? { data: dataOf(m.id), replicas: machineReplicas(m) } : {}),
        /* Whether it keeps the company's backups, and how many it holds; none of either without the core. */
        keepsBackups: m.networkId ? m.keepsBackups : null,
        heldBackups: m.networkId ? m.heldBackups.length : null,
        drain: machineDrain(ctx, machineProgramNodes(on(m.id).map(n => n.id), m.id, programHost, own)),
        /* Its plans' nodes, its own built-in node when it keeps a copy of the data, and the server's when the server runs
           on it. */
        running: running(
          a => (a.builtin && (onOwn(a.builtinMachine) ? serverMachine?.id === m.id : a.builtinMachine === m.networkId)) || on(m.id).some(n => n.id === a.nodeId),
          p => (p.builtin ? (onOwn(p.builtinMachine) ? serverMachine?.id === m.id : p.builtinMachine === m.networkId) : p.machineId === m.id),
        ),
      })),
      ...(held ? { copies: held.copies } : {}),
      /* Whether this person sees the order the server passes on in. */
      priority: held !== null,
      /* The request to move the server, for everyone who sees machines, and whether this person may ask for one: the CEO
         or the orchestrator acting for him, while this app leads. */
      move: await moveView(db),
      canMove: me.isOwner && !me.viaHead && ctx.mode.current() === 'lead',
    };
  });

  const notCeo = () => new ApiError(403, 'forbidden', 'Only the CEO does this, by himself or through the orchestrator.', 'not_owner_session');

  /* A live machine its owner, or someone who sees the whole company, may change. */
  async function ownMachine(me: Awaited<ReturnType<typeof requirePerson>>, id: string) {
    const [machine] = await db.select().from(machines).where(and(eq(machines.id, id), eq(machines.companyId, me.companyId), isNull(machines.revokedAt), shownMachine(config)));
    if (!machine) throw new ApiError(404, 'not_found', 'This machine does not exist.', 'machine_unknown');
    if (machine.personId !== me.id && me.scopeKind !== 'company') throw new ApiError(403, 'forbidden', 'Only the owner of this machine can do this.', 'not_owner');
    return machine;
  }

  app.get('/api/machines/:id/removal', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const machine = await ownMachine(me, id);
    await refuseLeader(db, config, [id]);
    reply.header('cache-control', 'no-store');
    return removalWarnings(db, config, machine);
  });

  app.post('/api/machines/:id/disconnect', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    await ownMachine(me, id);
    await refuseLeader(db, config, [id]);
    await disconnectMachines(ctx, [id]);
    return reply.code(204).send();
  });

  /* The CEO's choice of a machine's place in the order the server passes on in: left to the score, a place by hand,
     or kept from the server. His alone, by himself or through the orchestrator. */
  app.put('/api/machines/:id/priority', async (req, reply) => {
    const me = await requirePerson(req, db);
    if (!me.isOwner || me.viaHead) throw notCeo();
    const { id } = IdParams.parse(req.params);
    const { pin } = PriorityBody.parse(req.body);
    await ownMachine(me, id);
    await setPriority(ctx, id, pin);
    return reply.code(204).send();
  });

  /* The CEO's request to move the server to this machine, and its taking off. His alone, by himself or through the
     orchestrator. */
  app.post('/api/machines/:id/move', async (req, reply) => {
    const me = await requirePerson(req, db);
    if (!me.isOwner || me.viaHead) throw notCeo();
    const { id } = IdParams.parse(req.params);
    await ownMachine(me, id);
    await askMove(ctx, id, me.id);
    return reply.code(202).send({ state: 'preparing' });
  });

  app.delete('/api/machines/:id/move', async (req, reply) => {
    const me = await requirePerson(req, db);
    if (!me.isOwner || me.viaHead) throw notCeo();
    const { id } = IdParams.parse(req.params);
    await ownMachine(me, id);
    await cancelMove(ctx, id);
    return reply.code(204).send();
  });

  /* Whether the machine takes the company's test runs, and whether it keeps the company's backups. A machine lent again
     may take a run that waits. */
  app.patch('/api/machines/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const ticks = TicksBody.parse(req.body);
    await ownMachine(me, id);
    const [now] = await db.update(machines).set(ticks).where(eq(machines.id, id)).returning({ lendsTests: machines.lendsTests, keepsBackups: machines.keepsBackups });
    if (ticks.lendsTests) await pumpTests(ctx);
    return now;
  });

  const imageOf = (part: 'node' | 'updater') => nodeImageOfBuild({
    image: config.image,
    commit: config.commit,
    part,
    digestOf: async tag => (await ctx.updates.siblings(tag))[part],
    onError: err => app.log.warn({ error: loggable(err) }, `Could not read this build's ${part} image from the registry, so install.sh names it by its tag.`),
  });
  const nodeImage = imageOf('node');
  const updaterImage = imageOf('updater');

  /* Every command that installs or updates a node runs this script, so the machine gets the node of this server's build, and
     the updater of the nodes reads it for the same. The hash of the server's own computer tells nothing of its key. */
  app.get('/install.sh', async (_req, reply) => {
    const script = await readFile(config.installScript, 'utf8');
    const server = await publicUrl(db, config);
    const [image, updater] = await Promise.all([nodeImage(), updaterImage()]);
    return reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(script.replaceAll('__HORNHOOF_SERVER__', server).replaceAll('__HORNHOOF_NODE_IMAGE__', image).replaceAll('__HORNHOOF_UPDATER_IMAGE__', updater)
        .replaceAll('__HORNHOOF_HOST_ID__', config.hostId ?? ''));
  });

  /* The command on Windows runs this one, which runs the same install.sh in a container of the updater image of this build. */
  app.get('/install.ps1', async (_req, reply) => {
    const script = await readFile(join(dirname(config.installScript), 'install.ps1'), 'utf8');
    const [server, updater] = await Promise.all([publicUrl(db, config), updaterImage()]);
    return reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(script.replaceAll('__HORNHOOF_SERVER__', server).replaceAll('__HORNHOOF_UPDATER_IMAGE__', updater));
  });
}
