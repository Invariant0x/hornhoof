import { it } from 'vitest';
import { createServer } from 'node:net';
import { eq } from 'drizzle-orm';
import { agents, jobs, subscriptions, turns } from '../src/db/schema.js';
import { aclCompany } from './agent-view-company.js';
import { connectNode } from './helpers.js';

it('serves the real browser integration', async () => {
  const key = 'k'.repeat(40);
  const c = await aclCompany({ NODE_KEY: key, STREAM_PING_MS: '100' });
  await c.db.update(subscriptions).set({ kind: 'api_key', targetKind: 'any' });
  await c.db.insert(turns).values({ companyId: c.companyId, number: 1, goal: 'ACL integration', openedAt: new Date() });
  const node = await connectNode(c.url, key);
  node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], terminals: true });
  const hiddenTask = await c.work('Hidden work', c.crew.other);
  const ownTask = await c.work('Own work', c.crew.mine);
  const awayTask = await c.work('Away work', c.crew.away, c.sales.id);

  void (async () => {
    for (;;) {
      const m = await node.next();
      if (m.type === 'term.open') {
        node.send({ type: 'term.data', termId: m.termId, data: 'Mina private terminal\r\n' });
        node.send({ type: 'term.program', termId: m.termId, running: true });
      }
    }
  })().catch(error => { throw error; });

  const turnOn = (agentId: string, planId: string, status: 'running' | 'done' = 'running') => c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: planId, agentId, kind: 'conversation', prompt: 'A turn.', timeoutMs: 900000, status, startedAt: new Date(), ...(status === 'done' ? { finishedAt: new Date() } : {}) }).returning();
  const onPlan = (agentId: string, planId: string) => c.db.update(agents).set({ subscriptionId: planId }).where(eq(agents.id, agentId));
  const commands: Record<string, () => unknown> = {
    'turn-mine-ann': () => turnOn(c.crew.mine.id, c.plans.ann.id),
    'move-mine-bob': () => c.app.inject({ method: 'PATCH', url: '/api/agents/' + c.crew.mine.id, payload: { subscription: c.plans.bob.id }, cookies: { hh_session: c.tokens.ceo } }),
    'move-other-ann-running': async () => { await turnOn(c.crew.other.id, c.plans.bob.id); await onPlan(c.crew.other.id, c.plans.ann.id); },
    'move-other-ann-idle': async () => { await turnOn(c.crew.other.id, c.plans.bob.id, 'done'); await onPlan(c.crew.other.id, c.plans.ann.id); },
    'turn-other-bob': () => turnOn(c.crew.other.id, c.plans.bob.id),
    'turn-other-ann': () => turnOn(c.crew.other.id, c.plans.ann.id),
  };
  const control = createServer(socket => {
    let text = '';
    socket.on('data', chunk => {
      text += String(chunk);
      for (;;) {
        const end = text.indexOf('\n');
        if (end < 0) return;
        const line = text.slice(0, end);
        text = text.slice(end + 1);
        if (!line) continue;
        const { control: name } = JSON.parse(line);
        console.error('ACL CONTROL', name);
        void Promise.resolve(commands[name]?.()).then(
          () => {
            console.error('ACL CONTROL DONE', name);
            socket.write(JSON.stringify({ control: name }) + '\n');
          },
          error => console.error('ACL CONTROL FAILED', name, error),
        );
      }
    });
    socket.on('close', () => {
      node.close();
      void c.app.close().then(() => control.close());
    });
  });
  await new Promise<void>(done => control.listen(0, '127.0.0.1', done));
  const address = control.address();
  const controlPort = typeof address === 'object' && address ? address.port : 0;
  process.stdout.write(JSON.stringify({
    url: c.url.replace('ws://', 'http://'), tokens: c.tokens, ids: c.ids, plans: c.plans, controlPort,
    crew: Object.fromEntries(Object.entries(c.crew).map(([name, agent]) => [name, { id: agent.id, name: agent.name }])),
    dev: c.dev, sales: c.sales, hiddenTask: { id: hiddenTask.id }, ownTask: { id: ownTask.id }, awayTask: { id: awayTask.id },
  }) + '\n');
  await new Promise<void>(done => control.on('close', () => done()));
}, 120_000);
