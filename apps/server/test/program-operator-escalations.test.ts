import { and, eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { jobs, programOperatorCases } from '../src/db/schema.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { authorizeOperator } from '../src/modules/program-operator/authorization.js';
import { escalateCase, expireOperatorCases } from '../src/modules/program-operator/cases.js';
import { checkOperatorHealth } from '../src/modules/program-operator/health.js';
import { stuckPrograms } from './program-operator-incident.js';

const letter = 'A report from the head of development.';
const say = (c: Awaited<ReturnType<typeof stuckPrograms>>, agentId: string, text = letter) =>
  enqueueTurn(c.ctx, { companyId: c.companyId, agentId, prompt: text, createdBy: null, message: { personId: null, text, from: 'agent', by: c.head.id, name: c.head.name } });
const noticesTo = async (c: Awaited<ReturnType<typeof stuckPrograms>>, agentId: string) =>
  (await c.turnsOf(agentId)).filter(turn => turn.prompt.includes('Program operator case') || (turn.requestedPrompt ?? '').includes('Program operator case'));

it('a failed program of the orchestrator makes no turn for it: people and the head of Operations hear', async () => {
  const c = await stuckPrograms();
  const head = await c.opsHead();
  await say(c, c.orchestrator.id);
  const first = await c.runningOf(c.orchestrator.id);
  await c.unrecorded(c.orchestrator.id, first!.id);
  expect(await noticesTo(c, c.orchestrator.id)).toEqual([]);
  expect(await noticesTo(c, head.id)).toHaveLength(1);
  const told = await c.peopleTold(c.orchestrator.id);
  expect(told).toHaveLength(1);
  const [incident] = await c.casesOf(c.orchestrator.id);
  expect(JSON.stringify(told)).toContain(c.orchestrator.name);
  expect(JSON.stringify(told)).not.toContain(incident!.capability);
  expect(incident!.escalationJobId).toBe((await noticesTo(c, head.id))[0]!.id);
});

it('ten failures in a row of the orchestrator give one escalation, and never a turn about itself', { timeout: 120_000 }, async () => {
  const c = await stuckPrograms();
  const head = await c.opsHead();
  await say(c, c.orchestrator.id);
  for (let i = 0; i < 10; i++) await c.failsOnce(c.orchestrator.id);
  expect(await c.casesOf(c.orchestrator.id)).toHaveLength(10);
  expect(await noticesTo(c, c.orchestrator.id)).toEqual([]);
  expect(await noticesTo(c, head.id)).toHaveLength(1);
  expect(await c.peopleTold(c.orchestrator.id)).toHaveLength(1);
  await checkOperatorHealth(c.ctx);
  expect(await noticesTo(c, head.id)).toHaveLength(1);
  expect(await c.peopleTold(c.orchestrator.id)).toHaveLength(1);
  /* Nothing is left for the health check to chase: every case points at the one notice. */
  const pending = await c.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.agentId, c.orchestrator.id), eq(programOperatorCases.status, 'escalated'), sql`${programOperatorCases.escalationJobId} is null`));
  expect(pending).toEqual([]);
});

it('tells people once and waits for a head of Operations that is not there yet', async () => {
  const c = await stuckPrograms();
  await say(c, c.orchestrator.id);
  for (let i = 0; i < 3; i++) await c.failsOnce(c.orchestrator.id);
  await checkOperatorHealth(c.ctx);
  expect(await c.peopleTold(c.orchestrator.id)).toHaveLength(1);
  expect(await noticesTo(c, c.orchestrator.id)).toEqual([]);
  const head = await c.opsHead();
  await checkOperatorHealth(c.ctx);
  await checkOperatorHealth(c.ctx);
  expect(await noticesTo(c, head.id)).toHaveLength(1);
  expect(await c.peopleTold(c.orchestrator.id)).toHaveLength(1);
});

it('a head of Operations whose own program failed is not told of itself: the orchestrator is', async () => {
  const c = await stuckPrograms();
  const head = await c.opsHead();
  await say(c, head.id);
  const first = await c.runningOf(head.id);
  await c.unrecorded(head.id, first!.id);
  expect(await noticesTo(c, head.id)).toEqual([]);
  expect(await noticesTo(c, c.orchestrator.id)).toHaveLength(1);
  expect(await c.peopleTold(head.id)).toEqual([]);
});

it('a head whose program an operator denied is not told of itself', async () => {
  const c = await stuckPrograms();
  await say(c, c.head.id);
  const first = await c.runningOf(c.head.id);
  await c.unrecorded(c.head.id, first!.id);
  await c.db.update(programOperatorCases).set({ status: 'open', escalationJobId: null, resolution: null }).where(eq(programOperatorCases.jobId, first!.id));
  const incident = await c.caseOf(first!.id);
  await escalateCase(c.ctx, incident, 'denied', new Date(), { outcome: 'denied', text: 'Denied.', image: null });
  expect(await noticesTo(c, c.head.id)).toEqual([]);
  expect((await noticesTo(c, c.orchestrator.id)).length).toBeGreaterThan(0);
});

