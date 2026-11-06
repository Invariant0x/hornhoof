import { describe, expect, it } from 'vitest';
import { DEPARTMENT_TEMPLATES, TEMPLATE_KEYS } from '../src/index.js';
import { defaultDepartmentWorkMode, DepartmentTurnProgress, DepartmentWorkMode, DepartmentWorkModeChange } from '../src/department-mode.js';

describe('department work mode contract', () => {
  it.each(['turns', 'continuous'])('accepts %s without caller authority', workMode => {
    expect(DepartmentWorkMode.parse(workMode)).toBe(workMode);
    expect(DepartmentWorkModeChange.parse({ workMode })).toEqual({ workMode });
  });
  it.each(['weekly', '', null, true, 1, {}])('rejects unknown mode %#', value => {
    expect(DepartmentWorkMode.safeParse(value).success).toBe(false);
  });
  it.each([
    {}, { mode: 'turns' }, { workMode: 'turns', canChange: true },
    { workMode: 'continuous', ownerPersonId: '00000000-0000-4000-8000-000000000001' },
  ])('rejects forged settings fields %#', value => {
    expect(DepartmentWorkModeChange.safeParse(value).success).toBe(false);
  });
  it('uses the Operations template default and a turns default for custom departments', () => {
    expect(defaultDepartmentWorkMode('operations')).toBe('continuous');
    expect(defaultDepartmentWorkMode(null)).toBe('turns');
    expect(DEPARTMENT_TEMPLATES).toContainEqual(expect.objectContaining({ key: 'operations', workMode: 'continuous' }));
  });
  it.each(TEMPLATE_KEYS.filter(key => key !== 'operations'))('keeps %s turn-based by template', key => {
    expect(defaultDepartmentWorkMode(key)).toBe('turns');
    expect(DEPARTMENT_TEMPLATES).toContainEqual(expect.objectContaining({ key, workMode: 'turns' }));
  });
});

describe('department progress metadata', () => {
  it.each([
    { turnNumber: 8, done: 0, total: 0 },
    { turnNumber: 8, done: 0, total: 5 },
    { turnNumber: 8, done: 3, total: 5 },
    { turnNumber: 8, done: 1000, total: 1000 },
  ])('accepts explicit common turn and exact counts %#', value => {
    expect(DepartmentTurnProgress.parse(value)).toEqual(value);
  });
  it.each([
    { turnNumber: 0, done: 0, total: 0 }, { turnNumber: 1.5, done: 0, total: 0 },
    { turnNumber: 8, done: -1, total: 0 }, { turnNumber: 8, done: 2, total: 1 },
    { turnNumber: 8, done: 0.5, total: 2 }, { turnNumber: 8, done: 0, total: Number.POSITIVE_INFINITY },
    { turnNumber: 8, done: 0, total: 0, departmentId: 'foreign' },
  ])('refuses invented or inconsistent progress %#', value => {
    expect(DepartmentTurnProgress.safeParse(value).success).toBe(false);
  });
});
