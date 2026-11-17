import { randomUUID } from 'node:crypto';
import type { OperatorCheck } from '@hornhoof/protocol/program-operator';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { agentEvents, attachments, jobs, machines, nodes, programOperatorCases, subscriptions } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { encryptSecret } from '../src/crypto/secrets.js';
import { agentCasePicture } from '../src/modules/program-operator/attachments.js';
import { reserveDelivery, wordsDigest } from '../src/modules/program-operator/deliveries.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { renderOperatorScreen } from '../src/modules/program-operator/screen.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { stuckPrograms } from './program-operator-incident.js';

vi.mock('../src/modules/program-operator/screen.js', async original => {
  const actual = await original<typeof import('../src/modules/program-operator/screen.js')>();
  return { ...actual, renderOperatorScreen: vi.fn(actual.renderOperatorScreen) };
});
beforeEach(() => {
  vi.mocked(renderOperatorScreen).mockClear();
});

type Company = Awaited<ReturnType<typeof stuckPrograms>>;
const CELLS = 'Waiting for your input\n> the words nobody sent';
const seen = (values: Partial<OperatorCheck> = {}): OperatorCheck => ({ input: 'text', screen: { cols: 80, rows: 24, cells: CELLS }, ...values });
const render = (cells: string, secrets: string[] = []) => renderOperatorScreen({ cells, cols: 80, rows: 24, secrets }).png;

async function turnOf(c: Company, agentId = c.agent.id) {
  await enqueueTurn(c.ctx, { companyId: c.companyId, agentId, prompt: 'Words.', createdBy: null, message: { personId: null, text: 'Words.', from: 'agent', by: c.head.id, name: c.head.name } });
  return (await c.runningOf(agentId))!;
}
const picturesOf = (c: Company, jobId: string) => c.db.select().from(attachments).where(eq(attachments.jobId, jobId));
const noticesFor = (c: Company, incident: { id: string }) => c.db.select({ job: jobs, data: agentEvents.data }).from(agentEvents).innerJoin(jobs, eq(jobs.id, agentEvents.jobId)).where(sql`${agentEvents.data}->>'programOperatorCase' = ${incident.id}`);

it('the screen and the input line the node saw go with the case of that turn, and with the notice about it', async () => {
  const c = await stuckPrograms(true);
  const turn = await turnOf(c);
  await c.unrecorded(c.agent.id, turn.id, new Date(), seen());
  const incident = await c.caseOf(turn.id);
  const [picture] = await picturesOf(c, turn.id);
  expect(picture).toMatchObject({ operatorCaseId: incident.id, agentId: c.agent.id, mediaType: 'image/png' });
  expect(incident.pictureId).toBe(picture!.id);
  expect(incident.evidence).toMatchObject([{ reason: 'assignment_unrecorded', input: 'text' }]);
  const [notice] = await noticesFor(c, incident);
  expect(notice!.data).toMatchObject({ pictures: [{ id: picture!.id }] });
  expect(notice!.job.prompt).toContain('input line held text that was not sent');
});

it('says nothing of the input line when it was empty', async () => {
  const c = await stuckPrograms(true);
  const turn = await turnOf(c);
  await c.unrecorded(c.agent.id, turn.id, new Date(), seen({ input: 'empty' }));
  const incident = await c.caseOf(turn.id);
  expect(incident.evidence).toMatchObject([{ input: 'empty' }]);
  const [notice] = await noticesFor(c, incident);
  expect(notice!.job.prompt).not.toContain('input line');
});

it('the operator of the case may open the picture, and the program it shows may not', async () => {
  const c = await stuckPrograms(true);
  const turn = await turnOf(c);
  await c.unrecorded(c.agent.id, turn.id, new Date(), seen());
  const incident = await c.caseOf(turn.id);
  const [notice] = await noticesFor(c, incident);
  await c.db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, notice!.job.id));
  const bytes = await agentCasePicture(c.db, { id: notice!.job.id, companyId: c.companyId, agentId: notice!.job.agentId!, agentKind: 'worker', roleKey: 'OPS-PROGRAM', departmentId: null, skills: [] }, `operator-case:${incident.id}`, incident.pictureId!);
  expect(bytes.equals(render(CELLS))).toBe(true);
  await expect(agentCasePicture(c.db, { id: turn.id, companyId: c.companyId, agentId: c.agent.id, agentKind: 'worker', roleKey: null, departmentId: null, skills: [] }, `operator-case:${incident.id}`, incident.pictureId!)).rejects.toMatchObject({ status: 404 });
});

