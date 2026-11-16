import { and, desc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentEvents, agentInbox, jobs } from '../../db/schema.js';
import { readMessage, type MessageEnvelope } from '../events/parties.js';
import { addressed } from './prompt.js';

export const UNHEARD_NOTE = 'Words sent into the running turn were not taken by the program. They go with its next turn.';

/* Sent copies, visible facts and coalesced lines with a separate input receipt are no words into a turn. */
export const incomingWords = sql`coalesce(${agentEvents.data}->'_message'->>'direction', 'in') <> 'out' and coalesce(${agentEvents.data}->>'turnFact', 'false') <> 'true' and coalesce(${agentEvents.data}->>'inputShadow', 'false') <> 'true'`;
export type TurnWords = { personId: string | null; data: unknown };
export type ClickGrant = { personId: string; machineId: string | null; seq: number | null };
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'> | Tx;
type Standing = Pick<typeof jobs.$inferSelect, 'id' | 'agentId' | 'createdBy' | 'answersCeo' | 'inboxWake' | 'decisionInputPending'>;
type WordEvent = { seq: number; personId: string | null; kind: string; data: unknown };
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

/* A repeat of a turn's words names who spoke last in that turn, for a command on a machine: a person's id, or null when it
   is not known. */
const SPOKE = 'machineSpeaker';

/* Who said these words, for a command on a machine: the person by id, null when whose words went in is not known (an
   Enter in the terminal, words that may have gone in without being kept, or several people's at once), and undefined for
   nobody's: an employee's letter or report, Hornhoof's own notice, or the note of a click that opened a machine. A notice of
   what a person did or said, a task or a comment of theirs, their answer or an improvement they gave, is theirs. A repeat
   goes by whose words it repeats. */
export function machineSpeaker(w: { personId: string | null; kind: string; data: unknown }): string | null | undefined {
  if (w.personId) return w.personId;
  const spoke = w.kind === 'typed' ? (w.data as Record<string, unknown> | null)?.[SPOKE] : undefined;
  if (spoke === null || typeof spoke === 'string') return spoke;
  if (accessNote(w.data)) return undefined;
  const envelope = readMessage(w.data).message;
  if (envelope) return envelopeSpeaker(envelope);
  return w.kind === 'typed' ? null : undefined;
}

const accessNote = (data: unknown): boolean => computerClick(data) || Boolean((data as { computerAccess?: unknown } | null)?.computerAccess);

/* The people an envelope names as its senders: one is the speaker, none is nobody, and more than one is not known. */
function envelopeSpeaker(envelope: MessageEnvelope): string | null | undefined {
  const people = new Set([envelope.from, ...(envelope.senders ?? [])].filter(p => p.kind === 'person').map(p => p.id));
  if (!people.size) return undefined;
  const [only] = people;
  return people.size === 1 && only ? only : null;
}

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

function parseGrant(raw: unknown): ClickGrant | null {
  if (!raw || typeof raw !== 'object') return null;
  const { personId, machineId, seq } = raw as { personId?: unknown; machineId?: unknown; seq?: unknown };
  if (typeof personId !== 'string' || !personId) return null;
  return {
    personId,
    machineId: typeof machineId === 'string' && machineId ? machineId : null,
    seq: typeof seq === 'number' ? seq : null,
  };
}

function savedClicks(data: unknown): ClickGrant[] {
  if (!computerClick(data)) return [];
  const raw = (data as { computerClicks?: unknown }).computerClicks;
  return Array.isArray(raw) ? raw.flatMap(item => parseGrant(item) ?? []) : [];
}

function messageClick(seq: number, data: unknown): ClickGrant | null {
  const d = (data ?? {}) as { notification?: { source?: unknown }; actor?: { kind?: unknown; id?: unknown }; computerAccess?: { machineId?: unknown } };
  if (d.notification?.source !== 'computer_access' || d.actor?.kind !== 'person') return null;
  return parseGrant({ personId: d.actor.id, machineId: d.computerAccess?.machineId, seq });
}

