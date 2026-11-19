import { describe, expect, it } from 'vitest';
import { BUS, CH, CY, FHEAD, FT, FW, G, GS, HH, HW, PH, PW, PY, REP, RY, schemaLayout, stepPaths } from '../src/screens/schema';
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

describe('the department schema as tall as its words', () => {
  const sizes = (s: ReturnType<typeof schemaLayout>) => s.size;

  it.each([
    ['no sub-units', () => dept(TEAM, ROLES)],
    ['nine sub-units', grown],
  ])('keeps the old sizes and places while the words fit them, with %s', (_, make) => {
    const before = schemaLayout(make(), 2);
    expect(sizes(before)).toEqual({ head: HH, chip: CH, heading: FHEAD, row: PY, bus: BUS, ry: RY, cy: CY, ft: FT });
    /* Words that need no more, or at most a pixel more, than the old boxes change nothing. */
    for (const need of [{ head: 0, chip: 0, heading: 0 }, { head: 172.4, chip: 83.8, heading: 81 }, { head: HH + 1, chip: CH + 1, heading: FHEAD - 12 }]) {
      expect(schemaLayout(make(), 2, need)).toEqual(before);
    }
  });

  it.each([
    ['no sub-units', () => dept(TEAM, ROLES)],
    ['nine sub-units', grown],
  ])('grows the head card, every chip and every heading to the tallest one\'s words and keeps every gap, with %s', (_, make) => {
    const s = schemaLayout(make(), 2, { head: 260.4, chip: 131.2, heading: 150 });
    const z = sizes(s);
    /* In whole pixels; a heading leaves 12 below it, as chips do between them, and 1 for the frame's line above it. */
    expect([z.head, z.chip, z.heading, z.row]).toEqual([261, 132, 163, 144]);
    expect([z.bus - z.head, z.ry - z.bus, z.cy - z.bus, z.ft - z.cy]).toEqual([BUS - HH, RY - BUS, CY - BUS, FT - CY]);
    for (const f of s.frames) {
      f.members.forEach((m, i) => {
        expect(m.y).toBe(z.ft + z.heading + i * z.row);
        expect(m.cy).toBe(m.y + z.chip / 2);
      });
      const last = f.members[f.members.length - 1];
      if (last) expect(z.ft + f.h).toBeGreaterThanOrEqual(last.y + z.chip + 8);
      if (f.members.length) expect(s.lines).toContainEqual({ cls: 'tr', pts: [[f.x + 10, z.bus], [f.x + 10, last!.cy]] });
    }
    /* The head's drop leaves its card's bottom, the bus runs under it, and the report comes into the card. */
    expect(s.lines).toContainEqual({ cls: 'tr', pts: [[s.hx, z.head], [s.hx, z.bus]] });
    const [ex, ey] = s.report!.pts[s.report!.pts.length - 1]!;
    expect((ex === s.hx + HW / 2 && ey > 0 && ey < z.head) || (ey === z.head && ex > s.hx - HW / 2 && ex < s.hx + HW / 2)).toBe(true);
    for (const g of s.lines.filter(l => l.cls === 'gate')) expect(g.pts[0]![1]).toBe(z.ry + 16);
    expect(s.h).toBe(z.ft + Math.max(...s.frames.map(f => f.h)));
    const first = s.frames.find(f => f.members.length)!;
    expect(stepPaths(s).toMember(first.members[0]!.e.id)).toEqual([[s.hx, z.head - 30], [s.hx, z.bus], [first.x + 10, z.bus], [first.x + 10, first.members[0]!.cy], [first.members[0]!.x + 14, first.members[0]!.cy]]);
  });
});
