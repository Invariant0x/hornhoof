import type {
  Department, DepartmentTree, SegmentKind, TreeActivity, TreeAgent, TreeLine, TreeMove, TreeSegment,
} from '../types';
import type { Point } from '../ui/wires';
import { CH, CW } from './schema';

export const SEGMENT_CLASS: Record<SegmentKind, string> = { work: 'w', after: 'af', person: 'ps', stall: 'st', lost: 'ls', alarm: 'al', queued: 'q', unknown: 'u' };
export const trunkBranch = (department: Department) => department.repository?.branch ?? 'main';
export const treeClock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
export const secondsBetween = (from: string, to: string) => Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
export const currentSegment = (segments: TreeSegment[], now: string) => segments.find(s => s.from <= now && (!s.to || s.to > now));

const IDLE_CLASS = { stall: 'm', person: 'p', after: 'm', lost: 'bad', alarm: 'bad', queued: 'm', unknown: 'm' };
export const idleClass = (kind: Exclude<SegmentKind, 'work'>): string => IDLE_CLASS[kind];

export type TreePick = {
  kind: 'activity' | 'line' | 'move' | 'merge' | 'main' | 'turn';
  agentId?: string;
  taskId?: string;
  moveIndex?: number;
  jobId?: string;
  segmentIndex?: number;
};
export type TreeRow = {
  type: 'axis' | 'main' | 'turn' | 'lane';
  y: number;
  h: number;
  agent?: TreeAgent;
  line?: TreeLine;
  lines?: TreeLine[];
  current?: boolean;
  activities?: TreeActivity[];
  activity?: TreeActivity;
  pick?: TreePick;
};
export type TreePath = {
  kind: 'grid' | 'now' | 'main' | 'turn' | 'segment' | 'fork' | 'merge' | 'bridge';
  points: Point[];
  cls: string;
  row?: string;
  dim?: boolean;
  segmentKind?: SegmentKind;
};
export type TreeMark = {
  kind: 'start' | 'fork' | 'merge' | 'done' | 'move' | 'head';
  x: number;
  y: number;
  cls: string;
  dim?: boolean;
  move?: TreeMove;
  pick: TreePick;
};
export type TreeBadge = {
  kind: Exclude<SegmentKind, 'work'>;
  from: string;
  program?: TreeSegment['program'];
  alarm?: TreeSegment['alarm'];
  waitsForAgent?: TreeAgent;
  externalWait?: TreeSegment['externalWait'];
  minutes: number;
  waitsFor: number[];
  x: number;
  y: number;
  row: string;
};
export type TreeTarget = { pick: TreePick; row: string; x: number; y: number; width: number; height: number; round: boolean; segment?: TreeSegment };
export type TreeLayout = {
  rows: TreeRow[];
  paths: TreePath[];
  marks: TreeMark[];
  badges: TreeBadge[];
  targets: TreeTarget[];
  pulses: Point[][];
  grid: { at: string; x: number }[];
  from: string;
  scale: number;
  labelWidth: number;
  width: number;
  height: number;
  nowX: number;
  x(at: string): number;
};
type Drawing = { tree: DepartmentTree; layout: TreeLayout; turnY: number };
const R = 8;

/* A plate is the size of an employee's chip on the map, on every screen and beside any number of others: the tree moves and
   zooms instead of squeezing it. Every lane keeps that fixed size, with long text clipped inside it. */
const PLATE_HEIGHT = { axis: 0, main: 32, turn: 40, lane: CH };
const PLATE_WIDTH = CW;
export const plateKey = (row: Pick<TreeRow, 'type' | 'agent'>): string => row.agent?.id ?? row.type;
export const plateHeight = (row: Pick<TreeRow, 'type'>): number => PLATE_HEIGHT[row.type];
export const plateRoom = (row: Pick<TreeRow, 'agent'>): number => row.agent ? 6 : 4;
const center = (r: TreeRow) => r.y + r.h / 2;

const STATE_PRIORITY: Record<SegmentKind, number> = { unknown: 0, queued: 1, stall: 2, after: 3, person: 4, work: 5, lost: 6, alarm: 7 };
export const statePriority = (kind: SegmentKind): number => STATE_PRIORITY[kind];
const containsNow = (s: TreeSegment, now: string) => s.from <= now && (!s.to || s.to > now);

function strongestCurrent(segments: TreeSegment[], now: string): TreeSegment | undefined {
  return segments.filter(s => containsNow(s, now)).sort((a, b) => statePriority(a.kind) - statePriority(b.kind) || a.from.localeCompare(b.from)).at(-1);
}

function lastSegment(segments: TreeSegment[], now: string): TreeSegment | undefined {
  return [...segments].sort((a, b) => (a.to ?? now).localeCompare(b.to ?? now) || statePriority(a.kind) - statePriority(b.kind)).at(-1);
}

