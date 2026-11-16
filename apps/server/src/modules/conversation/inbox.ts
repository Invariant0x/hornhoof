import { cleanDiagnostic } from '@hornhoof/protocol/redaction';
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentSpot } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { agentInbox, agents, companies, departments, jobs, type InboxMode, type LetterKind } from '../../db/schema.js';
import { countOnly, idOnly } from '../../db/selections.js';
import type { MessageParty } from '../events/parties.js';
import { appendEvent } from '../events/store.js';

type Reader = Pick<Db, 'select'>;
type Writer = Pick<Db, 'update' | 'insert' | 'select' | 'delete'>;
export type InboxStatus = (typeof agentInbox.$inferSelect)['status'];
export type InboxRow = typeof agentInbox.$inferSelect;

/* How the employee takes mail: its own mode, else what it inherits, its department's or else the company's. A person's assistant answers its
   owner alone and takes everything as it comes. */
export async function inboxModeOf(db: Reader, agentId: string): Promise<{ own: InboxMode | null; inherited: InboxMode; effective: InboxMode }> {
  const [row] = await db
    .select({ kind: agents.kind, own: agents.inboxMode, department: departments.inboxMode, company: companies.inboxMode })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .leftJoin(departments, eq(departments.id, agents.departmentId))
    .where(eq(agents.id, agentId));
  if (!row) return { own: null, inherited: 'direct', effective: 'direct' };
  const inherited = row.department ?? row.company;
  return { own: row.own, inherited, effective: row.kind === 'assistant' ? 'direct' : (row.own ?? inherited) };
}

/* What a turn's message says of where it came from, as the queue keeps it. */
export type MailMessage = {
  personId: string | null;
  text: string;
  from?: 'orchestrator' | 'agent';
  name?: string;
  by?: string;
  task?: { id: string; number: number };
  taskWake?: unknown;
  report?: string;
  channel?: 'telegram' | 'assistant';
  notification?: { source: string };
  /* Who did what a notice of Hornhoof tells, as the notice names them. */
  actor?: { kind: 'person' | 'agent' | 'hornhoof'; id: string | null; name: string };
  computerAccess?: { machineId: string; inboxId?: string };
};
export type MailTurn = { companyId: string; agentId: string; taskId?: string; repeated?: unknown; message?: MailMessage };

/* Mail is what no person wrote: an employee's or the orchestrator's message, a report, or Hornhoof's notice. A person's
   words, by the window, the terminal, Telegram or an assistant, are a person's and never mail. */
export function isMail(t: MailTurn): t is MailTurn & { message: MailMessage } {
  const m = t.message;
  return Boolean(m && !t.repeated && m.personId === null && !m.channel && m.text.trim());
}

/* Mail the inbox takes instead of a turn: everything but what wakes a task, from Hornhoof or an employee's letter on it, which
   stays a turn on that task and is kept in the inbox with that turn. */
export const takesInsteadOfTurn = (t: MailTurn & { message: MailMessage }): boolean => !t.message.taskWake;

/* What the letter is, as the tab names it: another's words, a report on work, a comment on a task, a task given to the
   employee (to do or to check), or any other notice of Hornhoof. */
const REPORTS = new Set(['reported']);
const COMMENTS = new Set(['comment']);
const ASSIGNMENTS = new Set(['assigned', 'review']);
export function letterKind(m: MailMessage): LetterKind {
  const source = m.notification?.source ?? '';
  if (m.from) return 'message';
  if (m.report || REPORTS.has(source)) return 'report';
  if (COMMENTS.has(source)) return 'comment';
  return ASSIGNMENTS.has(source) ? 'assignment' : 'notification';
}

type Sender = Pick<typeof agentInbox.$inferInsert, 'senderKind' | 'senderAgentId' | 'senderPersonId' | 'senderName'>;
const HORNHOOF: Sender = { senderKind: 'hornhoof', senderAgentId: null, senderPersonId: null, senderName: 'Hornhoof' };

/* Who wrote the letter: the employee or the orchestrator that sent it, else whoever did what Hornhoof's notice tells. */
async function senderOf(db: Reader, companyId: string, m: MailMessage): Promise<Sender> {
  if (m.from === 'agent' && m.by) return { senderKind: 'agent', senderAgentId: m.by, senderPersonId: null, senderName: m.name ?? 'Employee' };
  if (m.from === 'orchestrator') {
    const [orchestrator] = await db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator')));
    return { senderKind: 'agent', senderAgentId: orchestrator?.id ?? null, senderPersonId: null, senderName: 'Orchestrator' };
  }
  const actor = m.actor;
  if (actor?.kind === 'agent' && actor.id) return { senderKind: 'agent', senderAgentId: actor.id, senderPersonId: null, senderName: actor.name };
  if (actor?.kind === 'person' && actor.id) return { senderKind: 'person', senderAgentId: null, senderPersonId: actor.id, senderName: actor.name };
  return HORNHOOF;
}

