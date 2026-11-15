import { describe, expect, it } from 'vitest';
import { DEPARTMENT_TEMPLATES } from '../src/index.js';
import * as departmentMode from '../src/department-mode.js';

const { DepartmentTurnProgress } = departmentMode;

/* Every department works in one flow of tasks, its turn being its next release: no template or setting picks how it works. */
describe('no department work mode', () => {
  it('leaves the work mode out of every template and of the contract', () => {
    for (const template of DEPARTMENT_TEMPLATES) expect(template).not.toHaveProperty('workMode');
    expect(Object.keys(departmentMode).filter(name => /WorkMode/i.test(name))).toEqual([]);
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
