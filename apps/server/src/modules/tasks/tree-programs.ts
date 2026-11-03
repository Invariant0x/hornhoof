import { LOST_END_MS } from '@hornhoof/protocol/map';
import type { jobs } from '../../db/schema.js';
import type { ProgramChange } from './silent.js';
import type { ExternalWait, SegmentKind, TreeAgent, TreeSegment } from './tree.js';

export type ProgramPoint = ProgramChange & { at: Date };
export type FactTurn = Pick<typeof jobs.$inferSelect, 'id' | 'taskId' | 'createdAt' | 'startedAt' | 'finishedAt' | 'status'> & {
  agentId: string;
  history: ProgramPoint[];
};
type ReportedProgram = NonNullable<ProgramChange['program']>;

function programKind(program: ReportedProgram, end: number): SegmentKind {
  switch (program.state) {
    case 'thinking':
    case 'tool': return 'work';
    case 'asking': return 'person';
    case 'gone': return 'lost';
    case 'idle': return end - program.since >= LOST_END_MS ? 'lost' : 'stall';
  }
}

function changedPrograms(points: ProgramPoint[]): ReportedProgram[] {
  const out: ReportedProgram[] = [];
  for (const point of points) {
    if (point.program && point.program.state !== out.at(-1)?.state) out.push(point.program);
  }
  return out;
}

function programSegments(turn: FactTurn, end: number): TreeSegment[] {
  const programs = changedPrograms(turn.history);
  return programs.map((program, i) => {
    const next = programs[i + 1];
    const to = next ? new Date(next.since).toISOString() : turn.finishedAt?.toISOString() ?? null;
    return { kind: programKind(program, next?.since ?? end), from: new Date(program.since).toISOString(), to, program };
  });
}

const alarmKey = (point: ProgramPoint): string => point.alarm ? `${point.alarm.reason}:${point.alarm.since}` : '';

function changedAlarms(points: ProgramPoint[]): ProgramPoint[] {
  const out: ProgramPoint[] = [];
  for (const point of points) {
    if (alarmKey(point) !== (out.at(-1) ? alarmKey(out.at(-1)!) : '')) out.push(point);
  }
  return out;
}

function alarmSegments(turn: FactTurn): TreeSegment[] {
  const changes = changedAlarms(turn.history);
  return changes.flatMap((point, i) => {
    if (!point.alarm) return [];
    return [{ kind: 'alarm', from: new Date(point.alarm.since).toISOString(),
      to: changes[i + 1]?.at.toISOString() ?? turn.finishedAt?.toISOString() ?? null, alarm: point.alarm }];
  });
}

function queuedSegment(turn: FactTurn, agent: TreeAgent): TreeSegment[] {
  const to = turn.startedAt ?? turn.finishedAt;
  if (to && to <= turn.createdAt) return [];
  return [{ kind: 'queued', from: turn.createdAt.toISOString(), to: to?.toISOString() ?? null, waitsForAgent: agent }];
}

export function turnSegments(turn: FactTurn, agent: TreeAgent, now: Date): TreeSegment[] {
  const end = (turn.finishedAt ?? now).getTime();
  const running: TreeSegment[] = turn.startedAt ? [{ kind: 'unknown', from: turn.startedAt.toISOString(), to: turn.finishedAt?.toISOString() ?? null }] : [];
  return [...queuedSegment(turn, agent), ...running, ...programSegments(turn, end), ...alarmSegments(turn)];
}

function covers(segment: TreeSegment, from: number, to: number, end: number): boolean {
  return Date.parse(segment.from) <= from && (segment.to ? Date.parse(segment.to) : end) >= to;
}

function sameDetails(a: TreeSegment, b: TreeSegment): boolean {
  return a.kind === b.kind && a.program === b.program && a.alarm === b.alarm && a.waitsForAgent === b.waitsForAgent && a.externalWait === b.externalWait;
}

function appendSegment(out: TreeSegment[], segment: TreeSegment): void {
  const previous = out.at(-1);
  if (previous && previous.to === segment.from && sameDetails(previous, segment)) previous.to = segment.to;
  else out.push(segment);
}

function partition(base: TreeSegment[], overlays: TreeSegment[], now: Date): TreeSegment[] {
  const start = Date.parse(base[0]!.from), end = Date.parse(base.at(-1)!.to ?? now.toISOString());
  const all = [...base, ...overlays];
  if (start === end) return [{ ...all.filter(s => covers(s, start, end, end)).at(-1)!, from: base[0]!.from, to: base.at(-1)!.to }];
  const bounds = [...new Set([start, end, ...all.flatMap(s => [Date.parse(s.from), Date.parse(s.to ?? now.toISOString())])])]
    .filter(at => start <= at && at <= end).sort((a, b) => a - b);
  const out: TreeSegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i]!, to = bounds[i + 1]!;
    const source = all.filter(s => covers(s, from, to, end)).at(-1)!;
    appendSegment(out, { ...source, from: new Date(from).toISOString(), to: to === end && source.to === null ? null : new Date(to).toISOString() });
  }
  return out;
}

/* Only observed programs and alarms fill historical work. A gap in that evidence remains unknown. */
export function withPrograms(base: TreeSegment[], turns: FactTurn[], agent: TreeAgent, now: Date): TreeSegment[] {
  if (!turns.length) return base;
  return partition(base, turns.flatMap(turn => turnSegments(turn, agent, now)), now);
}

const TIME_RANK: Record<SegmentKind, number> = { unknown: 0, stall: 1, after: 2, person: 3, work: 4, lost: 5, alarm: 6, queued: 7 };

/* Task lifetimes may overlap. An agent's elapsed time counts once; each queued message keeps its own wait. */
export function countedSegments(segments: TreeSegment[], now: Date): TreeSegment[] {
  const queued = segments.filter(s => s.kind === 'queued');
  const states = segments.filter(s => s.kind !== 'queued').sort((a, b) => TIME_RANK[a.kind] - TIME_RANK[b.kind]);
  if (!states.length) return queued;
  const from = states.map(s => s.from).sort()[0]!;
  const to = states.map(s => s.to ?? now.toISOString()).sort().at(-1)!;
  return [...partition([{ kind: 'unknown', from, to }], states, now), ...queued];
}

/* An explicit task wait is a normal dependency wait, independent of a program's silence. */
export function withExternalWait(base: TreeSegment[], wait: ExternalWait | null | undefined, now: Date): TreeSegment[] {
  if (!wait) return base;
  const to = Date.parse(wait.until) > now.getTime() ? null : wait.until;
  return partition(base, [{ kind: 'after', from: wait.since, to, externalWait: wait }], now);
}
