import type { Point } from './ui/wires';
import { bridgeWires, type WireGap } from './map-people-bridges';

/* A chip is PW wide and at least PH tall: every chip of the department people is as tall as the one whose words need the most,
   as the map measures them, and the layout stacks and spaces them by that height. */
export const PW = 156, PH = 48;
const CX = 600, TURN_FLOOR = 606;
/* GUTTER_ROOM: what a chip between two cards of a column leaves free above and below it together, as at 48 px. */
const PGAP = 8, DOCK = 40, RAIL = 14, PORT_IN = 14, PORT = 48, RING = 18, GUTTER_ROOM = 12;
const BELOW = 30, STRIP = 22, SGAP = 12, STEP = 14, LOWER_GAP = 18, LANE_STEP = 12, MAX_DOCK = 3;

export type Spot = { id: string; x: number; y: number; w: number; h: number };
/* What the department people need beside the rows of cards: the tallest stack of chips docked beside one card, and the
   least gap between two cards of a column for a chip standing in it, 0 for none. */
export type DockRoom = { stack: number; gutter: number };
export type DeptPersonInput = { id: string; departments: string[] };
export type PersonChip = { id: string; x: number; y: number; w: number; h: number };
export type PersonWire = { id: string; personId: string; deptId: string; pts: Point[] };
export type PersonRoute = { personId: string; deptId: string; pts: Point[] };
export type PeopleLayout = {
  chips: PersonChip[];
  wires: PersonWire[];
  vias: Point[];
  routes: PersonRoute[];
  gaps: WireGap[];
};

type RichSpot = Spot & { side: -1 | 1; row: number; midY: number; corridor?: number };
type GutterEntry = { id: string; pair: [RichSpot, RichSpot] };
type StripEntry = { id: string; spots: RichSpot[] };
type Seg = [Point, Point];

/* Horizontal centers for a centered row of equal-width chips. */
export function rowCenters(n: number, w: number, gap: number, cx = CX): number[] {
  const left = cx - (n * w + Math.max(0, n - 1) * gap) / 2 + w / 2;
  return Array.from({ length: n }, (_, i) => left + i * (w + gap));
}

const outerChipX = (s: RichSpot) => (s.side < 0 ? s.x - DOCK - PW : s.x + s.w + DOCK);
const chipInnerEdge = (s: RichSpot, x: number) => (s.side < 0 ? x + PW : x);
const cardOuterEdge = (s: RichSpot) => (s.side < 0 ? s.x : s.x + s.w);
const gapKey = (s: RichSpot) => `${s.side}:${s.row}`;

function enrichSpots(spots: Spot[]): Map<string, RichSpot> {
  const ys = [...new Set(spots.map(s => s.y))].sort((a, b) => a - b);
  return new Map(
    spots.map(s => [
      s.id,
      { ...s, side: s.x + s.w / 2 < CX ? -1 : 1, row: ys.indexOf(s.y), midY: s.y + s.h / 2 },
    ]),
  );
}

function resolveSpots(ids: string[], byId: Map<string, RichSpot>): RichSpot[] {
  return [...new Set(ids)].flatMap(id => {
    const spot = byId.get(id);
    return spot ? [spot] : [];
  }).sort((a, b) => a.row - b.row || a.side - b.side);
}

function isAdjacentSameCol(ss: RichSpot[]): ss is [RichSpot, RichSpot] {
  return ss.length === 2 && ss[0]!.side === ss[1]!.side && ss[1]!.row - ss[0]!.row === 1;
}

function dockOne(docked: Map<RichSpot, string[]>, strip: StripEntry[], spot: RichSpot, id: string): void {
  const list = docked.get(spot) ?? [];
  if (list.length < MAX_DOCK) {
    list.push(id);
    docked.set(spot, list);
  } else {
    strip.push({ id, spots: [spot] });
  }
}

