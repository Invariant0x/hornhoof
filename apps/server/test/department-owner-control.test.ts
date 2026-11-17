import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, approvalPolicies, departments, requests, subscriptions, tasks, teams, waitPolicies } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { company } from './department-owner-fixture.js';
import { TEST_API_KEY } from './helpers-company.js';
import { as } from './helpers.js';

/* A person who runs a department, and its head on their word, do what is the department's own without the CEO or the
   orchestrator: its API keys, its hiring, its approval and wait policies, its description and the work given to it. Another
   department's is still refused, and nothing of the whole company comes with it. Sam runs Sales and Dana Development. */

type C = Awaited<ReturnType<typeof company>>;
type Res = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Res;
const send = (c: C, token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  c.app.inject({ method, url, ...(payload ? { payload } : {}), ...as(token) });
const key = (label: string, target: object) => ({ kind: 'api_key', provider: 'anthropic_api', label, apiKey: TEST_API_KEY, target });
const listed = async (c: C, token: string) => ((await send(c, token, 'GET', '/api/subscriptions')).json().subscriptions as { id: string; label: string }[]).map(s => s.label);
const GRANTING = 'ops-failure-review';

describe("a department's API keys", () => {
  it('are added, seen, renamed and removed by the person who runs it, without the CEO', async () => {
    const c = await company();
    const made = await send(c, c.samToken, 'POST', '/api/subscriptions', key('Sales key', { kind: 'department', id: c.sales.id }));
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().subscription.id as string;
    expect(await listed(c, c.samToken)).toContain('Sales key');
    /* His screen knows it is his to change, and that Sales is where he connects one. */
    const screen = (await send(c, c.samToken, 'GET', '/api/subscriptions')).json() as { subscriptions: { id: string; canChange: boolean }[]; apiPlaces: string[] | null };
    expect([screen.subscriptions.find(s => s.id === id)?.canChange, screen.apiPlaces]).toEqual([true, [c.sales.id]]);
    expect((await send(c, c.ceoToken, 'GET', '/api/subscriptions')).json().apiPlaces).toBeNull();
    expect((await send(c, c.samToken, 'GET', `/api/subscriptions/${id}/tokens`)).statusCode).toBe(200);
    expect((await send(c, c.samToken, 'PATCH', `/api/subscriptions/${id}`, { label: 'Sales API' })).json().subscription.label).toBe('Sales API');
    expect((await send(c, c.samToken, 'DELETE', `/api/subscriptions/${id}`)).statusCode).toBe(204);
    expect((await c.db.select(only(subscriptions, 'removedAt')).from(subscriptions).where(eq(subscriptions.id, id)))[0]!.removedAt).not.toBeNull();
  });

  it('include one the CEO placed in the department, which its person keeps as the CEO does', async () => {
    const c = await company();
    const id = (await send(c, c.ceoToken, 'POST', '/api/subscriptions', key('Sales by CEO', { kind: 'department', id: c.sales.id }))).json().subscription.id as string;
    expect(await listed(c, c.samToken)).toContain('Sales by CEO');
    expect((await send(c, c.samToken, 'PATCH', `/api/subscriptions/${id}`, { label: 'Sales own' })).statusCode).toBe(200);
    expect((await send(c, c.samToken, 'DELETE', `/api/subscriptions/${id}`)).statusCode).toBe(204);
  });

  it("are no one's elsewhere: another department, a team of it, the whole company or the orchestrator stay closed", async () => {
    const c = await company();
    const [team] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Web' }).returning();
    for (const target of [{ kind: 'department', id: c.dev.id }, { kind: 'department', id: c.product.id }, { kind: 'team', id: team!.id }, { kind: 'any' }, { kind: 'orchestrator' }]) {
      const refused = await send(c, c.samToken, 'POST', '/api/subscriptions', key('Not mine', target));
      expect([refused.statusCode, refused.json().error.reason], JSON.stringify(target)).toEqual([403, 'company_scope_only']);
    }
    const devKey = (await send(c, c.ceoToken, 'POST', '/api/subscriptions', key('Dev key', { kind: 'department', id: c.dev.id }))).json().subscription.id as string;
    const anyKey = (await send(c, c.ceoToken, 'POST', '/api/subscriptions', key('Company key', { kind: 'any' }))).json().subscription.id as string;
    expect(await listed(c, c.samToken)).not.toEqual(expect.arrayContaining(['Dev key']));
    expect(await listed(c, c.samToken)).not.toEqual(expect.arrayContaining(['Company key']));
    for (const id of [devKey, anyKey]) {
      expect((await send(c, c.samToken, 'GET', `/api/subscriptions/${id}/tokens`)).statusCode).toBe(403);
      expect((await send(c, c.samToken, 'PATCH', `/api/subscriptions/${id}`, { label: 'Taken' })).statusCode).toBe(403);
      expect((await send(c, c.samToken, 'DELETE', `/api/subscriptions/${id}`)).statusCode).toBe(403);
      expect((await send(c, c.samToken, 'POST', `/api/subscriptions/${id}/models`)).statusCode).toBe(403);
    }
    /* His own key does not go out of Sales either. */
    const own = (await send(c, c.samToken, 'POST', '/api/subscriptions', key('Sales key', { kind: 'department', id: c.sales.id }))).json().subscription.id as string;
    expect((await send(c, c.samToken, 'PATCH', `/api/subscriptions/${own}`, { target: { kind: 'department', id: c.dev.id } })).statusCode).toBe(403);
    expect((await send(c, c.samToken, 'PATCH', `/api/subscriptions/${own}`, { target: { kind: 'any' } })).statusCode).toBe(403);
    expect((await c.db.select(only(subscriptions, 'targetId')).from(subscriptions).where(eq(subscriptions.id, own)))[0]!.targetId).toBe(c.sales.id);
  });

  it("never show another person's personal plan or its secret, and are never added by an agent", async () => {
    const c = await company();
    const [plan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'claude', kind: 'personal', label: 'Dana own', status: 'ready', ownerPersonId: c.ids.dana, secretEnc: 'sealed-secret-of-dana' }).returning();
    const all = await send(c, c.samToken, 'GET', '/api/subscriptions');
    expect(all.body).not.toContain('Dana own');
    expect(all.body).not.toContain('sealed-secret-of-dana');
    expect((await send(c, c.samToken, 'GET', `/api/subscriptions/${plan!.id}/tokens`)).statusCode).toBe(403);
    expect((await send(c, c.samToken, 'PATCH', `/api/subscriptions/${plan!.id}`, { budget: 50 })).statusCode).toBe(403);
    expect((await send(c, c.samToken, 'DELETE', `/api/subscriptions/${plan!.id}`)).statusCode).toBe(403);
    const byHead = await c.app.inject({ method: 'POST', url: '/api/subscriptions', headers: orchestratorHeaders(c.ids.sam, c.salesHead.id), payload: key('By head', { kind: 'department', id: c.sales.id }) });
    expect(byHead.statusCode).toBe(403);
    expect(await c.db.select().from(subscriptions).where(eq(subscriptions.label, 'By head'))).toEqual([]);
  });
});

