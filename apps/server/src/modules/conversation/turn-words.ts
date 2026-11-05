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

/* The words as they went to the program: what a message shows, or what is kept with it when more went (who said it, how to
   fetch its pictures), under the heading of its envelope. Null for an event without words. */
export function deliveredWords(stored: unknown): string | null {
  const { data, message } = readMessage(stored);
  const { text, livePrompt } = (data ?? {}) as { text?: unknown; livePrompt?: unknown };
  const said = typeof livePrompt === 'string' ? livePrompt : text;
  if (typeof said !== 'string') return null;
  return message ? addressed(said, message) : said;
}

export async function wordsForTurn(ctx: Pick<Ctx, 'db'>, agentId: string, jobId: string, text?: string) {
  const words = await ctx.db.select({ seq: agentEvents.seq, personId: agentEvents.personId, data: agentEvents.data }).from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.jobId, jobId), inArray(agentEvents.kind, ['message', 'typed']), incomingWords)).orderBy(desc(agentEvents.seq));
  if (text === undefined) return words;
  return words.filter(event => {
    const said = deliveredWords(event.data);
    return said !== null && flat(said) === flat(text);
  });
}

const lastWords = async (ctx: Pick<Ctx, 'db'>, job: Standing | undefined) => (job?.agentId ? (await wordsForTurn(ctx, job.agentId, job.id))[0] : undefined);

/* Whom the original answers now: nobody while words are on their way into it, the one who said its last words, or whoever
   started it. */
const answeredBy = (job: Standing | undefined, last: TurnWords | undefined): string | null => {
  if (job?.decisionInputPending) return null;
  return last ? last.personId : job?.createdBy ?? null;
};

const hiddenRecord = (words: TurnWords | null, personId: string | null): TurnWords => ({ personId: words?.personId === personId ? personId : null, data: words?.data ?? {} });
const standingOf = (job: Standing | undefined) => ({ createdBy: job?.createdBy ?? null, answersCeo: job?.answersCeo ?? false });

/* The next turn keeps a hidden record of the words, but never restores a person the original no longer answers. */
export async function repeatedTurn(ctx: Pick<Ctx, 'db'>, job: Standing | undefined, source?: TurnWords | null): Promise<RepeatedTurn> {
  const last = await lastWords(ctx, job);
  const personId = answeredBy(job, last);
  const words = source === undefined ? last ?? { personId, data: {} } : source;
  return { ...standingOf(job), repeated: hiddenRecord(words, personId) };
}
