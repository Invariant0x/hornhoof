import type {
  Department, DepartmentTree, SegmentKind, TreeAgent, TreeLine, TreeMove, TreeReview, TreeReviewer, TreeSegment, TreeVerdict,
} from '../types';
import type { Point } from '../ui/wires';

export const SEGMENT_CLASS: Record<SegmentKind, string> = { work: 'w', after: 'af', person: 'ps', stall: 'st' };
export const reviewsOf = (tree: DepartmentTree): TreeReview[] => tree.reviews ?? (tree.review ? [tree.review] : []);
export const trunkBranch = (department: Department) => department.repository?.branch ?? 'main';
export const treeClock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
export const secondsBetween = (from: string, to: string) => Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
export const currentSegment = (segments: TreeSegment[], now: string) => segments.find(s => s.from <= now && (!s.to || s.to > now));
export const latestLines = (lines: TreeLine[]) => [
  ...lines.reduce((all, line) => {
    const old = all.get(line.agent.id);
    if (!old || line.createdAt > old.createdAt) all.set(line.agent.id, line);
    return all;
  }, new Map<string, TreeLine>()).values(),
];

export function idleClass(kind: Exclude<SegmentKind, 'work'>): string {
  if (kind === 'stall') return 'a';
  if (kind === 'person') return 'p';
  return 'm';
}

export type TreePick = {
  kind: 'line' | 'reviewer' | 'move' | 'merge' | 'main' | 'turn' | 'review';
  agentId?: string;
  taskId?: string;
  moveIndex?: number;
};
export type TreeRow = {
  type: 'axis' | 'main' | 'turn' | 'lane';
  y: number;
  h: number;
  agent?: TreeAgent;
  line?: TreeLine;
  reviewer?: TreeReviewer;
  review?: TreeReview;
  lines?: TreeLine[];
  reviews?: { review: TreeReview; reviewer: TreeReviewer }[];
  current?: boolean;
  pick?: TreePick;
};
export type TreePath = {
  kind: 'grid' | 'now' | 'main' | 'turn' | 'segment' | 'fork' | 'merge' | 'bridge';
  points: Point[];
  cls: string;
  row?: string;
  dim?: boolean;
};
export type TreeMark = {
  kind: 'start' | 'fork' | 'merge' | 'done' | 'move' | 'head' | 'verdict' | 'review';
  x: number;
  y: number;
  cls: string;
  dim?: boolean;
  move?: TreeMove;
  verdict?: TreeVerdict;
  pick: TreePick;
};
export type TreeBadge = {
  kind: Exclude<SegmentKind, 'work'>;
  minutes: number;
  waitsFor: number[];
  x: number;
  y: number;
  row: string;
};
export type TreeTarget = { pick: TreePick; row: string; x: number; y: number; width: number; height: number; round: boolean };
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
const center = (r: TreeRow) => r.y + r.h / 2;

type Lane = Omit<TreeRow, 'y' | 'h'>;

function laneFor(lanes: Map<string, Lane>, agent: TreeAgent): Lane {
  const row = lanes.get(agent.id) ?? { type: 'lane', agent, lines: [], reviews: [] };
  lanes.set(agent.id, row);
  return row;
}

function labelledLane(row: Lane): Lane {
  row.lines!.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const line = row.lines!.at(-1), last = row.reviews!.at(-1);
  if (last && (!line || last.review.openedAt >= line.createdAt)) {
    return { ...row, reviewer: last.reviewer, review: last.review, pick: { kind: 'reviewer', taskId: last.review.taskId, agentId: row.agent!.id } };
  }
  return { ...row, line, pick: { kind: 'line', taskId: line!.taskId, agentId: row.agent!.id } };
}

function lanesOf(tree: DepartmentTree): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const line of tree.lines) laneFor(lanes, line.agent).lines!.push(line);
  for (const review of reviewsOf(tree)) {
    for (const reviewer of review.reviewers) laneFor(lanes, reviewer.agent).reviews!.push({ review, reviewer });
  }
  return [...lanes.values()].map(labelledLane);
}

