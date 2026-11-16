import type { WorkLine } from '@hornhoof/protocol';
import { and, asc, eq, gte, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, companies, departments, jobs, mapReturns, requests, tasks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { GONE_ALONG } from '../conversation/queue.js';

/* The lines of the company map, kept apart from the pulses of single messages: a line is blue while the one below works on
   an assignment, and yellow for a while after it gave back a result. Lines run from the orchestrator to each department's
   head, and from a head to each employee of its department, a product's employees included. */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Db | Tx;

type Agent = Pick<typeof agents.$inferSelect, 'id' | 'companyId' | 'kind' | 'departmentId' | 'productId' | 'teamId' | 'switchedOffAt' | 'removedAt'>;
type Line = typeof mapReturns.$inferSelect;
type TaskFacts = Pick<typeof tasks.$inferSelect, 'id' | 'parentId' | 'status' | 'executorAgentId' | 'assigneeAgentId' | 'after'>;

/* What decides whether an agent acts on a task now: the tasks with those above them, the tasks still to be done first,
   and the questions each agent waits on, as agentId:taskId. */
export type Facts = { tasks: ReadonlyMap<string, TaskFacts>; notDone: ReadonlySet<string>; asked: ReadonlySet<string> };

const LIVE = ['open', 'working'];
/* A department task in one of these no longer keeps its department's line on with the work under it. */
const OVER = ['blocked', 'done', 'cancelled'];
/* How far up a task's parents are followed; the engine refuses circles, this only bounds a broken chain. */
const DEPTH = 50;

const ready = (f: Facts, t: TaskFacts) => !t.after.some(id => f.notDone.has(id));
const asking = (f: Facts, agentId: string, t: TaskFacts) => f.asked.has(`${agentId}:${t.id}`);

/* An employee acts on the task while it holds it: as its producer, or as the owner of its current checking stage, Tests
   included, which holds it until it hands it on; and neither waiting for the tasks it comes after nor for a person's
   answer. */
export function memberActs(f: Facts, agentId: string, taskId: string | null): boolean {
  const t = taskId ? f.tasks.get(taskId) : undefined;
  if (!t || !ready(f, t) || asking(f, agentId, t)) return false;
  return t.assigneeAgentId === agentId && [...LIVE, 'review'].includes(t.status);
}

/* The department task the task is part of: itself, or the nearest task above it that has no executor. */
function rootOf(f: Facts, t: TaskFacts): TaskFacts | null {
  let at: TaskFacts | undefined = t;
  for (let hops = 0; at && hops < DEPTH; hops++) {
    if (!at.executorAgentId) return at;
    at = at.parentId ? f.tasks.get(at.parentId) : undefined;
  }
  return null;
}

/* A head acts on the task when it is part of a department task it holds that can go on: not blocked, not over, not
   waiting for the tasks it comes after or for the head's own question. */
export function headActs(f: Facts, headId: string, taskId: string | null): boolean {
  const t = taskId ? f.tasks.get(taskId) : undefined;
  const root = t && rootOf(f, t);
  return !!root && root.assigneeAgentId === headId && LIVE.includes(root.status) && ready(f, root) && !asking(f, headId, root);
}

/* An employee's work keeps its department's line on unless the department task above it is blocked or over. */
export function underLiveRoot(f: Facts, taskId: string | null): boolean {
  const t = taskId ? f.tasks.get(taskId) : undefined;
  if (!t) return false;
  const root = rootOf(f, t);
  return !root || !OVER.includes(root.status);
}

/* The turn that handed a task in along the line, while it still runs, is not new work on that task. A message gives no
   task back: its turn goes on with its work, and the line turns yellow once that ends. */
function givenBack(line: Line | undefined, jobId: string, taskId: string | null): boolean {
  return !!line?.sourceTaskId && line.sourceTaskId === taskId && line.sourceJobId === jobId;
}

const topOf = (parents: ReadonlyMap<string, string | null>, departmentId: string | null) => (departmentId ? (parents.get(departmentId) ?? departmentId) : null);

async function orchestratorOf(db: Reader, companyId: string): Promise<string | null> {
  const [orchestrator] = await db
    .select(idOnly(agents))
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  return orchestrator?.id ?? null;
}

/* The head of the employee's department, of the department holding it when it works on a product. */
async function headOf(db: Reader, agent: Agent): Promise<string | null> {
  if (!agent.departmentId) return null;
  const [dept] = await db.select({ parentId: departments.parentId }).from(departments).where(eq(departments.id, agent.departmentId));
  const top = dept?.parentId ?? agent.departmentId;
  const [head] = await db
    .select(idOnly(agents))
    .from(agents)
    .where(and(eq(agents.companyId, agent.companyId), eq(agents.kind, 'head'), eq(agents.departmentId, top), isNull(agents.removedAt)));
  return head?.id ?? null;
}

/* The agent above this one on the map: the orchestrator above a head, the head of its department above an employee. */
async function above(db: Reader, agent: Agent): Promise<string | null> {
  if (agent.removedAt) return null;
  if (agent.kind === 'head') return orchestratorOf(db, agent.companyId);
  return agent.kind === 'worker' ? headOf(db, agent) : null;
}

async function agentOf(db: Reader, id: string): Promise<Agent | null> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  return agent ?? null;
}

