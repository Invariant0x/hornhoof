import { describe, expect, it } from 'vitest';
import { BUS, CH, CY, FHEAD, FT, FW, G, GS, HEAD_ROOM, HH, HW, PH, PW, PY, REP, schemaLayout, stepPaths } from '../src/screens/schema';
import { taskRoute } from './task-route';
import type { Department, DeptRole, Employee } from '../src/types';
import type { Point } from '../src/ui/wires';

const role = (id: string, gate: number | null = null, schema?: 'before_work' | 'final_check' | 'observer'): DeptRole => ({ id, title: { en: id, ru: id }, description: { en: '', ru: '' }, kind: id.endsWith('HEAD') ? 'head' : 'member', gate, ...(schema ? { schema } : {}) });
const emp = (id: string, roleId: string | null, kind: Employee['kind'] = 'worker'): Employee => ({
  id,
  name: id,
  roleId,
  title: null,
  kind,
  model: '',
  modelName: null,
  provider: 'claude',
  state: 'sleeping',
  status: 'idle',
  on: true,
  task: null,
  effort: null,
  timer: null,
  context: null,
  program: null, alarm: null, retry: null, failure: null,
});
const dept = (employees: Employee[], roles: DeptRole[]): Department => ({
  id: 'd1',
  name: null,
  templateKey: 'development',
  roleCode: 'DEV',
  about: '',
  agents: { total: employees.length, working: 0 },
  products: [],
  teams: [],
  people: [],
  employees,
  roles,
});

const ROLES = [role('DEV-HEAD'), role('DEV-BE'), role('DEV-FE'), role('DEV-REV', 1), role('DEV-QA', 5)];
const TEAM = [emp('hana', 'DEV-HEAD', 'head'), emp('bruno', 'DEV-BE'), emp('felix', 'DEV-FE'), emp('fiona', 'DEV-FE'), emp('rita', 'DEV-REV'), emp('quinn', 'DEV-QA')];

/* Nine sub-units, an observer and a short pipeline, as a grown department has them. */
function grown(): Department {
  const teams = Array.from({ length: 9 }, (_, i) => ({ id: `u${i}`, name: `Unit ${i}`, about: '', stage: 0, gate: false, turnkey: false }));
  const employees = [...TEAM, emp('pat', 'DEV-PERF'), ...teams.map((t, i) => ({ ...emp(`m${i}`, 'DEV-BE'), teamId: t.id }))];
  return { ...dept(employees, [...ROLES, role('DEV-PERF', null, 'observer')]), teams };
}

/* Whether a level or upright piece of a line touches a box [x, y, width, height]. */
const touches = (a: Point, b: Point, [x, y, w, h]: number[]) =>
  Math.max(a[0], b[0]) >= x! && Math.min(a[0], b[0]) <= x! + w! && Math.max(a[1], b[1]) >= y! && Math.min(a[1], b[1]) <= y! + h!;
const pieces = (pts: Point[]) => pts.slice(1).map((b, i) => [pts[i]!, b] as const);

