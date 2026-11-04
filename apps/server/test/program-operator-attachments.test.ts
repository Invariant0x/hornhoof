import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, attachments, companies, jobs, nodes, people, personAccess, programInstances, programOperatorCases, requests, sessions, subscriptions, tasks, testParts, testRuns } from '../src/db/schema.js';
import { filesOf, picturesOf } from '../src/modules/tasks/attachments.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { as } from './helpers.js';
import { operatorCompany } from './program-operator-company.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=', 'base64');

async function fixture() {
  const c = await operatorCompany(true);
  const turn = async (agentId: string, companyId = c.companyId) => {
    const token = randomUUID();
    const [job] = await c.db.insert(jobs).values({ companyId, agentId, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Read report.', timeoutMs: 1000, status: 'running', toolTokenHash: hashToken(token) }).returning();
    return { job: job!, token };
  };
  const operator = await turn(c.operator!.id);
  const head = await turn(c.head.id);
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const orchestratorTurn = await turn(orchestrator!.id);
  await c.db.insert(programInstances).values({ id: c.fact.instance, companyId: c.companyId, agentId: c.agent.id, nodeId: c.identity.nodeId });
  const [incident] = await c.db.insert(programOperatorCases).values({ companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, nodeId: c.identity.nodeId, instance: c.fact.instance, reason: 'assignment_unrecorded', evidenceKey: c.delivery.id, capability: randomUUID(), deadlineAt: new Date(Date.now() + 60000), operatorAgentId: c.operator!.id, operatorJobId: operator.job.id, escalationJobId: head.job.id }).returning();
  const [picture] = await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, operatorCaseId: incident!.id, mediaType: 'image/png', bytes: PNG, size: PNG.length }).returning();
  await c.db.update(programOperatorCases).set({ pictureId: picture!.id }).where(eq(programOperatorCases.id, incident!.id));
  const fetchPicture = (token: string, file = picture!.id, ref = `operator-case:${incident!.id}`) => c.app.inject({ method: 'GET', url: `/api/attachments/file?task=${encodeURIComponent(ref)}&file=${encodeURIComponent(file)}`, headers: { authorization: `Bearer ${token}` } });
  const person = async (departmentId: string | null, companyId = c.companyId) => {
    const [p] = await c.db.insert(people).values({ companyId, name: 'Reader', email: `${randomUUID()}@example.test`, status: 'active', scopeKind: departmentId ? 'listed' : 'company' }).returning();
    if (departmentId) await c.db.insert(personAccess).values({ companyId, personId: p!.id, departmentId });
    const token = randomUUID();
    await c.db.insert(sessions).values({ tokenHash: hashToken(token), personId: p!.id, expiresAt: new Date(Date.now() + 60000) });
    return token;
  };
  return { ...c, turn, operatorTurn: operator, headTurn: head, orchestrator: orchestrator!, orchestratorTurn, incident: incident!, picture: picture!, fetchPicture, person };
}

it('downloads the case PNG for its assigned operator, actual report recipient and current orchestrator after resolution', async () => {
  const c = await fixture();
  for (const status of ['open', 'resolved', 'escalated'] as const) {
    await c.db.update(programOperatorCases).set({ status }).where(eq(programOperatorCases.id, c.incident.id));
    if (status !== 'open') await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, c.job.id));
    for (const token of [c.operatorTurn.token, c.headTurn.token, c.orchestratorTurn.token]) {
      const res = await c.fetchPicture(token);
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(PNG)).toBe(true);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-file-name']).toBe('program-question.png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toContain('private');
    }
  }
  expect((await c.fetchPicture((await c.turn(c.head.id)).token)).statusCode).toBe(200);
  await c.db.update(programOperatorCases).set({ pictureId: null }).where(eq(programOperatorCases.id, c.incident.id));
  expect((await c.fetchPicture(c.operatorTurn.token)).statusCode).toBe(200);
});

it('refuses target workers, unrelated workers, unassigned operator turns and foreign jobs with the same generic 404', async () => {
  const c = await fixture();
  const [foreign] = await c.db.insert(companies).values({ name: 'Foreign', singleton: false }).returning();
  const [outsider] = await c.db.insert(agents).values({ companyId: foreign!.id, name: 'Outsider', kind: 'orchestrator', model: '' }).returning();
  const tokens = await Promise.all([c.agent.id, c.watcher.id, c.operator!.id].map(id => c.turn(id)));
  tokens.push(await c.turn(outsider!.id, foreign!.id));
  const unknown = await c.fetchPicture(c.operatorTurn.token, randomUUID());
  expect(unknown.statusCode).toBe(404);
  for (const { token } of tokens) {
    const res = await c.fetchPicture(token);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(unknown.json());
  }
});

