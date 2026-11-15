import { z } from 'zod';

/* What a department's open turn holds for its next release, counted as its viewer may see. It confers no ownership and shows
   no unfiltered task totals. */
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DepartmentTurnProgress = z.strictObject({ turnNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), done: Count, total: Count })
  .refine(value => value.done <= value.total, 'Completed tasks cannot exceed the total.');
export type DepartmentTurnProgress = z.infer<typeof DepartmentTurnProgress>;