/* Keeps the letter in the employee's inbox, with the turn it went into or waits for. */
export async function keepMail(db: Writer, t: MailTurn & { message: MailMessage }, jobId: string, status: InboxStatus): Promise<string> {
  const m = t.message;
  const task = m.task ?? null;
  const [row] = await db.insert(agentInbox).values({
    companyId: t.companyId,
    agentId: t.agentId,
    ...(await senderOf(db, t.companyId, m)),
    taskId: task?.id ?? t.taskId ?? null,
    taskNumber: task?.number ?? null,
    kind: letterKind(m),
    source: m.notification?.source ?? null,
    text: m.text,
    jobId,
    status,
    readAt: status === 'unread' ? null : new Date(),
    createdAt: new Date(),
  }).returning({ id: agentInbox.id });
  return row!.id;
}

/* The screens of the employee's place fetch its inbox again; the message says nothing of what is in it. */
export async function inboxChanged(ctx: Pick<Ctx, 'db' | 'bus'>, agentId: string): Promise<void> {
  const [agent] = await ctx.db.select({ companyId: agents.companyId, departmentId: agents.departmentId, productId: agents.productId, teamId: agents.teamId }).from(agents).where(eq(agents.id, agentId));
  if (agent) ctx.bus.publish(agent.companyId, { type: 'inbox', agentId, spot: await agentSpot(ctx.db, agent) });
}

/* The letters of these turns went out with them: read. How many were unread. */
export async function mailWentOut(db: Writer, agentId: string, jobIds: string[]): Promise<number> {
  if (!jobIds.length) return 0;
  const read = await db.update(agentInbox).set({ status: 'read', readAt: new Date() }).where(and(eq(agentInbox.agentId, agentId), inArray(agentInbox.jobId, jobIds), eq(agentInbox.status, 'unread'))).returning({ id: agentInbox.id });
  return read.length;
}

/* The letters of a turn that never went out, whose senders heard so: none of them waits for the employee. How many went. */
export async function dropMail(db: Writer, agentId: string, jobId: string): Promise<number> {
  const dropped = await db.delete(agentInbox).where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.jobId, jobId), eq(agentInbox.status, 'unread'))).returning({ id: agentInbox.id });
  return dropped.length;
}

/* Attaches the unread letters that go out with this inbox turn before dispatch, detaching any unshown ones. */
export async function claimMail(db: Writer, agentId: string, mail: readonly Pick<InboxRow, 'id'>[], job: { id: string; inboxWake: boolean }): Promise<void> {
  if (!job.inboxWake || !mail.length) return;
  const ids = mail.map(m => m.id);
  await db.update(agentInbox).set({ jobId: null }).where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.jobId, job.id), notInArray(agentInbox.id, ids)));
  await db.update(agentInbox).set({ jobId: job.id }).where(and(eq(agentInbox.agentId, agentId), inArray(agentInbox.id, ids), eq(agentInbox.status, 'unread')));
}

/* The turn that took the inbox went out with these letters in its summary: read, as letters of that turn. */
export async function mailShown(db: Writer, agentId: string, ids: string[], jobId: string): Promise<void> {
  if (!ids.length) return;
  await db.update(agentInbox).set({ status: 'read', readAt: new Date(), jobId }).where(and(eq(agentInbox.agentId, agentId), inArray(agentInbox.id, ids), eq(agentInbox.status, 'unread')));
}

/* A turn that took the inbox did not reach its program: what it showed is unread again, for the next one. How many. */
export async function mailBack(db: Writer, agentId: string, jobId: string): Promise<number> {
  const back = await db.update(agentInbox).set({ status: 'unread', readAt: null }).where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.jobId, jobId), eq(agentInbox.status, 'read'))).returning({ id: agentInbox.id });
  return back.length;
}

/* What the turn that takes the inbox gives: the unread letters, but those that wait in a turn of their own, which gives them. */
export async function unreadMail(db: Reader, agentId: string): Promise<InboxRow[]> {
  const rows = await db
    .select({ letter: agentInbox })
    .from(agentInbox)
    .leftJoin(jobs, eq(jobs.id, agentInbox.jobId))
    .where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.status, 'unread'), or(isNull(jobs.id), eq(jobs.inboxWake, true), notInArray(jobs.status, ['queued', 'running']))))
    .orderBy(asc(agentInbox.seq));
  return rows.map(r => r.letter);
}

