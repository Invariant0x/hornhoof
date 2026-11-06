import { z } from 'zod';
import { DEPARTMENT_TEMPLATES, type TemplateKey } from './index.js';

/* Shared metadata for the department setting and viewer-safe common-turn counts.
   These schemas do not confer ownership or reveal unfiltered task totals. */
export const DEPARTMENT_WORK_MODES = ['turns', 'continuous'] as const;
export const DepartmentWorkMode = z.enum(DEPARTMENT_WORK_MODES);
export type DepartmentWorkMode = z.infer<typeof DepartmentWorkMode>;
export const DepartmentWorkModeChange = z.strictObject({ workMode: DepartmentWorkMode });
export type DepartmentWorkModeChange = z.infer<typeof DepartmentWorkModeChange>;
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DepartmentTurnProgress = z.strictObject({ turnNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), done: Count, total: Count })
  .refine(value => value.done <= value.total, 'Completed tasks cannot exceed the total.');
export type DepartmentTurnProgress = z.infer<typeof DepartmentTurnProgress>;
export function defaultDepartmentWorkMode(key: TemplateKey | null): DepartmentWorkMode {
  return DEPARTMENT_TEMPLATES.find(template => template.key === key)?.workMode ?? 'turns';
}
