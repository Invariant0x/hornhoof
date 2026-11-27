/* The few calls of the Telegram Bot API a head's bot makes, at config.telegramApiUrl. The token goes only into the address
   of a call, so an error here carries Telegram's code and words, never the address or the token. */

export type TelegramUser = { id: number; is_bot: boolean; first_name: string; username?: string; language_code?: string };
/* A file as Telegram gives it in a message: its id to ask getFile for, and what Telegram says of it. */
export type TelegramFile = { file_id: string; file_unique_id?: string; file_size?: number; file_name?: string; mime_type?: string; duration?: number };
type TelegramSticker = TelegramFile & { emoji?: string; set_name?: string; is_animated?: boolean; is_video?: boolean };
export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  reply_to_message?: Pick<TelegramMessage, 'message_id' | 'chat' | 'text' | 'caption'>;
  quote?: { text: string };
  /* The photos and files sent together as one album share it, each in an update of its own. */
  media_group_id?: string;
  /* Each size of one photo, the biggest last. */
  photo?: TelegramFile[];
  document?: TelegramFile;
  voice?: TelegramFile;
  audio?: TelegramFile & { title?: string; performer?: string };
  video?: TelegramFile;
  video_note?: TelegramFile;
  animation?: TelegramFile;
  sticker?: TelegramSticker;
  contact?: { phone_number: string; first_name: string; last_name?: string };
  location?: { latitude: number; longitude: number };
  venue?: { location: { latitude: number; longitude: number }; title: string; address: string };
  poll?: { question: string; options: { text: string }[] };
  forward_origin?: unknown;
};
export type TelegramUpdate = { update_id: number; message?: TelegramMessage };

/* code: Telegram's own, or none when it could not be reached. retryAfter: the seconds it asks to wait, when it asks. */
export class TelegramError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

type Answer = { ok?: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } };

async function postTelegram<T>(base: string, token: string, method: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}/bot${token}/${method}`, init);
  } catch {
    throw new TelegramError(null, 'Telegram could not be reached.');
  }
  const answer = (await res.json().catch(() => null)) as Answer | null;
  if (!answer?.ok) throw refusal(res.status, answer, token);
  return answer.result as T;
}

/* What Telegram refused, in its own words without the bot's token. */
function refusal(status: number, answer: Answer | null, token: string): TelegramError {
  const words = (answer?.description ?? `Telegram answered ${status}.`).replaceAll(token, '[token]');
  return new TelegramError(answer?.error_code ?? status, words, answer?.parameters?.retry_after ?? null);
}

async function callTelegram<T>(base: string, token: string, method: string, params: object, signal?: AbortSignal): Promise<T> {
  return postTelegram<T>(base, token, method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });
}

/* How long getUpdates waits for news before it answers with none, in seconds: Telegram's own long polling. */
const POLL_SECONDS = 30;

export const getMe = (base: string, token: string) => callTelegram<TelegramUser>(base, token, 'getMe', {});

/* A webhook from the bot's earlier life keeps getUpdates refused; taking it off keeps what waits for the bot. */
export const deleteWebhook = (base: string, token: string) => callTelegram<boolean>(base, token, 'deleteWebhook', { drop_pending_updates: false });

export const getUpdates = (base: string, token: string, offset: number, signal: AbortSignal) =>
  callTelegram<TelegramUpdate[]>(base, token, 'getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message'] }, signal);

/* Plain text, with no formatting, so no character in an answer can break it. */
export const sendText = (base: string, token: string, chatId: number, text: string, signal?: AbortSignal) =>
  callTelegram<unknown>(base, token, 'sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }, signal);

export const sendTyping = (base: string, token: string, chatId: number, signal: AbortSignal) =>
  callTelegram<unknown>(base, token, 'sendChatAction', { chat_id: chatId, action: 'typing' }, signal);

const TELEGRAM_SEND_FILE_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_CAPTION_MAX = 1024;

export async function sendDocument(
  base: string,
  token: string,
  chatId: number,
  doc: { bytes: Buffer; name: string; mediaType?: string },
  caption?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!doc.bytes.length || doc.bytes.length > TELEGRAM_SEND_FILE_BYTES) {
    throw new TelegramError(400, 'Bad Request: file must be non-empty and up to 50 MB.');
  }
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([new Uint8Array(doc.bytes)], { type: doc.mediaType ?? 'application/octet-stream' }), doc.name || 'file');
  if (caption?.trim()) form.append('caption', splitForTelegram(caption.trim(), TELEGRAM_CAPTION_MAX)[0]!);
  return postTelegram<unknown>(base, token, 'sendDocument', { method: 'POST', body: form, signal });
}

/* The most one Telegram message holds. */
const TELEGRAM_TEXT_MAX = 4096;

const highHalf = (code: number) => code >= 0xd800 && code <= 0xdbff;

/* A text in pieces Telegram takes: each at most max long, cut after a line break in its second half when there is one,
   and never between the two halves of one character. */
export function splitForTelegram(text: string, max = TELEGRAM_TEXT_MAX): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const atLine = rest.lastIndexOf('\n', max - 1) + 1;
    let cut = atLine > max / 2 ? atLine : max;
    if (highHalf(rest.charCodeAt(cut - 1))) cut -= 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/* The most of one file Telegram gives a bot. */
export const TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;

/* A file of a message, by its id: Telegram names where it lies, and the bytes come from there. The token goes only into the
   address, and never into an error. */
export async function downloadFile(base: string, token: string, fileId: string, signal?: AbortSignal): Promise<Buffer> {
  const file = await callTelegram<{ file_path?: string; file_size?: number }>(base, token, 'getFile', { file_id: fileId }, signal);
  if (!file.file_path) throw new TelegramError(null, 'Telegram gave no path for this file.');
  if ((file.file_size ?? 0) > TELEGRAM_FILE_BYTES) throw new TelegramError(400, 'Bad Request: file is too big');
  let res: Response;
  try {
    res = await fetch(`${base}/file/bot${token}/${file.file_path}`, { signal });
  } catch {
    throw new TelegramError(null, 'Telegram could not be reached.');
  }
  if (!res.ok) throw new TelegramError(res.status, `Telegram answered ${res.status} for a file.`);
  return Buffer.from(await res.arrayBuffer());
}
