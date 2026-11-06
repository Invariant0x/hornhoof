import { z } from 'zod';

export const HandoffMessage = z.never();
export type HandoffMessage = z.infer<typeof HandoffMessage>;
export const HandoffControlMessage = z.never();
export type HandoffControlMessage = z.infer<typeof HandoffControlMessage>;
export const HandoffAssignment = z.never();
export type HandoffAssignment = z.infer<typeof HandoffAssignment>;
export const ResetSource = z.never();
export type ResetSource = z.infer<typeof ResetSource>;
