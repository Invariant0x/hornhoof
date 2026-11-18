import type { Notification } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { agentParty, HORNHOOF, personParty, type MessageParty } from '../events/parties.js';
import type { Actor, Task, Wake } from './state.js';

async function actorParty(ctx: Ctx, companyId: string, actor?: Actor): Promise<MessageParty> {
  if (actor?.personId) return personParty(ctx, companyId, actor.personId);
  return actor?.agentId ? agentParty(ctx, companyId, actor.agentId) : HORNHOOF;
}

function taskRefs(task: Task, wake: Wake): Notification['tasks'] {
  const refs = [{ id: task.id, number: task.number }];
  const origin = wake.cause?.task;
  if (origin && origin.id !== task.id) refs.push(origin);
  return refs;
}

async function waitDetail(ctx: Ctx, task: Task, wake: Wake): Promise<Notification['detail']> {
  const wait = wake.cause?.wait;
  if (!wait) return undefined;
  const setter = await agentParty(ctx, task.companyId, wait.setter);
  return { en: `set by ${setter.name}, until ${wait.until}`, ru: `поставил ${setter.name}, до ${wait.until}` };
}

function actionLine(task: Task, wake: Wake, senders: MessageParty[]): string {
  const cause = wake.cause;
  if (!cause?.action) return '';
  return `${senders.map(p => p.name).join(' and ')} ${cause.action} on #${cause.task?.number ?? task.number}.\n\n`;
}

function reportField(wake: Wake): { report?: string } {
  return wake.cause?.report ? { report: wake.cause.report } : {};
}

export async function wakeNotice(ctx: Ctx, task: Task, wake: Wake) {
  const cause = wake.cause;
  const actor = await actorParty(ctx, task.companyId, cause?.actor);
  const senders = cause?.actors ? await Promise.all(cause.actors.map(a => actorParty(ctx, task.companyId, a))) : [actor];
  const notification: Notification = { source: cause?.source ?? wake.why, tasks: taskRefs(task, wake), detail: await waitDetail(ctx, task, wake) };
  return { notification, actor, action: actionLine(task, wake, senders), senders, ...reportField(wake) };
}
