import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { savedSignIns } from '../src/db/schema.js';
import { keepSignIn } from '../src/modules/sign-ins/store.js';
import { as, connectNode, mcp, nextOf, until } from './helpers.js';
import { NODE_KEY, vaultCompany } from './vault-fixture.js';

/* The saved sign-ins of an employee: a sign-in the vault's browser got, kept encrypted for that one employee, shown on
   its card only as where, how and when, and revoked with one press. */

const COOKIE = 'cookie-marker-5d1c9e7a42';
const STORED = 'stored-marker-0b8e61f3a9';
const session = (value = COOKIE) => ({
  cookies: [{ name: 'sid', value, domain: 'partner.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }],
  origins: [{ origin: 'https://partner.example', localStorage: [{ name: 'token', value: STORED }] }],
});

type ToolReply = { content: { type: string; text?: string }[] };

async function setUp() {
  const lines: string[] = [];
  const logger = { level: 'info', stream: { write: (line: string) => void lines.push(line) } };
  const c = await vaultCompany(logger as never);
  await c.add(c.ceoSession, { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: 'pw-partner-1234' });
  const identity = await generateX25519Identity();
  const node = await connectNode(c.wsUrl, NODE_KEY);
  node.send({ type: 'hello', version: '0.31.0', loggedIn: true, running: [], publicKey: await identityToRecipient(identity), fills: ['browser'] });
  await until(async () => (await c.app.inject({ url: '/api/agents/orchestrator/events', ...as(c.ceoSession) })).json().state.ready);
  return { ...c, node, lines };
}

const signInsOf = (c: Awaited<ReturnType<typeof setUp>>, agentId: string, session: string) =>
  c.app.inject({ url: `/api/agents/${agentId}/sign-ins`, ...as(session) });

/* Nora's turn signs in through the vault, and the node answers that the browser got past the sign-in. */
async function signInThroughVault(c: Awaited<ReturnType<typeof setUp>>, value = COOKIE) {
  const { token } = await c.startTurn(c.nora.id);
  const client = await mcp(c.app, token);
  const pending = client.callTool({ name: 'vault_fill', arguments: { entry: 'Partner site', target: 'browser', fields: ['login', 'password'] } }) as Promise<ToolReply>;
  const fill = await nextOf(c.node, 'secret.fill');
  c.node.send({ type: 'secret.filled', requestId: fill.requestId, status: 'signed_in', filled: ['login', 'password'], session: session(value) } as never);
  return JSON.parse((await pending).content[0]!.text!) as { savedSignIn?: boolean };
}

describe('saved sign-ins of an employee', () => {
  it('keeps the sign-in the vault browser got for that employee, encrypted, and shows only where, how and when', async () => {
    const c = await setUp();
    expect(await signInThroughVault(c)).toMatchObject({ savedSignIn: true });

    const [row] = await c.db.select().from(savedSignIns).where(eq(savedSignIns.agentId, c.nora.id));
    expect(row).toMatchObject({ companyId: c.companyId, site: 'https://partner.example', source: 'vault', savedBy: null });
    expect(row!.sessionEnc).not.toContain(COOKIE);
    expect(row!.sessionEnc).not.toContain(STORED);

    const card = await signInsOf(c, c.nora.id, c.claraSession);
    expect(card.statusCode).toBe(200);
    expect(card.json()).toEqual({ signIns: [{ id: row!.id, site: 'https://partner.example', source: 'vault', savedBy: null, savedAt: row!.savedAt.toISOString() }] });
    expect(card.body).not.toContain(COOKIE);
    expect(card.body).not.toContain(STORED);
    expect(c.lines.join('')).not.toContain(COOKIE);
    expect(c.lines.join('')).not.toContain(STORED);
  });

  it('shows and revokes a sign-in only for people who see the employee: another department gets 403, another company finds no such employee', async () => {
    const c = await setUp();
    await signInThroughVault(c);
    const [row] = await c.db.select().from(savedSignIns).where(eq(savedSignIns.agentId, c.nora.id));

    expect((await signInsOf(c, c.nora.id, c.samSession)).statusCode).toBe(403);
    expect((await signInsOf(c, c.nora.id, c.olafSession)).statusCode).toBe(404);
    expect((await signInsOf(c, c.nora.id, c.ceoSession)).statusCode).toBe(200);
    const revoke = (session: string) => c.app.inject({ method: 'DELETE', url: `/api/agents/${c.nora.id}/sign-ins/${row!.id}`, ...as(session) });
    expect((await revoke(c.samSession)).statusCode).toBe(403);
    expect((await revoke(c.olafSession)).statusCode).toBe(404);
    expect(await c.db.select().from(savedSignIns)).toHaveLength(1);
  });

  it('revokes a sign-in with one press, and a sign-in of another employee is not found under this one', async () => {
    const c = await setUp();
    await signInThroughVault(c);
    const [row] = await c.db.select().from(savedSignIns).where(eq(savedSignIns.agentId, c.nora.id));

    const elsewhere = await c.app.inject({ method: 'DELETE', url: `/api/agents/${c.sammy.id}/sign-ins/${row!.id}`, ...as(c.ceoSession) });
    expect(elsewhere.statusCode).toBe(404);
    const gone = await c.app.inject({ method: 'DELETE', url: `/api/agents/${c.nora.id}/sign-ins/${row!.id}`, ...as(c.claraSession) });
    expect(gone.statusCode).toBe(204);
    expect(await c.db.select().from(savedSignIns)).toEqual([]);
    expect((await signInsOf(c, c.nora.id, c.claraSession)).json()).toEqual({ signIns: [] });
  });

  it('keeps one sign-in per employee and site: a newer one replaces the older', async () => {
    const c = await setUp();
    await signInThroughVault(c, 'cookie-first-0123456789');
    await signInThroughVault(c, 'cookie-second-0123456789');
    const rows = await c.db.select().from(savedSignIns);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionEnc).not.toContain('cookie-second-0123456789');
  });

  it('keeps no sign-in for an employee of another company', async () => {
    const c = await setUp();
    const kept = await keepSignIn(c.app.ctx, { companyId: c.companyId, agentId: c.otherAgent.id, site: 'https://partner.example', session: session(), source: 'vault', savedBy: null, userAgent: null });
    expect(kept).toBe(false);
    expect(await c.db.select().from(savedSignIns)).toEqual([]);
  });
});
