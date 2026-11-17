import { setTimeout as sleep } from 'node:timers/promises';
import { and, asc, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { canContactAgent } from '../../auth/agent-view.js';
import { personColumns, type Person } from '../../auth/session.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { agentEvents, agents, jobs, people, telegramBots, telegramReplies } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { fileLink } from '../assistants/files.js';
import { turnGoingOn } from '../conversation/queue.js';
import { publicUrl } from '../link/link.js';
import { attachmentBytesForPerson } from '../tasks/attachments.js';
import { downloadFile, getUpdates, sendDocument, sendText, splitForTelegram, TelegramError, type TelegramUpdate } from './api.js';
import { transcribe } from './transcribe.js';
import { receive } from './inbox.js';
import { agentName, WORDS } from './words.js';

type BotRow = typeof telegramBots.$inferSelect;
type ReplyRow = typeof telegramReplies.$inferSelect;

/* After a failed poll a bot waits, twice as long after each failure in a row up to the longest, or as long as Telegram
   asks; one poll that works starts it over. */
const FIRST_PAUSE_MS = 1_000;
const LONGEST_PAUSE_MS = 60_000;
const OPEN = ['queued', 'running'] as const;

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
  private readonly unsubscribe: () => void;
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
      if (m.type === 'agent_event' && m.agentId === bot.agentId) this.answer();
    });
    this.loop = this.listen();
    this.answer();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.unsubscribe();
    await this.loop;
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
        pause = FIRST_PAUSE_MS;
        for (const group of albums(updates)) {
          if (this.stopped) break;
          /* Telegram forgets an update the next call confirms, so the offset moves on only once the update is marked read. */
          await this.take(group);
          offset = Math.max(offset, group.at(-1)!.update_id + 1);
        }
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

  /* The update is marked read before it is handled, so a restart never takes it twice; a stop waits for it to be handled. */
  private async take(group: TelegramUpdate[]): Promise<void> {
    const first = group[0]!.update_id;
    const marked = await this.ctx.db
      .update(telegramBots)
      .set({ updateOffset: group.at(-1)!.update_id + 1 })
      .where(and(eq(telegramBots.id, this.bot.id), lte(telegramBots.updateOffset, first)))
      .returning({ id: telegramBots.id });
    if (!marked.length) return;
    try {
      if (await receive(this.ctx, this.bot, group, this.say, this.fetchFile, this.transcribe)) this.answer();
    } catch (err) {
      if (!this.stopped) this.warn(err, 'A message to a Telegram bot could not be handled.');
    }
  }

  /* Sends what the agent said since, one pass at a time. settle: the pass comes after a poll, and may close what ended. */
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

  private async sendEventFiles(person: Person, row: ReplyRow, data: unknown): Promise<boolean> {
    let sent = false;
    for (const pic of picturesOfEvent(data)) {
      if (wasTelegramFileSent(row.jobId, row.chatId, pic.id)) {
        sent = true;
        continue;
      }
      const file = await attachmentBytesForPerson(this.ctx.db, person, pic.id);
      if (!file) continue;
      /* A bot sends no file over 50 MB: a big one goes as its link. */
      if (file.big) await this.say(row.chatId, WORDS[row.lang].bigFile(file.name, fileLink(this.ctx.config.secret, await publicUrl(this.ctx.db, this.ctx.config), file.id)));
      else await sendDocument(
        this.ctx.config.telegramApiUrl,
        this.token,
        row.chatId,
        { bytes: file.bytes, name: file.name, mediaType: file.mediaType },
        undefined,
        this.abort.signal,
      );
      markTelegramFileSent(row.jobId, row.chatId, pic.id);
      sent = true;
    }
    return sent;
  }

  /* Sends what the turn said since the last of it sent, with the files it attached, and keeps how far it got and whether
     anything reached the person. Null when the chat is gone: it takes nothing from the bot any more. */
  private async sayWords(person: Person, row: ReplyRow): Promise<boolean | null> {
    const { db } = this.ctx;
    const said = await db
      .select({ seq: agentEvents.seq, data: agentEvents.data })
      .from(agentEvents)
      .where(and(eq(agentEvents.jobId, row.jobId), eq(agentEvents.kind, 'text'), gt(agentEvents.seq, row.afterSeq)))
      .orderBy(asc(agentEvents.seq));
    let answered = row.answered;
    for (const words of said) {
      const text = textOf(words.data);
      let fileSent = false;
      try {
        await this.say(row.chatId, text);
        fileSent = await this.sendEventFiles(person, row, words.data);
      } catch (err) {
        if (!chatGone(err)) throw err;
        await db.delete(telegramReplies).where(eq(telegramReplies.id, row.id));
        return null;
      }
      if (text.trim() || fileSent) answered = true;
      await db.update(telegramReplies).set({ afterSeq: words.seq, answered }).where(eq(telegramReplies.id, row.id));
    }
    return answered;
  }

  private async answerOne(row: ReplyRow, settling: boolean): Promise<void> {
    const { db } = this.ctx;
    const person = await authorizedRecipient(db, this.bot, row.chatId);
    if (!person) {
      this.ended.delete(row.id);
      await db.delete(telegramReplies).where(eq(telegramReplies.id, row.id));
      return;
    }
    /* Whether the turn is over is read before its words, so none it said before its end is missed. */
    const [job] = await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, row.jobId));
    const over = !job || !(OPEN as readonly string[]).includes(job.status);
    const answered = await this.sayWords(person, row);
    if (answered === null || !over) return;
    const next = await turnGoingOn(this.ctx, row.jobId);
    if (next) {
      this.ended.delete(row.id);
      await db.update(telegramReplies).set({ jobId: next.id }).where(eq(telegramReplies.id, row.id)).catch(() => db.delete(telegramReplies).where(eq(telegramReplies.id, row.id)));
      return;
    }
    if (!settling || !this.ended.has(row.id)) {
      this.ended.add(row.id);
      return;
    }
    this.ended.delete(row.id);
    if (!answered && job?.status === 'failed') {
      const [agent] = await db.select({ kind: agents.kind, name: agents.name }).from(agents).where(eq(agents.id, this.bot.agentId));
      if (agent) await this.say(row.chatId, WORDS[row.lang].noAnswer(agentName(agent, row.lang))).catch(err => { if (!chatGone(err)) throw err; });
    }
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
