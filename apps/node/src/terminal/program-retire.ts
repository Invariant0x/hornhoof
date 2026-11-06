/* When a program may go, and what its going answers. It goes only when idle: its turn ended with its result, no writer is at
   work and nothing of anyone's is left in it. Nothing here stops a program that works: no key, signal or time limit. */

export type RetireIdleWorkspace = { agentKey: string; expectedInstance: string; expectedJobId: string; workspaceId: string; bindingVersion: number };
export type RetireResult = { status: 'retired'; instanceGone: true } | { status: 'busy' | 'stale' | 'unsupported'; instanceGone: false; reason: string };

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

/* The requests that retired a program. The same request asked again has the same answer, whatever runs by then. A bounded memory,
   and gone with the host: a request it does not know after a restart is stale, as nothing proves it was done. */
export class RetiredRequests {
  private readonly requests = new Set<string>();

  constructor(private readonly most = 64) {}

  has(request: RetireIdleWorkspace): boolean {
    return this.requests.has(requestKey(request));
  }

  add(request: RetireIdleWorkspace): void {
    this.requests.add(requestKey(request));
    if (this.requests.size > this.most) this.requests.delete(this.requests.values().next().value!);
  }
}

const requestKey = ({ agentKey, expectedInstance, expectedJobId, workspaceId, bindingVersion }: RetireIdleWorkspace): string =>
  JSON.stringify([agentKey, expectedInstance, expectedJobId, workspaceId, bindingVersion]);

/* Whether this promise has settled by now, without waiting for it. */
export async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), new Promise<boolean>(done => setImmediate(() => done(false)))]);
}
