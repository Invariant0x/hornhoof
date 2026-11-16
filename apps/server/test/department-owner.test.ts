import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { WHOLE, accessOf, type Access, type Spot } from '../src/auth/access.js';
import { decisionOwner, type Candidate, type DecisionSubject } from '../src/auth/decision-owner.js';
import { canDecide, decidedBy, type Decider } from '../src/auth/decisions.js';
import { companies, departments, people } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { ask } from '../src/modules/tasks/engine.js';
import { company } from './department-owner-fixture.js';
import { as, invitePerson } from './helpers.js';

const C = 'acme';
const listed = (departmentIds: string[], teamIds: string[] = [], owns: string[] = []): Access => ({ whole: false, departments: new Set(departmentIds), teams: new Set(teamIds), ...(owns.length ? { owns: new Set(owns) } : {}) });
const person = (id: string, access: Access, extra: Partial<Candidate> = {}): Candidate => ({ id, status: 'active', isOwner: false, access, ...extra });
const decider = (extra: Partial<Decider> = {}): Decider => ({ companyId: C, status: 'active', scopeKind: 'listed', isOwner: false, isCeoDelegate: false, ...extra });

const dev: Spot = { departmentId: 'dev', parentId: null };
const shop: Spot = { departmentId: 'shop', parentId: 'dev' };
const sales: Spot = { departmentId: 'sales', parentId: null };
const approval = (spot: Spot = dev, topic: string | null = 'release'): DecisionSubject => ({ source: 'request', kind: 'approval', topic: topic as never, spot });
const question = (spot: Spot = dev, topic: string | null = 'task'): DecisionSubject => ({ source: 'request', kind: 'question', topic: topic as never, spot });

const ceo = person('ceo', WHOLE, { isOwner: true });
const dana = person('dana', listed(['dev'], [], ['dev']));

describe('decisionOwner with a department owner', () => {
  it('gives an approval to the department owner, and with no owner to the CEO', () => {
    expect(decisionOwner(approval(), [ceo, dana])).toBe('dana');
    expect(decisionOwner(approval(), [ceo, person('dana', listed(['dev']))])).toBe('ceo');
  });

  it('never guesses the owner from who has access: with several or with one person listed, an approval stays the CEO\'s', () => {
    const alone = [ceo, person('ann', listed(['dev']))];
    expect(decisionOwner(approval(), alone)).toBe('ceo');
    expect(decisionOwner(approval(), [...alone, person('bob', listed(['dev']))])).toBe('ceo');
  });

  it('gives a product\'s approval to the owner of the department holding it', () => {
    expect(decisionOwner(approval(shop), [ceo, dana])).toBe('dana');
  });

  it('gives approvals of any topic to the owner, a release among them', () => {
    for (const topic of ['release', 'task', 'employee', null]) expect(decisionOwner(approval(dev, topic), [ceo, dana])).toBe('dana');
  });

  it('gives another department\'s approval, and the orchestrator\'s own, to the CEO', () => {
    expect(decisionOwner(approval(sales), [ceo, dana])).toBe('ceo');
    expect(decisionOwner(approval({ departmentId: null }), [ceo, dana])).toBe('ceo');
  });

  it('gives the department\'s questions to its owner, ahead of anyone else listed there', () => {
    expect(decisionOwner(question(), [ceo, person('ann', listed(['dev'])), dana])).toBe('dana');
    expect(decisionOwner(question(shop, 'employee'), [ceo, dana])).toBe('dana');
  });

  it('keeps what only the CEO decides with the CEO, whoever owns the department', () => {
    for (const topic of ['people', 'access', 'subscriptions', 'machines', 'public_link', 'updates', null]) expect(decisionOwner(question(dev, topic), [ceo, dana])).toBe('ceo');
    expect(decisionOwner({ source: 'proposal' }, [ceo, dana])).toBe('ceo');
  });

  it('gives it back to the CEO when the owner is not active any more', () => {
    for (const status of ['disabled', 'invited'] as const) expect(decisionOwner(approval(), [ceo, { ...dana, status }])).toBe('ceo');
  });

  it('keeps today\'s rule for a department question with no owner: the one person listed there', () => {
    expect(decisionOwner(question(), [ceo, person('ann', listed(['dev']))])).toBe('ann');
  });
});

