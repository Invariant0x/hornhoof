import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, subscriptions } from '../src/db/schema.js';
import { internalRoute, requireTriage, type TriageCall } from '../src/modules/tasks/question-authority.js';
import { waitCompany } from './wait-company.js';

type C = Awaited<ReturnType<typeof waitCompany>>;
const place = (c: C, departmentId: string | null = c.dev.id) => ({ companyId: c.companyId, departmentId });

describe('who a question goes to inside the company', () => {
  it('takes a worker\'s to the head of its department', async () => {
    const c = await waitCompany();
    expect(await internalRoute(c.db, place(c), c.agent.id)).toEqual({ target: 'head', agentId: c.head.id });
  });

  it('takes a head\'s own to the orchestrator', async () => {
    const c = await waitCompany();
    expect(await internalRoute(c.db, place(c), c.head.id)).toEqual({ target: 'orchestrator', agentId: c.orchestrator.id });
  });

  it('lets the orchestrator look at its own, on a task of no department', async () => {
    const c = await waitCompany();
    expect(await internalRoute(c.db, place(c, null), c.orchestrator.id)).toEqual({ target: 'orchestrator', agentId: c.orchestrator.id });
  });

  it('takes one of a product to the head of the department it is in', async () => {
    const c = await waitCompany();
    const [product] = await c.db.insert(departments).values({ companyId: c.companyId, parentId: c.dev.id, name: 'API', roleCode: 'API' }).returning();
    expect(await internalRoute(c.db, place(c, product!.id), c.agent.id)).toEqual({ target: 'head', agentId: c.head.id });
  });

  it.each([
    ['has left', { removedAt: new Date() }],
    ['is switched off', { switchedOffAt: new Date() }],
  ])('goes past a head who %s, to the orchestrator and never a person', async (_name, change) => {
    const c = await waitCompany();
    await c.db.update(agents).set(change).where(eq(agents.id, c.head.id));
    expect(await internalRoute(c.db, place(c), c.agent.id)).toEqual({ target: 'orchestrator', agentId: c.orchestrator.id });
  });

  it('goes past a head whose plan is gone', async () => {
    const c = await waitCompany();
    const [plan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, ownerPersonId: c.sub.ownerPersonId, provider: c.sub.provider, kind: c.sub.kind, label: 'Gone', status: 'ready', removedAt: new Date() }).returning();
    await c.db.update(agents).set({ subscriptionId: plan!.id }).where(eq(agents.id, c.head.id));
    expect(await internalRoute(c.db, place(c), c.agent.id)).toEqual({ target: 'orchestrator', agentId: c.orchestrator.id });
  });

  it('has no route with neither there', async () => {
    const c = await waitCompany();
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.head.id));
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.orchestrator.id));
    expect(await internalRoute(c.db, place(c), c.agent.id)).toBeNull();
  });
});

describe('who may settle a question or put it before a person', () => {
  const callOf = async (c: C, agentId: string, status: 'running' | 'done' = 'running'): Promise<TriageCall> => {
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Work.', status, startedAt: new Date(), timeoutMs: 900_000 }).returning();
    return { jobId: job!.id, agentId, companyId: c.companyId };
  };
  const source = (c: C, triageAgentId: string | null = null) => ({ ...place(c), triageAgentId });
  const may = (c: C, call: TriageCall, what: 'resolve' | 'classify', on = source(c)) => c.db.transaction(tx => requireTriage(tx, call, on, what));
  const refused = (reason: string) => expect.objectContaining({ status: 403, reason }) as unknown;

  it.each(['resolve', 'classify'] as const)('lets the head of the department %s it', async what => {
    const c = await waitCompany();
    await expect(may(c, await callOf(c, c.head.id), what)).resolves.toEqual({ agentId: c.head.id, role: 'head' });
  });

  it.each(['resolve', 'classify'] as const)('lets the orchestrator %s it', async what => {
    const c = await waitCompany();
    await expect(may(c, await callOf(c, c.orchestrator.id), what)).resolves.toEqual({ agentId: c.orchestrator.id, role: 'orchestrator' });
  });

  it('lets a head of the department a product is in', async () => {
    const c = await waitCompany();
    const [product] = await c.db.insert(departments).values({ companyId: c.companyId, parentId: c.dev.id, name: 'API', roleCode: 'API' }).returning();
    await expect(may(c, await callOf(c, c.head.id), 'classify', { ...source(c), departmentId: product!.id })).resolves.toMatchObject({ role: 'head' });
  });

  it.each(['resolve', 'classify'] as const)('refuses a worker the right to %s, also its own question', async what => {
    const c = await waitCompany();
    await expect(may(c, await callOf(c, c.agent.id), what)).rejects.toEqual(refused('question_not_allowed'));
  });

  it('lets Operations settle what was handed to it, and never put it before a person', async () => {
    const c = await waitCompany();
    const handed = source(c, c.watcher.id);
    const call = await callOf(c, c.watcher.id);
    await expect(may(c, call, 'resolve', handed)).resolves.toEqual({ agentId: c.watcher.id, role: 'triage' });
    await expect(may(c, call, 'classify', handed)).rejects.toEqual(refused('question_not_allowed'));
  });

  it('refuses the head of another department, and one who has moved to it', async () => {
    const c = await waitCompany();
    const [ops] = await c.db.select().from(departments).where(eq(departments.templateKey, 'operations'));
    const [other] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Olga', kind: 'head', roleKey: 'OPS-HEAD', departmentId: ops!.id, subscriptionId: c.sub.id, model: '' }).returning();
    await expect(may(c, await callOf(c, other!.id), 'classify')).rejects.toEqual(refused('question_not_allowed'));
    const call = await callOf(c, c.head.id);
    await c.db.update(agents).set({ kind: 'worker' }).where(eq(agents.id, c.head.id));
    await expect(may(c, call, 'classify')).rejects.toEqual(refused('question_not_allowed'));
  });

  it('refuses one who has left', async () => {
    const c = await waitCompany();
    const call = await callOf(c, c.head.id);
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.head.id));
    await expect(may(c, call, 'classify')).rejects.toEqual(refused('question_not_allowed'));
  });

  it('refuses a turn that is not running now, or is someone else\'s', async () => {
    const c = await waitCompany();
    await expect(may(c, await callOf(c, c.head.id, 'done'), 'classify')).rejects.toEqual(refused('question_not_allowed'));
    const theirs = await callOf(c, c.agent.id);
    await expect(may(c, { ...theirs, agentId: c.head.id }, 'classify')).rejects.toEqual(refused('question_not_allowed'));
  });

  it('refuses a question of another company', async () => {
    const c = await waitCompany();
    const [other] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    await expect(may(c, await callOf(c, c.orchestrator.id), 'classify', { ...source(c), companyId: other!.id })).rejects.toEqual(refused('question_not_allowed'));
  });

  it('gives a person no way in: only a turn of an agent is a caller here, whoever wrote into it', async () => {
    const c = await waitCompany();
    const call = await callOf(c, c.agent.id);
    await c.db.update(jobs).set({ createdBy: c.sub.ownerPersonId, answersCeo: true }).where(eq(jobs.id, call.jobId));
    await expect(may(c, call, 'classify')).rejects.toEqual(refused('question_not_allowed'));
  });
});
