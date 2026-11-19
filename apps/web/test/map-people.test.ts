import { describe, expect, it } from 'vitest';
import { dockedRoom, PH, PW, peopleLayout, rowCenters, wirePeople, type DeptPersonInput, type Spot } from '../src/map-people';
import { bridgeWires } from '../src/map-people-bridges';
import { deptLayout } from '../src/screens/Map';
import type { Point } from '../src/ui/wires';

const CX = 600, CY = 420, HUB = 120;

function spotsFor(ids: string[]): (Spot & { path: Point[] })[] {
  return deptLayout(ids.length).map((s, i) => ({ ...s, id: ids[i]! }));
}

type Seg = { owner: string; a: Point; b: Point };

function segmentsOf(pts: Point[], owner: string): Seg[] {
  return pts.slice(1).map((b, i) => ({ owner, a: pts[i]!, b }));
}

function samePoint(p: Point, q: Point): boolean {
  return p[0] === q[0] && p[1] === q[1];
}

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function onBox(p: Point, a: Point, b: Point): boolean {
  return (
    p[0] >= Math.min(a[0], b[0]) &&
    p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) &&
    p[1] <= Math.max(a[1], b[1])
  );
}

/* True when two segments cross or overlap anywhere except a permitted shared junction point. */
function segmentsCross(s1: Seg, s2: Seg, allowedShared: Point[]): boolean {
  const { a, b } = s1;
  const { a: c, b: d } = s2;
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;

  const collinear = d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0;
  if (collinear) {
    const xOverlap = Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) - Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0]));
    const yOverlap = Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) - Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1]));
    if (xOverlap > 0 || yOverlap > 0) return true;
  }

  const hits: Point[] = [];
  if (d1 === 0 && onBox(a, c, d)) hits.push(a);
  if (d2 === 0 && onBox(b, c, d)) hits.push(b);
  if (d3 === 0 && onBox(c, a, b)) hits.push(c);
  if (d4 === 0 && onBox(d, a, b)) hits.push(d);
  if (!hits.length) return false;

  if (s1.owner !== s2.owner) return true;
  return hits.some(h => !allowedShared.some(v => samePoint(h, v)));
}

/* The part of a department's trace outside the hub, which covers the rest: where the trace crosses the hub's edge, it starts. */
function outsideHub(pts: Point[]): Point[] {
  const inside = (p: Point) => Math.hypot(p[0] - CX, p[1] - CY) <= HUB;
  const first = pts.findIndex(p => !inside(p));
  if (first <= 0) return pts;
  const [a, b] = [pts[first - 1]!, pts[first]!];
  /* A run across or down leaves the hub where it is HUB from the middle. */
  const edge: Point = a[0] === b[0] ? [a[0], CY + Math.sign(b[1] - CY) * Math.sqrt(HUB * HUB - (a[0] - CX) ** 2)] : [CX + Math.sign(b[0] - CX) * Math.sqrt(HUB * HUB - (a[1] - CY) ** 2), a[1]];
  return [edge, ...pts.slice(first)];
}

/* Closest distance from the hub center to a segment. */
function distToHub(a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((CX - a[0]) * dx + (CY - a[1]) * dy) / lenSq));
  return Math.hypot(CX - (a[0] + t * dx), CY - (a[1] + t * dy));
}

function startsOnDept(pt: Point, s: Spot): boolean {
  const onVert = (pt[0] === s.x || pt[0] === s.x + s.w) && pt[1] >= s.y && pt[1] <= s.y + s.h;
  const onBottom = pt[1] === s.y + s.h && pt[0] >= s.x && pt[0] <= s.x + s.w;
  return onVert || onBottom;
}

