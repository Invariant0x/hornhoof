import { peopleLayout, rowCenters, wirePeople, type PeopleLayout, type PersonChip, type PersonRoute } from './map-people';
import { departmentPeople, wholeCompanyPeople } from './org';
import type { Org } from './types';
import { orthoRoute, type Rect } from './ui/ortho';
import type { Point } from './ui/wires';

/* World coordinates, laid out like the prototype: people on top, the orchestrator in the middle, departments in two columns around him. */
export const W = 1200, H = 900, CX = W / 2, CY = 420, HUB = 120;
export const CHIP_W = 160, CHIP_H = 56, CHIP_GAP = 20;
export const DEPT_W = 280, DEPT_H = 160;
/* Up to two rows sit at the prototype's corners; more rows stack evenly around the hub, this far apart. */
const CORNER = 220, ROW = 220;
/* Room between the people and the top row, and above whatever comes below the hub or the lowest row. */
export const GAP = 28;
/* Where a department trace turns: 84 out from the hub's middle, under the hub, and the inner side of each column. */
const BEND = 84, INNER = 210;
/* The company's turn sits right under the hub, between the traces that leave it downwards, in two lines at most. */
export const TURN_GAP = 10, TURN_W = 2 * BEND - 16, TURN_H = 56;
/* The glow around the hub, and the hint of an empty map under it. */
export const HALO = 260, START_H = 120;

export type DeptSpot = { x: number; y: number; w: number; h: number; path: Point[] };

/* How far above or below the hub each row's middle sits. */
function rowOffsets(rows: number): number[] {
  if (rows <= 2) return [-CORNER, CORNER].slice(0, rows);
  return Array.from({ length: rows }, (_, r) => (r - (rows - 1) / 2) * ROW);
}

/* Departments fill the left and right columns in turn, top row first. A row level with the hub runs straight out; the others
   run out under the hub, turn up or down beside it and come into the near side of their card, all at right angles. */
export function deptLayout(n: number): DeptSpot[] {
  const offsets = rowOffsets(Math.ceil(n / 2));
  return Array.from({ length: n }, (_, i) => {
    const side = i % 2 ? 1 : -1;
    const midY = CY + offsets[Math.floor(i / 2)]!;
    const edgeX = CX + side * INNER;
    return {
      x: side < 0 ? edgeX - DEPT_W : edgeX,
      y: midY - DEPT_H / 2,
      w: DEPT_W,
      h: DEPT_H,
      path: midY !== CY ? [[CX, CY], [CX + side * BEND, CY], [CX + side * BEND, midY], [edgeX, midY]] : [[CX, CY], [edgeX, CY]],
    };
  });
}

/* The people sit just above the top row, and their bus runs 14 below them. */
export function chipsTop(n: number): number {
  return CY + Math.min(-CORNER, rowOffsets(Math.ceil(n / 2))[0] ?? -CORNER) - DEPT_H / 2 - GAP - CHIP_H;
}
export const busY = (n: number) => chipsTop(n) + CHIP_H + 14;
export const chipsWidth = (n: number) => n * CHIP_W + Math.max(0, n - 1) * CHIP_GAP;
export const chipCenters = (n: number) => rowCenters(n, CHIP_W, CHIP_GAP);

/* A block of the map, as a person's arrangement names it. */
export const HUB_KEY = 'hub';
export const deptKey = (id: string) => `dept:${id}`;
export const personKey = (id: string) => `person:${id}`;
/* Where a person put blocks: the top left of each, by its key. A block not in it stands where the map places it. */
export type Placed = Record<string, { x: number; y: number }>;

export type Block = { key: string; rect: Rect };
/* via: the dot where the trace turns towards its card, on the trace the map draws itself. */
export type ArrangedDept = DeptSpot & { id: string; via: Point | null };
/* A whole-company person's card and the way to it from the hub. apart: the person took the card out of the row, and it has a
   line of its own from the middle of the hub. */
export type TopPerson = Rect & { id: string; path: Point[]; apart: boolean };
/* The quiet lines of the people who stay in the row: a line down from each card, the bus, the way from it to the hub, and the
   dot where that way leaves the bus. */
export type Bus = { lines: Point[][]; drop: Point[]; via: Point };

export type MapArrangement = {
  hub: Rect;
  turn: Rect;
  depts: ArrangedDept[];
  top: TopPerson[];
  bus: Bus | null;
  people: PeopleLayout;
  /* Every block, for the grips that move them and for what Fit shows. */
  blocks: Block[];
};

