import { expect, it } from 'vitest';
import { mcp } from './helpers.js';
import { phoneCompany } from './phone-fixture.js';
import { acquirePhone } from '../src/modules/phones/queue.js';
import { nodes } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

type Reply = { content: { type: string; text?: string }[]; isError?: boolean };
const value = (reply: Reply): Record<string, unknown> => {
  expect(reply.isError, reply.content[0]?.text).not.toBe(true);
  return JSON.parse(reply.content[0]!.text!) as Record<string, unknown>;
};

it('gives one agent the phone and queues the next until the first session ends', async () => {
  const c = await phoneCompany();
  const phone = (await c.addPhone()).json();
  await expect(acquirePhone(c.app.ctx, { id: c.otherAgent.id, companyId: c.other.id, jobId: null }, phone.id)).rejects.toMatchObject({ status: 403 });
  const first = await c.startTurn(c.nora.id, c.task.id);
  const second = await c.startTurn(c.sammy.id, c.task.id);
  const firstTools = await mcp(c.app, first.token);
  const secondTools = await mcp(c.app, second.token);
  const acquired = value(await firstTools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
  expect(acquired.status).toBe('active');
  const queued = value(await secondTools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
  expect(queued).toMatchObject({ status: 'queued', position: 1 });
  const repeated = value(await secondTools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
  expect(repeated.id).toBe(queued.id);
  await firstTools.callTool({ name: 'phone_release', arguments: { session: acquired.id } });
  const next = value(await secondTools.callTool({ name: 'phone_session', arguments: { session: queued.id } }) as Reply);
  expect(next.status).toBe('active');
  expect(c.calls.filter(m => m.type === 'phone.open')).toHaveLength(2);
  await c.db.update(nodes).set({ keyHash: 'a newly rotated key hash' }).where(eq(nodes.id, c.executor.id));
  const refused = value(await secondTools.callTool({ name: 'phone_action', arguments: { session: queued.id, operation: { kind: 'tap', x: 1, y: 2 } } }) as Reply);
  expect(refused.status).toBe('failed');
  expect(c.calls.filter(m => m.type === 'phone.action')).toEqual([]);
});

it('lets the agent type a login and password it holds as text, with no tool that signs in for it', async () => {
  const c = await phoneCompany();
  const phone = (await c.addPhone()).json();
  const turn = await c.startTurn(c.nora.id, c.task.id);
  const tools = await mcp(c.app, turn.token);
  const listed = (await tools.listTools()).tools;
  /* The vault gives a sign-in as text; no tool puts one into a form for the agent. */
  expect(listed.map(t => t.name).filter(name => /fill|sign_?in|login|password/i.test(name))).toEqual([]);
  expect(listed.find(t => t.name === 'phone_action')!.description).not.toMatch(/fill|never pass a password/i);
  const session = value(await tools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
  for (const text of ['nora@acme.test', 'Pass word%s 1079!', 'Привет, мир 👋']) await tools.callTool({ name: 'phone_action', arguments: { session: session.id, operation: { kind: 'text', text } } });
  expect(c.calls.flatMap(m => m.type === 'phone.action' ? [m.operation] : [])).toEqual([{ kind: 'text', text: 'nora@acme.test' }, { kind: 'text', text: 'Pass word%s 1079!' }, { kind: 'text', text: 'Привет, мир 👋' }]);
});
