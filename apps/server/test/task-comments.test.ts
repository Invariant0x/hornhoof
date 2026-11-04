import type { ServerMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, tasks } from '../src/db/schema.js';
import { said } from '../src/modules/conversation/live.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { until } from './helpers.js';
import { waitCompany } from './wait-company.js';

describe('comments use the employee input path', () => {
  it('delivers a head comment to the current executor without an external wait', async () => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run(c.agent.id, task.id);
    const head = await c.run(c.head.id);
    const result = await head.client.callTool({ name: 'comment', arguments: { task: task.number, text: 'Submit the work.' } });
    expect(result.isError).toBeFalsy();
    expect((await c.messages(c.agent.id))[0]).toMatchObject({ jobId: worker.job.id, data: { text: expect.stringContaining('Submit the work.') } });
  });

  it('takes a comment that unblocks the executor into the same running turn', async () => {
    const c = await waitCompany();
    const task = await c.task();
    await c.db.update(tasks).set({ status: 'blocked' }).where(eq(tasks.id, task.id));
    const worker = await c.run(c.agent.id, task.id);
    const head = await c.run(c.head.id);
    const result = await head.client.callTool({ name: 'comment', arguments: { task: task.number, text: 'The access is available.' } });
    expect(result.isError).toBeFalsy();
    expect((await c.messages(c.agent.id))[0]).toMatchObject({ jobId: worker.job.id, data: { text: expect.stringContaining('The access is available.') } });
  });

  it.each(['executor', 'reviewer'])('delivers to the active review panel and skips a %s sender', async sender => {
    const c = await waitCompany();
    const task = await c.task();
    const [reviewer] = await c.db.insert(agents).values({ companyId: c.companyId, departmentId: c.dev.id, kind: 'worker', roleKey: 'DEV-BE', name: 'Rita', model: '', subscriptionId: c.sub.id }).returning();
    await c.db.update(tasks).set({ status: 'review', stage: 1, assigneeAgentId: c.head.id, panel: [c.head.id, reviewer!.id], gates: [c.head.id] }).where(eq(tasks.id, task.id));
    const head = await c.run(c.head.id, task.id);
    const peer = await c.run(reviewer!.id, task.id);
    const author = sender === 'reviewer' ? head : await c.run(c.agent.id);
    const result = await author.client.callTool({ name: 'comment', arguments: { task: task.number, text: 'Please check the retry boundary.' } });
    expect(result.isError).toBeFalsy();
    expect((await c.messages(reviewer!.id))[0]).toMatchObject({ jobId: peer.job.id, data: { text: expect.stringContaining('retry boundary') } });
    if (sender === 'executor') expect((await c.messages(c.head.id))[0]).toMatchObject({ jobId: head.job.id });
    else expect(await c.messages(c.head.id)).toEqual([]);
  });

  it('keeps the incoming message uncommitted until the common transport receipt', async () => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run(c.agent.id, task.id);
    const head = await c.run(c.head.id);
    let input: Extract<ServerMessage, { type: 'agent.say' }> | undefined;
    c.sent.mockImplementation((_node, message) => {
      if (message.type === 'agent.say') input = message;
      return true;
    });
    const pending = head.client.callTool({ name: 'comment', arguments: { task: task.number, text: 'Check the new instructions.' } });
    await until(() => !!input);
    expect(await c.messages(c.agent.id)).toEqual([]);
    said(c.ctx, BUILTIN, input!.ref, true);
    expect((await pending).isError).toBeFalsy();
    expect((await c.messages(c.agent.id))[0]).toMatchObject({ jobId: worker.job.id });
  });

  it('retains a refused comment for the normal next-turn delivery', async () => {
    const c = await waitCompany();
    const task = await c.task();
    await c.run(c.agent.id, task.id);
    const head = await c.run(c.head.id);
    c.sent.mockImplementation((_node, message) => {
      if (message.type === 'agent.say') queueMicrotask(() => said(c.ctx, BUILTIN, message.ref, false));
      return true;
    });
    const result = await head.client.callTool({ name: 'comment', arguments: { task: task.number, text: 'Do not lose this comment.' } });
    expect(result.isError).toBeFalsy();
    expect((await c.turnsOf()).filter(job => job.status === 'queued')).toEqual([expect.objectContaining({ prompt: expect.stringContaining('Do not lose this comment.') })]);
  });

  it('refuses another wait before the executor reads an unblock comment', async () => {
    const c = await waitCompany();
    const task = await c.task();
    await c.db.update(tasks).set({ status: 'blocked' }).where(eq(tasks.id, task.id));
    const worker = await c.run();
    const head = await c.run(c.head.id);
    await head.client.callTool({ name: 'comment', arguments: { task: task.number, text: 'The access is available.' } });
    const result = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString() } });
    expect(result.isError).toBe(true);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toBeNull();
  });
});
