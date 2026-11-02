import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { WHOLE, type Access, type Spot } from '../src/auth/access.js';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, companies, departments, people, proposals, requests, subscriptions, teams } from '../src/db/schema.js';
import { decisionOwner, type Candidate } from '../src/modules/tasks/decisions.js';
import { ask, cancel, createTask, report } from '../src/modules/tasks/engine.js';
import { as, invitePerson, listen, openStream, setUpCompany, testApp, until } from './helpers.js';

const listed = (departmentIds: string[], teamIds: string[] = []): Access => ({ whole: false, departments: new Set(departmentIds), teams: new Set(teamIds) });
const person = (id: string, access: Access, extra: Partial<Candidate> = {}): Candidate => ({ id, status: 'active', isOwner: false, access, ...extra });

describe('decisionOwner', () => {
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

  it("gives the CEO the orchestrator's cards and the request for the computer", () => {
    expect(decisionOwner({ source: 'proposal' }, [ceo, dan])).toBe('ceo');
    expect(decisionOwner({ source: 'computer_access' }, [ceo, dan])).toBe('ceo');
  });

  it('never makes someone else the CEO', () => {
    expect(() => decisionOwner({ source: 'proposal' }, [dan, person('zed', WHOLE)])).toThrow();
    expect(() => decisionOwner(question(dev), [person('old', WHOLE, { isOwner: true, status: 'disabled' }), dan])).not.toThrow();
  });
});

type View = {
  requests: { id: string; ownerPersonId: string; canAnswer: boolean; explained: string | null; task: { number: number } }[];
  proposals: { id: string; kind: string; ownerPersonId: string; canAnswer: boolean; brief: string; department: { id: string } | null }[];
  computerAccess: { kind: string; id: string; ownerPersonId: string; canAnswer: boolean; view: { asked: { reason: string } | null } } | null;
  counts: { byPerson: Record<string, number>; byAgent: Record<string, number>; total: number };
};

/* Acme with Development, where Dan is the only person; Sales, which Sara and Olga share; Marketing without anyone; Zed,
   who sees the whole company; and Tia, who reaches one team of Development. */
async function company() {
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  writeFileSync(join(control, 'alive'), '');
  const { app, db } = await testApp({ HORNHOOF_CONTROL_DIR: control });
  const ceo = await setUpCompany(app);
  const ctx = app.ctx;
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const dept = async (templateKey: 'development' | 'sales' | 'marketing', position: number) =>
    (await db.insert(departments).values({ companyId: acme!.id, templateKey, roleCode: templateKey.slice(0, 3).toUpperCase(), position }).returning())[0]!;
  const [dev, sales, mkt] = [await dept('development', 0), await dept('sales', 1), await dept('marketing', 2)];
  const [devTeam] = await db.insert(teams).values({ companyId: acme!.id, departmentId: dev.id, name: 'Web' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', departmentId: string) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey: kind === 'head' ? 'DEV-HEAD' : 'DEV-BE', departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const heads = { dev: await hire('Hana', 'head', dev.id), sales: await hire('Sven', 'head', sales.id), mkt: await hire('Mila', 'head', mkt.id) };
  const workers = { dev: await hire('Bruno', 'worker', dev.id), sales: await hire('Sam', 'worker', sales.id), mkt: await hire('Mo', 'worker', mkt.id) };
  const tokens = {
    ceo,
    dan: await invitePerson(app, ceo, { name: 'Dan', email: 'dan@acme.com', access: { departments: [dev.id], teams: [] } }),
    sara: await invitePerson(app, ceo, { name: 'Sara', email: 'sara@acme.com', access: { departments: [sales.id], teams: [] } }),
    olga: await invitePerson(app, ceo, { name: 'Olga', email: 'olga@acme.com', access: { departments: [sales.id], teams: [] } }),
    zed: await invitePerson(app, ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } }),
    tia: await invitePerson(app, ceo, { name: 'Tia', email: 'tia@acme.com', access: { departments: [], teams: [devTeam!.id] } }),
  };
  const ids = Object.fromEntries((await db.select().from(people)).map(p => [p.name.toLowerCase(), p.id])) as Record<'ivan' | 'dan' | 'sara' | 'olga' | 'zed' | 'tia', string>;
  /* Each question on a task of its own, held by the asking employee. */
  const asking = async (where: keyof typeof workers, q: Parameters<typeof ask>[3]) => {
    const deptId = { dev: dev.id, sales: sales.id, mkt: mkt.id }[where];
    const { task } = await createTask(ctx, { agentId: heads[where].id }, { title: `About ${q.text}`, brief: '', body: '', departmentId: deptId, assigneeAgentId: workers[where].id, executor: true, gates: [] });
    return { task, request: (await ask(ctx, workers[where].id, task.id, q)).request };
  };
  const view = async (token: string, query = ''): Promise<View> => (await app.inject({ url: `/api/requests${query}`, ...as(token) })).json();
  return { app, db, ctx, control, acme: acme!, sub: sub!, orchestrator: orchestrator!, dev, sales, mkt, devTeam: devTeam!, heads, workers, tokens, ids, asking, view };
}

