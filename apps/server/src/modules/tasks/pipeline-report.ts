import type { DepartmentFacts, DepartmentPipeline, DepartmentReport, PipelineFacts, PipelineHead, PipelineReport, PipelineTurn, TurnFacts } from '@hornhoof/protocol';
import { and, asc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { agents, departments, jobs, requests, taskEvents, tasks, testPartTimings, testParts, testRuns, turnSnapshots, turns } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { deptName } from '../departments/templates.js';
import { keepTimings } from '../testruns/timings.js';
import { refuse, type Tx } from './state.js';
import { laterBugsOf, pipelineFacts, reportRows, testsShown, type CountedFacts, type FactsInput, type FactsJob, type FactsTask, type LaterBug } from './pipeline-facts.js';
import { NUDGES, workTree, type AgentTime } from './tree.js';
import { treeFactsOf } from './tree-facts.js';
import { wordLanguages, wordsFor } from '../../locales/index.js';

type Reader = Db | Tx;
type Turn = typeof turns.$inferSelect;
type Source = { facts: TurnFacts; source: PipelineTurn['source'] };

/* The turn the first goals are measured against, in a company that has run it. */
const BASELINE_TURN = 7;

const FACT_TASK = {
  id: tasks.id,
  number: tasks.number,
  departmentId: tasks.departmentId,
  parentId: tasks.parentId,
  executorAgentId: tasks.executorAgentId,
  status: tasks.status,
  after: tasks.after,
  workKind: tasks.workKind,
  small: tasks.small,
  firstLine: sql<string>`split_part(left(${tasks.body}, 200), E'\n', 1)`,
  createdAt: tasks.createdAt,
  closedAt: tasks.closedAt,
};
type RawInput = Omit<FactsInput, 'agentTime' | 'openedAt' | 'until'>;

async function readRuns(db: Reader, taskIds: string[]): Promise<FactsInput['runs']> {
  const runs = await db.select({ id: testRuns.id, taskId: testRuns.taskId, kind: testRuns.kind, createdAt: testRuns.createdAt, finishedAt: testRuns.finishedAt, fileCache: testRuns.fileCache }).from(testRuns).where(inArray(testRuns.taskId, taskIds));
  if (!runs.length) return [];
  const parts = await db.select({ runId: testParts.runId, queuedAt: testParts.queuedAt, startedAt: testParts.startedAt, finishedAt: testParts.finishedAt }).from(testParts).where(inArray(testParts.runId, runs.map(r => r.id)));
  return runs.map(r => ({ ...r, parts: parts.filter(p => p.runId === r.id) }));
}

async function readTimings(db: Reader, runIds: string[]): Promise<FactsInput['timings']> {
  if (!runIds.length) return [];
  return db.select({ runId: testPartTimings.runId, files: testPartTimings.files, packages: testPartTimings.packages }).from(testPartTimings).where(inArray(testPartTimings.runId, runIds));
}

/* Everything a turn's tasks went through, read in one go. */
/* Agent turns with whether each was one of coordination: of the orchestrator, a head or an employee of Operations. */
async function readTurns(db: Reader, companyId: string, which: ReturnType<typeof and>): Promise<FactsJob[]> {
  const places = await db.select({ id: departments.id, parentId: departments.parentId, templateKey: departments.templateKey }).from(departments).where(eq(departments.companyId, companyId));
  const operations = new Set(places.filter(p => p.templateKey === 'operations').map(p => p.id));
  const inOperations = (departmentId: string | null) => places.some(p => p.id === departmentId && (operations.has(p.id) || (p.parentId !== null && operations.has(p.parentId))));
  const rows = await db.select({ taskId: jobs.taskId, status: jobs.status, error: jobs.error, interruption: jobs.interruption, createdAt: jobs.createdAt, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt, agentKind: agents.kind, departmentId: agents.departmentId })
    .from(jobs).leftJoin(agents, eq(agents.id, jobs.agentId)).where(and(eq(jobs.companyId, companyId), eq(jobs.kind, 'conversation'), which));
  return rows.map(({ interruption, agentKind, departmentId, ...turn }) => ({ ...turn, interrupted: interruption !== null, coordination: agentKind === 'orchestrator' || agentKind === 'head' || inOperations(departmentId) }));
}

async function readRaw(db: Reader, companyId: string, turnTasks: FactsTask[]): Promise<RawInput> {
  const ids = turnTasks.map(t => t.id);
  const events = await db.select({ taskId: taskEvents.taskId, kind: taskEvents.kind, data: taskEvents.data, createdAt: taskEvents.createdAt }).from(taskEvents).where(and(inArray(taskEvents.taskId, ids), notInArray(taskEvents.kind, [...NUDGES]))).orderBy(asc(taskEvents.createdAt), asc(taskEvents.id));
  const asks = await db.select({ taskId: requests.taskId, createdAt: requests.createdAt, answeredAt: requests.answeredAt }).from(requests).where(inArray(requests.taskId, ids));
  const turnsOfTasks = await readTurns(db, companyId, inArray(jobs.taskId, ids));
  await keepTimings(db, companyId, ids);
  const runs = await readRuns(db, ids);
  return {
    tasks: turnTasks,
    events,
    requests: asks,
    runs,
    jobs: turnsOfTasks,
    timings: await readTimings(db, runs.map(r => r.id)),
  };
}

/* The part of what a turn's tasks went through that belongs to these tasks. */
function partOf(raw: RawInput, some: FactsTask[]): RawInput {
  const ids = new Set(some.map(t => t.id));
  const runs = raw.runs.filter(r => ids.has(r.taskId));
  const runIds = new Set(runs.map(r => r.id));
  return {
    tasks: some,
    events: raw.events.filter(e => ids.has(e.taskId)),
    requests: raw.requests.filter(r => ids.has(r.taskId)),
    runs,
    jobs: raw.jobs.filter(j => j.taskId !== null && ids.has(j.taskId)),
    timings: raw.timings.filter(t => runIds.has(t.runId)),
  };
}

/* A turn's numbers for each department that had tasks in it and for all of it, from its events up to until. */
export async function turnFacts(db: Reader, turn: Turn, until: Date): Promise<TurnFacts> {
  const rows = await db.select(FACT_TASK).from(tasks).where(eq(tasks.turnId, turn.id)).orderBy(asc(tasks.number));
  const window = { openedAt: turn.openedAt ?? turn.createdAt, until };
  const raw = rows.length ? await readRaw(db, turn.companyId, rows) : { tasks: [], events: [], requests: [], runs: [], jobs: [], timings: [] };
  const departmentIds = [...new Set(rows.flatMap(r => r.departmentId ?? []))];
  const places = departmentIds.length ? await db.select().from(departments).where(inArray(departments.id, departmentIds)).orderBy(asc(departments.position)) : [];
  const departmentsFacts: DepartmentFacts[] = [];
  const allTime: AgentTime[] = [];
  for (const place of places) {
    const facts = await treeFactsOf(db, turn.companyId, place.id, () => true, turn, until);
    const agentTime = workTree(facts, until).time;
    allTime.push(...agentTime);
    const some = raw.tasks.filter(t => rows.find(r => r.id === t.id)?.departmentId === place.id);
    departmentsFacts.push({ department: { id: place.id, name: deptName(place) }, ...pipelineFacts({ ...partOf(raw, some), ...window, agentTime }) });
  }
  const outside = await readTurns(db, turn.companyId, and(isNull(jobs.taskId), gte(jobs.createdAt, window.openedAt), lte(jobs.createdAt, until)));
  return { version: 1, whole: pipelineFacts({ ...raw, outside, ...window, agentTime: allTime }), departments: departmentsFacts };
}

/* Kept as the turn closes, before the next one opens. A failure leaves the turn to close all the same, under a savepoint of
   its own, and the snapshot is built from the events the first time someone reads it. */
export async function keepSnapshot(tx: Tx, turn: Turn, log?: FastifyBaseLogger): Promise<void> {
  try {
    await tx.transaction(async inner => {
      const facts = await turnFacts(inner, turn, turn.closedAt ?? new Date());
      await inner.insert(turnSnapshots).values({ turnId: turn.id, companyId: turn.companyId, source: 'closed', facts }).onConflictDoNothing();
    });
  } catch (err) {
    log?.error({ error: loggable(err), turn: turn.number }, 'The snapshot of a closing turn could not be kept.');
  }
}

/* A closed turn as it was kept, or rebuilt from its events and kept the first time someone reads it. The read answers even
   where the database refuses the write, as on a copy that may only read: the snapshot is then kept at a later read. */
async function snapshotOf(db: Reader, turn: Turn): Promise<Source> {
  const [kept] = await db.select({ facts: turnSnapshots.facts, source: turnSnapshots.source }).from(turnSnapshots).where(eq(turnSnapshots.turnId, turn.id));
  if (kept) return kept;
  const facts = await turnFacts(db, turn, turn.closedAt ?? new Date());
  try {
    await db.transaction(async inner => {
      await inner.insert(turnSnapshots).values({ turnId: turn.id, companyId: turn.companyId, source: 'rebuilt', facts }).onConflictDoNothing();
    });
  } catch {
    /* Not kept this time; the facts are the same either way. */
  }
  return { facts, source: 'rebuilt' };
}

const liveOrKept = async (db: Reader, turn: Turn): Promise<Source> => (turn.status === 'open' ? { facts: await turnFacts(db, turn, new Date()), source: 'live' } : snapshotOf(db, turn));

/* A turn that ran: not one that closed planned, merged into another or with nothing in it. */
const ran = (t: Turn): boolean => t.status === 'open' || (t.status === 'closed' && !!t.openedAt && !!t.closedAt && t.closedAt > t.openedAt);

function pickTurn(rows: Turn[], number: number | undefined): Turn {
  const running = rows.filter(ran);
  const turn = number === undefined ? (running.find(t => t.status === 'open') ?? running.at(-1)) : running.find(t => t.number === number);
  if (!turn) throw refuse(404, 'turn_unknown', number === undefined ? 'No turn has run yet.' : `Turn ${number} has not run. Call turns to see them.`);
  return turn;
}

function baselineOf(running: Turn[], turn: Turn): Turn | null {
  const closed = running.filter(t => t.status === 'closed');
  const base = closed.find(t => t.number === BASELINE_TURN) ?? closed[0];
  return base && base.number < turn.number ? base : null;
}

const turnView = (t: Turn, source: PipelineTurn['source']): PipelineTurn => ({
  number: t.number,
  title: t.title || t.goal,
  status: t.status === 'open' ? 'open' : 'closed',
  openedAt: (t.openedAt ?? t.createdAt).toISOString(),
  closedAt: t.closedAt?.toISOString() ?? null,
  source,
});

type Read = { head: PipelineHead; now: TurnFacts; previous: TurnFacts | null; baseline: TurnFacts | null };

/* A turn the report compares with, when it has one. */
async function comparedOf(db: Reader, turn: Turn | null | undefined): Promise<{ view: PipelineTurn | null; facts: TurnFacts | null }> {
  if (!turn) return { view: null, facts: null };
  const kept = await snapshotOf(db, turn);
  return { view: turnView(turn, kept.source), facts: kept.facts };
}

/* A turn is compared with the turns of its own department, the one it belongs to. With no number, the department's running
   turn is read, else its last that ran; with no department either, the earliest running turn, else the last that ran. */
async function readReport(db: Reader, companyId: string, number: number | undefined, departmentId?: string): Promise<Read> {
  const rows = await db.select().from(turns).where(eq(turns.companyId, companyId)).orderBy(asc(turns.number));
  const turn = pickTurn(departmentId && number === undefined ? rows.filter(t => t.departmentId === departmentId) : rows, number);
  const running = rows.filter(t => ran(t) && t.departmentId === turn.departmentId);
  const now = await liveOrKept(db, turn);
  const previous = await comparedOf(db, running.filter(t => t.number < turn.number).at(-1));
  const baseline = await comparedOf(db, baselineOf(running, turn));
  return {
    head: { turn: turnView(turn, now.source), previous: previous.view, baseline: baseline.view, turns: running.map(t => t.number).reverse() },
    now: now.facts,
    previous: previous.facts,
    baseline: baseline.facts,
  };
}

/* Bug tasks of the company made since a turn opened, by the field or the first line of the body. */
async function bugsSince(db: Reader, companyId: string, since: Date): Promise<LaterBug[]> {
  const rows = await db
    .select({ number: tasks.number, title: tasks.title, body: tasks.body, createdAt: tasks.createdAt })
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), gte(tasks.createdAt, since), or(eq(tasks.workKind, 'bug'), ...wordLanguages().map(language => sql`${tasks.body} like ${`${wordsFor(language).taskKind.label}: ${wordsFor(language).taskKind.bug}%`}`))));
  return rows.map(r => ({ number: r.number, createdAt: r.createdAt, text: `${r.title}\n${r.body}` }));
}

