import { z } from 'zod';

const remaining = { turnsLeft: z.number().int().nonnegative(), partsLeft: z.number().int().nonnegative() };

/* waiting: the node takes no new turn and waits, however long, for the work that runs on it, since it was first asked.
   restarting: its work ended and the updater replaces it, since then. */
export const MachineDrain = z.discriminatedUnion('state', [
  z.object({ state: z.literal('waiting'), ...remaining, since: z.iso.datetime() }),
  z.object({ state: z.literal('restarting'), since: z.iso.datetime() }),
]);
export type MachineDrain = z.infer<typeof MachineDrain>;

/* One node's wait for an update, as the update screen shows it. node: builtin, or the node's id. provider and hostname
   are empty for the built-in node. work: the turns it waits for, of the company that reads this only. */
export const NodeWait = z.object({
  node: z.string(),
  provider: z.string().nullable(),
  hostname: z.string().nullable(),
  drain: MachineDrain,
  work: z.array(z.object({ agent: z.string(), task: z.number().int().nullable() })),
});
export type NodeWait = z.infer<typeof NodeWait>;
