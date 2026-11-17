import { MAX_INSTRUCTIONS } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ApiError } from '../src/errors.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, jobs, subscriptions, taskRoutes, tasks, taskWaits, teams } from '../src/db/schema.js';
import { listEvents } from '../src/modules/events/store.js';
import { said } from '../src/modules/conversation/live.js';
import { BUILTIN } from './builtin.js';
import { comment, createTask, updateTask } from '../src/modules/tasks/engine.js';
import { withInputLock } from '../src/modules/conversation/decision-context.js';
import { enqueueTurn, holdForWords, onAgent, pump, wordsSettled } from '../src/modules/conversation/queue.js';
import { queueTaskMessage, waitFor } from '../src/modules/tasks/external-wait.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { routeOf } from '../src/modules/tasks/echelons-store.js';
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
  const task = async () => (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Publish images', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true })).task;
  const messages = async (agentId: string) => (await listEvents(c.db, agentId, 0)).filter(e => e.kind === 'message');
  return { ...c, run, task, messages };
}

/* The plan of the recipient at its limit for an hour: a turn that waits for it does not end by itself. */
const planAtLimit = (c: Awaited<ReturnType<typeof messaging>>) => c.db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, c.sub.id));

/* Waits, with no deadline of its own, until what the server does after a call that broke off is done. */
async function settled(done: () => Promise<boolean>): Promise<void> {
  while (!(await done())) await new Promise(resolve => setImmediate(resolve));
}

