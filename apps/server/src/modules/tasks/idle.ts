export const IDLE_SETTINGS = {
  signalAfterMs: 10 * 60_000,
  watchdogAfterMs: 15 * 60_000,
  minFree: 3,
  busyRatio: 0.25,
} as const;

export type IdleEmployee = {
  id: string;
  name: string;
  enabled: boolean;
  hasTurn: boolean;
  actionable: boolean;
};

export type IdleTask = { id: string; number: number; title: string; after: string[] };
export type IdleSnapshot = { departmentId: string; at: number; employees: IdleEmployee[]; tasks: IdleTask[] };
export type IdleEpisode = { key: string; since: number };
export type IdleNotification = 'signal' | 'watchdog';
export type IdleEvaluation = {
  episode: IdleEpisode | null;
  free: IdleEmployee[];
  busy: IdleEmployee[];
  busyRatio: number;
  notifications: IdleNotification[];
};

export function isFree(_employee: Pick<IdleEmployee, 'enabled' | 'hasTurn' | 'actionable'>): boolean {
  throw new Error('Not implemented');
}

export function evaluateIdle(_previous: IdleEpisode | null, _snapshot: IdleSnapshot): IdleEvaluation {
  throw new Error('Not implemented');
}