function assertPlanarScene(spots: (Spot & { path: Point[] })[], people: DeptPersonInput[], ph = PH) {
  const layout = peopleLayout(spots, people, ph);
  const byId = new Map(spots.map(s => [s.id, s]));

  expect(layout.chips.map(c => c.id).sort()).toEqual(people.map(p => p.id).sort());
  for (const p of people) {
    expect(layout.routes.filter(r => r.personId === p.id).map(r => r.deptId).sort()).toEqual([...new Set(p.departments)].sort());
  }

  /* Every route starts on its department; visible wire pieces stay outside the hub, including at bridges. */
  for (const r of layout.routes) expect(startsOnDept(r.pts[0]!, byId.get(r.deptId)!)).toBe(true);
  for (const w of layout.wires) {
    for (const seg of segmentsOf(w.pts, w.personId)) {
      expect(distToHub(seg.a, seg.b)).toBeGreaterThan(HUB);
    }
  }

  /* Collect all map segments: department traces from hub, top-row people stem to hub, and department-people wires. */
  const allSegs: Seg[] = [];
  const allowedByOwner = new Map<string, Point[]>();

  /* The hub covers its middle, where the traces of departments meet: only what shows of them may not cross. */
  const hubShared: Point[] = [[CX, CY]];
  for (const s of spots) {
    const shown = outsideHub(s.path);
    allSegs.push(...segmentsOf(shown, 'hub'));
    for (const pt of shown.slice(0, -1)) hubShared.push(pt);
  }
  const topY = Math.min(...spots.map(s => s.y)) - 28 - 56;
  const busY = topY + 56 + 14;
  const topCenters = rowCenters(2, 160, 20);
  allSegs.push(
    ...segmentsOf([[topCenters[0]!, topY + 56], [topCenters[0]!, busY], [topCenters[1]!, busY], [topCenters[1]!, topY + 56]], 'top'),
    ...segmentsOf([[CX, busY], [CX, CY - HUB]], 'top'),
  );
  allowedByOwner.set('hub', hubShared);
  allowedByOwner.set('top', [[topCenters[0]!, busY], [topCenters[1]!, busY], [CX, busY]]);

  for (const w of layout.wires) {
    const bends = w.pts.slice(1, -1);
    const prev = allowedByOwner.get(w.personId) ?? [...layout.vias];
    allowedByOwner.set(w.personId, [...prev, ...bends]);
    allSegs.push(...segmentsOf(w.pts, w.personId));
  }

  for (let i = 0; i < allSegs.length; i++) {
    for (let j = i + 1; j < allSegs.length; j++) {
      const a = allSegs[i]!, b = allSegs[j]!;
      const allowed = a.owner === b.owner ? (allowedByOwner.get(a.owner) ?? []) : [];
      expect(segmentsCross(a, b, allowed), `${a.owner} ${JSON.stringify([a.a, a.b])} vs ${b.owner} ${JSON.stringify([b.a, b.b])}`).toBe(false);
    }
  }

  /* The wires, their forks and their bridges come from the routes and the cards alone. */
  expect(wirePeople(layout.routes, layout.chips)).toEqual({ wires: layout.wires, vias: layout.vias, gaps: layout.gaps });
  return layout;
}

function assertClearChips(layout: ReturnType<typeof peopleLayout>) {
  for (const wire of layout.wires) {
    for (const { a, b } of segmentsOf(wire.pts, wire.personId)) {
      for (const chip of layout.chips) {
        const insideX = Math.max(a[0], b[0]) > chip.x && Math.min(a[0], b[0]) < chip.x + chip.w;
        const insideY = Math.max(a[1], b[1]) > chip.y && Math.min(a[1], b[1]) < chip.y + chip.h;
        expect(insideX && insideY, `${wire.personId} passes through ${chip.id}`).toBe(false);
      }
    }
  }
}

/* Chips that stand over another chip or over a card. */
function overChips(layout: ReturnType<typeof peopleLayout>, spots: Spot[]): string[] {
  const boxes = [...layout.chips, ...spots];
  return boxes.flatMap((a, i) => boxes.slice(i + 1).flatMap(b => (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h ? [`${a.id} over ${b.id}`] : []
  )));
}

