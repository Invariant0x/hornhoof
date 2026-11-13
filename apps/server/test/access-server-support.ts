import { once } from 'node:events';
import { createServer } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import type { ServerMessage } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { agents, jobs, subscriptions, turns } from '../src/db/schema.js';
import { aclCompanyOn } from './agent-view-fixture.js';
import { TEST_SECRET } from './helpers-basic.js';
import { migratedPgliteDump, readPgliteTemplate } from './prepare-environment.js';
import { listenAt, listenIn } from '../../../test-support/ports.mjs';

const key = 'k'.repeat(40);
const template = process.env.HH_PGLITE_TEMPLATE;
const dump = template ? readPgliteTemplate(template) : await migratedPgliteDump();
if (!dump) throw new Error('Invalid HH_PGLITE_TEMPLATE for the browser access server');
const client = new PGlite({ loadDataDir: new Blob([new Uint8Array(dump)]) });
const db = drizzle(client, { schema }) as unknown as Db;
const app = await buildApp({ db, config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, UPDATE_CHECK_MS: '0', NODE_KEY: key, STREAM_PING_MS: '100', WEB_DIST: process.env.WEB_DIST }) });
const origin = await listenAt(port => app.listen({ host: '127.0.0.1', port }));
const c = await aclCompanyOn(app, db, origin.replace('http://', 'ws://') + '/api/nodes/socket');
await c.db.update(subscriptions).set({ kind: 'api_key', targetKind: 'any' });
await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.dev.id, number: 1, goal: 'ACL integration', openedAt: new Date() });
const node = new WebSocket(c.url, { headers: { authorization: `Bearer ${key}` } });
node.on('message', data => {
  const message = JSON.parse(String(data)) as ServerMessage;
  if (message.type === 'term.open') {
    node.send(JSON.stringify({ type: 'term.data', termId: message.termId, data: 'Mina private terminal\r\n' }));
    node.send(JSON.stringify({ type: 'term.program', termId: message.termId, running: true }));
  }
});
await once(node, 'open');
node.send(JSON.stringify({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], terminals: true }));
const hiddenTask = await c.work('Hidden work', c.crew.other);
const ownTask = await c.work('Own work', c.crew.mine);
const awayTask = await c.work('Away work', c.crew.away, c.sales.id);

const turnOn = (agentId: string, planId: string, status: 'running' | 'done' = 'running') => c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: planId, agentId, kind: 'conversation', prompt: 'A turn.', timeoutMs: 900000, status, startedAt: new Date(), ...(status === 'done' ? { finishedAt: new Date() } : {}) }).returning();
const onPlan = (agentId: string, planId: string) => c.db.update(agents).set({ subscriptionId: planId }).where(eq(agents.id, agentId));
const commands: Record<string, () => unknown> = {
  reset: async () => {
    await c.db.delete(jobs).where(eq(jobs.companyId, c.companyId));
    for (const agent of Object.values(c.crew)) await onPlan(agent.id, agent.subscriptionId!);
  },
  'turn-mine-ann': () => turnOn(c.crew.mine.id, c.plans.ann.id),
  'move-mine-bob': () => c.app.inject({ method: 'PATCH', url: '/api/agents/' + c.crew.mine.id, payload: { subscription: c.plans.bob.id }, cookies: { hh_session: c.tokens.ceo } }),
  'move-other-ann-running': async () => { await turnOn(c.crew.other.id, c.plans.bob.id); await onPlan(c.crew.other.id, c.plans.ann.id); },
  'move-other-ann-idle': async () => {
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(and(eq(jobs.agentId, c.crew.other.id), eq(jobs.status, 'running')));
    await onPlan(c.crew.other.id, c.plans.ann.id);
    c.app.ctx.bus.publish(c.companyId, { type: 'org' });
    c.app.ctx.bus.accessChanged(c.companyId);
  },
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
      void Promise.resolve(commands[name]?.()).then(
        () => {
          socket.write(JSON.stringify({ control: name }) + '\n');
        },
        () => socket.write(JSON.stringify({ control: name, error: 'Control command failed' }) + '\n'),
      );
    }
  });
  socket.on('close', () => {
    void shutdown();
  });
});
await listenIn(control);
const address = control.address();
const controlPort = typeof address === 'object' && address ? address.port : 0;
process.stdout.write(JSON.stringify({
  url: c.url.replace('ws://', 'http://'), tokens: c.tokens, ids: c.ids, plans: c.plans, controlPort,
  crew: Object.fromEntries(Object.entries(c.crew).map(([name, agent]) => [name, { id: agent.id, name: agent.name }])),
  dev: c.dev, sales: c.sales, hiddenTask: { id: hiddenTask.id }, ownTask: { id: ownTask.id }, awayTask: { id: awayTask.id },
}) + '\n');
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  node.close();
  await c.app.close();
  await client.close();
  control.close();
}
process.stdin.resume();
process.stdin.on('end', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
