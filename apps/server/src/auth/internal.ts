import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/* Hornhoof calls its own routes for the orchestrator, as the company's owner. The secret lives only in this process, so
   nothing from outside can make such a call. */
const SECRET = randomBytes(32).toString('hex');
const HEADERS = { secret: 'x-hornhoof-internal', person: 'x-hornhoof-person', agent: 'x-hornhoof-agent' } as const;

export const orchestratorHeaders = (personId: string, agentId: string): Record<string, string> => ({ [HEADERS.secret]: SECRET, [HEADERS.person]: personId, [HEADERS.agent]: agentId });

/* The person and the orchestrator a call of Hornhoof's own comes for, or null for any other request. */
export function internalCall(req: FastifyRequest): { personId: string; agentId: string } | null {
  const given = req.headers[HEADERS.secret];
  if (typeof given !== 'string' || given.length !== SECRET.length || !timingSafeEqual(Buffer.from(given), Buffer.from(SECRET))) return null;
  const personId = req.headers[HEADERS.person];
  const agentId = req.headers[HEADERS.agent];
  return typeof personId === 'string' && typeof agentId === 'string' ? { personId, agentId } : null;
}