describe('hiring with a skill that shows the whole company', () => {
  const line = (c: C, role: string, name: string, extra: string[] = []) => ({ role, name, model: '', subscription: null, skills: [...c.app.ctx.templates.roles.get(role)!.skills.filter(s => s.on).map(s => s.id), ...extra] });

  it('is left to people who see the whole company, while the department hires the rest itself', async () => {
    const c = await company();
    const refused = await send(c, c.samToken, 'POST', `/api/departments/${c.sales.id}/staff`, { people: [line(c, 'SAL-AE', 'Ola', [GRANTING])] });
    expect([refused.statusCode, refused.json().error.reason]).toEqual([403, 'skill_company_only']);
    expect((await send(c, c.samToken, 'POST', `/api/departments/${c.sales.id}/staff`, { people: [line(c, 'SAL-AE', 'Ola')] })).statusCode).toBe(201);
    expect((await send(c, c.ceoToken, 'POST', `/api/departments/${c.sales.id}/staff`, { people: [line(c, 'SAL-AE', 'Pia', [GRANTING])] })).statusCode).toBe(201);
    expect((await c.db.select(only(agents, 'name')).from(agents).where(and(eq(agents.departmentId, c.sales.id), isNull(agents.removedAt)))).map(a => a.name).sort()).toEqual(['Ola', 'Pia', 'Sid', 'Sue']);
  });

  it('is never done by a head, even on the CEO\'s word, for a new employee or one there is', async () => {
    const c = await company();
    const head = await c.tools(c.salesHead, c.ids.ceo);
    const hired = await call(head, 'hire', { people: [{ role: 'SAL-AE', name: 'Ola', skills: { on: [GRANTING], off: [] } }] });
    expect(hired.isError, hired.content[0]!.text).toBe(true);
    const changed = await call(head, 'change_employee', { employee: c.seller.id, skills: { [GRANTING]: true } });
    expect(changed.isError, changed.content[0]!.text).toBe(true);
    expect((await c.db.select(only(agents, 'skills')).from(agents).where(eq(agents.id, c.seller.id)))[0]!.skills).not.toContain(GRANTING);
    expect(await c.db.select().from(agents).where(eq(agents.name, 'Ola'))).toEqual([]);
  });
});