type Ends = { companyId: string; upstreamAgentId: string; downstreamAgentId: string };

const lineWhere = (e: Ends) => and(eq(mapReturns.companyId, e.companyId), eq(mapReturns.upstreamAgentId, e.upstreamAgentId), eq(mapReturns.downstreamAgentId, e.downstreamAgentId));

/* The line's row, made when it has none, and held until the transaction ends so moves on it go one at a time. */
async function locked(tx: Tx, e: Ends): Promise<Line> {
  const [existing] = await tx.select().from(mapReturns).where(lineWhere(e)).for('no key update');
  if (existing) return existing;
  await tx.insert(mapReturns).values({ companyId: e.companyId, upstreamAgentId: e.upstreamAgentId, downstreamAgentId: e.downstreamAgentId }).onConflictDoNothing();
  const [row] = await tx.select().from(mapReturns).where(lineWhere(e)).for('no key update');
  return row!;
}

/* New work started on the line: it begins a new cycle, once per turn however often that turn's start is told. */
export async function recordMapWorkStarted(tx: Tx, s: Ends & { jobId: string }): Promise<boolean> {
  const row = await locked(tx, s);
  if (row.workJobId === s.jobId) return false;
  await tx
    .update(mapReturns)
    .set({ workEpoch: row.workEpoch + 1, workJobId: s.jobId })
    .where(lineWhere(s));
  return true;
}

export type MapReturn = Ends & { workEpoch: number; sourceKey: string; sourceJobId: string | null; sourceTaskId: string | null; returnedAt: Date };

/* What a return keeps off the line while its turn runs: the task it handed in. A message hands none in, so the task the
   turn handed in before it stays off. */
const handedIn = (r: MapReturn) => (r.sourceTaskId ? { sourceJobId: r.sourceJobId, sourceTaskId: r.sourceTaskId } : {});

async function writeMapReturn(tx: Tx, row: Line, r: MapReturn): Promise<void> {
  if (row.sourceKey === r.sourceKey || r.workEpoch !== row.workEpoch) return;
  if (row.returnedEpoch === r.workEpoch && row.returnedAt && row.returnedAt.getTime() > r.returnedAt.getTime()) return;
  await tx
    .update(mapReturns)
    .set({ returnedEpoch: r.workEpoch, returnedAt: r.returnedAt, sourceKey: r.sourceKey, ...handedIn(r) })
    .where(lineWhere(r));
}

/* A result came back along the line in the given cycle. Only a line from an agent to the one right above it takes one.
   The same source again changes nothing, and neither does one older than the line's latest, by cycle and then by time. */
export async function recordMapReturn(tx: Tx, r: MapReturn): Promise<void> {
  const below = await agentOf(tx, r.downstreamAgentId);
  if (!below || below.companyId !== r.companyId || (await above(tx, below)) !== r.upstreamAgentId) throw new Error('A result goes back only along a line of the map.');
  await writeMapReturn(tx, await locked(tx, r), r);
}

/* The agent gave a result back to the one above it: in the cycle the line is in now, with the turn it runs. False when it
   has nobody above it on the map, or when to names someone else than the one above it. */
