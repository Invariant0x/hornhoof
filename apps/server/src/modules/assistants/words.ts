import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, errorAnswer, type ErrorReason } from '../../errors.js';
import { FILE_BYTES } from '../tasks/attachments.js';
import { langOf, type BotLang } from '../telegram/words.js';

export const FILES_URL = '/api/assistant/files';
const MB = FILE_BYTES / 1024 / 1024;

/* What a refusal tells the assistant's owner, as a person would say it to them, in Russian or English as the program's
   Accept-Language asks. The program passes the words on as they are and decides by status and reason, which stay. */
const WORDS: Partial<Record<ErrorReason, Record<BotLang, string>>> = {
  assistant_key_invalid: {
    en: "This assistant's key does not open Hornhoof: it is wrong, was replaced or taken back, or the assistant is switched off. A new key is made on the assistant's card in People.",
    ru: 'Ключ этого помощника не открывает Hornhoof: он неверный, его заменили или отозвали, или помощник выключен. Новый ключ делается на карточке помощника в разделе Люди.',
  },
  assistant_owner_inactive: {
    en: "You are switched off in Hornhoof now, so nothing can be done there for you. Ask the company's owner about it.",
    ru: 'Сейчас вы выключены в Hornhoof, поэтому там ничего нельзя сделать за вас. Спросите об этом владельца компании.',
  },
  assistant_agent_refused: { en: 'In Hornhoof you do not write to this employee, so nothing went to them.', ru: 'В Hornhoof вы не пишете этому сотруднику, поэтому ему ничего не ушло.' },
  agent_unknown: { en: 'There is no such employee in Hornhoof, or they were removed, so nothing went.', ru: 'В Hornhoof нет такого сотрудника, или его убрали, поэтому ничего не ушло.' },
  agent_not_ready: {
    en: 'The one you write to cannot answer right now, for example while they have no plan or machine to work on, so nothing went. Open Hornhoof to see why, or write again later.',
    ru: 'Тот, кому вы пишете, сейчас не может ответить, например пока у него нет плана или машины для работы, поэтому ничего не ушло. Откройте Hornhoof, чтобы узнать почему, или напишите позже.',
  },
  orchestrator_not_ready: {
    en: 'The orchestrator cannot answer right now, so nothing went. Open Hornhoof to see why, or write again later.',
    ru: 'Оркестратор сейчас не может ответить, поэтому ничего не ушло. Откройте Hornhoof, чтобы узнать почему, или напишите позже.',
  },
  request_unknown: { en: 'There is no such request in Hornhoof.', ru: 'В Hornhoof нет такого запроса.' },
  request_closed: { en: 'This request is answered already, so your answer was not taken.', ru: 'На этот запрос уже ответили, поэтому ваш ответ не принят.' },
  decision_not_allowed: { en: 'This decision is not yours to take in Hornhoof, so your answer was not taken.', ru: 'В Hornhoof это решение принимаете не вы, поэтому ваш ответ не принят.' },
  task_invalid: { en: 'This answer does not fit the request, so it was not taken. Answer it the way it asks.', ru: 'Такой ответ не подходит к запросу, поэтому он не принят. Ответьте так, как он спрашивает.' },
  attachment_unknown: { en: 'There is no such file in Hornhoof, or you cannot open it there.', ru: 'Такого файла в Hornhoof нет, или вам его там не открыть.' },
  file_empty: { en: 'The file is empty, so it did not come through. Send a file with something in it.', ru: 'Файл пустой, поэтому он не дошел. Пришлите файл, в котором что-то есть.' },
  file_too_big: { en: `The file is bigger than ${MB} MB, so it did not come through. Send it in parts or as a link.`, ru: `Файл больше ${MB} МБ, поэтому он не дошел. Пришлите его по частям или ссылкой.` },
  attachment_invalid: {
    en: "The file did not come through: Hornhoof has no room left for the company's files. Ask the company's owner about it.",
    ru: 'Файл не дошел: в Hornhoof закончилось место для файлов компании. Спросите об этом владельца компании.',
  },
};

/* A refusal of an assistant's call, in its owner's words where there are some. A file over the most Hornhoof keeps is
   turned away before its bytes are read. */
export function inOwnersWords(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const tooBig = (err as FastifyError).code === 'FST_ERR_CTP_BODY_TOO_LARGE' && req.routeOptions.url === FILES_URL;
  const refused = tooBig ? new ApiError(413, 'validation', err.message, 'file_too_big') : err;
  const words = refused instanceof ApiError && refused.reason ? WORDS[refused.reason]?.[langOf(req.headers['accept-language'])] : undefined;
  return errorAnswer(words && refused instanceof ApiError ? new ApiError(refused.status, refused.code, words, refused.reason, refused.details) : refused, req, reply);
}
