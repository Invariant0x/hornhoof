import { ASSIGNMENT_RECEIPT_MS, FIRST_ACTIVITY_MS, QUESTION_WAIT_MS, STARTUP_EXIT_MS, type OperatorEvidence, type OperatorQuestion } from '@hornhoof/protocol/program-operator';

type DeliveryFact = Extract<OperatorEvidence, { type: 'program.delivery' }>;
type Needed = Extract<OperatorEvidence, { type: 'program.operator_needed' }>;

/* Server authorization binds these facts to one program; program clocks and receipts prove the threshold. */
export function qualifyingReasons(facts: readonly OperatorEvidence[]): Needed[] {
  const deliveries = facts.filter((fact): fact is DeliveryFact => fact.type === 'program.delivery');
  const signals = facts.filter((fact): fact is Needed => fact.type === 'program.operator_needed');
  const seen = new Set<string>();
  return signals.filter(signal => {
    const valid = qualifies(facts, deliveries, signal);
    const key = `${signal.instance}:${signal.reason}:${signal.evidenceKey}`;
    if (!valid || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function qualifies(facts: readonly OperatorEvidence[], deliveries: readonly DeliveryFact[], signal: Needed): boolean {
  if (signal.reason === 'startup_exit') return startupExit(facts, signal);
  if (signal.reason !== 'question_waiting') return deliveryAlarm(deliveries, signal);
  const question = currentOperatorQuestion(facts, signal.instance, signal.jobId);
  return Boolean(question && question.kind !== 'work' && question.id === signal.questionId && question.id === signal.evidenceKey && signal.elapsedMs >= QUESTION_WAIT_MS);
}

export function currentOperatorQuestion(facts: readonly OperatorEvidence[], instance: string, jobId: string | null): OperatorQuestion | null {
  let current: OperatorQuestion | null = null;
  for (const fact of facts.filter(f => f.instance === instance && f.jobId === jobId).slice().sort((a, b) => a.ordinal - b.ordinal)) {
    if (fact.type === 'program.question') current = fact.phase === 'asked' ? fact.question : null;
    if (fact.type === 'program.delivery' && fact.phase === 'activity') current = null;
  }
  return current;
}

function deliveryAlarm(facts: readonly DeliveryFact[], signal: Needed): boolean {
  const delivery = facts.filter(fact => fact.instance === signal.instance && fact.jobId === signal.jobId && fact.deliveryId === signal.deliveryId);
  const attempt = delivery.find(fact => fact.phase === 'attempt' && fact.kind === 'assignment');
  if (!attempt || signal.evidenceKey !== attempt.deliveryId || delivery.some(fact => fact.phase === 'cancelled')) return false;
  const receipt = delivery.filter(fact => fact.phase === 'queued' || fact.phase === 'taken').sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
  return deliveryThreshold(delivery, signal, receipt);
}

function deliveryThreshold(delivery: readonly DeliveryFact[], signal: Needed, receipt: DeliveryFact | undefined): boolean {
  if (signal.reason === 'assignment_unrecorded') return !receipt && signal.elapsedMs >= ASSIGNMENT_RECEIPT_MS;
  if (signal.reason !== 'recorded_no_activity' || !receipt) return false;
  return signal.elapsedMs - receipt.elapsedMs >= FIRST_ACTIVITY_MS && !delivery.some(fact => fact.phase === 'activity');
}

function startupExit(facts: readonly OperatorEvidence[], signal: Needed): boolean {
  if (!signal.exit || signal.evidenceKey !== signal.instance || signal.sinceLaunchMs === null || signal.sinceLaunchMs > STARTUP_EXIT_MS) return false;
  const instance = facts.filter(fact => fact.instance === signal.instance);
  const launched = instance.some(fact => fact.type === 'program.launch' && fact.phase === 'attempt');
  return launched && !instance.some(fact => fact.type === 'program.delivery' && fact.phase === 'activity');
}

type LiveOutcome = { id: string; ordinal: number; instance: string; outcome: 'pending' | 'taken' | 'not_taken' | 'cancelled' };

/* Unknown outcomes split a known run. Only actual uptake resets an incident already reported for that run. */
export function liveFailureSignals<T extends LiveOutcome>(deliveries: readonly T[], consumed: ReadonlySet<string> = new Set()): T[] {
  const signals: T[] = [];
  let segment: T[] = [];
  for (const delivery of deliveries.slice().sort((a, b) => a.ordinal - b.ordinal)) {
    if (delivery.outcome === 'taken') {
      appendLiveSignal(signals, segment, consumed);
      segment = [];
    } else segment.push(delivery);
  }
  appendLiveSignal(signals, segment, consumed);
  return signals;
}

function appendLiveSignal<T extends LiveOutcome>(signals: T[], segment: readonly T[], consumed: ReadonlySet<string>): void {
  const previous = segment.find(delivery => delivery.outcome === 'not_taken' && consumed.has(delivery.id));
  const signal = previous ?? firstFailedRun(segment);
  if (signal) signals.push(signal);
}

function firstFailedRun<T extends LiveOutcome>(segment: readonly T[]): T | undefined {
  let streak = 0;
  for (const delivery of segment) {
    if (delivery.outcome === 'pending') streak = 0;
    if (delivery.outcome === 'not_taken' && ++streak === 3) return delivery;
  }
}
