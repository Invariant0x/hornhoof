import { API_MODELS } from '@hornhoof/protocol';
import { asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agentChanges, agents, departments, jobs, people, subscriptions } from '../src/db/schema.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

/* Development with Bruno, a backend engineer on the team key; Oleg in Development has a Codex plan. */
async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'development' }, { template: 'sales' }] }, ...as(ceo) });
  const [dev, sales] = await db.select().from(departments).where(isNull(departments.parentId)).orderBy(asc(departments.position));
  const key = await app.inject({
    method: 'POST',
    url: '/api/subscriptions',
    payload: { provider: 'anthropic_api', kind: 'api_key', label: 'Team key', apiKey: 'sk-ant-api03-team-key-5678', target: { kind: 'any' } },
    ...as(ceo),
  });
  const teamKey = key.json().subscription.id as string;
  const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  const codex = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(oleg) })).json().subscriptions[0].id as string;
  await db.update(subscriptions).set({ status: 'ready', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] }).where(eq(subscriptions.id, codex));
  const role = app.ctx.templates.roles.get('DEV-BE')!;
  const hired = await app.inject({
    method: 'POST',
    url: `/api/departments/${dev!.id}/staff`,
    payload: { people: [{ role: 'DEV-BE', name: 'Bruno', model: 'claude-sonnet-5-5', subscription: teamKey, skills: role.skills.filter(s => s.on).map(s => s.id) }] },
    ...as(ceo),
  });
  const brunoId = hired.json().hired[0] as string;
  return { app, db, ceo, oleg, dev: dev!, sales: sales!, teamKey, codex, brunoId, role };
}

