import { z } from 'zod';

/* Every service source is named here. The browser supplies the same keys in both dictionaries. */
export const NOTIFICATION_NAMES = {
  assigned: 'task assigned', review: 'gate review', changes: 'gate returned the work', stuck_at_gate: 'repeated gate returns',
  done: 'task completed', reported: 'work reported', blocked: 'work blocked', cancelled: 'task cancelled', answered: 'answer recorded',
  comment: 'task comment', updated: 'task rewritten', reminder: 'turn ended without a task move', go_on: 'turn ended before the work',
  turn: 'turn closed', switched: 'employee switched off', explain: 'question waiting for people', subtasks: 'last subtask closed',
  after_cancelled: 'dependency cancelled', merge: 'gates passed', unblocked: 'block answered', tests: 'test run ended', work: 'work run ended', calls: 'one-shot calls ended',
  turn_review: 'turn review', reviewed: 'review verdicts recorded', review_passed: 'review passed', wait_ended: 'wait timer', work_check: 'scheduled work check',
  timer: 'employee timer', first_turn: 'first window opened', computer_access: 'computer access changed', structure: 'company structure changed',
  staffing: 'employees hired', improvement: 'improvement selected', program_alarm: 'silent program alarm', program_operator: 'program operator call',
  machine: 'machine state changed', failure: 'program failed', retry: 'program retry', limit: 'plan limit', turn_fact: 'turn status recorded',
  work_requested: 'employee work requested', wait_requested: 'employee waiting for you', wait_unavailable: 'employee you wait for is unavailable', wait_cycle: 'waiting cycle', department_quiet: 'quiet department', wait_overdue: 'wait past its date', goal_risk: 'goal at risk', turn_summary: 'turn summary', release_tag: 'version tag without a recorded release', inbox_marked: 'letters marked by someone else', service: 'recorded service message',
} as const;
export type NotificationSource = keyof typeof NOTIFICATION_NAMES;
export const NotificationSourceSchema = z.enum(Object.keys(NOTIFICATION_NAMES) as [NotificationSource, ...NotificationSource[]]);
export const NotificationSchema = z.object({
  source: NotificationSourceSchema,
  tasks: z.array(z.object({ id: z.string(), number: z.number().int().positive() })),
  detail: z.object({ en: z.string(), ru: z.string() }).optional(),
});
export type Notification = z.infer<typeof NotificationSchema>;
