import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agents, companies, departments, invites, people, sessions, teams } from '../src/db/schema.js';
import { sessionFrom, setUpCompany, testApp } from './helpers.js';

const as = (token: string) => ({ cookies: { hh_session: token } });
const PASSWORD = 'a long enough password';

async function invite(app: FastifyInstance, token: string, payload: object) {
  return app.inject({ method: 'POST', url: '/api/people/invite', payload, ...as(token) });
}

function tokenOf(inviteUrl: string): string {
  return inviteUrl.split('/invite/')[1]!;
}

async function inviteAndAccept(app: FastifyInstance, ceo: string, payload: object): Promise<{ id: string; token: string }> {
  const res = await invite(app, ceo, payload);
  const accepted = await app.inject({ method: 'POST', url: `/api/invites/${tokenOf(res.json().inviteUrl)}/accept`, payload: { password: PASSWORD } });
  return { id: res.json().person.id, token: sessionFrom(accepted) };
}

async function addTeam(db: Db): Promise<{ departmentId: string; teamId: string }> {
  const [company] = await db.select().from(companies);
  const [dept] = await db.insert(departments).values({ companyId: company!.id, name: 'Marketing', roleCode: 'CMO' }).returning();
  const [team] = await db.insert(teams).values({ companyId: company!.id, departmentId: dept!.id, name: 'Social' }).returning();
  return { departmentId: dept!.id, teamId: team!.id };
}