it('checks the operator current role, Operations department, enabled state and case assignment', async () => {
  const c = await fixture();
  const changes = [{ roleKey: 'OPS-WATCH' }, { kind: 'head' as const }, { departmentId: c.dev.id }, { departmentId: null }, { switchedOffAt: new Date() }, { removedAt: new Date() }];
  for (const change of changes) {
    await c.db.update(agents).set(change).where(eq(agents.id, c.operator!.id));
    expect((await c.fetchPicture(c.operatorTurn.token)).statusCode).toBe(404);
    await c.db.update(agents).set({ roleKey: c.operator!.roleKey, kind: c.operator!.kind, departmentId: c.operator!.departmentId, switchedOffAt: null, removedAt: null }).where(eq(agents.id, c.operator!.id));
  }
  await c.db.update(programOperatorCases).set({ operatorAgentId: c.watcher.id }).where(eq(programOperatorCases.id, c.incident.id));
  expect((await c.fetchPicture(c.operatorTurn.token)).statusCode).toBe(404);
});

it('checks the report recipient is still the target department head and rejects removed or switched off readers', async () => {
  const c = await fixture();
  const changes = [{ kind: 'worker' as const }, { departmentId: c.watcher.departmentId }, { switchedOffAt: new Date() }, { removedAt: new Date() }];
  for (const change of changes) {
    await c.db.update(agents).set(change).where(eq(agents.id, c.head.id));
    expect((await c.fetchPicture(c.headTurn.token)).statusCode).toBe(404);
    await c.db.update(agents).set({ kind: c.head.kind, departmentId: c.head.departmentId, switchedOffAt: null, removedAt: null }).where(eq(agents.id, c.head.id));
  }
  await c.db.update(jobs).set({ agentId: c.watcher.id }).where(eq(jobs.id, c.headTurn.job.id));
  expect((await c.fetchPicture((await c.turn(c.head.id)).token)).statusCode).toBe(404);
  for (const field of ['switchedOffAt', 'removedAt'] as const) {
    await c.db.update(agents).set({ [field]: new Date() }).where(eq(agents.id, c.orchestrator.id));
    expect((await c.fetchPicture(c.orchestratorTurn.token)).statusCode).toBe(404);
    await c.db.update(agents).set({ [field]: null }).where(eq(agents.id, c.orchestrator.id));
  }
});

it('accepts only the exact case and PNG attachment identity with bounded bytes', async () => {
  const c = await fixture();
  for (const file of ['program-question.png', `../${c.picture.id}`, c.picture.id + '/else']) expect((await c.fetchPicture(c.operatorTurn.token, file)).statusCode).toBe(404);
  for (const ref of ['operator-case:missing', `operator-case:${randomUUID()}`, `operator-case:${c.incident.id}/else`]) expect((await c.fetchPicture(c.operatorTurn.token, c.picture.id, ref)).statusCode).toBe(404);
  for (const change of [{ mediaType: 'image/jpeg' }, { bytes: Buffer.from('plain') }, { bytes: Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]) }, { agentId: c.watcher.id }, { jobId: c.headTurn.job.id }]) {
    await c.db.update(attachments).set(change).where(eq(attachments.id, c.picture.id));
    expect((await c.fetchPicture(c.operatorTurn.token)).statusCode).toBe(404);
    expect((await c.app.inject({ method: 'GET', url: `/api/attachments/${c.picture.id}`, ...as(c.ceo) })).statusCode).toBe(404);
    await c.db.update(attachments).set({ mediaType: 'image/png', bytes: PNG, agentId: c.agent.id, jobId: c.job.id }).where(eq(attachments.id, c.picture.id));
  }
});

it('refuses pictures associated with API and login/test targets', async () => {
  const c = await fixture();
  await c.db.update(subscriptions).set({ kind: 'api_key' }).where(eq(subscriptions.id, c.sub.id));
  expect((await c.fetchPicture(c.operatorTurn.token)).statusCode).toBe(404);
  await c.db.update(subscriptions).set({ kind: 'personal' }).where(eq(subscriptions.id, c.sub.id));
  await c.db.update(jobs).set({ kind: 'test' }).where(eq(jobs.id, c.job.id));
  expect((await c.fetchPicture(c.operatorTurn.token)).statusCode).toBe(404);
});

