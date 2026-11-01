import type { BudgetUsage, QuotaRefusal, UsageObservation } from '@hornhoof/protocol';

export const MAX_USAGE_AGE_MS = 600_000;
export type UsageConnection = { epoch: string; issuedAt: number; current(): boolean };
type Stamp = { epoch: string | null; seq: number; at: string };
export type QuotaState = { latest: Stamp | null; blocked: Stamp | null; recovered: Stamp | null; usage?: BudgetUsage };
const empty = (): QuotaState => ({ latest: null, blocked: null, recovered: null });

export function quotaBlocked(state: QuotaState | null | undefined): boolean {
  return Boolean(state?.blocked);
}

function newer(stamp: Stamp, before: Stamp | null): boolean {
  if (!before) return true;
  const difference = Date.parse(stamp.at) - Date.parse(before.at);
  if (difference !== 0) return difference > 0;
  return stamp.epoch === before.epoch && stamp.seq > before.seq;
}

type SuccessfulObservation = Extract<UsageObservation, { outcome: 'success' }>;

function fresh(observation: UsageObservation, connection: UsageConnection, now: number): observation is SuccessfulObservation {
  if (observation.outcome !== 'success' || observation.delivery !== 'live') return false;
  const sampled = Date.parse(observation.sampledAt);
  return connection.current() && observation.epoch === connection.epoch && sampled >= connection.issuedAt && sampled <= now && now - sampled < MAX_USAGE_AGE_MS;
}

function ordered(state: QuotaState, observation: SuccessfulObservation): boolean {
  if (!state.latest) return true;
  if (state.latest.epoch === observation.epoch && observation.seq <= state.latest.seq) return false;
  return Date.parse(observation.sampledAt) >= Date.parse(state.latest.at);
}

function recovery(observation: SuccessfulObservation): boolean {
  return observation.source === 'usage_fetch' && observation.complete && observation.status === 'allowed' && observation.windows.length > 0 && observation.windows.every(w => w.utilization !== null && w.utilization < 1);
}

/* Only an actual fresh collection can change admission; receipt and reset hints do not sample usage. */
export function observeQuota(previous: QuotaState | null, observation: UsageObservation, connection: UsageConnection, now: number): QuotaState | null {
  const state = previous ?? empty();
  if (!fresh(observation, connection, now) || !ordered(state, observation)) return previous;
  return advanceQuota(state, observation);
}

function advanceQuota(state: QuotaState, observation: SuccessfulObservation): QuotaState {
  const stamp = { epoch: observation.epoch, seq: observation.seq, at: observation.sampledAt };
  const next = { ...state, latest: stamp };
  if (observation.status === 'rejected' || observation.windows.some(w => (w.utilization ?? 0) >= 1)) return { ...next, blocked: newer(stamp, state.blocked) ? stamp : state.blocked };
  if (recovery(observation) && newer(stamp, state.blocked)) return { ...next, blocked: null, recovered: stamp };
  return next;
}

/* A verified refusal can preserve a conservative hold, including offline delivery, but cannot grant permission. */
export function refuseQuota(previous: QuotaState | null, refusal: QuotaRefusal): QuotaState {
  const state = previous ?? empty();
  const stamp = { epoch: refusal.epoch, seq: refusal.seq, at: refusal.observedAt };
  if (!newer(stamp, state.recovered) || !newer(stamp, state.blocked)) return state;
  return { ...state, blocked: stamp };
}

type Completion = { ok: boolean; error: string | null; sessionId: string | null };
type CurrentJob = { status: string; kind: string; startedAt: Date | null };

function failedConversation(job: CurrentJob, completion: Completion): boolean {
  return !completion.ok && completion.error === 'agent_failed' && job.status === 'running' && job.kind === 'conversation';
}

export function currentRefusal(refusal: QuotaRefusal | undefined, job: CurrentJob, completion: Completion, provider: string, now: number): QuotaRefusal | null {
  if (!refusal || !job.startedAt) return null;
  if (!failedConversation(job, completion)) return null;
  if (refusal.provider !== provider || refusal.native.sessionId !== completion.sessionId) return null;
  const observed = Date.parse(refusal.observedAt);
  return observed >= job.startedAt.getTime() && observed <= now ? refusal : null;
}