describe('invites', () => {
  it('lets the CEO invite a person who then signs in', async () => {
    const { app } = await testApp({ PUBLIC_URL: 'https://hq.acme.com/' });
    const ceo = await setUpCompany(app);
    const res = await invite(app, ceo, { name: 'Maria', email: 'Maria@Acme.com', title: 'Deputy CEO', access: { whole: true } });
    expect(res.statusCode).toBe(201);
    expect(res.json().person).toMatchObject({ name: 'Maria', email: 'maria@acme.com', status: 'invited', access: { whole: true, departments: [], teams: [] } });
    expect(res.json().inviteUrl).toMatch(/^https:\/\/hq\.acme\.com\/invite\/[A-Za-z0-9_-]{43}$/);

    const token = tokenOf(res.json().inviteUrl);
    const opened = await app.inject({ url: `/api/invites/${token}` });
    expect(opened.json()).toEqual({ companyName: 'Acme', name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', access: { whole: true, departments: [], teams: [] } });

    const accepted = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: PASSWORD } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().person).toMatchObject({ email: 'maria@acme.com', status: 'active' });
    const me = await app.inject({ url: '/api/me', ...as(sessionFrom(accepted)) });
    expect(me.json().person.name).toBe('Maria');
  });

  it('gives 410 for a used invite and 404 for an unknown one', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    const url = `/api/invites/${tokenOf(res.json().inviteUrl)}`;
    expect((await app.inject({ method: 'POST', url: `${url}/accept`, payload: { password: PASSWORD } })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: `${url}/accept`, payload: { password: 'another long password' } });
    expect(again.statusCode).toBe(410);
    expect(again.json().error.code).toBe('gone');
    expect((await app.inject({ url })).statusCode).toBe(410);
    expect((await app.inject({ url: '/api/invites/no-such-token' })).statusCode).toBe(404);
  });

  it('stops the 11th accept for one invite within 15 minutes and leaves other invites alone', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const accept = (token: string) => app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: PASSWORD } });
    for (let i = 0; i < 10; i++) expect((await accept('guessed-token')).statusCode).toBe(404);
    const blocked = await accept('guessed-token');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatchObject({ code: 'too_many', reason: 'too_many_attempts' });
    const res = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    expect((await accept(tokenOf(res.json().inviteUrl))).statusCode).toBe(200);
  });

  it('gives 410 for an expired invite', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) });
    const url = `/api/invites/${tokenOf(res.json().inviteUrl)}`;
    expect((await app.inject({ url })).statusCode).toBe(410);
    expect((await app.inject({ method: 'POST', url: `${url}/accept`, payload: { password: PASSWORD } })).statusCode).toBe(410);
  });

  it('refuses a duplicate email in a different case', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await invite(app, ceo, { name: 'Ivan again', email: 'IVAN@acme.com', title: '', access: { whole: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('refuses a department or team that does not exist', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    for (const kind of ['department', 'team']) {
      const res = await invite(app, ceo, { name: 'Oleg', email: `${kind}@acme.com`, title: '', access: { [kind === 'department' ? 'departments' : 'teams']: ['00000000-0000-4000-8000-000000000000'] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation');
    }
  });

  it('only lets people with the whole company invite people', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { teamId } = await addTeam(db);
    const smm = await inviteAndAccept(app, ceo, { name: 'Sasha', email: 'sasha@acme.com', title: 'SMM', access: { teams: [teamId] } });
    const res = await invite(app, smm.token, { name: 'Friend', email: 'friend@acme.com', title: '', access: { whole: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });
});

describe('GET /api/people', () => {
  it('lists people with the names of what they reach', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { departmentId, teamId } = await addTeam(db);
    await invite(app, ceo, { name: 'Kate', email: 'kate@acme.com', title: 'Head of marketing', access: { departments: [departmentId] } });
    await invite(app, ceo, { name: 'Sasha', email: 'sasha@acme.com', title: 'SMM', access: { teams: [teamId] } });
    const res = await app.inject({ url: '/api/people', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    type Seen = { name: string; access: { whole: boolean; departments: { name: string }[]; teams: { name: string }[] } };
    const reach = Object.fromEntries(res.json().people.map((p: Seen) => [p.name, p.access.whole ? 'whole' : [...p.access.departments, ...p.access.teams].map(x => x.name).join(', ')]));
    expect(reach).toEqual({ Ivan: 'whole', Kate: 'Marketing', Sasha: 'Social' });
    const owners = res.json().people.filter((p: { isOwner: boolean }) => p.isOwner).map((p: { name: string }) => p.name);
    expect(owners).toEqual(['Ivan']);
    expect(res.body).not.toContain('scrypt');
    expect((await app.inject({ url: '/api/people' })).statusCode).toBe(401);
  });
});

describe('PATCH /api/people/:id', () => {
  it('disables a person and ends their sessions', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    const res = await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { status: 'disabled' }, ...as(ceo) });
    expect(res.statusCode).toBe(200);
    expect(res.json().person.status).toBe('disabled');
    expect(await db.select().from(sessions).where(eq(sessions.personId, maria.id))).toEqual([]);
    expect((await app.inject({ url: '/api/me', ...as(maria.token) })).statusCode).toBe(401);
  });

  it('changes title and access', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { departmentId } = await addTeam(db);
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    const res = await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { title: 'Head of marketing', access: { departments: [departmentId] } }, ...as(ceo) });
    expect(res.json().person).toMatchObject({ title: 'Head of marketing', access: { whole: false, departments: [{ id: departmentId, name: 'Marketing' }], teams: [] } });
  });

  it('protects the owner and yourself', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', access: { whole: true } });
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const byMaria = await app.inject({ method: 'PATCH', url: `/api/people/${owner!.id}`, payload: { status: 'disabled' }, ...as(maria.token) });
    expect(byMaria.statusCode).toBe(403);
    const self = await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { status: 'disabled' }, ...as(maria.token) });
    expect(self.statusCode).toBe(403);
    const unknown = await app.inject({ method: 'PATCH', url: '/api/people/00000000-0000-4000-8000-000000000000', payload: { title: 'x' }, ...as(ceo) });
    expect(unknown.statusCode).toBe(404);
  });

  it('lets anyone change their own title, and only that', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { departmentId } = await addTeam(db);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const own = await app.inject({ method: 'PATCH', url: `/api/people/${owner!.id}`, payload: { title: 'CEO' }, ...as(ceo) });
    expect(own.json().person.title).toBe('CEO');
    const olga = await inviteAndAccept(app, ceo, { name: 'Olga', email: 'olga@acme.com', title: '', access: { departments: [departmentId] } });
    const mine = await app.inject({ method: 'PATCH', url: `/api/people/${olga.id}`, payload: { title: 'Head of marketing' }, ...as(olga.token) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().person.title).toBe('Head of marketing');
    const wider = await app.inject({ method: 'PATCH', url: `/api/people/${olga.id}`, payload: { title: 'x', access: { whole: true } }, ...as(olga.token) });
    expect(wider.statusCode).toBe(403);
    const others = await app.inject({ method: 'PATCH', url: `/api/people/${owner!.id}`, payload: { title: 'x' }, ...as(olga.token) });
    expect(others.statusCode).toBe(403);
  });

  it('lets anyone trim and change only their own name, with the new name in every live view and agent signature', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { departmentId } = await addTeam(db);
    const olga = await inviteAndAccept(app, ceo, { name: 'Olga', email: 'olga@acme.com', title: 'Head of marketing', access: { departments: [departmentId] } });
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));

    const res = await app.inject({ method: 'PATCH', url: `/api/people/${olga.id}`, payload: { name: '  Lisa  ' }, ...as(olga.token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().person).toMatchObject({ name: 'Lisa', email: 'olga@acme.com', title: 'Head of marketing', access: { whole: false, departments: [{ id: departmentId }] } });
    expect((await app.inject({ url: '/api/me', ...as(olga.token) })).json().person.name).toBe('Lisa');
    expect((await app.inject({ url: '/api/people', ...as(olga.token) })).json().people.find((p: { id: string }) => p.id === olga.id).name).toBe('Lisa');
    expect((await app.inject({ method: 'PATCH', url: `/api/people/${owner!.id}`, payload: { name: 'Changed by Olga' }, ...as(olga.token) })).statusCode).toBe(403);
    for (const name of ['   ', 'x'.repeat(81)]) {
      expect((await app.inject({ method: 'PATCH', url: `/api/people/${olga.id}`, payload: { name }, ...as(olga.token) })).statusCode).toBe(400);
    }
    expect((await db.select({ name: people.name }).from(people).where(eq(people.id, owner!.id)))[0]!.name).toBe('Ivan');

    const { agentParty, personParty } = await import('../src/modules/events/parties.js');
    const { messageHeading } = await import('../src/modules/conversation/prompt.js');
    const from = await personParty(app.ctx, owner!.companyId, olga.id);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const to = await agentParty(app.ctx, owner!.companyId, orchestrator!.id);
    expect(messageHeading({ direction: 'in', from, to })).toBe('From Lisa (Head of marketing) to Orchestrator:');
  });

  it('stops a disabled invitee from accepting', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    await app.inject({ method: 'PATCH', url: `/api/people/${res.json().person.id}`, payload: { status: 'disabled' }, ...as(ceo) });
    const accept = () => app.inject({ method: 'POST', url: `/api/invites/${tokenOf(res.json().inviteUrl)}/accept`, payload: { password: PASSWORD } });
    expect((await accept()).statusCode).toBe(410);

    const enabled = await app.inject({ method: 'PATCH', url: `/api/people/${res.json().person.id}`, payload: { status: 'active' }, ...as(ceo) });
    expect(enabled.json().person.status).toBe('invited');
    expect((await accept()).statusCode).toBe(200);
  });
});

