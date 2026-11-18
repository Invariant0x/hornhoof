import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, assistants, companies, invites, jobs, machines, people, personKeys, sessions, subscriptions, tasks } from '../src/db/schema.js';
import { as, invitePerson, listen, mcp, ownDatabases, ownPlan, setUpCompany, testApp } from './helpers.js';

ownDatabases();

const MACHINE_ID = 'a1b2c3d4'.repeat(4);
const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

/* Ivan the CEO, and Maria and Olga, who see the whole company. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp(env);
  const ceo = await setUpCompany(app);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
  const olga = await invitePerson(app, ceo, { name: 'Olga', email: 'olga@acme.com', access: { whole: true } });
  const idOf = async (email: string) => (await db.select().from(people).where(eq(people.email, email)))[0]!.id;
  return { app, db, ceo, owner: owner!, companyId: owner!.companyId, maria, mariaId: await idOf('maria@acme.com'), olga, olgaId: await idOf('olga@acme.com') };
}

type Company = Awaited<ReturnType<typeof company>>;

const remove = (c: Company, id: string, session: string) => c.app.inject({ method: 'DELETE', url: `/api/people/${id}`, ...as(session) });
const row = async (c: Company, id: string) => (await c.db.select().from(people).where(eq(people.id, id)))[0]!;
const listed = async (c: Company) => ((await c.app.inject({ url: '/api/people', ...as(c.ceo) })).json().people as { name: string }[]).map(p => p.name);
const onMap = async (c: Company) => ((await c.app.inject({ url: '/api/org', ...as(c.ceo) })).json().people as { name: string }[]).map(p => p.name);

/* An assistant of this person, set up from this session, with its key. */
async function assistantOf(c: Company, session: string, ownerId: string, name = 'Ava') {
  const { id } = (await c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name, owner: ownerId, program: 'avaclone' }, ...as(session) })).json().person;
  const { key } = (await c.app.inject({ method: 'POST', url: `/api/people/${id}/key`, ...as(session) })).json();
  return { id: id as string, key: key as string };
}