it('keeps the screen only as its masked picture, and keeps no way to press keys on it', async () => {
  const c = await stuckPrograms(true);
  const secret = 'sk-ant-api03-the-plan-secret-1234567890';
  await c.db.update(subscriptions).set({ secretEnc: encryptSecret(secret, c.ctx.config.secret) }).where(eq(subscriptions.id, c.sub.id));
  const turn = await turnOf(c);
  const cells = `${CELLS} ${secret}`;
  await c.unrecorded(c.agent.id, turn.id, new Date(), seen({ screen: { cols: 80, rows: 24, cells } }));
  const [picture] = await picturesOf(c, turn.id);
  expect(Buffer.from(picture!.bytes).equals(render(cells, [secret]))).toBe(true);
  expect(Buffer.from(picture!.bytes).equals(render(cells))).toBe(false);
  const stored = await c.db.select(only(agentEvents, 'data')).from(agentEvents).where(eq(agentEvents.jobId, turn.id));
  expect(JSON.stringify(stored)).not.toContain('the words nobody sent');
  expect(JSON.stringify(stored)).not.toContain(secret);
});

it('a screen of sign-in or terms is drawn as the program shows it: nothing but the values of secrets is hidden', async () => {
  const c = await stuckPrograms(true);
  const turn = await turnOf(c);
  const cells = 'Sign in to go on\n> Accept the terms of use';
  await c.unrecorded(c.agent.id, turn.id, new Date(), seen({ screen: { cols: 80, rows: 24, cells } }));
  const [picture] = await picturesOf(c, turn.id);
  expect(Buffer.from(picture!.bytes).equals(render(cells))).toBe(true);
});

it('the same fact sent again is the same fact: no second picture, case or notice', async () => {
  const c = await stuckPrograms(true);
  const turn = await turnOf(c);
  const { delivery } = await c.unrecorded(c.agent.id, turn.id, new Date(), seen());
  const instance = await c.instanceOf(c.agent.id);
  const evidenceId = randomUUID();
  const again = { type: 'program.operator_needed' as const, agentKey: c.agent.id, jobId: turn.id, instance, evidenceId, ordinal: 5000, reason: 'assignment_unrecorded' as const, deliveryId: delivery.id, evidenceKey: delivery.id, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null, check: seen() };
  expect(await acceptOperatorEvidence(c.ctx, c.identity, again)).toBe(true);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, again)).toBe(true);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { ...again, check: seen({ input: 'empty' }) })).toBe(false);
  expect(await picturesOf(c, turn.id)).toHaveLength(1);
  expect(await c.casesOf(c.agent.id)).toHaveLength(1);
  expect(await noticesFor(c, await c.caseOf(turn.id))).toHaveLength(1);
});

it('a second look at the same turn goes on its case: the latest picture, and no second notice', async () => {
  const c = await stuckPrograms(true);
  const turn = await turnOf(c);
  await c.unrecorded(c.agent.id, turn.id, new Date(), seen({ screen: { cols: 80, rows: 24, cells: 'First look.' } }));
  const first = await c.caseOf(turn.id);
  const later = await reserveDelivery(c.db, { companyId: c.companyId, agentId: c.agent.id, jobId: turn.id, nodeId: c.identity.nodeId, kind: 'assignment', words: 'Words again.', reference: `again:${turn.id}` });
  const instance = await c.instanceOf(c.agent.id);
  await c.record({ type: 'program.delivery', agentKey: c.agent.id, jobId: turn.id, instance, evidenceId: randomUUID(), ordinal: 0, deliveryId: later.id, deliveryOrdinal: later.ordinal, kind: 'assignment', phase: 'attempt', elapsedMs: 0, wordsDigest: wordsDigest('Words again.') });
  await c.record({ type: 'program.operator_needed', agentKey: c.agent.id, jobId: turn.id, instance, evidenceId: randomUUID(), ordinal: 0, reason: 'assignment_unrecorded', deliveryId: later.id, evidenceKey: later.id, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null, check: seen({ input: 'empty', screen: { cols: 80, rows: 24, cells: 'Second look.' } }) });
  const incident = await c.caseOf(turn.id);
  expect(incident.id).toBe(first.id);
  expect(incident.evidence).toMatchObject([{ input: 'text' }, { input: 'empty' }]);
  const [latest] = await c.db.select().from(attachments).where(eq(attachments.id, incident.pictureId!));
  expect(Buffer.from(latest!.bytes).equals(render('Second look.'))).toBe(true);
  expect(await noticesFor(c, incident)).toHaveLength(1);
});

