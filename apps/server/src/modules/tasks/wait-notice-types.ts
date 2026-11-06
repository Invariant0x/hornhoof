import type { notificationMessage } from '../events/notifications.js';

export type WaitNoticeMessage = Awaited<ReturnType<typeof notificationMessage>>;
/* What must still be true when a notice goes out. Each kind of notice has its own: no notice speaks for all of them. */
export type WaitNoticeGuard = {
  tasks: { id: string; version: number }[];
  quiet?: { turnId: string; departmentId: string; key: string };
  /* The wait at the generation, route and level or review it was written for. A comment on the task changes none of these. */
  wait?: { id: string; generation: number; routeRevision: number; level?: number; ordinal?: number };
  goal?: { requestId: string; episodeId: string; revision: number };
  /* The turn a summary is of, and the task its log line goes on. */
  turn?: { id: string; taskId: string };
};