describe('peopleLayout', () => {
  it.each([2, 3])('keeps every person and all lines clear with %i docked people and several strip people', count => {
    const spots = spotsFor(['sls', 'mkt', 'prd', 'eng', 'sup', 'fin']);
    const docked = spots.flatMap(s => Array.from({ length: count }, (_, i) => ({ id: `${s.id}:${i}`, departments: [s.id] })));
    const layout = assertPlanarScene(spots, [
      ...docked,
      { id: 'mira', departments: ['sup', 'fin'] },
      { id: 'ines', departments: ['sls', 'eng'] },
      { id: 'nina', departments: ['sls', 'sup'] },
      { id: 'vera', departments: ['mkt', 'eng', 'fin'] },
    ]);
    assertClearChips(layout);
  });

  it('keeps an adjacent-column person in the gutter when a strip route uses the same gap', () => {
    const spots = spotsFor(['sls', 'mkt', 'prd', 'eng', 'sup', 'fin']);
    const layout = assertPlanarScene(spots, [
      { id: 'omar', departments: ['sls', 'prd'] },
      { id: 'ines', departments: ['sls', 'eng'] },
    ]);
    expect(layout.chips.find(c => c.id === 'omar')!.y).toBe(286);
    assertClearChips(layout);
  });

  it('docks one-department people 40 px off the outer side of their card, stacking up to three', () => {
    const spots = spotsFor(['sls', 'mkt', 'prd', 'eng']);
    const layout = assertPlanarScene(spots, [
      { id: 'lena', departments: ['sls'] },
      { id: 'jonas', departments: ['mkt'] },
      { id: 'ada', departments: ['mkt'] },
      { id: 'kofi', departments: ['mkt'] },
    ]);

    const byId = Object.fromEntries(layout.chips.map(c => [c.id, c]));
    /* Left column card sits at x=110..390, y=120..280 (midY=200): 40 px out puts the 156x48 chip at x=-86, y=176. */
    expect(byId.lena).toEqual({ id: 'lena', x: 110 - 40 - PW, y: 200 - PH / 2, w: PW, h: PH });
    /* Right column card sits at x=810..1090, y=120..280: three chips stack 8 px apart around midY=200. */
    expect(byId.jonas).toEqual({ id: 'jonas', x: 1090 + 40, y: 200 - (PH + 8) - PH / 2, w: PW, h: PH });
    expect(byId.ada).toEqual({ id: 'ada', x: 1090 + 40, y: 200 - PH / 2, w: PW, h: PH });
    expect(byId.kofi).toEqual({ id: 'kofi', x: 1090 + 40, y: 200 + (PH + 8) - PH / 2, w: PW, h: PH });

    /* Straight wire from the card outer edge to the chip inner edge, no vias. */
    const lenaRoute = layout.routes.find(r => r.personId === 'lena')!;
    expect(lenaRoute.pts).toEqual([[110, 200], [70, 200]]);
    expect(layout.vias).toEqual([]);
  });

  it('places a person with two adjacent same-column departments in the outer gutter with a 14 px rail and via', () => {
    const spots = spotsFor(['sls', 'mkt', 'prd', 'eng', 'sup', 'fin']);
    const layout = assertPlanarScene(spots, [{ id: 'omar', departments: ['sls', 'prd'] }]);

    const sls = spots[0]!, prd = spots[2]!;
    const cy = (sls.y + sls.h + prd.y) / 2;
    expect(layout.chips).toEqual([{ id: 'omar', x: sls.x - 40 - PW, y: cy - PH / 2, w: PW, h: PH }]);

    const rail = sls.x - 14;
    expect(layout.vias).toEqual([[rail, cy]]);
    expect(layout.routes).toEqual([
      { personId: 'omar', deptId: 'sls', pts: [[sls.x, sls.y + sls.h - 14], [rail, sls.y + sls.h - 14], [rail, cy], [sls.x - 40, cy]] },
      { personId: 'omar', deptId: 'prd', pts: [[prd.x, prd.y + 14], [rail, prd.y + 14], [rail, cy], [sls.x - 40, cy]] },
    ]);
  });

  it('opens a strip under the lowest row for opposite-column departments, routing around docked chips to higher rows', () => {
    const spots = spotsFor(['sls', 'mkt', 'prd', 'eng', 'sup', 'fin']);
    /* Scene from the approved mockup: docked chips on sls, mkt, eng, fin; gutter on prd+sup; Ines across sls+eng. */
    const layout = assertPlanarScene(spots, [
      { id: 'hana', departments: ['sls'] },
      { id: 'ines', departments: ['sls', 'eng'] },
      { id: 'felix', departments: ['mkt'] },
      { id: 'sana', departments: ['mkt'] },
      { id: 'teo', departments: ['prd', 'sup'] },
      { id: 'kofi', departments: ['eng'] },
      { id: 'yuki', departments: ['fin'] },
    ]);

    const low = Math.max(...spots.map(s => s.y + s.h));
    const lane = low + 30;
    const inesChip = layout.chips.find(c => c.id === 'ines')!;
    expect(inesChip).toEqual({ id: 'ines', x: CX - PW / 2, y: lane + 22, w: PW, h: PH });
    expect(layout.vias).toContainEqual([CX, lane]);

    const sls = spots[0]!, eng = spots[3]!;
    const leftRing = sls.x - 40 - PW - 18;
    const rightRing = eng.x + eng.w + 40 + PW + 18;
    const inesRoutes = layout.routes.filter(r => r.personId === 'ines');
    expect(inesRoutes).toEqual([
      {
        personId: 'ines',
        deptId: 'sls',
        pts: [[sls.x + 48, sls.y + sls.h], [sls.x + 48, sls.y + sls.h + 30], [leftRing, sls.y + sls.h + 30], [leftRing, lane], [CX, lane], [CX, lane + 22]],
      },
      {
        personId: 'ines',
        deptId: 'eng',
        pts: [[eng.x + eng.w - 48, eng.y + eng.h], [eng.x + eng.w - 48, eng.y + eng.h + 30], [rightRing, eng.y + eng.h + 30], [rightRing, lane], [CX, lane], [CX, lane + 22]],
      },
    ]);

    /* A two-department single-row map sits above the hub; the strip stays below the hub and never touches it. */
    const singleRow = assertPlanarScene(spotsFor(['sls', 'mkt']), [{ id: 'vera', departments: ['sls', 'mkt'] }]);
    expect(singleRow.chips[0]!.y).toBeGreaterThan(CY + HUB);
  });

  it('sends three-department and non-adjacent same-column people to the bottom strip without crossings', () => {
    const spots = spotsFor(['sls', 'mkt', 'prd', 'eng', 'sup', 'fin']);

    /* Two in one column, rows 0 and 2 (not adjacent). */
    const nonAdj = assertPlanarScene(spots, [{ id: 'nina', departments: ['sls', 'sup'] }]);
    const low = Math.max(...spots.map(s => s.y + s.h));
    expect(nonAdj.chips).toEqual([{ id: 'nina', x: CX - PW / 2, y: low + 30 + 22, w: PW, h: PH }]);
    expect(nonAdj.routes.map(r => r.deptId)).toEqual(['sls', 'sup']);

    /* Three+ strip people combining cross-column, non-adjacent and three-department reach on one map. */
    const multi = assertPlanarScene(spots, [
      { id: 'hana', departments: ['sls'] },
      { id: 'lena', departments: ['mkt'] },
      { id: 'omar', departments: ['prd', 'sup'] },
      { id: 'mira', departments: ['sup', 'fin'] },
      { id: 'nina', departments: ['sls', 'sup'] },
      { id: 'vera', departments: ['mkt', 'eng', 'fin'] },
    ]);
    expect(multi.chips.filter(c => c.y > low)).toHaveLength(3);
    expect(multi.routes.filter(r => r.personId === 'vera').map(r => r.deptId)).toEqual(['mkt', 'eng', 'fin']);
  });

  it('overflows a fourth single-department person while keeping a gutter person beside their cards', () => {
    const spots = spotsFor(['sls', 'mkt', 'prd', 'eng']);
    const layout = assertPlanarScene(spots, [
      { id: 'p1', departments: ['mkt'] },
      { id: 'p2', departments: ['mkt'] },
      { id: 'p3', departments: ['mkt'] },
      { id: 'p4', departments: ['mkt'] },
      { id: 'omar', departments: ['sls', 'prd'] },
      { id: 'ines', departments: ['sls', 'eng'] },
    ]);
    const low = Math.max(...spots.map(s => s.y + s.h));
    const stripIds = layout.chips.filter(c => c.y > low).map(c => c.id);
    expect(stripIds).toEqual(['ines', 'p4']);
  });
});

