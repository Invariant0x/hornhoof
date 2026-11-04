import type { notificationMessage } from '../events/notifications.js';

export type WaitNoticeMessage = Awaited<ReturnType<typeof notificationMessage>>;
export type WaitNoticeGuard = {
  tasks: { id: string; version: number }[];
  quiet?: { turnId: string; departmentId: string; key: string };
};
