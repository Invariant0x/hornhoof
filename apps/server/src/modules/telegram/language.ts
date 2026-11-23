import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agentEvents, telegramChatLanguages } from '../../db/schema.js';
import type { TelegramMessage } from './api.js';
import { LOCALES } from '@hornhoof/protocol';
import { langOf, type BotLang } from './words.js';

/* The scripts a text can be written in, by the ISO 15924 code the registry gives each language, the more telling first. */
const WRITTEN: [script: string, pattern: RegExp][] = [
  ['Jpan', /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ['Kore', /\p{Script=Hangul}/u], ['Hans', /\p{Script=Han}/u], ['Deva', /\p{Script=Devanagari}/u],
  ['Arab', /\p{Script=Arabic}/u], ['Cyrl', /\p{Script=Cyrillic}/u], ['Latn', /\p{Script=Latin}/u],
];

/* The language a text is written in, when its script names one: a script that one language of the registry has. A script
   that several share (Latin) says nothing, and the person's Telegram language code decides. */
const writtenLanguage = (text: string): BotLang | undefined => {
  const script = WRITTEN.find(([, pattern]) => pattern.test(text))?.[0];
  const same = LOCALES.filter(locale => locale.script === script);
  return same.length === 1 ? same[0]!.id : undefined;
};

/* Older events kept the person's text and Hornhoof's notes together. A bare file was shown by its name. */
const note = /(?:^|\n\n)\[(?:A (?:voice message|round video message|sticker|contact:|place:|location:|poll:)|[^\]\n]+ did not come)/;

function legacyWrittenLanguage(text: string | null, pictures: { name: string }[] | null): BotLang | undefined {
  if (!text || text.includes('[This message is forwarded from someone else.]')) return;
  if (pictures && text === pictures.map(p => p.name).join(', ')) return;
  const at = text.search(note);
  return writtenLanguage(at < 0 ? text : text.slice(0, at));
}

async function earlierLanguage(db: Db, bot: { id: string; agentId: string }, chatId: number): Promise<BotLang | undefined> {
  const [kept] = await db.select({ lang: telegramChatLanguages.lang }).from(telegramChatLanguages)
    .where(and(eq(telegramChatLanguages.botId, bot.id), eq(telegramChatLanguages.chatId, chatId)));
  if (kept) return kept.lang;
  const messages = await db.select({
    text: sql<string | null>`${agentEvents.data}->>'text'`,
    pictures: sql<{ name: string }[] | null>`${agentEvents.data}->'pictures'`,
  }).from(agentEvents).where(and(
    eq(agentEvents.agentId, bot.agentId),
    eq(agentEvents.kind, 'message'),
    sql`${agentEvents.data}->'telegram'->>'bot' = ${bot.id}`,
    sql`${agentEvents.data}->'telegram'->>'chat' = ${String(chatId)}`,
  )).orderBy(desc(agentEvents.seq));
  for (const message of messages) {
    const lang = legacyWrittenLanguage(message.text, message.pictures);
    if (lang) return lang;
  }
}

export async function chatLanguage(db: Db, bot: { id: string; agentId: string }, chatId: number, messages: TelegramMessage[], appLanguage: string | undefined): Promise<BotLang> {
  const written = messages.flatMap(m => m.forward_origin ? [] : [m.text ?? m.caption ?? '']).join('\n');
  const lang = writtenLanguage(written);
  if (!lang) return (await earlierLanguage(db, bot, chatId)) ?? langOf(appLanguage);
  await db.insert(telegramChatLanguages).values({ botId: bot.id, chatId, lang })
    .onConflictDoUpdate({ target: [telegramChatLanguages.botId, telegramChatLanguages.chatId], set: { lang } });
  return lang;
}
