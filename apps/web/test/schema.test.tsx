import { describe, expect, it } from 'vitest';
import { BUS, CY, FHEAD, FT, FW, G, GS, HH, HW, PY, REP, RY, schemaLayout, stepPaths } from '../src/screens/schema';
import type { Department, DeptRole, Employee } from '../src/types';

const role = (id: string, gate: number | null = null): DeptRole => ({ id, title: { en: id, ru: id }, description: { en: '', ru: '' }, kind: id.endsWith('HEAD') ? 'head' : 'member', gate });
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
  program: null, alarm: null,
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

describe('the department schema', () => {
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

  it('centers the head over the frames and numbers the gates, the last one as last', () => {
    const s = schemaLayout(dept(TEAM, ROLES), 0);
    expect(s.hx).toBe(s.w / 2);
    expect(s.head).toEqual(TEAM[0]);
    expect(s.gates.map(g => [g.n, g.last])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(s.gates[0]!.x).toBe((2 * FW + GS + (2 * FW + GS + G)) / 2);
  });

  it('draws the pipeline, the line back from every gate to the first stage, and the report to the head', () => {
    const s = schemaLayout(dept(TEAM, ROLES), 0);
    const back = s.lines.filter(l => l.cls === 'rl');
    /* Up from both gates, across, and down into both frames of the first stage. */
    expect(back.filter(l => l.arrow)).toHaveLength(2);
    expect(back.every(l => l.pts.some(p => p[1] === RY))).toBe(true);
    expect(s.lines.filter(l => l.cls === 'pl' && l.arrow && l.pts[0]![1] === CY)).toHaveLength(2);
    expect(s.report!.pts).toEqual([
      [s.frames[3]!.x + FW - 30, FT],
      [s.frames[3]!.x + FW - 30, REP],
      [s.hx + HW / 2, REP],
    ]);
    expect(s.back).not.toBeNull();
  });

  it('has no gates, pipeline or way back when no role keeps a gate', () => {
    const s = schemaLayout(dept([emp('hana', 'DEV-HEAD', 'head'), emp('bruno', 'DEV-BE')], [role('DEV-HEAD'), role('DEV-BE')]), 0);
    expect(s.gates).toEqual([]);
    expect(s.lines.some(l => l.cls === 'rl' || l.cls === 'gate')).toBe(false);
    expect(s.back).toBeNull();
    /* A narrow department keeps the head whole and reports straight up into it. */
    expect(s.hx).toBe(HW / 2);
    expect(s.report!.pts).toEqual([
      [FW - 30, FT],
      [FW - 30, HH],
    ]);
  });

  it('puts employees without a known role into a frame of their own at the end of the first stage', () => {
    const s = schemaLayout(dept([emp('bruno', 'DEV-BE'), emp('ann', null), emp('rob', 'CUSTOM')], [role('DEV-BE')]), 0);
    expect(s.frames.map(f => [f.key, f.role?.id ?? null, f.members.map(m => m.e.id)])).toEqual([
      ['DEV-BE', 'DEV-BE', ['bruno']],
      ['', null, ['ann', 'rob']],
    ]);
    expect(s.head).toBeNull();
  });

  it('lines the people up to the right of the head and widens the schema for them', () => {
    const s = schemaLayout(dept([emp('bruno', 'DEV-BE')], [role('DEV-BE')]), 2);
    expect(s.people).toEqual([
      [s.hx + HW / 2 + 40, 12],
      [s.hx + HW / 2 + 40, 12 + 66],
    ]);
    expect(s.right).toBe(s.hx + HW / 2 + 40 + 220);
  });

  it('gives the paths a pulse runs: from the head to an employee, on from its stage, and back from a gate', () => {
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
    expect(p.back('rita', 'felix')).toEqual([
      [s.frames[2]!.x + FW / 2, FT],
      [s.frames[2]!.x + FW / 2, RY],
      [s.frames[1]!.x + FW / 2, RY],
      [s.frames[1]!.x + FW / 2, FT],
    ]);
    expect(p.toMember('nobody')).toBeNull();
  });

  it('finds the way a message between two agents runs: down from the head, up to it, on to a later stage, back to an earlier one', () => {
    const s = schemaLayout(dept(TEAM, ROLES), 0);
    const p = stepPaths(s);
    expect(p.way('hana', 'felix')).toEqual(p.toMember('felix'));
    expect(p.way('felix', 'hana')).toEqual([...p.toMember('felix')!].reverse());
    expect(p.way('quinn', 'hana')).toEqual(s.report!.pts);
    expect(p.way('felix', 'rita')).toEqual(p.onward('felix'));
    expect(p.way('rita', 'felix')).toEqual(p.back('rita', 'felix'));
    expect(p.way('felix', 'fiona')).toBeNull();
    expect(p.way('felix', 'nobody')).toBeNull();
  });
});
