import { api } from './api';
import { useLive } from './tasks';
import type { BacklogItem, TurnMode } from './types';

const listPath = (departmentId: string) => `/api/departments/${departmentId}/backlog`;

/* A department's list of work kept for later turns, first to go first; fetched again when someone changes it. */
export function useBacklog(departmentId: string | null) {
  const { data, failure, load } = useLive(departmentId ? listPath(departmentId) : null, (b: { items: BacklogItem[] }) => b.items, m => m.type === 'backlog' && m.spot.departmentId === departmentId);
  return { items: data, failure, load };
}

export const addToBacklog = (departmentId: string, item: { title: string; text: string }) => api.post<{ item: BacklogItem }>(listPath(departmentId), item);
export const orderBacklog = (departmentId: string, ids: string[]) => api.put<{ items: BacklogItem[] }>(`${listPath(departmentId)}/order`, { ids });
export const removeFromBacklog = (departmentId: string, id: string) => api.del<{ items: BacklogItem[] }>(`${listPath(departmentId)}/${id}`);
/* mode: how the next turn runs, when the items start one or join a planned one of that mode. */
export const scheduleBacklog = (departmentId: string, ids: string[], mode: TurnMode) =>
  api.post<{ turn: { number: number }; tasks: { id: string; number: number }[] }>(`${listPath(departmentId)}/schedule`, { ids, mode });

/* The list with one item moved to another place, the rest in their order. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item!);
  return next;
}