function classifyPeople(people: DeptPersonInput[], byId: Map<string, RichSpot>) {
  const docked = new Map<RichSpot, string[]>();
  const gutter = new Map<string, GutterEntry>();
  const strip: StripEntry[] = [];

  for (const p of people) {
    const ss = resolveSpots(p.departments, byId);
    if (!ss.length) continue;
    if (ss.length === 1) dockOne(docked, strip, ss[0]!, p.id);
    else if (isAdjacentSameCol(ss) && !gutter.has(gapKey(ss[0]))) gutter.set(gapKey(ss[0]), { id: p.id, pair: ss });
    else strip.push({ id: p.id, spots: ss });
  }

  return { docked, gutter, strip };
}

const rangesTouch = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(Math.max(a0, a1), Math.max(b0, b1)) >= Math.max(Math.min(a0, a1), Math.min(b0, b1));

const orthoSegsTouch = ([a, b]: Seg, [c, d]: Seg) => rangesTouch(a[0], b[0], c[0], d[0]) && rangesTouch(a[1], b[1], c[1], d[1]);

const onOrthoSegment = (pt: Point, a: Point, b: Point) => orthoSegsTouch([pt, pt], [a, b]);

const routeSegs = (routes: PersonRoute[]): Seg[] =>
  routes.flatMap(r => r.pts.slice(1).map((b, i): Seg => [r.pts[i]!, b]));

const segListsTouch = (a: Seg[], b: Seg[]) => a.some(s1 => b.some(s2 => orthoSegsTouch(s1, s2)));

function addVia(vias: Point[], pt: Point): void {
  if (!vias.some(v => v[0] === pt[0] && v[1] === pt[1])) vias.push(pt);
}

function firstHit(pts: Point[], drawn: Seg[]): number {
  if (!drawn.length) return -1;
  return pts.findIndex((pt, k) => k > 0 && drawn.some(([a, b]) => onOrthoSegment(pt, a, b)));
}

function orderRoutes(routes: PersonRoute[], chipX: number): PersonRoute[] {
  return [...routes].sort((a, b) => {
    const spanA = Math.max(...a.pts.map(p => Math.abs(p[0] - chipX)));
    const spanB = Math.max(...b.pts.map(p => Math.abs(p[0] - chipX)));
    return spanB - spanA || a.pts[0]![1] - b.pts[0]![1];
  });
}

