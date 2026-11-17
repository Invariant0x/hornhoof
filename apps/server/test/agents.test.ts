import { API_MODELS } from '@hornhoof/protocol';
import { asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentChanges, agents, departments, jobs, people, proposals, subscriptions, requests, tasks, teams } from '../src/db/schema.js';
import { instructionsOf, renderInstructions } from '../src/modules/agents/instructions.js';
import { answer, ask, createTask, submit, verdict } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { as, invitePerson, setUpCompany, testApp, ownPlan, until, echelonsTurn } from './helpers.js';

/* Which employees' lanes were asked for, in order: a change to an employee waits in its lane while another is written. */
const lanes = vi.hoisted(() => [] as string[]);
vi.mock('../src/modules/conversation/queue.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/modules/conversation/queue.js')>();
  return { ...real, onAgent: ((ctx, agentId, fn) => { lanes.push(agentId); return real.onAgent(ctx, agentId, fn); }) as typeof real.onAgent };
});

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
  const codeSource = async () => {
    await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, dev!.id));
    app.ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
    app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  };
  const snapshot = async (id: string) => {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    return routeSnapshot(await routeOf(db, task!), task!.assigneeAgentId);
  };
  await echelonsTurn(db, dev!.companyId);
  return { app, db, ceo, oleg, dev: dev!, sales: sales!, teamKey, codex, brunoId, role, codeSource, snapshot };
}

