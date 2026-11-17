import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AuthorCheckDone } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { WebSocket } from 'ws';
import { jobs, subscriptions, taskEvents } from '../src/db/schema.js';
import { NodeHub, ownBuiltin } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { requestAuthorCheck, recordAuthorCheck } from '../src/modules/tasks/author-check.js';
import { submit, updateTask } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

async function setup() {
  const f = await fixture({ authorProvider: 'claude' });
  await f.db.update(subscriptions).set({ kind: 'api_key' }).where(eq(subscriptions.id, f.claude.id));
  const [job] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: f.author.id, subscriptionId: f.claude.id,
    taskId: f.task.id, kind: 'conversation', prompt: '', timeoutMs: 900_000, status: 'running' }).returning();
  const node = ownBuiltin(f.ctx.config), sent: unknown[] = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)), ping: () => {}, close: () => {}, terminate: () => {} });
  const hub = new NodeHub({ pingMs: 60_000, onMessage: async () => {}, onClose: async () => {} });
  onTestFinished(() => hub.stop());
  hub.attach(node, socket as unknown as WebSocket);
  hub.greet(node);
  f.ctx.hub = hub;
  f.ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: 'task' in want ? HEAD : BASE });
  const request = await requestAuthorCheck(f.ctx, f.author.id, job!.id, f.task.id);
  const completed: AuthorCheckDone = { ...request, type: 'author_check.done', exitCode: 0, crap: { kind: 'measured', max: 2 }, reason: null,
    startedAt: '2026-11-17T00:00:00.000Z', finishedAt: '2026-11-17T00:00:01.000Z' };
  const receipts = async () => (await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id))).filter(event => event.data.authorCheck);
  return { ...f, node, sent, job: job!, request, completed, receipts };
}

describe('server-pinned author check receipts', () => {
  it('pins its own repository and both commits and accepts one immutable node result', async () => {
    const f = await setup();
    expect(f.sent).toEqual([f.request]);
    expect(f.request).toMatchObject({ repoUrl: 'https://github.com/acme/shop.git', baseCommit: BASE, commit: HEAD, branch: `task-${f.task.number}` });
    await handleNodeMessage(f.ctx, f.node, f.completed);
    await recordAuthorCheck(f.ctx, f.node, f.completed);
    const receipts = await f.receipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ agentId: null, personId: null, data: { authorCheck: f.completed } });
    const moved = await submit(f.ctx, f.author.id, f.task.id, { summary: 'Ready.', evidence: 'Checked.', review: { baseCommit: BASE } });
    expect(moved.task.assigneeAgentId).toBe(f.tester.id);
  });

  it.each(['node', 'sha', 'base', 'task', 'repo', 'job', 'request'] as const)('refuses a result bound to another %s', async field => {
    const f = await setup();
    const result = { ...f.completed };
    if (field === 'sha') result.commit = 'c'.repeat(40);
    if (field === 'base') result.baseCommit = 'c'.repeat(40);
    if (field === 'task') result.taskId = randomUUID();
    if (field === 'repo') result.repoUrl = 'https://github.com/other/shop.git';
    if (field === 'job') result.jobId = randomUUID();
    if (field === 'request') result.requestId = randomUUID();
    await recordAuthorCheck(f.ctx, field === 'node' ? { kind: 'builtin', machine: 'different' } : f.node, result);
    expect(await f.receipts()).toHaveLength(0);
  });

  it('does not reuse a receipt after a risk change creates a new route revision', async () => {
    const f = await setup();
    await updateTask(f.ctx, f.head.id, f.task.id, { riskClass: 'security' });
    await recordAuthorCheck(f.ctx, f.node, f.completed);
    expect(await f.receipts()).toHaveLength(0);
  });

  it('refuses another author or a job that belongs to another employee', async () => {
    const f = await setup();
    await expect(requestAuthorCheck(f.ctx, f.reviewer.id, f.job.id, f.task.id)).rejects.toMatchObject({ status: 409 });
    await expect(requestAuthorCheck(f.ctx, f.author.id, randomUUID(), f.task.id)).rejects.toMatchObject({ status: 409 });
  });
});
