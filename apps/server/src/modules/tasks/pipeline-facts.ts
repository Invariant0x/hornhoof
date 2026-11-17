import { AGENT_TIMES, EXTERNAL_WAITS, FILE_BUDGET_MS, KIND_LINES, PIPELINE_STAGES, TEST_BUDGET_MS, type AgentTimeKind, type DepartmentReport, type DoneTask, type ExternalWaitKind, type FileTime, type KindFacts, type KindLine, type PackageTime, type PartTimings, type PipelineFacts, type PipelineRow, type PipelineSection, type PipelineStage, type PipelineUnit, type RunWaits, type SlowTest, type Spread, type TestFileTiming, type TestsFacts, type TurnsFacts, type Waited, type WorkKind } from '@hornhoof/protocol';
import type { TaskEventKind, TaskStatus, TestRunFileCache } from '../../db/schema.js';
import type { AgentTime } from './tree.js';

/* The facts of one turn as the database holds them, for all of a company or one department. Everything here is worked out
   from these alone, so a closed turn and an open one are counted the same way. */
export type FactsTask = {
  id: string;
  number: number;
  parentId: string | null;
  executorAgentId: string | null;
  status: TaskStatus;
  after: string[];
  workKind: WorkKind | null;
  small?: boolean;
  /* The first line of its body, where a kind was written before it had a field. */
  firstLine: string;
  createdAt: Date;
  closedAt: Date | null;
};
export type FactsEvent = { taskId: string; kind: TaskEventKind; data: Record<string, unknown>; createdAt: Date };
type FactsRequest = { taskId: string; createdAt: Date; answeredAt: Date | null };
type FactsPart = { queuedAt: Date; startedAt: Date | null; finishedAt: Date | null };
export type FactsRun = { id: string; taskId: string; kind: 'tests' | 'work'; createdAt: Date; finishedAt: Date | null; parts: FactsPart[]; fileCache?: TestRunFileCache | null };
/* coordination: a turn of the orchestrator, a head or an employee of Operations. */
export type FactsJob = { taskId: string | null; status: string; error: string | null; interrupted: boolean; coordination: boolean; createdAt: Date; startedAt: Date | null; finishedAt: Date | null };
type FactsTimings = PartTimings & { runId: string };
export type FactsInput = {
  openedAt: Date;
  /* When the turn closed, or now. */
  until: Date;
  tasks: FactsTask[];
  events: FactsEvent[];
  requests: FactsRequest[];
  runs: FactsRun[];
  jobs: FactsJob[];
  /* Agent turns outside any task while the turn ran. They are the company's, so a department's facts have none. */
  outside?: FactsJob[];
  agentTime: AgentTime[];
  timings: FactsTimings[];
};

/* One task with what happened to it, and when it was given out and ended. */
type Line = { task: FactsTask; events: FactsEvent[]; issued: Date; end: Date; review: boolean };

const seconds = (from: Date, to: Date): number => Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function spread(values: number[]): Spread {
  return { count: values.length, median: median(values), worst: values.length ? Math.max(...values) : null };
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(keyOf(row), [...(map.get(keyOf(row)) ?? []), row]);
  return map;
}

const latest = (a: Date, b: Date): Date => (a < b ? b : a);

/* A task that waits for what it comes after, or for its turn to start, is not given out yet. */
function issuedAt(task: FactsTask, events: FactsEvent[], openedAt: Date): Date {
  const started = events.findLast(e => e.kind === 'started');
  const assigned = events.find(e => e.kind === 'assigned');
  return latest(started?.createdAt ?? assigned?.createdAt ?? task.createdAt, openedAt);
}

