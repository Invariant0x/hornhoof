import { z } from 'zod';

const id = z.string().min(1).max(256);
const turnId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.number().int().nonnegative().max(8_640_000_000_000_000);
const details = z.object({
  statusCode: z.number().int().min(100).max(599).optional(),
  requestId: id.nullable().optional(),
  traceId: id.nullable().optional(),
}).readonly();
const error = z.object({
  name: id.optional(), code: id, retryable: z.boolean(), details: details.optional(),
}).readonly();
const nativeRecord = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn.prompt'), agentId: id, turnId: turnId.optional(), promptId: id.optional(), time,
  }).readonly(),
  z.object({
    type: z.literal('turn.ended'), agentId: id, turnId,
    reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
    error: error.optional(), durationMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    traceId: id.optional(), time,
  }).readonly(),
  z.object({ type: z.literal('metadata'), protocol_version: id, created_at: time }).readonly(),
]);

export type NativeRecord = z.infer<typeof nativeRecord>;

/* Pinned 2.4.1 source shape only. This proves neither runtime provenance nor an HH input receipt.
   Keep IDs locally for a future causal join; never forward this object as a diagnostic or wire DTO. */
export function projectNativeRecord(value: unknown): NativeRecord | null {
  const result = nativeRecord.safeParse(value);
  return result.success ? result.data : null;
}
