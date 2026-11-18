import { eq } from 'drizzle-orm';
import type { PhoneReadinessIssue } from '@hornhoof/protocol';
import { expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { as, until } from './helpers.js';
import { phoneCompany } from './phone-fixture.js';
import { agents, companyPhones } from '../src/db/schema.js';

it('reports readiness for a registered phone and checks again when the node comes back', async () => {
  let issues: PhoneReadinessIssue[] = ['lock'];
  const c = await phoneCompany({ readiness: () => issues });
  const made = await c.addPhone();
  expect(made.statusCode).toBe(201);
  expect(made.json().readiness).toEqual(['lock']);
  expect(c.calls[1]).toMatchObject({ type: 'phone.baseline', binding: { phoneId: made.json().id, hardwareKey: 'a'.repeat(64) } });
  const list = () => c.app.inject({ url: '/api/phones', ...as(c.claraSession) });
  issues = [];
  c.hello();
  await until(async () => (await list()).json().phones[0].readiness?.length === 0);
});

it('lets any person register their network phone on a company machine, with an owner', async () => {
  const c = await phoneCompany();
  const made = await c.addPhone();
  expect(made.statusCode).toBe(201);
  expect(made.json()).toMatchObject({ name: 'Clara phone', owner: { id: c.clara.id, name: c.clara.name }, lending: true, endpoint: '192.168.1.80:5555' });
  const foreign = await c.app.inject({ url: `/api/phones/${made.json().id}`, ...as(c.olafSession) });
  expect(foreign.statusCode).toBe(403);
  const duplicate = await c.app.inject({ method: 'POST', url: '/api/phones', ...as(c.claraSession), payload: { machineId: c.machine.id, endpoint: '192.168.1.81:5555', name: 'The same physical phone over another address' } });
  expect(duplicate.statusCode).toBe(201);
  expect(duplicate.json().id).toBe(made.json().id);
  expect(await c.db.select().from(companyPhones)).toHaveLength(1);
});

it('lets a person register a phone plugged by cable into the machine by its serial number', async () => {
  const c = await phoneCompany();
  const made = await c.app.inject({ method: 'POST', url: '/api/phones', ...as(c.claraSession), payload: { machineId: c.machine.id, endpoint: 'ZF525LRDQS', name: 'Clara phone on a cable' } });
  expect(made.statusCode).toBe(201);
  expect(made.json()).toMatchObject({ endpoint: 'ZF525LRDQS' });
  expect(c.calls.find(m => m.type === 'phone.probe')).toMatchObject({ endpoint: 'ZF525LRDQS' });
});

it('never sends the node to an address on its own machine, where its agents\' tools listen', async () => {
  const c = await phoneCompany();
  const local = await c.app.inject({ method: 'POST', url: '/api/phones/probe', ...as(c.claraSession), payload: { machineId: c.machine.id, endpoint: '127.0.0.1:43117' } });
  expect(local.statusCode).toBe(400);
  expect(c.calls).toEqual([]);
});

it("lets the orchestrator, acting for the owner, look for a phone and stop and resume any person's phone", async () => {
  const c = await phoneCompany();
  const phone = (await c.addPhone()).json();
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const ceo = (await c.app.inject({ url: '/api/me', ...as(c.ceoSession) })).json().person.id as string;
  const inside = { headers: orchestratorHeaders(ceo, orchestrator!.id) };
  const probed = await c.app.inject({ method: 'POST', url: '/api/phones/probe', payload: { machineId: c.machine.id, endpoint: '192.168.1.80:5555' }, ...inside });
  expect(probed.json()).toMatchObject({ devices: [{ serial: '192.168.1.80:5555', status: 'device' }] });
  expect((await c.app.inject({ method: 'POST', url: `/api/phones/${phone.id}/stop`, ...inside })).json()).toMatchObject({ lending: false });
  expect((await c.app.inject({ method: 'POST', url: `/api/phones/${phone.id}/resume`, ...inside })).json()).toMatchObject({ lending: true });
});
