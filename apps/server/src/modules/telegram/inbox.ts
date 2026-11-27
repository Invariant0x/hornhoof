import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { canContactAgent } from '../../auth/agent-view.js';
import { personColumns, type Person } from '../../auth/session.js';
import { isUniqueViolation } from '../../db/errors.js';
import { agentEvents, agents, people, telegramBots, telegramReplies } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError, loggable } from '../../errors.js';
import { keepMessageFile, PICTURES_PER_MESSAGE } from '../conversation/pictures.js';
import { takenBytes } from '../tasks/attachments.js';
import { writeToAgent } from '../conversation/routes.js';
import { TELEGRAM_FILE_BYTES, TelegramError, type TelegramFile, type TelegramMessage, type TelegramUpdate, type TelegramUser } from './api.js';
import { chatLanguage } from './language.js';
import { agentName, botWords, type BotLang } from './words.js';

type Bot = Pick<typeof telegramBots.$inferSelect, 'id' | 'companyId' | 'agentId'>;
/* Sends a few words of the bot's own to a chat. */
type Say = (chatId: number, text: string) => Promise<void>;

/* The person of the company who writes: by the number Telegram gives their account, or the first time by their username,
   whose number is kept from then on, so a username that later passes to someone else finds nobody. */
export async function senderOf(ctx: Pick<Ctx, 'db'>, companyId: string, from: TelegramUser): Promise<Person | null> {
  const [known] = await ctx.db.select(personColumns).from(people).where(and(eq(people.companyId, companyId), eq(people.telegramUserId, from.id)));
  if (known) return known;
  if (!from.username) return null;
  try {
    const [named] = await ctx.db
      .update(people)
      .set({ telegramUserId: from.id })
      .where(and(eq(people.companyId, companyId), eq(people.telegramUsername, from.username.toLowerCase()), isNull(people.telegramUserId)))
      .returning(personColumns);
    return named ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/* The newest event of the agent so far: what is said after it answers what comes now. */
async function lastSeq(ctx: Pick<Ctx, 'db'>, agentId: string): Promise<number> {
  const [last] = await ctx.db.select(only(agentEvents, 'seq')).from(agentEvents).where(eq(agentEvents.agentId, agentId)).orderBy(desc(agentEvents.seq)).limit(1);
  return last?.seq ?? 0;
}

/* The turn the message went into answers it back in the chat from the message on. */
async function awaitAnswer(ctx: Pick<Ctx, 'db'>, bot: Bot, jobId: string, chatId: number, update: number, before: number, lang: BotLang): Promise<void> {
  const [said] = await ctx.db
    .select(only(agentEvents, 'seq'))
    .from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->'telegram'->>'update' = ${String(update)}`))
    .orderBy(desc(agentEvents.seq))
    .limit(1);
  await ctx.db.insert(telegramReplies).values({ botId: bot.id, jobId, chatId, afterSeq: said?.seq ?? before, lang })
    .onConflictDoUpdate({ target: [telegramReplies.botId, telegramReplies.jobId, telegramReplies.chatId], set: { lang } });
}

/* What a person sends besides words, read for the agent: its notes in place of what cannot go as a file, and the files. */
type Incoming = { file: TelegramFile; name: string; voice?: true };
type Came = { notes: string[]; files: Incoming[] };

const seconds = (f: TelegramFile) => (f.duration ? `, ${f.duration} s` : '');

/* What one message of the person carries: a document or an archive, a photo, a voice, audio or video message, a sticker,
   a contact, a place or a poll. A sticker that is a still picture goes as one; any other goes as what it shows. */
export function whatCame(m: TelegramMessage): Came {
  const notes: string[] = [];
  const files: Incoming[] = [];
  if (m.forward_origin) notes.push('[This message is forwarded from someone else.]');
  if (m.document) files.push({ file: m.document, name: m.document.file_name ?? 'file' });
  const photo = m.photo?.at(-1);
  if (photo) files.push({ file: photo, name: 'photo.jpg' });
  if (m.voice) files.push({ file: m.voice, name: 'voice.ogg', voice: true });
  if (m.audio) files.push({ file: m.audio, name: m.audio.file_name ?? 'audio.mp3' });
  if (m.video) files.push({ file: m.video, name: m.video.file_name ?? 'video.mp4' });
  if (m.video_note) {
    notes.push(`[A round video message${seconds(m.video_note)}.]`);
    files.push({ file: m.video_note, name: 'video-note.mp4' });
  }
  if (m.animation && !m.document) files.push({ file: m.animation, name: m.animation.file_name ?? 'animation.mp4' });
  if (m.sticker) {
    const s = m.sticker;
    notes.push(`[A sticker${s.emoji ? ` ${s.emoji}` : ''}${s.set_name ? ` from the set ${s.set_name}` : ''}.]`);
    if (!s.is_animated && !s.is_video) files.push({ file: s, name: 'sticker.webp' });
  }
  if (m.contact) notes.push(`[A contact: ${[m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ')}, ${m.contact.phone_number}.]`);
  if (m.venue) notes.push(`[A place: ${m.venue.title}, ${m.venue.address} (${m.venue.location.latitude}, ${m.venue.location.longitude}).]`);
  else if (m.location) notes.push(`[A location: ${m.location.latitude}, ${m.location.longitude}.]`);
  if (m.poll) notes.push(`[A poll: ${m.poll.question} Options: ${m.poll.options.map(o => o.text).join('; ')}.]`);
  return { notes, files };
}

/* Gets a file of a message from Telegram. */
export type FetchFile = (fileId: string) => Promise<Buffer>;
/* The words of a voice message, or null when there are none to give. */
export type Transcribe = (bytes: Buffer, name: string) => Promise<string | null>;

const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);

/* Brings the files over from Telegram and keeps them for the agent, each in turn. One that does not come is named in the
   words the agent reads, and the person hears why. */
async function bringFiles(ctx: Ctx, me: Person, agentId: string, came: Came, fetchFile: FetchFile, transcribe: Transcribe, chatId: number, say: Say, words: ReturnType<typeof botWords>) {
  const ids: string[] = [];
  const notes: string[] = [];
  for (const { file, name, voice } of came.files) {
    if ((file.file_size ?? 0) > TELEGRAM_FILE_BYTES) {
      notes.push(`[${name} (${megabytes(file.file_size!)} MB) did not come: Telegram gives a bot files of up to ${megabytes(TELEGRAM_FILE_BYTES)} MB.]`);
      await say(chatId, words.fileTooBig(name, megabytes(TELEGRAM_FILE_BYTES)));
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await fetchFile(file.file_id);
      if (!bytes.length) throw new Error('The file came empty.');
    } catch (err) {
      const tooBig = err instanceof TelegramError && /too big/i.test(err.message);
      ctx.log.warn({ error: err instanceof TelegramError ? { code: err.code, message: err.message } : loggable(err), agentId }, 'A file sent to a Telegram bot could not be fetched.');
      notes.push(`[${name} did not come${tooBig ? `: Telegram gives a bot files of up to ${megabytes(TELEGRAM_FILE_BYTES)} MB` : ''}.]`);
      await say(chatId, tooBig ? words.fileTooBig(name, megabytes(TELEGRAM_FILE_BYTES)) : words.fileLost(name));
      continue;
    }
    if (voice) {
      const said = await transcribe(bytes, name);
      notes.push(said ? `[A voice message${seconds(file)}. Its words, as speech recognition heard them: ${said}]` : `[A voice message${seconds(file)}, with no transcript: its recording is the file voice.ogg below.]`);
    }
    try {
      ids.push((await keepMessageFile(ctx, me, agentId, await takenBytes(ctx, bytes), name)).id);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      notes.push(`[${name} did not come: Hornhoof has no room left for the company's files.]`);
      await say(chatId, words.noRoom(name));
    }
  }
  return { ids, notes };
}

/* One message of a bot, or the updates of one album together: a person's words and files in a private chat go to the bot's
   agent as if they wrote and sent them in its window, with their rights; anyone else hears plainly why not. Returns whether
   the message went to the agent. */
export async function receive(ctx: Ctx, bot: Bot, updates: TelegramUpdate | TelegramUpdate[], say: Say, fetchFile: FetchFile, transcribe: Transcribe = async () => null): Promise<boolean> {
  const all = (Array.isArray(updates) ? updates : [updates]).filter(u => u.message);
  const update = all[0];
  const message = update?.message;
  if (!update || !message?.from || message.from.is_bot || message.chat.type !== 'private') return false;
  const chatId = message.chat.id;
  const messages = all.map(u => u.message!);
  const lang = await chatLanguage(ctx.db, bot, chatId, messages, message.from.language_code);
  const words = botWords(lang);
  const me = await senderOf(ctx, bot.companyId, message.from);
  if (!me) {
    await say(chatId, words.unknown(message.from.id, message.from.username ? `@${message.from.username}` : null));
    return false;
  }
  if (me.status !== 'active') {
    await say(chatId, words.inactive);
    return false;
  }
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, bot.agentId), eq(agents.companyId, me.companyId), isNull(agents.removedAt)));
  if (!agent) return false;
  const name = agentName(agent, lang);
  if (!(await canContactAgent(ctx.db, me, agent))) {
    await say(chatId, words.notYours(name));
    return false;
  }
  const came: Came = { notes: [], files: [] };
  for (const m of messages) {
    const one = whatCame(m);
    came.notes.push(...one.notes);
    came.files.push(...one.files);
  }
  const said = messages.map(m => (m.text ?? m.caption ?? '').trim()).filter(Boolean);
  if (!said.length && !came.notes.length && !came.files.length) {
    await say(chatId, words.unreadable);
    return false;
  }
  const files = came.files.slice(0, PICTURES_PER_MESSAGE);
  const brought = await bringFiles(ctx, me, agent.id, { ...came, files }, fetchFile, transcribe, chatId, say, words);
  if (came.files.length > files.length) brought.notes.push(`[${came.files.length - files.length} more files of this album did not come: a message carries at most ${PICTURES_PER_MESSAGE}.]`);
  const text = [...said, ...came.notes, ...brought.notes].join('\n\n');
  /* Nothing came but what the person already heard did not. */
  if (!said.length && !came.notes.length && !brought.ids.length) return false;
  const source = messages.find(m => m.reply_to_message?.chat.id === chatId);
  const original = source?.reply_to_message;
  const reply = original && { id: original.message_id, text: source?.quote?.text ?? original.text ?? original.caption ?? '' };
  const before = await lastSeq(ctx, agent.id);
  let jobId: string;
  try {
    jobId = await writeToAgent(ctx, me, agent, { text, pictures: brought.ids, telegram: { bot: bot.id, chat: chatId, update: update.update_id, lang, ...(reply && { reply }) } });
  } catch (err) {
    const notReady = err instanceof ApiError && (err.reason === 'agent_not_ready' || err.reason === 'orchestrator_not_ready');
    if (!notReady) ctx.log.warn({ error: loggable(err), agentId: agent.id }, 'A message from Telegram did not reach its agent.');
    const offline = notReady && err.details?.undelivered === 'machine_offline';
    await say(chatId, offline ? words.machineOffline(name) : notReady ? words.notReady(name) : words.failed);
    return false;
  }
  await awaitAnswer(ctx, bot, jobId, chatId, update.update_id, before, lang);
  return true;
}