describe("a head's own approval and wait policies", () => {
  const RULE = { channel: 'message', mode: 'new_kinds' };
  const DATES = { kind: 'after', ownerMs: 3_600_000, headMs: 7_200_000, decisionMs: 10_800_000, reviewIntervalMs: 3_600_000 };

  it('are set in a turn that answers the person who runs the department, for it and no other', async () => {
    const c = await company();
    const head = await c.tools(c.salesHead, c.ids.sam);
    const rule = await call(head, 'set_approval_policy', { department: c.sales.id, ...RULE });
    expect(rule.isError, rule.content[0]!.text).toBeFalsy();
    const dates = await call(head, 'set_wait_policy', { department: c.sales.id, ...DATES });
    expect(dates.isError, dates.content[0]!.text).toBeFalsy();
    expect(await c.db.select({ departmentId: approvalPolicies.departmentId, mode: approvalPolicies.mode }).from(approvalPolicies)).toEqual([{ departmentId: c.sales.id, mode: 'new_kinds' }]);
    expect((await c.db.select(only(waitPolicies, 'departmentId')).from(waitPolicies)).map(p => p.departmentId)).toEqual([c.sales.id]);
    for (const [name, args] of [['set_approval_policy', { department: c.dev.id, ...RULE }], ['set_wait_policy', { department: c.dev.id, ...DATES }]] as const) {
      const refused = await call(head, name, args);
      expect([refused.isError, refused.content[0]!.text], name).toEqual([true, "This department is not yours. Nothing was changed. You set only your own department's approvals and wait dates."]);
    }
    expect(await c.db.select().from(approvalPolicies).where(eq(approvalPolicies.departmentId, c.dev.id))).toEqual([]);
  });

  it('are set in any turn with the rights of whoever runs the department, whoever wrote or nobody, but never for commits', async () => {
    const c = await company();
    for (const person of [c.ids.dana, null]) {
      const set = await call(await c.tools(c.salesHead, person), 'set_approval_policy', { department: c.sales.id, ...RULE });
      expect(set.isError, `${String(person)}: ${set.content[0]!.text}`).toBeFalsy();
    }
    const commit = await call(await c.tools(c.salesHead, c.ids.sam), 'set_approval_policy', { department: c.sales.id, channel: 'commit', mode: 'new_kinds' });
    expect(commit.isError, commit.content[0]!.text).toBe(true);
    /* Sales names no owner, so its head goes with the CEO's rights. */
    expect(await c.db.select({ departmentId: approvalPolicies.departmentId, channel: approvalPolicies.channel, mode: approvalPolicies.mode, updatedBy: approvalPolicies.updatedBy }).from(approvalPolicies)).toEqual([
      { departmentId: c.sales.id, channel: 'message', mode: 'new_kinds', updatedBy: c.ids.ceo },
    ]);
    /* A worker has none of them. */
    const tools = (await (await c.tools(c.seller, c.ids.sam)).listTools()).tools.map(t => t.name);
    expect(tools).not.toContain('set_approval_policy');
    expect(tools).not.toContain('set_wait_policy');
  });
});

