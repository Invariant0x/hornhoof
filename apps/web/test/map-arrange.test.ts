import { describe, expect, it } from 'vitest';
import { arrangedBounds, arrangeMap, bendAt, deptKey, deptLayout, HUB_KEY, PEOPLE_LINE, personKey, routeKey, type MapArrangement } from '../src/map-arrange';
import { peopleLayout } from '../src/map-people';
import { ROAD } from '../src/map-roads';
import { departmentPeople } from '../src/org';
import { pulsePath } from '../src/screens/Map';
import type { Department, Org } from '../src/types';
import type { Rect } from '../src/ui/ortho';
import type { Point } from '../src/ui/wires';
import { ORG, PEOPLE } from './api-mock';

const dept = (d: Partial<Department> & { id: string }): Department => ({ name: null, templateKey: null, roleCode: 'SAL', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [], ...d });
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const [D1, D2, D3, D4] = [ID(1), ID(2), ID(3), ID(4)];
const DAN = ID(5), OLEG = ID(6);
/* Four departments at the corners around the hub; Dan beside Sales, Oleg under them for Sales and Support across the hub, and
   Ivan and Maria with the whole company on top. */
const dan = { ...PEOPLE[2]!, id: DAN, name: 'Dan', title: '', status: 'active' as const };
const oleg = { ...PEOPLE[2]!, id: OLEG, name: 'Oleg', title: '', status: 'active' as const, deputy: true, departments: [D1, D4], access: { whole: false, departments: [{ id: D1, name: 'Sales' }, { id: D4, name: 'Support' }], teams: [] } };
const ORG4: Org = { ...ORG, people: [...ORG.people, oleg], departments: [dept({ id: D1, name: 'Sales', people: [dan] }), dept({ id: D2, name: 'Design' }), dept({ id: D3, name: 'Finance' }), dept({ id: D4, name: 'Support' })] };

const right = (r: Rect) => r.x + r.w, bottom = (r: Rect) => r.y + r.h;
const onEdge = ([x, y]: Point, r: Rect) =>
  ((x === r.x || x === right(r)) && y >= r.y && y <= bottom(r)) || ((y === r.y || y === bottom(r)) && x >= r.x && x <= right(r));
const square = (pts: Point[]) => pts.slice(1).every((p, i) => p[0] === pts[i]![0] || p[1] === pts[i]![1]);
const through = (a: Point, b: Point, r: Rect) =>
  Math.max(a[0], b[0]) > r.x && Math.min(a[0], b[0]) < right(r) && Math.max(a[1], b[1]) > r.y && Math.min(a[1], b[1]) < bottom(r);
const segments = (pts: Point[]) => pts.slice(1).map((b, i): [Point, Point] => [pts[i]!, b]);
const blockOf = (arr: MapArrangement, key: string) => arr.blocks.find(b => b.key === key)!.rect;
/* Whether a line runs through any block but those it joins. */
const crossesOthers = (arr: MapArrangement, pts: Point[], ends: string[]) =>
  arr.blocks.filter(b => !ends.includes(b.key)).some(b => segments(pts).some(([p, q]) => through(p, q, b.rect)));
/* Every line on the map: the traces of departments, the people's row and their own lines, and the department people's wires. */
const lines = (arr: MapArrangement) => [...arr.depts.map(d => d.path), ...arr.top.map(t => t.path), ...(arr.bus ? [...arr.bus.lines, arr.bus.drop] : []), ...arr.people.wires.map(w => w.pts), ...arr.people.routes.map(r => r.pts)];

/* Six departments, three people with the whole company, Dan beside Sales and four people who look after several
   departments each from the strip under them. */
