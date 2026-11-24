import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agentEvents, people, telegramBots, telegramChats, telegramReplies } from '../../db/schema.js';
import { ensureChatNumbers, readChatNumber, readReplyQuote } from '../events/numbers.js';
import type { BotLang } from './words.js';

export type TelegramSentEntry = { bot: string; chat: number; messageId: number };
export type WindowReplyBridge = { botId: string; chatId: number; replyToMessageId: number; lang: BotLang };

const prop = (data: unknown, key: string): unknown =>
  data && typeof data === 'object' && key in data ? (data as Record<string, unknown>)[key] : undefined;

export function telegramMessageIdForChat(data: unknown, botId: string, chatId: number): number | undefined {
  const incoming = prop(data, 'telegram') as { bot?: unknown; chat?: unknown; messageId?: unknown } | undefined;
  if (incoming && incoming.bot === botId && incoming.chat === chatId && typeof incoming.messageId === 'number') {
    return incoming.messageId;
  }
  const sent = prop(data, '_telegramSent');
  if (!Array.isArray(sent)) return undefined;
  const match = sent.find(
    (s): s is TelegramSentEntry => Boolean(s && typeof s === 'object' && (s as TelegramSentEntry).bot === botId && (s as TelegramSentEntry).chat === chatId && typeof (s as TelegramSentEntry).messageId === 'number'),
  );
  return match?.messageId;
}

export async function recordTelegramSent(db: Db, seq: number, entry: TelegramSentEntry): Promise<void> {
  const item = JSON.stringify([entry]);
  await db.execute(
    sql`update ${agentEvents} set data = jsonb_set(${agentEvents.data}, '{_telegramSent}', coalesce(${agentEvents.data}->'_telegramSent', '[]'::jsonb) || ${item}::jsonb) where ${agentEvents.seq} = ${seq}`,
  );
}

export async function findHornhoofNumberForTelegram(
  db: Db,
  agentId: string,
  botId: string,
  chatId: number,
  tgMessageId: number,
): Promise<number | undefined> {
  await ensureChatNumbers(db, agentId);
  const needle = JSON.stringify([{ bot: botId, chat: chatId, messageId: tgMessageId }]);
  const albumId = JSON.stringify([tgMessageId]);
  const [row] = await db
    .select({ data: agentEvents.data })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.agentId, agentId),
        or(
          and(
            sql`${agentEvents.data}->'telegram'->>'bot' = ${botId}`,
            sql`(${agentEvents.data}->'telegram'->>'chat')::bigint = ${chatId}`,
            or(
              sql`(${agentEvents.data}->'telegram'->>'messageId')::bigint = ${tgMessageId}`,
              sql`coalesce(${agentEvents.data}->'telegram'->'messageIds', '[]'::jsonb) @> ${albumId}::jsonb`,
            ),
          ),
          sql`coalesce(${agentEvents.data}->'_telegramSent', '[]'::jsonb) @> ${needle}::jsonb`,
        ),
      ),
    )
    .orderBy(desc(agentEvents.seq))
    .limit(1);
  return row ? readChatNumber(row.data) : undefined;
}

async function chatLangOrDefault(db: Db, botId: string, chatId: number): Promise<BotLang> {
  const [chat] = await db
    .select({ lang: telegramChats.lang })
    .from(telegramChats)
    .where(and(eq(telegramChats.botId, botId), eq(telegramChats.chatId, chatId)))
    .limit(1);
  return chat?.lang ?? 'en';
}

export async function prepareWindowReplyBridge(
  db: Db,
  agentId: string,
  chatId: number | null,
  quotedSeq: number,
): Promise<WindowReplyBridge | null> {
  if (chatId === null) return null;
  const [bot] = await db.select({ id: telegramBots.id }).from(telegramBots).where(eq(telegramBots.agentId, agentId)).limit(1);
  if (!bot) return null;
  const [quoted] = await db
    .select({ data: agentEvents.data })
    .from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.seq, quotedSeq)))
    .limit(1);
  const replyToMessageId = quoted ? telegramMessageIdForChat(quoted.data, bot.id, chatId) : undefined;
  if (replyToMessageId === undefined) return null;
  return { botId: bot.id, chatId, replyToMessageId, lang: await chatLangOrDefault(db, bot.id, chatId) };
}

