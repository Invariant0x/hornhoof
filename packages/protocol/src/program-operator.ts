import { z } from 'zod';
import type { NodeMessage, ServerMessage } from './index.js';

export const PROGRAM_OPERATOR_ROLE = 'OPS-PROGRAM';
export const OPERATOR_CASE_MS = 600_000;
export const ASSIGNMENT_RECEIPT_MS = 60_000;
export const FIRST_ACTIVITY_MS = 300_000;
export const STARTUP_EXIT_MS = 60_000;
export const QUESTION_WAIT_MS = 30_000;
export const OPERATOR_SNAPSHOT_MS = 30_000;
export const OPERATOR_CELLS_BYTES = 65_536;
export const OPERATOR_PICTURE_BYTES = 1_048_576;
/* What one look at an employee's program lets its viewer press and type, at most. */
export const PROGRAM_INPUT_KEYS = 32;
export const PROGRAM_INPUT_TEXT = 4000;

/* A key by its tmux name, with Ctrl, Alt or Shift before it: Enter, Escape, C-u, M-b, S-Tab, F5, a letter or a digit. Nothing
   else is a key, so no word can reach tmux as one of its own options. */
const KEY_NAMES = 'Enter|Escape|Tab|BTab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|PPage|NPage|DC|IC|F(?:[1-9]|1[0-2])|[A-Za-z0-9]';
export const ProgramKey = z.string().regex(new RegExp(`^(?:[CMS]-)*(?:${KEY_NAMES})$`));
export type ProgramKey = z.infer<typeof ProgramKey>;
export const OperatorReason = z.enum(['assignment_unrecorded', 'recorded_no_activity', 'live_words_not_taken', 'startup_exit', 'question_waiting']);
export type OperatorReason = z.infer<typeof OperatorReason>;
export const OperatorError = z.enum(['operator_forbidden', 'program_busy', 'input_not_proven', 'snapshot_stale', 'node_unavailable', 'no_program', 'protected_screen', 'action_unknown']);
export type OperatorError = z.infer<typeof OperatorError>;
export const OperatorDelivery = z.object({ id: z.uuid(), ordinal: z.number().int().positive() }).strict();
export type OperatorDelivery = z.infer<typeof OperatorDelivery>;
const OperatorDeliveryPhase = z.enum(['attempt', 'queued', 'taken', 'activity', 'not_taken', 'cancelled']);
type OperatorDeliveryPhase = z.infer<typeof OperatorDeliveryPhase>;

const count = z.number().int().nonnegative();
const opaque = z.string().min(16).max(128);
const identity = { agentKey: z.uuid(), jobId: z.uuid().nullable(), instance: z.uuid() };
const evidence = { ...identity, evidenceId: z.uuid(), ordinal: count };
export const OperatorQuestion = z.object({ id: z.uuid(), kind: z.enum(['permission', 'protected', 'work']), tool: z.string().max(100).nullable(), text: z.string().max(4096), callId: z.string().max(128).nullable() }).strict();
export type OperatorQuestion = z.infer<typeof OperatorQuestion>;
const OperatorExit = z.object({ code: z.number().int().nullable(), signal: z.string().max(40).nullable() }).strict();
const screenCells = { cols: z.number().int().min(1).max(512), rows: z.number().int().min(1).max(256), cells: z.string().max(OPERATOR_CELLS_BYTES).refine(value => new TextEncoder().encode(value).length <= OPERATOR_CELLS_BYTES) };
export const OperatorInputLine = z.enum(['empty', 'text', 'unknown']);
/* What the input row holds: nothing, only Hornhoof's own words that never went, anyone else's words, or what nobody can read. */
export const ProgramInputLine = z.enum(['empty', 'hornhoof', 'words', 'unknown']);
export type ProgramInputLine = z.infer<typeof ProgramInputLine>;
export type OperatorInputLine = z.infer<typeof OperatorInputLine>;
/* What the node saw as it stopped waiting: whether the program's input line held text, and its screen, if it could look. */
export const OperatorCheck = z.object({ input: OperatorInputLine, screen: z.object(screenCells).strict().nullable() }).strict();
export type OperatorCheck = z.infer<typeof OperatorCheck>;

