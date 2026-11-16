import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../src/crypto/secrets.js';
import { vaultEntries, vaultLog } from '../src/db/schema.js';
import { as, mcp } from './helpers.js';
import { vaultCompany } from './vault-fixture.js';

const PASSWORD = 'pw-marker-8f02bd';
/* The RFC 6238 seed of SHA1: at 1111111109 s its six-digit code is 081804, one second before the next period. */
const CODE = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const AT = 1111111109_000;

type ToolReply = { content: { type: 'text'; text: string }[]; isError?: boolean };
const answer = (reply: ToolReply) => JSON.parse(reply.content[0]!.text) as Record<string, unknown>;

async function setUp() {
  const c = await vaultCompany();
  c.app.ctx.clock = () => AT;
  await c.add(c.ceoSession, { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: CODE });
  await c.add(c.samSession, { name: 'CRM', site: 'https://crm.example', login: 'sales@acme.test', password: 'pw-crm-1234' });
  return c;
}

const call = async (c: Awaited<ReturnType<typeof setUp>>, token: string, name: string, args: Record<string, unknown> = {}) =>
  (await (await mcp(c.app, token)).callTool({ name, arguments: args })) as ToolReply;

describe('the vault for agents', () => {
  it('lists every entry of the company to each of its agents, with no password', async () => {
    const c = await setUp();
    for (const agent of [c.nora, c.aide, c.orchestrator]) {
      const { token } = await c.startTurn(agent.id);
      const list = await call(c, token, 'vault_entries');
      expect(answer(list).entries, agent.name).toEqual([
        { name: 'CRM', site: 'https://crm.example', login: 'sales@acme.test', hasCode: false },
        { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', hasCode: true },
      ]);
      expect(JSON.stringify(list)).not.toContain(PASSWORD);
    }
  });

  it('gives the agent that asks the login, the password and the code of this moment as text, and never the code secret', async () => {
    const c = await setUp();
    for (const agent of [c.nora, c.aide]) {
      const { token } = await c.startTurn(agent.id);
      const reply = await call(c, token, 'vault_entry', { entry: 'partner SITE' });
      expect(reply.isError, agent.name).toBeUndefined();
      expect(answer(reply)).toEqual({ name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: '081804', codeSecondsLeft: 1 });
      expect(JSON.stringify(reply)).not.toContain(CODE);
    }
    const { token } = await c.startTurn(c.nora.id);
    expect(answer(await call(c, token, 'vault_entry', { entry: 'CRM' }))).toEqual({ name: 'CRM', site: 'https://crm.example', login: 'sales@acme.test', password: 'pw-crm-1234' });
  });

  it('logs who took which entry for which task, with no value', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id, c.task.id);
    await call(c, token, 'vault_entry', { entry: 'Partner site' });
    const taken = await c.db.select().from(vaultLog).where(eq(vaultLog.kind, 'taken'));
    expect(taken).toMatchObject([{ entryName: 'Partner site', site: 'https://partner.example/login', agentId: c.nora.id, personId: null, taskId: c.task.id }]);
    expect(JSON.stringify(taken)).not.toContain(PASSWORD);
    expect(JSON.stringify(taken)).not.toContain('081804');
    const [entry] = await c.db.select().from(vaultEntries).where(eq(vaultEntries.name, 'Partner site'));
    const log = await c.app.inject({ url: `/api/vault/${entry!.id}/log`, ...as(c.samSession) });
    expect(log.json().log[0]).toMatchObject({ kind: 'taken', agent: { name: 'Nora' }, person: null, task: { id: c.task.id, number: c.task.number } });
    expect(log.body).not.toContain(PASSWORD);
  });

  it('knows no entry of another company and none that is not saved', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.otto.id);
    expect(answer(await call(c, token, 'vault_entries')).entries).toEqual([]);
    const theirs = await call(c, token, 'vault_entry', { entry: 'Partner site' });
    expect(theirs.isError).toBe(true);
    expect(answer(theirs)).toMatchObject({ error: { reason: 'vault_unknown' } });
    expect(JSON.stringify(theirs)).not.toContain(PASSWORD);
    expect(await c.db.select().from(vaultLog).where(eq(vaultLog.kind, 'taken'))).toEqual([]);
  });

  it('saves the sign-in a person gave the orchestrator in chat, and changes it by its name the next time', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.orchestrator.id);
    const saved = await call(c, token, 'vault_save', { name: 'LinkedIn', site: 'https://www.linkedin.com/login', login: 'ivan@acme.test', password: 'pw-linked-5521', code: 'jbsw y3dp ehpk 3pxp' });
    expect(saved.isError).toBeUndefined();
    expect(answer(saved)).toMatchObject({ name: 'LinkedIn', site: 'https://www.linkedin.com/login', login: 'ivan@acme.test', hasCode: true, createdBy: { id: c.orchestrator.id, name: c.orchestrator.name } });
    expect(JSON.stringify(saved)).not.toContain('pw-linked-5521');
    const [row] = await c.db.select().from(vaultEntries).where(eq(vaultEntries.name, 'LinkedIn'));
    expect(decryptSecret(row!.passwordEnc, Buffer.from(c.config.secret))).toBe('pw-linked-5521');

    const changed = await call(c, token, 'vault_save', { name: 'linkedin', site: 'https://www.linkedin.com/login', login: 'ivan@acme.test', password: 'pw-linked-new-77' });
    expect(answer(changed)).toMatchObject({ name: 'LinkedIn', hasCode: true });
    const rows = await c.db.select().from(vaultEntries).where(eq(vaultEntries.name, 'LinkedIn'));
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0]!.passwordEnc, Buffer.from(c.config.secret))).toBe('pw-linked-new-77');
    const log = await c.db.select().from(vaultLog).where(eq(vaultLog.entryName, 'LinkedIn')).orderBy(vaultLog.at);
    expect(log.map(l => [l.kind, l.agentId, l.personId])).toEqual([['created', c.orchestrator.id, null], ['changed', c.orchestrator.id, null]]);

    const { token: nora } = await c.startTurn(c.nora.id);
    expect(answer(await call(c, nora, 'vault_entry', { entry: 'LinkedIn' }))).toMatchObject({ login: 'ivan@acme.test', password: 'pw-linked-new-77' });
  });
});
