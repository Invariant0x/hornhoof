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

export function isFree(employee: Pick<IdleEmployee, 'enabled' | 'hasTurn' | 'actionable'>): boolean {
  return employee.enabled && !employee.hasTurn && !employee.actionable;
}

const ids = (items: readonly { id: string }[]) => items.map(item => item.id).sort();
const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

export function evaluateIdle(previous: IdleEpisode | null, snapshot: IdleSnapshot): IdleEvaluation {
  const enabled = snapshot.employees.filter(employee => employee.enabled);
  const free = enabled.filter(isFree).sort(byId);
  const busy = enabled.filter(employee => !isFree(employee)).sort(byId);
  const busyRatio = enabled.length ? busy.length / enabled.length : 0;
  const active = snapshot.tasks.length > 0 && enabled.length > 0 && (free.length >= IDLE_SETTINGS.minFree || busyRatio < IDLE_SETTINGS.busyRatio);
  if (!active) return { episode: null, free, busy, busyRatio, notifications: [] };
  const key = JSON.stringify({ departmentId: snapshot.departmentId, free: ids(free), busy: ids(busy), tasks: ids(snapshot.tasks) });
  const since = previous?.key === key ? previous.since : snapshot.at;
  const elapsed = Math.max(0, snapshot.at - since);
  const notifications: IdleNotification[] = [];
  if (free.length >= IDLE_SETTINGS.minFree && elapsed >= IDLE_SETTINGS.signalAfterMs) notifications.push('signal');
  if (busyRatio < IDLE_SETTINGS.busyRatio && elapsed >= IDLE_SETTINGS.watchdogAfterMs) notifications.push('watchdog');
  return { episode: { key, since }, free, busy, busyRatio, notifications };
}