const open = (app: FastifyInstance, token: string, id: string) => app.inject({ url: `/api/agents/${id}`, ...as(token) });
const patch = (app: FastifyInstance, token: string, id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/agents/${id}`, payload, ...as(token) });

describe('hiring', () => {
  it('hires an employee with a long role and delivers all of its skills', async () => {
    const { app, db, ceo, dev, teamKey } = await company();
    const role = app.ctx.templates.roles.get('DEV-FE')!;
    const detail = 'Keep the frontend contract. '.repeat(8_000);
    app.ctx.templates = { ...app.ctx.templates, roles: new Map(app.ctx.templates.roles).set(role.id, { ...role, body: role.body + detail }) };
    const own = role.skills.filter(s => s.on).map(s => s.id);
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
    expect(told.text.includes(detail)).toBe(true);
    expect(told.skills.length + many.filter(id => app.ctx.templates.skills.get(id)!.kind === 'core').length).toBe(many.length);
  });
});

describe('the employee card', () => {
  it('stores an orchestrator assignment separately from its standing identity', async () => {
    const { app, db, ceo } = await company();
    const assignment = '\nCoordinate the named company goals.  \n';
    const res = await patch(app, ceo, 'orchestrator', { base: assignment });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.parts.find((p: { kind: string }) => p.kind === 'base')).toMatchObject({ text: 'You are the Orchestrator who runs the company with its CEO, can do anything in the company and in Hornhoof itself, sees everything and can change its own system.', overridden: false });
    expect(card.parts.find((p: { kind: string }) => p.kind === 'assignment').text).toContain(assignment);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect((await instructionsOf(app.ctx, orchestrator!)).text).toContain(assignment);
    expect((await instructionsOf(app.ctx, orchestrator!, false)).text).toContain(assignment);
    expect((await patch(app, ceo, 'orchestrator', { base: null })).statusCode).toBe(200);
    expect((await open(app, ceo, 'orchestrator')).json().parts.find((p: { kind: string }) => p.kind === 'assignment').text).not.toContain(assignment);
  });

  it("opens an employee's card with its skills, prompt parts and raw text", async () => {
    const { app, db, ceo, dev, teamKey, codex, brunoId, role } = await company();
    const res = await open(app, ceo, brunoId);
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card).toMatchObject({
      id: brunoId,
      kind: 'worker',
      name: 'Bruno',
      role: { id: 'DEV-BE', title: { en: 'Backend engineer' }, effort: 'xhigh' },
      department: { id: dev.id, name: 'Development' },
      product: null,
      model: 'claude-sonnet-5-5',
      subscription: { id: teamKey, label: 'Team key' },
      state: 'sleeping',
    });
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(role.skills.map(s => s.id));
    expect(card.skills.find((s: { id: string }) => s.id === 'hh-report-to-head')).toMatchObject({ on: true, locked: true, overridden: false, templateChanged: false });
    expect(card.parts.map((p: { kind: string }) => p.kind)).toEqual(['header', 'base', 'assignment', ...role.skills.filter(s => s.on).map(() => 'skill')]);
    expect(card.raw).toBe(card.parts.map((p: { text: string }) => p.text).join('\n\n'));
    const [bruno] = await db.select().from(agents).where(eq(agents.id, brunoId));
    expect(card).not.toHaveProperty('instructions');
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect(card.runsOn.map((r: { subscription: { id: string } }) => r.subscription.id)).toEqual([codex, orchestrator!.subscriptionId, teamKey]);
    expect(card.runsOn.find((r: { subscription: { id: string } }) => r.subscription.id === teamKey).models).toEqual(API_MODELS.anthropic_api);
    expect(card.changes).toMatchObject([{ field: 'hired', personName: 'Ivan', actingAgent: null }]);
  });

  it('moves an employee to another provider, where it starts on the model its role asks for, and lets a person pick the program default', async () => {
    const { app, db, ceo, codex, brunoId } = await company();
    const res = await patch(app, ceo, brunoId, { subscription: codex });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ model: 'gpt-6.1-sol', subscription: { id: codex, provider: 'codex' } });
    expect((await patch(app, ceo, brunoId, { model: '' })).json().model).toBe('');
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

  it('shows the fitted role effort on the map for Kimi unless a person picks a level', async () => {
    const { app, db, ceo, oleg, brunoId } = await company();
    const kimi = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['kimi'] }, ...as(oleg) })).json().subscriptions[0].id as string;
    await db.update(subscriptions).set({ status: 'ready', models: [{ id: 'kimi-code/k3', name: 'K3', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }] }).where(eq(subscriptions.id, kimi));
    const effortOnMap = async () => (await app.inject({ url: '/api/org', ...as(ceo) })).json().departments[0].employees[0].effort;
    await patch(app, ceo, brunoId, { effort: 'high' });
    expect(await effortOnMap()).toBe('high');
    /* Another provider's levels may differ, so a move goes back to its default. */
    const moved = (await patch(app, ceo, brunoId, { subscription: kimi })).json();
    expect(moved).toMatchObject({ effort: null, model: '' });
    expect(await effortOnMap()).toBe('high');
    await patch(app, ceo, brunoId, { model: 'kimi-code/k3', effort: 'low' });
    expect(await effortOnMap()).toBe('low');
  });

  it('shows a Codex employee on the map at its role effort unless set', async () => {
    const { app, db, ceo, codex, brunoId } = await company();
    await db.update(subscriptions).set({ models: [{ id: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'], defaultEffort: 'medium' }] }).where(eq(subscriptions.id, codex));
    const effortOnMap = async () => (await app.inject({ url: '/api/org', ...as(ceo) })).json().departments[0].employees[0].effort;
    expect((await patch(app, ceo, brunoId, { subscription: codex })).statusCode).toBe(200);
    expect(await effortOnMap()).toBe('xhigh');
    await patch(app, ceo, brunoId, { model: 'gpt-6.1-sol', effort: 'low' });
    expect(await effortOnMap()).toBe('low');
  });

  it('shows no level for a model with no known efforts, and its own default for a role without one', async () => {
    const { app, db, ceo, codex, brunoId } = await company();
    const org = async () => (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect((await org()).orchestrator.effort).toBe('xhigh');
    await patch(app, ceo, brunoId, { subscription: codex });
    expect((await org()).departments[0].employees[0].effort).toBeNull();
    app.ctx.templates.roles.set('DEV-BE', { ...app.ctx.templates.roles.get('DEV-BE')!, effort: undefined });
    await db.update(subscriptions).set({ models: [{ id: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'high', 'max'], defaultEffort: 'low' }] }).where(eq(subscriptions.id, codex));
    await patch(app, ceo, brunoId, { model: 'gpt-6.1-sol' });
    expect((await org()).departments[0].employees[0].effort).toBe('low');
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
    expect(card.parts.find((p: { kind: string }) => p.kind === 'assignment')).toMatchObject({ overridden: true });
    expect(card.parts.find((p: { kind: string }) => p.kind === 'assignment').text).toContain('You own the billing API.');
  });

  it('keeps long assignments and skill overrides whole on the employee card', async () => {
    const { app, db, ceo, brunoId } = await company();
    const card = (await open(app, ceo, brunoId)).json();
    const parts = card.parts as { kind: string; id: string }[];
    const core = parts.find(p => p.kind === 'skill' && app.ctx.templates.skills.get(p.id)?.kind === 'core')!;
    const file = 'dev-tdd';
    const base = 'Own the checkout.\n'.repeat(15_000);
    const body = 'Review the whole change.\n'.repeat(9_000);
    const res = await patch(app, ceo, brunoId, { base, skillText: { [core.id]: body, [file]: body } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('instructions');
    const [bruno] = await db.select().from(agents).where(eq(agents.id, brunoId));
    const told = await instructionsOf(app.ctx, bruno!);
    expect(told.text).toContain(base);
    expect(told.text).toContain(body);
    expect(told.skills.find(skill => skill.name === file)?.body.endsWith(body)).toBe(true);
  });

  it('preserves a tracker nudge written after the card has read the employee', async () => {
    const { app, db, ceo, brunoId } = await company();
    const last = new Date('2026-11-15T12:00:00Z');
    const nudged = new Date('2026-11-15T12:02:00Z');
    await db.update(agents).set({ timerMinutes: 60, timerOrder: 'Check the tracker.', timerAt: last }).where(eq(agents.id, brunoId));
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async (...args) => {
      await db.update(agents).set({ timerAt: nudged, timerNudgedAt: nudged }).where(eq(agents.id, brunoId));
      return transaction(...args);
    });
    const edited = await patch(app, ceo, brunoId, { name: 'Bruna' });
    expect(edited.statusCode).toBe(200);
    const [row] = await db.select().from(agents).where(eq(agents.id, brunoId));
    expect(row).toMatchObject({ name: 'Bruna', timerAt: nudged, timerNudgedAt: nudged });
  });

  it('keeps both of two changes sent at once', async () => {
    const { app, ceo, brunoId } = await company();
    /* The first change holds its write until the second asked for the employee's lane, so the second would read the card
       before the first lands if the lane let it in. */
    const db = app.ctx.db;
    const transaction = db.transaction.bind(db);
    const asked = () => lanes.filter(id => id === brunoId).length;
    const before = asked();
    let held = false;
    db.transaction = (async (...args: Parameters<typeof transaction>) => {
      if (!held) {
        held = true;
        await until(() => asked() >= before + 2);
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

  it('takes a prompt edit far longer than nodes before skill files took', async () => {
    const { app, db, ceo, brunoId, role } = await company();
    const long = 'x'.repeat(7000);
    const skillText = Object.fromEntries(role.skills.filter(s => s.on).slice(0, 4).map(s => [s.id, long]));
    expect((await patch(app, ceo, brunoId, { base: long, skillText })).statusCode).toBe(200);
    const [bruno] = await db.select().from(agents).where(eq(agents.id, brunoId));
    expect(renderInstructions(app.ctx.templates, bruno!, { company: 'Acme', department: 'Development', product: null }).whole).toContain(long);
  });

  it('resets template abilities while preserving the employee assignment', async () => {
    const { app, db, ceo, teamKey, brunoId, role } = await company();
    await patch(app, ceo, brunoId, { effort: 'max', base: 'Mine.', skills: { 'dev-debugging': false }, skillText: { 'hh-report-to-head': 'Report briefly.' } });
    const res = await app.inject({ method: 'POST', url: `/api/agents/${brunoId}/reset`, ...as(ceo) });
    expect(res.statusCode).toBe(200);
    expect(res.json().parts[1]).toMatchObject({ text: role.body, overridden: false });
    expect(res.json().parts.find((p: { kind: string }) => p.kind === 'assignment').text).toContain('Mine.');
    expect((await db.select().from(agents).where(eq(agents.id, brunoId)))[0]!.overrides).toEqual({ base: 'Mine.' });
    expect(res.json().skills.filter((s: { on: boolean }) => s.on).map((s: { id: string }) => s.id)).toEqual(role.skills.filter(s => s.on).map(s => s.id));
    expect(res.json().effort).toBeNull();
    expect(res.json()).toMatchObject({ model: 'claude-sonnet-5-5', subscription: { id: teamKey } });
    expect((await db.select().from(agents).where(eq(agents.id, brunoId)))[0]!.effort).toBeNull();
    expect(res.json().changes[0]).toMatchObject({ field: 'reset', before: { effort: 'max' }, after: { effort: null } });
  });

  it('refreshes the map after resetting an effort to the role', async () => {
    const { app, ceo, dev, brunoId } = await company();
    await patch(app, ceo, brunoId, { effort: 'low' });
    const heard: string[] = [];
    onTestFinished(app.ctx.bus.subscribe(dev.companyId, message => heard.push(message.type)));
    expect((await app.inject({ method: 'POST', url: `/api/agents/${brunoId}/reset`, ...as(ceo) })).statusCode).toBe(200);
    expect(heard).toContain('org');
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments[0].employees[0].effort).toBe('xhigh');
  });

  it('lets someone of a product who owns the plan change an employee, and only the whole company or the department\'s people remove them', async () => {
    const { app, db, ceo, oleg, dev, sales, brunoId } = await company();
    /* Pia has only Shop, a product of Development, where Bruno works on her plan. */
    const [shop] = await db.insert(departments).values({ companyId: dev.companyId, name: 'Shop', parentId: dev.id, roleCode: 'DEV' }).returning();
    await db.update(agents).set({ productId: shop!.id }).where(eq(agents.id, brunoId));
    const pia = await invitePerson(app, ceo, { name: 'Pia', email: 'pia@acme.com', access: { departments: [shop!.id] } });
    await ownPlan(db, 'pia@acme.com', brunoId);
    expect((await open(app, pia, brunoId)).json()).toMatchObject({ canEdit: true, canRemove: false });
    expect((await patch(app, pia, brunoId, { name: 'Bob' })).json().name).toBe('Bob');
    expect((await app.inject({ method: 'POST', url: `/api/agents/${brunoId}/reset`, ...as(pia) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/agents/${brunoId}`, ...as(pia) })).json().error.reason).toBe('department_owner_only');
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales.id] } });
    expect((await open(app, maria, brunoId)).json().error.reason).toBe('agent_hidden');
    /* Oleg is given Development and runs it: he removes an employee on someone else's plan. */
    expect((await open(app, oleg, brunoId)).json()).toMatchObject({ canEdit: true, canRemove: true });
    expect((await app.inject({ method: 'DELETE', url: `/api/agents/${brunoId}`, ...as(oleg) })).statusCode).toBe(204);
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

  it('names the model its role asks for when an employee gets a plan and no model comes with it', async () => {
    const { app, ceo, teamKey, codex, brunoId } = await company();
    /* Another program does not know the old model: the backend engineer's middle strength is the nearest the plan has. */
    expect((await patch(app, ceo, brunoId, { subscription: codex })).json().model).toBe('gpt-6.1-sol');
    expect((await patch(app, ceo, brunoId, { subscription: null })).json().model).toBe('');
    expect((await patch(app, ceo, brunoId, { subscription: teamKey })).json().model).toBe('claude-sonnet-5-5');
    expect((await patch(app, ceo, brunoId, { subscription: codex, model: '' })).json().model).toBe('');
    expect((await patch(app, ceo, brunoId, { subscription: teamKey, model: 'claude-opus-5-5' })).json().model).toBe('claude-opus-5-5');
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
      { id: brunoId, name: 'Bruno', roleId: 'DEV-BE', title: role.title, kind: 'worker', model: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5', provider: 'anthropic_api', effort: 'xhigh', state: 'sleeping', status: 'idle', on: true, opens: true, task: null, timer: null, context: null, alarm: null, program: null, retry: null, failure: null, held: null, obsolete: null },
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
    /* The architect and the reviewer are in the default roster, in its order; the red team is offered on top. */
    expect(org.departments[0].employees.map((e: { name: string }) => e.name)).toEqual(['Hana', 'Bruno', 'Ann', 'Rob', 'Rita']);
  });

  it.each([false, true])('replaces a checker moved into a sub-unit while retaining required Review and its question (question: %s)', async withQuestion => {
    const { app, db, ceo, dev, teamKey, brunoId, codeSource, snapshot } = await company();
    await codeSource();
    const line = (role: string, name: string) => ({ role, name, model: 'claude-sonnet-5-5', subscription: teamKey, skills: app.ctx.templates.roles.get(role)!.skills.filter(s => s.on).map(s => s.id) });
    const staffed = await app.inject({ method: 'POST', url: `/api/departments/${dev.id}/staff`, payload: { people: [line('DEV-HEAD', 'Hana'), line('DEV-REV', 'Rita'), line('DEV-REV', 'Rob')] }, ...as(ceo) });
    expect(staffed.statusCode).toBe(201);
    const [hanaId, ritaId, robId] = staffed.json().hired as [string, string, string];
    const [urgent] = await db.insert(teams).values({ companyId: dev.companyId, departmentId: dev.id, name: 'Urgent fixes' }).returning();
    const create = (title: string) => createTask(app.ctx, { agentId: hanaId }, { title, brief: '', body: '', departmentId: dev.id, assigneeAgentId: brunoId, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId: ritaId });
    const { task: checking } = await create('Checkout API');
    const { task: atWork } = await create('Refund API');
    await wakeAll(app.ctx, (await submit(app.ctx, brunoId, checking.id, { summary: 'Candidate', evidence: 'Changed tests.', review: { baseCommit: BASE } })).wakes);
    const candidateId = (await snapshot(checking.id)).candidateId;
    expect(await snapshot(checking.id)).toMatchObject({ stage: 'review', ownerAgentId: ritaId });
    expect(await db.select().from(jobs).where(eq(jobs.agentId, ritaId))).toMatchObject([{ taskId: checking.id, status: 'queued' }]);
    const question = withQuestion ? await ask(app.ctx, ritaId, checking.id, { kind: 'question', text: 'Which checkout version?' }) : null;

    expect((await patch(app, ceo, ritaId, { team: urgent!.id })).statusCode).toBe(200);
    expect(await snapshot(checking.id)).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: robId, candidateId });
    expect((await snapshot(atWork.id)).stages.find(step => step.stage === 'review')).toMatchObject({ status: 'pending', ownerAgentId: null });
    expect(await db.select().from(jobs).where(eq(jobs.agentId, ritaId))).toMatchObject([{ taskId: checking.id, status: 'failed', error: 'switched_off' }]);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, robId))).toMatchObject([{ taskId: checking.id, status: 'queued', startedAt: null }]);
    if (question) {
      expect((await db.select().from(requests).where(eq(requests.id, question.request.id)))[0]).toMatchObject({ status: 'open', answeredAt: null });
      await expect(verdict(app.ctx, robId, checking.id, { pass: true, reviewedCommit: HEAD, comment: 'Checked.' })).rejects.toMatchObject({ reason: 'task_invalid' });
    }

    expect((await patch(app, ceo, robId, { team: urgent!.id })).statusCode).toBe(200);
    expect(await snapshot(checking.id)).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null, candidateId });
    expect((await db.select().from(tasks).where(eq(tasks.id, checking.id)))[0]!.status).toBe('waiting');
    expect(await db.select().from(jobs).where(eq(jobs.agentId, robId))).toMatchObject([{ taskId: checking.id, status: 'failed', error: 'switched_off' }]);
    if (question) expect((await db.select().from(requests).where(eq(requests.id, question.request.id)))[0]).toMatchObject({ status: 'open', answeredAt: null });
  });

  it.each([false, true])('keeps current and independent questions when a Review owner moves into a sub-unit (other question: %s)', async otherAsks => {
    const { app, db, ceo, dev, teamKey, codex, brunoId, codeSource, snapshot } = await company();
    await codeSource();
    const staff = (name: string, kind: 'head' | 'worker', roleKey: string, subscriptionId: string, model: string) => ({ companyId: dev.companyId, departmentId: dev.id, kind, roleKey, name, model, subscriptionId, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id) });
    const [head, rita, rob] = await db.insert(agents).values([
      staff('Hana', 'head', 'DEV-HEAD', teamKey, 'claude-sonnet-5-5'),
      staff('Rita', 'worker', 'DEV-REV', teamKey, 'claude-sonnet-5-5'),
      staff('Rob', 'worker', 'DEV-REV', codex, 'gpt-6.1-sol'),
    ]).returning();
    const [team] = await db.insert(teams).values({ companyId: dev.companyId, departmentId: dev.id, name: 'Urgent fixes' }).returning();
    const create = async (title: string, reviewerAgentId: string) => (await createTask(app.ctx, { agentId: head!.id }, { title, brief: '', body: '', departmentId: dev.id, assigneeAgentId: brunoId, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId })).task;
    const task = await create('Checkout review', rita!.id);
    const independent = await create('Refund review', rob!.id);
    const code = { summary: 'Candidate', evidence: 'Changed tests.', review: { baseCommit: BASE } };
    await submit(app.ctx, brunoId, task.id, code);
    await submit(app.ctx, brunoId, independent.id, code);
    const candidateId = (await snapshot(task.id)).candidateId;
    const first = await ask(app.ctx, rita!.id, task.id, { kind: 'question', text: 'Which version?' });
    const second = otherAsks ? await ask(app.ctx, rob!.id, independent.id, { kind: 'question', text: 'Which deployment?' }) : null;
    const { task: work } = await createTask(app.ctx, { agentId: head!.id }, { title: 'Review tooling', brief: '', body: '', departmentId: dev.id, assigneeAgentId: rita!.id, executor: true });
    const ownQuestion = await ask(app.ctx, rita!.id, work.id, { kind: 'question', text: 'Which tool version?' });
    const [history] = await db.insert(requests).values({ companyId: dev.companyId, taskId: task.id, agentId: rita!.id, kind: 'question', text: 'Settled scope', status: 'answered', answer: 'Checkout only', answeredAt: new Date() }).returning();

    expect((await patch(app, ceo, rita!.id, { team: team!.id })).statusCode).toBe(200);
    expect(await snapshot(task.id)).toMatchObject({ stage: 'review', ownerAgentId: rob!.id, candidateId });
    for (const request of [first.request, ownQuestion.request, ...(second ? [second.request] : [])]) expect((await db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'open', answeredAt: null });
    expect(await snapshot(work.id)).toMatchObject({ stage: 'development', phase: 'waiting', ownerAgentId: null });
    expect((await snapshot(independent.id)).ownerAgentId).toBe(rob!.id);
    expect((await db.select().from(requests).where(eq(requests.id, history!.id)))[0]).toMatchObject({ status: 'answered', answer: 'Checkout only' });
    await expect(verdict(app.ctx, rob!.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Checked.' })).rejects.toMatchObject({ reason: 'task_invalid' });
    const [person] = await db.select().from(people);
    const answered = await answer(app.ctx, { personId: person!.id }, first.request.id, { answer: 'Use the current checkout.' });
    expect(answered.wakes.map(wake => wake.agentId)).toEqual([rob!.id]);
    await verdict(app.ctx, rob!.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Checked the specified version.' });
    expect((await snapshot(task.id)).stage).toBe('tests');
    if (second) await expect(verdict(app.ctx, rob!.id, independent.id, { pass: true, reviewedCommit: HEAD, comment: 'Checked.' })).rejects.toMatchObject({ reason: 'task_invalid' });
  });

  it('keeps an executor question when moving into a sub-unit leaves its current assignment', async () => {
    const { app, db, ceo, dev, teamKey, brunoId, snapshot } = await company();
    const [head] = await db.insert(agents).values({ companyId: dev.companyId, departmentId: dev.id, kind: 'head', roleKey: 'DEV-HEAD', name: 'Hana', model: '', subscriptionId: teamKey }).returning();
    const [team] = await db.insert(teams).values({ companyId: dev.companyId, departmentId: dev.id, name: 'Urgent fixes' }).returning();
    const { task } = await createTask(app.ctx, { agentId: head!.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: brunoId, executor: true, resultKind: 'code' });
    const question = await ask(app.ctx, brunoId, task.id, { kind: 'question', text: 'Which checkout version?' });

    expect((await patch(app, ceo, brunoId, { team: team!.id })).statusCode).toBe(200);

    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'waiting', assigneeAgentId: null, executorAgentId: brunoId });
    expect(await snapshot(task.id)).toMatchObject({ stage: 'development', phase: 'waiting', ownerAgentId: null, candidateId: null });
    expect((await db.select().from(requests).where(eq(requests.id, question.request.id)))[0]).toMatchObject({ status: 'open', answeredAt: null });
  });
});
