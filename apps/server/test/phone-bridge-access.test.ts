import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { phoneCompany } from './phone-fixture.js';
import { companyPhones, nodes, phoneSessions } from '../src/db/schema.js';
import { acquirePhone } from '../src/modules/phones/queue.js';

it('authorizes only the current machine key, bound USB serial and current session generation', async () => {
  const c = await phoneCompany();
  const probe = (key: string, payload: Record<string, unknown>) => c.app.inject({ method: 'POST', url: '/api/nodes/phone-bridge/authorize', headers: { authorization: `Bearer ${key}` }, payload });
  const key = 'phone-node-1079-key-012345678901234567890';
  const discovery = { scope: 'probe', serial: null };
  expect((await probe(key, discovery)).statusCode).toBe(200);
  expect((await probe('wrong-key', discovery)).statusCode).toBe(403);
  const made = await c.addPhone();
  const phoneId = made.json().id as string;
  await c.db.update(companyPhones).set({ transport: 'usb', endpoint: null, serial: 'R58MIDENTITY' }).where(eq(companyPhones.id, phoneId));
  const borrower = await c.startTurn(c.nora.id, c.task.id);
  const actor = { id: c.nora.id, companyId: c.companyId, departmentId: c.mkt.id, jobId: borrower.job.id };
  const session = await acquirePhone(c.app.ctx, actor, phoneId);
  const [held] = await c.db.select().from(phoneSessions).where(eq(phoneSessions.id, session.id));
  const target = { scope: 'session', phoneId, sessionId: session.id, generation: held!.generation, serial: 'R58MIDENTITY', hardwareKey: 'a'.repeat(64) };
  expect((await probe(key, target)).statusCode).toBe(200);
  expect((await probe(key, { ...target, serial: 'OTHER' })).statusCode).toBe(403);
  expect((await probe(key, { ...target, hardwareKey: 'b'.repeat(64) })).statusCode).toBe(403);
  await c.db.update(companyPhones).set({ lending: false, generation: held!.generation! + 1 }).where(eq(companyPhones.id, phoneId));
  expect((await probe(key, target)).statusCode).toBe(403);
  await c.db.update(nodes).set({ keyHash: null }).where(eq(nodes.id, c.executor.id));
  expect((await probe(key, discovery)).statusCode).toBe(403);
});