it('a turn that succeeded ends the run of failures: the next failure is told again', async () => {
  const c = await stuckPrograms();
  const head = await c.opsHead();
  await say(c, c.orchestrator.id);
  await c.failsOnce(c.orchestrator.id);
  await c.failsOnce(c.orchestrator.id);
  expect(await noticesTo(c, head.id)).toHaveLength(1);
  const healed = await c.runningOf(c.orchestrator.id);
  await c.heard(c.orchestrator.id, healed!.id);
  await say(c, c.orchestrator.id, 'Another letter, later.');
  await c.failsOnce(c.orchestrator.id);
  expect(await noticesTo(c, head.id)).toHaveLength(2);
  expect(await c.peopleTold(c.orchestrator.id)).toHaveLength(2);
});

it('a failure a day after the last one is news again, even though no turn worked in between', async () => {
  const c = await stuckPrograms();
  const head = await c.opsHead();
  await say(c, c.orchestrator.id);
  await c.failsOnce(c.orchestrator.id);
  await c.db.update(programOperatorCases).set({ escalatedAt: new Date(Date.now() - 25 * 60 * 60_000) }).where(eq(programOperatorCases.agentId, c.orchestrator.id));
  await c.failsOnce(c.orchestrator.id);
  expect(await noticesTo(c, head.id)).toHaveLength(2);
  expect(await c.peopleTold(c.orchestrator.id)).toHaveLength(2);
});

it('the notice gives the head of Operations no way into the terminal', async () => {
  const c = await stuckPrograms();
  const head = await c.opsHead();
  await say(c, c.orchestrator.id);
  const running = await c.runningOf(c.orchestrator.id);
  await c.unrecorded(c.orchestrator.id, running!.id);
  const incident = await c.caseOf(running!.id);
  await expect(authorizeOperator(c.ctx, { id: incident.escalationJobId!, companyId: c.companyId, agentId: head.id }, incident.id, c.orchestrator.id)).rejects.toMatchObject({ code: 'forbidden' });
  const [notice] = await noticesTo(c, head.id);
  expect(notice!.prompt).not.toContain(incident.capability);
  expect(JSON.stringify(c.sent.mock.calls.filter(([to]) => to.kind === 'node').map(([, frame]) => frame).filter(frame => frame.type === 'job.run' && frame.jobId === notice!.id))).not.toContain(incident.capability);
});

it('does not collapse what an operator reported itself: each report has its own words', async () => {
  const c = await stuckPrograms();
  const report = (text: string) => ({ outcome: 'needs_owner', text, image: null });
  await say(c, c.agent.id);
  await c.failsOnce(c.agent.id);
  const rows = await c.casesOf(c.agent.id);
  const running = await c.runningOf(c.agent.id);
  await c.unrecorded(c.agent.id, running!.id);
  const [second] = await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.jobId, running!.id));
  for (const [row, text] of [[rows[0]!, 'First question.'], [second!, 'Second question.']] as [typeof programOperatorCases.$inferSelect, string][]) {
    await c.db.update(programOperatorCases).set({ status: 'open', escalationJobId: null, resolution: null }).where(eq(programOperatorCases.id, row.id));
    const [open] = await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.id, row.id));
    await escalateCase(c.ctx, open!, 'needs_owner', new Date(), report(text));
  }
  const notices = await noticesTo(c, c.orchestrator.id);
  expect(notices.filter(n => n.prompt.includes('First question.'))).toHaveLength(1);
  expect(notices.filter(n => n.prompt.includes('Second question.'))).toHaveLength(1);
});

it('with an operator, ten failures wake it once: what it could not fix is not asked of it again', { timeout: 120_000 }, async () => {
  const c = await stuckPrograms(true);
  const head = await c.opsHead();
  await say(c, c.orchestrator.id);
  for (let i = 0; i < 10; i++) {
    const running = await c.runningOf(c.orchestrator.id);
    await c.unrecorded(c.orchestrator.id, running!.id);
    const incident = await c.caseOf(running!.id);
    if (incident.status === 'open') {
      /* Its ten minutes have passed. */
      await c.db.update(programOperatorCases).set({ deadlineAt: new Date(Date.now() - 1000) }).where(eq(programOperatorCases.id, incident.id));
      await expireOperatorCases(c.ctx);
    }
    await c.failedTurn(running!.id);
    await c.retryDue(c.orchestrator.id);
    /* The operator's own turn is over before the next round. */
    await c.db.update(jobs).set({ status: 'done', result: 'Could not fix it.', finishedAt: new Date() }).where(and(eq(jobs.agentId, c.operator!.id), eq(jobs.status, 'running')));
  }
  expect(await noticesTo(c, c.operator!.id)).toHaveLength(1);
  expect(await noticesTo(c, head.id)).toHaveLength(1);
  expect(await noticesTo(c, c.orchestrator.id)).toEqual([]);
});