describe('POST /api/people/:id/invite', () => {
  const reinvite = (app: FastifyInstance, token: string, id: string) =>
    app.inject({ method: 'POST', url: `/api/people/${id}/invite`, ...as(token) });

  it('gives a person a new link that also resets their password', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const first = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    const oldLink = tokenOf(first.json().inviteUrl);
    const maria = { id: first.json().person.id, token: sessionFrom(await app.inject({ method: 'POST', url: `/api/invites/${oldLink}/accept`, payload: { password: PASSWORD } })) };

    const res = await reinvite(app, ceo, maria.id);
    expect(res.statusCode).toBe(201);
    expect(res.json().person.status).toBe('invited');
    expect(res.json().inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);

    expect((await app.inject({ url: '/api/me', ...as(maria.token) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'maria@acme.com', password: PASSWORD } })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/invites/${oldLink}` })).statusCode).toBe(410);

    const accepted = await app.inject({ method: 'POST', url: `/api/invites/${tokenOf(res.json().inviteUrl)}/accept`, payload: { password: 'a brand new password' } });
    expect(accepted.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'maria@acme.com', password: 'a brand new password' } })).statusCode).toBe(200);
  });

  it('replaces an expired invite', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const first = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) });
    const res = await reinvite(app, ceo, first.json().person.id);
    expect((await app.inject({ url: `/api/invites/${tokenOf(res.json().inviteUrl)}` })).statusCode).toBe(200);
  });

  it('protects the owner and yourself and needs company scope', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    const { teamId } = await addTeam(db);
    const smm = await inviteAndAccept(app, ceo, { name: 'Sasha', email: 'sasha@acme.com', title: '', access: { teams: [teamId] } });
    expect((await reinvite(app, maria.token, owner!.id)).statusCode).toBe(403);
    expect((await reinvite(app, maria.token, maria.id)).statusCode).toBe(403);
    expect((await reinvite(app, smm.token, maria.id)).statusCode).toBe(403);
    expect((await reinvite(app, ceo, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});

describe('PUT /api/people/:id/ceo-delegate', () => {
  const mark = (app: FastifyInstance, token: string, id: string, isCeoDelegate: unknown) => app.inject({ method: 'PUT', url: `/api/people/${id}/ceo-delegate`, payload: { isCeoDelegate }, ...as(token) });
  const me = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/me', ...as(token) })).json();

  it('lets the CEO set and take off the mark of a person with the whole company, and says so in /api/me and /api/people', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    expect((await me(app, maria.token)).canDecideCompany).toBe(false);
    expect((await me(app, ceo)).canDecideCompany).toBe(true);

    const set = await mark(app, ceo, maria.id, true);
    expect(set.statusCode).toBe(200);
    expect(set.json().person).toMatchObject({ id: maria.id, isCeoDelegate: true });
    expect(await mark(app, ceo, maria.id, true).then(r => r.statusCode)).toBe(200);
    expect((await me(app, maria.token))).toMatchObject({ person: { isCeoDelegate: true }, canDecideCompany: true });
    const listed = (await app.inject({ url: '/api/people', ...as(maria.token) })).json().people;
    expect(listed.find((p: { id: string }) => p.id === maria.id).isCeoDelegate).toBe(true);

    const off = await mark(app, ceo, maria.id, false);
    expect(off.json().person.isCeoDelegate).toBe(false);
    expect((await me(app, maria.token)).canDecideCompany).toBe(false);
  });

  it('gives no mark to a new invite, nor to a person who does not see the whole company', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { departmentId } = await addTeam(db);
    const nina = await invite(app, ceo, { name: 'Nina', email: 'nina@acme.com', title: '', access: { whole: true } });
    expect(nina.json().person.isCeoDelegate).toBe(false);
    const dana = await inviteAndAccept(app, ceo, { name: 'Dana', email: 'dana@acme.com', title: '', access: { departments: [departmentId] } });
    const refused = await mark(app, ceo, dana.id, true);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.reason).toBe('delegate_requires_company_access');
    expect((await mark(app, ceo, nina.json().person.id, true)).statusCode).toBe(409);
    expect((await mark(app, ceo, nina.json().person.id, false)).statusCode).toBe(200);
  });

  it('is the real CEO\'s alone: not a person of the whole company, not the delegate, not the orchestrator, not for the CEO', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    const olga = await inviteAndAccept(app, ceo, { name: 'Olga', email: 'olga@acme.com', title: '', access: { whole: true } });
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    expect((await mark(app, olga.token, maria.id, true)).statusCode).toBe(403);
    expect((await mark(app, olga.token, olga.id, true)).statusCode).toBe(403);
    await mark(app, ceo, maria.id, true);
    expect((await mark(app, maria.token, olga.id, true)).statusCode).toBe(403);
    expect((await mark(app, ceo, owner!.id, true)).json().error.reason).toBe('owner_locked');
    const { orchestratorHeaders } = await import('../src/auth/internal.js');
    const viaOrchestrator = await app.inject({ method: 'PUT', url: `/api/people/${olga.id}/ceo-delegate`, payload: { isCeoDelegate: true }, headers: orchestratorHeaders(owner!.id, '00000000-0000-4000-8000-000000000009') });
    expect(viaOrchestrator.statusCode).toBe(403);
    expect((await mark(app, ceo, '00000000-0000-4000-8000-000000000000', true)).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/people/${olga.id}/ceo-delegate`, payload: { isCeoDelegate: true, isOwner: true }, ...as(ceo) })).statusCode).toBe(400);
    const [still] = await db.select().from(people).where(eq(people.id, olga.id));
    expect(still!.isCeoDelegate).toBe(false);
  });

  it('takes the mark off for good when the delegate is disabled, sent a new invite or loses the whole company', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { departmentId } = await addTeam(db);
    const delegateOf = async (id: string) => (await db.select().from(people).where(eq(people.id, id)))[0]!.isCeoDelegate;
    const a = await inviteAndAccept(app, ceo, { name: 'A', email: 'a@acme.com', title: '', access: { whole: true } });
    const b = await inviteAndAccept(app, ceo, { name: 'B', email: 'b@acme.com', title: '', access: { whole: true } });
    const c = await inviteAndAccept(app, ceo, { name: 'C', email: 'c@acme.com', title: '', access: { whole: true } });
    for (const p of [a, b, c]) await mark(app, ceo, p.id, true);
    for (const p of [a, b, c]) expect(await delegateOf(p.id)).toBe(true);

    await app.inject({ method: 'PATCH', url: `/api/people/${a.id}`, payload: { status: 'disabled' }, ...as(ceo) });
    await app.inject({ method: 'PATCH', url: `/api/people/${a.id}`, payload: { status: 'active' }, ...as(ceo) });
    expect(await delegateOf(a.id)).toBe(false);
    await app.inject({ method: 'POST', url: `/api/people/${b.id}/invite`, ...as(ceo) });
    expect(await delegateOf(b.id)).toBe(false);
    await app.inject({ method: 'PATCH', url: `/api/people/${c.id}`, payload: { access: { departments: [departmentId] } }, ...as(ceo) });
    await app.inject({ method: 'PATCH', url: `/api/people/${c.id}`, payload: { access: { whole: true } }, ...as(ceo) });
    expect(await delegateOf(c.id)).toBe(false);
  });

  it('lets only the CEO change the access or status of the delegate, or send them a new invite', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { departmentId } = await addTeam(db);
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } });
    const olga = await inviteAndAccept(app, ceo, { name: 'Olga', email: 'olga@acme.com', title: '', access: { whole: true } });
    await mark(app, ceo, maria.id, true);
    for (const payload of [{ status: 'disabled' }, { access: { departments: [departmentId] } }]) {
      const res = await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload, ...as(olga.token) });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.reason).toBe('owner_locked');
    }
    const reinvite = await app.inject({ method: 'POST', url: `/api/people/${maria.id}/invite`, ...as(olga.token) });
    expect(reinvite.statusCode).toBe(403);
    const [still] = await db.select().from(people).where(eq(people.id, maria.id));
    expect(still).toMatchObject({ status: 'active', scopeKind: 'company', isCeoDelegate: true });
    expect((await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { title: 'Deputy' }, ...as(olga.token) })).statusCode).toBe(200);
  });
});