const SIX = ['Sales', 'Development', 'Design', 'Finance', 'Support', 'Marketing'].map((name, i) => ({ id: `00000000-0000-4000-8000-0000000001${i}0`, name }));
const deputy = (id: string, name: string, of: number[]) => ({
  ...PEOPLE[2]!, id, name, title: '', status: 'active' as const, deputy: true, departments: of.map(i => SIX[i]!.id),
  access: { whole: false, departments: of.map(i => SIX[i]!), teams: [] },
});
const SIX_ORG: Org = {
  ...ORG,
  people: [...ORG.people, { ...PEOPLE[1]!, id: 'p9', name: 'Alex' }, deputy(ID(6), 'Oleg', [0, 4]), deputy('n1', 'Nina', [1, 2, 5]), deputy('n2', 'Petr', [1, 3]), deputy('n3', 'Lena', [0, 1])],
  departments: SIX.map((d, i) => dept({ ...d, people: i ? [] : [dan] })),
};
const SIX_MOVES = { [deptKey(SIX[1]!.id)]: { x: 860, y: 980 }, [personKey('n1')]: { x: 1200, y: 600 } };

/* Each line the map draws, with the blocks it joins when it joins two. */
const ways = (arr: MapArrangement): { pts: Point[]; ends?: string[] }[] => [
  ...arr.depts.map(d => ({ pts: d.path, ends: [HUB_KEY, deptKey(d.id)] })),
  ...arr.top.filter(t => t.apart).map(t => ({ pts: t.path, ends: [HUB_KEY, personKey(t.id)] })),
  ...(arr.bus ? [...arr.bus.lines, arr.bus.drop].map(pts => ({ pts })) : []),
  ...arr.people.routes.map(r => ({ pts: r.pts, ends: [deptKey(r.deptId), personKey(r.personId)] })),
];
/* Runs of different lines side by side closer than near, for at least as long, with no block standing between them: they
   should have joined into one. */
function sideBySide(all: { pts: Point[] }[], blocks: Rect[], near = ROAD): string[] {
  const runs = all.flatMap(({ pts }, line) => segments(pts).map(([p, q]) => {
    const across = p[1] === q[1], at = across ? p[1] : p[0], [a, b] = across ? [p[0], q[0]] : [p[1], q[1]];
    return { line, across, at, lo: Math.min(a, b), hi: Math.max(a, b) };
  }));
  const between = (r: (typeof runs)[number], o: (typeof runs)[number]) => blocks.some(b => {
    const [atLo, atHi, alLo, alHi] = r.across ? [b.y, bottom(b), b.x, right(b)] : [b.x, right(b), b.y, bottom(b)];
    return atLo >= Math.min(r.at, o.at) && atHi <= Math.max(r.at, o.at) && alLo < Math.min(r.hi, o.hi) && alHi > Math.max(r.lo, o.lo);
  });
  return runs.flatMap((r, i) => runs.slice(i + 1).filter(o => o.line !== r.line && o.across === r.across && o.at !== r.at && Math.abs(o.at - r.at) < near && Math.min(o.hi, r.hi) - Math.max(o.lo, r.lo) >= near && !between(r, o))
    .map(o => `${r.across ? 'across' : 'down'} ${r.at} [${r.lo}, ${r.hi}] and ${o.at} [${o.lo}, ${o.hi}]`));
}

describe('the map as nobody moved it', () => {
  it('stands where the map places everything, with the department people as they are laid out today', () => {
    const arr = arrangeMap(ORG4);
    const spots = deptLayout(4);
    expect(arr.depts.map(d => [d.x, d.y, d.path])).toEqual(spots.map(s => [s.x, s.y, s.path]));
    expect(arr.people).toEqual(peopleLayout(ORG4.departments.map((d, i) => ({ id: d.id, ...spots[i]! })), departmentPeople(ORG4)));
    expect(arr.hub).toEqual({ x: 480, y: 300, w: 240, h: 240 });
    /* The first person's way runs from the top of the hub up to the bus and across to the card, as before. */
    expect(arr.top[0]!.path.slice(0, 2)).toEqual([[600, 300], [600, arr.bus!.via[1]]]);
  });
});