describe('canDecide with a department owner', () => {
  const owner = { who: decider(), access: listed(['dev'], [], ['dev']) };
  const listedHere = { who: decider(), access: listed(['dev']) };

  it('lets the owner take every approval of the department and its products', () => {
    expect(canDecide(approval(), owner.who, owner.access, C)).toBe(true);
    expect(canDecide(approval(shop), owner.who, owner.access, C)).toBe(true);
    expect(canDecide(question(), owner.who, owner.access, C)).toBe(true);
  });

  it('does not let the owner take another department\'s approval, or what only the CEO decides', () => {
    expect(canDecide(approval(sales), owner.who, owner.access, C)).toBe(false);
    expect(canDecide(question(dev, 'people'), owner.who, owner.access, C)).toBe(false);
    expect(canDecide(question(dev, null), owner.who, owner.access, C)).toBe(false);
    expect(canDecide({ source: 'proposal' }, owner.who, owner.access, C)).toBe(false);
  });

  it('does not let someone with access who is not the owner take an approval', () => {
    expect(canDecide(approval(), listedHere.who, listedHere.access, C)).toBe(false);
    expect(canDecide(approval(), decider({ scopeKind: 'company' }), WHOLE, C)).toBe(false);
  });

  it('gives an owner no right while not active or from another company', () => {
    for (const status of ['disabled', 'invited'] as const) expect(canDecide(approval(), decider({ status }), owner.access, C)).toBe(false);
    expect(canDecide(approval(), decider({ companyId: 'other' }), owner.access, C)).toBe(false);
  });

  it('always lets the CEO and the active delegate take any of them, with an owner there', () => {
    for (const subject of [approval(), approval(shop), question(), question(dev, 'people')]) {
      expect(canDecide(subject, decider({ scopeKind: 'company', isOwner: true }), WHOLE, C)).toBe(true);
      expect(canDecide(subject, decider({ scopeKind: 'company', isCeoDelegate: true }), WHOLE, C)).toBe(true);
    }
    expect(canDecide(approval(), decider({ scopeKind: 'company', isCeoDelegate: true, status: 'disabled' }), WHOLE, C)).toBe(false);
  });
});

describe('decidedBy with a department owner', () => {
  it('names the owner\'s department on an approval only when it has an owner', () => {
    expect(decidedBy(approval(), [ceo, dana])).toEqual({ kind: 'owner_and_ceo', departmentId: 'dev' });
    expect(decidedBy(approval(shop), [ceo, dana])).toEqual({ kind: 'owner_and_ceo', departmentId: 'dev' });
    expect(decidedBy(approval(), [ceo])).toEqual({ kind: 'ceo_and_delegate', departmentId: null });
    expect(decidedBy(approval())).toEqual({ kind: 'ceo_and_delegate', departmentId: null });
  });

  it('keeps the department\'s own questions with its people, who still take them', () => {
    expect(decidedBy(question(), [ceo, dana])).toEqual({ kind: 'department_and_ceo', departmentId: 'dev' });
  });
});

const COMMIT = 'a'.repeat(40);