const OperatorNodeMessages = [
  z.object({ type: z.literal('program.delivery'), ...evidence, deliveryId: z.uuid(), deliveryOrdinal: z.number().int().positive(), kind: z.enum(['assignment', 'live']), phase: OperatorDeliveryPhase, elapsedMs: count, wordsDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal('program.launch'), ...evidence, phase: z.enum(['attempt', 'started', 'failed']), elapsedMs: count }).strict(),
  z.object({ type: z.literal('program.operator_needed'), ...evidence, reason: OperatorReason, deliveryId: z.uuid().nullable(), questionId: z.uuid().nullable().optional(), evidenceKey: z.string().min(1).max(128), elapsedMs: count, sinceLaunchMs: count.nullable(), exit: OperatorExit.nullable(), check: OperatorCheck.optional() }).strict().refine(frame => frame.reason !== 'question_waiting' || Boolean(frame.questionId && frame.evidenceKey === frame.questionId)),
  z.object({ type: z.literal('program.question'), ...evidence, question: OperatorQuestion, questionOrdinal: z.number().int().positive(), phase: z.enum(['asked', 'cleared']), elapsedMs: count }).strict(),
  /* An employee's program as it stands: its screen with only the values of secrets masked, and what Hornhoof knows of it. */
  z.object({ type: z.literal('program.view'), agentKey: z.uuid(), request: z.uuid(), result: z.enum(['ok', 'refused']), reason: OperatorError.nullable(), jobId: z.uuid().nullable(), instance: z.uuid().nullable(), snapshot: opaque.nullable(), state: z.enum(['working', 'idle', 'gone']), completion: z.string().regex(/^[a-f0-9]{64}$/).optional(), tool: z.string().max(100).nullable(), question: OperatorQuestion.nullable(), input: ProgramInputLine, undelivered: z.boolean(), ...screenCells }).strict(),
  /* With the turn, program and question the input went into, and the text and reason masked with the node's secrets. */
  z.object({ type: z.literal('program.input_result'), agentKey: z.uuid(), action: z.uuid(), result: z.enum(['applied', 'refused', 'unknown']), reason: OperatorError.nullable(), jobId: z.uuid().nullable(), instance: z.uuid().nullable(), question: OperatorQuestion.nullable(), text: z.string().max(PROGRAM_INPUT_TEXT).nullable(), auditReason: z.string().max(1000) }).strict(),
  z.object({ type: z.literal('program.recovery_ready'), ...evidence, case: z.uuid(), owner: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('program.recovery_state'), ...identity, request: z.uuid(), program: z.enum(['here', 'gone']), current: z.uuid().nullable(), generation: count, input: ProgramInputLine, wait: OperatorQuestion.shape.kind.nullable(), runningTool: z.boolean(), retrying: z.boolean(), busy: z.boolean() }).strict(),
] as const;

export const OperatorNodeMessage = z.discriminatedUnion('type', OperatorNodeMessages);
export type OperatorNodeMessage = z.infer<typeof OperatorNodeMessage>;
export type OperatorEvidence = Extract<OperatorNodeMessage, { evidenceId: string }>;
export type ProgramView = Extract<OperatorNodeMessage, { type: 'program.view' }>;
export type ProgramInputResult = Extract<OperatorNodeMessage, { type: 'program.input_result' }>;
export type OperatorRecoveryState = Extract<OperatorNodeMessage, { type: 'program.recovery_state' }>;

const OperatorServerMessages = [
  z.object({ type: z.literal('program.view_get'), agentKey: z.uuid(), request: z.uuid() }).strict(),
  z.object({ type: z.literal('program.recovery_state_get'), ...identity, request: z.uuid(), case: z.uuid() }).strict(),
  /* Text goes in first, as a paste, then the keys one after another, into the program the snapshot showed. */
  z.object({ type: z.literal('program.input_send'), agentKey: z.uuid(), action: z.uuid(), snapshot: opaque, keys: z.array(ProgramKey).max(PROGRAM_INPUT_KEYS), text: z.string().min(1).max(PROGRAM_INPUT_TEXT).nullable(), auditReason: z.string().trim().min(1).max(1000) }).strict().refine(frame => frame.keys.length > 0 || frame.text !== null),
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