/* How many letters the summary shows, the newest, and how much of each. */
export const SUMMARY_LETTERS = 20;
export const SUMMARY_CHARS = 300;

const cut = (text: string, n: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}...` : flat;
};
const at = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const letterLine = (row: InboxRow, i: number) => `${i}. ${row.senderName}${row.taskNumber !== null ? `, on #${row.taskNumber}` : ''}, at ${at(row.createdAt)}: ${cut(row.text, SUMMARY_CHARS)}`;

/* What the turn that takes the inbox begins with: how many letters wait and the newest of them, each the employee's own
   letter as it came, cut short. A task is named by its number only: its text is the employee's to read with its tools. */
export function mailSummary(unread: InboxRow[]): string {
  const shown = unread.slice(-SUMMARY_LETTERS);
  const earlier = unread.length - shown.length;
  return [
    `Hornhoof: your inbox has ${unread.length} unread ${unread.length === 1 ? 'letter' : 'letters'}. ${earlier ? `The newest ${shown.length} follow, oldest first; ${earlier} earlier ones are in the inbox tool.` : 'They follow, oldest first.'} Each is cut at ${SUMMARY_CHARS} characters.`,
    shown.map((row, i) => letterLine(row, earlier + i + 1)).join('\n'),
    'Read them whole with the inbox tool, and once you dealt with a letter mark it done with inbox_mark. Letters that come while this turn runs wait in the inbox too: read them there, or in the one turn that takes the inbox next. Answer a sender with message_employee.',
  ].join('\n\n');
}

/* seen: read or dealt with, as a person reads both. */
export type InboxFilter = { status?: InboxStatus | 'seen' | 'all'; task?: number; sender?: string; limit?: number; before?: string };

/* The employee's own letters, newest last, with how many it has not read. */
export async function inboxView(db: Reader, agentId: string, filter: InboxFilter = {}): Promise<{ unread: number; letters: InboxRow[] }> {
  const status = filter.status ?? 'unread';
  const where: (SQL | undefined)[] = [eq(agentInbox.agentId, agentId)];
  if (status === 'seen') where.push(inArray(agentInbox.status, ['read', 'done']));
  else if (status !== 'all') where.push(eq(agentInbox.status, status));
  if (filter.task !== undefined) where.push(eq(agentInbox.taskNumber, filter.task));
  if (filter.sender) where.push(eq(agentInbox.senderAgentId, filter.sender));
  if (filter.before) {
    const [cursor] = await db.select({ seq: agentInbox.seq }).from(agentInbox).where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.id, filter.before)));
    if (cursor) where.push(lt(agentInbox.seq, cursor.seq));
  }
  const rows = await db.select().from(agentInbox).where(and(...where)).orderBy(desc(agentInbox.seq)).limit(Math.min(filter.limit ?? 50, 200));
  return { unread: await unreadCount(db, agentId), letters: rows.reverse() };
}

/* A page of the employee's letters as a person reads them, newest first, older than the letter `before` names; more: whether
   older ones follow. */
export async function lettersPage(db: Reader, agentId: string, { before, limit }: { before?: string; limit: number }): Promise<{ letters: InboxRow[]; more: boolean }> {
  const where: (SQL | undefined)[] = [eq(agentInbox.agentId, agentId)];
  if (before) {
    const [cursor] = await db.select({ seq: agentInbox.seq }).from(agentInbox).where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.id, before)));
    if (cursor) where.push(lt(agentInbox.seq, cursor.seq));
  }
  const rows = await db.select().from(agentInbox).where(and(...where)).orderBy(desc(agentInbox.seq)).limit(limit + 1);
  return { letters: rows.slice(0, limit), more: rows.length > limit };
}

export async function letterTotal(db: Reader, agentId: string): Promise<number> {
  const [row] = await db.select(countOnly()).from(agentInbox).where(eq(agentInbox.agentId, agentId));
  return row?.n ?? 0;
}

/* How many of the employee's letters nobody marked yet. */
export async function unreadCount(db: Reader, agentId: string): Promise<number> {
  const [row] = await db.select(countOnly()).from(agentInbox).where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.status, 'unread')));
  return row?.n ?? 0;
}

async function detachQueuedWake(db: Pick<Db, 'select' | 'update'>, agentId: string, picked: SQL | undefined): Promise<void> {
  const queued = await db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued'), eq(jobs.inboxWake, true)));
  if (!queued.length) return;
  await db.update(agentInbox).set({ jobId: null }).where(and(picked, eq(agentInbox.status, 'unread'), inArray(agentInbox.jobId, queued.map(j => j.id))));
}

/* A person marks the employee's own letters read, these or all of them; a letter it dealt with stays so, and any other id
   is refused whole. How many are unread after. */
export async function readByPerson(db: Pick<Db, 'select' | 'update'>, agentId: string, which: string[] | 'all'): Promise<number | null> {
  const mine = eq(agentInbox.agentId, agentId);
  if (which !== 'all') {
    const found = await db.select(idOnly(agentInbox)).from(agentInbox).where(and(mine, inArray(agentInbox.id, which)));
    if (found.length !== new Set(which).size) return null;
  }
  const picked = which === 'all' ? mine : and(mine, inArray(agentInbox.id, which));
  await detachQueuedWake(db, agentId, picked);
  await db.update(agentInbox).set({ status: 'read', readAt: new Date() }).where(and(picked, eq(agentInbox.status, 'unread')));
  return unreadCount(db, agentId);
}

/* Which of the employee's letters a mark takes: these ids, and of them, or of all, those of this kind, from this source,
   on this task, or that came before this moment. */
export type LetterPick = { ids?: string[]; kind?: LetterKind; source?: string; task?: number; receivedBefore?: Date };

/* Whether the pick names letters at all: an id, a kind, a source, a task or a moment. */
export const picksLetters = (pick: LetterPick): boolean =>
  Boolean(pick.ids?.length) || pick.kind !== undefined || pick.source !== undefined || pick.task !== undefined || pick.receivedBefore !== undefined;

function pickedBy(agentId: string, pick: LetterPick): SQL {
  return and(
    eq(agentInbox.agentId, agentId),
    pick.ids ? inArray(agentInbox.id, pick.ids) : undefined,
    pick.kind ? eq(agentInbox.kind, pick.kind) : undefined,
    pick.source !== undefined ? eq(agentInbox.source, pick.source) : undefined,
    pick.task !== undefined ? eq(agentInbox.taskNumber, pick.task) : undefined,
    pick.receivedBefore ? lt(agentInbox.createdAt, pick.receivedBefore) : undefined,
  )!;
}

/* Marks the employee's letters the pick takes; read never takes back a letter that was dealt with. Any id not of its
   inbox refuses the mark whole. How many letters it changed, or null. */
export async function markMail(db: Pick<Db, 'select' | 'update'>, agentId: string, pick: LetterPick, status: 'read' | 'done'): Promise<number | null> {
  if (pick.ids) {
    const mine = await db.select(idOnly(agentInbox)).from(agentInbox).where(and(eq(agentInbox.agentId, agentId), inArray(agentInbox.id, pick.ids)));
    if (mine.length !== new Set(pick.ids).size) return null;
  }
  const picked = and(pickedBy(agentId, pick), inArray(agentInbox.status, status === 'read' ? ['unread'] : ['unread', 'read']));
  await detachQueuedWake(db, agentId, picked);
  const changed = await db.update(agentInbox).set({ status, readAt: new Date() }).where(picked).returning({ id: agentInbox.id });
  return changed.length;
}

/* Who marked another's letters and why, as the employee's log names them. */
export type MarkedBy = { party: MessageParty & { kind: 'agent' | 'person'; id: string }; reason: string };

const letters = (n: number) => `${n} ${n === 1 ? 'letter' : 'letters'}`;
const MARKED_RU = { read: 'прочитано', done: 'разобрано' } as const;

/* Letters someone else marked go in the employee's log, so it sees who took what away and why: never a word to its
   program, a turn or a letter of its own. The reason is cleaned of secrets. */
export async function logMarked(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, agent: { id: string; companyId: string }, by: MarkedBy, status: 'read' | 'done', count: number): Promise<void> {
  if (count === 0) return;
  const reason = cleanDiagnostic(by.reason);
  const { kind, id, name } = by.party;
  await appendEvent(ctx, {
    companyId: agent.companyId,
    agentId: agent.id,
    kind: 'message',
    data: {
      text: `${name} marked ${letters(count)} ${status} in this inbox. Why: ${reason}`,
      notification: { source: 'inbox_marked', tasks: [], detail: { en: `${status}: ${count}`, ru: `${MARKED_RU[status]}: ${count}` } },
      actor: by.party,
      inboxMarked: { by: { kind, id, name }, status, count, reason },
    },
  });
}