describe("a head and its department's work", () => {
  it('cancels a task given to its department by the orchestrator, and none of another department', async () => {
    const c = await company();
    const given = (await createTask(c.app.ctx, { agentId: c.orchestrator.id }, { title: 'From above', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.worker.id, executor: true })).task;
    const elsewhere = (await createTask(c.app.ctx, { agentId: c.orchestrator.id }, { title: 'Theirs', brief: '', body: '', departmentId: c.sales.id, assigneeAgentId: c.seller.id, executor: true })).task;
    const head = await c.tools(c.head, c.ids.dana);
    const cancelled = await call(head, 'cancel_task', { task: given.number, why: 'Dana dropped it.' });
    expect(cancelled.isError, cancelled.content[0]!.text).toBeFalsy();
    const refused = await call(head, 'cancel_task', { task: elsewhere.number, why: 'Not ours.' });
    expect([refused.isError, refused.content[0]!.text]).toEqual([true, `There is no task ${elsewhere.number} you can see. Call tasks for yours.`]);
    const status = async (id: string) => (await c.db.select(only(tasks, 'status')).from(tasks).where(eq(tasks.id, id)))[0]!.status;
    expect([await status(given.id), await status(elsewhere.id)]).toEqual(['cancelled', 'open']);
    /* A worker still cancels only what it created. */
    const worker = await call(await c.tools(c.seller, c.ids.sam), 'cancel_task', { task: elsewhere.number, why: 'Mine to drop?' });
    expect(worker.isError).toBe(true);
  });

  it('never rewrites how a request reads for people: that is the orchestrator\'s', async () => {
    const c = await company();
    const [request] = await c.db.insert(requests).values({ companyId: c.companyId, taskId: c.salesTask.id, agentId: c.seller.id, kind: 'question', text: 'Discount ok?' }).returning();
    const explain = (agentId: string) => c.app.inject({ method: 'POST', url: `/api/requests/${request!.id}/explained`, headers: orchestratorHeaders(c.ids.sam, agentId), payload: { text: 'Plain words.' } });
    const byHead = await explain(c.salesHead.id);
    expect([byHead.statusCode, byHead.json().error.reason]).toEqual([403, 'orchestrator_only']);
    expect((await explain(c.orchestrator.id)).statusCode).toBe(200);
  });

  it('sets the department description in any turn, whoever wrote or nobody, as the person who runs it does on the screen', async () => {
    const c = await company();
    const about = async (id: string) => (await c.db.select(only(departments, 'about')).from(departments).where(eq(departments.id, id)))[0]!.about;
    const told = await call(await c.tools(c.salesHead, null), 'change_department', { about: 'Measures: replies and first reply time.' });
    expect(told.isError, told.content[0]!.text).toBeFalsy();
    expect(await about(c.sales.id)).toBe('Measures: replies and first reply time.');
    const onDanas = await call(await c.tools(c.salesHead, c.ids.dana), 'change_department', { about: 'Measures: replies.' });
    expect(onDanas.isError, onDanas.content[0]!.text).toBeFalsy();
    expect(await about(c.sales.id)).toBe('Measures: replies.');
    expect((await send(c, c.danaToken, 'POST', '/api/departments/build', { items: [{ department: c.dev.id, about: 'Deploys a day.' }] })).statusCode).toBe(201);
    expect(await about(c.dev.id)).toBe('Deploys a day.');
    expect((await send(c, c.danaToken, 'POST', '/api/departments/build', { items: [{ department: c.sales.id, about: 'Taken.' }] })).statusCode).toBe(403);
    expect(await about(c.sales.id)).toBe('Measures: replies.');
  });
});