export async function preparePersonTelegramChatId(db: Db, person: Pick<Person, 'id'>): Promise<number | null> {
  const [row] = await db.select({ telegramUserId: people.telegramUserId }).from(people).where(eq(people.id, person.id)).limit(1);
  return row?.telegramUserId ?? null;
}

export async function enqueueWindowReplyAnswer(db: Db, bridge: WindowReplyBridge, jobId: string, beforeSeq: number): Promise<void> {
  const [said] = await db
    .select({ seq: agentEvents.seq })
    .from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->'_telegramBridge'->>'bot' = ${bridge.botId}`))
    .orderBy(desc(agentEvents.seq))
    .limit(1);
  await db
    .insert(telegramReplies)
    .values({ botId: bridge.botId, jobId, chatId: bridge.chatId, afterSeq: said?.seq ?? beforeSeq, lang: bridge.lang })
    .onConflictDoUpdate({ target: [telegramReplies.botId, telegramReplies.jobId, telegramReplies.chatId], set: { lang: bridge.lang } });
}

export type PendingBridgeRow = {
  seq: number;
  personId: string | null;
  personName: string | null;
  data: unknown;
  chatId: number;
  replyToMessageId: number;
};

export async function pendingWindowBridges(db: Db, agentId: string, botId: string): Promise<PendingBridgeRow[]> {
  const alreadySent = JSON.stringify([{ bot: botId }]);
  const rows = await db
    .select({ seq: agentEvents.seq, personId: agentEvents.personId, personName: people.name, data: agentEvents.data })
    .from(agentEvents)
    .leftJoin(people, eq(people.id, agentEvents.personId))
    .where(
      and(
        eq(agentEvents.agentId, agentId),
        eq(agentEvents.kind, 'message'),
        sql`${agentEvents.data}->'_telegramBridge'->>'bot' = ${botId}`,
        sql`not (coalesce(${agentEvents.data}->'_telegramSent', '[]'::jsonb) @> ${alreadySent}::jsonb)`,
      ),
    )
    .orderBy(asc(agentEvents.seq));
  return rows.flatMap(r => {
    const b = prop(r.data, '_telegramBridge') as { chat?: unknown; replyToMessageId?: unknown } | undefined;
    if (!b || typeof b.chat !== 'number' || typeof b.replyToMessageId !== 'number') return [];
    return [{ ...r, chatId: b.chat, replyToMessageId: b.replyToMessageId }];
  });
}

async function telegramIdForSeq(db: Db, agentId: string, seq: number, botId: string, chatId: number): Promise<number | undefined> {
  const [row] = await db
    .select({ data: agentEvents.data })
    .from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.seq, seq)))
    .limit(1);
  return row ? telegramMessageIdForChat(row.data, botId, chatId) : undefined;
}

export async function replyTargetForAnswer(
  db: Db,
  agentId: string,
  botId: string,
  jobId: string,
  chatId: number,
  answerData: unknown,
): Promise<number | undefined> {
  const ownQuote = readReplyQuote(answerData);
  if (ownQuote) return telegramIdForSeq(db, agentId, ownQuote.seq, botId, chatId);
  const messages = await db
    .select({ data: agentEvents.data })
    .from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message')))
    .orderBy(desc(agentEvents.seq));
  for (const m of messages) {
    const quote = readReplyQuote(m.data);
    if (!quote) continue;
    const msgTgId = telegramMessageIdForChat(m.data, botId, chatId);
    if (msgTgId !== undefined) return msgTgId;
    const quotedTgId = await telegramIdForSeq(db, agentId, quote.seq, botId, chatId);
    if (quotedTgId !== undefined) return quotedTgId;
  }
  return undefined;
}
