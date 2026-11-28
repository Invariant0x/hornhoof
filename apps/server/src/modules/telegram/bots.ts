import type { FailureKind } from '@hornhoof/protocol';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { canContactAgent } from '../../auth/agent-view.js';
import { personColumns, type Person } from '../../auth/session.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { agentEvents, agents, jobs, people, telegramBots, telegramReplies } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { fileLink } from '../assistants/files.js';
import { turnGoingOn } from '../conversation/turn-records.js';
import { publicUrl } from '../link/link.js';
import { attachmentBytesForPerson } from '../tasks/attachments.js';
import { downloadFile, getUpdates, sendDocument, sendText, sendTyping, splitForTelegram, TelegramError, type TelegramUpdate } from './api.js';
import { transcribe } from './transcribe.js';
import { receive } from './inbox.js';
import { IncomingQueue, keepUpdates } from './incoming-queue.js';
import { agentName, botWords } from './words.js';

type BotRow = typeof telegramBots.$inferSelect;
type ReplyRow = typeof telegramReplies.$inferSelect;

/* After a failed poll a bot waits, twice as long after each failure in a row up to the longest, or as long as Telegram
   asks; one poll that works starts it over. */
const FIRST_PAUSE_MS = 1_000;
const LONGEST_PAUSE_MS = 60_000;
/* Telegram clears a typing action after five seconds. */
const TYPING_MS = 4_000;

const textOf = (data: unknown): string => (data && typeof data === 'object' && 'text' in data && typeof data.text === 'string' ? data.text : '');
const picturesOfEvent = (data: unknown): { id: string }[] => {
  if (!data || typeof data !== 'object' || !('pictures' in data) || !Array.isArray(data.pictures)) return [];
  return data.pictures.filter((p): p is { id: string } => Boolean(p && typeof p === 'object' && 'id' in p && typeof p.id === 'string'));
};
/* A chat that blocked the bot, or that Telegram does not know, takes nothing from it any more. */
const chatGone = (err: unknown) => err instanceof TelegramError && (err.code === 403 || err.code === 400);

const sentTelegramFiles = new Set<string>();
const sentKey = (jobId: string, chatId: number, attachmentId: string) => `${jobId}:${chatId}:${attachmentId}`;

export function markTelegramFileSent(jobId: string, chatId: number, attachmentId: string): void {
  if (sentTelegramFiles.size >= 5_000) {
    const oldest = sentTelegramFiles.values().next().value;
    if (oldest) sentTelegramFiles.delete(oldest);
  }
  sentTelegramFiles.add(sentKey(jobId, chatId, attachmentId));
}

export const wasTelegramFileSent = (jobId: string, chatId: number, attachmentId: string): boolean =>
  sentTelegramFiles.has(sentKey(jobId, chatId, attachmentId));

async function authorizedRecipient(db: Ctx['db'], bot: BotRow, chatId: number): Promise<Person | null> {
  const [person] = await db
    .select(personColumns)
    .from(people)
    .where(and(eq(people.companyId, bot.companyId), eq(people.telegramUserId, chatId)));
  if (!person || person.status !== 'active') return null;
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, bot.agentId), isNull(agents.removedAt)));
  if (!agent || !(await canContactAgent(db, person, agent))) return null;
  return person;
}

/* The updates in turn, the photos and files of one album together, as the person sent them as one message. */
export function albums(updates: TelegramUpdate[]): TelegramUpdate[][] {
  const groups: TelegramUpdate[][] = [];
  for (const update of updates) {
    const album = update.message?.media_group_id;
    const last = groups.at(-1);
    const before = last?.at(-1)?.message;
    if (album && last && before?.media_group_id === album && before.chat.id === update.message!.chat.id) last.push(update);
    else groups.push([update]);
  }
  return groups;
}

/* One bot: its long poll for people's messages, and the answers it carries back to their chats. */
class Listener {
  private readonly abort = new AbortController();
  private readonly token: string;
  private readonly loop: Promise<void>;
  private readonly incoming: IncomingQueue;
  private readonly unsubscribe: () => void;
  private readonly typing = new Map<string, NodeJS.Timeout>();
  private sending: Promise<void> = Promise.resolve();
  private sendingAgain = false;
  private settleNext = false;
  /* Replies whose turn was over when a pass looked: the next pass after a poll closes them, once what comes after a turn,
     such as a turn that goes on from it, had its time. */
  private readonly ended = new Set<string>();

