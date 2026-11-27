import { matchLocale, type FailureKind, type LocaleId } from '@hornhoof/protocol';
import { wordsFor } from '../../locales/index.js';
import { LINK_DAYS } from '../assistants/files.js';

/* What a bot can say on its own, in the language of the person it talks to: the words are in the files of each language
   (locales/). */
export type BotLang = LocaleId;

/* The language of Telegram's language code, English when the product has none of it. */
export const langOf = (code: string | undefined): BotLang => matchLocale(code ? [code] : []);

export const agentName = (agent: { kind: string; name: string }, lang: BotLang): string => (agent.kind === 'orchestrator' ? wordsFor(lang).bot.orchestrator : agent.name);

export function botWords(lang: BotLang) {
  const words = wordsFor(lang).bot;
  const failureMessage = (agent: string, kind?: FailureKind): string => {
    if (kind === 'usage_limit') return words.planLimit(agent);
    if (kind === 'rate_limited') return words.tooMany(agent);
    if (kind === 'tools') return words.toolsUnavailable(agent);
    return words.noAnswer(agent);
  };
  return { ...words, failureMessage, bigFile: (name: string, url: string) => words.bigFile(name, url, LINK_DAYS) };
}
