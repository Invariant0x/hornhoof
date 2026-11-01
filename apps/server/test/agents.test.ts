import { API_MODELS } from '@hornhoof/protocol';
import { asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { MAX_INSTRUCTIONS, parseServerMessage } from '@hornhoof/protocol';
import { agentChanges, agents, departments, jobs, people, proposals, subscriptions } from '../src/db/schema.js';
import { instructionsOf } from '../src/modules/agents/instructions.js';
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

describe('hiring', () => {
  it('hires an employee with as many skills as a hire takes, their bodies going as files', async () => {
    const { app, db, ceo, dev, teamKey } = await company();
    const own = app.ctx.templates.roles.get('DEV-FE')!.skills.filter(s => s.on).map(s => s.id);
    const many = [...new Set([...own, ...app.ctx.templates.skills.keys()])].filter(id => !id.startsWith('orch-')).slice(0, 60);
    const res = await app.inject({
      method: 'POST',
      url: `/api/departments/${dev.id}/staff`,
      payload: { people: [{ role: 'DEV-FE', name: 'Ira', model: 'claude-sonnet-5-5', subscription: teamKey, skills: many }] },
      ...as(ceo),
    });
    expect(res.statusCode).toBe(201);
    const [ira] = await db.select().from(agents).where(eq(agents.name, 'Ira'));
    const told = await instructionsOf(app.ctx, ira!);
    expect(told.text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
    expect(told.skills.length + many.filter(id => app.ctx.templates.skills.get(id)!.kind === 'core').length).toBe(many.length);
  });
});

describe('the employee card', () => {
  it("opens an employee's card with its skills, prompt parts and raw text", async () => {
    const { app, db, ceo, dev, teamKey, codex, brunoId, role } = await company();
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
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect(card.runsOn.map((r: { subscription: { id: string } }) => r.subscription.id)).toEqual([codex, orchestrator!.subscriptionId, teamKey]);
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

  it('sets how hard an employee thinks, from the levels its model takes, and keeps who changed it', async () => {
    const { app, db, ceo, brunoId } = await company();
    expect((await open(app, ceo, brunoId)).json().effort).toBeNull();
    const res = await patch(app, ceo, brunoId, { effort: 'max' });
    expect(res.statusCode).toBe(200);
    expect(res.json().effort).toBe('max');
    const refused = await patch(app, ceo, brunoId, { effort: 'ultra' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.reason).toBe('effort_unknown');
    const [bruno] = await db.select().from(agents).where(eq(agents.id, brunoId));
    expect(bruno!.effort).toBe('max');
    const rows = await db.select().from(agentChanges).where(eq(agentChanges.agentId, brunoId));
    expect(rows.find(r => r.field === 'effort')).toMatchObject({ before: null, after: 'max' });
    expect((await patch(app, ceo, brunoId, { effort: null })).json().effort).toBeNull();
  });

  it('shows the effort each employee runs at on the map: Kimi at its most unless set, the others as set', async () => {
    const { app, db, ceo, oleg, brunoId } = await company();
    const kimi = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['kimi'] }, ...as(oleg) })).json().subscriptions[0].id as string;
    await db.update(subscriptions).set({ status: 'ready', models: [{ id: 'kimi-code/k3', name: 'K3', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }] }).where(eq(subscriptions.id, kimi));
    const effortOnMap = async () => (await app.inject({ url: '/api/org', ...as(ceo) })).json().departments[0].employees[0].effort;
    await patch(app, ceo, brunoId, { effort: 'high' });
    expect(await effortOnMap()).toBe('high');
    /* Another provider's levels may differ, so a move goes back to its default. */
    const moved = (await patch(app, ceo, brunoId, { subscription: kimi })).json();
    expect(moved).toMatchObject({ effort: null, model: '' });
    expect(await effortOnMap()).toBe('max');
    await patch(app, ceo, brunoId, { model: 'kimi-code/k3', effort: 'low' });
    expect(await effortOnMap()).toBe('low');
  });

  it('shows a Codex employee on the map at the most its model takes unless set', async () => {
    const { app, db, ceo, codex, brunoId } = await company();
    await db.update(subscriptions).set({ models: [{ id: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }] }).where(eq(subscriptions.id, codex));
    const effortOnMap = async () => (await app.inject({ url: '/api/org', ...as(ceo) })).json().departments[0].employees[0].effort;
    expect((await patch(app, ceo, brunoId, { subscription: codex })).statusCode).toBe(200);
    expect(await effortOnMap()).toBe('xhigh');
    await patch(app, ceo, brunoId, { model: 'gpt-6.1-sol', effort: 'low' });
    expect(await effortOnMap()).toBe('low');
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
    const off = await patch(app, ceo, brunoId, { skills: { 'dev-debugging': false, 'dev-api-design': true } });
    expect(off.statusCode).toBe(200);
    const skills = off.json().skills;
    expect(skills.find((s: { id: string }) => s.id === 'dev-debugging').on).toBe(false);
    expect(skills.find((s: { id: string }) => s.id === 'dev-api-design')).toMatchObject({ on: true, locked: false });
    expect(off.json().raw).not.toContain('<!-- hh:skill dev-debugging -->');
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

  it('keeps the instructions short enough for a node to take them, counting only what is not a skill file', async () => {
    const { app, db, ceo, brunoId } = await company();
    const card = (await open(app, ceo, brunoId)).json();
    const told = async () => (await instructionsOf(app.ctx, (await db.select().from(agents).where(eq(agents.id, brunoId)))[0]!)).text;
    const room = MAX_INSTRUCTIONS - (await told()).length;
    const core = (id: string) => app.ctx.templates.skills.get(id)?.kind === 'core';
    /* Grows the base and the core skills, which the instructions carry whole, by n characters in all, each within the
       8,000 a field takes. */
    const grown = (n: number) => {
      const body: { base?: string; skillText: Record<string, string> } = { skillText: {} };
      for (const part of card.parts as { kind: string; id: string; text: string }[]) {
        if (part.kind === 'header' || (part.kind === 'skill' && !core(part.id))) continue;
        /* A skill's part carries its markers and heading around the text it takes. */
        const text = part.kind === 'base' ? part.text : /\n\n([\s\S]*)\n<!-- \/hh:skill -->$/.exec(part.text)![1]!;
        const add = Math.min(n, 8000 - text.length);
        n -= add;
        if (part.kind === 'base') body.base = text + 'x'.repeat(add);
        else body.skillText[part.id] = text + 'x'.repeat(add);
      }
      return body;
    };
    expect((await patch(app, ceo, brunoId, grown(room + 1))).json().error.reason).toBe('instructions_too_long');
    expect((await patch(app, ceo, brunoId, grown(room))).statusCode).toBe(200);
    /* A skill that goes as a file may grow to all a field takes. */
    const file = (card.parts as { kind: string; id: string }[]).find(p => p.kind === 'skill' && !core(p.id))!;
    expect((await patch(app, ceo, brunoId, { skillText: { [file.id]: 'y'.repeat(8000) } })).statusCode).toBe(200);
    const run = { type: 'job.run', jobId: brunoId, subscriptionId: brunoId, provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 1, secret: null, instructions: await told(), toolToken: null };
    expect(parseServerMessage(JSON.stringify(run))).not.toBeNull();
  });

  it('keeps both of two changes sent at once', async () => {
    const { app, ceo, brunoId } = await company();
    /* The first change waits before it writes, so the second reads the card before the first lands. */
    const db = app.ctx.db;
    const transaction = db.transaction.bind(db);
    let held = false;
    db.transaction = (async (...args: Parameters<typeof transaction>) => {
      if (!held) {
        held = true;
        await new Promise(r => setTimeout(r, 100));
      }
      return transaction(...args);
    }) as typeof db.transaction;
    const answers = await Promise.all([patch(app, ceo, brunoId, { skills: { 'dev-debugging': false } }), patch(app, ceo, brunoId, { skills: { 'dev-api-design': true } })]);
    expect(answers.map(a => a.statusCode)).toEqual([200, 200]);
    const on = new Set(((await open(app, ceo, brunoId)).json().skills as { id: string; on: boolean }[]).filter(s => s.on).map(s => s.id));
    expect([on.has('dev-debugging'), on.has('dev-api-design')]).toEqual([false, true]);
  });

  it('removes a department whose employees were removed and that had a staff proposal', async () => {
    const { app, db, ceo, sales, teamKey } = await company();
    const role = app.ctx.templates.roles.get('SAL-AE')!;
    const hired = await app.inject({
      method: 'POST',
      url: `/api/departments/${sales.id}/staff`,
      payload: { people: [{ role: 'SAL-AE', name: 'Ada', model: '', subscription: teamKey, skills: role.skills.filter(s => s.on).map(s => s.id) }] },
      ...as(ceo),
    });
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    await db.insert(proposals).values({ companyId: sales.companyId, agentId: orchestrator!.id, kind: 'staff', departmentId: sales.id, items: [], status: 'dismissed' });
    await app.inject({ method: 'DELETE', url: `/api/agents/${hired.json().hired[0]}`, ...as(ceo) });
    const removed = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ department: sales.id, note: '', remove: true }] }, ...as(ceo) });
    expect(removed.statusCode).toBe(201);
    expect(await db.select().from(departments).where(eq(departments.id, sales.id))).toEqual([]);
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
    await patch(app, ceo, brunoId, { base: 'Mine.', skills: { 'dev-debugging': false }, skillText: { 'hh-report-to-head': 'Report briefly.' } });
    const res = await app.inject({ method: 'POST', url: `/api/agents/${brunoId}/reset`, ...as(ceo) });
    expect(res.statusCode).toBe(200);
    expect(res.json().parts[1]).toMatchObject({ text: role.body, overridden: false });
    expect(res.json().skills.filter((s: { on: boolean }) => s.on).map((s: { id: string }) => s.id)).toEqual(role.skills.filter(s => s.on).map(s => s.id));
    expect(res.json().changes[0].field).toBe('reset');
  });

  it('lets people of the department change its employees, and only the whole company remove them', async () => {
    const { app, ceo, oleg, sales, brunoId } = await company();
    expect((await open(app, oleg, brunoId)).json().canEdit).toBe(true);
    expect((await patch(app, oleg, brunoId, { name: 'Bob' })).json().name).toBe('Bob');
    expect((await app.inject({ method: 'POST', url: `/api/agents/${brunoId}/reset`, ...as(oleg) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/agents/${brunoId}`, ...as(oleg) })).json().error.reason).toBe('company_scope_only');
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales.id] } });
    expect((await open(app, maria, brunoId)).json().error.reason).toBe('not_your_department');
  });

  it('lets go of a plan whose owner lost the department or was disabled', async () => {
    const { app, db, ceo, dev, sales, codex, brunoId } = await company();
    const [oleg] = await db.select().from(people).where(eq(people.name, 'Oleg'));
    const access = (departments: string[]) => app.inject({ method: 'PATCH', url: `/api/people/${oleg!.id}`, payload: { access: { departments } }, ...as(ceo) });
    await patch(app, ceo, brunoId, { subscription: codex });
    await access([dev.id, sales.id]);
    expect((await open(app, ceo, brunoId)).json().subscription.id).toBe(codex);
    await access([sales.id]);
    expect((await open(app, ceo, brunoId)).json()).toMatchObject({ subscription: null, state: 'needs_subscription' });
    expect((await open(app, ceo, brunoId)).json().changes[0]).toMatchObject({ field: 'subscription', personName: 'Ivan' });

    await access([dev.id]);
    await patch(app, ceo, brunoId, { subscription: codex });
    await app.inject({ method: 'PATCH', url: `/api/people/${oleg!.id}`, payload: { status: 'disabled' }, ...as(ceo) });
    expect((await open(app, ceo, brunoId)).json().subscription).toBe(null);
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
    expect((await patch(app, ceo, 'orchestrator', { effort: 'high' })).json().effort).toBe('high');
    expect((await patch(app, ceo, 'orchestrator', { name: 'Boss' })).json().error.reason).toBe('orchestrator_card');
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect(orchestrator!.model).toBe('claude-sonnet-5-5');
  });

  it('lists the employees of each department on the map', async () => {
    const { app, ceo, brunoId, role } = await company();
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments[0].employees).toEqual([
      { id: brunoId, name: 'Bruno', roleId: 'DEV-BE', title: role.title, kind: 'worker', model: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5', provider: 'anthropic_api', effort: 'medium', state: 'sleeping', status: 'idle', on: true, task: null, timer: null, context: null },
    ]);
  });

  it('lists the head first, then by hire, people hired together in the order of the roster', async () => {
    const { app, ceo, dev, teamKey, brunoId } = await company();
    const line = (role: string, name: string) => ({ role, name, model: '', subscription: teamKey, skills: app.ctx.templates.roles.get(role)!.skills.filter(s => s.on).map(s => s.id) });
    await app.inject({
      method: 'POST',
      url: `/api/departments/${dev.id}/staff`,
      payload: { people: [line('DEV-RED', 'Rita'), line('DEV-REV', 'Rob'), line('DEV-HEAD', 'Hana'), line('DEV-ARCH', 'Ann')] },
      ...as(ceo),
    });
    await patch(app, ceo, brunoId, { model: 'claude-opus-5-5' });
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    /* The reviewer is in the default roster; the architect and the red team are offered on top. */
    expect(org.departments[0].employees.map((e: { name: string }) => e.name)).toEqual(['Hana', 'Bruno', 'Rob', 'Ann', 'Rita']);
  });
});