  constructor(
    private readonly ctx: Ctx,
    readonly bot: BotRow,
  ) {
    this.token = decryptSecret(bot.tokenEnc, ctx.config.secret);
    this.unsubscribe = ctx.bus.subscribe(bot.companyId, m => {
      if (m.type === 'working' || (m.type === 'agent_event' && m.agentId === bot.agentId)) this.answer();
    });
    this.incoming = new IncomingQueue(ctx.db, ctx.config.secret, bot.id, async group => {
      if (await receive(this.ctx, this.bot, group, this.say, this.fetchFile, this.transcribe)) this.answer();
    }, err => this.warn(err, 'Telegram input remains queued.'));
    this.incoming.wake();
    this.loop = this.listen();
    this.answer();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    for (const timer of this.typing.values()) clearTimeout(timer);
    this.typing.clear();
    this.unsubscribe();
    await this.loop;
    await this.incoming.stop();
    await this.sending;
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  private say = async (chatId: number, text: string): Promise<void> => {
    for (const piece of splitForTelegram(text)) if (piece.trim()) await sendText(this.ctx.config.telegramApiUrl, this.token, chatId, piece, this.abort.signal);
  };

  private fetchFile = (fileId: string): Promise<Buffer> => downloadFile(this.ctx.config.telegramApiUrl, this.token, fileId, this.abort.signal);

  private transcribe = (bytes: Buffer, name: string): Promise<string | null> => transcribe(this.ctx.config, bytes, name);

  private warn(err: unknown, what: string): void {
    this.ctx.log.warn({ error: err instanceof TelegramError ? { code: err.code, message: err.message } : loggable(err), agentId: this.bot.agentId, bot: this.bot.username }, what);
  }

  private async listen(): Promise<void> {
    let offset = this.bot.updateOffset;
    let pause = FIRST_PAUSE_MS;
    while (!this.stopped) {
      try {
        const updates = await getUpdates(this.ctx.config.telegramApiUrl, this.token, offset, this.abort.signal);
        for (const group of albums(updates)) {
          if (this.stopped) break;
          /* Telegram forgets an update the next call confirms, so the offset moves on only once the update is marked read. */
          await keepUpdates(this.ctx.db, this.ctx.config.secret, this.bot.id, group);
          this.incoming.wake();
          offset = Math.max(offset, group.at(-1)!.update_id + 1);
        }
        pause = FIRST_PAUSE_MS;
        this.answer(true);
      } catch (err) {
        if (this.stopped) break;
        this.warn(err, 'Could not read the messages of a Telegram bot.');
        const asked = err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : 0;
        await sleep(Math.max(pause, asked), undefined, { signal: this.abort.signal }).catch(() => {});
        pause = Math.min(pause * 2, LONGEST_PAUSE_MS);
      }
    }
  }

  /* Checks for finished answers one pass at a time. settle: the pass comes after a poll, and may close a failed turn. */
  private answer(settle = false): void {
    this.settleNext ||= settle;
    if (this.sendingAgain) return;
    this.sendingAgain = true;
    this.sending = this.sending.then(async () => {
      this.sendingAgain = false;
      const settling = this.settleNext;
      this.settleNext = false;
      if (this.stopped) return;
      try {
        const rows = await this.ctx.db.select().from(telegramReplies).where(eq(telegramReplies.botId, this.bot.id)).orderBy(asc(telegramReplies.createdAt));
        for (const row of rows) if (!this.stopped) await this.answerOne(row, settling);
      } catch (err) {
        if (!this.stopped) this.warn(err, 'Could not send an answer to Telegram.');
      }
    });
  }

  private async sendEventFiles(person: Person, row: ReplyRow, data: unknown): Promise<void> {
    for (const pic of picturesOfEvent(data)) {
      if (wasTelegramFileSent(row.jobId, row.chatId, pic.id)) continue;
      const file = await attachmentBytesForPerson(this.ctx, person, pic.id);
      if (!file) continue;
      /* A bot sends no file over 50 MB: a big one goes as its link. */
      if (file.big) await this.say(row.chatId, botWords(row.lang).bigFile(file.name, fileLink(this.ctx.config.secret, await publicUrl(this.ctx.db, this.ctx.config), file.id)));
      else await sendDocument(
        this.ctx.config.telegramApiUrl,
        this.token,
        row.chatId,
        { bytes: file.bytes, name: file.name, mediaType: file.mediaType },
        undefined,
        this.abort.signal,
      );
      markTelegramFileSent(row.jobId, row.chatId, pic.id);
    }
  }

  /* The last nonempty text is the answer. Files of the whole turn go with it, including separate attachment events.
     Remember delivered events so a later file that needs a retry does not send the answer again. */
  private async sayAnswer(person: Person, row: ReplyRow): Promise<void> {
    const { db } = this.ctx;
    const said = await db
      .select({ seq: agentEvents.seq, data: agentEvents.data })
      .from(agentEvents)
      .where(and(eq(agentEvents.jobId, row.jobId), eq(agentEvents.kind, 'text'), gt(agentEvents.seq, row.afterSeq)))
      .orderBy(asc(agentEvents.seq));
    const last = said.findLast(words => textOf(words.data).trim());
    for (const words of said) {
      await this.sendEventFiles(person, row, words.data);
      if (words === last) await this.say(row.chatId, textOf(words.data));
      await db.update(telegramReplies).set({ afterSeq: words.seq }).where(eq(telegramReplies.id, row.id));
    }
  }

  private async showTyping(row: ReplyRow): Promise<void> {
    if (this.typing.has(row.id)) return;
    this.typing.set(row.id, setTimeout(() => {
      this.typing.delete(row.id);
      this.answer();
    }, TYPING_MS));
    await sendTyping(this.ctx.config.telegramApiUrl, this.token, row.chatId, this.abort.signal)
      .catch(err => { if (!this.stopped && !chatGone(err)) this.warn(err, 'Could not show typing in Telegram.'); });
  }

  private stopTyping(id: string): void {
    clearTimeout(this.typing.get(id));
    this.typing.delete(id);
  }

  private async sayFailure(row: ReplyRow, error: string | null, kind?: FailureKind): Promise<void> {
    const [agent] = await this.ctx.db.select({ kind: agents.kind, name: agents.name }).from(agents).where(eq(agents.id, this.bot.agentId));
    if (!agent) return;
    const name = agentName(agent, row.lang);
    const words = botWords(row.lang);
    await this.say(row.chatId, error === 'machine_offline' ? words.machineOffline(name) : words.failureMessage(name, kind));
  }

  private async answerOne(row: ReplyRow, settling: boolean): Promise<void> {
    const { db } = this.ctx;
    const person = await authorizedRecipient(db, this.bot, row.chatId);
    if (!person) {
      this.stopTyping(row.id);
      this.ended.delete(row.id);
      await db.delete(telegramReplies).where(eq(telegramReplies.id, row.id));
      return;
    }
    /* Whether the turn is over is read before its words, so none it said before its end is missed. */
    const [job] = await db.select({ status: jobs.status, failure: jobs.failure, error: jobs.error }).from(jobs).where(eq(jobs.id, row.jobId));
    if (job?.status === 'running') return this.showTyping(row);
    this.stopTyping(row.id);
    if (job?.status === 'queued') return;
    const next = await turnGoingOn(this.ctx, row.jobId);
    if (next) {
      this.ended.delete(row.id);
      await db.update(telegramReplies).set({ jobId: next.id }).where(eq(telegramReplies.id, row.id)).catch(() => db.delete(telegramReplies).where(eq(telegramReplies.id, row.id)));
      this.answer();
      return;
    }
    if (job?.status === 'failed' && (!settling || !this.ended.has(row.id))) {
      this.ended.add(row.id);
      return;
    }
    try {
      if (job?.status === 'done') await this.sayAnswer(person, row);
      if (job?.status === 'failed') {
        await this.sayFailure(row, job.error, job.failure?.kind);
      }
    } catch (err) {
      if (!chatGone(err)) throw err;
    }
    this.ended.delete(row.id);
    await db.delete(telegramReplies).where(eq(telegramReplies.id, row.id));
  }
}

/* Every bot of the company, each listening from the server's start until its token is taken off or its agent leaves. */
export class TelegramBots {
  private readonly listening = new Map<string, Listener>();
  private started = false;

