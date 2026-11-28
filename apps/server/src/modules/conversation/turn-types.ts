import type { Notification } from '@hornhoof/protocol';
import type { MessageParty } from '../events/parties.js';
import { jobs } from '../../db/schema.js';
import { type WithEvent } from '../events/store.js';
import { type TaskWake } from '../tasks/wake-state.js';
import { type TurnAlarmReason } from '../tasks/silent.js';
import { type TurnWords } from './turn-words.js';
/* answersCeo: a note of something the CEO did, which counts as the CEO's order without a message. */
/* withMessage: what is kept together with the message, or not at all. */
/* retryOf: the turn a node restart cut off, which this one runs once more. continueOf: the turn that ended without
   recording its work, whose session this one goes on with. */
export type Turn = { companyId: string; agentId: string; prompt: string; createdBy: string | null; message?: { chatReceipt?: string | undefined; personId: string | null; text: string; from?: 'orchestrator' | 'agent'; name?: string; by?: string; byTurn?: string; task?: { id: string; number: number }; taskWake?: TaskWake; request?: string; timer?: true; failureCase?: string; silentJob?: string; silentReason?: TurnAlarmReason; notification?: Notification; actor?: MessageParty; action?: string; offer?: string; report?: string; reportContext?: string; senders?: MessageParty[]; pictures?: { id: string; name: string }[]; channel?: 'telegram' | 'assistant'; telegram?: { bot: string; chat: number; update: number }; assistant?: { id: string; name: string; message: string } }; repeated?: TurnWords; taskId?: string; answersCeo?: boolean; withMessage?: WithEvent; retryOf?: string; continueOf?: string; notBefore?: Date | null; fresh?: string };

export type TurnMessage = NonNullable<Turn['message']>;

/* A turn that waited for the agent and goes out inside its turn. */
export type Along = Pick<typeof jobs.$inferSelect, 'id' | 'prompt' | 'taskId' | 'continueOf' | 'inboxWake'>;
export type Queued = Pick<typeof jobs.$inferSelect, 'id' | 'companyId' | 'agentId' | 'taskId' | 'prompt'>;
/* What a turn goes out with: where it runs and what it says. */
export type Sending = Pick<typeof jobs.$inferInsert, 'subscriptionId' | 'nodeId' | 'builtinMachine' | 'prompt' | 'sessionId' | 'toolTokenHash' | 'instructionsHash'>;