describe('the map while departments work in the turn', () => {
  const turn = (done: number, total: number) => ({ turnNumber: 3, done, total });
  /* Sales works in the turn; Operations, in the next corner, works all the time. */
  const working = (progress: Department['turnProgress']): Org => ({
    ...ORG4,
    turn: { id: 'u3', number: 3, goal: 'Ship payments' },
    departments: ORG4.departments.map((d, i) => ({ ...d, turnProgress: i === 0 ? progress : null })),
  });

  it('gives every card room for its turn strip while any department works in the turn, and keeps the people clear above', () => {
    const arr = arrangeMap(working(turn(3, 17)));
    expect(arr.depts.map(d => [d.w, d.h])).toEqual(Array(4).fill([280, 196]));
    expect(arr.depts.map(d => d.y + d.h / 2 - 420)).toEqual([-220, -220, 220, 220]);
    for (const d of arr.depts) expect(arr.blocks.find(b => b.key === deptKey(d.id))!.rect).toEqual({ x: d.x, y: d.y, w: 280, h: 196 });
    /* Each trace still ends in the middle of its card's near side. */
    for (const d of arr.depts) expect(d.path[d.path.length - 1]).toEqual([d.x < 600 ? d.x + d.w : d.x, d.y + d.h / 2]);
    const topRow = Math.min(...arr.depts.map(d => d.y));
    for (const p of arr.top) expect(topRow - (p.y + p.h)).toBe(28);
    for (const pts of lines(arr)) expect(square(pts)).toBe(true);
  });

  it('keeps the cards as they were while no department has tasks in the turn', () => {
    for (const progress of [null, turn(0, 0)]) {
      const arr = arrangeMap(working(progress));
      expect(arr.depts.map(d => d.h)).toEqual(Array(4).fill(160));
      expect(arr.depts.map(d => [d.x, d.y, d.path])).toEqual(arrangeMap(ORG4).depts.map(d => [d.x, d.y, d.path]));
    }
  });

  it('keeps a moved card where it was put when it grows for the turn, its line still at right angles', () => {
    const arr = arrangeMap(working(turn(1, 2)), { [deptKey(D1)]: { x: 100, y: 700 } });
    const sales = blockOf(arr, deptKey(D1));
    expect(sales).toEqual({ x: 100, y: 700, w: 280, h: 196 });
    const trace = arr.depts.find(d => d.id === D1)!.path;
    expect(square(trace)).toBe(true);
    expect(onEdge(trace[trace.length - 1]!, sales)).toBe(true);
    expect(crossesOthers(arr, trace, [HUB_KEY, deptKey(D1)])).toBe(false);
  });

  it('leaves nothing under the hub for the turn: Fit shows the hub, its glow and the blocks', () => {
    const empty: Org = { ...ORG, turn: { id: 'u3', number: 3, goal: 'Ship payments' } };
    const arr = arrangeMap(empty);
    expect('turn' in arr).toBe(false);
    expect(arrangedBounds(arr, empty).y1).toBe(540 + 28 + 120);
    const alone = working(turn(3, 17));
    const four: Org = { ...alone, people: ORG.people, departments: alone.departments.map(d => ({ ...d, people: [] })) };
    expect(arrangedBounds(arrangeMap(four), four).y1).toBe(420 + 220 + 98);
  });
});

