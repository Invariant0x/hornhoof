import { z } from 'zod';

/* Shared by work files and declared test diagnostics; neither path raises the existing quotas. */
export const MAX_RUN_FILES = 20;
export const RUN_FILE_BYTES = 50 * 1024 * 1024;
export const RunFile = z.string().min(1).max(200)
  .refine(n => !/[\/\\\u0000-\u001f\u007f]/.test(n) && n !== '.' && n !== '..', 'Not a plain file name.');
