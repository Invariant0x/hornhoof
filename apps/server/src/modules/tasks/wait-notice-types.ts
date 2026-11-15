import type { notificationMessage } from '../events/notifications.js';

export type WaitNoticeMessage = Awaited<ReturnType<typeof notificationMessage>>;
/* What must still be true when a notice goes out. Each kind of notice has its own: no notice speaks for all of them. */
export type WaitNoticeGuard = {
  tasks: { id: string; version: number }[];
  quiet?: { turnId: string; departmentId: string; key: string };
  /* The wait at the generation, route and level or review it was written for. A comment on the task changes none of these. */
  wait?: { id: string; generation: number; routeRevision: number; level?: number; ordinal?: number };
  goal?: { requestId: string; episodeId: string; revision: number };
  /* A task's wait on one employee in the episode its last work move began. */
  waitOn?: { taskId: string; employee: string; episode: number };
  /* The turn a summary is of, and the task its log line goes on. */
  turn?: { id: string; taskId: string };
  /* A version tag that released none of that turn: what it is named, the commit it is on, and why: no release of it was
     recorded before main moved, or what its record relied on no longer stands. */
  tag?: { version: string; commit: string; why: 'unrecorded' | 'stale' };
};
