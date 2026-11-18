import { externalWaitFact, type WaitFailure } from '@hornhoof/protocol/waits';
import type { Ctx } from '../../app.js';
import { type ExternalWait } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { type Task, type Tx, type Wake } from './state.js';
import { move } from './transitions.js';
import { wakeAll } from './wake.js';
import { setWaitStage, waitForSourceKey } from './wait-state.js';
/* Where the record of a wait stands now that the wait itself ended or came back: it has not ended by that. */
export const markRecord = (wait: ExternalWait, stage: 'waiting' | 'check_back') => async (tx: Tx, task: Task): Promise<void> => {
  if (wait.operation) await setWaitStage(tx, { taskId: task.id, kind: 'external', sourceKey: waitForSourceKey(wait.operation), stage });
};

export const waitEndedWake = (task: Task, agentId: string, reason: string, unavailable?: string): Wake =>
  ({ agentId, taskId: task.id, why: 'wait_ended', text: reason, ...(unavailable ? { note: unavailable } : {}), version: task.version + 1 });

export const waitEndedFact = (agentId: string, reason: string, unavailable?: string, failure?: WaitFailure) =>
  ({ kind: 'updated' as const, actor: { agentId }, text: unavailable ?? `The wait for "${reason}" ended.`, data: { externalWait: null, reason, ...(failure ? { waitFailure: failure } : {}) }, ...(unavailable ? { automatic: 'wait_unavailable' as const } : {}) });

export async function expireWait(ctx: Ctx, task: Task, unavailable?: string, now = new Date()): Promise<boolean> {
  if (!task.externalWait || !task.assigneeAgentId) return false;
  const work = task.externalWait.work;
  const wake = waitEndedWake(task, task.assigneeAgentId, task.externalWait.reason, unavailable);
  const wakes: Wake[] = work ? [{ ...wake, why: 'work_check' }] : [wake];
  const failure = unavailable ? 'unavailable' : externalWaitFact(task.externalWait, now.getTime()).failure;
  const ended = waitEndedFact(task.assigneeAgentId, task.externalWait.reason, unavailable, failure);
  const fact = work ? { ...ended, text: unavailable ?? `Check the progress of "${task.externalWait.reason}".`, automatic: 'work_check' as const } : ended;
  try {
    await move(ctx, task, { externalWait: null, silent: 0 }, fact, markRecord(task.externalWait, 'check_back'), wakes);
  } catch (error) {
    if (error instanceof ApiError && error.reason === 'task_changed') return false;
    throw error;
  }
  await wakeAll(ctx, wakes);
  return true;
}
