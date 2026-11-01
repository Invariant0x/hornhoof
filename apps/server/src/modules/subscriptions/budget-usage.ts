import type { BudgetUsage, QuotaRefusal, UsageObservation, WindowSample } from '@hornhoof/protocol';

function emptyUsage(): BudgetUsage {
  return { windows: [], authoritativeNames: null, lastCompleteSampledAt: null, lastCompleteReceivedAt: null, lastRefreshReceivedAt: null, lastRefreshOutcome: 'unavailable', providerStatus: null, statusSampledAt: null, statusReceivedAt: null };
}

function collectedWindows(observation: Extract<UsageObservation, { outcome: 'success' }>, receivedAt: string): WindowSample[] {
  return observation.windows.map(w => ({ ...w, sampledAt: observation.sampledAt, receivedAt, source: observation.source, epoch: observation.epoch, seq: observation.seq, delivery: observation.delivery, admissionEligible: true }));
}

function retainRestriction(previous: WindowSample | undefined, next: WindowSample): WindowSample {
  if (previous?.utilization === undefined || previous.utilization === null) return next;
  /* A partial decrease cannot restore permission for any configured threshold. Keep its original evidence. */
  return next.utilization !== null && next.utilization >= previous.utilization ? next : previous;
}

function partialWindows(previous: WindowSample[], collected: WindowSample[]): WindowSample[] {
  const windows = new Map(previous.map(w => [w.name, w]));
  for (const next of collected) windows.set(next.name, retainRestriction(windows.get(next.name), next));
  return [...windows.values()];
}

/* Eligibility is decided once by observeQuota. This projector never grants a sample its own authority. */
export function projectBudgetUsage(previous: BudgetUsage | undefined, observation: UsageObservation, accepted: boolean, receivedAt: string): BudgetUsage {
  const before = previous ?? emptyUsage();
  const refresh = { ...before, lastRefreshReceivedAt: receivedAt, lastRefreshOutcome: accepted ? 'success' as const : 'unavailable' as const };
  if (!accepted || observation.outcome !== 'success') return refresh;
  const complete = observation.complete && observation.source === 'usage_fetch' && observation.windows.length > 0;
  const collected = collectedWindows(observation, receivedAt);
  const windows = complete ? collected : partialWindows(before.windows, collected);
  const status = observation.status === 'rejected' || complete || before.providerStatus !== 'rejected';
  const names = complete ? windows.map(w => w.name) : before.authoritativeNames;
  return {
    ...refresh,
    windows: windows.slice(0, 8),
    authoritativeNames: windows.length <= 8 ? names : null,
    lastCompleteSampledAt: complete ? observation.sampledAt : before.lastCompleteSampledAt,
    lastCompleteReceivedAt: complete ? receivedAt : before.lastCompleteReceivedAt,
    ...(status ? { providerStatus: observation.status, statusSampledAt: observation.sampledAt, statusReceivedAt: receivedAt } : {}),
  };
}

export function projectBudgetRefusal(previous: BudgetUsage | undefined, refusal: QuotaRefusal, receivedAt: string): BudgetUsage {
  return { ...(previous ?? emptyUsage()), providerStatus: 'rejected', statusSampledAt: refusal.observedAt, statusReceivedAt: receivedAt };
}
