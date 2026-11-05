import { it } from 'vitest';
import { createInterface } from 'node:readline';
import { eq } from 'drizzle-orm';
import { agents, jobs, subscriptions } from '../src/db/schema.js';
import { aclCompany } from './agent-view-company.js';
import { connectNode } from './helpers.js';

it('serves the real browser integration', async () => {
  const key = 'k'.repeat(40);
  const c = await aclCompany({ NODE_KEY: key, STREAM_PING_MS: '100' });
  await c.db.update(subscriptions).set({ kind: 'api_key', targetKind: 'any' });
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

  const turnOn = (agentId: string, planId: string, status = 'running') => c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: planId, agentId, kind: 'conversation', prompt: 'A turn.', timeoutMs: 900000, status, startedAt: new Date(), ...(status === 'done' ? { finishedAt: new Date() } : {}) }).returning();
  const onPlan = (agentId: string, planId: string) => c.db.update(agents).set({ subscriptionId: planId }).where(eq(agents.id, agentId));
  const commands: Record<string, () => unknown> = {
    'move-mine-bob': () => c.app.inject({ method: 'PATCH', url: '/api/agents/' + c.crew.mine.id, payload: { subscription: c.plans.bob.id }, cookies: { hh_session: c.tokens.ceo } }),
    'move-other-ann-running': async () => { await turnOn(c.crew.other.id, c.plans.bob.id); await onPlan(c.crew.other.id, c.plans.ann.id); },
    'move-other-ann-idle': async () => { await turnOn(c.crew.other.id, c.plans.bob.id, 'done'); await onPlan(c.crew.other.id, c.plans.ann.id); },
    'turn-other-ann': () => turnOn(c.crew.other.id, c.plans.ann.id),
  };
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    const { control } = JSON.parse(line);
    void Promise.resolve(commands[control]?.()).then(() => process.stdout.write(JSON.stringify({ control }) + '\n'));
  });
  process.stdout.write(JSON.stringify({
    url: c.url.replace('ws://', 'http://'), tokens: c.tokens, ids: c.ids, plans: c.plans,
    crew: Object.fromEntries(Object.entries(c.crew).map(([name, agent]) => [name, { id: agent.id, name: agent.name }])),
    dev: c.dev, sales: c.sales, hiddenTask: { id: hiddenTask.id }, ownTask: { id: ownTask.id }, awayTask: { id: awayTask.id },
  }) + '\n');
  await new Promise<void>(done => input.on('close', () => {
    void c.app.close().then(() => {
      node.close();
      done();
    });
  }));
});
