import { z } from 'zod';
import type { TemplateKey } from './index.js';

/* Strict metadata only. Shared index/template defaults wait for the previous
   schema writer's published checkpoint; no department DTO/route is enabled. */
export const DepartmentWorkMode = z.enum(['turns', 'continuous']);
export type DepartmentWorkMode = z.infer<typeof DepartmentWorkMode>;
export const DepartmentWorkModeChange = z.strictObject({ workMode: DepartmentWorkMode });
export type DepartmentWorkModeChange = z.infer<typeof DepartmentWorkModeChange>;
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DepartmentTurnProgress = z.strictObject({ turnNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), done: Count, total: Count })
  .refine(value => value.done <= value.total, 'Completed tasks cannot exceed the total.');
export type DepartmentTurnProgress = z.infer<typeof DepartmentTurnProgress>;
export function defaultDepartmentWorkMode(_key: TemplateKey | null): DepartmentWorkMode {
  throw new Error('Department template work mode is not implemented.');
}
