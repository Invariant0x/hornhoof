import { readFile } from 'node:fs/promises';
import { MACHINE_KINDS } from '@hornhoof/protocol';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { seesAgentId, viewerOf } from '../../auth/agent-view.js';
import { requirePerson } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { agents, machines, nodeCodes, nodes, people, subscriptions, tasks, testParts, testRuns, type Provider } from '../../db/schema.js';
import { ApiError, loggable } from '../../errors.js';
import { runningAgents } from '../agents/running.js';
import { publicUrl } from '../link/link.js';
import { machineNodes, machineState, together } from '../testruns/load.js';
import { pumpTests } from '../testruns/runs.js';
import { createInstallCommand } from './command.js';
import { nodeCommandRoutes } from './command-routes.js';
import { connectionRoutes } from './connection-routes.js';
import { disconnectMachines } from './disconnect.js';
import { BUILTIN, nodeIdentity, type NodeHub } from './hub.js';
import { nodeImageOfBuild } from './image.js';
import { builtinMachine, liveNode, otherBuild, settlePlans } from './nodes.js';
import { machineProgramNodes, machineProgramState, machineProgramRoutes, programsFor } from './programs.js';
import { machineDrain, nodeDrain } from '../updates/drain.js';

const JoinBody = z.object({
  code: z.string().min(1).max(200),
  machineId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  hostname: z.string().trim().min(1).max(120),
  os: z.enum(['linux', 'darwin']),
  arch: z.enum(['arm64', 'x86_64']),
  kind: z.enum(MACHINE_KINDS).default('computer'),
});

const IdParams = z.object({ id: z.uuid() });
export const LendBody = z.object({ lendsTests: z.boolean() }).strict();
export const PlanBody = z.object({ subscription: z.uuid() }).strict();

const codeUsed = () => new ApiError(410, 'gone', 'This install command was already used or has expired. Get a new one in Hornhoof.', 'code_used');
const alreadyThere = () => new ApiError(409, 'conflict', 'This machine runs it already.', 'already_on_machine');

/* The node of this plan, or this machine's own, on this machine with a new key. One that was here before keeps its id,
   so the installer finds its container and sign-in again. A plan's first node takes the plan's id, as nodes had before
   they had rows of their own. None while the node has a key: a machine key and a command are all a join shows, so a
   second command must not take a working node over. */
