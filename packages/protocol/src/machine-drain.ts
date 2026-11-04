import { z } from 'zod';

const remaining = { turnsLeft: z.number().int().nonnegative(), partsLeft: z.number().int().nonnegative() };

export const MachineDrain = z.discriminatedUnion('state', [
  z.object({ state: z.literal('waiting'), ...remaining, until: z.iso.datetime() }),
  z.object({ state: z.literal('postponed'), ...remaining, retryAt: z.iso.datetime() }),
  z.object({ state: z.literal('restarting'), since: z.iso.datetime() }),
]);
export type MachineDrain = z.infer<typeof MachineDrain>;
