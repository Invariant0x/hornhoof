import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, subscriptions } from '../src/db/schema.js';
import { CHANNEL_MS, type Endpoint, EventBus } from '../src/modules/events/bus.js';
import { as, setUpCompany, testApp } from './helpers.js';

describe('live channels', () => {
  it('are remembered for ten minutes after the last message, one per direction', () => {
    const bus = new EventBus();
    const t0 = Date.parse('2026-11-09T10:00:00.000Z');
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

  it('stay on past ten minutes while the one they lead to goes on with work that started before they went quiet', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const companyId = acme!.id;
    const [dev, ops] = await db
      .insert(departments)
      .values([
        { companyId, templateKey: 'development', roleCode: 'DEV', position: 0 },
        { companyId, templateKey: 'operations', roleCode: 'OPS', position: 1 },
      ])
      .returning();
    const hire = async (name: string, kind: 'head' | 'worker', departmentId: string) =>
      (await db.insert(agents).values({ companyId, kind, name, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const hana = await hire('Hana', 'head', dev!.id);
    const bruno = await hire('Bruno', 'worker', dev!.id);
    const felix = await hire('Felix', 'worker', dev!.id);
    const otto = await hire('Otto', 'worker', ops!.id);
    const sent = Date.now() - CHANNEL_MS - 60_000;
    const work = (agentId: string, startedAt: Date) => ({ companyId, subscriptionId: sub!.id, agentId, prompt: 'work', status: 'running' as const, timeoutMs: 1000, startedAt });
    /* Bruno works on what came twenty minutes ago; Felix and Otto started anew after their ways went quiet. */
    await db.insert(jobs).values([work(bruno.id, new Date(sent + 1000)), work(felix.id, new Date()), work(otto.id, new Date())]);
    const way = (from: Endpoint, to: Endpoint) => app.ctx.bus.publish(companyId, { type: 'pulse', from, to }, sent);
    const inDev = (id: string) => ({ kind: 'agent' as const, id, departmentId: dev!.id });
    way({ kind: 'orchestrator' }, { kind: 'department', id: dev!.id });
    way({ kind: 'orchestrator' }, { kind: 'department', id: ops!.id });
    way(inDev(hana.id), inDev(bruno.id));
    way(inDev(hana.id), inDev(felix.id));
    way(inDev(bruno.id), inDev(hana.id));

    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.live).toEqual([{ from: { kind: 'orchestrator' }, to: { kind: 'department', id: dev!.id }, at: new Date(sent).toISOString(), held: true }]);
    expect(org.departments[0].live).toEqual([{ from: hana.id, to: bruno.id, at: new Date(sent).toISOString(), held: true }]);
    expect(org.departments[1].live).toEqual([]);
  });

  it('come held while young too, so a map that fetched them keeps them on past ten minutes while the work goes on', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const [bruno] = await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name: 'Bruno', departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning();
    await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: bruno!.id, prompt: 'work', status: 'running', timeoutMs: 1000, startedAt: new Date() });
    app.ctx.bus.publish(acme!.id, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: dev!.id } });
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.live).toEqual([{ from: { kind: 'orchestrator' }, to: { kind: 'department', id: dev!.id }, at: expect.any(String), held: true }]);
  });
});
