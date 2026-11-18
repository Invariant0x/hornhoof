import { workingTurns } from './hub-turns';
import { peopleLayout, rowCenters, wirePeople, type PeopleLayout, type PersonChip, type PersonRoute } from './map-people';
import { joinRoads, roadForks, type Way } from './map-roads';
import { departmentPeople, wholeCompanyPeople } from './org';
import type { Org } from './types';
import { along, orthoRoute, orthoThrough, type Rect } from './ui/ortho';
import type { Point } from './ui/wires';

/* World coordinates: people on top, the orchestrator in the middle, departments in two columns around him. */
export const W = 1200, H = 900, CX = W / 2, CY = 420, HUB = 120;
const CHIP_W = 160, CHIP_H = 56, CHIP_GAP = 20;
/* A card grows by its turn strip while any department works in the turn, so every card of the map stays the same size. */
const DEPT_W = 280, DEPT_H = 160, DEPT_H_TURN = 196;
/* Up to two rows sit at the four corners; more rows stack evenly around the hub, this far apart, and never closer than
   ROW_GAP between the cards. */
const CORNER = 220, ROW = 220, ROW_GAP = 32;
/* Room between the people and the top row, and above whatever comes below the hub or the lowest row. */
export const GAP = 28;
/* Where a department trace turns: 84 out from the hub's middle, under the hub, and the inner side of each column. */
const BEND = 84, INNER = 210;
/* The glow around the hub, and the hint of an empty map under it. */
export const HALO = 260, START_H = 120;

export type DeptSpot = { x: number; y: number; w: number; h: number; path: Point[] };

/* How far above or below the hub each row's middle sits. */
function rowOffsets(rows: number, h: number): number[] {
  if (rows <= 2) return [-CORNER, CORNER].slice(0, rows);
  const step = Math.max(ROW, h + ROW_GAP);
  return Array.from({ length: rows }, (_, r) => (r - (rows - 1) / 2) * step);
}

/* How tall the cards of the map are: taller for the turn strip while any department works in the turn. */
const cardHeight = (org: Org): number => (workingTurns(org.departments).length ? DEPT_H_TURN : DEPT_H);

/* Departments fill the left and right columns in turn, top row first. A row level with the hub runs straight out; the others
   run out under the hub, turn up or down beside it and come into the near side of their card, all at right angles. */
export function deptLayout(n: number, h = DEPT_H): DeptSpot[] {
  const offsets = rowOffsets(Math.ceil(n / 2), h);
  return Array.from({ length: n }, (_, i) => {
    const side = i % 2 ? 1 : -1;
    const midY = CY + offsets[Math.floor(i / 2)]!;
    const edgeX = CX + side * INNER;
    return {
      x: side < 0 ? edgeX - DEPT_W : edgeX,
      y: midY - h / 2,
      w: DEPT_W,
      h,
      path: midY !== CY ? [[CX, CY], [CX + side * BEND, CY], [CX + side * BEND, midY], [edgeX, midY]] : [[CX, CY], [edgeX, CY]],
    };
  });
}

/* The people sit just above the top row, and their bus runs 14 below them. */
function chipsTop(n: number, h = DEPT_H): number {
  return CY + Math.min(-CORNER, rowOffsets(Math.ceil(n / 2), h)[0] ?? -CORNER) - h / 2 - GAP - CHIP_H;
}
export const busY = (n: number, h = DEPT_H) => chipsTop(n, h) + CHIP_H + 14;
const chipCenters = (n: number) => rowCenters(n, CHIP_W, CHIP_GAP);

/* A block of the map, as a person's arrangement names it. */
export const HUB_KEY = 'hub';
export const deptKey = (id: string) => `dept:${id}`;
export const personKey = (id: string) => `person:${id}`;
/* Where a person put blocks: the top left of each, by its key. A block not in it stands where the map places it. */
export type Placed = Record<string, { x: number; y: number }>;
/* A line of the map a person may bend, as their arrangement names it: the trace to a department by its block's key, the line
   to a person moved out of the people's row by theirs, the way from the people's row down to the hub, and a department
   person's line to one of their departments. */
