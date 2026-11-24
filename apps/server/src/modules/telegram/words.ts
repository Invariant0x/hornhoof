import { LINK_DAYS } from '../assistants/files.js';

/* What a bot can say on its own, in Russian or English. */
export type BotLang = 'en' | 'ru';

export const langOf = (code: string | undefined): BotLang => (code?.toLowerCase().startsWith('ru') ? 'ru' : 'en');

export const agentName = (agent: { kind: string; name: string }, lang: BotLang): string =>
  agent.kind === 'orchestrator' ? (lang === 'ru' ? 'Оркестратор' : 'Orchestrator') : agent.name;

export const WORDS = {
  en: {
    unknown: (id: number, username: string | null) =>
      `I do not know you yet. Ask the company's owner to add your Telegram to your row in People in Hornhoof. Your Telegram number is ${id}${username ? `, your username is ${username}` : ''}.`,
    inactive: "You are not active in the company in Hornhoof now, so I cannot take your message. Ask the company's owner about it.",
    notYours: (agent: string) => `In Hornhoof you cannot write to ${agent}, so I cannot pass your message on. Ask the company's owner if you need to.`,
    unreadable: 'I cannot read this kind of message. Send words, a file, a photo, a video or a voice message.',
    fileLost: (name: string) => `${name} did not come through. Send it again in a little while.`,
    fileTooBig: (name: string, limit: number) => `${name} is too big: a bot gets files of up to ${limit} MB from Telegram. Send it as a link, or in parts.`,
    bigFile: (name: string, url: string) => `${name} is over 50 MB, more than Telegram passes on. Its link downloads it for ${LINK_DAYS} days: ${url}`,
    noRoom: (name: string) => `${name} did not come through: Hornhoof has no room left for the company's files. Ask the company's owner about it.`,
    notReady: (agent: string) => `${agent} cannot answer right now. Open Hornhoof to see why, or write again later.`,
    failed: 'Your message did not go through. Please write it again in a little while.',
    noAnswer: (agent: string) => `${agent} could not answer this time. Open Hornhoof to see why, or write again.`,
  },
  ru: {
    unknown: (id: number, username: string | null) =>
      `Я вас пока не знаю. Попросите владельца компании добавить ваш Telegram в вашу строку в разделе «Люди» в Hornhoof. Ваш номер в Telegram: ${id}${username ? `, имя пользователя: ${username}` : ''}.`,
    inactive: 'Сейчас вы не активны в компании в Hornhoof, поэтому я не могу принять сообщение. Спросите об этом владельца компании.',
    notYours: (agent: string) => `В Hornhoof вам нельзя писать этому сотруднику (${agent}), поэтому я не могу передать ваше сообщение. Если нужно, спросите владельца компании.`,
    unreadable: 'Такое сообщение я прочитать не могу. Пришлите текст, файл, фото, видео или голосовое.',
    fileLost: (name: string) => `Файл ${name} не дошел. Пришлите его, пожалуйста, еще раз чуть позже.`,
    fileTooBig: (name: string, limit: number) => `Файл ${name} слишком большой: бот получает из Telegram файлы до ${limit} МБ. Пришлите ссылку или разбейте на части.`,
    bigFile: (name: string, url: string) => `Файл ${name} больше 50 МБ, столько Telegram не передает. По ссылке его можно скачать ${LINK_DAYS} дней: ${url}`,
    noRoom: (name: string) => `Файл ${name} не дошел: в Hornhoof закончилось место для файлов компании. Спросите об этом владельца компании.`,
    notReady: (agent: string) => `${agent} сейчас не может ответить. Откройте Hornhoof, чтобы узнать почему, или напишите позже.`,
    failed: 'Ваше сообщение не дошло. Напишите его, пожалуйста, еще раз чуть позже.',
    noAnswer: (agent: string) => `${agent}: ответить в этот раз не получилось. Откройте Hornhoof, чтобы узнать почему, или напишите еще раз.`,
  },
} satisfies Record<BotLang, unknown>;
