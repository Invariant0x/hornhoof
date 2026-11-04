import { NOTIFICATION_NAMES, type Notification, type NotificationSource } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { agentParty, personParty } from './parties.js';

type RecordedActor = { personId: string; agentId?: undefined } | { agentId: string; personId?: undefined };

/* Service producers supply a registered source, even when the same text also names a person. */
export async function notificationMessage(ctx: Pick<Ctx, 'db' | 'templates'>, companyId: string, source: NotificationSource, text: string, options: { actor?: RecordedActor; tasks?: Notification['tasks']; detail?: Notification['detail'] } = {}) {
  const actor = options.actor?.personId ? await personParty(ctx, companyId, options.actor.personId)
    : options.actor?.agentId ? await agentParty(ctx, companyId, options.actor.agentId) : undefined;
  return {
    personId: null, text: actor ? `${actor.name}: ${NOTIFICATION_NAMES[source]}.\n\n${text}` : text,
    notification: { source, tasks: options.tasks ?? [], ...(options.detail ? { detail: options.detail } : {}) },
    ...(actor ? { actor } : {}),
  };
}
