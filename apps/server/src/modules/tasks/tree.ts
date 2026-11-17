import { ECHELON_STAGES, isStaged, type EchelonsSnapshot, type EchelonFindingsView, type EchelonStage } from '@hornhoof/protocol/echelons';
import type { TurnAlarm, TurnProgram } from '@hornhoof/protocol/map';
import type { TaskWaitView } from '@hornhoof/protocol/waits';
import { countedSegments, turnSegments, withExternalWait, withPrograms, type FactTurn } from './tree-programs.js';
import { taskActor, waitingAgents, type TreeWait, type WaitSpan } from './tree-waits.js';
import type { REQUEST_STATUSES, TaskEventKind, TaskStatus } from '../../db/schema.js';

type RequestStatus = (typeof REQUEST_STATUSES)[number];

const TEXT_MAX = 160;

/* Hornhoof's own reminders on a quiet task are neither moves nor signs of life. */
export const NUDGES: ReadonlySet<TaskEventKind> = new Set(['reminded', 'continued', 'stuck', 'wait_due', 'wait_card', 'away']);

export type SegmentKind = 'work' | 'after' | 'person' | 'stall' | 'lost' | 'alarm' | 'queued' | 'unknown';
/* to is null while it still goes on at `now`. */
export type ExternalWait = { reason: string; since: string; until: string };
export type TreeSegment = { kind: SegmentKind; from: string; to: string | null; program?: Pick<TurnProgram, 'state' | 'since' | 'tool'>; alarm?: TurnAlarm; waitsForAgent?: TreeAgent; externalWait?: ExternalWait };
/* A task event as a dot on the line; text cut to 160 characters. */
export type TreeMove = { kind: TaskEventKind; at: string; text: string };
export type TreeAgent = { id: string; name: string };
export type TreeLine = {
  echelons: EchelonsSnapshot;
  echelonFindings: EchelonFindingsView;
  ownerSince: string;
  taskId: string;
  number: number;
  title: string;
  agent: TreeAgent;
  /* The department's task it is a part of (tasks.parentId), when there is one. */
  part: { id: string; number: number; title: string } | null;
  /* task-<number> when the task is in a repository (inRepository), else null: no branch, no fork, no merge. */
  branch: string | null;
  createdAt: string;
  /* When the work started: the 'started' event when the task waited for others, else createdAt; null while it still waits. */
  cutAt: string | null;
  /* The report recording the checked candidate integration. */
  mergedAt: string | null;
  /* closedAt of a task done without a merge. */
  doneAt: string | null;
  /* Numbers of the tasks in tasks.after that are not done yet. */
  waitsFor: number[];
  /* Who answers for each thing it waits on, by when. */
  waits: TaskWaitView[];
  segments: TreeSegment[];
  moves: TreeMove[];
  /* The latest agent event of this agent's jobs on this task. */
  lastActionAt: string | null;
  /* A job of this agent on this task is running now. */
  live: boolean;
  externalWait?: ExternalWait | null;
};
export type TreeActivity = { jobId: string; agent: TreeAgent; task: Pick<FactRelatedTask, 'id' | 'number' | 'title'> | null; segments: TreeSegment[] };
/* Seconds of each kind from the start of the turn to now, over all of the agent's lines, observed turns and waits. */
export type AgentTime = { agent: TreeAgent; work: number; after: number; person: number; stall: number; lost: number; alarm: number; queued: number; unknown: number };
export type IdleStretch = {
  agent: TreeAgent;
  taskId: string;
  number: number;
  title: string;
  kind: Exclude<SegmentKind, 'work'>;
  from: string;
  to: string | null;
  waitsFor: number[];
  /* The request's text for a wait for a person, cut to 160 characters. */
  question: string | null;
  program?: TreeSegment['program'];
  alarm?: TurnAlarm;
  waitsForAgent?: TreeAgent;
  externalWait?: ExternalWait;
};
export type DepartmentTree = {
  now: string;
  turn: { id: string; number: number; branch: string; startedAt: string } | null;
  /* The department or one of its products has a repository. */
  repository: boolean;
  lines: TreeLine[];
  waiting: TreeWait[];
  activity: TreeActivity[];
  time: AgentTime[];
  idle: IdleStretch[];
};