it('shows the picture to the CEO and people reaching the target, and hides it from unrelated and foreign people', async () => {
  const c = await fixture();
  const [foreign] = await c.db.insert(companies).values({ name: 'Foreign', singleton: false }).returning();
  for (const token of [c.ceo, await c.person(c.dev.id)]) {
    const res = await c.app.inject({ method: 'GET', url: `/api/attachments/${c.picture.id}`, ...as(token) });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
  }
  for (const token of [await c.person(c.watcher.departmentId!), await c.person(null, foreign!.id)]) expect((await c.app.inject({ method: 'GET', url: `/api/attachments/${c.picture.id}`, ...as(token) })).statusCode).toBe(404);
  await c.db.update(programOperatorCases).set({ agentId: c.orchestrator.id, jobId: c.orchestratorTurn.job.id }).where(eq(programOperatorCases.id, c.incident.id));
  await c.db.update(attachments).set({ agentId: c.orchestrator.id, jobId: c.orchestratorTurn.job.id }).where(eq(attachments.id, c.picture.id));
  expect((await c.app.inject({ method: 'GET', url: `/api/attachments/${c.picture.id}`, ...as(await c.person(c.dev.id)) })).statusCode).toBe(404);
  expect((await c.app.inject({ method: 'GET', url: `/api/attachments/${c.picture.id}`, ...as(c.ceo) })).statusCode).toBe(200);
});

it('cannot rebind a target worker case picture as an ordinary request picture or choice', async () => {
  const c = await fixture();
  const task = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Check picture', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true, gates: [] })).task;
  for (const question of [{ kind: 'question' as const, text: 'Look?', images: [c.picture.id] }, { kind: 'choice' as const, text: 'Pick?', options: [{ label: 'One', image: c.picture.id }, { label: 'Two', image: null }] }]) {
    await expect(ask(c.ctx, c.agent.id, task.id, question)).rejects.toMatchObject({ status: 400 });
    const [picture] = await c.db.select().from(attachments).where(eq(attachments.id, c.picture.id));
    expect(picture!.requestId).toBeNull();
  }
});

it('excludes case pictures from ordinary file downloads and request/file listings even with accidental task/request links', async () => {
  const c = await fixture();
  const task = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Check picture', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true, gates: [] })).task;
  const [request] = await c.db.insert(requests).values({ companyId: c.companyId, taskId: task.id, agentId: c.agent.id, kind: 'question', text: 'Look?' }).returning();
  await c.db.update(attachments).set({ taskId: task.id, name: 'program-question.png', requestId: request!.id }).where(eq(attachments.id, c.picture.id));
  for (const file of [c.picture.id, 'program-question.png']) expect((await c.fetchPicture((await c.turn(c.watcher.id)).token, file, String(task.number))).statusCode).toBe(404);
  expect(await filesOf(c.db, task.id)).toEqual([]);
  expect((await picturesOf(c.db, [{ id: request!.id, options: [] }])).get(request!.id)).toEqual([]);
  await c.db.update(tasks).set({ departmentId: c.watcher.departmentId }).where(eq(tasks.id, task.id));
  expect((await c.app.inject({ method: 'GET', url: `/api/attachments/${c.picture.id}`, ...as(await c.person(c.watcher.departmentId!)) })).statusCode).toBe(404);
});

it('keeps case pictures out of node work-file downloads even with an accidental task link', async () => {
  const c = await fixture();
  const task = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Check picture', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true, gates: [] })).task;
  const token = randomUUID();
  await c.db.update(nodes).set({ keyHash: hashToken(token) }).where(eq(nodes.id, c.identity.nodeId));
  const name = 'program-question.png';
  const [run] = await c.db.insert(testRuns).values({ companyId: c.companyId, number: 1, taskId: task.id, agentId: c.agent.id, jobId: c.job.id, kind: 'work', command: 'Read file', files: [name], timeoutMs: 1000 }).returning();
  const [part] = await c.db.insert(testParts).values({ companyId: c.companyId, runId: run!.id, part: 0, status: 'running', nodeId: c.identity.nodeId }).returning();
  await c.db.update(attachments).set({ taskId: task.id, name }).where(eq(attachments.id, c.picture.id));
  const res = await c.app.inject({ method: 'GET', url: `/api/parts/${part!.id}/files/${name}`, headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(404);
});
