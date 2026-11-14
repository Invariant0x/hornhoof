import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import { agentEvents, agents, jobs, programOperatorCases, type AgentKind } from '../src/db/schema.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { releaseRecoveryHold } from '../src/modules/program-operator/release.js';
import { readProgramView, reportOperatorCase, sendProgramInput } from '../src/modules/program-operator/tools.js';
import { operatorCompany } from './program-operator-company.js';

/* A person's own assistant is no employee of the company: its owner alone sees it, not the CEO, not the orchestrator and not
   Operations. Its program is nobody else's to look at, type into or recover, whatever id of it a caller found. */

type Caller = { id: string; companyId: string; agentId: string; agentKind: AgentKind; roleKey: string | null };

async function staged() {
  const c = await operatorCompany(true);
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [opsHead] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Olga', kind: 'head', roleKey: 'OPS-HEAD', departmentId: c.ops.id, subscriptionId: c.sub.id, model: '' }).returning();
  const turn = async (agent: typeof agents.$inferSelect): Promise<Caller> => {
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Round.', timeoutMs: 1000, status: 'running' }).returning();
    return { id: job!.id, companyId: c.companyId, agentId: agent.id, agentKind: agent.kind, roleKey: agent.roleKey };
  };
  const now = new Date(); let ordinal = 0;
  const record = (frame: Parameters<typeof acceptOperatorEvidence>[2]) => acceptOperatorEvidence(c.ctx, c.identity, { ...frame, ordinal: ordinal++, evidenceId: randomUUID() }, now);
  /* The node says the words it typed never showed in the program's log. */
  const needed = () => record({ type: 'program.operator_needed', agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, reason: 'assignment_unrecorded', deliveryId: c.delivery.id, evidenceKey: c.delivery.id, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null });
  /* The agent of the program is a person's own assistant. */
  const assistant = () => c.db.update(agents).set({ kind: 'assistant', roleKey: null, departmentId: null }).where(eq(agents.id, c.agent.id));
  /* What goes to the node to look at its program, type into it, ask how it stands or give a case on it, since the mark. */
  const ACTS = ['program.view_get', 'program.input_send', 'program.recovery_state_get', 'program.operator_case'];
  let mark = 0;
  const from = () => { mark = c.sent.mock.calls.length; };
  const reached = () => c.sent.mock.calls.slice(mark).map(([, frame]) => (frame as { type: string }).type).filter(type => ACTS.includes(type));
  const logged = async () => (await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.job.id))).map(e => e.data as Record<string, unknown>).filter(d => d.operatorInputIntent || d.operatorAction || d.recoveryRelease);
  return { ...c, orchestrator: orchestrator!, opsHead: opsHead!, turn, record, needed, assistant, from, reached, logged };
}

it("shows and types into a person's own assistant's program for nobody: the orchestrator, the head of Operations and the program operator are refused", async () => {
  const c = await staged();
  await c.assistant();
  for (const agent of [c.orchestrator, c.opsHead, c.operator!]) {
    const caller = await c.turn(agent);
    await expect(readProgramView(c.ctx, caller, { employee: c.agent.id }), agent.name).rejects.toMatchObject({ status: 403 });
    await expect(sendProgramInput(c.ctx, caller, { employee: c.agent.id, snapshot: randomUUID(), keys: ['Enter'], reason: 'It stands.' }), agent.name).rejects.toMatchObject({ status: 403 });
  }
  expect(c.reached(), 'nothing goes to its program').toEqual([]);
  expect(await c.logged()).toEqual([]);
});

it("opens no case on a person's own assistant's program and calls no program operator to it", async () => {
  const c = await staged();
  await c.record(c.fact);
  await c.assistant();
  await c.needed();
  expect(await c.db.select().from(programOperatorCases)).toEqual([]);
  expect(await c.db.select().from(jobs).where(eq(jobs.agentId, c.operator!.id))).toEqual([]);
  expect(c.reached()).toEqual([]);
});

it('releases no hold and takes no report of a case opened before its agent was a person\'s own assistant', async () => {
  const c = await staged();
  await c.record(c.fact);
  await c.needed();
  const [incident] = await c.db.select().from(programOperatorCases);
  await c.db.update(jobs).set({ status: 'running', nodeId: c.identity.nodeId }).where(eq(jobs.id, incident!.operatorJobId!));
  const operator: Caller = { id: incident!.operatorJobId!, companyId: c.companyId, agentId: c.operator!.id, agentKind: 'worker', roleKey: PROGRAM_OPERATOR_ROLE };
  await c.assistant();
  c.from();
  await expect(releaseRecoveryHold(c.ctx, await c.turn(c.opsHead), { case: incident!.id, reason: 'It stands.' })).rejects.toMatchObject({ status: 403 });
  await expect(reportOperatorCase(c.ctx, operator, { case: incident!.id, outcome: 'failed', text: 'It stands.' })).rejects.toMatchObject({ status: 403 });
  expect((await c.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.id, incident!.id))))[0]).toMatchObject({ status: incident!.status, resolution: incident!.resolution });
  expect(c.reached()).toEqual([]);
  expect(await c.logged()).toEqual([]);
});