describe('task messages reach their recipient', () => {
  it.each([
    { team: false, review: false },
    { team: false, review: true },
    { team: true, review: false },
    { team: true, review: true },
  ])('delivers the head message and the reply in the running turns: %j', async setup => {
    const c = await messaging();
    if (setup.team) {
      const [team] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Tiger' }).returning();
      await c.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, c.agent.id));
    }
    const task = await c.task();
    if (setup.review) {
      const route = await routeOf(c.db, task);
      await c.db.update(tasks).set({ status: 'review', assigneeAgentId: c.head.id }).where(eq(tasks.id, task.id));
      await c.db.update(taskRoutes).set({ state: { ...route.state, stage: 'review' } }).where(eq(taskRoutes.taskId, task.id));
    }
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
    const child = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Images', brief: '', body: '', departmentId: c.dev.id, parentId: parent.id, assigneeAgentId: c.agent.id, executor: true })).task;
    await waitFor(c.ctx, c.agent.id, child.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    const head = await c.run(c.head.id, parent.id);
    const sender = await c.run(orchestrator!.id);
    const sent = await sender.client.callTool({ name: 'message_employee', arguments: { employee: c.head.id, task: child.number, text: 'Please check the child task.' } });
    expect(sent.isError).toBeFalsy();
    expect((await c.messages(c.head.id))[0]).toMatchObject({ jobId: head.job.id, data: { task: { id: child.id } } });
    expect((await c.db.select().from(tasks).where(eq(tasks.id, child.id)))[0]!.externalWait).toMatchObject({ reason: 'Registry' });
  });

  it('lets an employee answer the orchestrator on the task it asked about, though the task is not with the employee', async () => {
    const c = await messaging();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const release = (await createTask(c.ctx, { agentId: orchestrator!.id }, { title: 'Release', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.head.id })).task;
    const asker = await c.run(orchestrator!.id);
    const worker = await c.run(c.agent.id);
    const asked = await asker.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: release.number, text: 'Do the images look right?' } });
    expect(asked.isError).toBeFalsy();
    const answer = await worker.client.callTool({ name: 'message_employee', arguments: { employee: orchestrator!.id, task: release.number, text: 'Yes.' } });
    expect(answer.isError).toBeFalsy();
    expect((await c.messages(orchestrator!.id)).find(e => e.message?.direction === 'in')).toMatchObject({ data: { text: 'Yes.', task: { id: release.id } } });
  });

  describe('a message that waits in line for the next turn', () => {
    const IN_LINE = 'Sent to Bruno. It gets this with its next turn, not at once.';
    const send = (client: Awaited<ReturnType<typeof mcp>>, employee: string, text: string, task?: number) =>
      client.callTool({ name: 'message_employee', arguments: { employee, text, ...(task ? { task } : {}) } }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
    const atLimit = (c: Awaited<ReturnType<typeof messaging>>) => c.db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, c.sub.id));
    const pastShare = (c: Awaited<ReturnType<typeof messaging>>) => c.db.update(subscriptions).set({ budget: 50, limits: { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.8, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, c.sub.id));
    /* What a failure collector reads of the messages a sender's turns could not deliver. */
    const undeliveredBy = async (c: Awaited<ReturnType<typeof messaging>>, agentId: string) =>
      (await listEvents(c.db, agentId, 0)).filter(e => e.kind === 'tool_result' && (e.data as { undelivered?: unknown }).undelivered).map(e => ({ jobId: e.jobId, data: e.data }));
    /* The machine of the company key, as Hornhoof sees its line: open before its hello, open past it, or closed. */
    const line = (c: Awaited<ReturnType<typeof messaging>>, state: 'hello_pending' | 'ready' | 'closed') => {
      c.ctx.hub.isOnline = () => state !== 'closed';
      c.ctx.hub.isReady = () => state === 'ready';
    };

    it.each([{ bound: true }, { bound: false }])('keeps a message for a busy employee whose running turn did not take it, for its next turn: %j', async ({ bound }) => {
      const c = await messaging();
      const task = await c.task();
      const head = await c.run(c.head.id);
      const worker = await c.run(c.agent.id, task.id);
      c.sent.mockImplementation((_node, message) => {
        if (message.type === 'agent.say') queueMicrotask(() => said(c.ctx, BUILTIN, message.ref, false));
        return true;
      });
      const result = await send(head.client, c.agent.id, 'Do not lose these words.', bound ? task.number : undefined);
      expect([result.isError, result.content[0]!.text]).toEqual([undefined, IN_LINE]);
      const queued = (await c.turnsOf()).filter(j => j.status === 'queued');
      expect(queued).toHaveLength(1);
      expect(queued[0]!.prompt).toContain('Do not lose these words.');
      expect((await c.jobOf(worker.job.id)).status).toBe('running');
      expect((await c.messages(c.agent.id)).find(e => e.message?.direction === 'in')).toMatchObject({ jobId: queued[0]!.id });
      expect(await undeliveredBy(c, c.head.id)).toEqual([]);
    });

    it('keeps the orchestrator\'s message for a busy employee whose running turn did not take it', async () => {
      const c = await messaging();
      const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
      const sender = await c.run(orchestrator!.id);
      await c.run(c.agent.id);
      c.sent.mockImplementation((_node, message) => {
        if (message.type === 'agent.say') queueMicrotask(() => said(c.ctx, BUILTIN, message.ref, false));
        return true;
      });
      const result = await send(sender.client, c.agent.id, 'Check the release notes.');
      expect(result.isError).toBeFalsy();
      const queued = (await c.turnsOf()).filter(j => j.status === 'queued');
      expect(queued.map(j => j.prompt)).toEqual([expect.stringContaining('Check the release notes.')]);
    });

    it.each([{ bound: true }, { bound: false }])('keeps a message for an employee whose machine is getting back on the line, and sends it once the machine says hello: %j', async ({ bound }) => {
      const c = await messaging();
      const task = await c.task();
      const head = await c.run(c.head.id);
      line(c, 'hello_pending');
      const result = await send(head.client, c.agent.id, 'Wait for me.', bound ? task.number : undefined);
      expect([result.isError, result.content[0]!.text]).toEqual([undefined, 'Sent to Bruno. Its machine is getting back on the line, so the turn starts once it is back.']);
      const [queued, ...more] = (await c.turnsOf()).filter(j => j.status === 'queued');
      expect([queued!.prompt, more]).toEqual([expect.stringContaining('Wait for me.'), []]);
      expect(await undeliveredBy(c, c.head.id)).toEqual([]);
      line(c, 'ready');
      await pump(c.ctx, c.agent.id);
      expect((await c.jobOf(queued!.id)).status).toBe('running');
    });

    it('keeps the orchestrator\'s message for an employee whose machine is getting back on the line, and refuses one with its code once the line is closed', async () => {
      const c = await messaging();
      const task = await c.task();
      const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
      const sender = await c.run(orchestrator!.id);
      line(c, 'hello_pending');
      expect((await send(sender.client, c.agent.id, 'Wait for me.', task.number)).isError).toBeFalsy();
      expect((await c.turnsOf()).filter(j => j.status === 'queued').map(j => j.prompt)).toEqual([expect.stringContaining('Wait for me.')]);
      line(c, 'closed');
      const refused = await send(sender.client, c.agent.id, 'Are you there?', task.number);
      const said = `Not delivered: reason machine_offline, recipient ${c.agent.id}, task #${task.number}.`;
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain(`This employee cannot answer right now. See the window for what to do.\n${said}`);
      expect(await undeliveredBy(c, orchestrator!.id)).toEqual([{ jobId: sender.job.id, data: { ok: false, summary: said, undelivered: { reason: 'machine_offline', recipient: c.agent.id, task: task.number } } }]);
    });

    it.each([{ bound: true }, { bound: false }])('refuses a message for an employee whose machine is off the line, with the code, the employee and the task: %j', async ({ bound }) => {
      const c = await messaging();
      const task = await c.task();
      const head = await c.run(c.head.id);
      line(c, 'closed');
      const result = await send(head.client, c.agent.id, 'Are you there?', bound ? task.number : undefined);
      const said = `Not delivered: reason machine_offline, recipient ${c.agent.id}, task ${bound ? `#${task.number}` : 'none'}.`;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/^Bruno cannot run now\. /);
      expect(result.content[0]!.text.endsWith(`\n${said}`)).toBe(true);
      expect((await c.turnsOf()).filter(j => j.status === 'queued')).toEqual([]);
      expect(await undeliveredBy(c, c.head.id)).toEqual([{ jobId: head.job.id, data: { ok: false, summary: said, undelivered: { reason: 'machine_offline', recipient: c.agent.id, task: bound ? task.number : null } } }]);
    });

    it.each([{ bound: true }, { bound: false }])('keeps a message for a busy employee on a node without live terminals: %j', async ({ bound }) => {
      const c = await messaging();
      const task = await c.task();
      const head = await c.run(c.head.id);
      const worker = await c.run(c.agent.id, task.id);
      c.ctx.hub.hasTerminals = () => false;
      const result = await send(head.client, c.agent.id, 'Do not lose these words.', bound ? task.number : undefined);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toBe(IN_LINE);
      const queued = (await c.turnsOf()).filter(j => j.status === 'queued');
      expect(queued).toHaveLength(1);
      expect(queued[0]!.prompt).toContain('Do not lose these words.');
      expect((await c.jobOf(worker.job.id)).status).toBe('running');
      expect((await c.messages(c.agent.id)).find(e => e.message?.direction === 'in')).toMatchObject({ jobId: queued[0]!.id });
    });

    it.each([{ bound: true }, { bound: false }])('keeps a message for an Antigravity employee at work for its next turn, as Antigravity takes typed words as a turn of its own: %j', async ({ bound }) => {
      const c = await messaging();
      await c.db.update(subscriptions).set({ provider: 'antigravity' }).where(eq(subscriptions.id, c.sub.id));
      /* The node turns down live words for Antigravity, every time. */
      c.sent.mockImplementation((_node, message) => {
        if (message.type === 'agent.say') queueMicrotask(() => said(c.ctx, BUILTIN, message.ref, false));
        return true;
      });
      const task = await c.task();
      const head = await c.run(c.head.id);
      const worker = await c.run(c.agent.id, task.id);
      const result = await send(head.client, c.agent.id, 'Run the browser checks.', bound ? task.number : undefined);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toBe(IN_LINE);
      expect(c.sent.mock.calls.map(([, m]) => m).filter(m => m.type === 'agent.say')).toEqual([]);
      const queued = (await c.turnsOf()).filter(j => j.status === 'queued');
      expect(queued).toHaveLength(1);
      expect(queued[0]!.prompt).toContain('Run the browser checks.');
      expect((await c.jobOf(worker.job.id)).status).toBe('running');
    });

    it('keeps a message behind a turn that waits ahead of it', async () => {
      const c = await messaging();
      const head = await c.run(c.head.id);
      const [ahead] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Try again.', status: 'queued', timeoutMs: 1000, notBefore: new Date(Date.now() + 60_000) }).returning();
      const result = await send(head.client, c.agent.id, 'After your retry.');
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toBe(IN_LINE);
      const queued = (await c.turnsOf()).filter(j => j.status === 'queued');
      expect(queued.map(j => j.id)).toContain(ahead!.id);
      expect(queued).toHaveLength(2);
    });

    it.each([{ bound: true }, { bound: false }])('keeps a message for an idle employee whose window did not take its turn, and sends it on the next try: %j', async ({ bound }) => {
      const c = await messaging();
      const task = await c.task();
      const head = await c.run(c.head.id);
      c.sent.mockReturnValue(false);
      const result = await send(head.client, c.agent.id, 'Take this when you can.', bound ? task.number : undefined);
      expect([result.isError, result.content[0]!.text]).toEqual([undefined, IN_LINE]);
      const [queued, ...more] = (await c.turnsOf()).filter(j => j.status === 'queued');
      expect([queued!.prompt, more]).toEqual([expect.stringContaining('Take this when you can.'), []]);
      expect((await c.turnsOf()).filter(j => j.status === 'failed')).toEqual([]);
      expect(await undeliveredBy(c, c.head.id)).toEqual([]);
      c.sent.mockReturnValue(true);
      await pump(c.ctx, c.agent.id);
      expect((await c.jobOf(queued!.id)).status).toBe('running');
    });

    it('keeps a message whose turn did not go out though only later turns wait behind it', async () => {
      const c = await messaging();
      const head = await c.run(c.head.id);
      c.sent.mockReturnValue(false);
      await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Later.', status: 'queued', timeoutMs: 1000, createdAt: new Date(Date.now() + 60_000) });
      const result = await send(head.client, c.agent.id, 'Goes first and cannot go yet.');
      expect([result.isError, result.content[0]!.text]).toEqual([undefined, IN_LINE]);
      expect((await c.turnsOf()).map(j => j.status)).toEqual(['queued', 'queued']);
    });

    it('keeps a message for an idle employee whose window still gives back the words of its last turn, and sends it once they are in', async () => {
      const c = await messaging();
      const head = await c.run(c.head.id);
      const last = await c.run(c.agent.id);
      /* The clock stands still, so the window's time for the words of the turn that ended does not run out by itself. */
      vi.useFakeTimers({ toFake: ['Date'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      await onAgent(c.ctx, c.agent.id, async () => {
        await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, last.job.id));
        holdForWords(c.ctx, c.agent.id, last.job.id, BUILTIN, new Date());
      });
      const result = await send(head.client, c.agent.id, 'After your last words.');
      expect([result.isError, result.content[0]!.text]).toEqual([undefined, IN_LINE]);
      const [queued, ...more] = (await c.turnsOf()).filter(j => j.status === 'queued');
      expect([queued!.prompt, more]).toEqual([expect.stringContaining('After your last words.'), []]);
      expect(await undeliveredBy(c, c.head.id)).toEqual([]);
      await wordsSettled(c.ctx, BUILTIN, c.agent.id, last.job.id);
      await pump(c.ctx, c.agent.id);
      expect((await c.jobOf(queued!.id)).status).toBe('running');
    });

    it.each([{ bound: true }, { bound: false }])('sends a message once when its sender repeats it in the same turn: %j', async ({ bound }) => {
      const c = await messaging();
      const task = await c.task();
      const head = await c.run(c.head.id);
      c.sent.mockReturnValue(false);
      const first = await send(head.client, c.agent.id, 'Only once, please.', bound ? task.number : undefined);
      expect([first.isError, first.content[0]!.text]).toEqual([undefined, IN_LINE]);
      const again = await send(head.client, c.agent.id, 'Only once, please.', bound ? task.number : undefined);
      expect([again.isError, again.content[0]!.text]).toEqual([undefined, 'Sent to Bruno already in this turn, so this repeat was not sent again.']);
      expect((await c.turnsOf()).map(j => j.status)).toEqual(['queued']);
      expect((await c.messages(c.agent.id)).filter(e => e.message?.direction === 'in').map(e => (e.data as { text: string }).text)).toEqual(['Only once, please.']);
      /* Other words, or the same words from a later turn, go as ever. */
      expect((await send(head.client, c.agent.id, 'And one more thing.', bound ? task.number : undefined)).content[0]!.text).toBe(IN_LINE);
      await c.db.update(jobs).set({ status: 'done', finishedAt: new Date(), toolTokenHash: null }).where(eq(jobs.id, head.job.id));
      const later = await c.run(c.head.id);
      expect((await send(later.client, c.agent.id, 'Only once, please.', bound ? task.number : undefined)).content[0]!.text).toBe(IN_LINE);
      expect((await c.messages(c.agent.id)).filter(e => e.message?.direction === 'in')).toHaveLength(3);
    });

    it('sends a message once when its sender lost the answer of a call that went through, and repeats it', async () => {
      const c = await messaging();
      const head = await c.run(c.head.id);
      const worker = await c.run(c.agent.id);
      /* The window types the words only after the sender's call broke off, as when its connection was reset. */
      let typed: ((ref: string) => void) | null = null;
      const asked = new Promise<string>(resolve => (typed = resolve));
      c.sent.mockImplementation((_node, message) => {
        if (message.type !== 'agent.say') return true;
        if (typed) typed(message.ref);
        else queueMicrotask(() => said(c.ctx, BUILTIN, message.ref, true));
        typed = null;
        return true;
      });
      const broken = new AbortController();
      const lost = head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, text: 'Did this reach you?' } }, undefined, { signal: broken.signal });
      const ref = await asked;
      broken.abort();
      await expect(lost).rejects.toThrow();
      said(c.ctx, BUILTIN, ref, true);
      await settled(async () => (await c.messages(c.agent.id)).some(e => e.message?.direction === 'in'));
      const again = await send(head.client, c.agent.id, 'Did this reach you?');
      expect([again.isError, again.content[0]!.text]).toEqual([undefined, 'Sent to Bruno already in this turn, so this repeat was not sent again.']);
      expect((await c.messages(c.agent.id)).filter(e => e.message?.direction === 'in').map(e => [e.jobId, (e.data as { text: string }).text])).toEqual([[worker.job.id, 'Did this reach you?']]);
      expect(c.sent.mock.calls.map(([, m]) => m).filter(m => m.type === 'agent.say')).toHaveLength(1);
      expect((await c.turnsOf()).map(j => j.status)).toEqual(['running']);
    });

    it('says nothing of a line when the message went into the running turn', async () => {
      const c = await messaging();
      const head = await c.run(c.head.id);
      await c.run(c.agent.id);
      const result = await send(head.client, c.agent.id, 'Right now.');
      expect(result.content[0]!.text).toBe('Sent to Bruno.');
    });

    it('says nothing of a line when the message started a turn', async () => {
      const c = await messaging();
      const head = await c.run(c.head.id);
      const result = await send(head.client, c.agent.id, 'Start now.');
      expect(result.content[0]!.text).toBe('Sent to Bruno.');
      expect((await c.turnsOf())[0]!.status).toBe('running');
    });

    it('still says a message did not go out when the plan of a busy employee is at its limit', async () => {
      const c = await messaging();
      const head = await c.run(c.head.id);
      await c.run(c.agent.id);
      c.ctx.hub.hasTerminals = () => false;
      await atLimit(c);
      const result = await send(head.client, c.agent.id, 'At the limit.');
      const line = `Not delivered: reason plan_at_limit, recipient ${c.agent.id}, task none.`;
      expect([result.isError, result.content[0]!.text]).toEqual([true, `The message did not reach the employee. Check its window and try again.\n${line}`]);
      expect((await c.turnsOf()).filter(j => j.status === 'queued')).toEqual([]);
      /* The turn it would have been, as a failure collector reads it. */
      expect((await c.turnsOf()).filter(j => j.status === 'failed')).toEqual([expect.objectContaining({ error: 'message_not_delivered', result: line })]);
      expect(await undeliveredBy(c, c.head.id)).toEqual([{ jobId: head.job.id, data: { ok: false, summary: line, undelivered: { reason: 'plan_at_limit', recipient: c.agent.id, task: null } } }]);
    });

    it('still says a task message did not go out when the plan of a busy employee used the share set for tasks', async () => {
      const c = await messaging();
      const task = await c.task();
      const head = await c.run(c.head.id);
      await c.run(c.agent.id);
      c.ctx.hub.hasTerminals = () => false;
      await pastShare(c);
      const result = await send(head.client, c.agent.id, 'Past the share.', task.number);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(`\nNot delivered: reason plan_budget, recipient ${c.agent.id}, task #${task.number}.`);
      expect((await c.turnsOf()).filter(j => j.status === 'queued')).toEqual([]);
    });

    it('keeps a message that is no task turn when the plan of a busy employee used the share set for tasks', async () => {
      const c = await messaging();
      const head = await c.run(c.head.id);
      await c.run(c.agent.id);
      c.ctx.hub.hasTerminals = () => false;
      await pastShare(c);
      const result = await send(head.client, c.agent.id, 'People and employees still get through.');
      expect(result.isError).toBeFalsy();
      expect((await c.turnsOf()).filter(j => j.status === 'queued')).toHaveLength(1);
    });
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

  describe('a message meeting a pending decision', () => {
    let c: Awaited<ReturnType<typeof failureCompany>>;
    let task: Awaited<ReturnType<typeof createTask>>['task'];
    let job: typeof jobs.$inferSelect;

    beforeEach(async () => {
      c = await failureCompany();
      c.sent.mockImplementation((_node, message) => {
        if (message.type === 'agent.say') queueMicrotask(() => said(c.ctx, BUILTIN, message.ref, true));
        return true;
      });
      task = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Publish images', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true })).task;
      const [running] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Work.', status: 'running', taskId: task.id, startedAt: new Date(), timeoutMs: 1000 }).returning();
      job = running!;
    });

    it('keeps the input lock before the agent line when a message meets a pending decision', async () => {
      let incoming: Promise<string> | undefined;
      await withInputLock(c.ctx, c.agent.id, async () => {
        incoming = queueTaskMessage(c.ctx, { companyId: c.companyId, agentId: c.agent.id, task: task.number, actor: { agentId: c.head.id }, text: 'Check the registry.' }, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Check the registry.', createdBy: null, message: { personId: null, text: 'Check the registry.' } });
        await onAgent(c.ctx, c.agent.id, async () => {});
        expect((await listEvents(c.db, c.agent.id, 0)).filter(e => e.kind === 'message')).toEqual([]);
      });
      expect(await incoming).toBe(job.id);
      expect((await listEvents(c.db, c.agent.id, 0)).filter(e => e.kind === 'message')).toEqual([
        expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ text: 'Check the registry.' }) }),
      ]);
    }, 3000);
  });

  it('ends the external wait with a message whose turn did not go out yet, as the message waits in line for the holder', async () => {
    const c = await messaging();
    const task = await c.task();
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    const head = await c.run(c.head.id);
    c.sent.mockReturnValue(false);
    const result = await head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: task.number, text: 'Please check.' } });
    expect(result.isError).toBeFalsy();
    expect((await c.turnsOf()).filter(j => j.status === 'queued').map(j => j.prompt)).toEqual([expect.stringContaining('Please check.')]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toBeNull();
    expect((await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, task.id))).map(wait => wait.sourceState.stage)).toEqual(['check_back']);
  });

  it('keeps the external wait when the message is refused', async () => {
    const c = await messaging();
    const task = await c.task();
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    const head = await c.run(c.head.id);
    await planAtLimit(c);
    const result = await head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: task.number, text: 'Please check.' } });
    expect(result.isError).toBe(true);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ reason: 'Registry' });
    expect((await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, task.id))).map(wait => wait.sourceState.stage)).toEqual(['waiting']);
  });



  it('reports an unexpected failure while restoring the wait', async () => {
    const c = await messaging();
    const task = await c.task();
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    const failure = new ApiError(503, 'conflict', 'The wait could not be restored.');
    /* The machine goes off the line as the turn goes to it, so the message is refused, and the next write that takes a
       transaction is the one that brings the wait back. */
    c.sent.mockImplementation((_node, message) => {
      if (message.type !== 'job.run') return true;
      c.ctx.hub.isOnline = () => false;
      c.ctx.hub.isReady = () => false;
      vi.spyOn(c.db, 'transaction').mockRejectedValueOnce(failure);
      return false;
    });
    await expect(queueTaskMessage(c.ctx, { companyId: c.companyId, agentId: c.agent.id, task: task.number, actor: { agentId: c.head.id }, text: 'Check.' }, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Check.', createdBy: null, message: { personId: null, text: 'Check.' } })).rejects.toBe(failure);
    /* The refusal came, and it was the wait's return that failed: the wait is not back. */
    expect((await c.turnsOf()).map(j => [j.status, j.error])).toEqual([['failed', 'message_not_delivered']]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toBeNull();
  });

  it('keeps a newer task action when restoring a wait after a refused message', async () => {
    const c = await messaging();
    const task = await c.task();
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    await planAtLimit(c);
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


  it('brings the comment that ends its external wait into the queued assignment turn, with no second turn', async () => {
    const c = await messaging();
    const task = await c.task();
    c.ctx.hub.isReady = () => false;
    await wakeAll(c.ctx, [{ agentId: c.agent.id, taskId: task.id, why: 'assigned' }]);
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() });
    c.ctx.hub.isReady = () => true;
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.head.id }, task.id, 'Submit now.')).wakes);
    const turns = await c.turnsOf();
    /* The assignment wake names no version, so it stays current and the comment joins it rather than queueing another. */
    expect(turns).toHaveLength(1);
    expect(turns.filter(turn => turn.status === 'running')).toEqual([expect.objectContaining({ taskId: task.id, prompt: expect.stringContaining('Submit now.') })]);
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

  it('returns an error when the new turn fails before dispatch', async () => {
    const c = await messaging();
    const task = await c.task();
    const head = await c.run(c.head.id);
    await c.db.update(agents).set({ overrides: { base: 'x'.repeat(MAX_INSTRUCTIONS + 1) } }).where(eq(agents.id, c.agent.id));
    const result = (await head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: task.number, text: 'Please check.' } })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    /* The turn failed with its own reason, which the refusal names. */
    expect(result.content[0]!.text).toContain(`\nNot delivered: reason instructions_too_long, recipient ${c.agent.id}, task #${task.number}.`);
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
