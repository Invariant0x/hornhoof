import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { onTestFinished } from 'vitest';
import { listenAt } from '../../../test-support/ports.mjs';

export type TelegramUser = { id: number; is_bot?: boolean; first_name: string; username?: string; language_code?: string };
export type TelegramUpdate = { update_id: number; message?: { message_id: number; from?: TelegramUser; chat: { id: number; type: string }; date: number; text?: string } & Record<string, unknown> };
export type Sent = { token: string; chat_id: number; text: string; parse_mode?: string };
export type SentDocument = { token: string; chat_id: number; file_name: string; content_type: string; bytes: Buffer; caption?: string };

export type FakeTelegram = {
  /* The address to give Hornhoof as TELEGRAM_API_URL. */
  url: string;
  /* The bots it knows, by token. */
  bots: Map<string, { id: number; username: string; first_name: string }>;
  /* Every message a bot sent. */
  sent: Sent[];
  /* Every document a bot sent with sendDocument. */
  sentDocuments: SentDocument[];
  /* The offset of every getUpdates, by token, in order. */
  offsets: Map<string, number[]>;
  /* Chats that blocked the bot: a message to them is refused as Telegram refuses it. */
  blocked: Set<number>;
  /* Chats that never started a bot, as "token:chat": Telegram refuses that bot's messages to them, as it does to a bot no one wrote to. */
  strangers: Set<string>;
  /* While set, it answers 502 to everything, as a proxy in front of it does when it is away. */
  down: boolean;
  /* Methods that answer 502 while the rest work. */
  broken: Set<string>;
  /* Bots with a webhook: Telegram refuses their getUpdates with 409 until deleteWebhook. */
  webhooks: Set<string>;
  /* Every call, as the method name: never the token. */
  calls: string[];
  /* A message a person writes to the bot. */
  write(token: string, from: TelegramUser, text: string | undefined, chat?: { id: number; type: string }): number;
  /* A message of any other kind a person sends the bot, as Telegram puts it: a document, a photo, a voice message. */
  send(token: string, from: TelegramUser, message: Record<string, unknown>): number;
  /* Files the bot may get with getFile, by their id. */
  files: Map<string, Buffer>;
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
    sentDocuments: [],
    offsets: new Map(),
    blocked: new Set(),
    strangers: new Set(),
    down: false,
    broken: new Set(),
    webhooks: new Set(),
    calls: [],
    files: new Map(),
    write(token, from, text, chat = { id: from.id, type: 'private' }) {
      return tg.send(token, from, { chat, ...(text === undefined ? {} : { text }) });
    },
    send(token, from, message) {
      const update: TelegramUpdate = { update_id: nextUpdate++, message: { message_id: nextMessage++, from, chat: { id: from.id, type: 'private' }, date: Math.floor(Date.now() / 1000), ...message } };
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
  const stranger = (token: string, chatId: number) => tg.strangers.has(`${token}:${chatId}`);
  const NOT_STARTED = "Forbidden: bot can't initiate conversation with a user";
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: 60 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req, reply) => {
    const method = req.url.split('/').pop()!.split('?')[0]!;
    tg.calls.push(method);
    if (tg.down || tg.broken.has(method)) return reply.code(502).send('Bad Gateway');
  });
  /* A file lies at the path getFile named, for the bot's token alone. */
  app.get<{ Params: { bot: string; '*': string } }>('/file/:bot/*', async (req, reply) => {
    const bytes = tg.bots.has(req.params.bot.replace(/^bot/, '')) ? tg.files.get(req.params['*'].replace(/^files\//, '')) : undefined;
    if (!bytes) return reply.code(404).send('Not Found');
    return reply.type('application/octet-stream').send(bytes);
  });
  app.post<{ Params: { bot: string; method: string }; Body: Record<string, unknown> | undefined }>('/:bot/:method', async (req, reply) => {
    const token = req.params.bot.replace(/^bot/, '');
    const bot = tg.bots.get(token);
    if (!bot) return reply.code(401).send(refuse(401, 'Unauthorized'));
    const body = req.body ?? {};
    switch (req.params.method) {
      case 'getMe':
        return { ok: true, result: { id: bot.id, is_bot: true, first_name: bot.first_name, username: bot.username } };
      case 'deleteWebhook':
        tg.webhooks.delete(token);
        /* Telegram forgets what waited for the webhook only when asked to. */
        if (body.drop_pending_updates === true) pending.delete(token);
        return { ok: true, result: true };
      case 'getUpdates': {
        if (tg.webhooks.has(token)) return reply.code(409).send(refuse(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"));
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
      case 'getFile': {
        const id = String(body.file_id ?? '');
        const bytes = tg.files.get(id);
        if (!bytes) return reply.code(400).send(refuse(400, 'Bad Request: invalid file_id'));
        if (bytes.length > 20 * 1024 * 1024) return reply.code(400).send(refuse(400, 'Bad Request: file is too big'));
        return { ok: true, result: { file_id: id, file_size: bytes.length, file_path: `files/${id}` } };
      }
      case 'sendMessage': {
        const chatId = Number(body.chat_id);
        if (tg.blocked.has(chatId)) return reply.code(403).send(refuse(403, 'Forbidden: bot was blocked by the user'));
        if (stranger(token, chatId)) return reply.code(403).send(refuse(403, NOT_STARTED));
        const text = String(body.text ?? '');
        if (!text || text.length > 4096) return reply.code(400).send(refuse(400, 'Bad Request: message text is empty or too long'));
        tg.sent.push({ token, chat_id: chatId, text, ...(typeof body.parse_mode === 'string' ? { parse_mode: body.parse_mode } : {}) });
        return { ok: true, result: { message_id: nextMessage++, chat: { id: chatId, type: 'private' }, date: Math.floor(Date.now() / 1000), text } };
      }
      case 'sendChatAction':
        return { ok: true, result: body.action === 'typing' };
      case 'sendDocument': {
        if (!Buffer.isBuffer(req.body)) return reply.code(400).send(refuse(400, 'Bad Request: multipart/form-data expected'));
        const form = await new Request('http://127.0.0.1/sendDocument', {
          method: 'POST',
          headers: { 'content-type': String(req.headers['content-type'] ?? '') },
          body: new Uint8Array(req.body),
        }).formData();
        const chatId = Number(form.get('chat_id'));
        if (tg.blocked.has(chatId)) return reply.code(403).send(refuse(403, `Forbidden: bot ${token} was blocked by the user`));
        if (stranger(token, chatId)) return reply.code(403).send(refuse(403, NOT_STARTED));
        const doc = form.get('document');
        if (!(doc instanceof File) || doc.size === 0 || doc.size > 50 * 1024 * 1024) {
          return reply.code(400).send(refuse(400, 'Bad Request: file must be non-empty and up to 50 MB'));
        }
        const rawCaption = form.get('caption');
        const caption = typeof rawCaption === 'string' && rawCaption.length > 0 ? rawCaption : undefined;
        const bytes = Buffer.from(await doc.arrayBuffer());
        tg.sentDocuments.push({
          token,
          chat_id: chatId,
          file_name: doc.name,
          content_type: doc.type,
          bytes,
          ...(caption !== undefined ? { caption } : {}),
        });
        return {
          ok: true,
          result: {
            message_id: nextMessage++,
            chat: { id: chatId, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            document: { file_id: `doc-${nextMessage}`, file_name: doc.name, mime_type: doc.type, file_size: bytes.length },
            ...(caption !== undefined ? { caption } : {}),
          },
        };
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
