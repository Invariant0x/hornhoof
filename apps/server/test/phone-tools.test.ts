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
  await expect(acquirePhone(c.app.ctx, { id: c.otherAgent.id, companyId: c.other.id, departmentId: null, jobId: null }, phone.id)).rejects.toMatchObject({ status: 403 });
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

it('sends a turn that waits for any phone to the first phone that frees up, in one company queue', async () => {
  const c = await phoneCompany();
  const first = (await c.addPhone()).json();
  const second = (await c.addPhone(c.samSession, '192.168.1.90:5555', 'Sam phone')).json();
  const turns = await Promise.all([c.startTurn(c.nora.id, c.task.id), c.startTurn(c.sammy.id, c.task.id), c.startTurn(c.nora.id, c.task.id), c.startTurn(c.sammy.id, c.task.id)]);
  const tools = await Promise.all(turns.map(t => mcp(c.app, t.token)));
  const acquire = async (n: number, phone?: string) => value(await tools[n]!.callTool({ name: 'phone_acquire', arguments: phone ? { phone } : {} }) as Reply);
  expect(await acquire(0)).toMatchObject({ status: 'active', phoneId: first.id });
  expect(await acquire(1)).toMatchObject({ status: 'active', phoneId: second.id });
  const anyPhone = await acquire(2);
  expect(anyPhone).toMatchObject({ status: 'queued', phoneId: null, position: 1 });
  const named = await acquire(3, first.id);
  expect(named).toMatchObject({ status: 'queued', phoneId: first.id, position: 2 });
  const listed = value(await tools[0]!.callTool({ name: 'phones', arguments: {} }) as Reply);
  expect(listed).toMatchObject({ waitingForAny: 1, phones: [{ id: first.id, state: 'busy', queued: 1 }, { id: second.id, state: 'busy', queued: 0 }] });
  await tools[1]!.callTool({ name: 'phone_release', arguments: { session: (await acquire(1)).id } });
  expect(value(await tools[2]!.callTool({ name: 'phone_session', arguments: { session: anyPhone.id } }) as Reply)).toMatchObject({ status: 'active', phoneId: second.id });
  expect(value(await tools[3]!.callTool({ name: 'phone_session', arguments: { session: named.id } }) as Reply)).toMatchObject({ status: 'queued', position: 1 });
  await tools[0]!.callTool({ name: 'phone_release', arguments: { session: (await acquire(0)).id } });
  expect(value(await tools[3]!.callTool({ name: 'phone_session', arguments: { session: named.id } }) as Reply)).toMatchObject({ status: 'active', phoneId: first.id });
});
