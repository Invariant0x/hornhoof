import type { ServerMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, tasks } from '../src/db/schema.js';
import { said } from '../src/modules/conversation/live.js';
import { createTask, submit } from '../src/modules/tasks/engine.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { BUILTIN } from './builtin.js';
import { until } from './helpers.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { waitCompany } from './wait-company.js';

await prepareSharedDatabase();

describe('comments use the employee input path', () => {
  it('delivers a head comment to the current executor without an external wait', async () => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run(c.agent.id, task.id);
    const head = await c.run(c.head.id);
    const result = await head.client.callTool({ name: 'comment', arguments: { task: task.number, text: 'Submit the work.' } });
    expect(result.isError).toBeFalsy();
    expect((await c.messages(c.agent.id))[0]).toMatchObject({ jobId: worker.job.id, message: { from: { id: c.head.id }, notification: { source: 'comment' } }, data: { actor: { id: c.head.id }, text: expect.stringContaining('Submit the work.') } });
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

  it.each(['head', 'author', 'reviewer'] as const)('delivers only to the current Review owner and skips a %s sender', async sender => {
    const c = await waitCompany();
    await c.db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, c.dev.id));
    await c.db.update(agents).set({ model: 'claude-opus-5-5' }).where(eq(agents.id, c.agent.id));
    const [reviewer] = await c.db.insert(agents).values({ companyId: c.companyId, departmentId: c.dev.id, kind: 'worker', roleKey: 'DEV-REV', name: 'Rita', model: 'claude-opus-5-5', subscriptionId: c.sub.id, skills: ['dev-review-diff'] }).returning();
    const task = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Checked retry', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true, resultKind: 'code', small: true, reviewerAgentId: reviewer!.id, paths: ['logic/totals.ts'] })).task;
    c.ctx.readCommit = async () => ({ branch: `task-${task.number}`, commitSha: HEAD });
    c.ctx.readCompare = async (_repo, refs) => ({ complete: true, baseSha: refs.base, headSha: refs.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
    await submit(c.ctx, c.agent.id, task.id, { summary: 'Implemented', evidence: 'Checked', review: { baseCommit: BASE } });
    const head = await c.run(c.head.id);
    const author = await c.run(c.agent.id);
    const peer = await c.run(reviewer!.id, task.id);
    const from = sender === 'head' ? head : sender === 'author' ? author : peer;
    const result = await from.client.callTool({ name: 'comment', arguments: { task: task.number, text: 'Please check the retry boundary.' } });
    expect(result.isError).toBeFalsy();
    if (sender === 'reviewer') expect(await c.messages(reviewer!.id)).toEqual([]);
    else expect((await c.messages(reviewer!.id))[0]).toMatchObject({ jobId: peer.job.id, data: { text: expect.stringContaining('retry boundary') } });
    expect(await c.messages(c.agent.id)).toEqual([]);
    expect(await c.messages(c.head.id)).toEqual([]);
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
