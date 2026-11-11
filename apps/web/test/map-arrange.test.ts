import { describe, expect, it } from 'vitest';
import { arrangedBounds, arrangeMap, deptKey, deptLayout, HUB_KEY, personKey, type MapArrangement } from '../src/map-arrange';
import { peopleLayout } from '../src/map-people';
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

describe('the map as nobody moved it', () => {
  it('stands where the map places everything, with the department people as they are laid out today', () => {
    const arr = arrangeMap(ORG4);
    const spots = deptLayout(4);
    expect(arr.depts.map(d => [d.x, d.y, d.path])).toEqual(spots.map(s => [s.x, s.y, s.path]));
    expect(arr.people).toEqual(peopleLayout(ORG4.departments.map((d, i) => ({ id: d.id, ...spots[i]! })), departmentPeople(ORG4)));
    expect(arr.hub).toEqual({ x: 480, y: 300, w: 240, h: 240 });
    /* Ivan's way runs from the top of the hub up to the bus and across to his card, as before. */
    expect(arr.top[0]!.path.slice(0, 2)).toEqual([[600, 300], [600, arr.bus!.via[1]]]);
  });
});

describe('the map while departments work in the turn', () => {
  const turn = (done: number, total: number) => ({ turnNumber: 3, done, total });
  /* Sales works in the turn; Operations, in the next corner, works all the time. */
  const working = (progress: Department['turnProgress']): Org => ({
    ...ORG4,
    turn: { id: 'u3', number: 3, goal: 'Ship payments' },
    departments: ORG4.departments.map((d, i) => ({ ...d, workMode: i === 1 ? 'continuous' as const : 'turns' as const, turnProgress: i === 0 ? progress : null })),
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

  it('sends a message along the lines as they are drawn', () => {
    const arr = arrangeMap(ORG4, { [deptKey(D1)]: { x: 100, y: 700 }, [personKey(OLEG)]: { x: 520, y: 720 } });
    const trace = arr.depts.find(d => d.id === D1)!.path;
    expect(pulsePath({ kind: 'department', id: D1 }, { kind: 'orchestrator' }, ORG4, arr)).toEqual([...trace].reverse());
    const route = arr.people.routes.find(r => r.personId === OLEG && r.deptId === D1)!.pts;
    expect(pulsePath({ kind: 'department', id: D1 }, { kind: 'person', id: OLEG }, ORG4, arr)).toEqual(route);
  });
});
