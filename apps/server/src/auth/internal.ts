import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/* Hornhoof calls its own routes for the orchestrator, as the company's owner. The secret lives only in this process, so
   nothing from outside can make such a call. */
const SECRET = randomBytes(32).toString('hex');
const HEADERS = { secret: 'x-hornhoof-internal', person: 'x-hornhoof-person', agent: 'x-hornhoof-agent', job: 'x-hornhoof-job', seq: 'x-hornhoof-source-seq' } as const;

export const orchestratorHeaders = (personId: string, agentId: string): Record<string, string> => ({ [HEADERS.secret]: SECRET, [HEADERS.person]: personId, [HEADERS.agent]: agentId });

/* A decision the orchestrator takes for the person its turn answers: the person, its turn and the message that says so,
   found by Hornhoof from the turn, never from what the orchestrator gave. */
export const orchestratorDecisionHeaders = (d: { personId: string; agentId: string; jobId: string; sourceSeq: number | null }): Record<string, string> => ({
  ...orchestratorHeaders(d.personId, d.agentId),
  [HEADERS.job]: d.jobId,
  [HEADERS.seq]: d.sourceSeq === null ? '' : String(d.sourceSeq),
});

type InternalCall = { personId: string; agentId: string; decision?: { jobId: string; sourceSeq: number | null } };

/* The person and the orchestrator a call of Hornhoof's own comes for, or null for any other request. */
export function internalCall(req: FastifyRequest): InternalCall | null {
  const given = req.headers[HEADERS.secret];
  if (typeof given !== 'string' || given.length !== SECRET.length || !timingSafeEqual(Buffer.from(given), Buffer.from(SECRET))) return null;
  const personId = req.headers[HEADERS.person];
  const agentId = req.headers[HEADERS.agent];
  if (typeof personId !== 'string' || typeof agentId !== 'string') return null;
  const jobId = req.headers[HEADERS.job];
  const seq = req.headers[HEADERS.seq];
  if (typeof jobId !== 'string') return { personId, agentId };
  return { personId, agentId, decision: { jobId, sourceSeq: typeof seq === 'string' && seq ? Number(seq) : null } };
}
