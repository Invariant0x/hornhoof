import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { decryptSecret } from '../src/crypto/secrets.js';
import { assistants, people, vaultEntries, vaultLog } from '../src/db/schema.js';
import { as, mcp } from './helpers.js';
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
    expect(made.json()).toMatchObject({ name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', hasCode: true, createdBy: { id: c.ceo.id, name: c.ceo.name } });
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
    expect(Object.keys(list.json().entries[0]).sort()).toEqual(['createdAt', 'createdBy', 'hasCode', 'id', 'login', 'name', 'site']);
  });

  it('takes an entry from any person of the company and reads a code from an authenticator address', async () => {
    const c = await vaultCompany();
    const made = await c.add(c.samSession, entry({ code: `otpauth://totp/Partner:team?secret=${CODE}&issuer=Partner&digits=8&period=60&algorithm=SHA256` }));
    expect(made.statusCode).toBe(201);
    const [row] = await c.db.select().from(vaultEntries);
    expect(JSON.parse(decryptSecret(row!.totpEnc!, Buffer.from(c.config.secret)))).toEqual({ secret: CODE, digits: 8, period: 60, algorithm: 'SHA256' });
    const noCode = await c.add(c.samSession, entry({ name: 'Second', code: '' }));
    expect(noCode.json().hasCode).toBe(false);
  });

  it('refuses an empty password, a broken code and a taken name without saying what was typed', async () => {
    const c = await vaultCompany();
    expect((await c.add(c.ceoSession, entry({ password: '' }))).statusCode).toBe(400);
    const broken = await c.add(c.ceoSession, entry({ code: 'not-a-code-91x' }));
    expect(broken.statusCode).toBe(400);
    expect(broken.body).not.toContain('not-a-code-91x');
    expect((await c.add(c.ceoSession, entry())).statusCode).toBe(201);
    expect((await c.add(c.ceoSession, entry({ name: 'partner SITE' }))).statusCode).toBe(409);
  });

  it('takes an entry from the orchestrator acting for a person, as added by the orchestrator', async () => {
    const c = await vaultCompany();
    const res = await c.app.inject({ method: 'POST', url: '/api/vault', payload: entry(), headers: orchestratorHeaders(c.ceo.id, c.orchestrator.id) });
    expect(res.statusCode).toBe(201);
    expect(res.json().createdBy).toEqual({ id: c.orchestrator.id, name: c.orchestrator.name });
    const [log] = await c.db.select().from(vaultLog);
    expect(log).toMatchObject({ kind: 'created', agentId: c.orchestrator.id, personId: null });
  });

  it('lets any person of the company change and remove an entry, keeps the stored values when none are typed, and logs it', async () => {
    const c = await vaultCompany();
    const id = (await c.add(c.ceoSession, entry())).json().id as string;
    const changed = await c.app.inject({ method: 'PATCH', url: `/api/vault/${id}`, payload: { login: 'new@acme.test', password: '', removeCode: true }, ...as(c.samSession) });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ login: 'new@acme.test', hasCode: false });
    const [row] = await c.db.select().from(vaultEntries);
    expect(decryptSecret(row!.passwordEnc, Buffer.from(c.config.secret))).toBe(PASSWORD);
    const newPassword = await c.app.inject({ method: 'PATCH', url: `/api/vault/${id}`, payload: { password: 'pw-second-77aa' }, ...as(c.samSession) });
    expect(newPassword.statusCode).toBe(200);
    const [after] = await c.db.select().from(vaultEntries);
    expect(decryptSecret(after!.passwordEnc, Buffer.from(c.config.secret))).toBe('pw-second-77aa');
    expect((await c.app.inject({ method: 'DELETE', url: `/api/vault/${id}`, ...as(c.samSession) })).statusCode).toBe(204);
    expect(await c.db.select().from(vaultEntries)).toEqual([]);
    const log = await c.db.select().from(vaultLog).orderBy(vaultLog.at);
    expect(log.map(l => [l.kind, l.entryName, l.personId])).toEqual([['created', 'Partner site', c.ceo.id], ['changed', 'Partner site', c.sam.id], ['changed', 'Partner site', c.sam.id], ['removed', 'Partner site', c.sam.id]]);
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

  it('shows the log of an entry with who and when, and no values', async () => {
    const c = await vaultCompany();
    const id = (await c.add(c.ceoSession, entry())).json().id as string;
    const log = await c.app.inject({ url: `/api/vault/${id}/log`, ...as(c.samSession) });
    expect(log.statusCode).toBe(200);
    expect(log.json().log).toMatchObject([{ kind: 'created', person: { name: c.ceo.name }, agent: null, task: null }]);
    expect(log.body).not.toContain(PASSWORD);
  });

  it("shows what a person's own assistant did only to its owner, and a task only by its number", async () => {
    const c = await vaultCompany();
    const id = (await c.add(c.ceoSession, entry())).json().id as string;
    /* Aide is Sam's own assistant. */
    const [aidePerson] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Aide', status: 'active', isAgent: true, assistantOf: c.sam.id, scopeKind: 'listed' }).returning();
    await c.db.insert(assistants).values({ personId: aidePerson!.id, companyId: c.companyId, program: 'avaclone', agentId: c.aide.id });
    const taken = { companyId: c.companyId, entryId: id, entryName: 'Partner site', site: 'https://partner.example/login', kind: 'taken' as const, taskId: c.task.id };
    await c.db.insert(vaultLog).values([{ ...taken, agentId: c.aide.id }, { ...taken, agentId: c.nora.id }]);
    const { token } = await c.startTurn(c.aide.id);
    expect((await (await mcp(c.app, token)).callTool({ name: 'vault_save', arguments: entry({ name: 'Aide added' }) })).isError).toBeUndefined();

    const seen = async (session: string) => {
      const log = await c.app.inject({ url: `/api/vault/${id}/log`, ...as(session) });
      const list = await c.app.inject({ url: '/api/vault', ...as(session) });
      return {
        body: log.body + list.body,
        agents: (log.json().log as { agent: { name: string } | null }[]).flatMap(l => (l.agent ? [l.agent.name] : [])).sort(),
        addedBy: (list.json().entries as { name: string; createdBy: { name: string } | null }[]).find(e => e.name === 'Aide added')!.createdBy,
      };
    };
    expect(await seen(c.samSession)).toMatchObject({ agents: ['Aide', 'Nora'], addedBy: { name: 'Aide' } });
    const ceo = await seen(c.ceoSession);
    expect(ceo).toMatchObject({ agents: ['Nora'], addedBy: null });
    expect(ceo.body).not.toContain(c.aide.id);
    const log = await c.app.inject({ url: `/api/vault/${id}/log`, ...as(c.ceoSession) });
    expect(log.json().log).toEqual(expect.arrayContaining([expect.objectContaining({ task: { id: c.task.id, number: c.task.number } })]));
    expect(log.body).not.toContain(c.task.title);
  });
});
