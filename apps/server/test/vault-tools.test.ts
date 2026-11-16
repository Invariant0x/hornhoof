import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { vaultEntries, vaultLog } from '../src/db/schema.js';
import { as, mcp } from './helpers.js';
import { vaultCompany } from './vault-fixture.js';

const PASSWORD = 'pw-marker-8f02bd';
/* RFC 6238's SHA1 seed: at 1111111111 s its six-digit code is 050471, good for 29 more seconds. */
const CODE = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const AT = new Date(1111111111_000);

type ToolReply = { content: { type: 'text'; text: string }[]; isError?: boolean };
const textOf = (reply: ToolReply) => reply.content[0]!.text;

async function setUp() {
  const c = await vaultCompany();
  await c.add(c.ceoSession, { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: CODE });
  await c.add(c.ceoSession, { name: 'Sales only', site: 'https://crm.example', login: 'sales@acme.test', password: 'pw-sales-1234', scope: { kind: 'department', departmentId: c.sales.id } });
  await c.add(c.ceoSession, { name: 'Nora only', site: 'https://nora.example', login: 'nora@acme.test', password: 'pw-nora-1234', scope: { kind: 'agent', agentId: c.nora.id } });
  await c.db.insert(vaultEntries).values({ companyId: c.other.id, name: 'Theirs', site: 'https://theirs.example', login: 'olaf', passwordEnc: 'x', createdBy: c.olaf.id, updatedBy: c.olaf.id });
  return c;
}

const call = async (c: { app: Parameters<typeof mcp>[0] }, token: string, name: string, args: Record<string, unknown> = {}) =>
  (await (await mcp(c.app, token)).callTool({ name, arguments: args })) as ToolReply;

/* The server's clock, set: only Date moves, so the requests and the database go on as ever. */
function clockAt(at: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  onTestFinished(() => void vi.useRealTimers());
}

describe('the vault for agents', () => {
  it('lists to each agent the entries it may use, with no value', async () => {
    const c = await setUp();
    const nora = await c.startTurn(c.nora.id);
    const sammy = await c.startTurn(c.sammy.id);
    const aide = await c.startTurn(c.aide.id);
    const names = (reply: ToolReply) => (JSON.parse(textOf(reply)) as { entries: { name: string }[] }).entries.map(e => e.name);
    const noraList = await call(c, nora.token, 'vault_entries');
    expect(names(noraList)).toEqual(['Nora only', 'Partner site']);
    expect(names(await call(c, sammy.token, 'vault_entries'))).toEqual(['Partner site', 'Sales only']);
    expect(names(await call(c, aide.token, 'vault_entries'))).toEqual(['Partner site']);
    expect(JSON.stringify(noraList)).not.toContain(PASSWORD);
    expect(JSON.parse(textOf(noraList)).entries[1]).toEqual({ name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', hasCode: true, scope: 'company' });
  });

  it('gives an agent that may use an entry its login, password and current code as text, and logs the take for its task without them', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id, c.task.id);
    clockAt(AT);
    const reply = await call(c, token, 'vault_entry', { entry: 'partner SITE' });
    vi.useRealTimers();
    expect(reply.isError).toBeUndefined();
    expect(JSON.parse(textOf(reply))).toEqual({
      name: 'Partner site',
      site: 'https://partner.example/login',
      login: 'team@acme.test',
      password: PASSWORD,
      code: { code: '050471', validForSeconds: 29 },
    });
    expect(textOf(reply)).not.toContain(CODE);

    const taken = (await c.db.select().from(vaultLog)).filter(r => r.kind === 'taken');
    expect(taken).toMatchObject([{ agentId: c.nora.id, taskId: c.task.id, personId: null, entryName: 'Partner site' }]);
    expect(JSON.stringify(taken)).not.toContain(PASSWORD);
    expect(JSON.stringify(taken)).not.toContain('050471');

    const [entry] = (await c.app.inject({ url: '/api/vault', ...as(c.ceoSession) })).json().entries.filter((e: { name: string }) => e.name === 'Partner site');
    const log = await c.app.inject({ url: `/api/vault/${entry.id}/log`, ...as(c.ceoSession) });
    expect(log.json().log.find((l: { kind: string }) => l.kind === 'taken')).toMatchObject({ kind: 'taken', agent: { id: c.nora.id, name: 'Nora' }, task: { id: c.task.id, number: c.task.number } });
    expect(log.body).not.toContain(PASSWORD);
    expect(log.body).not.toContain(CODE);
  });

  it('gives an assistant of the company an entry for everyone, with no code when the entry has none', async () => {
    const c = await setUp();
    await c.add(c.ceoSession, { name: 'No code', site: 'https://plain.example', login: 'plain', password: 'pw-plain-7d1' });
    const { token } = await c.startTurn(c.aide.id);
    expect(JSON.parse(textOf(await call(c, token, 'vault_entry', { entry: 'No code' })))).toEqual({ name: 'No code', site: 'https://plain.example', login: 'plain', password: 'pw-plain-7d1' });
  });

  it('refuses an entry kept for others, an unknown one and one of another company, with no value and no log line', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id);
    const kept = await call(c, token, 'vault_entry', { entry: 'Sales only' });
    expect(kept.isError).toBe(true);
    expect(JSON.parse(textOf(kept))).toMatchObject({ error: { reason: 'vault_not_allowed' } });
    expect(textOf(kept)).not.toContain('pw-sales-1234');
    expect(JSON.parse(textOf(await call(c, token, 'vault_entry', { entry: 'Nowhere' })))).toMatchObject({ error: { reason: 'vault_unknown' } });
    expect(JSON.parse(textOf(await call(c, token, 'vault_entry', { entry: 'Theirs' })))).toMatchObject({ error: { reason: 'vault_unknown' } });
    const sammy = await c.startTurn(c.sammy.id);
    expect(JSON.parse(textOf(await call(c, sammy.token, 'vault_entry', { entry: 'Nora only' })))).toMatchObject({ error: { reason: 'vault_not_allowed' } });
    expect((await c.db.select().from(vaultLog)).filter(r => r.kind === 'taken')).toEqual([]);
  });
});
