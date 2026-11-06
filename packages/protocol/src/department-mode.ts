import { z } from 'zod';
import type { TemplateKey } from './index.js';

/* Refusing scaffold until the targeted RED is recorded. Shared index/template
   edits wait for the previous schema writer's published checkpoint. */
export const DepartmentWorkMode = z.never();
export type DepartmentWorkMode = z.infer<typeof DepartmentWorkMode>;
export const DepartmentWorkModeChange = z.never();
export const DepartmentTurnProgress = z.never();
export function defaultDepartmentWorkMode(_key: TemplateKey | null): DepartmentWorkMode {
  throw new Error('Department template work mode is not implemented.');
}
