import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, vaultEntries, vaultLog } from '../src/db/schema.js';
import { as, mcp } from './helpers.js';
import { vaultCompany } from './vault-fixture.js';

const PASSWORD = 'pw-marker-8f02bd';
const CODE = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
type ToolReply = { content: { type: string; text: string }[]; isError?: boolean };
const valueOf = (reply: ToolReply) => JSON.parse(reply.content[0]!.text);
const call = async (c: Awaited<ReturnType<typeof vaultCompany>>, token: string, name: string, args: Record<string, unknown> = {}) =>
  (await (await mcp(c.app, token)).callTool({ name, arguments: args })) as ToolReply;

async function setUp() {
  const c = await vaultCompany();
  expect((await c.add(c.ceoSession, { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: CODE })).statusCode).toBe(201);
  await c.add(c.ceoSession, { name: 'Sales only', site: 'https://crm.example', login: 'sales@acme.test', password: 'pw-sales-1234', scope: { kind: 'department', departmentId: c.sales.id } });
  await c.add(c.ceoSession, { name: 'Nora only', site: 'Partner app', login: 'nora@acme.test', password: 'pw-nora-1234', scope: { kind: 'agent', agentId: c.nora.id } });
  return c;
}

describe('the vault for agents', () => {
  it('lists only the entries each agent may use, without passwords or code secrets', async () => {
    const c = await setUp();
    const names = (reply: ToolReply) => valueOf(reply).entries.map((e: { name: string }) => e.name);
    for (const [id, expected] of [[c.nora.id, ['Nora only', 'Partner site']], [c.sammy.id, ['Partner site', 'Sales only']], [c.aide.id, ['Partner site']]] as const) {
      const { token } = await c.startTurn(id);
      const reply = await call(c, token, 'vault_entries');
      expect(names(reply)).toEqual(expected);
      expect(JSON.stringify(reply)).not.toContain(PASSWORD);
      expect(JSON.stringify(reply)).not.toContain(CODE);
    }
  });

  it('gives the login, password and current code as text, and logs the take without values', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1111111109_000 });
    onTestFinished(() => vi.useRealTimers());
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id, c.task.id);
    const reply = await call(c, token, 'vault_entry', { entry: 'partner SITE' });
    expect(reply.isError).toBeUndefined();
    expect(valueOf(reply)).toEqual({ name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: { value: '081804', validForSeconds: 1 } });
    vi.setSystemTime(1111111110_000);
    expect(valueOf(await call(c, token, 'vault_entry', { entry: 'Partner site' })).code).toEqual({ value: '050471', validForSeconds: 30 });
    const uses = await c.db.select().from(vaultLog).where(eq(vaultLog.kind, 'taken'));
    expect(uses).toHaveLength(2);
    expect(uses[0]).toMatchObject({ agentId: c.nora.id, taskId: c.task.id, entryName: 'Partner site' });
    expect(uses[0]!.at.toISOString()).toBe(new Date(1111111109_000).toISOString());
    for (const text of [JSON.stringify(uses), (await c.app.inject({ url: `/api/vault/${uses[0]!.entryId}/log`, ...as(c.ceoSession) })).body]) {
      for (const secret of [PASSWORD, CODE, '081804', '050471', 'team@acme.test']) expect(text).not.toContain(secret);
    }
    expect(JSON.stringify(reply)).not.toContain(CODE);
  });

  it('gives a narrowed entry only to its department or agent, including an assistant by default', async () => {
    const c = await setUp();
    const [head] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    for (const id of [head!.id, c.aide.id, c.nora.id, c.sammy.id]) {
      const { token } = await c.startTurn(id);
      expect(valueOf(await call(c, token, 'vault_entry', { entry: 'Partner site' })).password).toBe(PASSWORD);
    }
    for (const [id, entry, login] of [[c.nora.id, 'Nora only', 'nora@acme.test'], [c.sammy.id, 'Sales only', 'sales@acme.test']] as const) {
      const { token } = await c.startTurn(id);
      const reply = valueOf(await call(c, token, 'vault_entry', { entry }));
      expect(reply.login).toBe(login);
      expect(reply).not.toHaveProperty('code');
    }
  });

  it('refuses entries kept for others, another company and unknown names, without a take', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.aide.id);
    const [foreign] = await c.db.insert(vaultEntries).values({ companyId: c.other.id, name: 'Theirs', site: 'https://other.example', login: 'o', passwordEnc: 'x', createdBy: c.olaf.id, updatedBy: c.olaf.id }).returning();
    for (const [entry, code, reason] of [['Sales only', 'forbidden', 'vault_not_allowed'], ['Nora only', 'forbidden', 'vault_not_allowed'], [foreign!.id, 'forbidden', 'vault_not_allowed'], ['Theirs', 'not_found', 'vault_unknown']]) {
      const reply = await call(c, token, 'vault_entry', { entry });
      expect(reply.isError).toBe(true);
      expect(valueOf(reply)).toMatchObject({ error: { code, reason } });
      expect(JSON.stringify(reply)).not.toContain(PASSWORD);
    }
    expect(await c.db.select().from(vaultLog).where(eq(vaultLog.kind, 'taken'))).toEqual([]);
  });
});