export type FactAgent = { id: string; name: string; createdAt: Date };
export type FactTask = {
  ownerSince: Date;
  echelons: EchelonsSnapshot;
  echelonFindings: EchelonFindingsView;
  /* Who answers for each thing it waits on: for work going on now, not for a turn that is over. */
  waits?: TaskWaitView[];
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
  parentId: string | null;
  executorAgentId: string | null;
  assigneeAgentId?: string | null;
  after: string[];
  inRepository: boolean;
  createdAt: Date;
  closedAt: Date | null;
  visible?: boolean;
  externalWait?: ExternalWait | null;
};
export type FactRelatedTask = { id: string; number: number; title: string; status: TaskStatus; visible: boolean };
export type FactTaskEvent = {
  taskId: string;
  agentId: string | null;
  kind: TaskEventKind;
  text: string;
  data: Record<string, unknown>;
  createdAt: Date;
};
export type FactRequest = {
  taskId: string;
  agentId: string;
  text: string;
  status: RequestStatus;
  createdAt: Date;
  answeredAt: Date | null;
};
export type FactSign = { taskId: string; agentId: string | null; at: Date };
export type FactJobState = { taskId: string; agentId: string; lastActionAt: Date | null; live: boolean };

export type TreeFacts = {
  repository: boolean;
  turn: { id: string; number: number; createdAt: Date; openedAt: Date | null } | null;
  agents: FactAgent[];
  tasks: FactTask[];
  related?: FactRelatedTask[];
  events: FactTaskEvent[];
  requests: FactRequest[];
  signs: FactSign[];
  jobs: FactJobState[];
  turns?: FactTurn[];
};

type PersonWindow = { a: number; b: number; open: boolean };

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const uniqueSorted = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);
const listOf = <K, V>(map: Map<K, V[]>, key: K): V[] => map.get(key) ?? [];

function requestBounds(r: FactRequest, stopMs: number, rawSigns: number[]): PersonWindow {
  const start = r.createdAt.getTime();
  if (r.status === 'open') return { a: start, b: stopMs, open: true };
  if (r.answeredAt) return { a: start, b: r.answeredAt.getTime(), open: false };
  const next = rawSigns.find(s => s > start);
  return next === undefined ? { a: start, b: stopMs, open: true } : { a: start, b: next, open: false };
}

function keepWindow(w: PersonWindow, stopMs: number, ongoing: boolean): boolean {
  if (w.b > w.a) return true;
  return ongoing && w.open && w.a === stopMs;
}

