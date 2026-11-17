import { expect, it } from 'vitest';
import { as } from './helpers.js';
import { phoneCompany } from './phone-fixture.js';
import { companyPhones } from '../src/db/schema.js';

it('lets any person register their network phone on a company machine, with an owner', async () => {
  const c = await phoneCompany();
  const made = await c.addPhone();
  expect(made.statusCode).toBe(201);
  expect(made.json()).toMatchObject({ name: 'Clara phone', owner: { id: c.clara.id, name: c.clara.name }, lending: true, serial: '192.168.1.80:5555' });
  const foreign = await c.app.inject({ url: `/api/phones/${made.json().id}`, ...as(c.olafSession) });
  expect(foreign.statusCode).toBe(403);
  const duplicate = await c.app.inject({ method: 'POST', url: '/api/phones', ...as(c.claraSession), payload: { machineId: c.machine.id, serial: '192.168.1.81:5555', transport: 'network', endpoint: '192.168.1.81:5555', name: 'The same physical phone over another address' } });
  expect(duplicate.statusCode).toBe(201);
  expect(duplicate.json().id).toBe(made.json().id);
  expect(await c.db.select().from(companyPhones)).toHaveLength(1);
});