export const PEOPLE_LINE = 'people';
export const routeKey = (personId: string, deptId: string) => `${personKey(personId)}:${deptKey(deptId)}`;
/* The bends a person put on lines, each line's in order from where it starts. A line runs through its bends at right angles
   wherever its blocks stand; a line not in it runs its own way. */
export type Bends = Record<string, Point[]>;
/* A line a person may bend: its name, its points as drawn, and the blocks it joins, the people's row named as its line. */
export type MapLine = { key: string; pts: Point[]; ends: [string, string] };

export type Block = { key: string; rect: Rect };
/* via: the dot where the trace turns towards its card, on the trace the map draws itself. */
type ArrangedDept = DeptSpot & { id: string; via: Point | null };
/* A whole-company person's card and the way to it from the hub. apart: the person took the card out of the row, and it has a
   line of its own from the middle of the hub. */
export type TopPerson = Rect & { id: string; path: Point[]; apart: boolean };
/* The quiet lines of the people who stay in the row: a line down from each card, the bus, the way from it to the hub, and the
   dot where that way leaves the bus. */
type Bus = { lines: Point[][]; drop: Point[]; via: Point };

export type MapArrangement = {
  hub: Rect;
  depts: ArrangedDept[];
  top: TopPerson[];
  bus: Bus | null;
  people: PeopleLayout;
  /* Every block, for the grips that move them and for what Fit shows. */
  blocks: Block[];
  /* Where the roads fork, for a dot like the one where a trace turns. */
  forks: Point[];
  /* The lines a person may bend, the traces of departments last. */
  lines: MapLine[];
};

const pointAt = ([x, y]: Point): Rect => ({ x, y, w: 0, h: 0 });
const samePlace = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y;
const samePts = (a: Point[], b: Point[]) => a.length === b.length && a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1]);
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
/* A line that may be bent: its name, where it starts and ends, the blocks it joins, whether it runs as the map lays it out,
   and whether it leaves the hub along its middle line. */
type Bendable = { key: string; from: Rect; to: Rect; ends: string[]; home: boolean; across?: boolean };

/* Where every block of the map stands for this person, and the lines between them. Nothing moved, it is the map as the map
   places it. A moved block keeps its lines at right angles: a line whose ends stand as placed keeps its way unless a moved
   block now stands across it; any other is routed again, around the blocks in its way. A person docked beside a department
   goes with it. A line the person bent runs through its bends, and the others join it where they run beside it. */
