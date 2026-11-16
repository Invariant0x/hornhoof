import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, errorAnswer, type ErrorReason } from '../../errors.js';
import { FILE_BYTES } from '../tasks/attachments.js';
import { langOf, type BotLang } from '../telegram/words.js';

export const FILES_URL = '/api/assistant/files';
const MB = FILE_BYTES / 1024 / 1024;

/* Why a call was refused, for the assistant's owner, in Russian or English as the program's Accept-Language asks: one
   neutral phrase that reads after "<file name> did not come: ", so the program puts it after the name of what did not go.
   The program decides by status and reason, which stay. */
export const WORDS: Partial<Record<ErrorReason, Record<BotLang, string>>> = {
  assistant_key_invalid: {
    en: "the assistant's key does not open Hornhoof, because it is wrong, was replaced or taken back, or the assistant is switched off. A new key is made on the assistant's card in People.",
    ru: 'ключ помощника не открывает Hornhoof, потому что он неверный, его заменили или отозвали, или помощник выключен. Новый ключ делается на карточке помощника в разделе Люди.',
  },
  assistant_owner_inactive: { en: "you are switched off in Hornhoof now, and the company's owner can switch you on again.", ru: 'сейчас вы выключены в Hornhoof, и включить вас может владелец компании.' },
  assistant_agent_refused: { en: 'in Hornhoof you do not write to this employee.', ru: 'в Hornhoof вы не пишете этому сотруднику.' },
  agent_unknown: { en: 'there is no such employee in Hornhoof, or they were removed.', ru: 'в Hornhoof нет такого сотрудника, или его убрали.' },
  agent_not_ready: {
    en: 'the one it goes to cannot answer right now, for example while they have no plan or machine to work on.',
    ru: 'адресат сейчас не может ответить, например пока у него нет плана или машины для работы.',
  },
  orchestrator_not_ready: { en: 'the orchestrator cannot answer right now.', ru: 'оркестратор сейчас не может ответить.' },
  request_unknown: { en: 'there is no such request in Hornhoof.', ru: 'в Hornhoof нет такого запроса.' },
  request_closed: { en: 'this request is answered already.', ru: 'на этот запрос уже ответили.' },
  decision_not_allowed: { en: 'this decision is not yours to take in Hornhoof.', ru: 'в Hornhoof это решение принимаете не вы.' },
  task_invalid: { en: 'this answer does not fit the request.', ru: 'такой ответ не подходит к запросу.' },
  attachment_unknown: { en: 'there is no such file in Hornhoof, or you cannot open it there.', ru: 'такого файла в Hornhoof нет, или вам его там не открыть.' },
  file_empty: { en: 'the file is empty.', ru: 'файл пустой.' },
  file_too_big: { en: `the file is bigger than ${MB} MB.`, ru: `файл больше ${MB} МБ.` },
  attachment_invalid: { en: "Hornhoof has no room left for the company's files.", ru: 'в Hornhoof закончилось место для файлов компании.' },
};

/* A refusal of an assistant's call, in its owner's words where there are some. A file over the most Hornhoof keeps is
   turned away before its bytes are read. */
export function inOwnersWords(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const tooBig = (err as FastifyError).code === 'FST_ERR_CTP_BODY_TOO_LARGE' && req.routeOptions.url === FILES_URL;
  const refused = tooBig ? new ApiError(413, 'validation', err.message, 'file_too_big') : err;
  const words = refused instanceof ApiError && refused.reason ? WORDS[refused.reason]?.[langOf(req.headers['accept-language'])] : undefined;
  return errorAnswer(words && refused instanceof ApiError ? new ApiError(refused.status, refused.code, words, refused.reason, refused.details) : refused, req, reply);
}
