import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { companies, departments, invites, people, sessions, teams } from '../src/db/schema.js';
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
    const res = await invite(app, ceo, { name: 'Maria', email: 'Maria@Acme.com', title: 'Deputy CEO', scope: { kind: 'company' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().person).toMatchObject({ name: 'Maria', email: 'maria@acme.com', status: 'invited', scope: { kind: 'company', id: null, name: 'Whole company' } });
    expect(res.json().inviteUrl).toMatch(/^https:\/\/hq\.acme\.com\/invite\/[A-Za-z0-9_-]{43}$/);

    const token = tokenOf(res.json().inviteUrl);
    const opened = await app.inject({ url: `/api/invites/${token}` });
    expect(opened.json()).toEqual({ companyName: 'Acme', name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', scopeName: 'Whole company', scopeKind: 'company' });

    const accepted = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: PASSWORD } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().person).toMatchObject({ email: 'maria@acme.com', status: 'active' });
    const me = await app.inject({ url: '/api/me', ...as(sessionFrom(accepted)) });
    expect(me.json().person.name).toBe('Maria');
  });

  it('gives 410 for a used invite and 404 for an unknown one', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', scope: { kind: 'company' } });
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
    const res = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', scope: { kind: 'company' } });
    expect((await accept(tokenOf(res.json().inviteUrl))).statusCode).toBe(200);
  });

  it('gives 410 for an expired invite', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', scope: { kind: 'company' } });
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) });
    const url = `/api/invites/${tokenOf(res.json().inviteUrl)}`;
    expect((await app.inject({ url })).statusCode).toBe(410);
    expect((await app.inject({ method: 'POST', url: `${url}/accept`, payload: { password: PASSWORD } })).statusCode).toBe(410);
  });

  it('refuses a duplicate email in a different case', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await invite(app, ceo, { name: 'Ivan again', email: 'IVAN@acme.com', title: '', scope: { kind: 'company' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('refuses a department or team that does not exist', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    for (const kind of ['department', 'team']) {
      const res = await invite(app, ceo, { name: 'Oleg', email: `${kind}@acme.com`, title: '', scope: { kind, id: '00000000-0000-4000-8000-000000000000' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation');
    }
  });

  it('only lets company scope invite people', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { teamId } = await addTeam(db);
    const smm = await inviteAndAccept(app, ceo, { name: 'Sasha', email: 'sasha@acme.com', title: 'SMM', scope: { kind: 'team', id: teamId } });
    const res = await invite(app, smm.token, { name: 'Friend', email: 'friend@acme.com', title: '', scope: { kind: 'company' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });
});

describe('GET /api/people', () => {
  it('lists people with their scope names', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { departmentId, teamId } = await addTeam(db);
    await invite(app, ceo, { name: 'Kate', email: 'kate@acme.com', title: 'Head of marketing', scope: { kind: 'department', id: departmentId } });
    await invite(app, ceo, { name: 'Sasha', email: 'sasha@acme.com', title: 'SMM', scope: { kind: 'team', id: teamId } });
    const res = await app.inject({ url: '/api/people', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    const scopes = Object.fromEntries(res.json().people.map((p: { name: string; scope: { name: string } }) => [p.name, p.scope.name]));
    expect(scopes).toEqual({ Ivan: 'Whole company', Kate: 'Marketing', Sasha: 'Social' });
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
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', scope: { kind: 'company' } });
    const res = await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { status: 'disabled' }, ...as(ceo) });
    expect(res.statusCode).toBe(200);
    expect(res.json().person.status).toBe('disabled');
    expect(await db.select().from(sessions).where(eq(sessions.personId, maria.id))).toEqual([]);
    expect((await app.inject({ url: '/api/me', ...as(maria.token) })).statusCode).toBe(401);
  });

  it('changes title and scope', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { departmentId } = await addTeam(db);
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', scope: { kind: 'company' } });
    const res = await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { title: 'Head of marketing', scope: { kind: 'department', id: departmentId } }, ...as(ceo) });
    expect(res.json().person).toMatchObject({ title: 'Head of marketing', scope: { kind: 'department', id: departmentId, name: 'Marketing' } });
  });

  it('protects the owner and yourself', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', scope: { kind: 'company' } });
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const byMaria = await app.inject({ method: 'PATCH', url: `/api/people/${owner!.id}`, payload: { status: 'disabled' }, ...as(maria.token) });
    expect(byMaria.statusCode).toBe(403);
    const self = await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { status: 'disabled' }, ...as(maria.token) });
    expect(self.statusCode).toBe(403);
    const unknown = await app.inject({ method: 'PATCH', url: '/api/people/00000000-0000-4000-8000-000000000000', payload: { title: 'x' }, ...as(ceo) });
    expect(unknown.statusCode).toBe(404);
  });

  it('stops a disabled invitee from accepting', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', scope: { kind: 'company' } });
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
    const first = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', scope: { kind: 'company' } });
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
    const first = await invite(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', scope: { kind: 'company' } });
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) });
    const res = await reinvite(app, ceo, first.json().person.id);
    expect((await app.inject({ url: `/api/invites/${tokenOf(res.json().inviteUrl)}` })).statusCode).toBe(200);
  });

  it('protects the owner and yourself and needs company scope', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const maria = await inviteAndAccept(app, ceo, { name: 'Maria', email: 'maria@acme.com', title: '', scope: { kind: 'company' } });
    const { teamId } = await addTeam(db);
    const smm = await inviteAndAccept(app, ceo, { name: 'Sasha', email: 'sasha@acme.com', title: '', scope: { kind: 'team', id: teamId } });
    expect((await reinvite(app, maria.token, owner!.id)).statusCode).toBe(403);
    expect((await reinvite(app, maria.token, maria.id)).statusCode).toBe(403);
    expect((await reinvite(app, smm.token, maria.id)).statusCode).toBe(403);
    expect((await reinvite(app, ceo, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});
