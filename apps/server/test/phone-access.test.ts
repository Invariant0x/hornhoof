import { expect, it } from 'vitest';
import { as } from './helpers.js';
import { phoneCompany } from './phone-fixture.js';
import { acquirePhone } from '../src/modules/phones/queue.js';

it('refuses another company and hides recordings by an agent the task viewer cannot open', async () => {
  const c = await phoneCompany();
  const phone = (await c.addPhone()).json();
  const turn = await c.startTurn(c.nora.id, c.task.id);
  const session = await acquirePhone(c.app.ctx, { id: c.nora.id, companyId: c.companyId, jobId: turn.job.id }, phone.id);
  const url = `/api/tasks/${c.task.id}/phone-recordings`;
  const allowed = await c.app.inject({ url, ...as(c.ceoSession) });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().recordings).toEqual([expect.objectContaining({ id: session.id })]);
  expect((await c.app.inject({ url, ...as(c.olafSession) })).statusCode).toBe(403);
  // Tasks are company work; their recordings still follow the recorded agent's visibility.
  const hidden = await c.app.inject({ url, ...as(c.samSession) });
  expect(hidden.statusCode).toBe(200);
  expect(hidden.json()).toEqual({ recordings: [] });
  expect((await c.app.inject({ url })).statusCode).toBe(401);
  const foreignRegistration = await c.app.inject({ method: 'POST', url: '/api/phones', ...as(c.olafSession), payload: { machineId: c.machine.id, endpoint: 'USB123456', name: 'Foreign phone' } });
  expect(foreignRegistration.statusCode).toBe(403);
  expect(c.calls.filter(message => message.type === 'phone.probe')).toHaveLength(1);
});
