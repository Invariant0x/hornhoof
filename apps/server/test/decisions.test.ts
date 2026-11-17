import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { WHOLE, type Access, type Spot } from '../src/auth/access.js';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, departments, people, proposals, requests } from '../src/db/schema.js';
import { decisionOwner as ownerFromAuth } from '../src/auth/decision-owner.js';
import { decisionOwner, type Candidate } from '../src/modules/tasks/decisions.js';
import { ask, cancel, createTask, report } from '../src/modules/tasks/engine.js';
import { as, invitePerson, listen, openStream, until, ownPlan } from './helpers.js';
import { company, everyKind, ownersOf } from './decisions-company.js';

const listed = (departmentIds: string[], teamIds: string[] = []): Access => ({ whole: false, departments: new Set(departmentIds), teams: new Set(teamIds) });

const person = (id: string, access: Access, extra: Partial<Candidate> = {}): Candidate => ({ id, status: 'active', isOwner: false, access, ...extra });

describe('decisionOwner', () => {
  it('keeps one owner rule, the same from both modules', () => {
    expect(decisionOwner).toBe(ownerFromAuth);
  });

  const ceo = person('ceo', WHOLE, { isOwner: true });
  const dan = person('dan', listed(['dev']));
  const dev = { departmentId: 'dev', parentId: null };
  const question = (spot: Spot, topic: Candidate['id'] | null = 'task') => ({ source: 'request' as const, kind: 'question' as const, topic: topic as never, spot });

  it("gives a department's question to the one person who reaches the department", () => {
    expect(decisionOwner(question(dev), [ceo, dan])).toBe('dan');
    expect(decisionOwner(question(dev, 'employee'), [ceo, dan])).toBe('dan');
    /* A product's task belongs to whoever reaches the department holding it. */
    expect(decisionOwner(question({ departmentId: 'shop', parentId: 'dev' }), [ceo, dan])).toBe('dan');
    expect(decisionOwner(question({ departmentId: 'shop', parentId: 'dev' }), [ceo, person('pia', listed(['shop']))])).toBe('pia');
  });

  it('gives it to the CEO when the department has nobody of its own, or more than one person', () => {
    expect(decisionOwner(question({ departmentId: 'sales', parentId: null }), [ceo, dan])).toBe('ceo');
    expect(decisionOwner(question(dev), [ceo, dan, person('eve', listed(['dev']))])).toBe('ceo');
  });

  it('counts neither people who see the whole company, nor people of one team only, nor people not active', () => {
    expect(decisionOwner(question(dev), [ceo, dan, person('zed', WHOLE)])).toBe('dan');
    expect(decisionOwner(question(dev), [ceo, person('tia', listed([], ['dev-team']))])).toBe('ceo');
    expect(decisionOwner(question(dev), [ceo, person('ina', listed(['dev']), { status: 'invited' })])).toBe('ceo');
    expect(decisionOwner(question(dev), [ceo, person('dis', listed(['dev']), { status: 'disabled' }), dan])).toBe('dan');
  });

  it('passes over a deputy of the whole company: the department person owns, and with only the deputy the CEO does', () => {
    const deputy = person('zed', WHOLE);
    expect(decisionOwner(question(dev), [ceo, deputy, dan])).toBe('dan');
    expect(decisionOwner(question(dev), [ceo, deputy])).toBe('ceo');
  });

  it("counts only the departments a person's access lists, never a team of the same place", () => {
    const tia = person('tia', listed([], ['dev-team']));
    expect(decisionOwner(question({ departmentId: 'dev', parentId: null, teamId: 'dev-team' }), [ceo, tia])).toBe('ceo');
    expect(decisionOwner(question({ departmentId: 'dev', parentId: null, teamId: 'dev-team' }), [ceo, tia, dan])).toBe('dan');
  });

  it("gives the CEO every approval, every topic only the CEO decides, a question without a topic and the orchestrator's own tasks", () => {
    expect(decisionOwner({ source: 'request', kind: 'approval', topic: 'task', spot: dev }, [ceo, dan])).toBe('ceo');
    for (const topic of ['people', 'access', 'subscriptions', 'machines', 'repositories', 'public_link', 'updates', 'release'] as const) {
      expect(decisionOwner(question(dev, topic), [ceo, dan]), topic).toBe('ceo');
    }
    expect(decisionOwner(question(dev, null), [ceo, dan])).toBe('ceo');
    expect(decisionOwner(question({ departmentId: null }), [ceo, dan])).toBe('ceo');
  });

  it("gives the CEO the orchestrator's cards", () => {
    expect(decisionOwner({ source: 'proposal' }, [ceo, dan])).toBe('ceo');
  });

  it('never makes someone else the CEO', () => {
    expect(() => decisionOwner({ source: 'proposal' }, [dan, person('zed', WHOLE)])).toThrow();
    expect(() => decisionOwner(question(dev), [person('old', WHOLE, { isOwner: true, status: 'disabled' }), dan])).not.toThrow();
  });
});

