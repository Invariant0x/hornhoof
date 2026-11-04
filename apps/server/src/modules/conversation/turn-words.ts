import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, type jobs } from '../../db/schema.js';
import { readMessage } from '../events/parties.js';
import { addressed } from './prompt.js';

export const UNHEARD_NOTE = 'Words sent into the running turn were not taken by the program. They go with its next turn.';

/* Sent copies, visible facts and coalesced lines with a separate input receipt are no words into a turn. */
export const incomingWords = sql`coalesce(${agentEvents.data}->'_message'->>'direction', 'in') <> 'out' and coalesce(${agentEvents.data}->>'turnFact', 'false') <> 'true' and coalesce(${agentEvents.data}->>'inputShadow', 'false') <> 'true'`;
export type TurnWords = { personId: string | null; data: unknown };
type Standing = Pick<typeof jobs.$inferSelect, 'id' | 'agentId' | 'createdBy' | 'answersCeo' | 'decisionInputPending'>;
export type RepeatedTurn = { createdBy: string | null; answersCeo: boolean; repeated: TurnWords };
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

export async function wordsForTurn(ctx: Pick<Ctx, 'db'>, agentId: string, jobId: string, text?: string) {
  const words = await ctx.db.select({ seq: agentEvents.seq, personId: agentEvents.personId, data: agentEvents.data }).from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.jobId, jobId), inArray(agentEvents.kind, ['message', 'typed']), incomingWords)).orderBy(desc(agentEvents.seq));
  if (text === undefined) return words;
  return words.filter(event => {
    const { data, message } = readMessage(event.data);
    const said = (data as { text?: unknown }).text;
    return typeof said === 'string' && flat(message ? addressed(said, message) : said) === flat(text);
  });
}

/* The next turn keeps a hidden record of the words, but never restores a person the original no longer answers. */
export async function repeatedTurn(ctx: Pick<Ctx, 'db'>, job: Standing | undefined, source?: TurnWords | null): Promise<RepeatedTurn> {
  const last = job?.agentId ? (await wordsForTurn(ctx, job.agentId, job.id))[0] : undefined;
  const personId = job?.decisionInputPending ? null : last ? last.personId : job?.createdBy ?? null;
  const words = source === undefined ? last ?? { personId, data: {} } : source;
  return {
    createdBy: job?.createdBy ?? null, answersCeo: job?.answersCeo ?? false,
    repeated: { personId: words?.personId === personId ? personId : null, data: words?.data ?? {} },
  };
}
