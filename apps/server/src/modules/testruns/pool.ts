import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { seesAgentId, viewerOf } from '../../auth/agent-view.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { agents, machines, people, tasks, testParts, testRuns } from '../../db/schema.js';
import { builtinOf, nodeIdentity, ownBuiltin, ownMachine, type NodeIdentity } from '../nodes/hub.js';
import { builtinName } from '../nodes/builtin.js';
import { builtinMachine, shownMachine } from '../nodes/nodes.js';
import { computerKey, runBlock, type RunBlock } from './capacity.js';
import { machineNodes, machineState, productPlaces, together } from './load.js';
import { needOf, partBudget, type PartNeed } from './part-budget.js';
import { loaded } from './pick.js';
import { browserHeldRun, commandFor, lostLine, placesOf, reaches, targetOf, type Place } from './runs.js';

type Run = typeof testRuns.$inferSelect;
type Row = { part: typeof testParts.$inferSelect; run: Run; task: number; agent: string };

/* The pool shows what runs, not how: a longer command is cut. */
const SHOWN_COMMAND = 200;
/* Machines named for one reason a part waits; the rest are counted. */
const SHOWN_NAMES = 5;

const cut = (command: string) => (command.length > SHOWN_COMMAND ? `${command.slice(0, SHOWN_COMMAND)}...` : command);
const names = (list: string[]) => list.slice(0, SHOWN_NAMES).join(', ') + (list.length > SHOWN_NAMES ? ` and ${list.length - SHOWN_NAMES} more` : '');

/* A part as the pool shows it: whose run, for which task, and what it runs. */
const view = ({ part, run, task, agent }: Row) => ({
  run: run.number,
  kind: run.kind,
  task,
  part: part.part,
  parts: run.parts,
  agent,
  command: cut(commandFor(run, part.part)),
  commit: run.commitSha,
  ranAgain: part.lost.map(lostLine),
});
const running = (row: Row) => ({ ...view(row), startedAt: row.part.startedAt?.toISOString() ?? null });

type Targets = Map<string, Awaited<ReturnType<typeof targetOf>>>;

/* What a run needs is read once a round, however many of its parts wait. */
async function targetIn(ctx: Ctx, targets: Targets, run: Run) {
  if (!targets.has(run.id)) targets.set(run.id, await targetOf(ctx, run));
  return targets.get(run.id)!;
}