describe('a block moved on the map', () => {
  it('takes a department to where it was put, with its docked people, and runs its lines there at right angles', () => {
    const before = arrangeMap(ORG4);
    const arr = arrangeMap(ORG4, { [deptKey(D1)]: { x: 100, y: 700 } });
    const sales = blockOf(arr, deptKey(D1));
    expect(sales).toEqual({ x: 100, y: 700, w: 280, h: 160 });
    const trace = arr.depts.find(d => d.id === D1)!.path;
    expect(trace[0]).toEqual([600, 420]);
    expect(square(trace)).toBe(true);
    expect(onEdge(trace[trace.length - 1]!, sales)).toBe(true);
    expect(crossesOthers(arr, trace, [HUB_KEY, deptKey(D1)])).toBe(false);
    /* Dan stays beside Sales. */
    const danBefore = before.people.chips.find(c => c.id === DAN)!, danNow = blockOf(arr, personKey(DAN));
    expect([danNow.x - danBefore.x, danNow.y - danBefore.y]).toEqual([100 - 110, 700 - 120]);
    /* Oleg's line to Sales starts on Sales and ends on his card, around everything else. */
    const route = arr.people.routes.find(r => r.personId === OLEG && r.deptId === D1)!.pts;
    expect(square(route)).toBe(true);
    expect(onEdge(route[0]!, sales)).toBe(true);
    expect(onEdge(route[route.length - 1]!, blockOf(arr, personKey(OLEG)))).toBe(true);
    expect(crossesOthers(arr, route, [deptKey(D1), personKey(OLEG)])).toBe(false);
  });

  it('puts a person where they were put and joins them to each of their departments at right angles', () => {
    const arr = arrangeMap(ORG4, { [personKey(OLEG)]: { x: 520, y: 720 } });
    const card = blockOf(arr, personKey(OLEG));
    expect(card).toMatchObject({ x: 520, y: 720 });
    for (const id of [D1, D4]) {
      const route = arr.people.routes.find(r => r.personId === OLEG && r.deptId === id)!.pts;
      expect(square(route)).toBe(true);
      expect(onEdge(route[0]!, blockOf(arr, deptKey(id)))).toBe(true);
      expect(onEdge(route[route.length - 1]!, card)).toBe(true);
      expect(crossesOthers(arr, route, [deptKey(id), personKey(OLEG)])).toBe(false);
    }
    expect(arr.people.wires.filter(w => w.personId === OLEG).length).toBeGreaterThan(0);
  });

  it('moves the hub, and every trace starts at its middle and the people\'s row comes down to it', () => {
    const arr = arrangeMap(ORG4, { [HUB_KEY]: { x: 520, y: 560 } });
    expect(arr.hub).toEqual({ x: 520, y: 560, w: 240, h: 240 });
    for (const d of arr.depts) {
      expect(d.path[0]).toEqual([640, 680]);
      expect(square(d.path)).toBe(true);
      expect(onEdge(d.path[d.path.length - 1]!, d)).toBe(true);
    }
    expect(arr.bus!.drop[arr.bus!.drop.length - 1]).toEqual([640, 680]);
    for (const t of arr.top) expect(t.path[0]).toEqual([640, 680]);
  });

  it('takes a whole-company person out of the row, with a line of their own to the hub', () => {
    const arr = arrangeMap(ORG4, { [personKey('p2')]: { x: 940, y: 20 } });
    const maria = arr.top.find(t => t.id === 'p2')!;
    expect(maria).toMatchObject({ x: 940, y: 20 });
    expect(maria.path[0]).toEqual([600, 420]);
    expect(square(maria.path)).toBe(true);
    expect(onEdge(maria.path[maria.path.length - 1]!, maria)).toBe(true);
    expect(crossesOthers(arr, maria.path, [HUB_KEY, personKey('p2')])).toBe(false);
    /* Ivan keeps the row and its bus, which no longer goes to Maria. */
    expect(arr.bus!.lines.flat().some(([x]) => x === 940 + 80)).toBe(false);
  });

  it('routes a line around a block put across it', () => {
    const before = arrangeMap(ORG4).depts.find(d => d.id === D1)!.path;
    const maria = { x: 400, y: 180 };
    const wall = { ...maria, w: 160, h: 56 };
    expect(segments(before).some(([p, q]) => through(p, q, wall))).toBe(true);
    const arr = arrangeMap(ORG4, { [personKey('p2')]: maria });
    const trace = arr.depts.find(d => d.id === D1)!.path;
    expect(square(trace)).toBe(true);
    expect(segments(trace).some(([p, q]) => through(p, q, wall)), JSON.stringify(trace)).toBe(false);
    expect(onEdge(trace[trace.length - 1]!, blockOf(arr, deptKey(D1)))).toBe(true);
  });

  it('draws every line across and down, wherever anything was put', () => {
    let s = 7;
    const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const keys = [HUB_KEY, ...[D1, D2, D3, D4].map(deptKey), ...['p1', 'p2', DAN, OLEG].map(personKey)];
    for (let run = 0; run < 40; run++) {
      const placed = Object.fromEntries(keys.filter(() => next() < 0.4).map(k => [k, { x: Math.round(next() * 1600) - 300, y: Math.round(next() * 1200) - 200 }]));
      const arr = arrangeMap(ORG4, placed);
      for (const pts of lines(arr)) expect(square(pts), `${JSON.stringify(placed)}: ${JSON.stringify(pts)}`).toBe(true);
    }
  });

  it('joins the lines of people who look after several departments into roads, as laid out and wherever blocks are put', () => {
    /* As laid out, with two blocks moved, with the hub and Oleg moved, and with Development put down below and on the right. */
    const dragged = [{ x: 560, y: 1010 }, { x: 900, y: 800 }].map(at => ({ [deptKey(SIX[1]!.id)]: at }));
    for (const placed of [{}, SIX_MOVES, { [HUB_KEY]: { x: 420, y: 330 }, [personKey(OLEG)]: { x: 40, y: 1000 } }, ...dragged]) {
      const arr = arrangeMap(SIX_ORG, placed);
      const all = ways(arr);
      expect(sideBySide(all, arr.blocks.map(b => b.rect)), JSON.stringify(placed)).toEqual([]);
      for (const { pts, ends } of all) {
        expect(square(pts)).toBe(true);
        if (ends) expect(crossesOthers(arr, pts, ends), JSON.stringify(pts)).toBe(false);
      }
      for (const r of arr.people.routes) {
        expect(onEdge(r.pts[0]!, blockOf(arr, deptKey(r.deptId)))).toBe(true);
        expect(onEdge(r.pts[r.pts.length - 1]!, blockOf(arr, personKey(r.personId)))).toBe(true);
      }
    }
  });

  it('joins the lines that ran 28 and 46 apart on the six-department map, and none of them runs through a card', () => {
    const arr = arrangeMap(SIX_ORG, SIX_MOVES);
    const all = ways(arr);
    expect(sideBySide(all, arr.blocks.map(b => b.rect), 47)).toEqual([]);
    for (const { pts, ends } of all) if (ends) expect(crossesOthers(arr, pts, ends), JSON.stringify(pts)).toBe(false);
  });

  it('marks where a road forks with a dot, outside the blocks', () => {
    const arr = arrangeMap(SIX_ORG);
    expect(arr.forks.length).toBeGreaterThan(0);
    for (const [x, y] of arr.forks) expect(arr.blocks.some(({ rect: r }) => x > r.x && x < right(r) && y > r.y && y < bottom(r))).toBe(false);
  });

  it('sends a message along the lines as they are drawn', () => {
    const arr = arrangeMap(ORG4, { [deptKey(D1)]: { x: 100, y: 700 }, [personKey(OLEG)]: { x: 520, y: 720 } });
    const trace = arr.depts.find(d => d.id === D1)!.path;
    expect(pulsePath({ kind: 'department', id: D1 }, { kind: 'orchestrator' }, ORG4, arr)).toEqual([...trace].reverse());
    const route = arr.people.routes.find(r => r.personId === OLEG && r.deptId === D1)!.pts;
    expect(pulsePath({ kind: 'department', id: D1 }, { kind: 'person', id: OLEG }, ORG4, arr)).toEqual(route);
  });
});

