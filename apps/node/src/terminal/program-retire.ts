/* When a program may go, and what its going answers. It goes only when idle: its turn ended with its result, no writer is at
   work and nothing of anyone's is left in it. Nothing here stops a program that works: no key, signal or time limit. */

export type RetireResult = { status: 'retired'; instanceGone: true } | { status: 'busy' | 'stale'; instanceGone: false; reason: string };

export const RETIRED: RetireResult = { status: 'retired', instanceGone: true };
export const busy = (reason: string): RetireResult => ({ status: 'busy', instanceGone: false, reason });
export const stale = (reason: string): RetireResult => ({ status: 'stale', instanceGone: false, reason });

/* What a program has going on, as its host knows it. */
export type IdleEvidence = {
  turn: boolean; queuedTurns: number; unopened: number; busy: boolean; starting: boolean; restarting: boolean; typing: boolean; promptWaits: boolean;
  personWords: boolean; calls: number; waitingWords: number; stillTyping: boolean; enterPending: boolean; unanswered: boolean; writers: boolean;
};

const REASONS: readonly [keyof IdleEvidence, string][] = [
  ['turn', 'a turn runs'], ['queuedTurns', 'a turn waits'], ['unopened', 'a typed turn waits for its answer'], ['busy', 'the program works'], ['starting', 'the program starts'],
  ['restarting', 'the program restarts'], ['typing', 'a prompt is on its way'], ['promptWaits', 'a prompt waits to go in'], ['personWords', 'a person is waiting for an answer'],
  ['calls', 'a tool runs'], ['waitingWords', 'words wait for a turn'], ['stillTyping', 'someone is typing'], ['enterPending', 'an Enter was pressed'], ['unanswered', 'words have no answer yet'],
  ['writers', 'something still writes'],
];

/* Why it may not go yet: in words with no path or secret, and null when it may. */
export function idleRefusal(evidence: IdleEvidence): string | null {
  return REASONS.find(([field]) => evidence[field])?.[1] ?? null;
}

/* An Enter a person pressed holds the program until the time it may be heard in has passed, and has no end while its turn runs. */
export const enterPending = (pressed: { until: number | null } | null | undefined, now = Date.now()): boolean =>
  Boolean(pressed) && (pressed!.until ?? Infinity) > now;

/* Whether this promise has settled by now, without waiting for it. */
export async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), new Promise<boolean>(done => setImmediate(() => done(false)))]);
}
