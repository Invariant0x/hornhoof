import { MAX_INSTRUCTIONS } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/errors.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, jobs, tasks, teams } from '../src/db/schema.js';
import { listEvents } from '../src/modules/events/store.js';
import { said } from '../src/modules/conversation/live.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { comment, createTask, updateTask } from '../src/modules/tasks/engine.js';
import { withInputLock } from '../src/modules/conversation/decision-context.js';
import { enqueueTurn, onAgent } from '../src/modules/conversation/queue.js';
import { queueTaskMessage, waitFor } from '../src/modules/tasks/external-wait.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { failureCompany } from './failure-company.js';
import { listen, mcp } from './helpers.js';

async function messaging() {
  const c = await failureCompany();
  await listen(c.app);
  c.sent.mockImplementation((_node, message) => {
    if (message.type === 'agent.say') queueMicrotask(() => said(c.ctx, BUILTIN, message.ref, true));
    return true;
  });
  const run = async (agentId: string, taskId?: string) => {
    const token = `task-message-${agentId}`;
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Work.', status: 'running', taskId, startedAt: new Date(), timeoutMs: 1000, toolTokenHash: hashToken(token) }).returning();
    return { job: job!, client: await mcp(c.app, token) };
  };
  const task = async () => (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Publish images', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true, gates: [] })).task;
  const messages = async (agentId: string) => (await listEvents(c.db, agentId, 0)).filter(e => e.kind === 'message');
  return { ...c, run, task, messages };
}

describe('task messages reach their recipient', () => {
  it.each([
    { team: false, gates: false, review: false },
    { team: false, gates: true, review: false },
    { team: true, gates: false, review: false },
    { team: true, gates: true, review: true },
  ])('delivers the head message and the reply in the running turns: %j', async setup => {
    const c = await messaging();
    if (setup.team) {
      const [team] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Tiger' }).returning();
      await c.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, c.agent.id));
    }
    const task = await c.task();
    if (setup.gates) await c.db.update(tasks).set({ gates: [c.agent.id], ...(setup.review ? { status: 'review', stage: 1, assigneeAgentId: c.head.id, panel: [c.head.id, c.agent.id] } : {}) }).where(eq(tasks.id, task.id));
    const head = await c.run(c.head.id);
    const worker = await c.run(c.agent.id, task.id);
    const sent = await head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: task.number, text: 'The images are ready.' } });
    expect(sent.isError).toBeFalsy();
    expect((await c.messages(c.agent.id)).find(e => e.message?.direction === 'in')).toMatchObject({ jobId: worker.job.id, data: { text: 'The images are ready.', task: { id: task.id, number: task.number } } });
    const reply = await worker.client.callTool({ name: 'message_employee', arguments: { employee: c.head.id, task: task.number, text: 'I have the images.' } });
    expect(reply.isError).toBeFalsy();
    expect((await c.messages(c.head.id)).find(e => e.message?.direction === 'in')).toMatchObject({ jobId: head.job.id, data: { text: 'I have the images.' } });
    expect(c.sent.mock.calls.map(([, m]) => m).filter(m => m.type === 'agent.say')).toHaveLength(2);
  });

  it('lets the orchestrator write to the giver about a child without ending the executor wait', async () => {
    const c = await messaging();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const parent = (await createTask(c.ctx, { agentId: orchestrator!.id }, { title: 'Release', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.head.id })).task;
    const child = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Images', brief: '', body: '', departmentId: c.dev.id, parentId: parent.id, assigneeAgentId: c.agent.id, executor: true, gates: [] })).task;
    await waitFor(c.ctx, c.agent.id, child.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    const head = await c.run(c.head.id, parent.id);
    const sender = await c.run(orchestrator!.id);
    const sent = await sender.client.callTool({ name: 'message_employee', arguments: { employee: c.head.id, task: child.number, text: 'Please check the child task.' } });
    expect(sent.isError).toBeFalsy();
    expect((await c.messages(c.head.id))[0]).toMatchObject({ jobId: head.job.id, data: { task: { id: child.id } } });
    expect((await c.db.select().from(tasks).where(eq(tasks.id, child.id)))[0]!.externalWait).toMatchObject({ reason: 'Registry' });
  });

  it.each([
    { bound: true, missingTerminal: false }, { bound: false, missingTerminal: false },
    { bound: true, missingTerminal: true }, { bound: false, missingTerminal: true },
  ])('returns an error when a live message cannot reach the terminal: %j', async ({ bound, missingTerminal }) => {
    const c = await messaging();
    const task = await c.task();
    const head = await c.run(c.head.id);
    await c.run(c.agent.id, task.id);
    if (missingTerminal) c.ctx.hub.hasTerminals = () => false;
    c.sent.mockImplementation((_node, message) => {
      if (message.type === 'agent.say') queueMicrotask(() => said(c.ctx, BUILTIN, message.ref, false));
      return true;
    });
    const result = await head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, text: 'Do not lose these words.', ...(bound ? { task: task.number } : {}) } });
    expect(result.isError).toBe(true);
    expect(await c.messages(c.agent.id)).toEqual([]);
    expect((await c.turnsOf()).filter(j => j.status === 'queued')).toEqual([]);
  });






  it('starts an idle holder on its task when the bound message is dispatched', async () => {
    const c = await messaging();
    const task = await c.task();
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    const head = await c.run(c.head.id);
    const result = await head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: task.number, text: 'Please submit.' } });
    expect(result.isError).toBeFalsy();
    expect((await c.turnsOf())[0]).toMatchObject({ taskId: task.id, status: 'running' });
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'working', externalWait: null });
  });

  it('delivers a person task message into the running turn through the same path', async () => {
    const c = await messaging();
    const task = await c.task();
    const worker = await c.run(c.agent.id, task.id);
    const result = await c.app.inject({ method: 'POST', url: `/api/agents/${c.agent.id}/messages`, payload: { text: 'Please submit.', task: task.number }, ...c.as(c.ceo) });
    expect(result.statusCode).toBe(202);
    expect((await c.messages(c.agent.id))[0]).toMatchObject({ jobId: worker.job.id, data: { text: 'Please submit.' } });
  });

  it('retains a system notice for the next turn when live input is refused', async () => {
    const c = await messaging();
    await c.run(c.agent.id);
    c.sent.mockImplementation((_node, message) => {
      if (message.type === 'agent.say') queueMicrotask(() => said(c.ctx, BUILTIN, message.ref, false));
      return true;
    });
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'A task needs attention.', createdBy: null, message: { personId: null, text: 'A task needs attention.' } });
    expect(await c.jobOf(id)).toMatchObject({ status: 'queued', prompt: 'A task needs attention.' });
  });

  it('keeps the input lock before the agent line when a message meets a pending decision', async () => {
    const c = await messaging();
    const task = await c.task();
    const worker = await c.run(c.agent.id, task.id);
    let incoming: Promise<string> | undefined;
    await withInputLock(c.ctx, c.agent.id, async () => {
      incoming = queueTaskMessage(c.ctx, { companyId: c.companyId, agentId: c.agent.id, task: task.number, actor: { agentId: c.head.id }, text: 'Check the registry.' }, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Check the registry.', createdBy: null, message: { personId: null, text: 'Check the registry.' } });
      await onAgent(c.ctx, c.agent.id, async () => {});
    });
    expect(await incoming).toBe(worker.job.id);
  }, 3000);

  it('keeps the external wait when the message cannot be dispatched', async () => {
    const c = await messaging();
    const task = await c.task();
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    const head = await c.run(c.head.id);
    c.sent.mockReturnValue(false);
    const result = await head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: task.number, text: 'Please check.' } });
    expect(result.isError).toBe(true);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ reason: 'Registry' });
  });



  it('reports an unexpected failure while restoring the wait', async () => {
    const c = await messaging();
    const task = await c.task();
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    const failure = new ApiError(503, 'conflict', 'The wait could not be restored.');
    c.sent.mockImplementation((_node, message) => {
      if (message.type === 'job.run') vi.spyOn(c.db, 'transaction').mockRejectedValueOnce(failure);
      return false;
    });
    await expect(queueTaskMessage(c.ctx, { companyId: c.companyId, agentId: c.agent.id, task: task.number, actor: { agentId: c.head.id }, text: 'Check.' }, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Check.', createdBy: null, message: { personId: null, text: 'Check.' } })).rejects.toBe(failure);
  });

  it('keeps a newer task action when restoring a wait after a failed dispatch', async () => {
    const c = await messaging();
    const task = await c.task();
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    c.sent.mockReturnValue(false);
    let changed: Promise<unknown> | undefined;
    await expect(queueTaskMessage(c.ctx, { companyId: c.companyId, agentId: c.agent.id, task: task.number, actor: { agentId: c.head.id }, text: 'Check.' }, {
      companyId: c.companyId, agentId: c.agent.id, prompt: 'Check.', createdBy: null, message: { personId: null, text: 'Check.' },
      withMessage: async () => {
        changed = onAgent(c.ctx, c.agent.id, () => updateTask(c.ctx, c.head.id, task.id, { title: 'New instructions' }));
      },
    })).rejects.toMatchObject({ reason: 'agent_not_ready' });
    await changed;
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ title: 'New instructions', externalWait: null });
  });

  it('refuses another wait while the comment still waits in the outbox', async () => {
    const c = await messaging();
    const task = await c.task();
    const input = { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() };
    await waitFor(c.ctx, c.agent.id, task.id, input);
    const commented = await comment(c.ctx, { agentId: c.head.id }, task.id, 'Submit now.');
    await expect(waitFor(c.ctx, c.agent.id, task.id, input)).rejects.toMatchObject({ reason: 'task_invalid' });
    await wakeAll(c.ctx, commented.wakes);
    expect((await c.turnsOf())[0]).toMatchObject({ status: 'running', prompt: expect.stringContaining('Submit now.') });
  });

  it('ends only the recipient task wait after the live message is accepted', async () => {
    const c = await messaging();
    const task = await c.task();
    const other = await c.task();
    const input = { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() };
    await waitFor(c.ctx, c.agent.id, task.id, input);
    await waitFor(c.ctx, c.agent.id, other.id, input);
    const worker = await c.run(c.agent.id, task.id);
    const head = await c.run(c.head.id);
    const result = await head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: task.number, text: 'Submit the work now.' } });
    expect(result.isError).toBeFalsy();
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ externalWait: null, silent: 0 });
    expect((await c.db.select().from(tasks).where(eq(tasks.id, other.id)))[0]!.externalWait).toMatchObject({ reason: 'Registry' });
    expect((await c.messages(c.agent.id))[0]).toMatchObject({ jobId: worker.job.id, data: { text: 'Submit the work now.' } });
    expect((await c.turnsOf()).map(j => j.id)).toEqual([worker.job.id]);
  });

  it('delivers a comment to the running holder and ends its external wait', async () => {
    const c = await messaging();
    const task = await c.task();
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    const worker = await c.run(c.agent.id, task.id);
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.head.id }, task.id, 'Submit both tasks.')).wakes);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toBeNull();
    expect((await c.messages(c.agent.id))[0]).toMatchObject({ jobId: worker.job.id, data: { text: expect.stringContaining('Submit both tasks.') } });
  });


  it('starts an existing queued turn when a comment ends its external wait', async () => {
    const c = await messaging();
    const task = await c.task();
    c.ctx.hub.isReady = () => false;
    await wakeAll(c.ctx, [{ agentId: c.agent.id, taskId: task.id, why: 'assigned' }]);
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    c.ctx.hub.isReady = () => true;
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.head.id }, task.id, 'Submit now.')).wakes);
    expect((await c.turnsOf())[0]).toMatchObject({ status: 'running', prompt: expect.stringContaining('Submit now.') });
  });

  it('keeps a comment in the queued wake that resumes an external wait', async () => {
    const c = await messaging();
    const task = await c.task();
    await c.run(c.agent.id);
    await wakeAll(c.ctx, [{ agentId: c.agent.id, taskId: task.id, why: 'assigned' }]);
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.head.id }, task.id, 'Add the changelog and submit both tasks.')).wakes);
    const queued = (await c.turnsOf()).filter(j => j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.prompt).toContain('Add the changelog and submit both tasks.');
  });

  it('returns an error when the idle recipient turn cannot go out', async () => {
    const c = await messaging();
    const task = await c.task();
    const head = await c.run(c.head.id);
    c.sent.mockReturnValue(false);
    const result = await head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: task.number, text: 'The images are ready.' } });
    expect(result.isError).toBe(true);
    expect((await c.turnsOf()).filter(j => j.status === 'queued')).toEqual([]);
  });


  it('returns an error when the new turn fails before dispatch', async () => {
    const c = await messaging();
    const task = await c.task();
    const head = await c.run(c.head.id);
    await c.db.update(agents).set({ overrides: { base: 'x'.repeat(MAX_INSTRUCTIONS + 1) } }).where(eq(agents.id, c.agent.id));
    const result = await head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: task.number, text: 'Please check.' } });
    expect(result.isError).toBe(true);
    expect((await c.turnsOf()).map(j => j.status)).toEqual(['failed']);
  });

  it('refuses to wait again before reading the queued comment that ended the previous wait', async () => {
    const c = await messaging();
    const task = await c.task();
    await c.run(c.agent.id);
    const input = { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() };
    await waitFor(c.ctx, c.agent.id, task.id, input);
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.head.id }, task.id, 'Submit the work now.')).wakes);
    await expect(waitFor(c.ctx, c.agent.id, task.id, input)).rejects.toMatchObject({ reason: 'task_invalid' });
  });
});