function linesOf(input: FactsInput): Line[] {
  const byTask = groupBy(input.events, e => e.taskId);
  return input.tasks.map(task => {
    const events = [...(byTask.get(task.id) ?? [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { task, events, issued: issuedAt(task, events, input.openedAt), end: task.closedAt ?? input.until, review: events.some(e => e.kind === 'created' && e.data.turnReview === true) };
  });
}

const isWork = (line: Line): boolean => !!line.task.executorAgentId && !line.review && line.task.status !== 'cancelled';
const isMerge = (e: FactsEvent): boolean => e.kind === 'submitted' && e.data.merged === true;
const handInsOf = (line: Line): FactsEvent[] => line.events.filter(e => e.kind === 'submitted' && !isMerge(e));

/* A current stage verdict passes work forward; only final Tests verification makes it ready to integrate.
   Historical verdicts without a named echelon retain their recorded last-look boundary. */
function stageAfterEvent(event: FactsEvent, next: FactsEvent | undefined): PipelineStage {
  if (event.kind === 'submitted') return 'review';
  if (event.kind === 'report') return 'merge';
  if (event.data.pass !== true) return 'fixes';
  return ['review', 'cleanup', 'security'].includes(String(event.data.stage)) || next?.kind === 'verdict' ? 'review' : 'merge';
}

/* Charge each interval to its recorded state, including checker-owned repairs and the wait for Tests. */
function addStages(stages: Record<PipelineStage, number>, line: Line): void {
  const events = line.events.filter(event => (event.kind === 'submitted' || event.kind === 'verdict' || (event.kind === 'report' && event.data.verifiedCandidate))
    && event.createdAt >= line.issued && event.createdAt <= line.end);
  let cursor = line.issued, stage: PipelineStage = 'work';
  for (const [index, event] of events.entries()) {
    stages[stage] += seconds(cursor, event.createdAt);
    cursor = event.createdAt;
    if (isMerge(event)) break;
    stage = stageAfterEvent(event, events[index + 1]);
  }
  stages[stage] += seconds(cursor, line.end);
}

function stagesOf(lines: Line[]): Record<PipelineStage, number> {
  const stages: Record<PipelineStage, number> = { work: 0, review: 0, fixes: 0, merge: 0, turnReview: 0 };
  for (const line of lines) {
    if (isWork(line)) addStages(stages, line);
    else if (line.review) stages.turnReview += seconds(line.issued, line.end);
  }
  return stages;
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);

/* What a review of a turn comes after: the work under the tasks it covers. */
function coveredBy(line: Line, nodes: Line[]): string[] {
  if (!line.review) return [];
  const covers = new Set(stringList(line.events.find(e => e.kind === 'created')?.data.covers));
  return nodes.filter(n => n.task.parentId !== null && covers.has(n.task.parentId)).map(n => n.task.id);
}

type Chain = { seconds: number; tasks: number[] };

function criticalPath(lines: Line[]): Chain {
  const nodes = lines.filter(l => isWork(l) || (l.review && l.task.status !== 'cancelled'));
  const byId = new Map(nodes.map(l => [l.task.id, l]));
  const longest = new Map<string, Chain>();
  const walk = (line: Line, above: ReadonlySet<string>): Chain => {
    const known = longest.get(line.task.id);
    if (known) return known;
    if (above.has(line.task.id)) return { seconds: 0, tasks: [] };
    const path = new Set([...above, line.task.id]);
    const before = [...line.task.after, ...coveredBy(line, nodes)].flatMap(id => (byId.has(id) ? [walk(byId.get(id)!, path)] : []));
    const first = before.reduce<Chain>((best, c) => (c.seconds > best.seconds ? c : best), { seconds: 0, tasks: [] });
    const chain = { seconds: first.seconds + seconds(line.issued, line.end), tasks: [...first.tasks, line.task.number] };
    longest.set(line.task.id, chain);
    return chain;
  };
  return nodes.map(n => walk(n, new Set())).reduce<Chain>((best, c) => (c.seconds > best.seconds ? c : best), { seconds: 0, tasks: [] });
}

function runWaits(runs: FactsRun[], until: Date): RunWaits {
  const times = runs.map(r => seconds(r.createdAt, r.finishedAt ?? until));
  const parts = runs.flatMap(r => r.parts);
  return {
    count: runs.length,
    seconds: sum(times),
    worst: times.length ? Math.max(...times) : 0,
    parts: parts.length,
    partQueueSeconds: sum(parts.map(p => seconds(p.queuedAt, p.startedAt ?? p.finishedAt ?? until))),
    partRunSeconds: sum(parts.flatMap(p => (p.startedAt ? [seconds(p.startedAt, p.finishedAt ?? until)] : []))),
  };
}

/* Every move of a task ends its wait; a note in its log ends it only when it says so. */
const MOVES: ReadonlySet<TaskEventKind> = new Set(['updated', 'submitted', 'verdict', 'report', 'blocked', 'asked', 'answered', 'cancelled', 'done', 'assigned']);
const endsWait = (e: FactsEvent): boolean => MOVES.has(e.kind) || 'externalWait' in e.data;

function waitKindOf(wait: unknown): ExternalWaitKind {
  const on = (wait as { on?: { kind?: string; event?: string } }).on;
  if (on?.kind === 'employee') return 'employee';
  const event = on?.event;
  return event === 'time' || event === 'ceo' || event === 'machine' ? event : 'other';
}

type Span = { from: Date; to: Date };

/* The seconds of a span no other span covers. */
function uncovered(span: Span, covers: Span[]): number {
  let cursor = span.from;
  let left = 0;
  for (const cover of [...covers].sort((a, b) => a.from.getTime() - b.from.getTime())) {
    if (cover.from > cursor) left += seconds(cursor, cover.from < span.to ? cover.from : span.to);
    cursor = latest(cursor, cover.to);
    if (cursor >= span.to) return left;
  }
  return left + seconds(cursor, span.to);
}

const NO_WAIT: Waited = { count: 0, seconds: 0 };

/* A wait for a run is a run: what counts as external is what is left of it around the runs of that task. */
function externalWaits(lines: Line[], runs: FactsRun[], until: Date): Record<ExternalWaitKind, Waited> {
  const waits: Record<ExternalWaitKind, Waited> = { employee: NO_WAIT, time: NO_WAIT, ceo: NO_WAIT, machine: NO_WAIT, other: NO_WAIT };
  const runsOf = groupBy(runs, r => r.taskId);
  for (const line of lines) {
    const covers = (runsOf.get(line.task.id) ?? []).map(r => ({ from: r.createdAt, to: r.finishedAt ?? until }));
    line.events.forEach((e, i) => {
      if (!e.data.externalWait) return;
      const to = line.events.slice(i + 1).find(endsWait)?.createdAt ?? line.end;
      const left = uncovered({ from: e.createdAt, to }, covers);
      const kind = waitKindOf(e.data.externalWait);
      if (left) waits[kind] = { count: waits[kind].count + 1, seconds: waits[kind].seconds + left };
    });
  }
  return waits;
}

function taskWaits(lines: Line[], openedAt: Date): Waited {
  const times = lines.flatMap(l => {
    const started = l.events.find(e => e.kind === 'started');
    return started ? [seconds(latest(l.task.createdAt, openedAt), started.createdAt)] : [];
  });
  return { count: times.length, seconds: sum(times) };
}

function waited(times: number[]): Waited {
  return { count: times.length, seconds: sum(times) };
}

/* Turns Hornhoof ended itself, as the work moved on or nobody could take them: no failure of the work. */
const ENDED_BY_HORNHOOF: ReadonlySet<string> = new Set(['handed_on', 'waiting', 'cancelled', 'stale', 'removed', 'switched_off', 'message_not_delivered']);
const isFailure = (j: FactsJob): boolean => j.status === 'failed' && !j.interrupted && !ENDED_BY_HORNHOOF.has(j.error ?? '');

const BODY_KINDS: Record<string, WorkKind> = { ошибка: 'bug', 'известное поведение': 'known_behavior', 'неизвестный путь': 'unknown_path', 'старый код': 'legacy_code' };

function kindOf(task: FactsTask): KindLine {
  if (task.workKind) return task.workKind;
  const named = /^Вид:\s*([^.]+)/.exec(task.firstLine)?.[1]?.trim().toLowerCase();
  return (named && BODY_KINDS[named]) || 'unset';
}

const isDone = (l: Line): boolean => l.task.status === 'done';
const accepted = (l: Line): number => seconds(l.issued, l.end);
const fixRoundsOf = (l: Line): number => Math.max(0, handInsOf(l).length - 1);

function kindFacts(lines: Line[]): KindFacts {
  return {
    tasks: lines.length,
    toAcceptance: median(lines.filter(isDone).map(accepted)),
    returns: sum(lines.map(l => l.events.filter(event => event.data.rework === true).length)),
    fixRounds: sum(lines.map(fixRoundsOf)),
  };
}

function kindsOf(work: Line[]): Partial<Record<KindLine, KindFacts>> {
  return Object.fromEntries([...groupBy(work, l => kindOf(l.task))].map(([kind, lines]) => [kind, kindFacts(lines)]));
}

function agentsOf(rows: AgentTime[]): Record<AgentTimeKind, number> {
  const of = (pick: (a: AgentTime) => number) => sum(rows.map(pick));
  return { work: of(a => a.work), waiting: of(a => a.after + a.person), idle: of(a => a.stall), lost: of(a => a.lost + a.alarm), queued: of(a => a.queued), unknown: of(a => a.unknown) };
}

/* The middle of what the parts said; none when no part told it. */
const medianOf = (rows: TestFileTiming[], pick: (r: TestFileTiming) => number | null): number | null => median(rows.flatMap(r => pick(r) ?? []));

function fileTime(rows: TestFileTiming[]): FileTime {
  const { package: name, file } = rows[0]!;
  return { package: name, file, totalMs: median(rows.map(r => r.totalMs))!, setupMs: medianOf(rows, r => r.setupMs), testsMs: medianOf(rows, r => r.testsMs), teardownMs: medianOf(rows, r => r.teardownMs), parts: rows.length };
}

function sumKnown(files: FileTime[], pick: (f: FileTime) => number | null): number | null {
  const known = files.flatMap(f => pick(f) ?? []);
  return known.length ? sum(known) : null;
}

const phases = (files: FileTime[]) => ({
  totalMs: sum(files.map(f => f.totalMs)),
  setupMs: sumKnown(files, f => f.setupMs),
  testsMs: sumKnown(files, f => f.testsMs),
  teardownMs: sumKnown(files, f => f.teardownMs),
});

/* A package split over the parts of a run adds up within the run; over the runs of a turn, the largest stands. */
function packageCounts(name: string, timings: FactsTimings[]): Pick<PackageTime, 'tests' | 'medianTestMs' | 'slowerThanMedian'> {
  const rows = timings.flatMap(t => t.packages.filter(p => p.package === name).map(p => ({ ...p, runId: t.runId })));
  if (!rows.length) return { tests: null, medianTestMs: null, slowerThanMedian: null };
  const runs = [...groupBy(rows, r => r.runId).values()];
  return {
    tests: Math.max(...runs.map(run => sum(run.map(r => r.tests)))),
    medianTestMs: median(rows.map(r => r.medianTestMs)),
    slowerThanMedian: Math.max(...runs.map(run => sum(run.map(r => r.slowerThanMedian)))),
  };
}

function packagesOf(files: FileTime[], timings: FactsTimings[]): PackageTime[] {
  return [...groupBy(files, f => f.package)]
    .map(([name, rows]) => ({ package: name, files: rows.length, ...phases(rows), medianFileMs: median(rows.map(r => r.totalMs))!, ...packageCounts(name, timings) }))
    .sort((a, b) => a.package.localeCompare(b.package));
}

const SHOWN_SLOWEST = 10;
/* A suite far over the budget has hundreds of such tests; the slowest of them are where to start. */
const SHOWN_OVER_BUDGET = 50;

/* Each test the logs named, at its slowest, slowest first. */
function namedTestsOf(timings: FactsTimings[]): SlowTest[] {
  const named = timings.flatMap(t => t.files.flatMap(f => f.slowest.map(s => ({ ...s, package: f.package, file: f.file }))));
  return [...groupBy(named, s => `${s.package}\n${s.file}\n${s.name}`).values()]
    .map(same => same.reduce((a, b) => (b.ms > a.ms ? b : a)))
    .sort((a, b) => b.ms - a.ms);
}

/* Both take a list slowest first. */
const filesOverBudget = (files: FileTime[]): FileTime[] => files.filter(f => f.totalMs > FILE_BUDGET_MS).slice(0, SHOWN_OVER_BUDGET);
const testsOverBudget = (tests: SlowTest[]): SlowTest[] => tests.filter(t => t.ms > TEST_BUDGET_MS).slice(0, SHOWN_OVER_BUDGET);

function testsFacts(timings: FactsTimings[]): TestsFacts {
  const rows = timings.flatMap(t => t.files);
  const files = [...groupBy(rows, r => `${r.package}\n${r.file}`).values()].map(fileTime).sort((a, b) => b.totalMs - a.totalMs);
  const named = namedTestsOf(timings);
  return {
    files: files.length,
    ...phases(files),
    packages: packagesOf(files, timings),
    slowestFiles: files.slice(0, SHOWN_SLOWEST),
    slowestTests: named.slice(0, SHOWN_SLOWEST),
    overBudgetFiles: filesOverBudget(files),
    overBudgetTests: testsOverBudget(named),
  };
}

/* What a report shows of test times. An older snapshot kept no lists over the budget, so its slowest ones stand in. */
export function testsShown(t: TestsFacts): DepartmentReport['tests'] {
  return {
    packages: t.packages,
    slowestFiles: t.slowestFiles,
    slowestTests: t.slowestTests,
    overBudgetFiles: t.overBudgetFiles ?? filesOverBudget(t.slowestFiles),
    overBudgetTests: t.overBudgetTests ?? testsOverBudget(t.slowestTests),
  };
}

const roundedRatio = (a: number, b: number): number | null => (b ? Math.round((a / b) * 100) / 100 : null);

function doneTasks(work: Line[]): DoneTask[] {
  return work.filter(isDone).map(l => ({ number: l.task.number, kind: kindOf(l.task), closedAt: l.end.toISOString() }));
}

function turnsFacts(turns: FactsJob[], tasks: number): TurnsFacts {
  const coordination = turns.filter(t => t.coordination).length;
  return { total: turns.length, coordination, perTask: roundedRatio(turns.length, tasks), coordinationShare: roundedRatio(coordination, turns.length) };
}

export function pipelineFacts(input: FactsInput): PipelineFacts {
  const lines = linesOf(input);
  const work = lines.filter(isWork);
  const handedIn = work.filter(l => handInsOf(l).length);
  const closedCount = (status: TaskStatus) => input.tasks.filter(t => t.status === status).length;
  return {
    tasks: { total: input.tasks.length, done: closedCount('done'), cancelled: closedCount('cancelled'), open: input.tasks.length - closedCount('done') - closedCount('cancelled') },
    small: spread(input.tasks.filter(t => t.small && t.closedAt).map(t => seconds(t.createdAt, t.closedAt!))),
    toAcceptance: spread(work.filter(isDone).map(accepted)),
    toFirstSubmit: spread(handedIn.map(l => seconds(l.issued, handInsOf(l)[0]!.createdAt))),
    wholeTurn: seconds(input.openedAt, input.until),
    criticalPath: criticalPath(lines),
    agents: agentsOf(input.agentTime),
    turns: turnsFacts([...input.jobs, ...(input.outside ?? [])], input.tasks.length),
    stages: stagesOf(lines),
    waits: {
      testRuns: runWaits(input.runs.filter(r => r.kind === 'tests'), input.until),
      workRuns: runWaits(input.runs.filter(r => r.kind === 'work'), input.until),
      external: externalWaits(lines, input.runs, input.until),
      person: waited(input.requests.map(r => seconds(r.createdAt, r.answeredAt ?? input.until))),
      tasks: taskWaits(lines, input.openedAt),
      queue: waited(input.jobs.map(j => seconds(j.createdAt, j.startedAt ?? j.finishedAt ?? input.until))),
    },
    returns: sum(work.map(l => l.events.filter(event => event.data.rework === true).length)),
    fixRounds: sum(work.map(fixRoundsOf)),
    submitsPerTask: roundedRatio(sum(handedIn.map(l => handInsOf(l).length)), handedIn.length),
    failures: input.jobs.filter(isFailure).length,
    interrupted: input.jobs.filter(j => j.interrupted).length,
    selectionMisses: selectionMissesOf(input.runs),
    kinds: kindsOf(work),
    done: doneTasks(work),
    tests: testsFacts(input.timings),
  };
}

/* What the full runs of a turn found red that the kept results called green. No number where none of them got to compare. */
function selectionMissesOf(runs: FactsRun[]): number | null {
  const full = runs.flatMap(run => run.fileCache?.mode === 'full' && (run.fileCache.compared || run.fileCache.mismatches.length) ? [run.fileCache] : []);
  return full.length ? sum(full.map(cache => cache.mismatches.length)) : null;
}

/* A bug task made after the task it names as #number closed. */
export type LaterBug = { number: number; createdAt: Date; text: string };
type LaterBugs = { total: number; byKind: Partial<Record<KindLine, number>> };

function namedDone(bug: LaterBug, byNumber: Map<number, DoneTask>): DoneTask[] {
  const named = [...new Set([...bug.text.matchAll(/#(\d+)/g)].map(m => Number(m[1])))];
  return named.flatMap(n => {
    const done = byNumber.get(n);
    return done && bug.number !== n && bug.createdAt > new Date(done.closedAt) ? [done] : [];
  });
}

export function laterBugsOf(done: DoneTask[], bugs: LaterBug[]): LaterBugs {
  const byNumber = new Map(done.map(d => [d.number, d]));
  const out: LaterBugs = { total: 0, byKind: {} };
  for (const bug of bugs) {
    const hits = namedDone(bug, byNumber);
    if (hits.length) out.total++;
    for (const kind of new Set(hits.map(h => h.kind))) out.byKind[kind] = (out.byKind[kind] ?? 0) + 1;
  }
  return out;
}

/* The change from one number to another in percent, none when there is nothing to compare with. */
function percentChange(value: number | null, base: number | null): number | null {
  if (value === null || base === null) return null;
  if (base === 0) return value === 0 ? 0 : null;
  return Math.round(((value - base) / base) * 100);
}

/* Numbers of a turn with the bugs found later in it, which grow after its snapshot. */
export type CountedFacts = { facts: PipelineFacts; later: LaterBugs };
type Fact = { section: PipelineSection; key: string; unit: PipelineUnit; value: number | null };

const counts = (section: PipelineSection, values: Record<string, number | null>): Fact[] => Object.entries(values).map(([key, value]) => ({ section, key, unit: 'count', value }));
const times = (section: PipelineSection, values: Record<string, number | null>): Fact[] => Object.entries(values).map(([key, value]) => ({ section, key, unit: 'seconds', value }));

function waitFacts(name: string, w: Waited): Fact[] {
  return [...counts('waits', { [`waits.${name}.count`]: w.count }), ...times('waits', { [`waits.${name}.seconds`]: w.seconds })];
}

function runFacts(name: string, w: RunWaits): Fact[] {
  return [
    ...waitFacts(name, w),
    ...times('waits', { [`waits.${name}.worst`]: w.worst, [`waits.${name}.partQueue`]: w.partQueueSeconds, [`waits.${name}.partRun`]: w.partRunSeconds }),
    ...counts('waits', { [`waits.${name}.parts`]: w.parts }),
  ];
}

function timeFacts(f: PipelineFacts): Fact[] {
  const agentsTotal = sum(AGENT_TIMES.filter(k => k !== 'queued').map(k => f.agents[k]));
  return times('time', {
    'small.median': f.small?.median ?? null,
    'toAcceptance.median': f.toAcceptance.median,
    'toAcceptance.worst': f.toAcceptance.worst,
    'toFirstSubmit.median': f.toFirstSubmit.median,
    'toFirstSubmit.worst': f.toFirstSubmit.worst,
    wholeTurn: f.wholeTurn,
    criticalPath: f.criticalPath.seconds,
    'agents.total': agentsTotal,
  });
}

function waitsFacts(f: PipelineFacts): Fact[] {
  return [
    ...runFacts('testRuns', f.waits.testRuns),
    ...runFacts('workRuns', f.waits.workRuns),
    ...EXTERNAL_WAITS.flatMap(k => waitFacts(`external.${k}`, f.waits.external[k])),
    ...waitFacts('person', f.waits.person),
    ...waitFacts('tasks', f.waits.tasks),
    ...waitFacts('queue', f.waits.queue),
  ];
}

function kindRows({ facts, later }: CountedFacts): Fact[] {
  return KIND_LINES.flatMap(kind => {
    const k = facts.kinds[kind];
    if (!k) return [];
    return [
      ...counts('kinds', { [`kinds.${kind}.tasks`]: k.tasks }),
      ...times('kinds', { [`kinds.${kind}.toAcceptance`]: k.toAcceptance }),
      ...counts('kinds', { [`kinds.${kind}.returns`]: k.returns, [`kinds.${kind}.fixRounds`]: k.fixRounds, [`kinds.${kind}.laterBugs`]: later.byKind[kind] ?? 0 }),
    ];
  });
}

const tenths = (ms: number | null): number | null => (ms === null ? null : Math.round(ms / 100) / 10);

function testRows(t: TestsFacts): Fact[] {
  if (!t.files) return [];
  return [
    ...times('tests', { 'tests.total': tenths(t.totalMs), 'tests.setup': tenths(t.setupMs), 'tests.run': tenths(t.testsMs), 'tests.teardown': tenths(t.teardownMs) }),
    ...counts('tests', { 'tests.files': t.files }),
    ...t.packages.flatMap(p => times('tests', { [`tests.package.${p.package}`]: tenths(p.totalMs) })),
  ];
}

/* A snapshot from before turns were counted has no rows here. */
function turnRows(t: TurnsFacts | undefined): Fact[] {
  if (!t) return [];
  return [
    ...counts('turns', { 'turns.total': t.total, 'turns.coordination': t.coordination }),
    { section: 'turns', key: 'turns.perTask', unit: 'ratio', value: t.perTask },
    { section: 'turns', key: 'turns.coordinationShare', unit: 'ratio', value: t.coordinationShare },
  ];
}

function factsOf(counted: CountedFacts): Fact[] {
  const f = counted.facts;
  return [
    ...counts('tasks', { 'tasks.total': f.tasks.total, 'tasks.done': f.tasks.done, 'tasks.cancelled': f.tasks.cancelled, 'tasks.open': f.tasks.open, 'small.count': f.small?.count ?? 0 }),
    ...timeFacts(f),
    ...times('stages', Object.fromEntries(PIPELINE_STAGES.map(k => [`stages.${k}`, f.stages[k]]))),
    ...times('agents', Object.fromEntries(AGENT_TIMES.map(k => [`agents.${k}`, f.agents[k]]))),
    ...turnRows(f.turns),
    ...waitsFacts(f),
    { section: 'problems', key: 'submitsPerTask', unit: 'ratio', value: f.submitsPerTask },
    ...counts('problems', { failures: f.failures, interrupted: f.interrupted, selectionMisses: f.selectionMisses }),
    ...counts('quality', { 'quality.laterBugs': counted.later.total, returns: f.returns, fixRounds: f.fixRounds }),
    ...kindRows(counted),
    ...testRows(f.tests),
  ];
}

/* Sections that grow with what happened: a line of nothing but zeros there says nothing. */
const OMITTED_WHEN_EMPTY: ReadonlySet<PipelineSection> = new Set(['stages', 'agents', 'waits']);
const says = (row: PipelineRow): boolean => !OMITTED_WHEN_EMPTY.has(row.section) || !!(row.value || row.previous || row.baseline);

/* Every number of a turn with the same number of the turns it is compared with, also one only they have. */
export function reportRows(now: CountedFacts, previous: CountedFacts | null, baseline: CountedFacts | null): PipelineRow[] {
  const valuesOf = (c: CountedFacts | null) => new Map((c ? factsOf(c) : []).map(f => [f.key, f.value]));
  const current = factsOf(now);
  const before = valuesOf(previous);
  const base = valuesOf(baseline);
  const known = new Set(current.map(f => f.key));
  const gone = [...(previous ? factsOf(previous) : []), ...(baseline ? factsOf(baseline) : [])].filter(f => !known.has(f.key)).map(f => ({ ...f, value: null }));
  const unique = [...new Map([...current, ...gone].map(f => [f.key, f])).values()];
  return unique.map(f => {
    const was = before.get(f.key) ?? null;
    const first = base.get(f.key) ?? null;
    return { ...f, previous: was, baseline: first, vsPrevious: percentChange(f.value, was), vsBaseline: percentChange(f.value, first) };
  }).filter(says);
}