/* Every kind of decision at once: a department question with its own person, an approval there, a question on a topic
   only the CEO decides, a question without a topic, a shared department's question, an unstaffed department's question,
   both of the orchestrator's cards and the request for the computer. */
async function everyKind() {
  const c = await company();
  const devQuestion = await c.asking('dev', { kind: 'question', text: 'Which cards do we take?', topic: 'task' });
  const devApproval = await c.asking('dev', { kind: 'approval', text: 'Merge the checkout?', commit: 'a'.repeat(40), topic: 'task' });
  const devPeople = await c.asking('dev', { kind: 'question', text: 'Hire a designer?', topic: 'people' });
  const devPlain = await c.asking('dev', { kind: 'question', text: 'An older kind of question' });
  const salesQuestion = await c.asking('sales', { kind: 'choice', text: 'Which price?', options: [{ label: '9', image: null }, { label: '12', image: null }], topic: 'task' });
  const mktQuestion = await c.asking('mkt', { kind: 'question', text: 'Which channel?', topic: 'employee' });
  const [structure] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, brief: 'Add Support.', items: [] }).returning();
  const [staff] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, kind: 'staff', departmentId: c.dev.id, brief: 'Hire a reviewer.', items: [] }).returning();
  c.ctx.computer.ask('Inspect disk space.');
  return { ...c, devQuestion, devApproval, devPeople, devPlain, salesQuestion, mktQuestion, structure: structure!, staff: staff! };
}

const ownersOf = (v: View) => Object.fromEntries(v.requests.map(r => [r.id, r.ownerPersonId]));

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
    expect(all.computerAccess).toMatchObject({ kind: 'computer_access', id: 'server', ownerPersonId: c.ids.ivan, canAnswer: true, view: { asked: { reason: 'Inspect disk space.' } } });
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
    /* Development's person sees the release of his department, not what the orchestrator asks the CEO. */
    expect((await c.view(c.tokens.dan)).requests.map(r => r.id)).toEqual([release.request.id]);
  });

  it("are counted from what the viewer may read: a department's person sees only the department's", async () => {
    const c = await everyKind();
    const his = await c.view(c.tokens.dan);
    expect(his.requests.map(r => r.id).sort()).toEqual([c.devQuestion, c.devApproval, c.devPeople, c.devPlain].map(x => x.request.id).sort());
    expect(his.proposals).toEqual([]);
    expect(his.computerAccess).toBeNull();
    expect(his.counts).toEqual({ byPerson: { [c.ids.dan]: 1, [c.ids.ivan]: 3 }, byAgent: { [c.workers.dev.id]: 4 }, total: 4 });
    /* He answers questions of his department as before, and approvals stay with people who see the whole company. */
    expect(Object.fromEntries(his.requests.map(r => [r.id, r.canAnswer]))).toEqual({
      [c.devQuestion.request.id]: true,
      [c.devApproval.request.id]: false,
      [c.devPeople.request.id]: true,
      [c.devPlain.request.id]: true,
    });
    const tias = await c.view(c.tokens.tia);
    expect(tias.requests).toEqual([]);
    expect(tias.counts).toEqual({ byPerson: {}, byAgent: {}, total: 0 });
  });

  it("show a deputy of the whole company every task's decision and the orchestrator's cards, but not the computer", async () => {
    const c = await everyKind();
    const his = await c.view(c.tokens.zed);
    expect(his.requests).toHaveLength(6);
    expect(his.proposals.map(p => [p.id, p.canAnswer])).toEqual([
      [c.structure.id, true],
      [c.staff.id, true],
    ]);
    expect(his.computerAccess).toBeNull();
    expect(his.counts.total).toBe(8);
    expect(his.counts.byPerson[c.ids.ivan]).toBe(7);
  });

  it('filter by one owner without changing the counts', async () => {
    const c = await everyKind();
    const mine = await c.view(c.tokens.ceo, `?person=${c.ids.dan}`);
    expect(mine.requests.map(r => r.id)).toEqual([c.devQuestion.request.id]);
    expect(mine.proposals).toEqual([]);
    expect(mine.computerAccess).toBeNull();
    expect(mine.counts.total).toBe(9);
    const ceos = await c.view(c.tokens.ceo, `?person=${c.ids.ivan}`);
    expect(ceos.requests).toHaveLength(5);
    expect(ceos.proposals).toHaveLength(2);
    expect(ceos.computerAccess).not.toBeNull();
    /* The filter is no key: someone else's decisions stay out of sight, and a stranger's filter shows nothing. */
    const sarasForDan = await c.view(c.tokens.dan, `?person=${c.ids.ivan}`);
    expect(sarasForDan.requests.map(r => r.id).sort()).toEqual([c.devApproval, c.devPeople, c.devPlain].map(x => x.request.id).sort());
    expect((await c.view(c.tokens.dan, '?person=00000000-0000-4000-8000-000000000999')).requests).toEqual([]);
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
    await report(c.ctx, c.heads.dev.id, task.id, { done: false, summary: 'Stuck on the provider.' });
    const [stuck] = await c.db.select({ topic: requests.decisionTopic, kind: requests.kind }).from(requests).where(eq(requests.taskId, task.id));
    expect(stuck).toEqual({ topic: 'task', kind: 'stuck' });
    expect(ownersOf(await c.view(c.tokens.ceo))[(await c.db.select().from(requests).where(eq(requests.taskId, task.id)))[0]!.id]).toBe(c.ids.dan);
  });
});