describe('the department schema', () => {
  it('lays out design, work, each check in its order and the final check, with an observer outside the pipeline', () => {
    const roles = [
      role('DEV-TEST', null, 'final_check'),
      role('DEV-SEC', 2),
      role('DEV-ARCH', null, 'before_work'),
      role('DEV-REV', 1),
      role('DEV-ENG'),
      role('DEV-PERF', null, 'observer'),
    ];
    const employees = roles.map(r => emp(r.id.toLowerCase(), r.id));
    const s = schemaLayout(dept(employees, roles), 0);
    expect(s.stages.map(stage => stage.map(f => [f.key, f.stage, f.check]))).toEqual([
      [['DEV-ARCH', 0, false]],
      [['DEV-ENG', 1, false]],
      [['DEV-REV', 2, true]],
      [['DEV-SEC', 3, true]],
      [['DEV-TEST', 4, true]],
    ]);
    /* A gate before every check, the final one too; none between design and the work. */
    expect(s.gates.map(g => g.n)).toEqual([1, 2, 3]);
    expect(s.gates[0]!.x).toBeGreaterThan(s.stages[1]![0]!.x + FW);
    expect(s.gates[0]!.x).toBeLessThan(s.stages[2]![0]!.x);
    expect(s.lines.filter(l => l.cls === 'gate')).toHaveLength(4);
    const observer = s.frames.find(f => f.key === 'DEV-PERF')!;
    expect(observer.stage).toBe(-1);
    expect(observer.x).toBeLessThan(s.stages[0]![0]!.x);
    expect(s.stages.flat().some(f => f.key === 'DEV-PERF')).toBe(false);
  });

  it('keeps every role and employee where they stand whether anyone holds a task or not', () => {
    const roles = [role('DEV-ARCH', null, 'before_work'), role('DEV-ENG'), role('DEV-REV', 1), role('DEV-SEC', 2), role('DEV-TEST', null, 'final_check')];
    const employees = roles.map(r => emp(r.id.toLowerCase(), r.id));
    const busy = employees.map(e => (e.id === 'dev-rev' ? { ...e, status: 'working' as const, task: { id: 't1', number: 1, title: 'Checkout', echelons: taskRoute('review', 'dev-rev') } } : e));
    const where = (s: ReturnType<typeof schemaLayout>) => s.frames.map(f => [f.key, f.x, f.stage, f.members.map(m => [m.e.id, m.x, m.y])]);
    const idle = schemaLayout(dept(employees, roles), 0), working = schemaLayout(dept(busy, roles), 0);
    expect(where(working)).toEqual(where(idle));
    expect(working.gates).toEqual(idle.gates);
  });

  it('puts a frame per role into stages: the roles without a gate first, then each gate in its order', () => {
    const s = schemaLayout(dept(TEAM, ROLES), 0);
    expect(s.frames.map(f => [f.key, f.x, f.stage])).toEqual([
      ['DEV-BE', 0, 0],
      ['DEV-FE', FW + GS, 0],
      ['DEV-REV', 2 * FW + GS + G, 1],
      ['DEV-QA', 3 * FW + GS + 2 * G, 2],
    ]);
    expect(s.w).toBe(4 * FW + GS + 2 * G);
    const fe = s.frames[1]!;
    expect(fe.members.map(m => [m.e.id, m.x, m.y])).toEqual([
      ['felix', FW + GS + 20, FT + FHEAD],
      ['fiona', FW + GS + 20, FT + FHEAD + PY],
    ]);
    expect(fe.h).toBe(FHEAD + 2 * PY + 8);
    expect(s.h).toBe(FT + fe.h);
  });

  it('centers the head over the frames and numbers the gates between the stages', () => {
    const s = schemaLayout(dept(TEAM, ROLES), 0);
    expect(s.hx).toBe(s.w / 2);
    expect(s.head).toEqual(TEAM[0]);
    expect(s.gates).toEqual([
      { x: (2 * FW + GS + (2 * FW + GS + G)) / 2, n: 1 },
      { x: (3 * FW + GS + G + (3 * FW + GS + 2 * G)) / 2, n: 2 },
    ]);
  });

  it('draws the pipeline through every gate and the report to the head, with no way back', () => {
    const s = schemaLayout(dept(TEAM, ROLES), 0);
    expect(s.lines.filter(l => l.cls === 'pl' && l.arrow && l.pts[0]![1] === CY)).toHaveLength(2);
    expect(s.lines.some(l => (l.cls as string) === 'rl')).toBe(false);
    expect(s.report!.pts).toEqual([
      [s.frames[3]!.x + FW - 30, FT],
      [s.frames[3]!.x + FW - 30, REP],
      [s.hx + HW / 2, REP],
    ]);
  });

  it('has no gates or pipeline when no role keeps a gate', () => {
    const s = schemaLayout(dept([emp('hana', 'DEV-HEAD', 'head'), emp('bruno', 'DEV-BE')], [role('DEV-HEAD'), role('DEV-BE')]), 0);
    expect(s.gates).toEqual([]);
    expect(s.lines.some(l => l.cls === 'gate' || (l.cls === 'pl' && l.pts[0]![1] === CY))).toBe(false);
    /* A narrow department keeps the head whole and reports straight up into it. */
    expect(s.hx).toBe(HW / 2);
    expect(s.report!.pts).toEqual([
      [FW - 30, FT],
      [FW - 30, HH],
    ]);
  });

  it('puts employees without a known role into a frame of their own at the end of the work stage', () => {
    const s = schemaLayout(dept([emp('bruno', 'DEV-BE'), emp('ann', null), emp('rob', 'CUSTOM')], [role('DEV-BE')]), 0);
    expect(s.frames.map(f => [f.key, f.role?.id ?? null, f.stage, f.members.map(m => m.e.id)])).toEqual([
      ['DEV-BE', 'DEV-BE', 0, ['bruno']],
      ['', null, 0, ['ann', 'rob']],
    ]);
    expect(s.head).toBeNull();
  });

  it('gives the paths a pulse runs: from the head to an employee, and on from its stage through the next gate', () => {
    const s = schemaLayout(dept(TEAM, ROLES), 0);
    const p = stepPaths(s);
    const felix = s.frames[1]!.members[0]!;
    expect(p.toMember('felix')).toEqual([
      [s.hx, HH - 30],
      [s.hx, BUS],
      [s.frames[1]!.x + 10, BUS],
      [s.frames[1]!.x + 10, felix.cy],
      [felix.x + 14, felix.cy],
    ]);
    expect(p.onward('felix')).toEqual([
      [s.frames[1]!.x + FW - 30, FT],
      [s.frames[1]!.x + FW - 30, CY],
      [s.frames[2]!.x + 30, CY],
      [s.frames[2]!.x + 30, FT],
    ]);
    expect(p.onward('quinn')).toEqual(s.report!.pts);
    expect(p.toMember('nobody')).toBeNull();
  });

  it('finds the way a message between two agents runs: down from the head, up to it, on to a later stage, back through the head', () => {
    const s = schemaLayout(dept(TEAM, ROLES), 0);
    const p = stepPaths(s);
    expect(p.way('hana', 'felix')).toEqual(p.toMember('felix'));
    expect(p.way('felix', 'hana')).toEqual([...p.toMember('felix')!].reverse());
    expect(p.way('quinn', 'hana')).toEqual(s.report!.pts);
    expect(p.way('felix', 'rita')).toEqual(p.onward('felix'));
    expect(p.way('rita', 'felix')).toEqual([...[...p.toMember('rita')!].reverse(), ...p.toMember('felix')!]);
    expect(p.way('felix', 'fiona')).toBeNull();
    expect(p.way('felix', 'nobody')).toBeNull();
  });

  it('lines the people up to the right of the head and widens the schema for them', () => {
    const s = schemaLayout(dept([emp('bruno', 'DEV-BE')], [role('DEV-BE')]), 2);
    expect(s.people).toEqual([
      [s.hx + HW / 2 + 40, 12],
      [s.hx + HW / 2 + 40, 12 + 66],
    ]);
    expect(s.right).toBe(s.hx + HW / 2 + 40 + 220);
  });

  it('hangs a sub-unit frame on the head\'s bus like a stage frame, outside any stage or gate', () => {
    const urgent = { id: 'u1', name: 'Urgent fixes', about: '', stage: 0, gate: false, turnkey: false };
    const sam = { ...emp('sam', 'DEV-BE'), teamId: 'u1' };
    const d: Department = { ...dept([...TEAM, sam], ROLES), teams: [urgent] };
    const s = schemaLayout(d, 0);
    const unit = s.frames[0]!;
    expect(unit.team?.name).toBe('Urgent fixes');
    expect(unit.stage).toBe(-1);
    expect(unit.members.map(m => m.e.id)).toEqual(['sam']);
    expect(s.stages.flat().some(f => f.members.some(m => m.e.id === 'sam'))).toBe(false);
    /* The head stands over the middle of all the frames, and the sub-unit's spine drops from the one bus. */
    expect(s.hx).toBe(s.w / 2);
    const placed = unit.members[0]!;
    expect(s.lines).toContainEqual({ cls: 'tr', pts: [[unit.x + 10, BUS], [s.frames[s.frames.length - 1]!.x + 10, BUS]] });
    expect(s.lines).toContainEqual({ cls: 'tr', pts: [[unit.x + 10, BUS], [unit.x + 10, placed.cy]] });
    expect(s.vias).toContainEqual([unit.x + 10, BUS]);
    expect(s.lines.some(l => (l.cls === 'pl' || l.cls === 'gate') && l.pts.some(p => p[0] < s.stages[0]![0]!.x))).toBe(false);
    const p = stepPaths(s);
    expect(p.toMember('sam')).toEqual([
      [s.hx, HH - 30],
      [s.hx, BUS],
      [unit.x + 10, BUS],
      [unit.x + 10, placed.cy],
      [placed.x + 14, placed.cy],
    ]);
    expect(p.onward('sam')).toEqual([...p.toMember('sam')!].reverse());
    expect(p.way('sam', 'hana')).toEqual(p.onward('sam'));
  });

  it('with many sub-units leads them all from the head\'s bottom: one drop to the bus, a spine down each frame, nothing from its left edge', () => {
    const s = schemaLayout(grown(), 1);
    const left = s.hx - HW / 2, right = s.hx + HW / 2;
    const units = s.frames.filter(f => f.team);
    expect(units).toHaveLength(9);
    /* Over the middle of the frames, not to the right of every sub-unit. */
    expect(s.hx).toBe(s.w / 2);
    expect(right).toBeLessThan(units[units.length - 1]!.x + FW);
    expect(s.lines.some(l => l.pts.some(([x, y]) => x === left && y <= HH))).toBe(false);
    expect(s.lines.filter(l => l.pts.some(([x, y]) => x > left && x < right && y === HH))).toEqual([{ cls: 'tr', pts: [[s.hx, HH], [s.hx, BUS]] }]);
    /* One bus along the sub-units, the observer and the stages alike. */
    expect(s.lines.filter(l => l.pts.every(([, y]) => y === BUS))).toEqual([
      { cls: 'tr', pts: [[s.frames[0]!.x + 10, BUS], [s.frames[s.frames.length - 1]!.x + 10, BUS]] },
    ]);
    for (const f of s.frames) {
      expect(s.lines).toContainEqual({ cls: 'tr', pts: [[f.x + 10, BUS], [f.x + 10, f.members[f.members.length - 1]!.cy]] });
      expect(s.vias).toContainEqual([f.x + 10, BUS]);
    }
    const observer = s.frames.find(f => f.key === 'DEV-PERF')!;
    const pat = observer.members[0]!;
    expect(stepPaths(s).toMember('pat')).toEqual([[s.hx, HH - 30], [s.hx, BUS], [observer.x + 10, BUS], [observer.x + 10, pat.cy], [pat.x + 14, pat.cy]]);
    /* The report still comes into the head's right edge, clear of the person's chip there, its label too. */
    expect(s.report!.pts[s.report!.pts.length - 1]).toEqual([right, REP]);
    const [px, py] = s.people[0]!;
    const [lx, ly] = s.report!.label;
    expect(REP).toBeGreaterThan(py + PH);
    expect(lx >= px && lx <= px + PW && ly >= py && ly <= py + PH).toBe(false);
  });

  it('lays out cards, headings, the head and the people that measure their natural size as it always did', () => {
    const natural = { head: HH, cards: Object.fromEntries(TEAM.map(e => [e.id, CH])), headings: { 'DEV-BE': 60, 'DEV-FE': FHEAD - HEAD_ROOM }, people: [PH, PH] };
    expect(schemaLayout(dept(TEAM, ROLES), 2, natural)).toEqual(schemaLayout(dept(TEAM, ROLES), 2));
  });

  it('stacks a card whose words take more lines by its measured height, and its frame, spine and the schema grow with it', () => {
    const plain = schemaLayout(dept(TEAM, ROLES), 0);
    const s = schemaLayout(dept(TEAM, ROLES), 0, { cards: { felix: 130 } });
    const fe = s.frames[1]!;
    const [felix, fiona] = fe.members;
    expect([felix!.y, felix!.h, felix!.cy]).toEqual([FT + FHEAD, 130, FT + FHEAD + 65]);
    expect([fiona!.y, fiona!.h, fiona!.cy]).toEqual([FT + FHEAD + 130 + PY - CH, CH, FT + FHEAD + 130 + PY - CH + CH / 2]);
    expect(fe.h).toBe(FHEAD + 130 + PY - CH + PY + 8);
    expect(s.h).toBe(FT + fe.h);
    expect(s.lines).toContainEqual({ cls: 'tick', pts: [[fe.x + 10, felix!.cy], [felix!.x, felix!.cy]] });
    expect(s.lines).toContainEqual({ cls: 'tr', pts: [[fe.x + 10, BUS], [fe.x + 10, fiona!.cy]] });
    expect(stepPaths(s).toMember('fiona')!.at(-1)).toEqual([fiona!.x + 14, fiona!.cy]);
    /* The other frames stay where they were. */
    expect(s.frames.filter(f => f !== fe)).toEqual(plain.frames.filter(f => f.key !== 'DEV-FE'));
  });

  it("starts a frame's cards under its heading when the heading wraps to more lines, and a call frame grows under it", () => {
    const s = schemaLayout(dept(TEAM, ROLES), 0, { headings: { 'DEV-FE': 120 } });
    const fe = s.frames[1]!;
    expect(fe.members.map(m => m.y)).toEqual([FT + 120 + HEAD_ROOM, FT + 120 + HEAD_ROOM + PY]);
    expect(fe.h).toBe(120 + HEAD_ROOM + 2 * PY + 8);
    /* A heading that still fits keeps the cards where they stand. */
    expect(schemaLayout(dept(TEAM, ROLES), 0, { headings: { 'DEV-FE': FHEAD - HEAD_ROOM } }).frames[1]!.members[0]!.y).toBe(FT + FHEAD);
    const pipelines = [{ id: 'r1', department: { id: 'd1', name: 'Development' }, name: 'Changes', why: '', archived: false, isDefault: true, version: 1,
      stages: [{ id: 's0', parentId: null, name: 'review', ownerRole: 'DEV-REV', owner: null, position: 0, echelon: 'review' as const, oneShot: { fanOut: 3, judge: true } }] }];
    const calls = (headings: Record<string, number>) => schemaLayout({ ...dept(TEAM, ROLES), pipelines }, 0, { headings }).frames.find(f => f.oneShot)!;
    expect(calls({}).h).toBe(FHEAD + 17);
    expect(calls({ 'one-shot:review': 150 }).h).toBe(150 + HEAD_ROOM);
  });

  it('moves the bus, the pipeline, the frames and the report down under a taller head card', () => {
    const plain = schemaLayout(dept(TEAM, ROLES), 0);
    const s = schemaLayout(dept(TEAM, ROLES), 0, { head: 240 });
    const down = 240 - HH;
    expect([s.hh, s.bus, s.cy, s.ft]).toEqual([240, BUS + down, CY + down, FT + down]);
    expect([plain.hh, plain.bus, plain.cy, plain.ft]).toEqual([HH, BUS, CY, FT]);
    expect(s.h).toBe(plain.h + down);
    expect(s.frames.map(f => f.members.map(m => m.y))).toEqual(plain.frames.map(f => f.members.map(m => m.y + down)));
    expect(s.lines).toContainEqual({ cls: 'tr', pts: [[s.hx, 240], [s.hx, s.bus]] });
    expect(s.lines.filter(l => l.cls === 'pl' && l.arrow).map(l => l.pts)).toEqual(plain.lines.filter(l => l.cls === 'pl' && l.arrow).map(l => l.pts.map(([x, y]) => [x, y + down])));
    expect(s.lines.filter(l => l.cls === 'gate').map(l => l.pts[0]![1])).toEqual(plain.lines.filter(l => l.cls === 'gate').map(l => l.pts[0]![1] + down));
    expect(s.report!.pts[0]).toEqual([plain.report!.pts[0]![0], s.ft]);
    expect(stepPaths(s).toMember('felix')!.slice(0, 2)).toEqual([[s.hx, 240 - 30], [s.hx, s.bus]]);
    expect(stepPaths(s).onward('felix')).toEqual(stepPaths(plain).onward('felix')!.map(([x, y]) => [x, y + down]));
  });

  it("stacks the people's chips by their measured heights, their line through the middle of each, and the report under the last", () => {
    const s = schemaLayout(dept(TEAM, ROLES), 2, { people: [100] });
    const px = s.hx + HW / 2 + 40;
    expect(s.people).toEqual([[px, 12], [px, 12 + 100 + 10]]);
    expect(s.peopleH).toEqual([100, PH]);
    expect(s.lines).toContainEqual({ cls: 'tick', pts: [[px - 14, 62], [px, 62]] });
    expect(s.lines).toContainEqual({ cls: 'tick', pts: [[px - 14, 122 + PH / 2], [px, 122 + PH / 2]] });
    expect(s.lines).toContainEqual({ cls: 'tr', pts: [[s.hx + HW / 2, 40], [px - 14, 40], [px - 14, 122 + PH / 2]] });
    /* The chips reach as low as the head now, so the report comes in under it, clear of them. */
    const pts = s.report!.pts;
    expect(pts.at(-1)![1]).toBe(HH);
    /* A taller first chip moves the way in on the head's edge down with the second one. */
    const edge = schemaLayout(dept(TEAM, ROLES), 2, { people: [70] }).report!.pts;
    expect(edge.at(-1)).toEqual([s.hx + HW / 2, 12 + 70 + 10 + PH + REP - 12 - PH]);
    for (const [a, b] of pieces(pts)) for (const [k, [x, y]] of s.people.entries()) expect(touches(a, b, [x, y, PW, s.peopleH[k]!])).toBe(false);
  });

  it.each([
    ['no sub-units', () => dept(TEAM, ROLES)],
    ['nine sub-units', grown],
  ])('brings the report into the head clear of the people\'s chips and their line, with %s', (_, make) => {
    for (const people of [0, 1, 2, 3]) {
      const s = schemaLayout(make(), people);
      const pts = s.report!.pts;
      const [ex, ey] = pts[pts.length - 1]!;
      /* It ends on the head: on its right edge or its bottom. */
      expect((ex === s.hx + HW / 2 && ey > 0 && ey < HH) || (ey === HH && ex > s.hx - HW / 2 && ex < s.hx + HW / 2)).toBe(true);
      const chips = s.people.map(([x, y]) => [x, y, PW, PH]);
      const peopleLine = s.lines.filter(l => l.pts.some(([x]) => x >= s.hx + HW / 2) && l.pts.every(([, y]) => y < BUS));
      const [lx, ly] = s.report!.label;
      for (const [a, b] of pieces(pts)) {
        for (const chip of chips) expect(touches(a, b, chip)).toBe(false);
        for (const l of peopleLine) for (const [c, d] of pieces(l.pts)) expect(touches(a, b, [Math.min(c[0], d[0]), Math.min(c[1], d[1]), Math.abs(c[0] - d[0]), Math.abs(c[1] - d[1])])).toBe(false);
      }
      for (const chip of chips) expect(touches([lx - 80, ly - 9], [lx + 80, ly + 9], chip)).toBe(false);
    }
  });
});
