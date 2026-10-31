import { describe, expect, it } from 'vitest';
import { companies, departments } from '../src/db/schema.js';
import { CHANNEL_MS, EventBus } from '../src/modules/events/bus.js';
import { as, setUpCompany, testApp } from './helpers.js';

describe('live channels', () => {
  it('are remembered for ten minutes after the last message, one per direction', () => {
    const bus = new EventBus();
    const t0 = Date.now();
    bus.publish('c1', { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'd1' } }, t0);
    bus.publish('c1', { type: 'pulse', from: { kind: 'department', id: 'd1' }, to: { kind: 'orchestrator' } }, t0 + 1000);
    bus.publish('c1', { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'd1' } }, t0 + 2000);
    expect(CHANNEL_MS).toBe(10 * 60_000);
    expect(bus.channels('c1', t0 + 3000).map(c => [c.from.kind, c.to.kind, c.at])).toEqual([
      ['department', 'orchestrator', new Date(t0 + 1000).toISOString()],
      ['orchestrator', 'department', new Date(t0 + 2000).toISOString()],
    ]);
    expect(bus.channels('c1', t0 + 1000 + CHANNEL_MS + 1).map(c => c.from.kind)).toEqual(['orchestrator']);
    expect(bus.channels('c2', t0)).toEqual([]);
  });

  it('come with the map: those between its places, and each department its own inside it', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    app.ctx.bus.publish(acme!.id, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: dev!.id } });
    app.ctx.bus.publish(acme!.id, { type: 'pulse', from: { kind: 'agent', id: 'a1', departmentId: dev!.id }, to: { kind: 'agent', id: 'a2', departmentId: dev!.id } });
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.live).toEqual([{ from: { kind: 'orchestrator' }, to: { kind: 'department', id: dev!.id }, at: expect.any(String) }]);
    expect(org.departments[0].live).toEqual([{ from: 'a1', to: 'a2', at: expect.any(String) }]);
  });
});