function repeatedClicks(said: readonly WordEvent[]): ClickGrant[] {
  return said.flatMap(w => (w.kind === 'typed' ? savedClicks(w.data) : []));
}

function directMessageClicks(said: readonly WordEvent[]): ClickGrant[] {
  return said.flatMap(w => (w.kind === 'message' && w.personId === null ? (messageClick(w.seq, w.data) ?? []) : []));
}

function directClickGrants(job: Pick<Standing, 'createdBy' | 'answersCeo' | 'inboxWake'>, said: readonly WordEvent[]): ClickGrant[] {
  const repeated = repeatedClicks(said);
  if (repeated.length) return repeated;
  if (job.inboxWake || !job.answersCeo || !job.createdBy) return [];
  const fromMessage = directMessageClicks(said);
  return fromMessage.length ? fromMessage : [{ personId: job.createdBy, machineId: null, seq: null }];
}

function matchedInboxGrants(events: { seq: number; data: unknown }[], senders: ReadonlyMap<string, string>): ClickGrant[] {
  return events.flatMap(e => {
    const inboxId = (e.data as { computerAccess?: { inboxId?: unknown } })?.computerAccess?.inboxId;
    if (typeof inboxId !== 'string') return [];
    const grant = messageClick(e.seq, e.data);
    return grant && senders.get(inboxId) === grant.personId ? [grant] : [];
  });
}

async function inboxClickGrants(db: Reader, agentId: string, jobId: string): Promise<ClickGrant[]> {
  const letters = await db
    .select({ id: agentInbox.id, senderPersonId: agentInbox.senderPersonId })
    .from(agentInbox)
    .where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.jobId, jobId), eq(agentInbox.source, 'computer_access'), eq(agentInbox.senderKind, 'person')));
  const senders = new Map(letters.flatMap(l => (l.senderPersonId ? [[l.id, l.senderPersonId] as const] : [])));
  if (!senders.size) return [];
  const events = await db
    .select({ seq: agentEvents.seq, data: agentEvents.data })
    .from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.kind, 'message'), incomingWords, inArray(sql`${agentEvents.data}->'computerAccess'->>'inboxId'`, [...senders.keys()])));
  return matchedInboxGrants(events, senders);
}

async function unbrokenClicks(db: Reader, agentId: string, grants: ClickGrant[]): Promise<ClickGrant[]> {
  const seqs = grants.flatMap(g => (g.seq !== null ? [g.seq] : []));
  if (!seqs.length) return grants;
  const after = await db
    .select({ seq: agentEvents.seq, personId: agentEvents.personId, kind: agentEvents.kind, data: agentEvents.data })
    .from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), gt(agentEvents.seq, Math.min(...seqs)), inArray(agentEvents.kind, ['message', 'typed']), incomingWords, or(isNotNull(agentEvents.personId), eq(agentEvents.kind, 'typed'))));
  const humanSeqs = after.filter(byPerson).map(e => e.seq);
  if (!humanSeqs.length) return grants;
  const cutoff = Math.max(...humanSeqs);
  return grants.filter(g => g.seq === null || g.seq > cutoff);
}

/* Server-verified machine-access clicks carried by this turn, directly or through its inbox wake, until a person writes or
   presses Enter in the window. Never grants anything outside computer on the opened machine. */
export async function activeClickGrants(
  db: Reader,
  job: Pick<Standing, 'id' | 'agentId' | 'createdBy' | 'answersCeo' | 'inboxWake'>,
  said: readonly WordEvent[],
): Promise<ClickGrant[]> {
  if (!job.agentId || said.some(byPerson)) return [];
  const base = directClickGrants(job, said);
  const grants = base.length ? base : job.inboxWake ? await inboxClickGrants(db, job.agentId, job.id) : [];
  return grants.length ? unbrokenClicks(db, job.agentId, grants) : [];
}

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

