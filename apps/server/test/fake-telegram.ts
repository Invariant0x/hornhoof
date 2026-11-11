import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { onTestFinished } from 'vitest';
import { listenAt } from '../../../test-support/ports.mjs';

export type TelegramUser = { id: number; is_bot?: boolean; first_name: string; username?: string; language_code?: string };
export type TelegramUpdate = { update_id: number; message?: { message_id: number; from?: TelegramUser; chat: { id: number; type: string }; date: number; text?: string } };
export type Sent = { token: string; chat_id: number; text: string; parse_mode?: string };

export type FakeTelegram = {
  /* The address to give Hornhoof as TELEGRAM_API_URL. */
  url: string;
  /* The bots it knows, by token. */
  bots: Map<string, { id: number; username: string; first_name: string }>;
  /* Every message a bot sent. */
  sent: Sent[];
  /* The offset of every getUpdates, by token, in order. */
  offsets: Map<string, number[]>;
  /* Chats that blocked the bot: a message to them is refused as Telegram refuses it. */
  blocked: Set<number>;
  /* While set, it answers 502 to everything, as a proxy in front of it does when it is away. */
  down: boolean;
  /* Every call, as the method name: never the token. */
  calls: string[];
  /* A message a person writes to the bot. */
  write(token: string, from: TelegramUser, text: string | undefined, chat?: { id: number; type: string }): number;
  /* How many getUpdates of this bot wait for news right now. */
  polling(token: string): number;
  /* Goes away: every waiting getUpdates ends with nothing, and every call after answers 502 until down is false again. */
  goDown(): void;
};

type Waiter = (updates: TelegramUpdate[]) => void;

/* A stand-in for the Telegram Bot API: getMe, getUpdates with long polling and sendMessage, as Telegram answers them. */
export async function fakeTelegram(): Promise<FakeTelegram> {
  /* A bot's connections stay open between its calls; the stand-in ends them when it goes. */
  const app = Fastify({ forceCloseConnections: true });
  const pending = new Map<string, TelegramUpdate[]>();
  const waiters = new Map<string, Set<Waiter>>();
  let nextUpdate = 1000;
  let nextMessage = 1;
  const tg: FakeTelegram = {
    url: '',
    bots: new Map(),
    sent: [],
    offsets: new Map(),
    blocked: new Set(),
    down: false,
    calls: [],
    write(token, from, text, chat = { id: from.id, type: 'private' }) {
      const update: TelegramUpdate = { update_id: nextUpdate++, message: { message_id: nextMessage++, from, chat, date: Math.floor(Date.now() / 1000), ...(text === undefined ? {} : { text }) } };
      pending.set(token, [...(pending.get(token) ?? []), update]);
      for (const wake of waiters.get(token) ?? []) wake(pending.get(token)!);
      waiters.get(token)?.clear();
      return update.update_id;
    },
    polling: token => waiters.get(token)?.size ?? 0,
    goDown() {
      tg.down = true;
      for (const set of waiters.values()) for (const wake of set) wake([]);
    },
  };
  const refuse = (code: number, description: string) => ({ ok: false, error_code: code, description });

  app.addHook('onRequest', async (req, reply) => {
    tg.calls.push(req.url.split('/').pop()!.split('?')[0]!);
    if (tg.down) return reply.code(502).send('Bad Gateway');
  });
  app.post<{ Params: { bot: string; method: string }; Body: Record<string, unknown> | undefined }>('/:bot/:method', async (req, reply) => {
    const token = req.params.bot.replace(/^bot/, '');
    const bot = tg.bots.get(token);
    if (!bot) return reply.code(401).send(refuse(401, 'Unauthorized'));
    const body = req.body ?? {};
    switch (req.params.method) {
      case 'getMe':
        return { ok: true, result: { id: bot.id, is_bot: true, first_name: bot.first_name, username: bot.username } };
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        tg.offsets.set(token, [...(tg.offsets.get(token) ?? []), offset]);
        /* Telegram forgets what an offset confirms. */
        pending.set(token, (pending.get(token) ?? []).filter(u => u.update_id >= offset));
        const ready = pending.get(token)!;
        if (ready.length) return { ok: true, result: ready };
        const updates = await new Promise<TelegramUpdate[]>(done => {
          const wake: Waiter = list => {
            clearTimeout(timer);
            waiters.get(token)?.delete(wake);
            done(list.filter(u => u.update_id >= offset));
          };
          waiters.set(token, (waiters.get(token) ?? new Set()).add(wake));
          const timer = setTimeout(() => wake([]), Number(body.timeout ?? 0) * 1000);
          reply.raw.once('close', () => wake([]));
        });
        return { ok: true, result: updates };
      }
      case 'sendMessage': {
        const chatId = Number(body.chat_id);
        if (tg.blocked.has(chatId)) return reply.code(403).send(refuse(403, 'Forbidden: bot was blocked by the user'));
        const text = String(body.text ?? '');
        if (!text || text.length > 4096) return reply.code(400).send(refuse(400, 'Bad Request: message text is empty or too long'));
        tg.sent.push({ token, chat_id: chatId, text, ...(typeof body.parse_mode === 'string' ? { parse_mode: body.parse_mode } : {}) });
        return { ok: true, result: { message_id: nextMessage++, chat: { id: chatId, type: 'private' }, date: Math.floor(Date.now() / 1000), text } };
      }
      default:
        return reply.code(404).send(refuse(404, 'Not Found'));
    }
  });
  await listenAt(port => app.listen({ host: '127.0.0.1', port }));
  tg.url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    for (const set of waiters.values()) for (const wake of set) wake([]);
    await app.close();
  });
  return tg;
}
