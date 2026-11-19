import { z } from 'zod';

export const WaitOnInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('employee'), employee: z.uuid() }),
  z.object({ kind: z.literal('external'), event: z.enum(['time', 'ceo', 'machine', 'other']) }),
]);
type WaitOn = z.infer<typeof WaitOnInput>;
export type RecordedWaitOn = WaitOn & { name?: string };
/* operation: what the wait's accountable record keeps it by, the same across a restart. run: the one run whose end ends it. */
export type ExternalWait = { reason: string; since: string; until: string; on?: RecordedWaitOn; operation?: string; run?: string; work?: true };

const moment = z.iso.datetime({ offset: true });
const reference = z.string().trim().min(1).max(200);
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export const WAIT_SOURCE_KINDS = ['after', 'review', 'person', 'run', 'external'] as const;
export const WaitSourceKind = z.enum(WAIT_SOURCE_KINDS);
export type WaitSourceKind = z.infer<typeof WaitSourceKind>;

export type WaitWho = { kind: 'person' | 'agent'; id: string; name: string };
export type WaitFailure = 'machine' | 'expired' | 'run' | 'unavailable';
export type WaitRunError = 'timeout' | 'machine' | 'repository' | 'files' | 'revision' | 'stopped';
export type TaskWaitFact = {
  who: WaitWho | null;
  since: string;
  kind: WaitSourceKind | 'work';
  reason: string | null;
  until?: string;
  nextCheck?: string;
  event?: 'time' | 'ceo';
  failure?: WaitFailure;
  runError?: WaitRunError;
};

export function externalWaitFact(wait: ExternalWait, now: number, observed?: TaskWaitFact): TaskWaitFact {
  if (wait.work) return { kind: 'work', who: observed?.who ?? null, since: wait.since, until: wait.until, nextCheck: wait.until, reason: wait.reason };
  const on = wait.on;
  const event = on?.kind === 'external' ? on.event : undefined;
  const who = observed?.who ?? (on?.kind === 'employee' ? { kind: 'agent', id: on.employee, name: on.name ?? '' } : null);
  const kind = wait.run ? observed?.kind === 'work' ? 'work' : 'run' : observed?.kind ?? 'external';
  const fact = { kind, who, since: wait.since, until: wait.until, reason: kind === 'run' || kind === 'work' ? observed?.reason ?? null : wait.reason };
  if (observed?.failure === 'run') return { ...fact, failure: 'run', ...(observed.runError ? { runError: observed.runError } : {}) };
  if (event === 'machine') return { ...fact, failure: 'machine' };
  if (event === 'time') return { ...fact, event };
  if (Date.parse(wait.until) <= now) return { ...fact, kind: 'external', reason: wait.reason, failure: 'expired' };
  if (event === 'ceo') return { ...fact, kind: 'person', event };
  return fact;
}

export const isPersonWait = (fact: TaskWaitFact): boolean => fact.kind === 'person' && !fact.failure;

/* A record that has come to its end stays, as what happened to the wait. An old wait stays open with what is known of it, no
   date made up for it, until someone gives it an owner and a plan. */
export const WAIT_STATES = ['active', 'resolved', 'cancelled', 'superseded', 'legacy_needs_plan'] as const;
export const WaitState = z.enum(WAIT_STATES);
export type WaitState = z.infer<typeof WaitState>;
export const WAIT_OUTCOMES = ['resolved', 'cancelled', 'superseded'] as const;
export const WaitOutcome = z.enum(WAIT_OUTCOMES);
export type WaitOutcome = z.infer<typeof WaitOutcome>;

/* Each kind of source has its own way of naming one source. It is stable across a restart and never made up by a sweep. */
const SOURCE_KEYS: Record<WaitSourceKind, RegExp> = {
  after: new RegExp(`^task:${UUID}$`),
  review: new RegExp(`^review:${UUID}:(review|security|cleanup):${UUID}:${UUID}$`),
  person: new RegExp(`^(request|question):${UUID}$`),
  run: new RegExp(`^run:${UUID}$`),
  external: new RegExp(`^(wait_for|operation|question):${UUID}$`),
};
export const validSourceKey = (kind: WaitSourceKind, key: string): boolean => SOURCE_KEYS[kind].test(key);
export const signalsOnce = (kind: WaitSourceKind, key: string): boolean => kind === 'external' && key.startsWith('operation:');

/* A real employee or person of the company: a machine, a time or a role is nobody to answer for a wait. Naming one gives it
   no right to change or approve anything. */
export const WaitOwnerBinding = z.union([z.strictObject({ agentId: z.uuid() }), z.strictObject({ personId: z.uuid() })]);
export type WaitOwnerBinding = z.infer<typeof WaitOwnerBinding>;

/* A review goes on at its interval until the source ends. intervalMs null says it has no repeats, which is how a source that
   signals once says it, and only such a source: an external operation has one signal, kept unique by its recovery case. */
export const WaitFinalReview = z.strictObject({ headAgentId: z.uuid(), anchorAt: moment, intervalMs: z.number().int().positive().nullable() });
export type WaitFinalReview = z.infer<typeof WaitFinalReview>;

