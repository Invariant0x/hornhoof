import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { ExternalWait } from '../../db/schema.js';
import { loadTask, move, refuse, type Moved } from './engine.js';

export const EXTERNAL_WAIT_MS = 2 * 3_600_000;
export const WaitInput = z.object({
  reason: z.string().trim().min(1).max(600).regex(/^[^\r\n\u2028\u2029]+$/).describe('One line naming the external event you wait for.'),
  until: z.iso.datetime({ offset: true }).describe('An ISO date and time in the future, at most two hours from now.'),
});

function waitOf(input: z.infer<typeof WaitInput>, now: Date): ExternalWait {
  const parsed = WaitInput.safeParse(input);
  if (!parsed.success) throw refuse(400, 'task_invalid', 'Name the external event in one line and give its deadline as an ISO date and time.');
  const until = new Date(parsed.data.until);
  const delay = until.getTime() - now.getTime();
  if (delay <= 0 || delay > EXTERNAL_WAIT_MS) throw refuse(400, 'task_invalid', 'The wait must end in the future, at most two hours from now.');
  return { reason: parsed.data.reason, since: now.toISOString(), until: until.toISOString() };
}

/* A holder can end its turn while an external system works; the task keeps its workflow status. */
export async function waitFor(ctx: Ctx, agentId: string, taskId: string, input: z.infer<typeof WaitInput>, now = new Date()): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  if (!['open', 'working', 'review', 'waiting', 'blocked'].includes(task.status)) throw refuse(409, 'task_invalid', `#${task.number} cannot wait while ${task.status}.`);
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not with you.`);
  const externalWait = waitOf(input, now);
  const row = await move(ctx, task, { externalWait, silent: 0 }, { kind: 'updated', actor: { agentId }, text: `Waiting for "${externalWait.reason}" until ${externalWait.until}.`, data: { externalWait } });
  return { task: row, wakes: [] };
}