export async function returnAlongLine(tx: Tx, r: { agentId: string; sourceKey: string; sourceTaskId: string | null; returnedAt: Date; to?: string }): Promise<boolean> {
  const agent = await agentOf(tx, r.agentId);
  const up = agent && (await above(tx, agent));
  if (!agent || !up || (r.to !== undefined && r.to !== up)) return false;
  const ends = { companyId: agent.companyId, upstreamAgentId: up, downstreamAgentId: agent.id };
  const line = await locked(tx, ends);
  const [turn] = await tx
    .select(idOnly(jobs))
    .from(jobs)
    .where(and(eq(jobs.agentId, agent.id), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running')))
    .limit(1);
  await writeMapReturn(tx, line, { ...ends, workEpoch: line.workEpoch, sourceKey: r.sourceKey, sourceJobId: turn?.id ?? null, sourceTaskId: r.sourceTaskId, returnedAt: r.returnedAt });
  return true;
}

/* The facts about these tasks and those above them that say who acts on them. */
async function factsFor(db: Reader, companyId: string, ids: string[]): Promise<Facts> {
  const found = new Map<string, TaskFacts>();
  const columns = { id: tasks.id, parentId: tasks.parentId, status: tasks.status, executorAgentId: tasks.executorAgentId, assigneeAgentId: tasks.assigneeAgentId, after: tasks.after };
  let wanted = [...new Set(ids)];
  for (let hops = 0; wanted.length && hops < DEPTH; hops++) {
    const rows = await db.select(columns).from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.id, wanted)));
    for (const t of rows) found.set(t.id, t);
    wanted = [...new Set(rows.flatMap(t => (t.parentId && !found.has(t.parentId) ? [t.parentId] : [])))];
  }
  return withDependencies(db, companyId, found);
}

async function withDependencies(db: Reader, companyId: string, found: Map<string, TaskFacts>): Promise<Facts> {
  const firstIds = [...new Set([...found.values()].flatMap(t => t.after))];
  const notDone = firstIds.length ? (await db.select(idOnly(tasks)).from(tasks).where(and(inArray(tasks.id, firstIds), notInArray(tasks.status, ['done'])))).map(t => t.id) : [];
  const ids = [...found.keys()];
  const asked = ids.length
    ? await db
        .select({ agentId: requests.agentId, taskId: requests.taskId })
        .from(requests)
        .where(and(eq(requests.companyId, companyId), eq(requests.status, 'open'), inArray(requests.taskId, ids)))
    : [];
  return { tasks: found, notDone: new Set(notDone), asked: new Set(asked.map(r => `${r.agentId}:${r.taskId}`)) };
}

/* The lines the agent's turn on the task keeps on: its own while it acts on the task, and for an employee its department's
   too, while the department task above it can go on. */
async function linesOfTurn(tx: Tx, companyId: string, agent: Agent, up: string, taskId: string): Promise<Ends[]> {
  const f = await factsFor(tx, companyId, [taskId]);
  const own = { companyId, upstreamAgentId: up, downstreamAgentId: agent.id };
  if (agent.kind === 'head') return headActs(f, agent.id, taskId) ? [own] : [];
  if (agent.kind !== 'worker' || !memberActs(f, agent.id, taskId)) return [];
  const head = await agentOf(tx, up);
  const top = head && (await above(tx, head));
  return top && underLiveRoot(f, taskId) ? [own, { companyId, upstreamAgentId: top, downstreamAgentId: up }] : [own];
}

/* A new cycle on each line, in one order everywhere, so two starts never wait on each other's lines. True when one began. */
async function beginCycles(tx: Tx, lines: Ends[], jobId: string): Promise<boolean> {
  const ordered = [...lines].sort((a, b) => `${a.upstreamAgentId}>${a.downstreamAgentId}`.localeCompare(`${b.upstreamAgentId}>${b.downstreamAgentId}`));
  let began = false;
  for (const line of ordered) began = (await recordMapWorkStarted(tx, { ...line, jobId })) || began;
  return began;
}

/* The lines the agent's turn keeps on for all the tasks it carries, each line once. */
async function linesOfTurns(tx: Tx, companyId: string, agent: Agent, up: string, taskIds: readonly (string | null)[]): Promise<Ends[]> {
  const lines = new Map<string, Ends>();
  for (const taskId of taskIds) {
    if (!taskId) continue;
    for (const line of await linesOfTurn(tx, companyId, agent, up, taskId)) lines.set(`${line.upstreamAgentId}>${line.downstreamAgentId}`, line);
  }
  return [...lines.values()];
}