/* Whether a line passes through p. */
const passes = (pts: Point[], p: Point) => segments(pts).some(([a, b]) =>
  (a[0] === b[0] && p[0] === a[0] && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) ||
  (a[1] === b[1] && p[1] === a[1] && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])));
const salesTrace = (arr: MapArrangement) => arr.depts.find(d => d.id === D1)!.path;

describe('a line a person bent', () => {
  it('keeps the way a line is drawn where its bends stand on it, and its dots', () => {
    const before = arrangeMap(ORG4);
    expect(salesTrace(before)).toEqual([[600, 420], [516, 420], [516, 200], [390, 200]]);
    const oleg = before.people.routes.find(r => r.personId === OLEG && r.deptId === D1)!.pts;
    const bends = {
      [deptKey(D1)]: [[516, 300], [450, 200]] as Point[],
      [routeKey(OLEG, D1)]: [oleg[1]!, oleg[2]!],
      [routeKey(DAN, D1)]: [[90, 200]] as Point[],
      [PEOPLE_LINE]: [[600, 200]] as Point[],
    };
    const arr = arrangeMap(ORG4, {}, bends);
    expect(arr.depts).toEqual(before.depts);
    expect(arr.people).toEqual(before.people);
    expect([arr.top, arr.bus, arr.forks]).toEqual([before.top, before.bus, before.forks]);
  });

  it('names every line a person may bend, with what it joins and its points as drawn', () => {
    const arr = arrangeMap(ORG4, { [personKey('p2')]: { x: 940, y: 20 } });
    const keys = arr.lines.map(l => l.key);
    expect(keys).toEqual(expect.arrayContaining([deptKey(D1), deptKey(D4), personKey('p2'), PEOPLE_LINE, routeKey(DAN, D1), routeKey(OLEG, D4)]));
    expect(keys).not.toContain(personKey('p1'));
    expect(arr.lines.find(l => l.key === deptKey(D1))).toEqual({ key: deptKey(D1), pts: salesTrace(arr), ends: [HUB_KEY, deptKey(D1)] });
    expect(arr.lines.find(l => l.key === PEOPLE_LINE)).toEqual({ key: PEOPLE_LINE, pts: arr.bus!.drop, ends: [HUB_KEY, PEOPLE_LINE] });
    expect(arr.lines.find(l => l.key === routeKey(DAN, D1))!.ends).toEqual([deptKey(D1), personKey(DAN)]);
    /* The traces of departments come last, so a click on a road they share with others bends the trace. */
    expect(keys.slice(-4)).toEqual([D1, D2, D3, D4].map(deptKey));
  });

  it('runs a line through a bend moved off its way at right angles, turning at the bend', () => {
    const arr = arrangeMap(ORG4, {}, { [deptKey(D1)]: [[480, 300]] });
    expect(salesTrace(arr)).toEqual([[600, 420], [480, 420], [480, 200], [390, 200]]);
    /* The dot where the trace turned into its card goes with the way the map drew. */
    expect(arr.depts.find(d => d.id === D1)!.via).toBeNull();
    expect(pulsePath({ kind: 'department', id: D1 }, { kind: 'orchestrator' }, ORG4, arr)).toEqual([...salesTrace(arr)].reverse());
  });

  it('keeps a bend where it stands when its block moves, the line still turning there', () => {
    const arr = arrangeMap(ORG4, { [deptKey(D1)]: { x: 50, y: 120 } }, { [deptKey(D1)]: [[516, 200]] });
    expect(salesTrace(arr)).toEqual([[600, 420], [516, 420], [516, 200], [330, 200]]);
  });

  it("runs a department person's line through its bends to wherever their card is put", () => {
    const bend: Point = [300, 860];
    const arr = arrangeMap(ORG4, { [personKey(OLEG)]: { x: 520, y: 720 } }, { [routeKey(OLEG, D1)]: [bend] });
    const route = arr.people.routes.find(r => r.personId === OLEG && r.deptId === D1)!.pts;
    expect(square(route)).toBe(true);
    expect(passes(route, bend), JSON.stringify(route)).toBe(true);
    expect(onEdge(route[0]!, blockOf(arr, deptKey(D1)))).toBe(true);
    expect(onEdge(route[route.length - 1]!, blockOf(arr, personKey(OLEG)))).toBe(true);
    expect(pulsePath({ kind: 'department', id: D1 }, { kind: 'person', id: OLEG }, ORG4, arr)).toEqual(route);
  });

  it("brings the people's row down to the hub through its bends, and the CEO's way with it", () => {
    const arr = arrangeMap(ORG4, {}, { [PEOPLE_LINE]: [[520, 200]] });
    expect(passes(arr.bus!.drop, [520, 200])).toBe(true);
    expect(square(arr.bus!.drop)).toBe(true);
    expect(arr.bus!.drop[arr.bus!.drop.length - 1]).toEqual([600, 420]);
    const ceo = arr.top.find(t => t.id === 'p1')!.path;
    expect(passes(ceo, [520, 200])).toBe(true);
    expect(pulsePath({ kind: 'orchestrator' }, { kind: 'person', id: 'p1' }, ORG4, arr)).toEqual(ceo);
  });

  it('changes nothing for the bends of a line that is not on the map', () => {
    expect(arrangeMap(ORG4, {}, { [deptKey(ID(9))]: [[10, 10]], [personKey('p1')]: [[20, 20]] })).toEqual(arrangeMap(ORG4));
  });

  it('draws every bent line across and down and through its bends, wherever anything was put', () => {
    let s = 11;
    const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const keys = [HUB_KEY, ...[D1, D2, D3, D4].map(deptKey), ...['p1', 'p2', DAN, OLEG].map(personKey)];
    const at = (): Point => [Math.round(next() * 1600) - 300, Math.round(next() * 1200) - 200];
    for (let run = 0; run < 30; run++) {
      const placed = Object.fromEntries(keys.filter(() => next() < 0.3).map(k => [k, { x: at()[0], y: at()[1] }]));
      const bends = Object.fromEntries(arrangeMap(ORG4, placed).lines.filter(() => next() < 0.4).map(l => [l.key, Array.from({ length: 1 + Math.floor(next() * 3) }, at)]));
      const arr = arrangeMap(ORG4, placed, bends);
      for (const l of arr.lines) {
        const where = `${JSON.stringify({ placed, bends: bends[l.key] })}: ${JSON.stringify(l.pts)}`;
        expect(square(l.pts), where).toBe(true);
        for (const b of bends[l.key] ?? []) expect(passes(l.pts, b), where).toBe(true);
      }
      for (const pts of lines(arr)) expect(square(pts)).toBe(true);
    }
  });
});