/* Where a plan's dates come from: a promise someone made, a version of the department's policy, or what the source itself
   says. Never a common deadline, a run's start plus its limit, or the longest a wait_for may last. */
const WaitPlanProvenance = z.strictObject({
  kind: z.enum(['explicit_promise', 'department_policy', 'source_contract']),
  actor: WaitOwnerBinding,
  ref: reference,
  revision: z.number().int().min(0),
  origin: reference,
});

export const WaitPlan = z.strictObject({
  version: z.literal(1),
  ownerDueAt: moment,
  headDueAt: moment,
  decisionDueAt: moment,
  provenance: WaitPlanProvenance,
  finalReview: WaitFinalReview,
}).refine(
  plan => Date.parse(plan.ownerDueAt) <= Date.parse(plan.headDueAt) && Date.parse(plan.headDueAt) <= Date.parse(plan.decisionDueAt),
  'The owner\'s date comes first, then the head\'s, then the decision\'s.',
);
export type WaitPlan = z.infer<typeof WaitPlan>;

/* A run's clocks stand apart, each with its own promise; a wait_for is waiting, or has come back to be looked at. */
const WAIT_STAGES = ['queue', 'host_slot', 'prepare', 'execution', 'retry', 'waiting', 'check_back'] as const;
export const WaitSourceState = z.strictObject({
  stage: z.enum(WAIT_STAGES).optional(),
  nextActionAt: moment.optional(),
  route: z.string().trim().min(1).max(120).optional(),
  /* The one run a wait_for is for: that run's end ends its record, however far its deadline came. */
  run: z.uuid().optional(),
});
export type WaitSourceState = z.infer<typeof WaitSourceState>;

/* The source's own count of its changes. A task's version moves with any comment, and is no part of it. */
const sourceRevision = z.number().int().min(0);
const keyFitsKind = (input: { kind: WaitSourceKind; sourceKey: string }) => validSourceKey(input.kind, input.sourceKey);
const KEY_OF_ANOTHER_KIND = 'This source key does not name a source of this kind.';
const repeatsUnlessOnce = (input: { kind: WaitSourceKind; sourceKey: string; plan: WaitPlan }) => (input.plan.finalReview.intervalMs === null) === signalsOnce(input.kind, input.sourceKey);
const questionRevisionFits = (input: { sourceKey: string; sourceRevision: number }): boolean => !input.sourceKey.startsWith('question:') || input.sourceRevision > 0;
function questionOwnerFits(input: { kind: WaitSourceKind; sourceKey: string; ownerBinding: WaitOwnerBinding }): boolean {
  if (!input.sourceKey.startsWith('question:')) return true;
  return input.kind === 'external' ? 'agentId' in input.ownerBinding : input.kind === 'person' && 'personId' in input.ownerBinding;
}

export const SyncSourceWaits = z.strictObject({
  taskId: z.uuid(),
  kind: WaitSourceKind,
  sourceKey: z.string(),
  sourceRevision,
  ownerBinding: WaitOwnerBinding,
  plan: WaitPlan,
  sourceState: WaitSourceState,
}).refine(keyFitsKind, KEY_OF_ANOTHER_KIND).refine(repeatsUnlessOnce, 'An external operation reviews once, with no repeats; every other source repeats until it ends.')
  .refine(questionRevisionFits, 'A question needs its positive route revision.')
  .refine(questionOwnerFits, 'An internal question has an agent owner; a human question has a person recipient.');
export type SyncSourceWaits = z.infer<typeof SyncSourceWaits>;

export const EndSourceWait = z.strictObject({
  taskId: z.uuid(),
  kind: WaitSourceKind,
  sourceKey: z.string(),
  sourceRevision,
  outcome: WaitOutcome,
  proofRef: reference,
}).refine(keyFitsKind, KEY_OF_ANOTHER_KIND).refine(questionRevisionFits, 'A question needs its positive route revision.');
export type EndSourceWait = z.infer<typeof EndSourceWait>;

export const ReplanWait = z.strictObject({
  waitId: z.uuid(),
  expectedGeneration: z.number().int().positive(),
  ownerBinding: WaitOwnerBinding.optional(),
  plan: WaitPlan.optional(),
  reason: z.string().trim().min(1).max(600),
}).refine(input => Boolean(input.ownerBinding || input.plan), 'Name a new owner or a new plan.');
export type ReplanWait = z.infer<typeof ReplanWait>;

/* What a screen may show of a wait: no source key, proof or route, which can name private work. */
const shownDate = moment.nullable();
export const TaskWaitView = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  kind: WaitSourceKind,
  state: WaitState,
  generation: z.number().int().positive(),
  level: z.number().int().min(0).max(3),
  owner: WaitOwnerBinding.nullable(),
  ownerDueAt: shownDate,
  headDueAt: shownDate,
  decisionDueAt: shownDate,
  nextActionAt: shownDate,
  stage: z.enum(WAIT_STAGES).nullable(),
});
export type TaskWaitView = z.infer<typeof TaskWaitView>;