function whyNoRoom(places: Place[], need: PartNeed, memoryGb: number, limit?: number): string {
  const reasons: Record<RunBlock, string[]> = { node: [], memory: [], cores: [], limit: [] };
  for (const place of places) {
    const block = runBlock(place, need, limit);
    if (block === null) return 'A machine is free for it: it goes out in a moment.';
    reasons[block].push(place.name);
  }
  return [
    reasons.node.length ? `The node's test user is busy: ${names(reasons.node)}.` : '',
    reasons.memory.length ? `Short of the ${memoryGb} GB of free memory it needs: ${names(reasons.memory)}.` : '',
    reasons.cores.length ? `Short of free cores (needs ${need.cores}): ${names(reasons.cores)}.` : '',
    reasons.limit.length ? `At the configured limit of ${limit} parts: ${names(reasons.limit)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/* Why no machine took a waiting part in the last round, from the machines online now. */
async function whyWaits(ctx: Ctx, places: Place[], { run, part }: Row, targets: Targets): Promise<string> {
  const target = await targetIn(ctx, targets, run);
  if (!target) return 'Its repository is gone: it ends with the next round.';
  const heldReason = await browserHeldRun(ctx, run.companyId, places, run, target.department);
  if (heldReason) return heldReason;
  const lent = places.filter(p => p.lent);
  if (!lent.length) return 'No computer lent to runs is online.';
  const reach = lent.filter(p => reaches(p, target.department));
  if (!reach.length) return `No lent machine online belongs to someone who reaches ${target.department ? 'its department' : 'the whole company'}.`;
  const able = run.kind === 'work' ? reach.filter(p => p.works) : reach;
  if (!able.length) return 'The lent machines online that may take it run a node too old for work: update their node.';
  const memoryGb = needOf(run, target.department);
  const need = partBudget(memoryGb, run.environmentSnapshot?.description.manifest, part.environmentSelection?.selection);
  const candidates = await productPlaces(ctx, able, run, need.memoryBytes);
  if (!candidates.length) return 'No lent machine online has the test runtimes this part needs.';
  const planned = part.lost.length ? [] : candidates.filter(place => computerKey(place) === part.environmentSelection?.computer);
  return whyNoRoom(planned.length ? planned : candidates, need, memoryGb, ctx.config.runsPerHost);
}

/* The company's machines, each with how busy it is and the parts of runs it runs, the built-in node, and the parts that
   wait for a machine with why each waits. Someone who does not see the whole company sees only their own machines, and
   anyone sees only the parts of agents they see. */
export async function poolOf(ctx: Ctx, who: Person) {
  const { db, hub } = ctx;
  const whole = who.scopeKind === 'company';
  const live = and(eq(machines.companyId, who.companyId), isNull(machines.revokedAt), shownMachine(ctx.config));
  const rows = await db
    .select({ id: machines.id, name: machines.hostname, kind: machines.kind, lent: machines.lendsTests, owner: people.name })
    .from(machines)
    .innerJoin(people, eq(people.id, machines.personId))
    .where(whole ? live : and(live, eq(machines.personId, who.id)))
    .orderBy(asc(machines.createdAt));
  const served = await machineNodes(db, who.companyId);
  const sight = await viewerOf(db, who);
  const allOpen: Row[] = await db
    .select({ part: testParts, run: testRuns, task: tasks.number, agent: agents.name })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .innerJoin(agents, eq(agents.id, testRuns.agentId))
    .where(and(eq(testParts.companyId, who.companyId), inArray(testParts.status, ['running', 'queued'])))
    .orderBy(asc(testRuns.createdAt), asc(testParts.part));
  const open = allOpen.filter(r => seesAgentId(sight, r.run.agentId));
  const ownId = ownMachine(ctx.config);
  /* What runs on a machine's nodes, and what runs on a machine's built-in node: a part from before those were told apart
     ran on this server's own. */
  const on = (machineId: string) => open.filter(r => r.part.status === 'running' && !r.part.builtin && r.part.machineId === machineId).map(running);
  const onBuiltin = (machine: string) => open.filter(r => r.part.status === 'running' && r.part.builtin && (r.part.builtinMachine ?? ownId) === machine).map(running);
  const loadOf = (ids: NodeIdentity[]) => together(ids.map(id => hub.loadOf(id)));

  const places = whole ? await placesOf(ctx, who.companyId) : [];
  const targets = new Map<string, Awaited<ReturnType<typeof targetOf>>>();
  const waiting = [];
  for (const row of whole ? open.filter(r => r.part.status === 'queued') : []) {
    waiting.push({ ...view(row), waitingSince: row.part.queuedAt.toISOString(), why: await whyWaits(ctx, places, row, targets) });
  }
  const own = ownBuiltin(ctx.config);
  const builtinLoad = loadOf([own]);
  const others = hub.builtins().filter(machine => machine !== ownId).sort();
  const builtinPlace = async (machine: string) => {
    const node = builtinOf(machine);
    const load = loadOf([node]);
    return { machine, name: await builtinName(ctx, db, machine), online: hub.isOnline(node), noRuns: hub.noRunsOf(node), load, loaded: load ? loaded(load) : false, parts: onBuiltin(machine) };
  };
  const host = whole ? await builtinMachine(db, ctx.config.hostId, who.companyId, ctx.config.machineId) : null;
  return {
    machines: rows.map(m => {
      const mine = served.filter(n => n.machineId === m.id).map(n => n.id);
      const { online, load } = machineState(hub, mine);
      const ids = mine.map(id => nodeIdentity(id));
      /* Why it takes no part of any run: what its nodes said, unless one of them takes parts. */
      const noRuns = ids.some(id => hub.isOnline(id) && hub.noRunsOf(id) === null) ? null : (ids.map(id => hub.noRunsOf(id)).find(Boolean) ?? null);
      return { id: m.id, name: m.name || 'a machine', owner: m.owner, kind: m.kind, online, lent: m.lent, noRuns, load, loaded: load ? loaded(load) : false, parts: on(m.id) };
    }),
    /* The node that comes with the server takes parts too. machine: the company's machine it runs on, which the pool
       counts once. */
    builtin: whole
      ? {
          online: hub.isOnline(own),
          noRuns: hub.noRunsOf(own),
          load: builtinLoad,
          loaded: builtinLoad ? loaded(builtinLoad) : false,
          parts: onBuiltin(ownId),
          machine: host && { id: host.id, name: host.hostname },
        }
      : null,
    /* The built-in nodes of the other machines that hold the company's data, which take parts too. */
    builtins: whole ? await Promise.all(others.map(machine => builtinPlace(machine))) : [],
    waiting,
  };
}

export function poolRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/pool', async req => poolOf(ctx, await requirePerson(req, ctx.db)));
}
