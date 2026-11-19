import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { approvalPolicies, departments, people, requests, taskEvents } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { company } from './department-owner-fixture.js';
import { as } from './helpers.js';

type C = Awaited<ReturnType<typeof company>>;
type Res = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;
const said = (r: Res) => r.content[0]!.text;
const openRequests = (c: C) => c.db.select().from(requests).where(eq(requests.status, 'open'));
const answer = (c: C, id: string, approve: boolean) => c.app.inject({ method: 'POST', url: `/api/requests/${id}`, payload: { approve }, ...as(c.ceoToken) });
const ruleFor = (c: C, departmentId: string, channel: string) => c.db.select().from(approvalPolicies).where(and(eq(approvalPolicies.departmentId, departmentId), eq(approvalPolicies.channel, channel as never)));

describe('reading and changing a department\'s approval policy', () => {
  it('asks nothing on any channel while nobody set a rule, and stores nothing for that', async () => {
    const c = await company();
    const tools = await c.tools(c.worker);
    const listed = (await tools.listTools()).tools.find(tool => tool.name === 'approval_policy');
    expect(listed?.description).toContain('An unset channel needs no approval.');
    expect(listed?.description).not.toContain('every time for a commit');
    const view = (await c.policy(c.ceoToken, c.dev.id)).json();
    expect(view.rules).toEqual(['message', 'price', 'publication', 'commit', 'spend', 'other'].map(channel => ({ channel, mode: 'none' })));
    expect(view).toMatchObject({ departmentId: c.dev.id, owner: null, canSetOwner: true, canChangePolicy: true });
    expect(await c.db.select().from(approvalPolicies)).toEqual([]);
  });

  it('offers the CEO the people who may own it, without the CEO and without anyone who has no access', async () => {
    const c = await company();
    const view = (await c.policy(c.ceoToken, c.dev.id)).json();
    expect(view.candidates.map((p: { id: string }) => p.id).sort()).toEqual([c.ids.dana, c.ids.wes].sort());
    expect(view.candidates[0]).not.toHaveProperty('email');
  });

  it('lets the CEO change a rule, keeping the limit and what it counts', async () => {
    const c = await company();
    const saved = await c.setRule(c.ceoToken, c.dev.id, 'spend', { mode: 'within_limits', limit: 100, unit: 'USD' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().rules).toContainEqual({ channel: 'spend', mode: 'within_limits', limit: 100, unit: 'USD' });
    expect((await c.policy(c.ceoToken, c.dev.id)).json().rules).toContainEqual({ channel: 'spend', mode: 'within_limits', limit: 100, unit: 'USD' });
  });

  it('replaces the rule of a channel, which leaves no limit behind on another mode', async () => {
    const c = await company();
    await c.setRule(c.ceoToken, c.dev.id, 'spend', { mode: 'within_limits', limit: 100 });
    await c.setRule(c.ceoToken, c.dev.id, 'spend', { mode: 'new_kinds' });
    const rows = await ruleFor(c, c.dev.id, 'spend');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'new_kinds', limitAmount: null, limitUnit: null });
  });

  it('lets the owner read and change it, and tells them they may not set the owner', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const hers = (await c.policy(c.danaToken, c.dev.id)).json();
    expect(hers).toMatchObject({ owner: { id: c.ids.dana, name: 'Dana' }, canSetOwner: false, canChangePolicy: true, candidates: [] });
    expect((await c.setRule(c.danaToken, c.dev.id, 'price', { mode: 'new_kinds' })).statusCode).toBe(200);
  });

  it('lets someone of the whole company read it but not change it, everyone given the department change it, and refuses it in full to someone without access', async () => {
    const c = await company();
    expect((await c.policy(c.wholeToken, c.dev.id)).json()).toMatchObject({ canSetOwner: false, canChangePolicy: false, candidates: [] });
    const refused = await c.setRule(c.wholeToken, c.dev.id, 'price', { mode: 'new_kinds' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.reason).toBe('policy_not_allowed');
    expect((await c.policy(c.samToken, c.dev.id)).statusCode).toBe(404);
    expect((await c.setRule(c.samToken, c.dev.id, 'price', { mode: 'new_kinds' })).statusCode).toBe(403);
    /* Dana is given Development, though nobody named her its owner. */
    expect((await c.policy(c.danaToken, c.dev.id)).json()).toMatchObject({ owner: null, canSetOwner: false, canChangePolicy: true, candidates: [] });
    expect((await c.setRule(c.danaToken, c.dev.id, 'price', { mode: 'new_kinds' })).statusCode).toBe(200);
  });

  it('takes the right to change it from an owner who lost access, and gives it to the delegate', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.id, c.ids.wes));
    expect((await c.setRule(c.wholeToken, c.dev.id, 'price', { mode: 'new_kinds' })).statusCode).toBe(200);
    await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.dana}`, payload: { access: { departments: [c.sales.id] } }, ...as(c.ceoToken) });
    expect((await c.setRule(c.danaToken, c.dev.id, 'price', { mode: 'every' })).statusCode).toBe(403);
    expect((await c.policy(c.ceoToken, c.dev.id)).json().owner).toBeNull();
  });

  it('refuses a mode of limits with no limit, a limit on another mode and an unknown channel, in plain words', async () => {
    const c = await company();
    for (const rule of [{ mode: 'within_limits' }, { mode: 'within_limits', limit: -1 }, { mode: 'every', limit: 5 }, { mode: 'nothing' }]) {
      const refused = await c.setRule(c.ceoToken, c.dev.id, 'spend', rule);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.reason).toBe('policy_invalid');
    }
    expect((await c.setRule(c.ceoToken, c.dev.id, 'carrier-pigeon', { mode: 'every' })).statusCode).toBe(400);
  });

  it('has no rules of its own on a product, and shows nothing of another company', async () => {
    const c = await company();
    expect((await c.setRule(c.ceoToken, c.product.id, 'spend', { mode: 'every' })).json().error.reason).toBe('owner_on_department');
    expect((await c.policy(c.ceoToken, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('keeps the rules through a change of owner and when the owner is taken away', async () => {
    const c = await company();
    await c.setRule(c.ceoToken, c.dev.id, 'spend', { mode: 'within_limits', limit: 100, unit: 'USD' });
    await c.setRule(c.ceoToken, c.dev.id, 'message', { mode: 'new_kinds' });
    const before = (await c.policy(c.ceoToken, c.dev.id)).json().rules;
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    expect((await c.policy(c.ceoToken, c.dev.id)).json().rules).toEqual(before);
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.wes);
    expect((await c.policy(c.ceoToken, c.dev.id)).json().rules).toEqual(before);
    await c.setOwner(c.ceoToken, c.dev.id, null);
    expect((await c.policy(c.ceoToken, c.dev.id)).json().rules).toEqual(before);
  });

  it('goes away with its department', async () => {
    const c = await company();
    const [fresh] = await c.db.insert(departments).values({ companyId: c.companyId, name: 'Temp', roleCode: 'OTH', position: 9 }).returning();
    await c.setRule(c.ceoToken, fresh!.id, 'spend', { mode: 'new_kinds' });
    await c.db.delete(departments).where(eq(departments.id, fresh!.id));
    expect(await ruleFor(c, fresh!.id, 'spend')).toEqual([]);
  });
});

describe('asking for an approval under the policy', () => {
  it('addresses ordinary machine questions to the person named by the caller', async () => {
    const c = await company();
    const tools = await c.tools(c.worker);
    const asked = await call(tools, 'ask_person', { task: c.task.number, topic: 'machines', person: c.ids.dana, question: 'Which of your computers has the files?' });
    expect(asked.isError, said(asked)).toBeFalsy();
    const hers = (await c.app.inject({ url: '/api/requests', ...as(c.danaToken) })).json();
    expect(hers.requests).toMatchObject([{ ownerPersonId: c.ids.dana, canAnswer: true }]);
  });

  it('does not open an ordinary question for the CEO when no responsible person was named', async () => {
    const c = await company();
    const tools = await c.tools(c.worker);
    const asked = await call(tools, 'ask_person', { task: c.task.number, topic: 'machines', question: 'Can I use a computer?' });
    expect(asked.isError).toBe(true);
    expect(await openRequests(c)).toEqual([]);
  });
  it('uses the commit rule when ask_person names a commit', async () => {
    const c = await company();
    const tools = await c.tools(c.worker);
    const commit = 'a'.repeat(40);
    const args = { task: c.task.number, commit, question: 'May this commit go?' };
    expect(said(await call(tools, 'ask_person', args))).toMatch(/no approval/i);
    expect(await openRequests(c)).toEqual([]);
    expect((await c.setRule(c.danaToken, c.dev.id, 'commit', { mode: 'every' })).statusCode).toBe(200);
    expect(said(await call(tools, 'ask_person', args))).toContain('waits');
    expect(await openRequests(c)).toMatchObject([{ commit, kind: 'approval' }]);
  });

  it('applies an explicit new-kinds commit rule to both request tools', async () => {
    const c = await company();
    const tools = await c.tools(c.worker);
    expect((await c.setRule(c.danaToken, c.dev.id, 'commit', { mode: 'new_kinds' })).statusCode).toBe(200);
    const firstCommit = 'a'.repeat(40);
    await call(tools, 'request_approval', { task: c.task.number, channel: 'commit', kind: 'Release', text: 'Release?', commit: firstCommit });
    const [first] = await openRequests(c);
    expect(first).toMatchObject({ commit: firstCommit });
    expect((await answer(c, first!.id, true)).statusCode).toBe(200);
    const second = await call(tools, 'ask_person', { task: c.task.number, question: 'Release the next commit?', commit: 'b'.repeat(40) });
    expect(said(second)).toMatch(/no approval/i);
    expect(await openRequests(c)).toEqual([]);
  });

  const asks = (over: Record<string, unknown> = {}) => ({ task: 1, channel: 'spend', kind: 'ads', text: 'Buy ads.', ...over });
  /* Bruno's tools, on the task he holds. */
  const bruno = async (c: C) => {
    const tools = await c.tools(c.worker);
    return (over: Record<string, unknown> = {}) => call(tools, 'request_approval', asks({ task: c.task.number, ...over }));
  };

  it('asks for a new kind under an explicit rule and sends it to the CEO with no owner', async () => {
    const c = await company();
    const ask = await bruno(c);
    await c.setRule(c.danaToken, c.dev.id, 'spend', { mode: 'new_kinds' });
    const res = await ask({ amount: 1 });
    expect(res.isError).toBeFalsy();
    const [open] = await openRequests(c);
    expect(open).toMatchObject({ kind: 'approval', commit: null, approvalChannel: 'spend', approvalKind: 'ads', approvalAmount: 1, taskId: c.task.id });
    expect(said(res)).toContain('waits');
    const seen = (await c.app.inject({ method: 'GET', url: '/api/requests', ...as(c.ceoToken) })).json();
    expect(seen.requests[0]).toMatchObject({ ownerPersonId: c.ids.ceo, canAnswer: true, commit: null });
  });

  it('sends it to the named owner when the department has one', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    await c.setRule(c.danaToken, c.dev.id, 'spend', { mode: 'every' });
    await (await bruno(c))();
    const hers = (await c.app.inject({ method: 'GET', url: '/api/requests', ...as(c.danaToken) })).json();
    expect(hers.requests[0]).toMatchObject({ kind: 'approval', agent: { id: c.worker.id }, ownerPersonId: c.ids.dana, canAnswer: true, decidedBy: { kind: 'owner_and_ceo' } });
  });

  it('creates no request within the limit, at the limit neither, and leaves the task free', async () => {
    const c = await company();
    await c.setRule(c.ceoToken, c.dev.id, 'spend', { mode: 'within_limits', limit: 100, unit: 'USD' });
    const ask = await bruno(c);
    for (const amount of [5, 100]) {
      const res = await ask({ amount });
      expect(res.isError).toBeFalsy();
      expect(said(res)).toMatch(/no approval/i);
    }
    expect(await openRequests(c)).toEqual([]);
    const log = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'comment')));
    expect(log.map(l => l.text)).toEqual([expect.stringContaining('100 USD'), expect.stringContaining('100 USD')]);
  });

  it('creates a request above the limit, and when the amount is not said', async () => {
    const c = await company();
    await c.setRule(c.ceoToken, c.dev.id, 'spend', { mode: 'within_limits', limit: 100, unit: 'USD' });
    const ask = await bruno(c);
    await ask({ amount: 100.5 });
    expect(await openRequests(c)).toHaveLength(1);
    const [first] = await openRequests(c);
    await answer(c, first!.id, false);
    await ask();
    expect(await openRequests(c)).toHaveLength(1);
  });

  it('applies each channel\'s own rule: a limit on spend does not free anything else', async () => {
    const c = await company();
    await c.setRule(c.ceoToken, c.dev.id, 'spend', { mode: 'within_limits', limit: 100 });
    const ask = await bruno(c);
    await c.setRule(c.danaToken, c.dev.id, 'other', { mode: 'every' });
    await ask({ channel: 'other', amount: 1 });
    expect(await openRequests(c)).toHaveLength(1);
  });

  it('asks nobody for any channel while the department set no rule for it, and says so in the task\'s log', async () => {
    const c = await company();
    const ask = await bruno(c);
    for (const channel of ['message', 'price', 'publication', 'spend', 'other', 'commit']) {
      const res = await ask({ channel, kind: 'new work', amount: 1000, ...(channel === 'commit' ? { commit: 'a'.repeat(40) } : {}) });
      expect(res.isError).toBeFalsy();
      expect(said(res)).toMatch(/no approval/i);
    }
    expect(await openRequests(c)).toEqual([]);
    const log = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'comment')));
    expect(log.map(l => l.text)).toEqual(['message', 'price', 'publication', 'spend', 'other', 'commit'].map(channel => expect.stringContaining(`asks no approval for ${channel}`)));
  });

  it('lets a department that wants to approve its own messages ask, and then stop asking', async () => {
    const c = await company();
    await c.setRule(c.ceoToken, c.dev.id, 'message', { mode: 'every' });
    const ask = await bruno(c);
    await ask({ channel: 'message', kind: 'welcome' });
    expect(await openRequests(c)).toHaveLength(1);
    expect((await c.setRule(c.ceoToken, c.dev.id, 'message', { mode: 'none' })).statusCode).toBe(200);
    expect(await ruleFor(c, c.dev.id, 'message')).toMatchObject([{ mode: 'none', limitAmount: null }]);
    expect(said(await ask({ channel: 'message', kind: 'welcome' }))).toMatch(/no approval/i);
    expect(await openRequests(c)).toHaveLength(1);
  });

  it('asks only for a new kind of spend under an explicit rule: a kind goes free once approved, however it is typed', async () => {
    const c = await company();
    await c.setRule(c.danaToken, c.dev.id, 'spend', { mode: 'new_kinds' });
    const ask = await bruno(c);
    await ask({ channel: 'spend', kind: 'Office  supplies' });
    const requests = await openRequests(c);
    expect(requests).toHaveLength(1);
    const [first] = requests;
    expect((await answer(c, first!.id, true)).statusCode).toBe(200);
    const again = await ask({ channel: 'spend', kind: ' OFFICE   Supplies' });
    expect(said(again)).toMatch(/no approval/i);
    expect(await openRequests(c)).toEqual([]);
    await ask({ channel: 'spend', kind: 'travel booking' });
    expect(await openRequests(c)).toHaveLength(1);
  });

  it('keeps an explicit every rule asking after a kind was approved', async () => {
    const c = await company();
    await c.setRule(c.ceoToken, c.dev.id, 'message', { mode: 'every' });
    const ask = await bruno(c);
    await ask({ channel: 'message', kind: 'welcome' });
    const [first] = await openRequests(c);
    await answer(c, first!.id, true);
    await ask({ channel: 'message', kind: 'welcome' });
    expect(await openRequests(c)).toHaveLength(1);
    expect(await ruleFor(c, c.dev.id, 'message')).toMatchObject([{ mode: 'every' }]);
  });

  it('keeps a declined or waiting kind new: only an approval makes it known', async () => {
    const c = await company();
    await c.setRule(c.ceoToken, c.dev.id, 'message', { mode: 'new_kinds' });
    const ask = await bruno(c);
    await ask({ channel: 'message', kind: 'cold email' });
    const [first] = await openRequests(c);
    await answer(c, first!.id, false);
    await ask({ channel: 'message', kind: 'cold email' });
    expect(await openRequests(c)).toHaveLength(1);
  });

  it('keeps kinds known apart by department and by channel', async () => {
    const c = await company();
    for (const d of [c.dev.id, c.sales.id]) await c.setRule(c.ceoToken, d, 'message', { mode: 'new_kinds' });
    await c.setRule(c.ceoToken, c.dev.id, 'publication', { mode: 'new_kinds' });
    const ask = await bruno(c);
    await ask({ channel: 'message', kind: 'welcome' });
    const [first] = await openRequests(c);
    await answer(c, first!.id, true);
    const sid = await c.tools(c.seller);
    await call(sid, 'request_approval', asks({ task: c.salesTask.number, channel: 'message', kind: 'welcome' }));
    expect(await openRequests(c)).toHaveLength(1);
    await ask({ channel: 'publication', kind: 'welcome' });
    expect(await openRequests(c)).toHaveLength(2);
  });

  it('keeps what a past approval made known through a change of owner', async () => {
    const c = await company();
    await c.setRule(c.ceoToken, c.dev.id, 'message', { mode: 'new_kinds' });
    const ask = await bruno(c);
    await ask({ channel: 'message', kind: 'welcome' });
    const [first] = await openRequests(c);
    await answer(c, first!.id, true);
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    expect(said(await ask({ channel: 'message', kind: 'welcome' }))).toMatch(/no approval/i);
  });

  it('wakes the agent with the answer, and says what was approved rather than a commit', async () => {
    const c = await company();
    await c.setRule(c.danaToken, c.dev.id, 'spend', { mode: 'every' });
    await (await bruno(c))({ amount: 7 });
    const [first] = await openRequests(c);
    await answer(c, first!.id, true);
    const [answered] = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'answered')));
    expect(answered!.text).toContain('Approved');
    expect(answered!.text).toContain('ads');
    expect(answered!.text).not.toContain('null');
  });

  it('refuses an agent who does not hold the task, without a request and without a line in its log', async () => {
    const c = await company();
    await c.setRule(c.ceoToken, c.dev.id, 'spend', { mode: 'within_limits', limit: 100 });
    const tools = await c.tools(c.head);
    const res = await call(tools, 'request_approval', asks({ task: c.task.number, amount: 1 }));
    expect(res.isError).toBe(true);
    expect((await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'comment'))))).toEqual([]);
    const seller = await c.tools(c.seller);
    expect((await call(seller, 'request_approval', asks({ task: c.task.number, amount: 1 }))).isError).toBe(true);
  });

  it('refuses a channel it does not know and an amount below zero', async () => {
    const c = await company();
    const ask = await bruno(c);
    expect((await ask({ channel: 'carrier-pigeon' })).isError).toBe(true);
    expect((await ask({ amount: -1 })).isError).toBe(true);
    expect(await openRequests(c)).toEqual([]);
  });

  it('accepts a fourth required question in the same turn', async () => {
    const c = await company();
    const ask = await bruno(c);
    await c.setRule(c.danaToken, c.dev.id, 'spend', { mode: 'every' });
    for (let i = 0; i < 3; i++) await ask({ kind: `k${i}` });
    const fourth = await ask({ kind: 'k3' });
    expect(fourth.isError, said(fourth)).toBeFalsy();
    expect(await openRequests(c)).toHaveLength(4);
  });
});

describe('telling the CEO when goals are missed', () => {
  it('puts a missed goal before the CEO alone, even when the department has its own owner', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const [own] = (await c.db.select().from(departments).where(eq(departments.id, c.dev.id)));
    expect(own!.ownerPersonId).toBe(c.ids.dana);
    const tools = await c.tools(c.worker);
    expect((await tools.listTools()).tools.map(t => t.name)).not.toContain('escalate_missed_goal');
    await c.setRule(c.danaToken, c.dev.id, 'other', { mode: 'every' });
    await call(tools, 'request_approval', { task: c.task.number, channel: 'other', kind: 'x', text: 'Pass?' });
    const [approval] = await openRequests(c);
    await answer(c, approval!.id, true);
    const heads = await c.tools(c.head);
    const { task } = await createTask(c.app.ctx, { agentId: c.orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.head.id });
    const res = await call(heads, 'escalate_missed_goal', { task: task.number, goal: 'Release 1.0 by Friday', why: 'Two weeks late.' });
    expect(res.isError).toBeFalsy();
    const ceo = (await c.app.inject({ method: 'GET', url: '/api/requests', ...as(c.ceoToken) })).json();
    expect(ceo.counts.total).toBe(1);
    expect(ceo.requests[0]).toMatchObject({ ownerPersonId: c.ids.ceo, canAnswer: true, kind: 'question' });
    expect(ceo.requests[0].text).toContain('Release 1.0 by Friday');
    /* The owner reads it with the rest of her department's work, and it is not hers to answer. */
    const dana = (await c.app.inject({ method: 'GET', url: '/api/requests', ...as(c.danaToken) })).json();
    expect(dana.requests).toMatchObject([{ ownerPersonId: c.ids.ceo, canAnswer: false, kind: 'question' }]);
    expect([dana.addressed, dana.counts.byPerson[c.ids.dana]]).toEqual([[], undefined]);
  });
});

describe('the orchestrator\'s tools for owners and rules', () => {
  it('reads the owner and the rules of a department', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    await c.setRule(c.ceoToken, c.dev.id, 'spend', { mode: 'within_limits', limit: 100 });
    const tools = await c.tools(c.orchestrator);
    const read = JSON.parse(said(await call(tools, 'approval_policy', { department: c.dev.id })));
    expect(read.owner).toEqual({ id: c.ids.dana, name: 'Dana' });
    expect(read.rules).toContainEqual({ channel: 'spend', mode: 'within_limits', limit: 100 });
  });

  it('sets the owner in any turn, as the owner when nobody wrote, and is refused the same as the CEO is', async () => {
    const c = await company();
    const nobody = await c.tools(c.orchestrator);
    expect((await call(nobody, 'set_department_owner', { department: c.dev.id, person: c.ids.dana })).isError).toBeFalsy();
    expect((await c.db.select({ o: departments.ownerPersonId }).from(departments).where(eq(departments.id, c.dev.id)))[0]!.o).toBe(c.ids.dana);
    await c.db.update(departments).set({ ownerPersonId: null }).where(eq(departments.id, c.dev.id));
    const ceos = await c.tools(c.orchestrator, c.ids.ceo);
    expect((await call(ceos, 'set_department_owner', { department: c.dev.id, person: c.ids.sam })).isError).toBe(true);
    const set = await call(ceos, 'set_department_owner', { department: c.dev.id, person: c.ids.dana });
    expect(set.isError).toBeFalsy();
    expect((await c.db.select({ o: departments.ownerPersonId }).from(departments).where(eq(departments.id, c.dev.id)))[0]!.o).toBe(c.ids.dana);
    expect((await call(ceos, 'set_department_owner', { department: c.dev.id, person: null })).isError).toBeFalsy();
    expect((await c.db.select({ o: departments.ownerPersonId }).from(departments).where(eq(departments.id, c.dev.id)))[0]!.o).toBeNull();
  });

  it('changes a rule in any turn, as the owner for a person who may not or for nobody, and only a rule that holds', async () => {
    const c = await company();
    const nobody = await c.tools(c.orchestrator);
    const rule = { department: c.dev.id, channel: 'spend', mode: 'within_limits', limit: 100, unit: 'USD' };
    expect((await call(nobody, 'set_approval_policy', rule)).isError).toBeFalsy();
    const strangers = await c.tools(c.orchestrator, c.ids.sam);
    expect((await call(strangers, 'set_approval_policy', { ...rule, limit: 50 })).isError).toBeFalsy();
    expect(await ruleFor(c, c.dev.id, 'spend')).toMatchObject([{ limitAmount: 50, updatedBy: c.ids.ceo }]);
    await c.db.delete(approvalPolicies);
    const ceos = await c.tools(c.orchestrator, c.ids.ceo);
    expect((await call(ceos, 'set_approval_policy', rule)).isError).toBeFalsy();
    expect(await ruleFor(c, c.dev.id, 'spend')).toMatchObject([{ mode: 'within_limits', limitAmount: 100, limitUnit: 'USD', updatedBy: c.ids.ceo }]);
    expect((await call(ceos, 'set_approval_policy', { ...rule, limit: undefined })).isError).toBe(true);
  });

  it("lets a department's owner change a rule through the orchestrator, which names owners for them as the company's owner", async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const hers = await c.tools(c.orchestrator, c.ids.dana);
    expect((await call(hers, 'set_approval_policy', { department: c.dev.id, channel: 'price', mode: 'new_kinds' })).isError).toBeFalsy();
    expect((await call(hers, 'set_department_owner', { department: c.dev.id, person: null })).isError).toBeFalsy();
    expect((await c.db.select({ o: departments.ownerPersonId }).from(departments).where(eq(departments.id, c.dev.id)))[0]!.o).toBeNull();
  });

  it("names owners through the orchestrator alone, and sets a department's rules through its head too, never a worker", async () => {
    const c = await company();
    const names = async (agent: { id: string }) => (await (await c.tools(agent)).listTools()).tools.map(t => t.name);
    for (const agent of [c.worker, c.head]) {
      const own = await names(agent);
      expect(own).toContain('request_approval');
      expect(own).toContain('approval_policy');
      expect(own).not.toContain('set_department_owner');
    }
    expect(await names(c.worker)).not.toEqual(expect.arrayContaining(['set_approval_policy']));
    expect(await names(c.worker)).not.toEqual(expect.arrayContaining(['set_wait_policy']));
    expect(await names(c.head)).toEqual(expect.arrayContaining(['set_approval_policy', 'set_wait_policy']));
    expect(await names(c.orchestrator)).toEqual(expect.arrayContaining(['set_department_owner', 'set_approval_policy', 'approval_policy', 'request_approval', 'escalate_missed_goal']));
  });
});
