import { z } from 'zod';
import type { NodeMessage, ServerMessage } from './index.js';

export const PROGRAM_OPERATOR_ROLE = 'OPS-PROGRAM';
export const OPERATOR_CASE_MS = 600_000;
export const ASSIGNMENT_RECEIPT_MS = 60_000;
export const FIRST_ACTIVITY_MS = 300_000;
export const STARTUP_EXIT_MS = 60_000;
export const QUESTION_WAIT_MS = 30_000;
export const OPERATOR_SNAPSHOT_MS = 30_000;
export const OPERATOR_KEY_MS = 2000;
export const OPERATOR_PROTECTED_SCREEN = 'Protected program screen [hidden]. Only the subscription owner may respond.';
export const OPERATOR_MAX_KEYS = 20;
export const OPERATOR_CELLS_BYTES = 65_536;
export const OPERATOR_PICTURE_BYTES = 1_048_576;

export const OperatorKey = z.enum(['Enter', 'Up', 'Down', 'Left', 'Right', 'Tab']);
export type OperatorKey = z.infer<typeof OperatorKey>;
export const OperatorReason = z.enum(['assignment_unrecorded', 'recorded_no_activity', 'live_words_not_taken', 'startup_exit', 'question_waiting']);
export type OperatorReason = z.infer<typeof OperatorReason>;
export const OperatorError = z.enum(['operator_forbidden', 'case_closed', 'program_busy', 'input_not_proven', 'snapshot_stale', 'node_unavailable', 'unsupported_node', 'no_program', 'protected_screen', 'action_unknown']);
export type OperatorError = z.infer<typeof OperatorError>;
export const OperatorDelivery = z.object({ id: z.uuid(), ordinal: z.number().int().positive() }).strict();
export type OperatorDelivery = z.infer<typeof OperatorDelivery>;
export const OperatorDeliveryPhase = z.enum(['attempt', 'queued', 'taken', 'activity', 'not_taken', 'cancelled']);
export type OperatorDeliveryPhase = z.infer<typeof OperatorDeliveryPhase>;

const count = z.number().int().nonnegative();
const opaque = z.string().min(16).max(128);
const identity = { agentKey: z.uuid(), jobId: z.uuid().nullable(), instance: z.uuid() };
const evidence = { ...identity, evidenceId: z.uuid(), ordinal: count };
export const OperatorQuestion = z.object({ id: z.uuid(), kind: z.enum(['permission', 'menu', 'protected', 'work', 'unknown']), tool: z.string().max(100).nullable(), text: z.string().max(4096), callId: z.string().max(128).nullable() }).strict();
export type OperatorQuestion = z.infer<typeof OperatorQuestion>;
export const OperatorExit = z.object({ code: z.number().int().nullable(), signal: z.string().max(40).nullable() }).strict();

export const OperatorNodeMessages = [
  z.object({ type: z.literal('program.delivery'), ...evidence, deliveryId: z.uuid(), deliveryOrdinal: z.number().int().positive(), kind: z.enum(['assignment', 'live']), phase: OperatorDeliveryPhase, elapsedMs: count, wordsDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal('program.launch'), ...evidence, phase: z.enum(['attempt', 'started', 'failed']), elapsedMs: count }).strict(),
  z.object({ type: z.literal('program.operator_needed'), ...evidence, reason: OperatorReason, deliveryId: z.uuid().nullable(), questionId: z.uuid().nullable().optional(), evidenceKey: z.string().min(1).max(128), elapsedMs: count, sinceLaunchMs: count.nullable(), exit: OperatorExit.nullable() }).strict().refine(frame => frame.reason !== 'question_waiting' || Boolean(frame.questionId && frame.evidenceKey === frame.questionId)),
  z.object({ type: z.literal('program.question'), ...evidence, question: OperatorQuestion, questionOrdinal: z.number().int().positive(), phase: z.enum(['asked', 'cleared']), elapsedMs: count }).strict(),
  z.object({ type: z.literal('program.screen'), ...identity, request: z.uuid(), result: z.enum(['ok', 'refused']), reason: OperatorError.nullable(), snapshot: opaque.nullable(), generation: count, state: z.enum(['pre_work', 'working', 'awaiting_input', 'gone', 'unknown']), keysAllowed: z.boolean(), protected: z.boolean(), cols: z.number().int().min(1).max(512), rows: z.number().int().min(1).max(256), cells: z.string().max(OPERATOR_CELLS_BYTES).refine(value => new TextEncoder().encode(value).length <= OPERATOR_CELLS_BYTES) }).strict(),
  z.object({ type: z.literal('program.key_result'), ...identity, action: z.uuid(), result: z.enum(['applied', 'refused', 'unknown']), reason: OperatorError.nullable() }).strict(),
  z.object({ type: z.literal('program.key_prepared'), ...identity, action: z.uuid(), result: z.enum(['ok', 'refused']), reason: OperatorError.nullable(), lease: z.uuid().nullable() }).strict(),
  z.object({ type: z.literal('program.recovery_ready'), ...evidence, case: z.uuid() }).strict(),
] as const;

