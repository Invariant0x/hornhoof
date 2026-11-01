import { z } from 'zod';

export const TASK43_CAPABILITY = 'task43_transfer_v1';
export const TASK43_FAILURE_REASONS = [
  'wrong_context',
  'unsupported_node',
  'node_offline',
  'busy',
  'unsafe_path',
  'source_changed',
  'size_mismatch',
  'hash_mismatch',
  'destination_conflict',
  'backpressure',
  'disconnected',
  'timeout',
  'commit_outcome_unknown',
  'io_failed',
] as const;

export const TASK43_TRANSFER_V1 = {
  taskNumber: 56,
  sourceAgentId: 'b8f2e7aa-1fb2-447e-9312-7dc1e12108a6',
  targetAgentId: '100edb09-da27-4868-9646-5c0118b9934e',
  relativeSource: 'task-43-evidence/review-transfer-r1/task43-review-transfer-r1.tgz',
  destinationBasename: 'task43-review-transfer-r1.tgz',
  size: 2012762,
  sha256: 'c92e8a8c418dc7290a4296079e75a131d9a6ea5188a52264cda7267f67fe561c',
  chunkBytes: 32768,
  base64Chars: 43692,
  frameBytes: 49152,
  retainedPayloadBuffersBytes: 524288,
  socketBufferedAmountBytes: 262144,
  totalMs: 60000,
  idleMs: 10000,
  chunks: 62,
  lastChunkBytes: 13914,
} as const;

export type Task43Policy = {
  taskNumber: number;
  sourceAgentId: string;
  targetAgentId: string;
  relativeSource: string;
  destinationBasename: string;
  size: number;
  sha256: string;
  chunkBytes: number;
  base64Chars: number;
  frameBytes: number;
  retainedPayloadBuffersBytes: number;
  socketBufferedAmountBytes: number;
  totalMs: number;
  idleMs: number;
  chunks: number;
  lastChunkBytes: number;
};
export type Task43FailureReason = (typeof TASK43_FAILURE_REASONS)[number];

const Uuid = z.uuid();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/).max(64);
const Utc = z.iso.datetime().max(40);
const FailureReason = z.enum(TASK43_FAILURE_REASONS);
const ids = { requestId: Uuid, attemptId: Uuid };
const context = { ...ids, taskId: Uuid, companyId: Uuid, jobId: Uuid };
const Data = z.string().max(43692).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const frame = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const Task43Invoke = frame({ task: z.literal(56), requestId: Uuid });
export const Task43Prepare = frame({ type: z.literal('task43.prepare'), ...context, role: z.enum(['source', 'target']) });
export const Task43Ready = frame({ type: z.literal('task43.ready'), ...ids, role: z.enum(['source', 'target']), existing: z.enum(['absent', 'matching']) });
export const Task43Read = frame({ type: z.literal('task43.read'), ...ids, offset: z.number().int().min(0).max(2012762) });
export const Task43Chunk = frame({ type: z.literal('task43.chunk'), ...ids, offset: z.number().int().min(0).max(2012762), data: Data });
export const Task43Write = frame({ type: z.literal('task43.write'), ...ids, offset: z.number().int().min(0).max(2012762), data: Data });
export const Task43Ack = frame({ type: z.literal('task43.ack'), ...ids, nextOffset: z.number().int().min(0).max(2012762) });
export const Task43SourceFinish = frame({ type: z.literal('task43.source_finish'), ...ids });
export const Task43SourceVerified = frame({ type: z.literal('task43.source_verified'), ...ids, size: z.number().int().min(0).max(2012762), sha256: Sha256, sourceReadAt: Utc });
export const Task43Verify = frame({ type: z.literal('task43.verify'), ...ids });
export const Task43Verified = frame({ type: z.literal('task43.verified'), ...ids, size: z.number().int().min(0).max(2012762), sha256: Sha256, targetVerifiedAt: Utc });
export const Task43Commit = frame({ type: z.literal('task43.commit'), ...ids });
export const Task43Stored = frame({
  type: z.literal('task43.stored'), ...ids, mode: z.enum(['copied', 'already_present']), size: z.number().int().min(0).max(2012762), sha256: Sha256,
  actualPath: z.string().min(1).max(1024), targetVerifiedAt: Utc, storedAt: Utc,
});
export const Task43Abort = frame({ type: z.literal('task43.abort'), ...ids, reason: FailureReason });
export const Task43Failed = frame({ type: z.literal('task43.failed'), ...ids, reason: FailureReason, mayExist: z.boolean() });

export const Task43NodeMessage = z.discriminatedUnion('type', [Task43Ready, Task43Chunk, Task43Ack, Task43SourceVerified, Task43Verified, Task43Stored, Task43Failed]);
export const Task43ServerMessage = z.discriminatedUnion('type', [Task43Prepare, Task43Read, Task43Write, Task43SourceFinish, Task43Verify, Task43Commit, Task43Abort]);
export type Task43NodeMessage = z.infer<typeof Task43NodeMessage>;
export type Task43ServerMessage = z.infer<typeof Task43ServerMessage>;

export const Task43Receipt = frame({
  schema: z.literal('task43-transfer-v1'),
  ...context,
  taskNumber: z.literal(56),
  sourceAgentId: z.literal(TASK43_TRANSFER_V1.sourceAgentId),
  targetAgentId: z.literal(TASK43_TRANSFER_V1.targetAgentId),
  sourceRelativePath: z.literal(TASK43_TRANSFER_V1.relativeSource),
  destinationBasename: z.literal(TASK43_TRANSFER_V1.destinationBasename),
  actualPath: z.string().min(1).max(1024).nullable(),
  expectedSize: z.literal(TASK43_TRANSFER_V1.size),
  expectedSha256: z.literal(TASK43_TRANSFER_V1.sha256),
  actualSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  actualSha256: Sha256.nullable(),
  sourceReadAt: Utc.nullable(),
  targetVerifiedAt: Utc.nullable(),
  storedAt: Utc.nullable(),
  serverReceivedAt: Utc,
  status: z.enum(['started', 'server_complete', 'failed']),
  delivered: z.literal(false),
  mode: z.union([z.enum(['copied', 'already_present']), z.null()]),
  errorReason: FailureReason.nullable(),
  mayExist: z.boolean(),
}).superRefine((receipt, ctx) => {
  if (receipt.status === 'failed' && !receipt.errorReason) ctx.addIssue({ code: 'custom', message: 'A failed receipt needs a reason.' });
  if (receipt.status !== 'server_complete') return;
  const complete = receipt.actualSize === TASK43_TRANSFER_V1.size && receipt.actualSha256 === TASK43_TRANSFER_V1.sha256 && receipt.actualPath !== null
    && receipt.targetVerifiedAt !== null && receipt.storedAt !== null && receipt.mode !== null && receipt.errorReason === null && receipt.mayExist;
  if (!complete) ctx.addIssue({ code: 'custom', message: 'A complete receipt needs independently observed final metadata.' });
  if (receipt.mode === 'copied' && receipt.sourceReadAt === null) ctx.addIssue({ code: 'custom', message: 'A copied receipt needs its source read time.' });
});
export type Task43Receipt = z.infer<typeof Task43Receipt>;

export function isTask43Type(type: string): boolean {
  return type.startsWith('task43.');
}