/* A turn taken to go out: the agent's, with the tasks it carries, its own and those of the turns that go out inside it. */
export type TakenTurn = { id: string; companyId: string; agentId: string | null; taskIds: readonly (string | null)[] };

/* A turn was taken to go out: a new cycle begins on each line the agent's work on its tasks keeps on, its own and, for an
   employee, its department's. It runs in the transaction that takes the turn, so the cycle is kept exactly when the turn
   is: a server that stops once the turn went out never brings the line's old return back, and one that could not keep
   the cycle took no turn. The company when a line began one. */
export async function workStarts(tx: Tx, turn: TakenTurn): Promise<{ companyId: string } | null> {
  const agent = turn.agentId ? await agentOf(tx, turn.agentId) : null;
  const up = agent && (await above(tx, agent));
  if (!agent || !up) return null;
  const lines = await linesOfTurns(tx, turn.companyId, agent, up, turn.taskIds);
  return (await beginCycles(tx, lines, turn.id)) ? { companyId: turn.companyId } : null;
}

/* A department line runs to its head, an employee's line to its head inside the department. */
export type MapLine = WorkLine & { departmentId: string; kind: 'department' | 'member' };

type Turn = { id: string; agentId: string; taskIds: (string | null)[] };

/* What each agent's card shows it on now: the task its turn works on, else the one it acts on next. */
export type Cards = ReadonlyMap<string, { task: { id: string } | null }>;

/* Every line of the company map as the database has it now, with the time on the database's clock after the facts were
   read. Only running turns light a line, so only their tasks and those above them are read, not the company's history.
   cards: what the agents' cards show them on, for an employee's turn that carries no task. */
export async function mapLines(db: Db, companyId: string, cards: Cards = new Map()): Promise<{ lines: MapLine[]; serverNow: Date }> {
  return db.transaction(
    async tx => {
      const staff = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.removedAt)));
      const parents = new Map((await tx.select({ id: departments.id, parentId: departments.parentId }).from(departments).where(eq(departments.companyId, companyId))).map(d => [d.id, d.parentId]));
      const saved = await tx.select().from(mapReturns).where(eq(mapReturns.companyId, companyId));
      const turns = await runningTurns(tx, companyId, staff, cards);
      const f = await factsFor(tx, companyId, turns.flatMap(t => t.taskIds.filter((id): id is string => !!id)));
      const lines = project({ staff, parents, saved, turns, facts: f });
      /* The clock goes on past the start of the transaction, which now() would give. */
      const [clock] = await tx
        .select({ ms: sql<number>`(extract(epoch from clock_timestamp()) * 1000)::float8` })
        .from(companies)
        .where(eq(companies.id, companyId));
      return { lines, serverNow: new Date(Math.floor(clock!.ms)) };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

type Started = { agentId: string | null; taskId: string | null; startedAt: Date | null };

/* The turns that went out inside the heads' running turns, from the earliest of those on. */
async function goneAlong(tx: Tx, heads: Started[]): Promise<Started[]> {
  const starts = heads.flatMap(j => (j.startedAt ? [j.startedAt.getTime()] : []));
  if (!starts.length) return [];
  return tx
    .select({ agentId: jobs.agentId, taskId: jobs.taskId, startedAt: jobs.startedAt })
    .from(jobs)
    .where(and(eq(jobs.result, GONE_ALONG), inArray(jobs.agentId, heads.map(j => j.agentId!)), gte(jobs.startedAt, new Date(Math.min(...starts)))))
    .orderBy(asc(jobs.startedAt));
}

/* The tasks a running turn carries: its own, then those of the turns that went out inside it after it started. */
const carried = (j: Started, along: Started[]) => [j.taskId, ...along.filter(a => a.agentId === j.agentId && j.startedAt && a.startedAt && a.startedAt >= j.startedAt).map(a => a.taskId)];

/* The task a running turn works on: its own, or for an employee's turn that carries none, as one a message started, the
   task its card shows it on. */