function mergePersonWindows(sorted: PersonWindow[]): PersonWindow[] {
  const merged: PersonWindow[] = [];
  for (const w of sorted) {
    const prev = merged.at(-1);
    if (prev && w.a <= prev.b) {
      prev.b = Math.max(prev.b, w.b);
      if (w.open) prev.open = true;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

function personWindows(fromMs: number, stopMs: number, ongoing: boolean, asks: FactRequest[], rawSigns: number[]): PersonWindow[] {
  const clipped = asks
    .map(r => {
      const w = requestBounds(r, stopMs, rawSigns);
      return { a: Math.max(fromMs, w.a), b: Math.min(stopMs, w.b), open: w.open };
    })
    .filter(w => keepWindow(w, stopMs, ongoing))
    .sort((x, y) => x.a - y.a);
  return mergePersonWindows(clipped);
}

function unreportedSegment(a: number, b: number): TreeSegment[] {
  return [{ kind: 'unknown', from: iso(a), to: iso(b) }];
}

function finishTail(out: TreeSegment[], cursor: number, fromMs: number, stopMs: number, ongoing: boolean): void {
  if (stopMs > cursor) {
    const tail = unreportedSegment(cursor, stopMs);
    if (ongoing) tail[tail.length - 1]!.to = null;
    out.push(...tail);
    return;
  }
  if (ongoing) {
    if (out.at(-1)?.to !== null) out.push({ kind: 'unknown', from: iso(stopMs), to: null });
    return;
  }
  if (!out.length) out.push({ kind: 'unknown', from: iso(fromMs), to: iso(stopMs) });
}

function activeSegments(fromMs: number, endAt: Date | null, nowMs: number, asks: FactRequest[], signsMs: number[]): TreeSegment[] {
  const ongoing = endAt === null;
  const stopMs = Math.max(fromMs, endAt ? endAt.getTime() : nowMs);
  const raw = uniqueSorted([fromMs, ...signsMs]);
  const waits = personWindows(fromMs, stopMs, ongoing, asks, raw);
  const out: TreeSegment[] = [];
  let cursor = fromMs;

  for (const w of waits) {
    if (w.a > cursor) out.push(...unreportedSegment(cursor, w.a));
    const openAtEnd = w.open && ongoing;
    out.push({ kind: 'person', from: iso(w.a), to: openAtEnd ? null : iso(w.b) });
    cursor = w.b;
  }
  finishTail(out, cursor, fromMs, stopMs, ongoing);
  return out;
}

export function lineSegments(input: {
  createdAt: Date;
  cutAt: Date | null;
  endAt: Date | null;
  now: Date;
  requests: FactRequest[];
  signs: Date[];
}): TreeSegment[] {
  if (!input.cutAt) return [{ kind: 'after', from: input.createdAt.toISOString(), to: null }];
  const startMs = input.createdAt.getTime();
  const cutMs = Math.max(startMs, input.cutAt.getTime());
  const head: TreeSegment[] = cutMs > startMs ? [{ kind: 'after', from: iso(startMs), to: iso(cutMs) }] : [];
  if (input.endAt && input.endAt.getTime() <= cutMs) {
    return head.length ? head : [{ kind: 'unknown', from: iso(startMs), to: iso(cutMs) }];
  }
  return [...head, ...activeSegments(cutMs, input.endAt, input.now.getTime(), input.requests, input.signs.map(d => d.getTime()))];
}

function sumSegmentSeconds(segments: TreeSegment[], startMs: number, nowMs: number) {
  const ms: Record<SegmentKind, number> = { work: 0, after: 0, person: 0, stall: 0, lost: 0, alarm: 0, queued: 0, unknown: 0 };
  for (const seg of segments) {
    const from = Math.max(startMs, Date.parse(seg.from));
    const to = Math.min(nowMs, seg.to ? Date.parse(seg.to) : nowMs);
    if (to > from) ms[seg.kind] += to - from;
  }
  return {
    work: Math.round(ms.work / 1000),
    after: Math.round(ms.after / 1000),
    person: Math.round(ms.person / 1000),
    stall: Math.round(ms.stall / 1000),
    lost: Math.round(ms.lost / 1000),
    alarm: Math.round(ms.alarm / 1000),
    queued: Math.round(ms.queued / 1000),
    unknown: Math.round(ms.unknown / 1000),
  };
}

export function agentTime(
  agents: FactAgent[],
  entries: { agentId: string; segments: TreeSegment[] }[],
  turnStartedAt: Date,
  now: Date,
): AgentTime[] {
  const byAgent = new Map<string, TreeSegment[]>();
  for (const e of entries) byAgent.set(e.agentId, [...listOf(byAgent, e.agentId), ...e.segments]);
  const startMs = turnStartedAt.getTime();
  const nowMs = now.getTime();

  return [...agents]
    .filter(a => byAgent.has(a.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(a => ({
      agent: { id: a.id, name: a.name },
      ...sumSegmentSeconds(countedSegments(byAgent.get(a.id)!, now), startMs, nowMs),
    }));
}

type IdleSource = {
  agent: TreeAgent;
  taskId: string;
  number: number;
  title: string;
  segments: TreeSegment[];
  afterNumbers: number[];
  waitsFor: number[];
  requests: FactRequest[];
};

const IDLE_RANK: Record<Exclude<SegmentKind, 'work'>, number> = { lost: 0, alarm: 0, person: 1, queued: 2, after: 3, stall: 4, unknown: 5 };

function questionFor(asks: FactRequest[], fromIso: string): string | null {
  const fromMs = Date.parse(fromIso);
  const sorted = [...asks].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const match = sorted.filter(r => r.createdAt.getTime() <= fromMs).at(-1) ?? sorted[0];
  return match ? match.text.slice(0, TEXT_MAX) : null;
}

function idleWaitsFor(src: IdleSource, seg: TreeSegment): number[] {
  if (seg.kind !== 'after') return [];
  return seg.to === null ? src.waitsFor : src.afterNumbers;
}

function toIdleStretch(src: IdleSource, seg: TreeSegment): IdleStretch | null {
  if (seg.kind === 'work') return null;
  return {
    agent: src.agent,
    taskId: src.taskId,
    number: src.number,
    title: src.title,
    kind: seg.kind,
    from: seg.from,
    to: seg.to,
    waitsFor: idleWaitsFor(src, seg),
    program: seg.program, alarm: seg.alarm, waitsForAgent: seg.waitsForAgent, externalWait: seg.externalWait,
    question: seg.kind === 'person' ? questionFor(src.requests, seg.from) : null,
  };
}

const stretchMs = (s: IdleStretch, nowMs: number): number => (s.to ? Date.parse(s.to) : nowMs) - Date.parse(s.from);

function compareIdle(a: IdleStretch, b: IdleStretch, nowMs: number): number {
  const aOpen = a.to === null;
  const bOpen = b.to === null;
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  if (aOpen && a.kind !== b.kind) return IDLE_RANK[a.kind] - IDLE_RANK[b.kind];
  return stretchMs(b, nowMs) - stretchMs(a, nowMs);
}

export function idleStretches(sources: IdleSource[], now: Date): IdleStretch[] {
  const nowMs = now.getTime();
  return sources
    .flatMap(src => src.segments.flatMap(seg => {
      const stretch = toIdleStretch(src, seg);
      return stretch ? [stretch] : [];
    }))
    .sort((a, b) => compareIdle(a, b, nowMs));
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = map.get(k);
    if (list) list.push(r);
    else map.set(k, [r]);
  }
  return map;
}

type Indexed = {
  agents: Map<string, FactAgent>;
  tasks: Map<string, FactRelatedTask>;
  movesByTask: Map<string, FactTaskEvent[]>;
  asksByPair: Map<string, FactRequest[]>;
  signsByTask: Map<string, FactSign[]>;
  jobsByTask: Map<string, FactJobState[]>;
  jobsByPair: Map<string, FactJobState>;
  turnsByPair: Map<string, FactTurn[]>;
};

const turnsOf = (facts: TreeFacts): FactTurn[] => facts.turns ?? [];

function indexFacts(facts: TreeFacts): Indexed {
  const agents = new Map(facts.agents.map(a => [a.id, a]));
  const tasks = new Map<string, FactRelatedTask>();
  for (const r of facts.related ?? []) tasks.set(r.id, r);
  for (const t of facts.tasks) tasks.set(t.id, { id: t.id, number: t.number, title: t.title, status: t.status, visible: t.visible !== false });
  const moves = facts.events.filter(e => !NUDGES.has(e.kind)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return {
    agents,
    tasks,
    movesByTask: groupBy(moves, e => e.taskId),
    asksByPair: groupBy(facts.requests, r => `${r.taskId}:${r.agentId}`),
    signsByTask: groupBy(facts.signs, s => s.taskId),
    jobsByTask: groupBy(facts.jobs, j => j.taskId),
    jobsByPair: new Map(facts.jobs.map(j => [`${j.taskId}:${j.agentId}`, j])),
    turnsByPair: groupBy(turnsOf(facts), j => `${j.taskId}:${j.agentId}`),
  };
}

function jobView(ix: Indexed, taskId: string, agentId: string): { lastActionAt: string | null; live: boolean; actionDate: Date | null } {
  const job = ix.jobsByPair.get(`${taskId}:${agentId}`);
  const actionDate = job?.lastActionAt ?? null;
  return { lastActionAt: isoOrNull(actionDate), live: job?.live ?? false, actionDate };
}

function afterOf(task: FactTask, tasks: Map<string, FactRelatedTask>): FactRelatedTask[] {
  return task.after.flatMap(id => (tasks.has(id) ? [tasks.get(id)!] : [])).sort((a, b) => a.number - b.number);
}

function cutDateOf(task: FactTask, moves: FactTaskEvent[], afterTasks: FactRelatedTask[]): Date | null {
  if (task.status !== 'done' && afterTasks.some(a => a.status !== 'done')) return null;
  const started = [...moves].reverse().find(e => e.kind === 'started');
  return started ? started.createdAt : task.createdAt;
}

function lineEndDates(task: FactTask, moves: FactTaskEvent[]): { mergedAt: Date | null; doneAt: Date | null } {
  const merged = moves.find(e => e.kind === 'report' && e.data.acceptedCandidate && typeof e.data.acceptedCandidate === 'object' && 'integration' in e.data.acceptedCandidate);
  if (merged) return { mergedAt: merged.createdAt, doneAt: null };
  return { mergedAt: null, doneAt: task.status === 'done' ? task.closedAt : null };
}

function partOf(parentId: string | null, tasks: Map<string, FactRelatedTask>): TreeLine['part'] {
  const parent = parentId ? tasks.get(parentId) : undefined;
  return parent?.visible ? { id: parent.id, number: parent.number, title: parent.title } : null;
}

function lineSigns(taskId: string, moves: FactTaskEvent[], ix: Indexed): Date[] {
  return [
    ...moves.map(e => e.createdAt),
    ...listOf(ix.signsByTask, taskId).map(s => s.at),
    ...listOf(ix.jobsByTask, taskId).flatMap(j => (j.lastActionAt ? [j.lastActionAt] : [])),
  ];
}

type OwnershipTask = Pick<FactTask, 'createdAt' | 'echelons' | 'assigneeAgentId' | 'executorAgentId'>;

function reassignedOwner(event: FactTaskEvent): boolean {
  return event.kind === 'updated' && Array.isArray(event.data.fields)
    && event.data.fields.some(field => ['owner', 'ownerAgentId', 'executor'].includes(String(field)));
}

function earlierVerdict(event: FactTaskEvent, workflow: EchelonsSnapshot, current: number): boolean {
  const previous = typeof event.data.stage === 'string' ? ECHELON_STAGES.indexOf(event.data.stage as EchelonStage) : -1;
  return event.kind === 'verdict' && event.data.pass === true && event.data.candidateId === workflow.candidateId && previous >= 0 && previous < current;
}

function checkerHandoff(event: FactTaskEvent, workflow: EchelonsSnapshot, current: number): boolean {
  const candidate = event.data.candidate as { id?: unknown } | undefined;
  return (event.kind === 'submitted' && candidate?.id === workflow.candidateId) || earlierVerdict(event, workflow, current);
}

function currentChecker(task: OwnershipTask, stage: number): boolean {
  return Boolean(task.assigneeAgentId && task.assigneeAgentId !== task.executorAgentId && stage >= 2);
}

/* A checker starts at its real handoff, not when its author's task was created. */
export function treeOwnerSince(task: OwnershipTask, moves: FactTaskEvent[]): Date {
  let since = task.createdAt;
  const workflow = task.echelons;
  const current = workflow.stage ? ECHELON_STAGES.indexOf(workflow.stage) : -1;
  for (const event of moves) {
    if ((reassignedOwner(event) || (currentChecker(task, current) && checkerHandoff(event, workflow, current))) && event.createdAt > since) since = event.createdAt;
  }
  return since;
}

function submittedBy(event: FactTaskEvent, actorId: string): boolean {
  const candidate = event.data.candidate as { producedBy?: { agentId?: string } } | undefined;
  return event.kind === 'submitted' && event.agentId === actorId && candidate?.producedBy?.agentId === actorId;
}

function observedLineEnd(task: FactTask, moves: FactTaskEvent[], actorId: string, completedAt: Date | null): Date | null {
  const handedOn = task.status === 'done' && isStaged(task.echelons.resultKind) ? moves.find(event => submittedBy(event, actorId)) : undefined;
  return handedOn && completedAt && handedOn.createdAt < completedAt ? handedOn.createdAt : completedAt;
}

function buildLine(task: FactTask, ix: Indexed, now: Date): { line: TreeLine; idle: IdleSource } | null {
  const actorId = taskActor(task);
  if (!actorId) return null;
  const actor = ix.agents.get(actorId);
  if (!actor) return null;
  const agent: TreeAgent = { id: actor.id, name: actor.name };
  const moves = listOf(ix.movesByTask, task.id);
  const afterTasks = afterOf(task, ix.tasks);
  const cutDate = cutDateOf(task, moves, afterTasks);
  const ends = lineEndDates(task, moves);
  const since = task.ownerSince;
  const ownerCut = cutDate && cutDate < since ? since : cutDate;
  const observedEnd = observedLineEnd(task, moves, actorId, ends.mergedAt ?? ends.doneAt);
  const asks = listOf(ix.asksByPair, `${task.id}:${agent.id}`);
  const segments = withExternalWait(withPrograms(lineSegments({
    createdAt: since,
    cutAt: ownerCut,
    endAt: observedEnd,
    now,
    requests: asks,
    signs: lineSigns(task.id, moves, ix),
  }), listOf(ix.turnsByPair, `${task.id}:${agent.id}`), agent, now), task.externalWait, now);
  const job = jobView(ix, task.id, agent.id);
  const visibleAfter = afterTasks.filter(a => a.visible);
  const waitsFor = visibleAfter.filter(a => a.status !== 'done').map(a => a.number);
  const afterNumbers = visibleAfter.map(a => a.number);

  const line: TreeLine = {
    echelons: task.echelons,
    echelonFindings: task.echelonFindings,
    ownerSince: since.toISOString(),
    taskId: task.id,
    number: task.number,
    title: task.title,
    agent,
    part: partOf(task.parentId, ix.tasks),
    branch: task.inRepository ? `task-${task.number}` : null,
    createdAt: task.createdAt.toISOString(),
    cutAt: isoOrNull(ownerCut),
    mergedAt: isoOrNull(ends.mergedAt),
    doneAt: isoOrNull(ends.doneAt),
    waitsFor,
    waits: task.waits ?? [],
    segments,
    moves: moves.map(m => ({ kind: m.kind, at: m.createdAt.toISOString(), text: m.text.slice(0, TEXT_MAX) })),
    lastActionAt: job.lastActionAt,
    live: job.live,
    externalWait: task.externalWait,
  };
  return { line, idle: { agent, taskId: task.id, number: task.number, title: task.title, segments, afterNumbers, waitsFor, requests: asks } };
}

const isLineTask = (task: FactTask): boolean =>
  task.visible !== false && task.status !== 'cancelled' && taskActor(task) !== null;

function representedPairs(lines: TreeLine[]): Set<string> {
  return new Set(lines.map(line => `${line.taskId}:${line.agent.id}`));
}

function participants(lines: TreeLine[]): Set<string> {
  return new Set(lines.map(line => line.agent.id));
}

function unrepresentedTurn(turn: FactTurn, known: Set<string>, visible: Set<string>, ix: Indexed): boolean {
  if (!visible.has(turn.agentId)) return false;
  if (turn.taskId !== null && ix.tasks.get(turn.taskId)?.visible !== true) return false;
  return !known.has(`${turn.taskId}:${turn.agentId}`);
}

type ObservedEntry = TreeActivity & { agentId: string };

function observedEntry(turn: FactTurn, agent: TreeAgent, ix: Indexed, now: Date): ObservedEntry {
  const task = ix.tasks.get(turn.taskId ?? ''), who = { id: agent.id, name: agent.name };
  return { agentId: agent.id, jobId: turn.id, agent: who, task: task ? { id: task.id, number: task.number, title: task.title } : null,
    segments: countedSegments(turnSegments(turn, who), now) };
}

function observedTime(facts: TreeFacts, ix: Indexed, lines: TreeLine[], now: Date): ObservedEntry[] {
  const known = representedPairs(lines), visible = participants(lines);
  for (const turn of turnsOf(facts)) if (turn.taskId && ix.tasks.get(turn.taskId)?.visible) visible.add(turn.agentId);
  return turnsOf(facts).filter(turn => unrepresentedTurn(turn, known, visible, ix)).flatMap(turn => {
    const agent = ix.agents.get(turn.agentId);
    return agent ? [observedEntry(turn, agent, ix, now)] : [];
  }).filter(entry => entry.segments.length > 0);
}

function waitSource(wait: WaitSpan): IdleSource {
  return { ...wait, segments: [{ kind: wait.kind, from: wait.from, to: wait.to, waitsForAgent: wait.waitsForAgent }], afterNumbers: [], waitsFor: [], requests: [] };
}

function taskOrder(a: FactTask, b: FactTask): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.number - b.number;
}

export function workTree(facts: TreeFacts, now: Date): DepartmentTree {
  if (!facts.turn) {
    return { now: now.toISOString(), turn: null, repository: facts.repository, lines: [], waiting: [], activity: [], time: [], idle: [] };
  }
  const ix = indexFacts(facts);
  const builtLines = [...facts.tasks]
    .filter(isLineTask)
    .sort(taskOrder)
    .flatMap(t => {
      const built = buildLine(t, ix, now);
      return built ? [built] : [];
    });

  const lines = builtLines.map(b => b.line);
  const spans = waitingAgents(facts, lines, now);
  const waiting = spans.flatMap(({ to, ...wait }) => to === null ? [wait] : []);
  const waitingSources = spans.map(waitSource);
  const turnStarted = facts.turn.openedAt ?? facts.turn.createdAt;
  const observed = observedTime(facts, ix, lines, now);
  const timeEntries = [...lines.map(l => ({ agentId: l.agent.id, segments: l.segments })), ...observed, ...waitingSources.map(w => ({ agentId: w.agent.id, segments: w.segments }))];

  return {
    now: now.toISOString(),
    turn: {
      id: facts.turn.id,
      number: facts.turn.number,
      branch: `turn-${facts.turn.number}`,
      startedAt: turnStarted.toISOString(),
    },
    repository: facts.repository,
    lines,
    waiting,
    activity: observed.map(({ jobId, agent, task, segments }) => ({ jobId, agent, task, segments })),
    time: agentTime(facts.agents, timeEntries, turnStarted, now),
    idle: idleStretches([...builtLines.map(b => b.idle), ...waitingSources], now),
  };
}
