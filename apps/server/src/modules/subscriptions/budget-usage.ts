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

function boundedWindows(windows: WindowSample[]): WindowSample[] {
  if (windows.length <= 8) return windows;
  return [...windows].sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1)).slice(0, 8);
}

function partialAuthority(before: BudgetUsage, windows: WindowSample[]): string[] | null {
  const names = before.authoritativeNames;
  if (!names || windows.length > 8) return null;
  return windows.every(w => names.includes(w.name)) ? names : null;
}

function reportedStatus(before: BudgetUsage, observation: Extract<UsageObservation, { outcome: 'success' }>, complete: boolean, receivedAt: string): Partial<BudgetUsage> {
  if (observation.status !== 'rejected' && !complete && before.providerStatus === 'rejected') return {};
  return { providerStatus: observation.status, statusSampledAt: observation.sampledAt, statusReceivedAt: receivedAt };
}

function acceptedUsage(before: BudgetUsage, observation: Extract<UsageObservation, { outcome: 'success' }>, receivedAt: string): BudgetUsage {
  const collected = collectedWindows(observation, receivedAt);
  const complete = observation.complete && observation.source === 'usage_fetch' && observation.windows.length > 0;
  if (complete) return { ...before, windows: collected, authoritativeNames: collected.map(w => w.name), lastCompleteSampledAt: observation.sampledAt, lastCompleteReceivedAt: receivedAt, ...reportedStatus(before, observation, true, receivedAt) };
  const windows = partialWindows(before.windows, collected);
  return { ...before, windows: boundedWindows(windows), authoritativeNames: partialAuthority(before, windows), ...reportedStatus(before, observation, false, receivedAt) };
}

/* Eligibility is decided once by observeQuota. This projector never grants a sample its own authority. */
export function projectBudgetUsage(previous: BudgetUsage | undefined, observation: UsageObservation, accepted: boolean, receivedAt: string): BudgetUsage {
  const before = previous ?? emptyUsage();
  const refresh = { ...before, lastRefreshReceivedAt: receivedAt, lastRefreshOutcome: accepted ? 'success' as const : 'unavailable' as const };
  if (!accepted || observation.outcome !== 'success') return refresh;
  return acceptedUsage(refresh, observation, receivedAt);
}

export function projectBudgetRefusal(previous: BudgetUsage | undefined, refusal: QuotaRefusal, receivedAt: string): BudgetUsage {
  return { ...(previous ?? emptyUsage()), providerStatus: 'rejected', statusSampledAt: refusal.observedAt, statusReceivedAt: receivedAt };
}
