import { expect, it } from 'vitest';
import { as } from './helpers.js';
import { phoneCompany } from './phone-fixture.js';

it('lets any person register their network phone on a company machine, with an owner', async () => {
  const c = await phoneCompany();
  const made = await c.addPhone();
  expect(made.statusCode).toBe(201);
  expect(made.json()).toMatchObject({ name: 'Clara phone', owner: { id: c.clara.id, name: c.clara.name }, lending: true, serial: '192.168.1.80:5555' });
  const foreign = await c.app.inject({ url: `/api/phones/${made.json().id}`, ...as(c.olafSession) });
  expect(foreign.statusCode).toBe(403);
});