export function arrangeMap(org: Org, placed: Placed = {}, bends: Bends = {}): MapArrangement {
  const n = org.departments.length, h = cardHeight(org);
  const spots = deptLayout(n, h);
  const hubHome = { x: CX - HUB, y: CY - HUB, w: 2 * HUB, h: 2 * HUB };
  const hub = placedAt(placed, HUB_KEY, hubHome);
  const hubMoved = !samePlace(hub, hubHome);
  const middle: Point = [hub.x + HUB, hub.y + HUB];

  const depts: Placing[] = org.departments.map((d, i) => {
    const home = { x: spots[i]!.x, y: spots[i]!.y, w: DEPT_W, h };
    return { key: deptKey(d.id), home, rect: placedAt(placed, deptKey(d.id), home) };
  });
  const deptById = new Map(org.departments.map((d, i) => [d.id, depts[i]!]));

  const topPeople = wholeCompanyPeople(org);
  const top = chipsTop(n, h), bus = busY(n, h), centers = chipCenters(topPeople.length);
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
  /* A line through its bends, from the way it runs without them; null for a line the person did not bend. */
  const bent = (line: Bendable | null, pts: Point[]): Point[] | null => {
    const at = line ? bends[line.key] : undefined;
    return line && at?.length ? orthoThrough(line.from, at, line.to, others(...line.ends), { pts, home: line.home, across: line.across }) : null;
  };

  const deptWays: Way[] = org.departments.map((_, i) => {
    const spot = spots[i]!, { key, rect, home } = depts[i]!;
    const kept = !hubMoved && samePlace(rect, home) && !crossesAny(spot.path, movedOthers(HUB_KEY, key));
    return { pts: kept ? spot.path : orthoRoute(pointAt(middle), rect, others(HUB_KEY, key)), fixed: kept, ends: [null, rect] };
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
    const own = hubMoved || crossesAny(straight, movedOthers(HUB_KEY)) ? orthoRoute(pointAt(join), pointAt(middle), others(HUB_KEY)) : straight;
    const drop = bent({ key: PEOPLE_LINE, from: pointAt(join), to: pointAt(middle), ends: [HUB_KEY], home: own === straight }, own) ?? own;
    const lo = Math.min(...xs, join[0]), hi = Math.max(...xs, join[0]);
    const across = tidy([...(xs.includes(lo) ? [under(lo)] : []), [lo, bus], [hi, bus], ...(xs.includes(hi) && hi !== lo ? [under(hi)] : [])]);
    arrangedBus = { lines: [across, ...xs.filter(x => x !== lo && x !== hi).map((x): Point[] => [under(x), [x, bus]])], drop, via: join };
    fromHub = [...drop].reverse();
  }
  const topWays = tops.map(t => {
    const apart = !samePlace(t.rect, t.home), x = t.rect.x + CHIP_W / 2;
    const way: Way = apart ? { pts: orthoRoute(pointAt(middle), t.rect, others(HUB_KEY, t.key)), ends: [null, t.rect] } : { pts: tidy([...fromHub, [x, bus], under(x)]), fixed: true };
    return { t, apart, way };
  });
  const { people: shown, home: routesHome } = Object.keys(placed).length ? movedPeople(base, chips, chipById, deptById, others, movedOthers) : { people: base, home: base.routes.map(() => true) };

  /* Lines that run side by side join into roads: the traces from the hub and the people's row keep their place where the map
     places them, and the lines of people and of what was moved come onto them or onto each other. */
  const busWays: Way[] = arrangedBus ? [...arrangedBus.lines, arrangedBus.drop].map(pts => ({ pts, fixed: true })) : [];
  const routeWays: Way[] = shown.routes.map(r => ({ pts: r.pts, ends: [deptById.get(r.deptId)!.rect, chipById.get(r.personId)!.rect] }));
  const blocks = all.map(b => b.rect);
  const ways = [...deptWays, ...topWays.map(w => w.way), ...busWays, ...routeWays];
  const bendable: (Bendable | null)[] = [
    ...depts.map((d, i) => ({ key: d.key, from: pointAt(middle), to: d.rect, ends: [HUB_KEY, d.key], home: !!deptWays[i]!.fixed, across: true })),
    ...topWays.map(({ t, apart }) => (apart ? { key: t.key, from: pointAt(middle), to: t.rect, ends: [HUB_KEY, t.key], home: false } : null)),
    ...busWays.map(() => null),
    ...shown.routes.map((r, i) => {
      const dept = deptById.get(r.deptId)!, chip = chipById.get(r.personId)!;
      return { key: routeKey(r.personId, r.deptId), from: dept.rect, to: chip.rect, ends: [chip.key, dept.key], home: routesHome[i]! };
    }),
  ];
  let roads = joinRoads(ways, blocks);
  /* The bent lines keep their place, and the others join the roads again around them. A line that runs as it was drawn
     through all its bends leaves the roads as they are. */
  const through = bendable.map((line, i) => bent(line, roads[i]!));
  if (through.some((pts, i) => pts && !samePts(pts, roads[i]!))) {
    roads = joinRoads(ways.map((w, i) => (through[i] ? { pts: samePts(through[i], roads[i]!) ? roads[i]! : through[i], fixed: true } : w)), blocks);
  }
  const deptRoads = roads.splice(0, deptWays.length), topRoads = roads.splice(0, topWays.length), routeRoads = roads.slice(busWays.length);

  const arrangedDepts: ArrangedDept[] = org.departments.map((d, i) => {
    const path = deptRoads[i]!;
    return { id: d.id, ...depts[i]!.rect, path, via: deptWays[i]!.fixed && samePts(path, spots[i]!.path) && path.length > 2 ? path[2]! : null };
  });
  const arrangedTop: TopPerson[] = topWays.map(({ t, apart }, i) => ({ id: t.id, ...t.rect, path: topRoads[i]!, apart }));
  const joined = routeRoads.some((pts, i) => pts !== routeWays[i]!.pts);
  const routes = joined ? shown.routes.map((r, i) => ({ ...r, pts: routeRoads[i]! })) : shown.routes;
  const people = joined ? { chips: shown.chips, routes, ...wirePeople(routes, shown.chips) } : shown;
  const drawn = [...deptRoads, ...topWays.flatMap((w, i) => (w.apart ? [topRoads[i]!] : [])), ...busWays.map(w => w.pts), ...routes.map(r => r.pts)];
  return {
    hub,
    depts: arrangedDepts,
    top: arrangedTop,
    bus: arrangedBus,
    people,
    blocks: all.map(({ key, rect }) => ({ key, rect })),
    forks: roadForks(drawn, blocks),
    lines: [
      ...routes.map((r): MapLine => ({ key: routeKey(r.personId, r.deptId), pts: r.pts, ends: [deptKey(r.deptId), personKey(r.personId)] })),
      ...(arrangedBus ? [{ key: PEOPLE_LINE, pts: arrangedBus.drop, ends: [HUB_KEY, PEOPLE_LINE] } satisfies MapLine] : []),
      ...arrangedTop.filter(t => t.apart).map((t): MapLine => ({ key: personKey(t.id), pts: t.path, ends: [HUB_KEY, personKey(t.id)] })),
      ...arrangedDepts.map((d): MapLine => ({ key: deptKey(d.id), pts: d.path, ends: [HUB_KEY, deptKey(d.id)] })),
    ],
  };
}

/* The bends of a line with one more where a click on it landed: on the nearest point of the line as drawn, on its corner when
   the click is within snap of one, in its place among the others along the line. */
export function bendAt(pts: Point[], bends: Point[], click: Point, snap: number): Point[] {
  const far = (p: Point) => Math.hypot(p[0] - click[0], p[1] - click[1]);
  let at: Point = pts[0]!;
  pts.slice(1).forEach((b, i) => {
    const a = pts[i]!, k = a[1] === b[1] ? 0 : 1;
    const lo = Math.min(a[k], b[k]), hi = Math.max(a[k], b[k]);
    const near: Point = k ? [a[0], Math.min(hi, Math.max(lo, Math.round(click[1])))] : [Math.min(hi, Math.max(lo, Math.round(click[0]))), a[1]];
    if (far(near) < far(at)) at = near;
  });
  const corner = pts.slice(1, -1).filter(p => far(p) <= snap).sort((p, q) => far(p) - far(q))[0];
  const point = corner ?? at;
  const where = along(pts, point);
  const after = bends.findIndex(b => along(pts, b) > where);
  return after < 0 ? [...bends, point] : [...bends.slice(0, after), point, ...bends.slice(after)];
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
): { people: PeopleLayout; home: boolean[] } {
  const home: boolean[] = [];
  const routes: PersonRoute[] = base.routes.map(r => {
    const chip = chipById.get(r.personId)!, dept = deptById.get(r.deptId)!;
    const dx = chip.rect.x - chip.home.x, dy = chip.rect.y - chip.home.y;
    const pts = shifted(r.pts, dx, dy);
    const kept = dx === dept.rect.x - dept.home.x && dy === dept.rect.y - dept.home.y && !crossesAny(pts, movedOthers(chip.key, dept.key));
    home.push(kept);
    if (kept) return { ...r, pts };
    return { ...r, pts: orthoRoute(dept.rect, chip.rect, others(chip.key, dept.key)) };
  });
  const placedChips = chips.map(c => c.rect);
  return { people: { chips: placedChips, routes, ...wirePeople(routes, placedChips) }, home };
}

/* The part of the world that has something on it, so Fit fills the screen with it: the hub with its glow, the hint under it
   on an empty map, every block and every line. */
export function arrangedBounds(arr: MapArrangement, org: Org): { x0: number; y0: number; x1: number; y1: number } {
  const mx = arr.hub.x + HUB;
  const below = arr.hub.y + 2 * HUB + GAP + (org.departments.length ? 0 : START_H);
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