describe('setting a department owner', () => {
  it('starts every department with no owner, which means the CEO', async () => {
    const c = await company();
    expect((await c.db.select({ owner: departments.ownerPersonId }).from(departments)).map(d => d.owner)).toEqual([null, null, null]);
  });

  it('lets the CEO name someone listed for the department, or someone who sees the whole company', async () => {
    const c = await company();
    const named = await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    expect(named.statusCode).toBe(200);
    expect(named.json()).toMatchObject({ ownerPersonId: c.ids.dana });
    expect((await c.setOwner(c.ceoToken, c.sales.id, c.ids.wes)).statusCode).toBe(200);
    expect((await c.db.select({ owner: departments.ownerPersonId }).from(departments).where(eq(departments.id, c.dev.id)))[0]!.owner).toBe(c.ids.dana);
  });

  it('refuses someone without access to the department, in plain words, and changes nothing', async () => {
    const c = await company();
    const refused = await c.setOwner(c.ceoToken, c.dev.id, c.ids.sam);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatchObject({ reason: 'owner_no_access', message: expect.stringContaining('access') });
    expect((await c.db.select({ owner: departments.ownerPersonId }).from(departments).where(eq(departments.id, c.dev.id)))[0]!.owner).toBeNull();
  });

  it('refuses a person who reaches only a product of it or a team in it, as neither is the department', async () => {
    const c = await company();
    const pia = await invitePerson(c.app, c.ceoToken, { name: 'Pia', email: 'pia@acme.com', access: { departments: [c.product.id] } });
    expect(pia).toBeTruthy();
    const [piaRow] = await c.db.select(idOnly(people)).from(people).where(eq(people.email, 'pia@acme.com'));
    expect((await c.setOwner(c.ceoToken, c.dev.id, piaRow!.id)).json().error.reason).toBe('owner_no_access');
  });

  it('refuses someone not active, someone of another company and an unknown id', async () => {
    const c = await company();
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, c.ids.dana));
    expect((await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana)).json().error.reason).toBe('owner_no_access');
    const [other] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [stranger] = await c.db.insert(people).values({ companyId: other!.id, name: 'Olga', email: 'olga@other.com', status: 'active', scopeKind: 'company' }).returning();
    expect((await c.setOwner(c.ceoToken, c.dev.id, stranger!.id)).json().error.reason).toBe('owner_no_access');
    expect((await c.setOwner(c.ceoToken, c.dev.id, '00000000-0000-4000-8000-000000000000')).json().error.reason).toBe('owner_no_access');
  });

  it('lets only the CEO and the delegate set it: not the owner, not a person of the department, not someone of the whole company', async () => {
    const c = await company();
    for (const token of [c.danaToken, c.wholeToken]) {
      const refused = await c.setOwner(token, c.dev.id, c.ids.dana);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.reason).toBe('owner_ceo_only');
    }
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.id, c.ids.wes));
    expect((await c.setOwner(c.wholeToken, c.dev.id, c.ids.dana)).statusCode).toBe(200);
  });

  it('keeps one way to say the CEO: naming the CEO is the same as no owner', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    expect((await c.setOwner(c.ceoToken, c.dev.id, c.ids.ceo)).json()).toMatchObject({ ownerPersonId: null });
    expect((await c.db.select({ owner: departments.ownerPersonId }).from(departments).where(eq(departments.id, c.dev.id)))[0]!.owner).toBeNull();
  });

  it('takes the owner away with null, idempotently', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    for (let i = 0; i < 2; i++) expect((await c.setOwner(c.ceoToken, c.dev.id, null)).json()).toMatchObject({ ownerPersonId: null });
  });

  it('has no owner of its own on a product, and no department of another company', async () => {
    const c = await company();
    expect((await c.setOwner(c.ceoToken, c.product.id, c.ids.dana)).json().error.reason).toBe('owner_on_department');
    const [other] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [outside] = await c.db.insert(departments).values({ companyId: other!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
    expect((await c.setOwner(c.ceoToken, outside!.id, null)).statusCode).toBe(404);
  });

  it('gives a right only while the person still has access: losing it, or being switched off, hands it back to the CEO', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const reach = (id: string, scopeKind: 'listed' | 'company' = 'listed') => accessOf(c.db, { id, scopeKind });
    expect((await reach(c.ids.dana)).owns).toEqual(new Set([c.dev.id]));
    await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.dana}`, payload: { access: { departments: [c.sales.id] } }, ...as(c.ceoToken) });
    /* Development no more; Sales she runs now, as everyone given it does. */
    expect((await reach(c.ids.dana)).owns).toEqual(new Set([c.sales.id]));
  });

  it('shows the company the owner who counts now: none once that person is switched off or loses access', async () => {
    const c = await company();
    const shown = async () => (await c.app.inject({ method: 'GET', url: '/api/org', ...as(c.ceoToken) })).json().departments.find((d: { id: string }) => d.id === c.dev.id).ownerPersonId;
    expect(await shown()).toBeNull();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    expect(await shown()).toBe(c.ids.dana);
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, c.ids.dana));
    expect(await shown()).toBeNull();
    expect((await c.policy(c.ceoToken, c.dev.id)).json().owner).toBeNull();
    await c.db.update(people).set({ status: 'active' }).where(eq(people.id, c.ids.dana));
    expect(await shown()).toBe(c.ids.dana);
    await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.dana}`, payload: { access: { departments: [c.sales.id] } }, ...as(c.ceoToken) });
    expect(await shown()).toBeNull();
  });
});

type WaitingLine = { id: string; ownerPersonId: string; canAnswer: boolean; decidedBy: { kind: string; department: { id: string } | null } };
type Waiting = { requests: WaitingLine[]; addressed: WaitingLine[]; counts: { byPerson: Record<string, number>; total: number } };

