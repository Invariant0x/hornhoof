import type { FastifyInstance } from 'fastify';
import { ApiError } from '../../errors.js';

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

// The answers to HTTP-01 challenges live in memory: an order is short, and one app holds one company's link.
export class Challenges {
  private readonly answers = new Map<string, string>();

  answer(token: string, keyAuthorization: string): void {
    this.answers.set(token, keyAuthorization);
  }

  forget(token: string): void {
    this.answers.delete(token);
  }

  get(token: string): string | undefined {
    return this.answers.get(token);
  }
}

// The CA asks with no session and over any port, so this route needs neither and says nothing but the answer.
export function challengeRoutes(app: FastifyInstance, challenges: Challenges): void {
  app.get<{ Params: { token: string } }>('/.well-known/acme-challenge/:token', async (req, reply) => {
    const { token } = req.params;
    const keyAuthorization = TOKEN.test(token) ? challenges.get(token) : undefined;
    if (keyAuthorization === undefined) throw new ApiError(404, 'not_found', 'Not found.');
    return reply.type('text/plain').send(keyAuthorization);
  });
}
