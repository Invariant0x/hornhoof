import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export type ErrorCode = 'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'gone';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const body = (code: ErrorCode, message: string) => ({ error: { code, message } });

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(body(err.code, err.message));
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? first.path.join('.') + ': ' : '';
      return reply.status(400).send(body('validation', where + (first?.message ?? 'Invalid input.')));
    }
    const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status < 500) return reply.status(status).send(body('validation', err.message));
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong.' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(body('not_found', 'Not found.')));
}
