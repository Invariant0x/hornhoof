import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AuthorCheckDone } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { WebSocket } from 'ws';
import { hashToken } from '../src/crypto/tokens.js';
import { jobs, subscriptions, taskEvents } from '../src/db/schema.js';
import { keyOf, NodeHub, ownBuiltin } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { requestAuthorCheck } from '../src/modules/tasks/author-check.js';
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
  const events = () => f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id));
  return { ...f, node, sent, job: job!, events };
}

describe('the disabled author check boundary', () => {
  it('does not dispatch a node check for an eligible Development task', async () => {
    const f = await setup();
    await expect(requestAuthorCheck(f.ctx, f.author.id, f.job.id, f.task.id)).rejects.toMatchObject({
      status: 409, message: 'The author check for skipping Review is disabled.',
    });
    expect(f.sent).toHaveLength(0);
    expect((await f.events()).some(event => event.data.authorCheckRequest)).toBe(false);
  });

  it('ignores a node result for a request made before Review skips were disabled', async () => {
    const f = await setup();
    const requestId = randomUUID();
    const route = (await f.detail()).echelons;
    await f.db.insert(taskEvents).values({
      uuid: requestId, companyId: f.task.companyId, taskId: f.task.id, agentId: f.author.id, kind: 'comment', text: 'Author check started.',
      data: { authorCheckRequest: {
        pin: { taskId: f.task.id, agentId: f.author.id, branch: `task-${f.task.number}`, baseCommit: BASE, commit: HEAD,
          repoUrlHash: hashToken('https://github.com/acme/shop.git'), paths: ['logic/totals.ts'] },
        routeRevision: route.revision, node: keyOf(f.node), verifyCherryPick: false,
      } },
    });
    const completed: AuthorCheckDone = { type: 'author_check.done', requestId, taskId: f.task.id, commit: HEAD, crap: 2, cherryPick: null };
    await handleNodeMessage(f.ctx, f.node, completed);
    expect((await f.events()).some(event => event.data.authorCheckReceipt)).toBe(false);
  });
});