const counted = (facts: PipelineFacts | null | undefined, bugs: LaterBug[]): CountedFacts | null => (facts ? { facts, later: laterBugsOf(facts.done, bugs) } : null);

function departmentReport(d: DepartmentFacts, read: Read, bugs: LaterBug[], about: Map<string, string>): DepartmentReport {
  const other = (facts: TurnFacts | null) => counted(facts?.departments.find(x => x.department.id === d.department.id), bugs);
  return {
    department: d.department,
    described: !!about.get(d.department.id)?.trim(),
    criticalPath: d.criticalPath.tasks,
    rows: reportRows(counted(d, bugs)!, other(read.previous), other(read.baseline)),
    tests: testsShown(d.tests),
  };
}

async function earliestBugs(db: Reader, companyId: string, read: Read): Promise<LaterBug[]> {
  const opened = [read.head.turn, read.head.previous, read.head.baseline].flatMap(t => (t ? [Date.parse(t.openedAt)] : []));
  return bugsSince(db, companyId, new Date(Math.min(...opened)));
}

async function aboutOf(db: Reader, companyId: string): Promise<Map<string, string>> {
  const rows = await db.select({ id: departments.id, about: departments.about }).from(departments).where(eq(departments.companyId, companyId));
  return new Map(rows.map(d => [d.id, d.about]));
}

/* The report of a turn with all its departments' parts, by default a running one or else the last that ran, of the
   department named. */
export async function pipelineReport(db: Reader, companyId: string, number?: number, departmentId?: string): Promise<PipelineReport> {
  const read = await readReport(db, companyId, number, departmentId);
  const bugs = await earliestBugs(db, companyId, read);
  const about = await aboutOf(db, companyId);
  return {
    ...read.head,
    whole: reportRows(counted(read.now.whole, bugs)!, counted(read.previous?.whole, bugs), counted(read.baseline?.whole, bugs)),
    departments: read.now.departments.map(d => departmentReport(d, read, bugs, about)),
  };
}

/* What one department's screen reads: only that department's numbers. */
export async function departmentPipeline(db: Reader, companyId: string, departmentId: string, number?: number): Promise<DepartmentPipeline> {
  const read = await readReport(db, companyId, number, departmentId);
  const facts = read.now.departments.find(d => d.department.id === departmentId);
  if (!facts) return { ...read.head, department: null };
  return { ...read.head, department: departmentReport(facts, read, await earliestBugs(db, companyId, read), await aboutOf(db, companyId)) };
}
