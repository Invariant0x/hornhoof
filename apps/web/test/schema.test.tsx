import { describe, expect, it } from 'vitest';
import { FT, HH, HW, schemaLayout, stepPaths } from '../src/screens/schema';
import type { Department, DeptRole, Employee } from '../src/types';

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

describe('the department schema', () => {
  it('puts employees without a known role into a frame of their own outside the work stages', () => {
    const s = schemaLayout(dept([emp('bruno', 'DEV-BE'), emp('ann', null), emp('rob', 'CUSTOM')], [role('DEV-BE')]), 0);
    expect(s.frames.map(f => [f.key, f.role?.id ?? null, f.members.map(m => m.e.id)])).toEqual([
      ['outside:DEV-BE', 'DEV-BE', ['bruno']],
      ['outside:', null, ['ann', 'rob']],
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

  it('places a sub-unit in its own frame with a direct line from the head, outside any stage or gate', () => {
    const urgent = { id: 'u1', name: 'Urgent fixes', about: '', stage: 0, gate: false };
    const simon = { ...emp('simon', 'DEV-BE'), teamId: 'u1' };
    const d: Department = { ...dept([...TEAM, simon], ROLES), teams: [urgent] };
    const s = schemaLayout(d, 0);
    expect(s.frames[0]!.team?.name).toBe('Urgent fixes');
    expect(s.frames[0]!.stage).toBe(-1);
    expect(s.frames[0]!.members.map(m => m.e.id)).toEqual(['simon']);
    expect(s.stages.flat().some(f => f.members.some(m => m.e.id === 'simon'))).toBe(false);
    /* Direct line from the head's left edge into the sub-unit frame, with no pipeline or rework line touching it. */
    expect(s.lines).toContainEqual({
      cls: 'tr',
      pts: [[s.hx - HW / 2, HH / 2], [s.frames[0]!.x + 10, HH / 2], [s.frames[0]!.x + 10, FT]],
      arrow: true,
    });
    expect(s.lines.some(l => l.cls === 'pl' && l.pts.some(p => p[0] < s.stages[0]![0]!.x))).toBe(false);
    const p = stepPaths(s);
    const placed = s.frames[0]!.members[0]!;
    expect(p.toMember('simon')).toEqual([
      [s.hx - HW / 2 + 14, HH / 2],
      [s.frames[0]!.x + 10, HH / 2],
      [s.frames[0]!.x + 10, placed.cy],
      [placed.x + 14, placed.cy],
    ]);
    expect(p.onward('simon')).toEqual([...p.toMember('simon')!].reverse());
    expect(p.way('simon', 'hana')).toEqual(p.onward('simon'));
  });
});