function rowsOf(tree: DepartmentTree, phone: boolean, height: number): TreeRow[] {
  const lanes = lanesOf(tree);
  const trunk = phone ? 34 : 40;
  const fixed = 32 + (tree.repository ? trunk * 2 + 8 : 0) + 12;
  const laneHeight = Math.min(phone ? 58 : 84, Math.max(phone ? 50 : 60, Math.floor((height - fixed) / Math.max(1, lanes.length))));
  const rows: TreeRow[] = [{ type: 'axis', y: 0, h: 32 }];
  if (tree.repository) {
    rows.push(
      { type: 'main', y: 0, h: trunk, pick: { kind: 'main' } },
      { type: 'turn', y: 0, h: trunk + 8, pick: { kind: 'turn' } },
    );
  }
  rows.push(...lanes.map(r => ({ ...r, y: 0, h: laneHeight })));
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

function path(d: Drawing, kind: TreePath['kind'], cls: string, points: Point[], row?: string, dim = false) {
  d.layout.paths.push({ kind, cls, points, row, dim });
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

function segments(
  d: Drawing, row: TreeRow, list: TreeSegment[], end: string,
  dim: boolean, live: boolean, cut?: string | null, plain = false,
) {
  const { layout: l, tree } = d, y = center(row);
  for (const s of list) {
    const from = s.from < l.from ? l.from : s.from;
    const to = s.to && s.to < end ? s.to : end;
    if (to <= from) continue;
    const x1 = l.x(from) + (s.from === cut && s.kind !== 'after' ? R : 0) + (plain && s.from === row.line?.createdAt ? 3.4 : 0);
    const x2 = l.x(to) - (dim && !plain && to === end ? R : 0);
    if (x2 <= x1) continue;
    path(d, 'segment', `seg ${SEGMENT_CLASS[s.kind]}`, [[x1, y], [x2, y]], row.agent?.id, dim);
    if (live && !dim && s.kind === 'work' && to === tree.now && x2 - x1 > 20) {
      l.pulses.push([[Math.max(x1, x2 - 200), y], [x2, y]]);
    }
  }
}

function head(d: Drawing, row: TreeRow, list: TreeSegment[], waitsFor: number[] = []) {
  const { layout: l, tree } = d, y = center(row);
  const s = currentSegment(list, tree.now), kind = s?.kind ?? 'work';
  mark(d, { kind: 'head', x: l.nowX, y, cls: SEGMENT_CLASS[kind], pick: row.pick! });
  if (s && kind !== 'work') {
    l.badges.push({
      kind,
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

function reviewLane(d: Drawing, row: TreeRow, openedAt: string) {
  const reviewer = row.reviewer!, verdict = reviewer.verdict, y = center(row), x = d.layout.x(openedAt);
  if (d.tree.repository) path(d, 'fork', 'cn c', [[x, d.turnY], [x, y - R], [x + R, y]], row.agent!.id, !!verdict);
  else mark(d, { kind: 'start', x, y, cls: 'ring m', dim: !!verdict, pick: row.pick! });
  segments(
    d, row, reviewer.segments, verdict?.at ?? d.tree.now, !!verdict, reviewer.live,
    d.tree.repository ? openedAt : null, !d.tree.repository,
  );
  if (verdict) {
    mark(d, {
      kind: 'verdict',
      x: d.layout.x(verdict.at),
      y,
      cls: verdict.pass && !verdict.findings ? 'ok' : 'a',
      verdict,
      pick: row.pick!,
    });
  } else {
    currentHead(d, row, reviewer.segments);
  }
}

function drawLane(d: Drawing, row: TreeRow) {
  for (const line of row.lines ?? []) {
    workLane(d, { ...row, line, current: row.pick?.taskId === line.taskId, pick: { kind: 'line', agentId: line.agent.id, taskId: line.taskId } });
  }
  for (const { review, reviewer } of row.reviews ?? []) {
    reviewLane(d, { ...row, reviewer, current: row.pick?.taskId === review.taskId && !review.closedAt, pick: { kind: 'reviewer', agentId: reviewer.agent.id, taskId: review.taskId } }, review.openedAt);
  }
}

function reviewMark(d: Drawing, review: TreeReview) {
  if (d.tree.repository) mark(d, { kind: 'review', x: d.layout.x(review.openedAt), y: d.turnY, cls: 'via okf', pick: { kind: 'review', taskId: review.taskId } });
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
      row: row.agent?.id ?? row.type,
      x: 0,
      y: row.y,
      width: layout.width,
      height: row.h,
      round: false,
    });
  }
}

export function treeLayout(tree: DepartmentTree, box: { width: number; height: number; phone: boolean }, zoom: number): TreeLayout {
  const from = windowStart(tree), rows = rowsOf(tree, box.phone, box.height);
  /* A phone's labels leave room for what the agent does in two short lines. */
  const labelWidth = box.phone ? 132 : 184, tail = box.phone ? 108 : 168;
  const available = Math.max(140, box.width - labelWidth - tail - 12);
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
  reviewsOf(tree).forEach(r => reviewMark(d, r));
  rowTargets(layout);
  return layout;
}
