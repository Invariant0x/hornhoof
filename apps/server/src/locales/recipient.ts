import { localeInfo } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { people, telegramBots, telegramChatLanguages } from '../db/schema.js';

/* Only a language shared by this person's chats with bots of this company is a hint for a new question. */
export async function explanationLanguage(db: Db, companyId: string, personId: string | null): Promise<string> {
  if (personId) {
    const langs = await db.selectDistinct({ id: telegramChatLanguages.lang }).from(people)
      .innerJoin(telegramChatLanguages, eq(telegramChatLanguages.chatId, people.telegramUserId))
      .innerJoin(telegramBots, eq(telegramBots.id, telegramChatLanguages.botId))
      .where(and(eq(people.id, personId), eq(people.companyId, companyId), eq(telegramBots.companyId, companyId))).limit(2);
    const first = langs[0];
    const language = first && localeInfo(first.id);
    if (langs.length === 1 && language) return `Write the explanation in ${language.english}, the language this person uses with the company.`;
  }
  return "Write the explanation in the recipient's language.";
}