function liesInside([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): boolean {
  if ((px === ax && py === ay) || (px === bx && py === by)) return false;
  return onOrthoSegment([px, py], [ax, ay], [bx, by]);
}

function splitWireAt(wires: PersonWire[], pt: Point): void {
  for (const wire of wires) {
    const i = wire.pts.findIndex((b, k) => k > 0 && liesInside(pt, wire.pts[k - 1]!, b));
    if (i > 0) wire.pts.splice(i, 0, pt);
  }
}

type Directions = Map<string, { pt: Point; set: Set<string> }>;

function addDirection(directions: Directions, from: Point, to: Point): void {
  if (from[0] === to[0] && from[1] === to[1]) return;
  const key = `${from[0]}:${from[1]}`;
  const entry = directions.get(key) ?? { pt: from, set: new Set<string>() };
  entry.set.add(`${Math.sign(to[0] - from[0])},${Math.sign(to[1] - from[1])}`);
  directions.set(key, entry);
}

function forkVias(wires: PersonWire[]): Point[] {
  const directions: Directions = new Map();
  for (const [a, b] of routeSegs(wires)) {
    addDirection(directions, a, b);
    addDirection(directions, b, a);
  }
  return [...directions.values()].filter(e => e.set.size >= 3).map(e => e.pt);
}

/* Turn a person's full department-to-chip routes into non-overlapping SVG wires and via dots at every fork. */
function personTree(personId: string, routes: PersonRoute[], chipX: number): { wires: PersonWire[]; vias: Point[] } {
  const drawn: Seg[] = [];
  const wires: PersonWire[] = [];

  for (const r of orderRoutes(routes, chipX)) {
    const hit = firstHit(r.pts, drawn);
    const pts = hit < 0 ? [...r.pts] : r.pts.slice(0, hit + 1);
    if (hit >= 0) splitWireAt(wires, r.pts[hit]!);
    if (pts.length >= 2) {
      wires.push({ id: `${personId}:${r.deptId}`, personId, deptId: r.deptId, pts });
      for (let i = 1; i < pts.length; i++) drawn.push([pts[i - 1]!, pts[i]!]);
    }
  }
  return { wires, vias: forkVias(wires) };
}

function placeDocked(docked: Map<RichSpot, string[]>, out: PeopleLayout, ph: number): void {
  for (const [s, ids] of docked) {
    const x = outerChipX(s);
    const inner = chipInnerEdge(s, x);
    const edge = cardOuterEdge(s);
    ids.forEach((id, j) => {
      const cy = s.midY + (j - (ids.length - 1) / 2) * (ph + PGAP);
      out.chips.push({ id, x, y: cy - ph / 2, w: PW, h: ph });
      const route: PersonRoute = { personId: id, deptId: s.id, pts: [[edge, cy], [inner, cy]] };
      out.routes.push(route);
      out.wires.push({ id: `${id}:${s.id}`, personId: id, deptId: s.id, pts: route.pts });
    });
  }
}

function placeGutter(gutter: Map<string, GutterEntry>, out: PeopleLayout, ph: number): void {
  for (const { id, pair: [a, b] } of gutter.values()) {
    const cy = (a.y + a.h + b.y) / 2;
    const x = outerChipX(a);
    const inner = chipInnerEdge(a, x);
    const edge = cardOuterEdge(a);
    const rail = a.side < 0 ? a.x - RAIL : a.x + a.w + RAIL;
    /* Leave the strip trace room between the card's bottom and the chip in the gap. */
    a.corridor = Math.min(BELOW, (cy - ph / 2 - a.y - a.h) / 2);
    out.chips.push({ id, x, y: cy - ph / 2, w: PW, h: ph });
    const routes: PersonRoute[] = [
      { personId: id, deptId: a.id, pts: [[edge, a.y + a.h - PORT_IN], [rail, a.y + a.h - PORT_IN], [rail, cy], [inner, cy]] },
      { personId: id, deptId: b.id, pts: [[edge, b.y + PORT_IN], [rail, b.y + PORT_IN], [rail, cy], [inner, cy]] },
    ];
    addPersonTree(out, id, routes, x + PW / 2);
  }
}

function bottomPortX(s: RichSpot, step: number, lowUses: number, bounds: [number, number]): number {
  const shift = Math.max(step, lowUses) * STEP;
  const base = s.side < 0 ? s.x + s.w - PORT - shift : s.x + PORT + shift;
  if (step === 0) return base;
  return s.side < 0 ? Math.max(s.x + PORT_IN, Math.min(base, bounds[0] - RAIL - shift)) : Math.min(s.x + s.w - PORT_IN, Math.max(base, bounds[1] + RAIL + shift));
}

type StripPlacement = {
  low: number; cx: number; laneY: number; attachY: number; step: number; ph: number;
  bounds: [number, number]; cardUses: Map<string, number>;
};

function higherCardRoute(s: RichSpot, used: number, place: StripPlacement): Point[] {
  const ring = s.side < 0 ? s.x - DOCK - PW - RING - place.step * STEP : s.x + s.w + DOCK + PW + RING + place.step * STEP;
  const port = s.side < 0 ? s.x + PORT - used * 12 : s.x + s.w - PORT + used * 12;
  const corr = s.y + s.h + (s.corridor === undefined ? BELOW - used * 8 : s.corridor / (used + 1));
  return [[port, s.y + s.h], [port, corr], [ring, corr], [ring, place.laneY]];
}

function spotStripRoute(personId: string, spot: RichSpot, place: StripPlacement): PersonRoute {
  const used = place.cardUses.get(spot.id) ?? 0;
  const port = bottomPortX(spot, place.step, used, place.bounds);
  const start: Point[] = spot.y + spot.h === place.low
    ? [[port, place.low], [port, place.laneY]] : higherCardRoute(spot, used, place);
  return { personId, deptId: spot.id, pts: [...start, [place.cx, place.laneY], [place.cx, place.attachY]] };
}

function buildStripRoutes(person: StripEntry, place: StripPlacement): PersonRoute[] {
  return person.spots.map(spot => spotStripRoute(person.id, spot, place));
}

const avgSide = (p: StripEntry) => p.spots.reduce((sum, s) => sum + s.side, 0) / p.spots.length;

function stripRank(p: StripEntry, low: number, maxRow: number): [number, number, number] {
  const depths = p.spots.map(s => (s.y + s.h === low ? 0 : maxRow - s.row + 1));
  return [Math.min(...depths), Math.max(...depths), avgSide(p)];
}

function orderByPriority(strip: StripEntry[], low: number, maxRow: number): StripEntry[] {
  return [...strip].sort((a, b) => {
    const ra = stripRank(a, low, maxRow), rb = stripRank(b, low, maxRow);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
}

type PickedRoutes = { routes: PersonRoute[]; segs: Seg[]; laneY: number; lower: boolean };

function clearRoutes(person: StripEntry, place: StripPlacement, blocked: Seg[], lower: boolean): PickedRoutes | null {
  const routes = buildStripRoutes(person, place), segs = routeSegs(routes);
  return segListsTouch(segs, blocked) ? null : { routes, segs, laneY: place.laneY, lower };
}

function pickMemberRoutes(person: StripEntry, place: StripPlacement, lowerCount: number, blocked: Seg[]): PickedRoutes | null {
  const above = clearRoutes(person, place, blocked, false);
  if (above) return above;
  const below = { ...place, laneY: place.attachY + place.ph + LOWER_GAP + lowerCount * LANE_STEP,
    attachY: place.attachY + place.ph, step: place.step + lowerCount + 1 };
  return clearRoutes(person, below, blocked, true);
}

type RowAttempt = {
  orderedRow: StripEntry[]; chips: PersonChip[]; bounds: [number, number];
  routesById: Map<string, PersonRoute[]>; segs: Seg[]; cardUses: Map<string, number>;
  top: number; maxY: number; lowerCount: number;
};
type RowSettings = { lane: number; low: number; step: number; ph: number; priorSegs: Seg[]; priorCards: Map<string, number> };
type StripProgress = RowSettings & { row: StripEntry[]; best: RowAttempt | null };

function newStripRow(priority: StripEntry[], settings: RowSettings): RowAttempt {
  const orderedRow = [...priority].sort((a, b) => avgSide(a) - avgSide(b));
  const centers = rowCenters(orderedRow.length, PW, SGAP), top = settings.lane + STRIP;
  const chips = orderedRow.map((p, i) => ({ id: p.id, x: centers[i]! - PW / 2, y: top, w: PW, h: settings.ph }));
  return { orderedRow, chips, bounds: [chips[0]!.x, chips[chips.length - 1]!.x + PW],
    routesById: new Map(), segs: [], cardUses: new Map(settings.priorCards), top, maxY: top + settings.ph, lowerCount: 0 };
}

function recordRoutes(attempt: RowAttempt, person: StripEntry, picked: PickedRoutes): void {
  attempt.lowerCount += Number(picked.lower);
  attempt.maxY = Math.max(attempt.maxY, picked.laneY);
  attempt.routesById.set(person.id, picked.routes);
  attempt.segs.push(...picked.segs);
  for (const s of person.spots) attempt.cardUses.set(s.id, (attempt.cardUses.get(s.id) ?? 0) + 1);
}

function addRowPerson(person: StripEntry, attempt: RowAttempt, settings: RowSettings, allowBridges: boolean): boolean {
  const chip = attempt.chips[attempt.orderedRow.indexOf(person)]!;
  const place = { low: settings.low, cx: chip.x + PW / 2, laneY: settings.lane, attachY: attempt.top,
    step: settings.step, ph: settings.ph, bounds: attempt.bounds, cardUses: attempt.cardUses };
  const blocked = allowBridges ? [] : [...settings.priorSegs, ...attempt.segs];
  const picked = pickMemberRoutes(person, place, attempt.lowerCount, blocked);
  if (!picked) return false;
  recordRoutes(attempt, person, picked);
  return true;
}

function tryStripRow(priority: StripEntry[], settings: RowSettings, allowBridges = false): RowAttempt | null {
  const attempt = newStripRow(priority, settings);
  return priority.every(p => addRowPerson(p, attempt, settings, allowBridges)) ? attempt : null;
}

function addPersonTree(out: PeopleLayout, id: string, routes: PersonRoute[], chipX: number): void {
  const tree = personTree(id, routes, chipX);
  out.routes.push(...routes);
  out.wires.push(...tree.wires);
  tree.vias.forEach(v => addVia(out.vias, v));
}

function commitStripRow(attempt: RowAttempt, out: PeopleLayout): void {
  out.chips.push(...attempt.chips);
  attempt.orderedRow.forEach((p, i) => addPersonTree(out, p.id, attempt.routesById.get(p.id)!, attempt.chips[i]!.x + PW / 2));
}

function advanceStripRow(progress: StripProgress, out: PeopleLayout): void {
  if (!progress.best) return;
  commitStripRow(progress.best, out);
  progress.priorSegs.push(...progress.best.segs);
  progress.priorCards = progress.best.cardUses;
  progress.lane = progress.best.maxY + RAIL;
  progress.step += progress.row.length;
}

function growStrip(person: StripEntry, progress: StripProgress, out: PeopleLayout): void {
  const next = tryStripRow([...progress.row, person], progress);
  if (next) {
    progress.row.push(person);
    progress.best = next;
    return;
  }
  advanceStripRow(progress, out);
  progress.row = [person];
  /* Keep the person when the fixed card ports need a bridge to reach them. */
  progress.best = tryStripRow(progress.row, progress, true);
}

function placeStrip(strip: StripEntry[], low: number, maxRow: number, out: PeopleLayout, ph: number): void {
  if (!strip.length) return;
  const progress: StripProgress = { low, lane: Math.max(low, TURN_FLOOR) + BELOW, step: 0, ph,
    priorSegs: [], priorCards: new Map(), row: [], best: null };
  for (const person of orderByPriority(strip, low, maxRow)) growStrip(person, progress, out);
  if (progress.best) commitStripRow(progress.best, out);
}

/* The wires of people's routes: each person's routes joined into one tree with a dot at every fork, and a gap where a wire
   passes under another person's. The same for routes laid out here or moved on the map since. */
export function wirePeople(routes: PersonRoute[], chips: PersonChip[]): Pick<PeopleLayout, 'wires' | 'vias' | 'gaps'> {
  const out: PeopleLayout = { chips: [], wires: [], vias: [], routes: [], gaps: [] };
  const middle = new Map(chips.map(c => [c.id, c.x + c.w / 2]));
  for (const id of new Set(routes.map(r => r.personId))) {
    const tree = personTree(id, routes.filter(r => r.personId === id), middle.get(id) ?? 0);
    out.wires.push(...tree.wires);
    tree.vias.forEach(v => addVia(out.vias, v));
  }
  return { vias: out.vias, ...bridgeWires(out.wires) };
}

/* What the department people need beside the rows of cards, with chips ph tall. */
export function dockedRoom(spots: Spot[], people: DeptPersonInput[], ph = PH): DockRoom {
  if (!spots.length || !people.length) return { stack: 0, gutter: 0 };
  const { docked, gutter } = classifyPeople(people, enrichSpots(spots));
  const most = Math.max(0, ...[...docked.values()].map(ids => ids.length));
  return { stack: most ? most * ph + (most - 1) * PGAP : 0, gutter: gutter.size ? ph + GUTTER_ROOM : 0 };
}

/* Keep each person connected when fixed card ports need bridges, and keep their traces clear of the hub. ph: how tall every
   chip is, PH or what the words of the chip of the most words need; a card is at least as tall as the chips docked beside
   it, as dockedRoom gives it. */
export function peopleLayout(spots: Spot[], people: DeptPersonInput[], ph = PH): PeopleLayout {
  const out: PeopleLayout = { chips: [], wires: [], vias: [], routes: [], gaps: [] };
  if (!spots.length || !people.length) return out;
  const byId = enrichSpots(spots);
  const low = Math.max(...spots.map(s => s.y + s.h));
  const maxRow = Math.max(...[...byId.values()].map(s => s.row));
  const { docked, gutter, strip } = classifyPeople(people, byId);
  placeDocked(docked, out, ph);
  placeGutter(gutter, out, ph);
  placeStrip(strip, low, maxRow, out, ph);
  return { ...out, ...bridgeWires(out.wires) };
}
