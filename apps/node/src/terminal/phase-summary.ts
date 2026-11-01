import { z } from 'zod';
import { redact } from '../redact.js';
import { PHASE_RECORDS } from './phase.js';

export const PHASES = ['launch', 'ready', 'accept', 'done'] as const;
export const FINISHES = ['ready_deadline', 'ready_signed_out', 'ready_pane_dead', 'ready_query_failed', 'ready_unknown', 'accept_deadline', 'wire_completed', 'hook_completed', 'done_completed', 'wire_failed', 'pane_dead', 'pane_query_failed', 'pane_unknown', 'cancelled', 'start_only', 'superseded', 'host_exception', 'runner_exception', 'runner_result'] as const;
export const PERSIST_CODES = ['ok', 'not_saved', 'identity_unavailable', 'unsafe_path', 'unsupported_fs', 'io_error', 'partial_write', 'conflict', 'size_limit', 'record_limit'] as const;
export type Phase = typeof PHASES[number];
export type Finish = typeof FINISHES[number];
export type PersistCode = typeof PERSIST_CODES[number];

const Summary = z.object({
  attemptId: z.uuid().nullable(), seq: z.number().int().min(0).max(PHASE_RECORDS), phase: z.enum(PHASES),
  finish: z.enum(FINISHES).nullable(), durable: z.boolean(), code: z.enum(PERSIST_CODES),
});
export type PhaseSummary = z.infer<typeof Summary>;

/* Project only known fields. Hide the complete ASCII line before applying its byte bound. */
export function phaseLine(value: unknown, secrets: string[]): string | undefined {
  const parsed = Summary.safeParse(value);
  if (!parsed.success) return undefined;
  const item = parsed.data;
  const text = `hh-terminal-phase-v1 attempt=${item.attemptId ?? 'unknown'} seq=${item.seq} phase=${item.phase} finish=${item.finish ?? 'unknown'} durable=${item.durable} code=${item.code}`;
  return Buffer.from(redact(text, secrets)).subarray(0, 160).toString('ascii');
}