describe('DELETE /api/people/:id', () => {
  it('takes a person off the list and the map for good: their sessions, keys, machines and own plans end', async () => {
    const c = await company();
    const plan = await ownPlan(c.db, 'maria@acme.com');
    /* A key she added for the company is the company's, and stays. */
    const [companyKey] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'anthropic_api', kind: 'api_key', label: 'Company key', status: 'ready', ownerPersonId: c.mariaId }).returning();
    const [box] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.mariaId, machineKey: 'maria-0001-abcd', hostname: 'maria-box' }).returning();
    await c.db.insert(personKeys).values({ personId: c.mariaId, companyId: c.companyId, publicKey: 'cHVibGlj', wrapped: 'd3JhcHBlZA', salt: 'c2FsdA', iv: 'aXY', iterations: 600_000 });
    await c.db.update(people).set({ telegramUsername: 'maria_acme' }).where(eq(people.id, c.mariaId));
    expect(await listed(c)).toContain('Maria');
    expect(await onMap(c)).toContain('Maria');

    const res = await remove(c, c.mariaId, c.ceo);
    expect(res.statusCode).toBe(204);

    expect(await listed(c)).toEqual(['Ivan', 'Olga']);
    expect(await onMap(c)).not.toContain('Maria');
    expect((await c.app.inject({ url: '/api/me', ...as(c.maria) })).statusCode).toBe(401);
    expect(await c.db.select().from(sessions).where(eq(sessions.personId, c.mariaId))).toEqual([]);
    expect(await c.db.select().from(personKeys).where(eq(personKeys.personId, c.mariaId))).toEqual([]);
    expect((await c.db.select().from(machines).where(eq(machines.id, box!.id)))[0]!.revokedAt).not.toBeNull();
    expect((await c.db.select().from(subscriptions).where(eq(subscriptions.id, plan)))[0]!.removedAt).not.toBeNull();
    expect((await c.db.select().from(subscriptions).where(eq(subscriptions.id, companyKey!.id)))[0]!.removedAt).toBeNull();
    expect(await row(c, c.mariaId)).toMatchObject({ name: 'Maria', status: 'disabled', isCeoDelegate: false, telegramUsername: null });
    expect((await row(c, c.mariaId)).removedAt).not.toBeNull();
    expect((await remove(c, c.mariaId, c.ceo)).statusCode).toBe(404);
  });

  it('keeps old tasks pointing at the person, with their name, and frees their email for a new invite', async () => {
    const c = await company();
    const made = await c.app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Old work' }, ...as(c.maria) });
    expect(made.statusCode).toBe(201);
    const task = made.json().task as { id: string };
    expect((await remove(c, c.mariaId, c.ceo)).statusCode).toBe(204);

    const view = (await c.app.inject({ url: `/api/tasks/${task.id}`, ...as(c.ceo) })).json();
    expect(view.task.createdBy).toEqual({ kind: 'person', id: c.mariaId, name: 'Maria' });
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.createdByPersonId).toBe(c.mariaId);
    const again = await c.app.inject({ method: 'POST', url: '/api/people/invite', payload: { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } }, ...as(c.ceo) });
    expect(again.statusCode).toBe(201);
    expect(again.json().person.id).not.toBe(c.mariaId);
  });

  it('ends an invite that was never accepted', async () => {
    const c = await company();
    const invited = await c.app.inject({ method: 'POST', url: '/api/people/invite', payload: { name: 'Sasha', email: 'sasha@acme.com', title: '', access: { whole: true } }, ...as(c.ceo) });
    const token = new URL(invited.json().inviteUrl).pathname.split('/').pop()!;
    expect((await remove(c, invited.json().person.id, c.ceo)).statusCode).toBe(204);
    expect((await c.app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: 'correct horse battery' } })).statusCode).toBe(410);
    expect((await c.db.select().from(invites).where(eq(invites.personId, invited.json().person.id)))[0]!.usedAt).not.toBeNull();
  });

  it("deletes an assistant: its key opens nothing and its own agent leaves the company, while its owner's plan stays", async () => {
    const c = await company();
    const plan = await ownPlan(c.db, c.owner.email!);
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}/assistant`, payload: { plan }, ...as(c.ceo) })).statusCode).toBe(200);
    const agentId = (await c.db.select().from(assistants).where(eq(assistants.personId, ava.id)))[0]!.agentId!;
    expect((await c.app.inject({ url: '/api/assistant/me', ...bearer(ava.key) })).statusCode).toBe(200);

    expect((await remove(c, ava.id, c.ceo)).statusCode).toBe(204);

    expect((await c.app.inject({ url: '/api/assistant/me', ...bearer(ava.key) })).statusCode).toBe(401);
    expect((await c.db.select().from(assistants).where(eq(assistants.personId, ava.id)))[0]!.keyHash).toBeNull();
    const [agent] = await c.db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent!.removedAt).not.toBeNull();
    expect(agent!.subscriptionId).toBeNull();
    expect((await c.db.select().from(subscriptions).where(eq(subscriptions.id, plan)))[0]!.removedAt).toBeNull();
    expect(await listed(c)).not.toContain('Ava');
  });

  it('leaves nothing to change on a deleted person or assistant: no status, invite link or key brings them back', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    for (const id of [c.mariaId, ava.id]) expect((await remove(c, id, c.ceo)).statusCode).toBe(204);
    const calls = [
      { method: 'PATCH' as const, url: `/api/people/${c.mariaId}`, payload: { status: 'active' } },
      { method: 'POST' as const, url: `/api/people/${c.mariaId}/invite` },
      { method: 'PATCH' as const, url: `/api/people/${ava.id}`, payload: { status: 'active' } },
      { method: 'POST' as const, url: `/api/people/${ava.id}/key` },
      { method: 'PATCH' as const, url: `/api/people/${ava.id}/assistant`, payload: { program: 'hermes' } },
    ];
    for (const call of calls) {
      const res = await c.app.inject({ ...call, ...as(c.ceo) });
      expect([call.url, res.statusCode, res.json().error.reason]).toEqual([call.url, 404, 'person_unknown']);
    }
    expect(await row(c, c.mariaId)).toMatchObject({ status: 'disabled', passwordHash: null });
    expect((await c.db.select().from(assistants).where(eq(assistants.personId, ava.id)))[0]).toMatchObject({ keyHash: null, program: 'avaclone' });
  });

  it('takes the assistants of a deleted person with them', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.maria, c.mariaId);
    expect((await remove(c, c.mariaId, c.ceo)).statusCode).toBe(204);
    expect((await row(c, ava.id)).removedAt).not.toBeNull();
    expect((await c.app.inject({ url: '/api/assistant/me', ...bearer(ava.key) })).statusCode).toBe(401);
    expect(await listed(c)).toEqual(['Ivan', 'Olga']);
  });

  it("is the CEO's alone and never applies to the CEO or another company", async () => {
    const c = await company();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    await c.app.inject({ method: 'PUT', url: `/api/people/${c.mariaId}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(c.ceo) });

    const byDelegate = await remove(c, c.olgaId, c.maria);
    expect([byDelegate.statusCode, byDelegate.json().error.reason]).toEqual([403, 'not_owner']);
    expect((await remove(c, c.mariaId, c.olga)).statusCode).toBe(403);
    const self = await remove(c, c.owner.id, c.ceo);
    expect([self.statusCode, self.json().error.reason]).toEqual([403, 'owner_locked']);
    const viaOrchestrator = await c.app.inject({ method: 'DELETE', url: `/api/people/${c.owner.id}`, headers: orchestratorHeaders(c.owner.id, orchestrator!.id) });
    expect(viaOrchestrator.json().error.reason).toBe('owner_locked');
    expect((await row(c, c.owner.id)).removedAt).toBeNull();

    const [other] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [stranger] = await c.db.insert(people).values({ companyId: other!.id, name: 'Other', email: 'other@example.test', title: '', status: 'active', scopeKind: 'company' }).returning();
    expect((await remove(c, stranger!.id, c.ceo)).statusCode).toBe(404);
    expect((await remove(c, '00000000-0000-4000-8000-000000000000', c.ceo)).statusCode).toBe(404);
    expect((await row(c, stranger!.id)).removedAt).toBeNull();

    expect((await c.app.inject({ method: 'DELETE', url: `/api/people/${c.olgaId}`, headers: orchestratorHeaders(c.owner.id, orchestrator!.id) })).statusCode).toBe(403);
    expect((await row(c, c.olgaId)).removedAt).toBeNull();
    expect((await row(c, c.mariaId)).removedAt).toBeNull();
  });

  it("requires a real CEO yes for the exact target and cannot record it through owner headers", async () => {
    const c = await company();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const headers = orchestratorHeaders(c.owner.id, orchestrator!.id);
    const approval = (id: string, auth: ReturnType<typeof as> | { headers: Record<string, string> }, approve: boolean) =>
      c.app.inject({ method: 'POST', url: `/api/people/${id}/delete-approval`, payload: { approve }, ...auth });
    const deleteAsAgent = (id: string) => c.app.inject({ method: 'DELETE', url: `/api/people/${id}`, headers });
    expect((await deleteAsAgent(c.olgaId)).statusCode).toBe(403);
    expect((await approval(c.olgaId, { headers }, true)).statusCode).toBe(403);
    expect((await approval(c.olgaId, as(c.maria), true)).statusCode).toBe(403);
    expect((await approval(c.olgaId, as(c.ceo), false)).statusCode).toBe(400);
    expect((await approval(c.mariaId, as(c.ceo), true)).statusCode).toBe(204);
    expect((await deleteAsAgent(c.olgaId)).statusCode).toBe(403);
    const token = 'delete-person-tool-token-0123456789';
    const [plan] = await c.db.select().from(subscriptions).where(eq(subscriptions.companyId, c.companyId));
    await c.db.insert(jobs).values({ companyId: c.companyId, agentId: orchestrator!.id, subscriptionId: plan!.id, kind: 'conversation', prompt: '', status: 'running', timeoutMs: 1000, toolTokenHash: hashToken(token) });
    await listen(c.app);
    const client = await mcp(c.app, token);
    const forged = await client.callTool({ name: 'api', arguments: { method: 'POST', path: `/api/people/${c.olgaId}/delete-approval`, body: { approve: true } } });
    expect(forged.isError).toBe(true);
    const removed = await client.callTool({ name: 'delete_person', arguments: { person: c.mariaId } });
    expect(removed.isError, JSON.stringify(removed.content)).toBeFalsy();
    expect(await row(c, c.mariaId)).toMatchObject({ deletionApprovedBy: c.owner.id, deletionApprovedAt: expect.any(Date), deletionCompletedAt: expect.any(Date) });
    expect((await row(c, c.olgaId)).removedAt).toBeNull();
  });

  it("lets the orchestrator read another person's assistant's conversation, and leaves orders to its person", async () => {
    const c = await company();
    const ava = await assistantOf(c, c.maria, c.mariaId);
    const plan = await ownPlan(c.db, 'maria@acme.com');
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}/assistant`, payload: { plan }, ...as(c.maria) })).statusCode).toBe(200);
    const [assistant] = await c.db.select().from(assistants).where(eq(assistants.personId, ava.id));
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const headers = orchestratorHeaders(c.owner.id, orchestrator!.id);
    const path = `/api/agents/${assistant!.agentId}`;
    expect((await c.app.inject({ url: `${path}/events`, headers })).statusCode).toBe(200);
    expect((await c.app.inject({ url: `${path}/events`, ...as(c.ceo) })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'POST', url: `${path}/messages`, headers, payload: { text: 'Do this.' } })).statusCode).toBe(403);
  });

  it('resumes cleanup after a failure after the account and its assistant were marked removed', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.maria, c.mariaId);
    const plan = await ownPlan(c.db, 'maria@acme.com');
    const [box] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.mariaId, machineKey: 'maria-box', hostname: 'maria-box' }).returning();
    await c.db.execute("CREATE FUNCTION fail_removal() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''Test cleanup failure''; END'");
    await c.db.execute("CREATE TRIGGER fail_removal BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION fail_removal()");
    try {
      expect((await remove(c, c.mariaId, c.ceo)).statusCode).toBe(500);
      expect((await row(c, c.mariaId)).removedAt).not.toBeNull();
      expect((await row(c, ava.id)).removedAt).not.toBeNull();
      expect((await c.app.inject({ url: '/api/me', ...as(c.maria) })).statusCode).toBe(401);
    } finally {
      await c.db.execute('DROP TRIGGER fail_removal ON subscriptions');
      await c.db.execute('DROP FUNCTION fail_removal()');
    }
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const retry = await c.app.inject({ method: 'DELETE', url: `/api/people/${c.mariaId}`, headers: orchestratorHeaders(c.owner.id, orchestrator!.id) });
    expect(retry.statusCode).toBe(204);
    expect((await c.db.select().from(subscriptions).where(eq(subscriptions.id, plan)))[0]!.removedAt).not.toBeNull();
    expect((await c.db.select().from(machines).where(eq(machines.id, box!.id)))[0]!.revokedAt).not.toBeNull();
    expect((await remove(c, c.mariaId, c.ceo)).statusCode).toBe(404);
  });

  it('never deletes a person whose machine runs the company server', async () => {
    const c = await company({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID });
    const [box] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.mariaId, machineKey: 'maria-0001-abcd', hostname: 'maria-box', networkId: MACHINE_ID, role: 'data' }).returning();
    const res = await remove(c, c.mariaId, c.ceo);
    expect([res.statusCode, res.json().error.reason, res.json().error.message]).toEqual([409, 'leader', 'maria-box runs the company server. Move the server to another machine first.']);
    expect(await row(c, c.mariaId)).toMatchObject({ status: 'active', removedAt: null });
    expect((await c.db.select().from(machines).where(eq(machines.id, box!.id)))[0]!.revokedAt).toBeNull();
    expect((await c.app.inject({ url: '/api/me', ...as(c.maria) })).statusCode).toBe(200);
  });
});
