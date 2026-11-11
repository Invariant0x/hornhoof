import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { canViewAgent } from '../../auth/agent-view.js';
import { personColumns, type Person } from '../../auth/session.js';
import { isUniqueViolation } from '../../db/errors.js';
import { agentEvents, agents, people, telegramBots, telegramReplies } from '../../db/schema.js';
import { ApiError, loggable } from '../../errors.js';
import { writeToAgent } from '../conversation/routes.js';
import type { TelegramUpdate, TelegramUser } from './api.js';
import { agentName, langOf, WORDS, type BotLang } from './words.js';

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
  const [last] = await ctx.db.select({ seq: agentEvents.seq }).from(agentEvents).where(eq(agentEvents.agentId, agentId)).orderBy(desc(agentEvents.seq)).limit(1);
  return last?.seq ?? 0;
}

/* The turn the message went into answers it back in the chat from the message on. */
async function awaitAnswer(ctx: Pick<Ctx, 'db'>, bot: Bot, jobId: string, chatId: number, update: number, before: number, lang: BotLang): Promise<void> {
  const [said] = await ctx.db
    .select({ seq: agentEvents.seq })
    .from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->'telegram'->>'update' = ${String(update)}`))
    .orderBy(desc(agentEvents.seq))
    .limit(1);
  await ctx.db.insert(telegramReplies).values({ botId: bot.id, jobId, chatId, afterSeq: said?.seq ?? before, lang }).onConflictDoNothing();
}

/* One update of a bot: a person's text in a private chat goes to the bot's agent as if they wrote it in its window, with
   their rights; anyone else hears plainly why not. Returns whether the message went to the agent. */
export async function receive(ctx: Ctx, bot: Bot, update: TelegramUpdate, say: Say): Promise<boolean> {
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat.type !== 'private') return false;
  const chatId = message.chat.id;
  const lang = langOf(message.from.language_code);
  const words = WORDS[lang];
  const me = await senderOf(ctx, bot.companyId, message.from);
  if (!me) {
    await say(chatId, words.unknown(message.from.id, message.from.username ? `@${message.from.username}` : null));
    return false;
  }
  if (me.status !== 'active') {
    await say(chatId, words.inactive);
    return false;
  }
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, bot.agentId), isNull(agents.removedAt)));
  if (!agent) return false;
  const name = agentName(agent, lang);
  if (!(await canViewAgent(ctx.db, me, agent))) {
    await say(chatId, words.notYours(name));
    return false;
  }
  const text = message.text?.trim();
  if (!text) {
    await say(chatId, words.textOnly);
    return false;
  }
  const before = await lastSeq(ctx, agent.id);
  let jobId: string;
  try {
    jobId = await writeToAgent(ctx, me, agent, { text, pictures: [], telegram: { bot: bot.id, chat: chatId, update: update.update_id } });
  } catch (err) {
    const notReady = err instanceof ApiError && (err.reason === 'agent_not_ready' || err.reason === 'orchestrator_not_ready');
    if (!notReady) ctx.log.warn({ error: loggable(err), agentId: agent.id }, 'A message from Telegram did not reach its agent.');
    await say(chatId, notReady ? words.notReady(name) : words.failed);
    return false;
  }
  await awaitAnswer(ctx, bot, jobId, chatId, update.update_id, before, lang);
  return true;
}