const pointAt = ([x, y]: Point): Rect => ({ x, y, w: 0, h: 0 });
const samePlace = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y;
const shifted = (pts: Point[], dx: number, dy: number): Point[] => pts.map(([x, y]) => [x + dx, y + dy]);
const placedAt = <R extends Rect>(placed: Placed, key: string, rect: R): R => (placed[key] ? { ...rect, x: placed[key].x, y: placed[key].y } : rect);

/* Drops repeated points and points in the middle of a straight run. */
function tidy(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1], before = out[out.length - 2];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    if (last && before && ((before[0] === last[0] && last[0] === p[0]) || (before[1] === last[1] && last[1] === p[1]))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/* Whether a line runs through the inside of any of these blocks. */
function crossesAny(pts: Point[], rects: Rect[]): boolean {
  return pts.slice(1).some((b, i) => {
    const a = pts[i]!;
    return rects.some(r => Math.max(a[0], b[0]) > r.x && Math.min(a[0], b[0]) < r.x + r.w && Math.max(a[1], b[1]) > r.y && Math.min(a[1], b[1]) < r.y + r.h);
  });
}

type Placing = { key: string; home: Rect; rect: Rect };

/* Where every block of the map stands for this person, and the lines between them. Nothing moved, it is the map as the map
   places it. A moved block keeps its lines at right angles: a line whose ends stand as placed keeps its way unless a moved
   block now stands across it; any other is routed again, around the blocks in its way. A person docked beside a department
   goes with it. */
export function arrangeMap(org: Org, placed: Placed = {}): MapArrangement {
  const n = org.departments.length;
  const spots = deptLayout(n);
  const hubHome = { x: CX - HUB, y: CY - HUB, w: 2 * HUB, h: 2 * HUB };
  const hub = placedAt(placed, HUB_KEY, hubHome);
  const hubMoved = !samePlace(hub, hubHome);
  const middle: Point = [hub.x + HUB, hub.y + HUB];

  const depts: Placing[] = org.departments.map((d, i) => {
    const home = { x: spots[i]!.x, y: spots[i]!.y, w: DEPT_W, h: DEPT_H };
    return { key: deptKey(d.id), home, rect: placedAt(placed, deptKey(d.id), home) };
  });
  const deptById = new Map(org.departments.map((d, i) => [d.id, depts[i]!]));

  const topPeople = wholeCompanyPeople(org);
  const top = chipsTop(n), bus = busY(n), centers = chipCenters(topPeople.length);
  const tops: (Placing & { id: string })[] = topPeople.map((p, i) => {
    const home = { x: centers[i]! - CHIP_W / 2, y: top, w: CHIP_W, h: CHIP_H };
    return { id: p.id, key: personKey(p.id), home, rect: placedAt(placed, personKey(p.id), home) };
  });

  const base = peopleLayout(org.departments.map((d, i) => ({ id: d.id, ...spots[i]! })), departmentPeople(org));
  const routesOf = (id: string) => base.routes.filter(r => r.personId === id);
  /* A person docked beside one department goes where it goes. */
  const chips: (Placing & { id: string; home: PersonChip; rect: PersonChip })[] = base.chips.map(c => {
    const own = routesOf(c.id);
    const dock = own.length === 1 && own[0]!.pts.length === 2 ? deptById.get(own[0]!.deptId) : undefined;
    const beside = dock ? { ...c, x: c.x + dock.rect.x - dock.home.x, y: c.y + dock.rect.y - dock.home.y } : c;
    return { id: c.id, key: personKey(c.id), home: c, rect: placedAt(placed, personKey(c.id), beside) };
  });
  const chipById = new Map(chips.map(c => [c.id, c]));

  const all: Placing[] = [{ key: HUB_KEY, home: hubHome, rect: hub }, ...depts, ...tops, ...chips];
  const others = (...ends: string[]) => all.filter(b => !ends.includes(b.key)).map(b => b.rect);
  const movedOthers = (...ends: string[]) => all.filter(b => !ends.includes(b.key) && !samePlace(b.rect, b.home)).map(b => b.rect);

  const arrangedDepts: ArrangedDept[] = org.departments.map((d, i) => {
    const spot = spots[i]!, { key, rect, home } = depts[i]!;
    const kept = !hubMoved && samePlace(rect, home) && !crossesAny(spot.path, movedOthers(HUB_KEY, key));
    const path = kept ? spot.path : orthoRoute(pointAt(middle), rect, others(HUB_KEY, key));
    return { id: d.id, ...rect, path, via: kept && path.length > 2 ? path[2]! : null };
  });

  /* The people who stay in the row keep its bus; the way down from it starts above the hub, or as near above it as the row
     reaches, and goes around a block moved into its way. */
  const stay = tops.filter(t => samePlace(t.rect, t.home));
  const xs = stay.map(t => t.rect.x + CHIP_W / 2);
  const under = (x: number): Point => [x, top + CHIP_H];
  let arrangedBus: Bus | null = null;
  let fromHub: Point[] = [];
  if (xs.length) {
    const join: Point = [hubMoved ? Math.min(Math.max(middle[0], Math.min(...xs)), Math.max(...xs)) : CX, bus];
    const straight: Point[] = [join, [CX, CY - HUB]];
    const drop = hubMoved || crossesAny(straight, movedOthers(HUB_KEY)) ? orthoRoute(pointAt(join), pointAt(middle), others(HUB_KEY)) : straight;
    const lo = Math.min(...xs, join[0]), hi = Math.max(...xs, join[0]);
    const across = tidy([...(xs.includes(lo) ? [under(lo)] : []), [lo, bus], [hi, bus], ...(xs.includes(hi) && hi !== lo ? [under(hi)] : [])]);
    arrangedBus = { lines: [across, ...xs.filter(x => x !== lo && x !== hi).map((x): Point[] => [under(x), [x, bus]])], drop, via: join };
    fromHub = [...drop].reverse();
  }
  const arrangedTop: TopPerson[] = tops.map(t => {
    const apart = !samePlace(t.rect, t.home), x = t.rect.x + CHIP_W / 2;
    const path = apart ? orthoRoute(pointAt(middle), t.rect, others(HUB_KEY, t.key)) : tidy([...fromHub, [x, bus], under(x)]);
    return { id: t.id, ...t.rect, path, apart };
  });

  const people = Object.keys(placed).length ? movedPeople(base, chips, chipById, deptById, others, movedOthers) : base;
  return {
    hub,
    turn: { x: middle[0] - TURN_W / 2, y: hub.y + 2 * HUB + TURN_GAP, w: TURN_W, h: TURN_H },
    depts: arrangedDepts,
    top: arrangedTop,
    bus: arrangedBus,
    people,
    blocks: all.map(({ key, rect }) => ({ key, rect })),
  };
}

/* The department people with their routes where their cards and departments now stand: a route whose two ends moved
   together moves with them, unless a moved block stands across it; any other is routed again. */
function movedPeople(
  base: PeopleLayout,
  chips: { id: string; key: string; home: PersonChip; rect: PersonChip }[],
  chipById: Map<string, { key: string; home: Rect; rect: Rect }>,
  deptById: Map<string, Placing>,
  others: (...ends: string[]) => Rect[],
  movedOthers: (...ends: string[]) => Rect[],
): PeopleLayout {
  const routes: PersonRoute[] = base.routes.map(r => {
    const chip = chipById.get(r.personId)!, dept = deptById.get(r.deptId)!;
    const dx = chip.rect.x - chip.home.x, dy = chip.rect.y - chip.home.y;
    if (dx === dept.rect.x - dept.home.x && dy === dept.rect.y - dept.home.y) {
      const pts = shifted(r.pts, dx, dy);
      if (!crossesAny(pts, movedOthers(chip.key, dept.key))) return { ...r, pts };
    }
    return { ...r, pts: orthoRoute(dept.rect, chip.rect, others(chip.key, dept.key)) };
  });
  const placedChips = chips.map(c => c.rect);
  return { chips: placedChips, routes, ...wirePeople(routes, placedChips) };
}

/* The part of the world that has something on it, so Fit fills the screen with it: the hub with its glow and what sits under
   it, every block and every line. */
export function arrangedBounds(arr: MapArrangement, org: Org): { x0: number; y0: number; x1: number; y1: number } {
  const mx = arr.hub.x + HUB;
  const below = arr.hub.y + 2 * HUB + GAP + (org.turn ? TURN_H : 0) + (org.departments.length ? 0 : START_H);
  const b = { x0: mx - HALO, x1: mx + HALO, y0: arr.hub.y, y1: below };
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    b.x0 = Math.min(b.x0, x0);
    b.y0 = Math.min(b.y0, y0);
    b.x1 = Math.max(b.x1, x1);
    b.y1 = Math.max(b.y1, y1);
  };
  for (const { rect: r } of arr.blocks) grow(r.x, r.y, r.x + r.w, r.y + r.h);
  for (const pts of [...arr.depts.map(d => d.path), ...arr.top.map(t => t.path), ...arr.people.wires.map(w => w.pts)]) for (const [x, y] of pts) grow(x, y, x, y);
  return b;
}