function workedOn(j: Started, staff: Agent[], cards: Cards): string | null {
  if (j.taskId || staff.find(a => a.id === j.agentId)?.kind !== 'worker') return j.taskId;
  return cards.get(j.agentId!)?.task?.id ?? null;
}

/* Each agent's running turn with the tasks it carries: the one it works on, and for a head those of the turns that went
   out inside it. */
async function runningTurns(tx: Tx, companyId: string, staff: Agent[], cards: Cards): Promise<Turn[]> {
  const ids = staff.map(a => a.id);
  if (!ids.length) return [];
  const running = await tx
    .select({ id: jobs.id, agentId: jobs.agentId, taskId: jobs.taskId, startedAt: jobs.startedAt })
    .from(jobs)
    .where(and(eq(jobs.companyId, companyId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), inArray(jobs.agentId, ids)));
  const along = await goneAlong(
    tx,
    running.filter(j => staff.find(a => a.id === j.agentId)?.kind === 'head'),
  );
  return running.map(j => ({ id: j.id, agentId: j.agentId!, taskIds: carried({ ...j, taskId: workedOn(j, staff, cards) }, along) }));
}

type Snapshot = { staff: Agent[]; parents: ReadonlyMap<string, string | null>; saved: Line[]; turns: Turn[]; facts: Facts };

const savedOf = (s: Snapshot, up: string, down: string) => s.saved.find(l => l.upstreamAgentId === up && l.downstreamAgentId === down);

/* An agent runs one turn at a time; a switched off one runs none that counts. */
const turnsOf = (s: Snapshot, agent: Agent) => (agent.switchedOffAt ? [] : s.turns.filter(t => t.agentId === agent.id));

/* The task an employee's running turn works on, while it acts on it and has not given it back. */
function memberWork(s: Snapshot, head: Agent, member: Agent): string | undefined {
  const line = savedOf(s, head.id, member.id);
  for (const turn of turnsOf(s, member)) {
    const taskId = turn.taskIds[0];
    if (taskId && memberActs(s.facts, member.id, taskId) && !givenBack(line, turn.id, taskId)) return taskId;
  }
  return undefined;
}

/* Whether the head works on a department task of its own in a turn that has not given it back. */
function headWorks(s: Snapshot, orchestrator: Agent, head: Agent): boolean {
  const line = savedOf(s, orchestrator.id, head.id);
  return turnsOf(s, head).some(turn => turn.taskIds.some(taskId => headActs(s.facts, head.id, taskId) && !givenBack(line, turn.id, taskId)));
}

function lineView(s: Snapshot, up: string, down: string, working: boolean): WorkLine {
  const saved = savedOf(s, up, down);
  return { upstreamAgentId: up, downstreamAgentId: down, working, workEpoch: saved?.workEpoch ?? 0, returnedEpoch: saved?.returnedEpoch ?? null, returnedAt: saved?.returnedAt?.toISOString() ?? null };
}

/* A head's lines: to each employee of its department, and from the orchestrator to it, on while the head or an employee
   under a department task that can go on works. */
function departmentLines(s: Snapshot, orchestrator: Agent | undefined, head: Agent): MapLine[] {
  const departmentId = topOf(s.parents, head.departmentId);
  if (!departmentId) return [];
  const members = s.staff.filter(a => a.kind === 'worker' && topOf(s.parents, a.departmentId) === departmentId);
  const busy = members.map(m => ({ m, taskId: memberWork(s, head, m) }));
  const lines: MapLine[] = busy.map(({ m, taskId }) => ({ ...lineView(s, head.id, m.id, taskId !== undefined), departmentId, kind: 'member' }));
  if (!orchestrator) return lines;
  const working = headWorks(s, orchestrator, head) || busy.some(b => b.taskId !== undefined && underLiveRoot(s.facts, b.taskId));
  return [...lines, { ...lineView(s, orchestrator.id, head.id, working), departmentId, kind: 'department' }];
}

/* Each line with whether the work below it goes on now, and what came back along it. */
export function project(s: Snapshot): MapLine[] {
  const orchestrator = s.staff.find(a => a.kind === 'orchestrator');
  return s.staff.filter(a => a.kind === 'head').flatMap(head => departmentLines(s, orchestrator, head));
}