it('a node that could not look still opens the case', async () => {
  const c = await stuckPrograms(true);
  const turn = await turnOf(c);
  await c.unrecorded(c.agent.id, turn.id, new Date(), { input: 'unknown', screen: null });
  const incident = await c.caseOf(turn.id);
  expect(incident).toMatchObject({ status: 'open', pictureId: null, operatorAgentId: expect.any(String) });
  expect(incident.evidence).toMatchObject([{ input: 'unknown' }]);
});

it('a screen that cannot be drawn costs the picture, not the signal', async () => {
  const c = await stuckPrograms(true);
  const turn = await turnOf(c);
  vi.mocked(renderOperatorScreen).mockImplementationOnce(() => { throw new RangeError('Operator screen PNG exceeds 1 MiB.'); });
  await c.unrecorded(c.agent.id, turn.id, new Date(), seen());
  expect(await c.caseOf(turn.id)).toMatchObject({ status: 'open', pictureId: null, evidence: [{ input: 'text' }] });
});

it('a machine that does not hold the turn binds nothing to it, and draws nothing', async () => {
  const c = await stuckPrograms(true);
  const turn = await turnOf(c);
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: randomUUID(), hostname: 'Other' }).returning();
  const [other] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, keyHash: randomUUID(), status: 'ready', version: '0.7.0' }).returning();
  const { delivery, instance } = await c.deliveryFact(c.agent.id, turn.id);
  const frame = { type: 'program.operator_needed' as const, agentKey: c.agent.id, jobId: turn.id, instance, evidenceId: randomUUID(), ordinal: 1, reason: 'assignment_unrecorded' as const, deliveryId: delivery.id, evidenceKey: delivery.id, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null, check: seen() };
  vi.mocked(renderOperatorScreen).mockClear();
  expect(await acceptOperatorEvidence(c.ctx, { kind: 'node', nodeId: other!.id, keyHash: other!.keyHash! }, frame)).toBe(false);
  expect(renderOperatorScreen).not.toHaveBeenCalled();
  expect(await picturesOf(c, turn.id)).toEqual([]);
});

it('with no operator to call, the outcome and the notice of the escalation carry that picture', async () => {
  const c = await stuckPrograms();
  const turn = await turnOf(c);
  await c.unrecorded(c.agent.id, turn.id, new Date(), seen());
  const incident = await c.caseOf(turn.id);
  expect(incident).toMatchObject({ status: 'escalated', resolution: { outcome: 'operator_unavailable', image: incident.pictureId } });
  expect(incident.pictureId).not.toBeNull();
  const [notice] = await noticesFor(c, incident);
  expect(notice!.data).toMatchObject({ pictures: [{ id: incident.pictureId }] });
  expect(notice!.job.agentId).toBe(c.orchestrator.id);
});

it("the orchestrator's failures show people the picture, tell the head of Operations once, and offer that head no picture it may not open", async () => {
  const c = await stuckPrograms();
  const head = await c.opsHead();
  const first = await turnOf(c, c.orchestrator.id);
  await c.unrecorded(c.orchestrator.id, first.id, new Date(), seen());
  await c.failedTurn(first.id);
  await c.retryDue(c.orchestrator.id);
  const second = (await c.runningOf(c.orchestrator.id))!;
  await c.unrecorded(c.orchestrator.id, second.id, new Date(), seen({ input: 'empty' }));
  const [one, two] = await c.casesOf(c.orchestrator.id);
  expect(one!.pictureId).not.toBeNull();
  expect(two!.pictureId).not.toBeNull();
  expect(two!.pictureId).not.toBe(one!.pictureId);
  expect(two!.escalationJobId).toBe(one!.escalationJobId);
  const [notice] = await noticesFor(c, one!);
  expect(notice!.job.agentId).toBe(head.id);
  expect(notice!.data).not.toHaveProperty('pictures');
  const [told] = await c.peopleTold(c.orchestrator.id);
  expect(told!.data).toMatchObject({ pictures: [{ id: one!.pictureId }] });
  expect(await c.peopleTold(c.orchestrator.id)).toHaveLength(1);
});

it('binds nothing when the signal says nothing of a look', async () => {
  const c = await stuckPrograms(true);
  const turn = await turnOf(c);
  await c.unrecorded(c.agent.id, turn.id);
  expect((await c.caseOf(turn.id)).pictureId).toBeNull();
  expect(await c.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.jobId, turn.id), sql`evidence::text like '%input%'`))).toEqual([]);
  expect(await picturesOf(c, turn.id)).toEqual([]);
});
