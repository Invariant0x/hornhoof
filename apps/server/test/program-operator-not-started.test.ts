import { asc, eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import type { NodeMessage } from '@hornhoof/protocol';
import { agents, jobs, programOperatorCases } from '../src/db/schema.js';
import { enqueueTurn, pump } from '../src/modules/conversation/queue.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { checkOperatorHealth } from '../src/modules/program-operator/health.js';
import { releaseRecoveryHold } from '../src/modules/program-operator/release.js';
import { operatorCompany } from './program-operator-company.js';

const GIT = 'git remote failed: fatal: bad config line 1 in file .git/config';
const EIO = "EIO: i/o error, open '/data/work/agents/a1/.claude/skills/x/SKILL.md.hh-52'";
const STATUS = { type: 'status', loggedIn: true, limits: null } as const;

/* A company whose agent Bruno runs a turn on its node, with another turn of his queued behind it. */
async function company(withOperator = true) {
  const c = await operatorCompany(withOperator);
  const next = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Next words.', createdBy: null });
  const sentOut = (jobId: string) => c.sent.mock.calls.some(([, frame]) => frame.type === 'job.run' && frame.jobId === jobId);
  /* The node says the turn ended before its program started. */
  const notStarted = (jobId: string, tail = GIT) => handleNodeMessage(c.ctx, c.identity, { type: 'job.done', jobId, ok: false, sessionId: null, result: '', tail, error: 'agent_failed', unstarted: true });
  const status = (workError: string | null) => handleNodeMessage(c.ctx, c.identity, { ...STATUS, workError } as NodeMessage);
  const cases = () => c.db.select().from(programOperatorCases).orderBy(asc(programOperatorCases.openedAt));
  /* The turns that tell someone of a case, with its id in their words. */
  const told = async (caseId: string) => (await c.db.select().from(jobs).where(sql`${jobs.prompt} like ${`%${caseId}%`}`));
  const hireOps = async () => {
    const [rob] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Rob', kind: 'worker', roleKey: 'OPS-PROGRAM', departmentId: c.watcher.departmentId, subscriptionId: c.sub.id, model: '' }).returning();
    const [turn] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: rob!.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Look.', timeoutMs: 1000, status: 'running' }).returning();
    return { id: turn!.id, companyId: c.companyId, agentId: rob!.id };
  };
  return { ...c, next, sentOut, notStarted, status, cases, told, hireOps };
}

it('holds the next turns of an agent whose turn failed before its program started, and tells Operations once', async () => {
  const c = await company();
  await c.notStarted(c.job.id);
  await pump(c.ctx, c.agent.id);
  expect(c.sentOut(c.next)).toBe(false);
  expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
  const [incident, ...more] = await c.cases();
  expect(more).toEqual([]);
  expect(incident).toMatchObject({ agentId: c.agent.id, jobId: c.job.id, nodeId: c.identity.nodeId, recoveryHold: true, status: 'escalated' });
  const notices = await c.told(incident!.id);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ agentId: c.operator!.id });
  for (const part of [GIT, 'Bruno', 'program_screen', 'program_recovery_release']) expect(notices[0]!.prompt, part).toContain(part);
  /* Time passes, and the watch over holds finds nothing more to say. */
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 60 * 60_000));
  expect(await c.told(incident!.id)).toHaveLength(1);
});

it('starts no third turn after the same start failure twice, with one case for Operations', async () => {
  const c = await company();
  const third = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Third words.', createdBy: null });
  await c.notStarted(c.job.id);
  /* The same failure comes again for the turn after, as a node that sent it before the hold would say it. */
  await c.db.update(jobs).set({ status: 'running', nodeId: c.identity.nodeId, startedAt: new Date() }).where(eq(jobs.id, c.next));
  await c.notStarted(c.next);
  await pump(c.ctx, c.agent.id);
  expect(c.sentOut(third)).toBe(false);
  expect(await c.jobOf(third)).toMatchObject({ status: 'queued' });
  expect(await c.cases()).toHaveLength(1);
});

it('keeps the words of the failed turn, and goes on with them and the queue once Operations releases the hold', async () => {
  const c = await company();
  await c.notStarted(c.job.id);
  const [incident] = await c.cases();
  const caller = await c.hireOps();
  expect(await releaseRecoveryHold(c.ctx, caller, { case: incident!.id, reason: 'Fixed the git config.' })).toMatchObject({ result: 'released' });
  expect((await c.cases())[0]).toMatchObject({ status: 'resolved', recoveryHold: false, resolution: { outcome: 'released' } });
  const [again] = await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id));
  expect(again?.prompt).toContain('Words.');
  expect(c.sentOut(again!.id)).toBe(true);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, again!.id));
  await pump(c.ctx, c.agent.id);
  expect(c.sentOut(c.next)).toBe(true);
});

it('holds every agent on a node that cannot write its work folder, and lets them go once the node writes again', async () => {
  const c = await company();
  await c.db.update(agents).set({ nodeId: c.identity.nodeId }).where(eq(agents.id, c.head.id));
  /* Hana's turn waits in the queue as the node fails, not sent yet. */
  const [{ id: other }] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.head.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Head words.', timeoutMs: 1000, status: 'queued' }).returning({ id: jobs.id }) as [{ id: string }];
  await c.status(EIO);
  await c.notStarted(c.job.id, EIO);
  await pump(c.ctx, c.head.id);
  await pump(c.ctx, c.agent.id);
  expect(c.sentOut(other)).toBe(false);
  expect(c.sentOut(c.next)).toBe(false);
  const [incident, ...more] = await c.cases();
  expect(more).toEqual([]);
  expect(incident).toMatchObject({ nodeId: c.identity.nodeId, recoveryHold: true });
  const notices = await c.told(incident!.id);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.prompt).toContain(EIO);
  await c.status(null);
  expect((await c.cases())[0]).toMatchObject({ recoveryHold: false, status: 'resolved' });
  expect(c.sentOut(other)).toBe(true);
});

it('lets Operations release a node that cannot write its work folder', async () => {
  const c = await company();
  await c.status(EIO);
  await c.notStarted(c.job.id, EIO);
  const [incident] = await c.cases();
  const caller = await c.hireOps();
  expect(await releaseRecoveryHold(c.ctx, caller, { case: incident!.id, reason: 'The disk is back.' })).toMatchObject({ result: 'released' });
  const [again] = await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id));
  expect(c.sentOut(again!.id)).toBe(true);
});

it('tells the orchestrator while nobody in Operations can hear, and Operations once one can, in the same words', async () => {
  const c = await company(false);
  await c.notStarted(c.job.id);
  const [incident] = await c.cases();
  const [first] = await c.told(incident!.id);
  expect(first).toMatchObject({ agentId: (await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator')))[0]!.id });
  const caller = await c.hireOps();
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 6 * 60_000));
  const second = (await c.told(incident!.id)).find(job => job.agentId === caller.agentId);
  expect(second?.prompt).toContain('ended before its program started');
  expect(second?.prompt).toContain(GIT);
});

it('leaves a turn whose program started and failed as it was', async () => {
  const c = await company();
  await handleNodeMessage(c.ctx, c.identity, { type: 'job.done', jobId: c.job.id, ok: false, sessionId: null, result: '', tail: GIT, error: 'agent_failed' });
  expect(await c.cases()).toEqual([]);
});
