import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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

/* Optional handler for unmatched requests that are not errors, like the web app's own routes. */
export type Fallback = (req: FastifyRequest, reply: FastifyReply) => FastifyReply | Promise<FastifyReply> | undefined;

export function registerErrorHandling(app: FastifyInstance, fallback?: Fallback): void {
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
  app.setNotFoundHandler(async (req, reply) => (await fallback?.(req, reply)) ?? reply.status(404).send(body('not_found', 'Not found.')));
}