describe('bridges between the lines of different people', () => {
  const wire = (personId: string, pts: Point[]) => ({ id: personId, personId, deptId: 'd', pts });

  it('cut a line only where it crosses another, not where it joins or leaves a road the other runs on', () => {
    const road = wire('a', [[0, 0], [100, 0]]);
    expect(bridgeWires([road, wire('b', [[50, 0], [50, 50]])]).gaps).toEqual([]);
    expect(bridgeWires([road, wire('b', [[0, 0], [70, 0], [70, 30]])]).gaps).toEqual([]);
    expect(bridgeWires([road, wire('b', [[50, 50], [50, 0], [80, 0]])]).gaps).toEqual([]);
    expect(bridgeWires([road, wire('c', [[50, -50], [50, 50]])]).gaps).toEqual([{ personId: 'c', pts: [[50, -6], [50, expect.closeTo(6)]] }]);
  });
});

describe('peopleLayout with chips as tall as their words need', () => {
  const ids = ['sls', 'mkt', 'prd', 'eng', 'sup', 'fin'];
  /* Three people beside every card, one in the gutter of each column and four under the lowest row. */
  const crowd: DeptPersonInput[] = [
    ...ids.flatMap(id => [0, 1, 2].map(i => ({ id: `${id}:${i}`, departments: [id] }))),
    { id: 'omar', departments: ['sls', 'prd'] },
    { id: 'teo', departments: ['mkt', 'eng'] },
    { id: 'ines', departments: ['sls', 'eng'] },
    { id: 'nina', departments: ['sls', 'sup'] },
    { id: 'vera', departments: ['mkt', 'eng', 'fin'] },
    { id: 'mira', departments: ['sup', 'fin'] },
  ];
  /* The cards as the map lays them out for chips of this height: as tall as the stack docked beside one, and the rows apart
     as far as the people beside them need. */
  const roomy = (ph: number) => {
    const room = dockedRoom(spotsFor(ids), crowd, ph);
    return deptLayout(ids.length, Math.max(160, room.stack), room).map((s, i) => ({ ...s, id: ids[i]! }));
  };

  it('needs no more room than the cards and the gaps between them while the chips keep 48 px', () => {
    expect(dockedRoom(spotsFor(ids), crowd)).toEqual({ stack: 3 * PH + 2 * 8, gutter: PH + 12 });
    expect(roomy(PH)).toEqual(spotsFor(ids));
    expect(dockedRoom(spotsFor(ids), [{ id: 'nina', departments: ['sls', 'sup'] }])).toEqual({ stack: 0, gutter: 0 });
  });

  it('stacks the chips beside a card by their height, 8 px apart around its middle', () => {
    const spots = roomy(90);
    const layout = peopleLayout(spots, crowd, 90);
    const sls = spots[0]!, mid = sls.y + sls.h / 2;
    expect([0, 1, 2].map(i => layout.chips.find(c => c.id === `sls:${i}`))).toEqual([0, 1, 2].map(i => ({ id: `sls:${i}`, x: sls.x - 40 - PW, y: mid + (i - 1) * 98 - 45, w: PW, h: 90 })));
    expect(layout.chips.every(c => c.w === PW && c.h === 90)).toBe(true);
  });

  it('moves the rows apart so that no chip stands over another or over a card, every line clear', () => {
    for (const ph of [64, 90, 140]) {
      const spots = roomy(ph);
      const layout = assertPlanarScene(spots, crowd, ph);
      expect(overChips(layout, spots), `${ph} px`).toEqual([]);
      assertClearChips(layout);
    }
  });
});
