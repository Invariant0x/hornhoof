import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentEvents, jobs } from '../../db/schema.js';
import { readMessage } from '../events/parties.js';
import { addressed } from './prompt.js';

export const UNHEARD_NOTE = 'Words sent into the running turn were not taken by the program. They go with its next turn.';

/* Sent copies, visible facts and coalesced lines with a separate input receipt are no words into a turn. */
export const incomingWords = sql`coalesce(${agentEvents.data}->'_message'->>'direction', 'in') <> 'out' and coalesce(${agentEvents.data}->>'turnFact', 'false') <> 'true' and coalesce(${agentEvents.data}->>'inputShadow', 'false') <> 'true'`;
export type TurnWords = { personId: string | null; data: unknown };
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'> | Tx;
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

const computerClick = (data: unknown): boolean => Boolean((data as { computerClick?: boolean }).computerClick);

/* Words a person typed, or a terminal Enter that cleared whom the turn answers; notices, agent messages and a repeated
   computer-opening click are none of those. */
export const byPerson = (w: { personId: string | null; kind: string; data: unknown }): boolean =>
  w.personId !== null || (w.kind === 'typed' && !computerClick(w.data));

/* Whom a turn answers: the last person who wrote or typed into it; whoever started it when nothing came into it yet. */
export function answeredWords<T extends { seq: number; personId: string | null; kind: string; data: unknown }>(
  createdBy: string | null,
  said: readonly T[],
): { personId: string; sourceSeq: number | null } | null {
  const last = said.find(byPerson);
  if (last) return last.personId ? { personId: last.personId, sourceSeq: last.seq } : null;
  return said.length === 0 && createdBy ? { personId: createdBy, sourceSeq: null } : null;
}

/* Whose click Hornhoof's note that opened the turn tells of, as their order, until a person writes or types into it. */
export const clickWords = (
  job: Pick<Standing, 'createdBy' | 'answersCeo'>,
  said: readonly { personId: string | null; kind: string; data: unknown }[],
): string | null => (!said.some(byPerson) && job.answersCeo ? job.createdBy : null);

export async function wordsForTurn(ctx: { db: Reader }, agentId: string, jobId: string, text?: string) {
  const words = await ctx.db
    .select({ seq: agentEvents.seq, personId: agentEvents.personId, kind: agentEvents.kind, data: agentEvents.data })
    .from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.jobId, jobId), inArray(agentEvents.kind, ['message', 'typed']), incomingWords))
    .orderBy(desc(agentEvents.seq));
  if (text === undefined) return words;
  return words.filter(event => {
    const said = deliveredWords(event.data);
    return said !== null && flat(said) === flat(text);
  });
}

function turnPrincipal(job: Standing, said: readonly { seq: number; personId: string | null; kind: string; data: unknown }[]): string | null {
  if (job.decisionInputPending) return null;
  const principal = answeredWords(job.createdBy, said);
  return principal ? principal.personId : null;
}

const turnClick = (job: Standing, said: readonly { personId: string | null; kind: string; data: unknown }[]): boolean =>
  !job.decisionInputPending && clickWords(job, said) !== null;

function withoutClick(data: unknown): Record<string, unknown> {
  const copy = { ...(data as Record<string, unknown>) };
  delete copy.computerClick;
  return copy;
}

function repeatedSource(personId: string | null, click: boolean, source: TurnWords | null): TurnWords {
  if (!source) return { personId: null, data: {} };
  return { personId: source.personId === personId ? personId : null, data: click ? source.data : withoutClick(source.data) };
}

function repeatedWords(said: readonly (TurnWords & { kind: string })[], personId: string | null, click: boolean, source: TurnWords | null | undefined): TurnWords {
  if (source !== undefined) return repeatedSource(personId, click, source);
  const kept = said.find(byPerson) || said[0];
  const base = kept ? kept.data : {};
  return { personId, data: click ? { ...(base as object), computerClick: true } : withoutClick(base) };
}

const EMPTY_REPEATED: RepeatedTurn = { createdBy: null, answersCeo: false, repeated: { personId: null, data: {} } };

async function currentStanding(ctx: Pick<Ctx, 'db'>, jobId: string | undefined): Promise<Standing | undefined> {
  if (!jobId) return undefined;
  const [row] = await ctx.db
    .select({ id: jobs.id, agentId: jobs.agentId, createdBy: jobs.createdBy, answersCeo: jobs.answersCeo, decisionInputPending: jobs.decisionInputPending })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  return row;
}

/* The next turn keeps a hidden record of the words, but never restores a person or click the original no longer answers. */
export async function repeatedTurn(ctx: Pick<Ctx, 'db'>, job: Pick<Standing, 'id'> | undefined, source?: TurnWords | null, unheardFrom?: string): Promise<RepeatedTurn> {
  const current = await currentStanding(ctx, job?.id);
  if (!current?.agentId) return EMPTY_REPEATED;
  const said = await wordsForTurn(ctx, current.agentId, current.id);
  return {
    createdBy: current.createdBy,
    answersCeo: current.answersCeo,
    repeated: withUnheardFrom(repeatedWords(said, turnPrincipal(current, said), turnClick(current, said), source), unheardFrom),
  };
}

/* Words repeated because the program never took them name the turn they were typed into, to go on in its session. */
function withUnheardFrom(words: TurnWords, unheardFrom?: string): TurnWords {
  return unheardFrom ? { ...words, data: { ...(words.data as Record<string, unknown>), unheardFrom } } : words;
}
