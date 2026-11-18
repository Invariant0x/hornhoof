import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/* Hornhoof calls its own routes for the orchestrator, as the company's owner. The secret lives only in this process, so
   nothing from outside can make such a call. */
const SECRET = randomBytes(32).toString('hex');
const HEADERS = { secret: 'x-hornhoof-internal', person: 'x-hornhoof-person', agent: 'x-hornhoof-agent', job: 'x-hornhoof-job', seq: 'x-hornhoof-source-seq' } as const;

export const orchestratorHeaders = (personId: string, agentId: string): Record<string, string> => ({ [HEADERS.secret]: SECRET, [HEADERS.person]: personId, [HEADERS.agent]: agentId });

export const orchestratorJobHeaders = (job: { id: string; agentId: string }): Record<string, string> => ({
  [HEADERS.secret]: SECRET,
  [HEADERS.agent]: job.agentId,
  [HEADERS.job]: job.id,
});

/* A head's department principal and the job that acts on their authority. */
export const orchestratorDecisionHeaders = (d: { personId: string; agentId: string; jobId: string; sourceSeq: number | null }): Record<string, string> => ({
  ...orchestratorHeaders(d.personId, d.agentId),
  [HEADERS.job]: d.jobId,
  [HEADERS.seq]: d.sourceSeq === null ? '' : String(d.sourceSeq),
});

type InternalCall = { personId?: string; agentId: string; decision?: { jobId: string; sourceSeq: number | null } };

/* The person and the orchestrator a call of Hornhoof's own comes for, or null for any other request. */
export function internalCall(req: FastifyRequest): InternalCall | null {
  const given = req.headers[HEADERS.secret];
  if (typeof given !== 'string') return null;
  const bytes = Buffer.from(given);
  if (bytes.length !== SECRET.length || !timingSafeEqual(bytes, Buffer.from(SECRET))) return null;
  const person = req.headers[HEADERS.person];
  const personId = typeof person === 'string' ? person : undefined;
  const agentId = req.headers[HEADERS.agent];
  if (typeof agentId !== 'string') return null;
  const jobId = req.headers[HEADERS.job];
  const seq = req.headers[HEADERS.seq];
  if (typeof jobId !== 'string') return { personId, agentId };
  return { personId, agentId, decision: { jobId, sourceSeq: typeof seq === 'string' && seq ? Number(seq) : null } };
}