describe('who may answer, as before the owners came', () => {
  it('stays the same for every person and the orchestrator', async () => {
    const c = await everyKind();
    const post = (token: string | null, id: string, payload: object) =>
      c.app.inject({ method: 'POST', url: `/api/requests/${id}`, payload, ...(token ? as(token) : { headers: orchestratorHeaders(c.ids.ivan, c.orchestrator.id) }) });
    /* Another person of Development, so the department's questions go to the CEO now; she still answers them. */
    const eve = await invitePerson(c.app, c.tokens.ceo, { name: 'Eve', email: 'eve@acme.com', access: { departments: [c.dev.id], teams: [] } });
    expect(ownersOf(await c.view(c.tokens.ceo))[c.devPlain.request.id]).toBe(c.ids.ivan);
    expect((await post(eve, c.devPlain.request.id, { answer: 'Yes.' })).statusCode).toBe(200);
    expect((await post(c.tokens.dan, c.devPeople.request.id, { answer: 'Not yet.' })).statusCode).toBe(200);
    expect((await post(c.tokens.dan, c.devApproval.request.id, { approve: true })).json().error.reason).toBe('company_scope_only');
    expect((await post(c.tokens.sara, c.devQuestion.request.id, { answer: 'Visa.' })).statusCode).toBe(404);
    expect((await post(c.tokens.tia, c.devQuestion.request.id, { answer: 'Visa.' })).statusCode).toBe(404);
    expect((await post(c.tokens.zed, c.devApproval.request.id, { approve: true })).statusCode).toBe(200);
    expect((await post(null, c.salesQuestion.request.id, { pick: 0 })).statusCode).toBe(200);
    /* The computer stays the real CEO's alone, whatever the counts say. */
    for (const token of [c.tokens.zed, c.tokens.dan]) expect((await c.app.inject({ url: '/api/computer', ...as(token) })).statusCode).toBe(403);
    expect((await c.app.inject({ url: '/api/computer', headers: orchestratorHeaders(c.ids.ivan, c.orchestrator.id) })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { proposalId: c.structure.id, items: [] }, ...as(c.tokens.dan) })).statusCode).toBe(403);
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
    expect(cards(await org(c.tokens.zed))).toEqual({ [c.ids.ivan]: 7, [c.ids.zed]: 0, [c.ids.dan]: 1, [c.ids.sara]: 0, [c.ids.olga]: 0, [c.ids.tia]: 0 });
    expect(cards(await org(c.tokens.dan))).toEqual({ [c.ids.ivan]: 3, [c.ids.zed]: null, [c.ids.dan]: 1, [c.ids.sara]: null, [c.ids.olga]: null, [c.ids.tia]: null });
    expect(cards(await org(c.tokens.sara))).toEqual({ [c.ids.ivan]: 1, [c.ids.zed]: null, [c.ids.dan]: null, [c.ids.sara]: 0, [c.ids.olga]: null, [c.ids.tia]: null });
  });
});

describe('telling screens that decisions changed', () => {
  it('tells only the real CEO that the request for the computer changed, without what it says', async () => {
    const c = await company();
    await listen(c.app);
    const streams = { ceo: await openStream(c.app, c.tokens.ceo), zed: await openStream(c.app, c.tokens.zed), dan: await openStream(c.app, c.tokens.dan) };
    await new Promise(r => setTimeout(r, 50));
    c.ctx.computer.ask('Inspect disk space.');
    expect((await c.app.inject({ method: 'POST', url: '/api/computer/decline', ...as(c.tokens.ceo) })).statusCode).toBe(200);
    await until(() => streams.ceo.messages.some(m => m.type === 'computer'));
    expect(streams.ceo.messages.filter(m => m.type === 'computer')).toEqual([{ type: 'computer' }]);
    expect(streams.zed.messages.some(m => m.type === 'computer')).toBe(false);
    expect(streams.dan.messages.some(m => m.type === 'computer')).toBe(false);
  });

  it("tells people who see the whole company that the orchestrator's cards changed, and the others nothing of it", async () => {
    const c = await company();
    await listen(c.app);
    const streams = { zed: await openStream(c.app, c.tokens.zed), dan: await openStream(c.app, c.tokens.dan) };
    await new Promise(r => setTimeout(r, 50));
    const [card] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, brief: 'Add Support.', items: [] }).returning();
    const built = await c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { proposalId: card!.id, items: [{ template: 'support', checked: true, note: 'Answers customers.' }] }, ...as(c.tokens.zed) });
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
    await new Promise(r => setTimeout(r, 50));
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.olga}`, payload: { access: { departments: [c.dev.id], teams: [] } }, ...as(c.tokens.ceo) })).statusCode).toBe(200);
    await until(() => stream.messages.some(m => m.type === 'org'));
  });
});