async function keyNode(tx: Db, at: { companyId: string; machineId: string; subscriptionId: string | null }, keyHash: string): Promise<string | null> {
  const [had] = at.subscriptionId ? await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.subscriptionId, at.subscriptionId)).limit(1) : [];
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
    const [owner] = await db.select({ status: people.status }).from(people).where(eq(people.id, code.personId));
    if (owner?.status !== 'active') throw codeUsed();
    /* A command to add plans to one machine is left unused on any other. */
    if (code.machineId) {
      const [meant] = await db.select().from(machines).where(eq(machines.id, code.machineId));
      if (!meant || meant.machineKey !== body.machineId || meant.personId !== code.personId) {
        throw new ApiError(409, 'conflict', `This command is for the machine ${meant?.hostname ?? ''}. Run it there.`, 'other_machine');
      }
    }

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
        await tx.select({ id: subscriptions.id }).from(subscriptions).where(inArray(subscriptions.id, code.subscriptionIds)).orderBy(asc(subscriptions.id)).for('update');
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
        .onConflictDoUpdate({ target: [machines.personId, machines.machineKey], set: { ...details, revokedAt: null } })
        .returning({ id: machines.id });

      /* The machine's own node has no plan: it takes test runs, and the machine its owner's plans later. */
      if (alone) {
        const key = newToken();
        const nodeId = await keyNode(tx, { companyId: code.companyId, machineId: machine!.id, subscriptionId: null }, hashToken(key));
        if (!nodeId) throw alreadyThere();
        return { machine: { id: machine!.id }, nodes: [{ nodeId, subscriptionId: null, provider: 'machine' as const, key }] };
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
      return { machine: { id: machine!.id }, nodes: made };
    });
    closeJoined(hub, joined.nodes);

    /* One line per node: the installer names its container after the node. */
    if (req.headers.accept?.includes('text/plain')) {
      return reply.type('text/plain; charset=utf-8').send(joined.nodes.map(n => `${n.nodeId} ${n.provider} ${n.key}\n`).join(''));
    }
    return joined;
  });

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
    const [machine] = await db.select().from(machines).where(and(eq(machines.id, id), isNull(machines.revokedAt)));
    if (!machine) throw new ApiError(404, 'not_found', 'This machine does not exist.', 'machine_unknown');
    if (machine.personId !== me.id) throw new ApiError(403, 'forbidden', 'Only the owner of this machine can do this.', 'not_owner');
    const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, subscription), eq(subscriptions.kind, 'personal'), isNull(subscriptions.removedAt)));
    if (!sub) throw new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
    if (sub.ownerPersonId !== me.id) throw new ApiError(403, 'forbidden', 'Only the owner of this subscription can do this.', 'not_owner');
    const [there] = await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.machineId, machine.id), eq(nodes.subscriptionId, sub.id), liveNode));
    if (there) throw new ApiError(409, 'conflict', 'This subscription is on this machine already.', 'already_on_machine');
    reply.code(201);
    return createInstallCommand(db, config, me, { companyId: me.companyId, personId: me.id, subscriptionIds: [sub.id], machineId: machine.id });
  });

  nodeCommandRoutes(app, ctx);
  connectionRoutes(app, ctx);

  app.get('/api/machines', async req => {
    const me = await requirePerson(req, db);
    const live = isNull(machines.revokedAt);
    const rows = await db
      .select({ id: machines.id, hostname: machines.hostname, os: machines.os, arch: machines.arch, kind: machines.kind, lendsTests: machines.lendsTests, ownerId: people.id, ownerName: people.name })
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
    const programHost = await builtinMachine(db, config.hostId, me.companyId);
    const serverMachine = me.scopeKind === 'company' ? programHost : null;
    const sight = await viewerOf(db, me);
    const allParts = await db
      .select({ machineId: testParts.machineId, builtin: testParts.builtin, runBy: testRuns.agentId, run: testRuns.number, kind: testRuns.kind, task: tasks.number, part: testParts.part, parts: testRuns.parts, agent: agents.name, startedAt: testParts.startedAt })
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
      parts: parts.filter(runs).map(({ machineId: _, builtin: __, runBy: ___, ...p }) => p),
    });
    return {
      /* The node that comes with the server runs the company's API keys and test runs too, and names the company's machine
         it runs on, when the server is on one. */
      builtin:
        me.scopeKind === 'company'
          ? {
              online: hub.isOnline(BUILTIN),
              load: together([hub.loadOf(BUILTIN)]),
              running: running(a => Boolean(a.builtin), p => p.builtin),
              machine: serverMachine,
              drain: nodeDrain(ctx, BUILTIN),
              programs: programsFor(hub, [BUILTIN]),
              browserError: hub.browserErrorOf(BUILTIN),
            }
          : null,
      machines: rows.map(m => ({
        id: m.id,
        hostname: m.hostname,
        os: m.os,
        arch: m.arch,
        kind: m.kind,
        owner: { id: m.ownerId, name: m.ownerName },
        ...machineState(hub, on(m.id).map(n => n.id)),
        ...machineProgramState(hub, on(m.id).map(n => n.id), m.id, programHost),
        otherBuild: otherBuild(hub, on(m.id).map(n => n.id), config.nodeBuild),
        lastSeenAt: latest(on(m.id).map(n => n.lastSeenAt)),
        plans: on(m.id).flatMap(n => (n.subscriptionId && n.provider ? [{ id: n.subscriptionId, provider: n.provider, status: n.status, online: hub.isOnline(nodeIdentity(n.id)) }] : [])),
        lendsTests: m.lendsTests,
        drain: machineDrain(ctx, machineProgramNodes(on(m.id).map(n => n.id), m.id, programHost)),
        running: running(a => (a.builtin && serverMachine?.id === m.id) || on(m.id).some(n => n.id === a.nodeId), p => p.machineId === m.id || (p.builtin && serverMachine?.id === m.id)),
      })),
    };
  });

  /* A live machine its owner, or someone who sees the whole company, may change. */
  async function ownMachine(me: Awaited<ReturnType<typeof requirePerson>>, id: string) {
    const [machine] = await db.select().from(machines).where(and(eq(machines.id, id), isNull(machines.revokedAt)));
    if (!machine) throw new ApiError(404, 'not_found', 'This machine does not exist.', 'machine_unknown');
    if (machine.personId !== me.id && me.scopeKind !== 'company') throw new ApiError(403, 'forbidden', 'Only the owner of this machine can do this.', 'not_owner');
    return machine;
  }

  app.post('/api/machines/:id/disconnect', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    await ownMachine(me, id);
    await disconnectMachines(ctx, [id]);
    return reply.code(204).send();
  });

  /* Whether the machine takes the company's test runs. A machine lent again may take a run that waits. */
  app.patch('/api/machines/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { lendsTests } = LendBody.parse(req.body);
    await ownMachine(me, id);
    await db.update(machines).set({ lendsTests }).where(eq(machines.id, id));
    if (lendsTests) await pumpTests(ctx);
    return { lendsTests };
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
}