function turnPrincipal(job: Standing, said: readonly WordEvent[]): string | null {
  if (job.decisionInputPending) return null;
  const principal = answeredWords(job.createdBy, said);
  return principal ? principal.personId : null;
}

function withoutClick(data: unknown): Record<string, unknown> {
  const copy = { ...(data as Record<string, unknown>) };
  delete copy.computerClick;
  delete copy.computerClicks;
  delete copy.computerAccess;
  return copy;
}

function withClicks(data: unknown, grants: ClickGrant[]): Record<string, unknown> {
  const clean = withoutClick(data);
  return grants.length ? { ...clean, computerClick: true, computerClicks: grants } : clean;
}

function repeatedSource(personId: string | null, grants: ClickGrant[], source: TurnWords | null): TurnWords {
  if (!source) return { personId: null, data: {} };
  return { personId: source.personId === personId ? personId : null, data: withClicks(source.data, grants) };
}

function repeatedWords(said: readonly (TurnWords & { kind: string })[], personId: string | null, grants: ClickGrant[], source: TurnWords | null | undefined): TurnWords {
  if (source !== undefined) return repeatedSource(personId, grants, source);
  const kept = said.find(byPerson) || said[0];
  const base = kept ? kept.data : {};
  return { personId, data: withClicks(base, grants) };
}

const EMPTY_REPEATED: RepeatedTurn = { createdBy: null, answersCeo: false, repeated: { personId: null, data: {} } };

async function currentStanding(ctx: Pick<Ctx, 'db'>, jobId: string | undefined): Promise<Standing | undefined> {
  if (!jobId) return undefined;
  const [row] = await ctx.db
    .select({ id: jobs.id, agentId: jobs.agentId, createdBy: jobs.createdBy, answersCeo: jobs.answersCeo, inboxWake: jobs.inboxWake, decisionInputPending: jobs.decisionInputPending })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  return row;
}

/* The next turn keeps a hidden record of the words, but never restores a person or click the original no longer answers. */
export async function repeatedTurn(ctx: Pick<Ctx, 'db'>, job: Pick<Standing, 'id'> | undefined, source?: TurnWords | null, unheardFrom?: string): Promise<RepeatedTurn> {
  const current = await currentStanding(ctx, job?.id);
  if (!current?.agentId) return EMPTY_REPEATED;
  const said = await wordsForTurn(ctx, current.agentId, current.id);
  const grants = current.decisionInputPending ? [] : await activeClickGrants(ctx.db, current, said);
  return {
    createdBy: current.createdBy,
    answersCeo: current.answersCeo,
    repeated: withSpeaker(withUnheardFrom(repeatedWords(said, turnPrincipal(current, said), grants, source), unheardFrom), repeatedSpeaker(current, said, source)),
  };
}

/* Who spoke the words a repeat carries, for a machine: the person whose words they are when it repeats some, else who spoke
   last in the turn; unknown while words were on their way into it, which may have gone in without being kept, and
   undefined when no person did. */
function repeatedSpeaker(current: Standing, said: readonly WordEvent[], source: TurnWords | null | undefined): string | null | undefined {
  if (current.decisionInputPending) return null;
  const own = source ? machineSpeaker({ ...source, kind: 'typed' }) : undefined;
  return own !== undefined ? own : said.map(machineSpeaker).find(speaker => speaker !== undefined);
}

function withSpeaker(words: TurnWords, spoke: string | null | undefined): TurnWords {
  return spoke === undefined ? words : { ...words, data: { ...(words.data as Record<string, unknown>), [SPOKE]: spoke } };
}

/* Words repeated because the program never took them name the turn they were typed into, to go on in its session. */
function withUnheardFrom(words: TurnWords, unheardFrom?: string): TurnWords {
  return unheardFrom ? { ...words, data: { ...(words.data as Record<string, unknown>), unheardFrom } } : words;
}
