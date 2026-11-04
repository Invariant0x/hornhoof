import { z } from 'zod';

export const WaitOnInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('employee'), employee: z.uuid() }),
  z.object({ kind: z.literal('external'), event: z.enum(['time', 'ceo', 'machine', 'other']) }),
]);
export type WaitOn = z.infer<typeof WaitOnInput>;
export type RecordedWaitOn = WaitOn & { name?: string };
export type ExternalWait = { reason: string; since: string; until: string; on?: RecordedWaitOn };