type ActivityItem = { activity: TreeActivity; segment: TreeSegment; index: number };
function activityItem(activities: TreeActivity[], now: string): ActivityItem | undefined {
  const items = activities.flatMap(activity => activity.segments.map((segment, index) => ({ activity, segment, index })));
  const segments = items.map(i => i.segment), chosen = strongestCurrent(segments, now) ?? lastSegment(segments, now);
  return items.find(i => i.segment === chosen);
}

function activityPick(item: ActivityItem): TreePick {
  return { kind: 'activity', agentId: item.activity.agent.id, jobId: item.activity.jobId, segmentIndex: item.index };
}

export function agentSegments(tree: DepartmentTree, agentId: string): TreeSegment[] {
  return [...tree.lines.filter(l => l.agent.id === agentId).flatMap(l => l.segments),
    ...(tree.activity ?? []).filter(a => a.agent.id === agentId).flatMap(a => a.segments),
    ...tree.idle.filter(i => i.agent.id === agentId && i.waitsForAgent),
  ].sort((a, b) => statePriority(a.kind) - statePriority(b.kind));
}

type Lane = Omit<TreeRow, 'y' | 'h'>;

function laneFor(lanes: Map<string, Lane>, agent: TreeAgent): Lane {
  const row = lanes.get(agent.id) ?? { type: 'lane', agent, lines: [], activities: [] };
  lanes.set(agent.id, row);
  return row;
}

function labelledLane(row: Lane, now: string): Lane {
  const observed = activityItem(row.activities!, now), activity = observed?.activity;
  row.lines!.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const line = row.lines!.findLast(l => l.live) ?? row.lines!.at(-1);
  if (!line) return { ...row, activity, pick: activityPick(observed!) };
  return { ...row, activity, line, pick: { kind: 'line', taskId: line.taskId, agentId: row.agent!.id } };
}

function addActivityLanes(lanes: Map<string, Lane>, activities: TreeActivity[] = []): void {
  for (const activity of activities) laneFor(lanes, activity.agent).activities!.push(activity);
}

export function lanesOf(tree: DepartmentTree): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const line of tree.lines) laneFor(lanes, line.agent).lines!.push(line);
  addActivityLanes(lanes, tree.activity);
  return [...lanes.values()].map(row => labelledLane(row, tree.now));
}

export function rowTaskNumber(row: Pick<TreeRow, 'line' | 'activity'>): number | undefined {
  return (row.line ?? row.activity?.task)?.number;
}

export function currentTaskNumber(tree: DepartmentTree, agentId: string): number | undefined {
  const row = lanesOf(tree).find(r => r.agent?.id === agentId);
  return row ? rowTaskNumber(row) : undefined;
}

function orderedLanes(tree: DepartmentTree, agentOrder: string[]): Lane[] {
  const ranks = new Map(agentOrder.map((id, i) => [id, i]));
  const rank = (id: string) => ranks.get(id) ?? ranks.size;
  return lanesOf(tree).sort((a, b) => rank(a.agent!.id) - rank(b.agent!.id));
}

function rowsOf(tree: DepartmentTree, agentOrder: string[] = []): TreeRow[] {
  const sized = (row: Lane): TreeRow => ({ ...row, y: 0, h: plateHeight(row) + plateRoom(row) * 2 });
  const rows: TreeRow[] = [{ type: 'axis', y: 0, h: 32 }];
  if (tree.repository) rows.push(sized({ type: 'main', pick: { kind: 'main' } }), sized({ type: 'turn', pick: { kind: 'turn' } }));
  rows.push(...orderedLanes(tree, agentOrder).map(sized));
  let y = 0;
  for (const row of rows) {
    row.y = y;
    y += row.h;
  }
  return rows;
}

function windowStart(tree: DepartmentTree): string {
  return new Date(Date.parse(tree.turn?.startedAt ?? tree.now) - 720_000).toISOString();
}

function path(d: Drawing, kind: TreePath['kind'], cls: string, points: Point[], row?: string, dim = false): TreePath {
  const drawn = { kind, cls, points, row, dim };
  d.layout.paths.push(drawn);
  return drawn;
}

function mark(d: Drawing, m: TreeMark) {
  d.layout.marks.push(m);
  d.layout.targets.push({ pick: m.pick, row: m.pick.agentId ?? 'turn', x: m.x, y: m.y, width: 20, height: 20, round: true });
}