describe('a click on a line', () => {
  const trace: Point[] = [[600, 420], [516, 420], [516, 200], [390, 200]];

  it('puts a bend on the nearest point of the line, or on its corner when the click is that near it', () => {
    expect(bendAt(trace, [], [520.4, 300.6], 4)).toEqual([[516, 301]]);
    expect(bendAt(trace, [], [519, 204], 6)).toEqual([[516, 200]]);
    expect(bendAt(trace, [], [519, 204], 3)).toEqual([[516, 204]]);
  });

  it('puts the new bend in its place among the others along the line', () => {
    expect(bendAt(trace, [[516, 301]], [450, 198], 4)).toEqual([[516, 301], [450, 200]]);
    expect(bendAt(trace, [[450, 200]], [516, 350], 4)).toEqual([[516, 350], [450, 200]]);
    expect(bendAt(trace, [[516, 380], [450, 200]], [513, 300], 4)).toEqual([[516, 380], [516, 300], [450, 200]]);
  });
});

describe('the map whose people chips grow with their words', () => {
  const person = (id: string, name: string) => ({ ...PEOPLE[2]!, id, name, title: '', status: 'active' as const });
  /* Six departments with three people beside Sales and three beside Design, the next card of its column, and Gus between
     the two, besides the people of the six-department map. */
  const CROWD: Org = {
    ...SIX_ORG,
    people: [...SIX_ORG.people, deputy('g1', 'Gus', [0, 2])],
    departments: SIX_ORG.departments.map((d, i) => ({ ...d, people: i === 0 ? [dan, person('a1', 'Ada'), person('a2', 'Ari')] : i === 2 ? ['b1', 'b2', 'b3'].map(id => person(id, id)) : [] })),
  };
  const overlapping = (arr: MapArrangement) => arr.blocks.flatMap((a, i) => arr.blocks.slice(i + 1).flatMap(b => (
    a.rect.x < right(b.rect) && b.rect.x < right(a.rect) && a.rect.y < bottom(b.rect) && b.rect.y < bottom(a.rect) ? [`${a.key} over ${b.key}`] : []
  )));

  it('keeps every block and line as it was while the words fit the old chips', () => {
    for (const org of [SIX_ORG, CROWD, ORG4]) {
      expect(arrangeMap(org, {}, {}, 0, { top: 56, dept: 48 })).toEqual(arrangeMap(org));
      expect(arrangeMap(org, {}, {}, 0, { top: 31.2, dept: 20 })).toEqual(arrangeMap(org));
    }
  });

  it('gives the whole-company row one height, the tallest chip\'s in whole pixels, 28 px above the cards and its bus under it', () => {
    const arr = arrangeMap(SIX_ORG, {}, {}, 0, { top: 90.2 });
    expect(arr.top.map(p => [p.w, p.h])).toEqual(arr.top.map(() => [160, 91]));
    const topRow = Math.min(...arr.depts.map(d => d.y));
    for (const p of arr.top) expect(topRow - (p.y + p.h)).toBe(28);
    expect(arr.bus!.via[1]).toBe(arr.top[0]!.y + 91 + 14);
    for (const p of arr.top) expect(arr.bus!.lines.flat()).toContainEqual([p.x + 80, p.y + 91]);
    expect(arr.depts.map(d => [d.x, d.y])).toEqual(arrangeMap(SIX_ORG).depts.map(d => [d.x, d.y]));
  });

  it('gives every department person\'s chip the height of the tallest one', () => {
    const arr = arrangeMap(SIX_ORG, {}, {}, 0, { dept: 70 });
    expect(arr.people.chips.map(c => [c.w, c.h])).toEqual(arr.people.chips.map(() => [156, 70]));
    expect(overlapping(arr)).toEqual([]);
  });

  it('moves the rows of cards apart for tall chips beside them, so nothing stands over anything and every line runs across and down', () => {
    for (const dept of [70, 120]) {
      const arr = arrangeMap(CROWD, {}, {}, 0, { top: 100, dept });
      expect(overlapping(arr), `${dept} px`).toEqual([]);
      for (const pts of lines(arr)) expect(square(pts)).toBe(true);
      for (const r of arr.people.routes) expect(crossesOthers(arr, r.pts, [deptKey(r.deptId), personKey(r.personId)]), `${r.personId} to ${r.deptId}`).toBe(false);
    }
    const old = arrangeMap(CROWD), tall = arrangeMap(CROWD, {}, {}, 0, { dept: 120 });
    expect(tall.depts[2]!.y - tall.depts[0]!.y).toBeGreaterThan(old.depts[2]!.y - old.depts[0]!.y);
  });

  it('makes every card as tall as the chips docked beside one, each docked chip\'s line straight into the side of its card', () => {
    for (const [dept, h] of [[48, 160], [50, 166], [70, 226], [120, 376]] as const) {
      const arr = arrangeMap(CROWD, {}, {}, 0, { dept });
      expect(arr.depts.map(d => d.h), `${dept} px`).toEqual(arr.depts.map(() => h));
      for (const id of [DAN, 'a1', 'a2', 'b1', 'b2', 'b3']) {
        const [route, ...more] = arr.people.routes.filter(r => r.personId === id);
        expect(more).toEqual([]);
        expect(route!.pts).toHaveLength(2);
        expect(onEdge(route!.pts[0]!, blockOf(arr, deptKey(route!.deptId)))).toBe(true);
        expect(onEdge(route!.pts[1]!, blockOf(arr, personKey(id)))).toBe(true);
      }
    }
  });
});