const open = (app: FastifyInstance, token: string, id: string) => app.inject({ url: `/api/agents/${id}`, ...as(token) });
const patch = (app: FastifyInstance, token: string, id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/agents/${id}`, payload, ...as(token) });

describe('the employee card', () => {
  it("opens an employee's card with its skills, prompt parts and raw text", async () => {
    const { app, ceo, dev, teamKey, codex, brunoId, role } = await company();
    const res = await open(app, ceo, brunoId);
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card).toMatchObject({
      id: brunoId,
      kind: 'worker',
      name: 'Bruno',
      role: { id: 'DEV-BE', title: { en: 'Backend engineer' } },
      department: { id: dev.id, name: 'Development' },
      product: null,
      model: 'claude-sonnet-5-5',
      subscription: { id: teamKey, label: 'Team key' },
      state: 'sleeping',
    });
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(role.skills.map(s => s.id));
    expect(card.skills.find((s: { id: string }) => s.id === 'hh-report-to-head')).toMatchObject({ on: true, locked: true, overridden: false, templateChanged: false });
    expect(card.parts.map((p: { kind: string }) => p.kind)).toEqual(['header', 'base', ...role.skills.filter(s => s.on).map(() => 'skill')]);
    expect(card.raw).toBe(card.parts.map((p: { text: string }) => p.text).join('\n\n'));
    expect(card.runsOn.map((r: { subscription: { id: string } }) => r.subscription.id).sort()).toEqual([teamKey, codex].sort());
    expect(card.runsOn.find((r: { subscription: { id: string } }) => r.subscription.id === teamKey).models).toEqual(API_MODELS.anthropic_api);
    expect(card.changes).toMatchObject([{ field: 'hired', personName: 'Ivan' }]);
  });

  it('moves an employee to another provider and resets its model', async () => {
    const { app, db, ceo, codex, brunoId } = await company();
    const res = await patch(app, ceo, brunoId, { subscription: codex });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ model: '', subscription: { id: codex, provider: 'codex' } });
    const picked = await patch(app, ceo, brunoId, { model: 'gpt-6.1-sol' });
    expect(picked.json().model).toBe('gpt-6.1-sol');
    const [bruno] = await db.select().from(agents).where(eq(agents.id, brunoId));
    expect(bruno).toMatchObject({ subscriptionId: codex, model: 'gpt-6.1-sol' });
  });

  it('refuses a model the subscription cannot run, and a subscription that cannot serve the department', async () => {
    const { app, db, ceo, sales, brunoId } = await company();
    const res = await patch(app, ceo, brunoId, { model: 'gpt-6.1-sol' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.reason).toBe('model_unknown');
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales.id] } });
    const theirs = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(maria) })).json().subscriptions[0].id;
    await db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, theirs));
    const moved = await patch(app, ceo, brunoId, { subscription: theirs });
    expect(moved.json().error.reason).toBe('subscription_cannot_serve');
  });

  it('turns a skill off but never a locked one', async () => {
    const { app, ceo, brunoId } = await company();
    const off = await patch(app, ceo, brunoId, { skills: { 'dev-tdd': false, 'dev-api-design': true } });
    expect(off.statusCode).toBe(200);
    const skills = off.json().skills;
    expect(skills.find((s: { id: string }) => s.id === 'dev-tdd').on).toBe(false);
    expect(skills.find((s: { id: string }) => s.id === 'dev-api-design')).toMatchObject({ on: true, locked: false });
    expect(off.json().raw).not.toContain('<!-- hh:skill dev-tdd -->');
    const locked = await patch(app, ceo, brunoId, { skills: { 'hh-report-to-head': false } });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.reason).toBe('skill_locked');
    expect((await patch(app, ceo, brunoId, { skills: { 'no-such-skill': true } })).json().error.reason).toBe('skill_unknown');
  });

  it('keeps every change with who made it', async () => {
    const { app, db, ceo, brunoId } = await company();
    await patch(app, ceo, brunoId, { name: 'Bruna', model: 'claude-opus-5-5', base: 'You own the billing API.' });
    const rows = await db.select().from(agentChanges).where(eq(agentChanges.agentId, brunoId)).orderBy(asc(agentChanges.createdAt));
    expect(rows.map(r => r.field).sort()).toEqual(['hired', 'model', 'name', 'prompt']);
    expect(rows.find(r => r.field === 'model')).toMatchObject({ before: 'claude-sonnet-5-5', after: 'claude-opus-5-5' });
    expect(rows.find(r => r.field === 'name')).toMatchObject({ before: 'Bruno', after: 'Bruna' });
    const card = (await open(app, ceo, brunoId)).json();
    expect(card.changes[0]).toMatchObject({ personName: 'Ivan', at: expect.any(String) });
    expect(card.parts[1]).toMatchObject({ text: 'You own the billing API.', overridden: true });
  });

  it('refuses a prompt edit that makes the instructions too long', async () => {
    const { app, ceo, brunoId, role } = await company();
    const long = 'x'.repeat(7000);
    const skillText = Object.fromEntries(role.skills.filter(s => s.on).slice(0, 4).map(s => [s.id, long]));
    const res = await patch(app, ceo, brunoId, { base: long, skillText });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.reason).toBe('instructions_too_long');
  });

  it('resets an employee to its template', async () => {
    const { app, ceo, brunoId, role } = await company();
    await patch(app, ceo, brunoId, { base: 'Mine.', skills: { 'dev-tdd': false }, skillText: { 'hh-report-to-head': 'Report briefly.' } });
    const res = await app.inject({ method: 'POST', url: `/api/agents/${brunoId}/reset`, ...as(ceo) });
    expect(res.statusCode).toBe(200);
    expect(res.json().parts[1]).toMatchObject({ text: role.body, overridden: false });
    expect(res.json().skills.filter((s: { on: boolean }) => s.on).map((s: { id: string }) => s.id)).toEqual(role.skills.filter(s => s.on).map(s => s.id));
    expect(res.json().changes[0].field).toBe('reset');
  });

  it('lets people of the department open the card but only the whole company change it', async () => {
    const { app, ceo, oleg, sales, brunoId } = await company();
    expect((await open(app, oleg, brunoId)).statusCode).toBe(200);
    expect((await patch(app, oleg, brunoId, { name: 'Bob' })).json().error.reason).toBe('company_scope_only');
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales.id] } });
    expect((await open(app, maria, brunoId)).json().error.reason).toBe('not_your_department');
  });

  it('removes an employee that is not working', async () => {
    const { app, db, ceo, teamKey, brunoId } = await company();
    const [bruno] = await db.select().from(agents).where(eq(agents.id, brunoId));
    const [job] = await db.insert(jobs).values({ companyId: bruno!.companyId, subscriptionId: teamKey, agentId: brunoId, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running' }).returning();
    const busy = await app.inject({ method: 'DELETE', url: `/api/agents/${brunoId}`, ...as(ceo) });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.reason).toBe('agent_working');
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    expect((await app.inject({ method: 'DELETE', url: `/api/agents/${brunoId}`, ...as(ceo) })).statusCode).toBe(204);
    expect((await open(app, ceo, brunoId)).statusCode).toBe(404);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments[0].employees).toEqual([]);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect((await app.inject({ method: 'DELETE', url: `/api/agents/${orchestrator!.id}`, ...as(ceo) })).json().error.reason).toBe('orchestrator_locked');
  });

  it("changes the orchestrator's model from his card", async () => {
    const { app, db, ceo } = await company();
    const card = (await open(app, ceo, 'orchestrator')).json();
    expect(card).toMatchObject({ kind: 'orchestrator', role: null, skills: [] });
    expect(card.raw).toContain('You are the Orchestrator');
    const res = await patch(app, ceo, 'orchestrator', { model: 'claude-sonnet-5-5' });
    expect(res.statusCode).toBe(200);
    expect(res.json().model).toBe('claude-sonnet-5-5');
    expect((await patch(app, ceo, 'orchestrator', { name: 'Boss' })).json().error.reason).toBe('orchestrator_card');
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect(orchestrator!.model).toBe('claude-sonnet-5-5');
  });

  it('lists the employees of each department on the map', async () => {
    const { app, ceo, brunoId, role } = await company();
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments[0].employees).toEqual([{ id: brunoId, name: 'Bruno', roleId: 'DEV-BE', title: role.title, kind: 'worker', model: 'claude-sonnet-5-5', provider: 'anthropic_api', state: 'sleeping' }]);
  });
});