function trunks(d: Drawing) {
  const { tree, layout: l, turnY } = d;
  if (!tree.repository || !tree.turn) return;
  const mainY = center(l.rows[1]!);
  path(d, 'main', 'tk main', [[12, mainY], [l.nowX, mainY]]);
  const startX = l.x(tree.turn.startedAt);
  if (tree.turn.startedAt >= l.from) {
    path(d, 'fork', 'cn k', [[startX, mainY], [startX, turnY - R], [startX + R, turnY]]);
    mark(d, { kind: 'fork', x: startX, y: mainY, cls: 'via k', pick: { kind: 'turn' } });
  }
  path(d, 'turn', 'tk turn', [[tree.turn.startedAt >= l.from ? startX + R : 12, turnY], [l.nowX, turnY]]);
}

function connections(d: Drawing, row: TreeRow, line: TreeLine, end: string, done: boolean) {
  const { layout: l, turnY } = d, y = center(row), who = line.agent.id;
  if (line.cutAt && line.cutAt <= d.tree.now) {
    const x = l.x(line.cutAt);
    path(d, 'bridge', 'ko', [[x, turnY + 6], [x, y - R - 1]], who);
    path(d, 'fork', 'cn c', [[x, turnY], [x, y - R], [x + R, y]], who, done);
    mark(d, { kind: 'fork', x, y: turnY, cls: 'via c', dim: done, pick: row.pick! });
  }
  if (!done) return;
  const x = l.x(end);
  path(d, 'bridge', 'ko', [[x, y - R - 1], [x, turnY + 6]], who);
  path(d, 'merge', 'cn ok', [[x - R, y], [x, y - R], [x, turnY]], who);
  mark(d, { kind: 'merge', x, y: turnY, cls: 'via ok', pick: { ...row.pick!, kind: 'merge' } });
}

function needsPulse(d: Drawing, row: TreeRow, s: TreeSegment, to: string, dim: boolean, live: boolean): boolean {
  if (!live || dim || s.kind !== 'work' || to !== d.tree.now) return false;
  return strongestCurrent(agentSegments(d.tree, row.agent!.id), d.tree.now)?.kind === 'work';
}

function segments(
  d: Drawing, row: TreeRow, list: TreeSegment[], end: string,
  dim: boolean, live: boolean, cut?: string | null, plain = false,
) {
  const { layout: l } = d, y = center(row);
  for (const s of list) {
    const from = s.from < l.from ? l.from : s.from;
    const to = s.to && s.to < end ? s.to : end;
    if (to <= from) continue;
    const x1 = l.x(from) + (s.from === cut && s.kind !== 'after' ? R : 0) + (plain && s.from === row.line?.createdAt ? 3.4 : 0);
    const x2 = l.x(to) - (dim && !plain && to === end ? R : 0);
    if (x2 <= x1) continue;
    path(d, 'segment', `seg ${SEGMENT_CLASS[s.kind]}`, [[x1, y], [x2, y]], row.agent?.id, dim).segmentKind = s.kind;
    l.targets.push({ pick: row.pick!, row: row.agent!.id, x: x1, y: y - 8, width: x2 - x1, height: 16, round: false, segment: s });
    if (needsPulse(d, row, s, to, dim, live)) {
      l.pulses.push([[Math.max(x1, x2 - 200), y], [x2, y]]);
    }
  }
}

function head(d: Drawing, row: TreeRow, list: TreeSegment[], waitsFor: number[] = []) {
  const { layout: l, tree } = d, y = center(row);
  const s = currentSegment(list, tree.now), kind = s?.kind ?? 'unknown';
  mark(d, { kind: 'head', x: l.nowX, y, cls: SEGMENT_CLASS[kind], pick: row.pick! });
  if (s && kind !== 'work') {
    l.badges.push({
      kind, from: s.from, program: s.program, alarm: s.alarm, waitsForAgent: s.waitsForAgent, externalWait: s.externalWait,
      minutes: secondsBetween(s.from, tree.now) / 60,
      waitsFor,
      x: l.nowX + 11,
      y,
      row: row.agent!.id,
    });
  }
}

function moveClass(move: TreeMove, line: TreeLine, now: string): string {
  const unanswered = move.kind === 'asked' && currentSegment(line.segments, now)?.kind === 'person';
  return unanswered ? 'mv br' : 'mv';
}

function moves(d: Drawing, row: TreeRow, line: TreeLine, dim: boolean) {
  line.moves.forEach((move, moveIndex) => {
    if (move.kind === 'started' || move.at < d.layout.from || move.at > d.tree.now) return;
    mark(d, {
      kind: 'move',
      move,
      x: d.layout.x(move.at),
      y: center(row),
      cls: moveClass(move, line, d.tree.now),
      dim,
      pick: { ...row.pick!, kind: 'move', moveIndex },
    });
  });
}

function currentHead(d: Drawing, row: TreeRow, list: TreeSegment[], waitsFor: number[] = []) {
  if (row.current !== false) head(d, row, list, waitsFor);
}

