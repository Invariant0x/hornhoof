import { z } from 'zod';

export const NODE_LOG_BYTES = 16384;
export const NODE_LOG_LINES = 80;
export const NodeLog = z.string().max(NODE_LOG_BYTES)
  .refine(text => new TextEncoder().encode(text).byteLength <= NODE_LOG_BYTES, 'The node log is too large.')
  .refine(text => text.split('\n').length <= NODE_LOG_LINES, 'The node log has too many lines.');

export const NodeStopReason = z.enum(['hornhoof_update', 'node_update', 'program_update', 'stopped', 'server_restart']);
export type NodeStopReason = z.infer<typeof NodeStopReason>;
const ended = { startedAt: z.iso.datetime().nullable(), at: z.iso.datetime().nullable(), log: NodeLog };

/* A missing clean-stop marker proves an unclean exit, not the signal or memory condition that caused it. */
export const NodeExit = z.discriminatedUnion('kind', [
  z.object({ ...ended, kind: z.literal('planned'), reason: NodeStopReason }),
  z.object({ ...ended, kind: z.literal('unplanned'), reason: z.enum(['unclean_exit', 'killed', 'out_of_memory', 'disconnected']) }),
  z.object({ ...ended, kind: z.literal('unknown'), reason: z.literal('unknown') }),
]);
export type NodeExit = z.infer<typeof NodeExit>;
