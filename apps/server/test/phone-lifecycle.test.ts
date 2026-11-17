import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { PHONE_LEASE_MS } from '@hornhoof/protocol';
import { companyPhones, phoneSessions } from '../src/db/schema.js';
import { checkConnectedPhones, refreshPhoneReadiness } from '../src/modules/phones/readiness.js';
import { cancelJob } from '../src/modules/tasks/wake.js';
import { as, mcp, until } from './helpers.js';
import { phoneCompany } from './phone-fixture.js';

type Reply = { content: { type: string; text?: string }[]; isError?: boolean };
const value = (reply: Reply): Record<string, unknown> => JSON.parse(reply.content[0]!.text!) as Record<string, unknown>;

it('owner Stop revokes before acknowledgement, cancels the queue and keeps owner control', async () => {
  const c = await phoneCompany();
  const phone = (await c.addPhone()).json();
  const first = await c.startTurn(c.nora.id, c.task.id);
  const second = await c.startTurn(c.sammy.id, c.task.id);
  const firstTools = await mcp(c.app, first.token);
  const secondTools = await mcp(c.app, second.token);
  const acquired = value(await firstTools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
  const queued = value(await secondTools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
  expect((await c.app.inject({ method: 'POST', url: `/api/phones/${phone.id}/stop`, ...as(c.samSession) })).statusCode).toBe(403);
  c.holdRevokes();
  const stopped = await c.app.inject({ method: 'POST', url: `/api/phones/${phone.id}/stop`, ...as(c.claraSession) });
  expect(stopped.json()).toMatchObject({ lending: false, state: 'owner' });
  const late = await firstTools.callTool({ name: 'phone_action', arguments: { session: acquired.id, operation: { kind: 'tap', x: 1, y: 2 } } }) as Reply;
  expect(late.isError).toBe(true);
  expect(c.calls.filter(m => m.type === 'phone.action')).toEqual([]);
  expect(value(await secondTools.callTool({ name: 'phone_session', arguments: { session: queued.id } }) as Reply).status).toBe('cancelled');
  await until(() => c.calls.some(m => m.type === 'phone.revoke'));
  c.acknowledgeRevokes();
  await until(async () => (await c.db.select().from(phoneSessions).where(eq(phoneSessions.id, String(acquired.id))))[0]!.status === 'ended');
  expect(c.calls.filter(m => m.type === 'phone.open')).toHaveLength(1);
});

it('cancellation and a lost lease release the phone and promote the next live job on virtual time', async () => {
  const c = await phoneCompany();
  const phone = (await c.addPhone()).json();
  const first = await c.startTurn(c.nora.id, c.task.id);
  const second = await c.startTurn(c.sammy.id, c.task.id);
  const firstTools = await mcp(c.app, first.token);
  const secondTools = await mcp(c.app, second.token);
  const acquired = value(await firstTools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
  const queued = value(await secondTools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
  await cancelJob(c.app.ctx, first.job.id);
  expect((await c.db.select().from(phoneSessions).where(eq(phoneSessions.id, String(acquired.id))))[0]!.status).toBe('ended');
  expect(value(await secondTools.callTool({ name: 'phone_session', arguments: { session: queued.id } }) as Reply).status).toBe('active');
  const now = c.app.ctx.clock();
  c.app.ctx.clock = () => now + PHONE_LEASE_MS + 1;
  expect(value(await secondTools.callTool({ name: 'phone_session', arguments: { session: queued.id } }) as Reply)).toMatchObject({ status: 'ended', reason: 'lost' });
});

it('checks idle phones after minutes and leaves a session alone until it ends', async () => {
  const c = await phoneCompany(() => []);
  const phone = (await c.addPhone()).json();
  const checks = () => c.calls.filter(m => m.type === 'phone.baseline');
  expect(checks()).toHaveLength(1);

  const now = c.app.ctx.clock();
  c.app.ctx.clock = () => now + 15_000;
  await checkConnectedPhones(c.app.ctx);
  expect(checks()).toHaveLength(1);

  c.app.ctx.clock = () => now + 5 * 60_000;
  await checkConnectedPhones(c.app.ctx);
  await until(() => checks().length === 2);

  const first = await c.startTurn(c.nora.id, c.task.id);
  const tools = await mcp(c.app, first.token);
  const acquired = value(await tools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
  expect(acquired.status).toBe('active');
  c.app.ctx.clock = () => now + 10 * 60_000;
  const [registered] = await c.db.select().from(companyPhones).where(eq(companyPhones.id, phone.id));
  await refreshPhoneReadiness(c.app.ctx, registered!);
  await checkConnectedPhones(c.app.ctx);
  expect(checks()).toHaveLength(2);

  await tools.callTool({ name: 'phone_release', arguments: { session: acquired.id } });
  expect(checks()).toHaveLength(3);
  expect(c.calls.slice(-2).map(m => m.type)).toEqual(['phone.revoke', 'phone.baseline']);
});
