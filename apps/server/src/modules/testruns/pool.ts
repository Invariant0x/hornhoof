import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { agents, machines, nodes, people, tasks, testParts, testRuns } from '../../db/schema.js';
import { BUILTIN, nodeIdentity, type NodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';
import { together } from './load.js';
import { loaded } from './pick.js';
import { commandFor, lostLine, needOf, placesOf, reaches, targetOf, type Place } from './runs.js';

type Run = typeof testRuns.$inferSelect;
type Row = { part: typeof testParts.$inferSelect; run: Run; task: number; agent: string };

const GIB = 1024 ** 3;
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
  ranAgain: part.lost.map(lostLine),
});
const running = (row: Row) => ({ ...view(row), startedAt: row.part.startedAt?.toISOString() ?? null });

/* Why no machine took a waiting part in the last round, from the machines online now. */
async function whyWaits(ctx: Ctx, places: Place[], run: Run, targets: Map<string, Awaited<ReturnType<typeof targetOf>>>): Promise<string> {
  if (!targets.has(run.id)) targets.set(run.id, await targetOf(ctx, run));
  const target = targets.get(run.id)!;
  if (!target) return 'Its repository is gone: it ends with the next round.';
  const lent = places.filter(p => p.lent);
  if (!lent.length) return 'No machine lent to runs is online.';
  const reach = lent.filter(p => reaches(p, target.department));
  if (!reach.length) return `No lent machine online belongs to someone who reaches ${target.department ? 'its department' : 'the whole company'}.`;
  const able = run.kind === 'work' ? reach.filter(p => p.works) : reach;
  if (!able.length) return 'The lent machines online that may take it run a node too old for work: update their node.';
  const need = needOf(run, target.department);
  const [busy, hot, short]: string[][] = [[], [], []];
  for (const p of able) {
    if (p.busy) busy.push(p.name);
    else if (p.load && loaded(p.load)) hot.push(p.name);
    else if (!p.load || p.load.memFree < need * GIB) short.push(p.name);
    else return 'A machine is free for it: it goes out in a moment.';
  }
  return [
    busy.length ? `Running another part: ${names(busy)}.` : '',
    hot.length ? `Loaded: ${names(hot)}.` : '',
    short.length ? `Short of the ${need} GB of free memory it needs: ${names(short)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/* The company's machines, each with how busy it is and the parts of runs it runs, the built-in node, and the parts that
   wait for a machine with why each waits. Someone who does not see the whole company sees only their own machines. */
export async function poolOf(ctx: Ctx, who: Pick<Person, 'id' | 'companyId' | 'scopeKind'>) {
  const { db, hub } = ctx;
  const whole = who.scopeKind === 'company';
  const live = and(eq(machines.companyId, who.companyId), isNull(machines.revokedAt));
  const rows = await db
    .select({ id: machines.id, name: machines.hostname, lent: machines.lendsTests, owner: people.name })
    .from(machines)
    .innerJoin(people, eq(people.id, machines.personId))
    .where(whole ? live : and(live, eq(machines.personId, who.id)))
    .orderBy(asc(machines.createdAt));
  const served = await db
    .select({ id: nodes.id, machineId: nodes.machineId })
    .from(nodes)
    .where(and(eq(nodes.companyId, who.companyId), liveNode));
  const open: Row[] = await db
    .select({ part: testParts, run: testRuns, task: tasks.number, agent: agents.name })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .innerJoin(agents, eq(agents.id, testRuns.agentId))
    .where(and(eq(testParts.companyId, who.companyId), inArray(testParts.status, ['running', 'queued'])))
    .orderBy(asc(testRuns.createdAt), asc(testParts.part));
  const on = (machineId: string | null, builtin = false) => open.filter(r => r.part.status === 'running' && (builtin ? r.part.builtin : r.part.machineId === machineId)).map(running);
  const loadOf = (ids: NodeIdentity[]) => together(ids.map(id => hub.loadOf(id)));

  const places = whole ? await placesOf(ctx, who.companyId) : [];
  const targets = new Map<string, Awaited<ReturnType<typeof targetOf>>>();
  const waiting = [];
  for (const row of whole ? open.filter(r => r.part.status === 'queued') : []) {
    waiting.push({ ...view(row), waitingSince: row.part.queuedAt.toISOString(), why: await whyWaits(ctx, places, row.run, targets) });
  }
  const builtinLoad = loadOf([BUILTIN]);
  return {
    machines: rows.map(m => {
      const ids = served.filter(n => n.machineId === m.id).map(n => nodeIdentity(n.id));
      const load = loadOf(ids);
      return { id: m.id, name: m.name || 'a machine', owner: m.owner, online: ids.some(id => hub.isOnline(id)), lent: m.lent, load, loaded: load ? loaded(load) : false, parts: on(m.id) };
    }),
    /* The node that comes with the server takes parts too. */
    builtin: whole ? { online: hub.isOnline(BUILTIN), load: builtinLoad, loaded: builtinLoad ? loaded(builtinLoad) : false, parts: on(null, true) } : null,
    waiting,
  };
}

export function poolRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/pool', async req => poolOf(ctx, await requirePerson(req, ctx.db)));
}
