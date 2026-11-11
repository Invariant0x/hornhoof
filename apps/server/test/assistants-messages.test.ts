import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, requests, taskEvents } from '../src/db/schema.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { as, connectNode, invitePerson, listen, nextOf, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

const state = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;

/* A company with its orchestrator ready on the built-in node, Sales with its head and a worker on the company's key, and
   the CEO's row. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], skillFiles: true });
  await until(async () => (await state(app, ceo)).ready);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [acme] = await db.select().from(companies);
  const [sales] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
  const on = { companyId: acme!.id, subscriptionId: orchestrator!.subscriptionId, model: '' };
  const [head] = await db.insert(agents).values({ ...on, kind: 'head', name: 'Sasha', roleKey: 'SAL-HEAD', departmentId: sales!.id }).returning();
  const [worker] = await db.insert(agents).values({ ...on, kind: 'worker', name: 'Wendy', roleKey: 'SAL-SDR', departmentId: sales!.id }).returning();
  return { app, db, ceo, builtin, orchestrator: orchestrator!, owner: owner!, sales: sales!, head: head!, worker: worker! };
}

type Company = Awaited<ReturnType<typeof company>>;

async function assistantOf(c: Company, session: string, ownerId: string, name = 'Ava'): Promise<{ id: string; key: string }> {
  const { id } = (await c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name, owner: ownerId, program: 'avaclone' }, ...as(session) })).json().person;
  return { id, key: (await c.app.inject({ method: 'POST', url: `/api/people/${id}/key`, ...as(session) })).json().key };
}

const write = (c: Company, key: string, agentId: string, text: string) =>
  c.app.inject({ method: 'POST', url: '/api/assistant/messages', headers: { authorization: `Bearer ${key}` }, payload: { agentId, text } });

describe("an assistant's message", () => {
  it("reaches the orchestrator as the CEO's own words, marked as the assistant's, with administration left to the CEO", async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    const sent = await write(c, ava.key, c.orchestrator.id, 'Plan the launch for next week.');
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toEqual({ message: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), agentId: c.orchestrator.id } });
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain('From Ivan (CEO) through the assistant Ava to Orchestrator:');
    expect(run.prompt).toContain('Plan the launch for next week.');
    expect(run.prompt).toContain("Ava is the personal assistant of Ivan and wrote this for Ivan, at their request. Ivan is the company's owner (the CEO).");
    expect(run.prompt).toContain("Take these words as Ivan's own. Your answer in this window goes back to Ava as plain text");
    expect(run.prompt).not.toContain('except for administration');
    expect(run.prompt).not.toContain('hiring or removing employees');
    const events = (await c.app.inject({ url: '/api/agents/orchestrator/events', ...as(c.ceo) })).json().events;
    expect(events[0]).toMatchObject({ kind: 'message', person: { id: c.owner.id }, data: { text: 'Plan the launch for next week.' }, message: { channel: 'assistant', assistant: { id: ava.id, name: 'Ava' } } });
  });

  it("tells a head that the person responsible for its department wrote through their assistant", async () => {
    const c = await company();
    await invitePerson(c.app, c.ceo, { name: 'Sara', email: 'sara@acme.com', access: { departments: [c.sales.id] } });
    const [sara] = await c.db.select().from(people).where(eq(people.email, 'sara@acme.com'));
    await c.db.update(departments).set({ ownerPersonId: sara!.id }).where(eq(departments.id, c.sales.id));
    const ava = await assistantOf(c, c.ceo, sara!.id, 'Max');
    expect((await write(c, ava.key, c.head.id, 'How are the leads?')).statusCode).toBe(202);
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain('From Sara through the assistant Max to Sasha');
    expect(run.prompt).toContain("Max is the personal assistant of Sara and wrote this for Sara, at their request. Sara is responsible for your department.");
  });

  it('answers the questions its owner takes, one about administering the company too, recorded as the assistant\'s', async () => {
    const c = await company();
    const { task } = await createTask(c.app.ctx, { agentId: c.head.id }, { title: 'Leads', brief: '', body: 'Find leads.', departmentId: c.sales.id, assigneeAgentId: c.worker.id, executor: true });
    const work = (await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'Which region first?', topic: 'task' })).request;
    const machine = (await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'May I use the Mac mini?', topic: 'machines' })).request;
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    expect((await write(c, ava.key, c.worker.id, 'Start with Europe.')).statusCode).toBe(202);
    const [answered] = await c.db.select().from(requests).where(eq(requests.id, work.id));
    expect(answered).toMatchObject({ status: 'answered', answer: 'Start with Europe.', answeredBy: c.owner.id, answeredByAssistantId: ava.id });
    expect((await c.db.select().from(requests).where(eq(requests.id, machine.id)))[0]).toMatchObject({ status: 'answered', answeredBy: c.owner.id, answeredByAssistantId: ava.id });
    const lines = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'answered')));
    expect(lines.map(l => l.data)).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: work.id, assistantId: ava.id }), expect.objectContaining({ requestId: machine.id, assistantId: ava.id })]));
  });

  it('is refused while the agent cannot answer, and for no words', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    expect((await write(c, ava.key, c.head.id, '   ')).statusCode).toBe(400);
    await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.head.id));
    const refused = await write(c, ava.key, c.head.id, 'Hello?');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.reason).toBe('agent_not_ready');
  });
});