describe('decisions waiting for people', () => {
  it('each have the owner the rules give, counted once per owner and per asking employee', async () => {
    const c = await everyKind();
    const all = await c.view(c.tokens.ceo);
    expect(ownersOf(all)).toEqual({
      [c.devQuestion.request.id]: c.ids.dan,
      [c.devApproval.request.id]: c.ids.ivan,
      [c.devPeople.request.id]: c.ids.ivan,
      [c.devPlain.request.id]: c.ids.ivan,
      [c.salesQuestion.request.id]: c.ids.ivan,
      [c.mktQuestion.request.id]: c.ids.ivan,
    });
    expect(all.proposals.map(p => [p.id, p.kind, p.ownerPersonId])).toEqual([
      [c.structure.id, 'structure', c.ids.ivan],
      [c.staff.id, 'staff', c.ids.ivan],
    ]);
    expect(all.machineAccess).toMatchObject([{ kind: 'computer_access', id: c.machine, ownerPersonId: c.ids.ivan, canAnswer: true, view: { asked: { reason: 'Inspect disk space.' } } }]);
    /* A page loaded before machines had access of their own reads the old key, which held one request or none: it gets
       none, and goes on. */
    expect((await c.app.inject({ url: '/api/requests', ...as(c.tokens.ceo) })).json()).toMatchObject({ computerAccess: null });
    expect(all.counts.byPerson).toEqual({ [c.ids.ivan]: 8, [c.ids.dan]: 1 });
    expect(all.counts.byAgent).toEqual({ [c.workers.dev.id]: 4, [c.workers.sales.id]: 1, [c.workers.mkt.id]: 1, [c.orchestrator.id]: 3 });
    expect(all.counts.total).toBe(9);
  });

  it("take in the orchestrator's own question and a release confirmation as the requests they are, both the CEO's", async () => {
    const c = await company();
    const { task } = await createTask(c.ctx, { personId: c.ids.ivan }, { title: 'Turn 3: Launch', brief: '', body: '', departmentId: null, assigneeAgentId: c.orchestrator.id });
    const itsOwn = await ask(c.ctx, c.orchestrator.id, task.id, { kind: 'question', text: 'Which goal goes first?', topic: 'task' });
    const release = await c.asking('dev', { kind: 'approval', text: 'Release 0.6?', commit: 'c'.repeat(40) });
    const all = await c.view(c.tokens.ceo);
    expect(ownersOf(all)).toEqual({ [itsOwn.request.id]: c.ids.ivan, [release.request.id]: c.ids.ivan });
    expect(all.counts).toEqual({ byPerson: { [c.ids.ivan]: 2 }, byAgent: { [c.orchestrator.id]: 1, [c.workers.dev.id]: 1 }, total: 2 });
    /* Development's person who owns its worker's plan sees the release of his agent, not what the orchestrator asks the CEO. */
    await ownPlan(c.db, 'dan@acme.com', c.workers.dev.id);
    expect((await c.view(c.tokens.dan)).requests.map(r => r.id)).toEqual([release.request.id]);
  });

  it("are counted from what the viewer may read: a department's person sees all its work, a product's person the work of their agents, and what is theirs to take", async () => {
    const c = await everyKind();
    /* Development's person runs it in full: every decision its employees ask shows with its work, on whoever's plan. */
    const his = await c.view(c.tokens.dan);
    expect(his.requests.map(r => r.id).sort()).toEqual([c.devQuestion, c.devApproval, c.devPeople, c.devPlain].map(x => x.request.id).sort());
    expect(his.addressed).toEqual([]);
    expect(his.proposals).toEqual([]);
    expect(his.machineAccess).toEqual([]);
    expect(his.counts).toEqual({ byPerson: { [c.ids.dan]: 1, [c.ids.ivan]: 3 }, byAgent: { [c.workers.dev.id]: 4 }, total: 4 });
    /* He takes his department's own decisions and its approvals; the CEO's topics and a question without a topic are the CEO's. */
    expect(Object.fromEntries(his.requests.map(r => [r.id, r.canAnswer]))).toEqual({
      [c.devQuestion.request.id]: true,
      [c.devApproval.request.id]: true,
      [c.devPeople.request.id]: false,
      [c.devPlain.request.id]: false,
    });
    expect(Object.fromEntries(his.requests.map(r => [r.id, r.decidedBy]))).toEqual({
      [c.devQuestion.request.id]: { kind: 'department_and_ceo', department: { id: c.dev.id, name: 'Development' } },
      [c.devApproval.request.id]: { kind: 'ceo_and_delegate', department: null },
      [c.devPeople.request.id]: { kind: 'ceo_and_delegate', department: null },
      [c.devPlain.request.id]: { kind: 'ceo_and_delegate', department: null },
    });
    /* Pia has only Shop, a product of Marketing, where Mo works on someone else's plan: only the decision that is hers to take
       shows, by itself. */
    const [shop] = await c.db.insert(departments).values({ companyId: c.acme.id, name: 'Shop', parentId: c.mkt.id, roleCode: 'MAR', position: 3 }).returning();
    await c.db.update(agents).set({ productId: shop!.id }).where(eq(agents.id, c.workers.mkt.id));
    const pia = await invitePerson(c.app, c.tokens.ceo, { name: 'Pia', email: 'pia@acme.com', access: { departments: [shop!.id], teams: [] } });
    const [piaRow] = await c.db.select().from(people).where(eq(people.email, 'pia@acme.com'));
    const { task } = await createTask(c.ctx, { agentId: c.heads.mkt.id }, { title: 'About Which banner?', brief: '', body: '', departmentId: c.mkt.id, productId: shop!.id, assigneeAgentId: c.workers.mkt.id, executor: true });
    const { request } = await ask(c.ctx, c.workers.mkt.id, task.id, { kind: 'question', text: 'Which banner?', topic: 'task' });
    const before = await c.view(pia);
    expect(before.requests).toEqual([]);
    expect(before.addressed.map(r => [r.id, r.canAnswer])).toEqual([[request.id, true]]);
    expect(before.counts).toEqual({ byPerson: { [piaRow!.id]: 1 }, byAgent: {}, total: 1 });
    await ownPlan(c.db, 'pia@acme.com', c.workers.mkt.id);
    const hers = await c.view(pia);
    expect(hers.requests.map(r => [r.id, r.canAnswer])).toEqual([[request.id, true]]);
    expect(hers.addressed).toEqual([]);
    expect(hers.counts).toEqual({ byPerson: { [piaRow!.id]: 1 }, byAgent: { [c.workers.mkt.id]: 1 }, total: 1 });
    const tias = await c.view(c.tokens.tia);
    expect(tias.requests).toEqual([]);
    expect(tias.addressed).toEqual([]);
    expect(tias.counts).toEqual({ byPerson: {}, byAgent: {}, total: 0 });
  });

  it('show a person of the whole company without the delegate mark only what their agents ask, and let them take none', async () => {
    const c = await everyKind();
    const none = await c.view(c.tokens.zed);
    expect([none.requests, none.addressed, none.proposals, none.machineAccess, none.counts.total]).toEqual([[], [], [], [], 0]);
    await ownPlan(c.db, 'zed@acme.com', c.workers.dev.id, c.orchestrator.id);
    const his = await c.view(c.tokens.zed);
    expect(his.requests).toHaveLength(4);
    expect(his.requests.every(r => !r.canAnswer)).toBe(true);
    expect(his.proposals.map(p => [p.id, p.canAnswer, p.decidedBy])).toEqual([
      [c.structure.id, false, { kind: 'ceo_and_delegate', department: null }],
      [c.staff.id, false, { kind: 'ceo_and_delegate', department: null }],
    ]);
    expect(his.machineAccess).toMatchObject([{ canAnswer: false, decidedBy: { kind: 'ceo_and_delegate', department: null }, view: { asked: { reason: 'Inspect disk space.' } } }]);
    expect(his.counts.total).toBe(7);
    expect(his.counts.byPerson[c.ids.ivan]).toBe(6);
  });

  it('let the CEO and the CEO delegate take every decision they see', async () => {
    const c = await everyKind();
    await c.app.inject({ method: 'PUT', url: `/api/people/${c.ids.zed}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(c.tokens.ceo) });
    for (const token of [c.tokens.ceo, c.tokens.zed]) {
      const v = await c.view(token);
      expect(v.requests).toHaveLength(6);
      expect(v.machineAccess).toHaveLength(1);
      expect([...v.requests, ...v.proposals, ...v.machineAccess].every(d => d.canAnswer)).toBe(true);
    }
  });

  it('filter by one owner without changing the counts', async () => {
    const c = await everyKind();
    const mine = await c.view(c.tokens.ceo, `?person=${c.ids.dan}`);
    expect(mine.requests.map(r => r.id)).toEqual([c.devQuestion.request.id]);
    expect(mine.proposals).toEqual([]);
    expect(mine.machineAccess).toEqual([]);
    expect(mine.counts.total).toBe(9);
    const ceos = await c.view(c.tokens.ceo, `?person=${c.ids.ivan}`);
    expect(ceos.requests).toHaveLength(5);
    expect(ceos.proposals).toHaveLength(2);
    expect(ceos.machineAccess).toHaveLength(1);
    /* Anyone filters by themselves; another person's filter is View as, the CEO's and the CEO delegate's alone, and only for a
       person of the company. */
    await ownPlan(c.db, 'dan@acme.com', c.workers.dev.id);
    expect((await c.view(c.tokens.dan, `?person=${c.ids.dan}`)).requests.map(r => r.id)).toEqual([c.devQuestion.request.id]);
    const refused = async (token: string, person: string) => {
      const res = await c.app.inject({ url: `/api/requests?person=${person}`, ...as(token) });
      return [res.statusCode, res.json().error?.reason];
    };
    expect(await refused(c.tokens.dan, c.ids.ivan)).toEqual([403, 'view_as_ceo_only']);
    expect(await refused(c.tokens.ceo, '00000000-0000-4000-8000-000000000999')).toEqual([404, 'person_unknown']);
    for (const bad of ['?person=me', '?person=', '?owner=x']) expect((await c.app.inject({ url: `/api/requests${bad}`, ...as(c.tokens.ceo) })).statusCode, bad).toBe(400);
  });

  it('change their counts as decisions come, get answered, withdrawn or cancelled', async () => {
    const c = await company();
    const count = async () => (await c.view(c.tokens.ceo)).counts.byPerson[c.ids.dan] ?? 0;
    const first = await c.asking('dev', { kind: 'question', text: 'Which cards?', topic: 'task' });
    const second = await c.asking('dev', { kind: 'question', text: 'Which banks?', topic: 'task' });
    expect(await count()).toBe(2);
    expect((await c.app.inject({ method: 'POST', url: `/api/requests/${first.request.id}`, payload: { answer: 'Visa only.' }, ...as(c.tokens.dan) })).statusCode).toBe(200);
    expect(await count()).toBe(1);
    await cancel(c.ctx, { agentId: c.heads.dev.id }, second.task.id, 'Not needed.');
    expect(await count()).toBe(0);
    expect((await c.view(c.tokens.ceo)).counts.total).toBe(0);
  });

  it("take the topic from the server where it knows the subject, never a lower one from the agent", async () => {
    const c = await company();
    const approval = await c.asking('dev', { kind: 'approval', text: 'Merge?', commit: 'b'.repeat(40), topic: 'task' });
    const [stored] = await c.db.select({ topic: requests.decisionTopic }).from(requests).where(eq(requests.id, approval.request.id));
    expect(stored!.topic).toBe('release');
    const { task } = await createTask(c.ctx, { personId: c.ids.ivan }, { title: 'Launch', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.heads.dev.id });
    const reported = await report(c.ctx, c.heads.dev.id, task.id, { done: false, summary: 'Stuck on the provider.' });
    const [stuck] = await c.db.select({ topic: requests.decisionTopic, kind: requests.kind, audience: requests.audience, triageAgentId: requests.triageAgentId }).from(requests).where(eq(requests.taskId, task.id));
    expect(stuck).toEqual({ topic: 'task', kind: 'stuck', audience: 'internal', triageAgentId: c.orchestrator.id });
    const [internal] = await c.db.select().from(requests).where(eq(requests.taskId, task.id));
    expect(reported.wakes).toEqual([{ agentId: c.orchestrator.id, taskId: task.id, why: 'explain', text: internal!.id }]);
    expect(ownersOf(await c.view(c.tokens.ceo))[internal!.id]).toBeUndefined();
    expect((await c.app.inject({ method: 'POST', url: `/api/requests/${internal!.id}`, payload: { retry: true }, ...as(c.tokens.ceo) })).statusCode).toBe(409);
  });
});

describe('decisions on the map', () => {
  type Card = { id: string; pendingDecisions: number | null };
  type OrgView = { people: Card[]; departments: { id: string; people: Card[] }[] };
  const cards = (org: OrgView) => Object.fromEntries([...org.people, ...org.departments.flatMap(d => d.people)].map(p => [p.id, p.pendingDecisions]));

  it("show each person's own count, a viewer's count of what they see, and nothing for totals they cannot see", async () => {
    const c = await everyKind();
    const org = async (token: string): Promise<OrgView> => (await c.app.inject({ url: '/api/org', ...as(token) })).json();
    expect(cards(await org(c.tokens.ceo))).toEqual({ [c.ids.ivan]: 8, [c.ids.zed]: 0, [c.ids.dan]: 1, [c.ids.sara]: 0, [c.ids.olga]: 0, [c.ids.tia]: 0 });
    expect(cards(await org(c.tokens.zed))).toEqual({ [c.ids.ivan]: 0, [c.ids.zed]: 0, [c.ids.dan]: 0, [c.ids.sara]: 0, [c.ids.olga]: 0, [c.ids.tia]: 0 });
    expect(cards(await org(c.tokens.dan))).toEqual({ [c.ids.ivan]: 3, [c.ids.zed]: null, [c.ids.dan]: 1, [c.ids.sara]: null, [c.ids.olga]: null, [c.ids.tia]: null });
    expect(cards(await org(c.tokens.sara))).toEqual({ [c.ids.ivan]: 1, [c.ids.zed]: null, [c.ids.dan]: null, [c.ids.sara]: 0, [c.ids.olga]: null, [c.ids.tia]: null });
  });
});

describe('telling screens that decisions changed', () => {
  it('tells every person that computer access changed, without what it says', async () => {
    const c = await company();
    await listen(c.app);
    /* A stream hears from its headers on: the server listens to the bus in the same step as it sends them. */
    const streams = { ceo: await openStream(c.app, c.tokens.ceo), zed: await openStream(c.app, c.tokens.zed), dan: await openStream(c.app, c.tokens.dan) };
    await c.askComputer('Inspect disk space.');
    expect((await c.app.inject({ method: 'POST', url: '/api/computer/decline', ...as(c.tokens.ceo) })).statusCode).toBe(200);
    await until(() => streams.ceo.messages.some(m => m.type === 'computer'));
    expect(streams.ceo.messages.filter(m => m.type === 'computer')).toEqual([{ type: 'computer' }]);
    await until(() => streams.zed.messages.some(m => m.type === 'computer'));
    /* It carries nothing, so each person's screens load what is theirs to see: a machine may be anybody's. */
    await until(() => streams.dan.messages.some(m => m.type === 'computer'));
  });

  it('tells the orchestrator acting for the CEO nothing of the request for the computer, which it may not read', async () => {
    const c = await company();
    await listen(c.app);
    const headers = orchestratorHeaders(c.ids.ivan, c.orchestrator.id);
    expect((await c.app.inject({ url: '/api/computer', headers })).statusCode).toBe(403);
    const inside = await openStream(c.app, undefined, headers);
    expect(inside.res.status).toBe(200);
    await c.askComputer('Inspect disk space.');
    expect((await c.app.inject({ method: 'POST', url: '/api/computer/decline', ...as(c.tokens.ceo) })).statusCode).toBe(200);
    /* What comes after the change on the same stream shows the change itself went by. */
    c.ctx.bus.publish(c.acme.id, { type: 'org' });
    await until(() => inside.messages.some(m => m.type === 'org'));
    expect(inside.messages.some(m => m.type === 'computer')).toBe(false);
  });

  it("tells people who see the whole company that the orchestrator's cards changed, and the others nothing of it", async () => {
    const c = await company();
    await listen(c.app);
    const streams = { zed: await openStream(c.app, c.tokens.zed), dan: await openStream(c.app, c.tokens.dan) };
    const [card] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, brief: 'Add Support.', items: [] }).returning();
    const built = await c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { proposalId: card!.id, items: [{ template: 'support', checked: true, note: 'Answers customers.' }] }, ...as(c.tokens.ceo) });
    expect(built.statusCode).toBe(201);
    await until(() => streams.zed.messages.some(m => m.type === 'requests'));
    expect(streams.zed.messages.filter(m => m.type === 'requests')).toEqual([{ type: 'requests', spot: { departmentId: null } }]);
    expect(streams.dan.messages.some(m => m.type === 'requests')).toBe(false);
    expect((await c.view(c.tokens.zed)).proposals).toEqual([]);
  });

  it("tells everyone to fetch the map again when someone's access changes, as owners may move", async () => {
    const c = await company();
    await listen(c.app);
    const stream = await openStream(c.app, c.tokens.dan);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.olga}`, payload: { access: { departments: [c.dev.id], teams: [] } }, ...as(c.tokens.ceo) })).statusCode).toBe(200);
    await until(() => stream.messages.some(m => m.type === 'org'));
  });
});