export const OperatorNodeMessage = z.discriminatedUnion('type', OperatorNodeMessages);
export type OperatorNodeMessage = z.infer<typeof OperatorNodeMessage>;
export type OperatorEvidence = Extract<OperatorNodeMessage, { evidenceId: string }>;
export type OperatorScreen = Extract<OperatorNodeMessage, { type: 'program.screen' }>;
export type OperatorKeyResult = Extract<OperatorNodeMessage, { type: 'program.key_result' }>;
export type OperatorKeyPrepared = Extract<OperatorNodeMessage, { type: 'program.key_prepared' }>;

const keyInput = { ...identity, case: z.uuid(), capability: opaque, snapshot: opaque, generation: count, action: z.uuid(), key: OperatorKey };

export const OperatorServerMessages = [
  z.object({ type: z.literal('program.screen_get'), ...identity, request: z.uuid(), case: z.uuid(), capability: opaque }).strict(),
  z.object({ type: z.literal('program.key_prepare'), ...keyInput }).strict(),
  z.object({ type: z.literal('program.key_send'), ...keyInput, lease: z.uuid(), withinMs: z.number().int().min(1).max(OPERATOR_KEY_MS).optional() }).strict(),
  z.object({ type: z.literal('program.operator_case'), ...identity, case: z.uuid(), capability: opaque, disposition: z.enum(['open', 'revoke']), remainingMs: count.max(OPERATOR_CASE_MS), revision: count, readOnly: z.boolean().optional(), reason: OperatorReason.optional(), questionId: z.uuid().nullable().optional(), closedBecause: z.string().min(1).max(100).optional() }).strict(),
  z.object({ type: z.literal('program.evidence_ack'), evidenceId: z.uuid() }).strict(),
] as const;

export const OperatorServerMessage = z.discriminatedUnion('type', OperatorServerMessages);
export type OperatorServerMessage = z.infer<typeof OperatorServerMessage>;

/* Additive metadata is validated independently of the older transport schemas. */
export const OperatorDeliveryMetadata = z.object({ operatorDelivery: OperatorDelivery.optional(), operatorSourceDelivery: OperatorDelivery.optional() });
type DeliveryMetadata = z.infer<typeof OperatorDeliveryMetadata>;
export type ProgramNodeMessage = Exclude<NodeMessage, { type: 'hello' | 'agent.unheard' }>
  | (Extract<NodeMessage, { type: 'hello' }> & { programOperatorV1?: boolean })
  | (Extract<NodeMessage, { type: 'agent.unheard' }> & DeliveryMetadata)
  | OperatorNodeMessage;
export type ProgramServerMessage = Exclude<ServerMessage, { type: 'job.run' | 'agent.say' }>
  | (Extract<ServerMessage, { type: 'job.run' | 'agent.say' }> & DeliveryMetadata)
  | OperatorServerMessage;
