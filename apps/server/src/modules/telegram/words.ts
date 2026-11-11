/* What a bot says on its own, in the language of the person's Telegram: Russian for Russian, English for everyone else. */
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
    textOnly: 'I take only text messages for now. Please write it in words.',
    notReady: (agent: string) => `${agent} cannot answer right now. Open Hornhoof to see why, or write again later.`,
    failed: 'Your message did not go through. Please write it again in a little while.',
    noAnswer: (agent: string) => `${agent} could not answer this time. Open Hornhoof to see why, or write again.`,
  },
  ru: {
    unknown: (id: number, username: string | null) =>
      `Я вас пока не знаю. Попросите владельца компании добавить ваш Telegram в вашу строку в разделе «Люди» в Hornhoof. Ваш номер в Telegram: ${id}${username ? `, имя пользователя: ${username}` : ''}.`,
    inactive: 'Сейчас вы не активны в компании в Hornhoof, поэтому я не могу принять сообщение. Спросите об этом владельца компании.',
    notYours: (agent: string) => `В Hornhoof вам нельзя писать этому сотруднику (${agent}), поэтому я не могу передать ваше сообщение. Если нужно, спросите владельца компании.`,
    textOnly: 'Пока я принимаю только текстовые сообщения. Напишите, пожалуйста, словами.',
    notReady: (agent: string) => `${agent} сейчас не может ответить. Откройте Hornhoof, чтобы узнать почему, или напишите позже.`,
    failed: 'Ваше сообщение не дошло. Напишите его, пожалуйста, еще раз чуть позже.',
    noAnswer: (agent: string) => `${agent}: ответить в этот раз не получилось. Откройте Hornhoof, чтобы узнать почему, или напишите еще раз.`,
  },
} satisfies Record<BotLang, unknown>;
