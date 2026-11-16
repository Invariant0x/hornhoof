import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { decryptSecret } from '../src/crypto/secrets.js';
import { agents, assistants, people, vaultEntries, vaultLog } from '../src/db/schema.js';
import { as } from './helpers.js';
import { vaultCompany } from './vault-fixture.js';

const PASSWORD = 'pw-marker-3c41e7';
const CODE = 'JBSWY3DPEHPK3PXPJBSWY3DP';

const entry = (over: Record<string, unknown> = {}) => ({ name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: CODE, ...over });

describe('the company vault for people', () => {
  it('keeps the password and the code secret encrypted and never gives them back', async () => {
    const c = await vaultCompany();
    const made = await c.add(c.ceoSession, entry());
    expect(made.statusCode).toBe(201);
    expect(made.body).not.toContain(PASSWORD);
    expect(made.body).not.toContain(CODE);
    expect(made.json()).toMatchObject({ name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', hasCode: true, scope: { kind: 'company' }, createdBy: { name: c.ceo.name } });
    const [row] = await c.db.select().from(vaultEntries);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    expect(JSON.stringify(row)).not.toContain(CODE);
    expect(decryptSecret(row!.passwordEnc, Buffer.from(c.config.secret))).toBe(PASSWORD);
    expect(JSON.parse(decryptSecret(row!.totpEnc!, Buffer.from(c.config.secret)))).toEqual({ secret: CODE, digits: 6, period: 30, algorithm: 'SHA1' });
    const list = await c.app.inject({ url: '/api/vault', ...as(c.samSession) });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(PASSWORD);
    expect(list.body).not.toContain(CODE);
    expect(list.json().entries.map((e: { name: string }) => e.name)).toEqual(['Partner site']);
    expect(Object.keys(list.json().entries[0]).sort()).toEqual(['createdAt', 'createdBy', 'hasCode', 'id', 'login', 'name', 'scope', 'site', 'updatedAt', 'updatedBy']);
  });

  it('takes an entry from any person of the company and reads a code from an authenticator address', async () => {
    const c = await vaultCompany();
    const made = await c.add(c.claraSession, entry({ code: `otpauth://totp/Partner:team?secret=${CODE}&issuer=Partner&digits=8&period=60&algorithm=SHA256` }));
    expect(made.statusCode).toBe(201);
    const [row] = await c.db.select().from(vaultEntries);
    expect(JSON.parse(decryptSecret(row!.totpEnc!, Buffer.from(c.config.secret)))).toEqual({ secret: CODE, digits: 8, period: 60, algorithm: 'SHA256' });
    const noCode = await c.add(c.samSession, entry({ name: 'Second', code: '' }));
    expect(noCode.json().hasCode).toBe(false);
  });

  it('refuses a short password, a broken code and a taken name without saying what was typed', async () => {
    const c = await vaultCompany();
    const short = await c.add(c.ceoSession, entry({ password: 'pw7' }));
    expect(short.statusCode).toBe(400);
    expect(short.body).not.toContain('pw7');
    const broken = await c.add(c.ceoSession, entry({ code: 'not-a-code-91x' }));
    expect(broken.statusCode).toBe(400);
    expect(broken.body).not.toContain('not-a-code-91x');
    expect((await c.add(c.ceoSession, entry())).statusCode).toBe(201);
    expect((await c.add(c.ceoSession, entry({ name: 'partner SITE' }))).statusCode).toBe(409);
  });

  it('takes values only from a person, never from an agent acting as one', async () => {
    const c = await vaultCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const res = await c.app.inject({ method: 'POST', url: '/api/vault', payload: { ...entry(), scope: { kind: 'company' } }, headers: orchestratorHeaders(c.ceo.id, orchestrator!.id) });
    expect(res.statusCode).toBe(403);
    expect(await c.db.select().from(vaultEntries)).toEqual([]);
  });

  it('narrows an entry to a department or an agent of this company only', async () => {
    const c = await vaultCompany();
    expect((await c.add(c.ceoSession, entry({ name: 'Dept', scope: { kind: 'department', departmentId: c.mkt.id } }))).json().scope).toMatchObject({ kind: 'department', departmentId: c.mkt.id });
    expect((await c.add(c.ceoSession, entry({ name: 'Agent', scope: { kind: 'agent', agentId: c.nora.id } }))).json().scope).toMatchObject({ kind: 'agent', agentId: c.nora.id, agentName: 'Nora' });
    expect((await c.add(c.ceoSession, entry({ name: 'Foreign agent', scope: { kind: 'agent', agentId: c.otherAgent.id } }))).statusCode).toBe(400);
  });

  it('lets the author and the CEO change and remove an entry, keeps the stored values when none are typed, and logs it', async () => {
    const c = await vaultCompany();
    const id = (await c.add(c.claraSession, entry())).json().id as string;
    const bySam = await c.app.inject({ method: 'PATCH', url: `/api/vault/${id}`, payload: { login: 'sam@acme.test' }, ...as(c.samSession) });
    expect(bySam.statusCode).toBe(403);
    const changed = await c.app.inject({ method: 'PATCH', url: `/api/vault/${id}`, payload: { login: 'new@acme.test', password: '', removeCode: true }, ...as(c.claraSession) });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ login: 'new@acme.test', hasCode: false });
    const [row] = await c.db.select().from(vaultEntries);
    expect(decryptSecret(row!.passwordEnc, Buffer.from(c.config.secret))).toBe(PASSWORD);
    const newPassword = await c.app.inject({ method: 'PATCH', url: `/api/vault/${id}`, payload: { password: 'pw-second-77aa' }, ...as(c.ceoSession) });
    expect(newPassword.statusCode).toBe(200);
    const [after] = await c.db.select().from(vaultEntries);
    expect(decryptSecret(after!.passwordEnc, Buffer.from(c.config.secret))).toBe('pw-second-77aa');
    expect((await c.app.inject({ method: 'DELETE', url: `/api/vault/${id}`, ...as(c.samSession) })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'DELETE', url: `/api/vault/${id}`, ...as(c.ceoSession) })).statusCode).toBe(204);
    expect(await c.db.select().from(vaultEntries)).toEqual([]);
    const log = await c.db.select().from(vaultLog).orderBy(vaultLog.at);
    expect(log.map(l => [l.kind, l.entryName])).toEqual([['created', 'Partner site'], ['changed', 'Partner site'], ['changed', 'Partner site'], ['removed', 'Partner site']]);
    expect(JSON.stringify(log)).not.toContain(PASSWORD);
  });

  it('answers 403 to a person of another company for any entry it names, and lists none of ours', async () => {
    const c = await vaultCompany();
    const id = (await c.add(c.ceoSession, entry())).json().id as string;
    expect((await c.app.inject({ url: '/api/vault', ...as(c.olafSession) })).json().entries).toEqual([]);
    for (const [method, url] of [['PATCH', `/api/vault/${id}`], ['DELETE', `/api/vault/${id}`], ['GET', `/api/vault/${id}/log`]] as const) {
      const res = await c.app.inject({ method, url, ...(method === 'PATCH' ? { payload: { login: 'x@other.test' } } : {}), ...as(c.olafSession) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await c.db.select().from(vaultEntries)).length).toBe(1);
  });

  it('shows the log of an entry with who, when and for which task, and no values', async () => {
    const c = await vaultCompany();
    const id = (await c.add(c.ceoSession, entry())).json().id as string;
    const log = await c.app.inject({ url: `/api/vault/${id}/log`, ...as(c.claraSession) });
    expect(log.statusCode).toBe(200);
    expect(log.json().log).toMatchObject([{ kind: 'created', person: { name: c.ceo.name }, agent: null, task: null }]);
    expect(log.body).not.toContain(PASSWORD);
  });

  it("shows a person's own assistant's use only to its owner, and a task only by its number", async () => {
    const c = await vaultCompany();
    const id = (await c.add(c.ceoSession, entry())).json().id as string;
    /* Aide is Clara's own assistant. */
    const [aidePerson] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Aide', status: 'active', isAgent: true, assistantOf: c.clara.id, scopeKind: 'listed' }).returning();
    await c.db.insert(assistants).values({ personId: aidePerson!.id, companyId: c.companyId, program: 'avaclone', agentId: c.aide.id });
    const used = { companyId: c.companyId, entryId: id, entryName: 'Partner site', site: 'https://partner.example/login', kind: 'used' as const, taskId: c.task.id, target: 'browser' as const, fields: ['login' as const, 'password' as const], status: 'signed_in' };
    await c.db.insert(vaultLog).values([{ ...used, agentId: c.aide.id }, { ...used, agentId: c.nora.id }]);

    const users = async (session: string) => {
      const res = await c.app.inject({ url: `/api/vault/${id}/log`, ...as(session) });
      expect(res.statusCode).toBe(200);
      return { body: res.body, agents: (res.json().log as { agent: { name: string } | null }[]).flatMap(l => (l.agent ? [l.agent.name] : [])).sort() };
    };
    expect((await users(c.claraSession)).agents).toEqual(['Aide', 'Nora']);
    for (const session of [c.samSession, c.ceoSession]) {
      const seen = await users(session);
      expect(seen.agents).toEqual(['Nora']);
      expect(seen.body).not.toContain(c.aide.id);
    }
    /* Sam has Sales only and does not open the task of Marketing: its number, never its title. */
    const sam = await c.app.inject({ url: `/api/vault/${id}/log`, ...as(c.samSession) });
    expect(sam.json().log).toEqual(expect.arrayContaining([expect.objectContaining({ task: { id: c.task.id, number: c.task.number } })]));
    expect(sam.body).not.toContain(c.task.title);
  });
});