describe('approvals with a department owner', () => {
  const asked = async (c: Awaited<ReturnType<typeof company>>) => (await ask(c.app.ctx, c.worker.id, c.task.id, { kind: 'approval', text: 'Merge?', commit: COMMIT })).request;
  const waiting = async (c: Awaited<ReturnType<typeof company>>, token: string): Promise<Waiting> => (await c.app.inject({ method: 'GET', url: '/api/requests', ...as(token) })).json();

  it('sends an approval to the named owner, and shows it as theirs with its work, as she sees every employee there', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const request = await asked(c);
    const hers = await waiting(c, c.danaToken);
    expect(hers.requests).toMatchObject([{ id: request.id, ownerPersonId: c.ids.dana, canAnswer: true, decidedBy: { kind: 'owner_and_ceo', department: { id: c.dev.id } } }]);
    expect(hers.addressed).toEqual([]);
    expect(hers.counts.byPerson[c.ids.dana]).toBe(1);
  });

  it('sends it to the CEO with no owner, as today', async () => {
    const c = await company();
    await asked(c);
    const his = await waiting(c, c.ceoToken);
    expect(his.requests).toMatchObject([{ ownerPersonId: c.ids.ceo, canAnswer: true, decidedBy: { kind: 'ceo_and_delegate', department: null } }]);
    expect(his.counts).toMatchObject({ byPerson: { [c.ids.ceo]: 1 }, total: 1 });
    /* An approval no owner takes goes to the CEO. Dana, given Development, still sees it with its work and may take it;
       Sam of Sales sees nothing of it. */
    const hers = await waiting(c, c.danaToken);
    expect(hers.requests).toMatchObject([{ ownerPersonId: c.ids.ceo, canAnswer: true }]);
    expect(hers.addressed).toEqual([]);
    expect((await waiting(c, c.samToken)).requests).toEqual([]);
    expect((await waiting(c, c.samToken)).addressed).toEqual([]);
  });

  it('adds nothing to the number the CEO waits on while the department has its own owner, and still lists it for the CEO', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    await asked(c);
    const his = await waiting(c, c.ceoToken);
    expect(his.counts.total).toBe(0);
    expect(his.counts.byPerson).toEqual({ [c.ids.dana]: 1 });
    expect(his.requests).toMatchObject([{ ownerPersonId: c.ids.dana, canAnswer: true }]);
    expect((await waiting(c, c.danaToken)).counts.total).toBe(1);
  });

  it('lets the owner, the CEO and the delegate each answer it, and nobody else', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.id, c.ids.wes));
    const answer = (id: string, token: string) => c.app.inject({ method: 'POST', url: `/api/requests/${id}`, payload: { approve: true }, ...as(token) });
    const again = async () => {
      const r = await asked(c);
      expect((await answer(r.id, c.samToken)).statusCode).toBe(403);
      return r;
    };
    for (const token of [c.danaToken, c.ceoToken, c.wholeToken]) {
      const r = await again();
      const done = await answer(r.id, token);
      expect(done.statusCode, 'the answer').toBe(200);
      expect(done.json().request.status).toBe('approved');
    }
  });

  it('lets everyone given the department answer it beside the named owner, while it stays addressed to her', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const ola = await invitePerson(c.app, c.ceoToken, { name: 'Ola', email: 'ola@acme.com', access: { departments: [c.dev.id] } });
    const request = await asked(c);
    expect((await waiting(c, ola)).requests).toMatchObject([{ id: request.id, ownerPersonId: c.ids.dana, canAnswer: true }]);
    const done = await c.app.inject({ method: 'POST', url: `/api/requests/${request.id}`, payload: { approve: true }, ...as(ola) });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().request.status).toBe('approved');
  });

  it('leaves a former owner the right while she has the department, takes it at once with her access, and the waiting approval goes to the new owner', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const request = await asked(c);
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.wes);
    expect((await waiting(c, c.danaToken)).requests).toMatchObject([{ id: request.id, ownerPersonId: c.ids.wes, canAnswer: true }]);
    await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.dana}`, payload: { access: { departments: [c.sales.id] } }, ...as(c.ceoToken) });
    const refused = await c.app.inject({ method: 'POST', url: `/api/requests/${request.id}`, payload: { approve: true }, ...as(c.danaToken) });
    expect(refused.statusCode).toBe(403);
    expect((await waiting(c, c.wholeToken)).requests).toMatchObject([{ id: request.id, ownerPersonId: c.ids.wes, canAnswer: true }]);
  });
});
