import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AuthorCheckRun, type AuthorCheckDone } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { WebSocket } from 'ws';
import { jobs, subscriptions, taskEvents } from '../src/db/schema.js';
import { NodeHub, ownBuiltin } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { recordAuthorCheck, requestAuthorCheck } from '../src/modules/tasks/author-check.js';
import { submit, updateTask } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

async function setup() {
  const f = await fixture({ authorProvider: 'claude' });
  await f.db.update(subscriptions).set({ kind: 'api_key' }).where(eq(subscriptions.id, f.claude.id));
  const [job] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: f.author.id, subscriptionId: f.claude.id,
    taskId: f.task.id, kind: 'conversation', prompt: '', timeoutMs: 900_000, status: 'running' }).returning();
  const node = ownBuiltin(f.ctx.config);
  const sent: unknown[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw) as unknown), ping: () => {}, close: () => {}, terminate: () => {},
  });
  const hub = new NodeHub({ pingMs: 60_000, onMessage: async () => {}, onClose: async () => {} });
  onTestFinished(() => hub.stop());
  hub.attach(node, socket as unknown as WebSocket);
  hub.greet(node);
  f.ctx.hub = hub;
  f.ctx.readCommit = async (_repo, want) => ({
    branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: 'task' in want ? HEAD : BASE,
  });
  const request = await requestAuthorCheck(f.ctx, f.author.id, job!.id, f.task.id);
  const completed: AuthorCheckDone = { type: 'author_check.done', requestId: request.requestId, taskId: f.task.id, commit: HEAD, crap: 2, cherryPick: null };
  const receipts = async () => (await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id))).filter(event => event.data.authorCheckReceipt);
  return { ...f, node, sent, job: job!, request, completed, receipts };
}

describe('author check request and receipt boundary', () => {
  it('selects the repository and both SHAs and records the node reply once', async () => {
    const f = await setup();
    expect(f.sent).toHaveLength(1);
    const run = AuthorCheckRun.parse(f.sent[0]);
    expect(run).toMatchObject({
      repo: { url: 'https://github.com/acme/shop.git' },
      pin: { baseCommit: BASE, commit: HEAD, branch: `task-${f.task.number}` }, mainCommit: BASE,
    });
    const [event] = await f.db.select().from(taskEvents).where(eq(taskEvents.uuid, f.request.requestId));
    expect(event?.data.authorCheckRequest).not.toHaveProperty('repo');
    await handleNodeMessage(f.ctx, f.node, f.completed);
    await Promise.all([recordAuthorCheck(f.ctx, f.node, f.completed), recordAuthorCheck(f.ctx, f.node, f.completed)]);
    expect(await f.receipts()).toMatchObject([{ agentId: null, personId: null, data: { authorCheckReceipt: { pin: run.pin, crap: 2 } } }]);
    const moved = await submit(f.ctx, f.author.id, f.task.id, { summary: 'Ready.', evidence: 'Checked.', review: { baseCommit: BASE } });
    expect(moved.task.assigneeAgentId).toBe(f.tester.id);
  });

  it('rejects another machine, task, SHA and nonce', async () => {
    const f = await setup();
    await recordAuthorCheck(f.ctx, { kind: 'builtin', machine: 'other' }, f.completed);
    for (const mismatch of [{ taskId: randomUUID() }, { commit: 'c'.repeat(40) }, { requestId: randomUUID() }]) {
      await recordAuthorCheck(f.ctx, f.node, { ...f.completed, ...mismatch });
    }
    expect(await f.receipts()).toHaveLength(0);
  });

  it('refuses a stale route, an unrelated job and a different author', async () => {
    const f = await setup();
    await updateTask(f.ctx, f.head.id, f.task.id, { riskClass: 'security' });
    await recordAuthorCheck(f.ctx, f.node, f.completed);
    expect(await f.receipts()).toHaveLength(0);
    await expect(requestAuthorCheck(f.ctx, f.reviewer.id, f.job.id, f.task.id)).rejects.toMatchObject({ status: 409 });
    await expect(requestAuthorCheck(f.ctx, f.author.id, randomUUID(), f.task.id)).rejects.toMatchObject({ status: 409 });
  });
});