  constructor(private readonly ctx: Ctx) {}

  /* A server that cannot read its bots still starts, without them, as it does without its public link's settings. */
  async start(): Promise<void> {
    this.started = true;
    try {
      for (const bot of await this.ctx.db.select().from(telegramBots)) this.listen(bot);
    } catch (err) {
      this.ctx.log.error({ error: loggable(err) }, 'Could not start the Telegram bots.');
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    const all = [...this.listening.values()];
    this.listening.clear();
    await Promise.all(all.map(l => l.stop()));
  }

  /* The bots of these agents as the database has them now: started, started over with a new token, or stopped. */
  async refresh(agentIds: string[]): Promise<void> {
    const old = [...this.listening.values()].filter(l => agentIds.includes(l.bot.agentId));
    for (const l of old) this.listening.delete(l.bot.id);
    await Promise.all(old.map(l => l.stop()));
    if (!this.started || !agentIds.length) return;
    for (const bot of await this.ctx.db.select().from(telegramBots).where(inArray(telegramBots.agentId, agentIds))) this.listen(bot);
  }

  private listen(bot: BotRow): void {
    try {
      this.listening.set(bot.id, new Listener(this.ctx, bot));
    } catch (err) {
      this.ctx.log.warn({ error: loggable(err), agentId: bot.agentId }, 'A Telegram bot could not start: its token does not open with this server\'s secret.');
    }
  }
}
