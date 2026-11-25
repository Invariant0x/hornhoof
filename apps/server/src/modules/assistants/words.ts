import { localeOfHeader, LOCALES } from '@hornhoof/protocol';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { wordsFor } from '../../locales/index.js';
import { ApiError, errorAnswer, type ErrorReason } from '../../errors.js';
import { FILE_BYTES } from '../tasks/file-policy.js';
import { LINK_DAYS } from './files.js';

const MB = FILE_BYTES / 1024 / 1024;

/* Why a call was refused, for the assistant's owner, in the language the program's Accept-Language asks for: one neutral
   phrase that reads after "<file name> did not come: ", so the program puts it after the name of what did not go. The
   program decides by status and reason, which stay. The words are in the files of each language (locales/). */
export function refusalWords(language: string): Partial<Record<ErrorReason, string>> {
  const { file_too_big, file_link_expired, ...plain } = wordsFor(language).refusals;
  return { ...plain, file_too_big: file_too_big(MB), file_link_expired: file_link_expired(LINK_DAYS) };
}

/* The languages an assistant's owner may ask in: the registry's. */
export const REFUSAL_LANGUAGES = LOCALES.map(locale => locale.id);

/* A refusal of an assistant's call, in its owner's words where there are some. */
export function inOwnersWords(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const words = err instanceof ApiError && err.reason ? refusalWords(localeOfHeader(req.headers['accept-language']))[err.reason] : undefined;
  return errorAnswer(words && err instanceof ApiError ? new ApiError(err.status, err.code, words, err.reason, err.details) : err, req, reply);
}