function workLane(d: Drawing, row: TreeRow) {
  const line = row.line!, plain = !d.tree.repository || !line.branch;
  const stopped = plain ? line.doneAt : line.mergedAt;
  const done = !!stopped && stopped <= d.tree.now;
  const end = done ? stopped : d.tree.now;
  if (plain || !line.cutAt || line.createdAt < line.cutAt) {
    mark(d, {
      kind: 'start',
      x: d.layout.x(line.createdAt),
      y: center(row),
      cls: 'ring m',
      dim: done,
      pick: row.pick!,
    });
  }
  segments(d, row, line.segments, end, done, line.live, plain ? null : line.cutAt, plain);
  if (!plain) connections(d, row, line, end, done);
  moves(d, row, line, done);
  if (plain && done) mark(d, { kind: 'done', x: d.layout.x(end), y: center(row), cls: 'sq', pick: row.pick! });
  if (!done) currentHead(d, row, line.segments, line.waitsFor);
}

function drawWait(d: Drawing, row: TreeRow) {
  const list: TreeSegment[] = d.tree.idle.filter(i => i.agent.id === row.agent?.id && i.waitsForAgent && (i.kind === 'stall' || i.kind === 'after'));
  if (!list.length) return;
  segments(d, row, list, d.tree.now, false, false);
  if (currentSegment(list, d.tree.now)) head(d, row, list);
}

/* lanesOf supplies both arrays for every lane, including agents with only observed history. */
function drawActivityHead(d: Drawing, row: TreeRow, item: ActivityItem | undefined) {
  if (!item || !containsNow(item.segment, d.tree.now)) return;
  const strongest = strongestCurrent(agentSegments(d.tree, row.agent!.id), d.tree.now);
  if (strongest !== item.segment) return;
  d.layout.badges = d.layout.badges.filter(b => b.row !== row.agent!.id);
  head(d, { ...row, pick: activityPick(item) }, [item.segment]);
}

function drawActivity(d: Drawing, row: TreeRow) {
  for (const activity of row.activities!) {
    activity.segments.forEach((segment, index) => segments(d, { ...row, pick: activityPick({ activity, segment, index }) }, [segment], d.tree.now, false, true));
  }
  drawActivityHead(d, row, activityItem(row.activities!, d.tree.now));
}

function drawLane(d: Drawing, row: TreeRow) {
  for (const line of row.lines!) {
    workLane(d, { ...row, line, current: row.pick?.taskId === line.taskId, pick: { kind: 'line', agentId: line.agent.id, taskId: line.taskId } });
  }
  drawWait(d, row);
  drawActivity(d, row);
}

function gridLines(d: Drawing) {
  const { tree, layout: l } = d;
  const step = 3_600_000;
  for (let at = Math.ceil(Date.parse(l.from) / step) * step; at < Date.parse(tree.now); at += step) {
    const time = new Date(at).toISOString(), gx = l.x(time);
    path(d, 'grid', 'g-hr', [[gx, 26], [gx, l.height]]);
    if (l.nowX - gx > 40) l.grid.push({ at: time, x: gx });
  }
  path(d, 'now', 'g-now', [[l.nowX, 24], [l.nowX, l.height]]);
}

function rowTargets(layout: TreeLayout) {
  for (const row of layout.rows.filter(r => r.pick)) {
    layout.targets.unshift({
      pick: row.pick!,
      row: plateKey(row),
      x: 0,
      y: row.y,
      width: layout.width,
      height: row.h,
      round: false,
    });
  }
}

export function treeLayout(tree: DepartmentTree, box: { width: number; phone: boolean; agentOrder?: string[] }, zoom: number): TreeLayout {
  const from = windowStart(tree), rows = rowsOf(tree, box.agentOrder);
  const labelWidth = PLATE_WIDTH + 10, tail = box.phone ? 108 : 168;
  /* On a phone the time axis starts in what is left beside the plates, so the fork of a young turn is on the screen. */
  const available = Math.max(box.phone ? 64 : 140, box.width - labelWidth - tail - 12);
  const scale = Math.min(18, Math.max(box.phone ? .9 : 1.2, available / Math.max(1, secondsBetween(from, tree.now) / 60))) * zoom;
  const x = (at: string) => Math.round((12 + (Date.parse(at) - Date.parse(from)) / 60_000 * scale) * 10) / 10;
  const height = rows.reduce((n, r) => n + r.h, 10), nowX = x(tree.now);
  const layout: TreeLayout = {
    from, rows, scale, labelWidth, width: Math.ceil(nowX + tail), height, nowX, x,
    paths: [], marks: [], badges: [], targets: [], pulses: [], grid: [],
  };
  const d: Drawing = { tree, layout, turnY: center(rows.find(r => r.type === 'turn') ?? rows[0]!) };
  gridLines(d);
  trunks(d);
  rows.filter(r => r.agent).forEach(r => drawLane(d, r));
  rowTargets(layout);
  return layout;
}
