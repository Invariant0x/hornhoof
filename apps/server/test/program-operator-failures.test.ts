import { randomUUID } from 'node:crypto';
import type { OperatorEvidence } from '@hornhoof/protocol/program-operator';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { jobs, programOperatorCases, tasks } from '../src/db/schema.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { createRoute } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { agentFailureState, agentFailureStates } from '../src/modules/tasks/failures.js';
import { operatorCompany } from './program-operator-company.js';

it.each([
  { status: 'open', prework: false },
  { status: 'escalated', prework: false },
  { status: 'escalated', prework: true },
] as const)('retries an overloaded task with an $status operator case unless prework is held=$prework', async ({ status, prework }) => {
  const c = await operatorCompany(status === 'open');
  const now = new Date();
  const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 1, title: 'Checkout', body: 'Keep working.', status: 'working', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executorAgentId: c.agent.id }).returning();
  await c.db.transaction(tx => createRoute(tx, task!, {}, developmentStages()));
  await c.db.update(jobs).set({ taskId: task!.id }).where(eq(jobs.id, c.job.id));
  let ordinal = 0;
  const record = (frame: OperatorEvidence) => acceptOperatorEvidence(c.ctx, c.identity, { ...frame, evidenceId: randomUUID(), ordinal: ordinal++ }, now);
  await record(c.fact);
  if (!prework) await record({ ...c.fact, phase: 'taken', elapsedMs: 10 });
  await record({ type: 'program.operator_needed', agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, reason: prework ? 'assignment_unrecorded' : 'recorded_no_activity', deliveryId: c.delivery.id, evidenceKey: c.delivery.id, elapsedMs: prework ? 60000 : 300010, sinceLaunchMs: 300010, exit: null });
  const [incident] = await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.agentId, c.agent.id));
  expect(incident).toMatchObject({ status, recoveryHold: prework });

  const failure = { kind: 'overloaded' as const, retryable: true, text: 'The provider is busy.' };
  await handleNodeMessage(c.ctx, c.identity, { type: 'job.done', jobId: c.job.id, ok: false, sessionId: 'same-session', error: 'agent_failed', tail: 'Busy.', result: '', failure }, now);
  const children = await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id));
  expect(children).toHaveLength(prework ? 0 : 1);
  if (!prework) expect(children[0]).toMatchObject({ agentId: c.agent.id, taskId: task!.id, status: 'queued', notBefore: new Date(+now + 60000) });
  expect((await c.db.select().from(tasks).where(eq(tasks.id, task!.id)))[0]).toMatchObject({ status: 'working', assigneeAgentId: c.agent.id, executorAgentId: c.agent.id });
  expect(await c.turnsOf(c.watcher.id)).toEqual([]);
  /* A busy provider is no failure while its retry waits; held with no retry, it is one, for a person to look at. */
  const expected = prework
    ? { retry: null, failure: { kind: 'overloaded', text: 'The provider is busy.', at: +now, tail: 'Busy.' }, obsolete: null }
    : { retry: { attempt: 1, max: 4, at: +now + 60000, kind: 'overloaded' }, failure: null, obsolete: null };
  expect(await agentFailureState(c.ctx, c.agent.id)).toEqual(expected);
  const shown = await agentFailureStates(c.ctx, c.companyId, [c.agent.id, c.watcher.id]);
  expect(shown.get(c.agent.id)).toEqual(expected);
  expect(shown.get(c.watcher.id)).toEqual({ retry: null, failure: null, obsolete: null });
});
