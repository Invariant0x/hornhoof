import { randomUUID } from 'node:crypto';
import type { OperatorCheck, OperatorEvidence } from '@hornhoof/protocol/program-operator';
import { and, asc, eq, sql } from 'drizzle-orm';
import { agentEvents, agents, jobs, programInstances, programOperatorCases } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { pump } from '../src/modules/conversation/queue.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { wordsDigest } from '../src/modules/program-operator/deliveries.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { operatorCompany } from './program-operator-company.js';

type Run = { type: string; jobId: string; prompt: string; operatorDelivery?: { id: string; ordinal: number }; operatorSourceDelivery?: { id: string; ordinal: number } };

/* A company whose programs work on and do not record the words they are given: one that did something since these words keeps
   no recovery hold, so each turn fails and the next one goes out. One that did nothing since them waits on a hold instead. */
export async function stuckPrograms(withOperator = false) {
  const c = await operatorCompany(withOperator);
  await c.db.update(jobs).set({ status: 'done', result: 'Earlier work.', finishedAt: new Date(0) }).where(eq(jobs.id, c.job.id));
  const [orchestrator] = await c.db.select().from(agents).where(and(eq(agents.companyId, c.companyId), eq(agents.kind, 'orchestrator')));
  const opsHead = () => c.db.insert(agents).values({ companyId: c.companyId, name: 'Olga', kind: 'head', roleKey: 'OPS-HEAD', departmentId: c.watcher.departmentId, subscriptionId: c.sub.id, model: '' }).returning().then(rows => rows[0]!);

  const instances = new Map<string, string>();
  const instanceOf = async (agentId: string) => {
    const known = instances.get(agentId);
    if (known) return known;
    const [row] = await c.db.insert(programInstances).values({ id: randomUUID(), companyId: c.companyId, agentId, nodeId: c.identity.nodeId, launched: true, active: true }).returning();
    instances.set(agentId, row!.id);
    return row!.id;
  };

  let ordinal = 1000;
  const record = (frame: OperatorEvidence, at = new Date()) => acceptOperatorEvidence(c.ctx, c.identity, { ...frame, evidenceId: randomUUID(), ordinal: ordinal++ }, at);
  const runs = () => c.sent.mock.calls.map(([, frame]) => frame as unknown as Run).filter(frame => frame.type === 'job.run');
  const runOf = (jobId: string) => runs().find(run => run.jobId === jobId);
  const runningOf = async (agentId: string) => (await c.db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'running'))))[0];

  async function deliveryFact(agentId: string, jobId: string) {
    const run = runOf(jobId)!, delivery = run.operatorDelivery!, instance = await instanceOf(agentId);
    const fact: OperatorEvidence = { type: 'program.delivery', agentKey: agentId, jobId, instance, evidenceId: randomUUID(), ordinal: 0, deliveryId: delivery.id, deliveryOrdinal: delivery.ordinal, kind: 'assignment', phase: 'attempt', elapsedMs: 0, wordsDigest: wordsDigest(run.prompt) };
    return { fact, delivery, instance };
  }

  /* What the node reports of a turn whose words stay unrecorded for a minute, from a program that did nothing since them. */
  async function unrecordedIdle(agentId: string, jobId: string, at = new Date(), check?: OperatorCheck, worked = false) {
    const { fact, delivery, instance } = await deliveryFact(agentId, jobId);
    await record(fact, at);
    if (worked) await record({ ...fact, phase: 'activity', elapsedMs: 100 } as typeof fact, at);
    await record({ type: 'program.operator_needed', agentKey: agentId, jobId, instance, evidenceId: randomUUID(), ordinal: 0, reason: 'assignment_unrecorded', deliveryId: delivery.id, evidenceKey: delivery.id, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null, ...(check ? { check } : {}) }, at);
    return { fact, delivery };
  }

  /* The same from a program that did something since them. */
  const unrecorded = (agentId: string, jobId: string, at = new Date(), check?: OperatorCheck) => unrecordedIdle(agentId, jobId, at, check, true);

  const caseOf = async (jobId: string) => (await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.jobId, jobId)))[0]!;
  const casesOf = (agentId: string) => c.db.select().from(programOperatorCases).where(eq(programOperatorCases.agentId, agentId)).orderBy(asc(programOperatorCases.openedAt));

  /* What the node does once the server revoked the case: the turn fails, never retryable. */
  const failedTurn = async (jobId: string, at = new Date()) => {
    const incident = await caseOf(jobId);
    const outcome = incident.resolution?.outcome ?? 'operator_timeout';
    await handleNodeMessage(c.ctx, c.identity, { type: 'job.done', jobId, ok: false, sessionId: 'session', error: 'agent_failed', tail: 'Failed.', result: '', failure: { kind: 'unknown', retryable: false, text: `Program operator recovery ended: ${outcome}; case ${incident.id}.` } }, at);
  };

  /* The program took these words after all, and its turn ended well. */
  const heard = async (agentId: string, jobId: string, at = new Date()) => {
    const { fact } = await deliveryFact(agentId, jobId);
    await record(fact, at);
    await record({ ...fact, phase: 'taken', elapsedMs: 100 }, at);
    await handleNodeMessage(c.ctx, c.identity, { type: 'job.done', jobId, ok: true, sessionId: 'session', tail: 'Done.', result: 'Done.', error: null }, at);
  };

  /* Time passes until whatever waits for its retry may go. */
  const retryDue = async (agentId: string) => {
    await c.db.update(jobs).set({ notBefore: new Date(Date.now() - 1000) }).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued'), sql`${jobs.notBefore} is not null`));
    await pump(c.ctx, agentId);
  };

  /* One whole round of the incident: the running turn's words stay unrecorded, it fails, and its retry goes out. */
  const failsOnce = async (agentId: string) => {
    const running = await runningOf(agentId);
    await unrecorded(agentId, running!.id);
    await failedTurn(running!.id);
    await retryDue(agentId);
    return running!;
  };

  const peopleTold = async (agentId: string) => (await c.db.select(only(agentEvents, 'data')).from(agentEvents).where(and(eq(agentEvents.agentId, agentId), sql`${agentEvents.data}->>'operatorEscalation' is not null`)));
  const continuationsOf = (jobId: string) => c.db.select().from(jobs).where(eq(jobs.continueOf, jobId));

  return { ...c, orchestrator: orchestrator!, opsHead, record, deliveryFact, runs, runOf, runningOf, unrecorded, unrecordedIdle, caseOf, casesOf, failedTurn, heard, retryDue, failsOnce, peopleTold, continuationsOf, instanceOf };
}
