import { Decrypter, armor, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { vaultLog } from '../src/db/schema.js';
import { builtinOf, ownMachine } from '../src/modules/nodes/hub.js';
import { useFillTimer, usePhoneTargets, useSessionStore } from '../src/modules/vault/fill.js';
import { ApiError } from '../src/errors.js';
import { as, connectNode, mcp, nextOf, until, type FakeNode } from './helpers.js';
import { NODE_KEY, vaultCompany } from './vault-fixture.js';

const PASSWORD = 'pw-marker-8f02bd';
const CODE = 'JBSWY3DPEHPK3PXPJBSWY3DP';

type ToolReply = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
const textOf = (reply: ToolReply) => (reply.content[0] as { text: string }).text;

async function withNode(c: Awaited<ReturnType<typeof vaultCompany>>, fills: ('browser' | 'phone')[] = ['browser']) {
  const identity = await generateX25519Identity();
  const node = await connectNode(c.wsUrl, NODE_KEY);
  node.send({ type: 'hello', version: '0.31.0', loggedIn: true, running: [], publicKey: await identityToRecipient(identity), fills });
  /* The hello is settled, with the turns it ended, before any turn of the test starts. */
  await until(async () => (await c.app.inject({ url: '/api/agents/orchestrator/events', ...as(c.ceoSession) })).json().state.ready);
  const open = async (sealed: string) => {
    const d = new Decrypter();
    d.addIdentity(identity);
    return JSON.parse(await d.decrypt(armor.decode(sealed), 'text')) as unknown;
  };
  return { node, open };
}

async function setUp(fills?: ('browser' | 'phone')[]) {
  const c = await vaultCompany();
  await c.add(c.ceoSession, { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: CODE });
  await c.add(c.ceoSession, { name: 'Sales only', site: 'https://crm.example', login: 'sales@acme.test', password: 'pw-sales-1234', scope: { kind: 'department', departmentId: c.sales.id } });
  await c.add(c.ceoSession, { name: 'Nora only', site: 'https://nora.example', login: 'nora@acme.test', password: 'pw-nora-1234', scope: { kind: 'agent', agentId: c.nora.id } });
  const n = await withNode(c, fills);
  return { ...c, ...n };
}

const call = async (c: { app: Parameters<typeof mcp>[0] }, token: string, name: string, args: Record<string, unknown> = {}) =>
  (await (await mcp(c.app, token)).callTool({ name, arguments: args })) as ToolReply;

/* The node answers the next fill as given, after checking what it got. */
async function answerFill(node: FakeNode, reply: Record<string, unknown>) {
  const fill = await nextOf(node, 'secret.fill');
  node.send({ type: 'secret.filled', requestId: fill.requestId, ...reply } as never);
  return fill;
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

  it('has the node of the turn type an entry in its browser, sealed to that node alone, and logs who, when and for which task', async () => {
    const c = await setUp();
    const { token, job } = await c.startTurn(c.nora.id, c.task.id);
    const pending = call(c, token, 'vault_fill', { entry: 'partner site', target: 'browser' });
    const fill = await answerFill(c.node, { status: 'signed_in', filled: ['login', 'password', 'code'], shot: 'iVBORw0KGgo=' });
    const reply = await pending;
    expect(fill).toMatchObject({ jobId: job.id, fields: ['login', 'password', 'code'], target: { kind: 'browser', address: 'https://partner.example/login' } });
    expect(JSON.stringify(fill)).not.toContain(PASSWORD);
    expect(JSON.stringify(fill)).not.toContain(CODE);
    expect(await c.open(fill.sealed)).toEqual({ login: 'team@acme.test', password: PASSWORD, totp: { secret: CODE, digits: 6, period: 30, algorithm: 'SHA1' } });
    expect(Date.parse(fill.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    expect(reply.isError).toBeUndefined();
    expect(JSON.parse(textOf(reply))).toEqual({ entry: 'Partner site', target: 'browser', status: 'signed_in', filled: ['login', 'password', 'code'], savedSignIn: false });
    expect(reply.content[1]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
    const [use] = await c.db.select().from(vaultLog).where(eq(vaultLog.kind, 'used'));
    expect(use).toMatchObject({ agentId: c.nora.id, jobId: job.id, taskId: c.task.id, target: 'browser', fields: ['login', 'password', 'code'], status: 'signed_in' });
    expect(use!.endedAt).not.toBeNull();
  });

  it('hands a sign-in the browser got to the saved sign-ins of the agent', async () => {
    const c = await setUp();
    const saved: unknown[] = [];
    useSessionStore(c.app.ctx, async (_ctx, input) => (saved.push(input), true));
    const { token } = await c.startTurn(c.nora.id);
    const session = { cookies: [{ name: 'sid', value: 'cookie-value-123456', domain: 'partner.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
    const pending = call(c, token, 'vault_fill', { entry: 'Partner site', target: 'browser', fields: ['login', 'password'] });
    await answerFill(c.node, { status: 'signed_in', filled: ['login', 'password'], session });
    const reply = JSON.parse(textOf(await pending));
    expect(reply).toMatchObject({ status: 'signed_in', savedSignIn: true });
    expect(JSON.stringify(reply)).not.toContain('cookie-value-123456');
    expect(saved).toEqual([{ companyId: c.companyId, agentId: c.nora.id, site: 'https://partner.example', session }]);
  });

  it('refuses an entry kept for others or of another company, and sends nothing to the node', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id);
    const sales = await call(c, token, 'vault_fill', { entry: 'Sales only', target: 'browser' });
    expect(sales.isError).toBe(true);
    expect(JSON.parse(textOf(sales))).toMatchObject({ error: { code: 'forbidden' } });
    const [foreign] = await c.db
      .insert((await import('../src/db/schema.js')).vaultEntries)
      .values({ companyId: c.other.id, name: 'Theirs', site: 'https://other.example', login: 'o', passwordEnc: 'x', createdBy: c.olaf.id, updatedBy: c.olaf.id })
      .returning();
    const byId = await call(c, token, 'vault_fill', { entry: foreign!.id, target: 'browser' });
    expect(byId.isError).toBe(true);
    expect(JSON.parse(textOf(byId))).toMatchObject({ error: { code: 'forbidden' } });
    const otherTurn = await call(c, token, 'vault_fill', { entry: 'Theirs', target: 'browser' });
    expect(JSON.parse(textOf(otherTurn))).toMatchObject({ error: { code: 'not_found' } });
    expect(c.node.queued()).toBe(0);
    expect(await c.db.select().from(vaultLog).where(eq(vaultLog.kind, 'used'))).toEqual([]);
  });

  it('answers unsupported from a node that fills no browser, and no_answer when the node keeps silent', async () => {
    const c = await setUp(['phone']);
    const { token } = await c.startTurn(c.nora.id);
    expect(JSON.parse(textOf(await call(c, token, 'vault_fill', { entry: 'Partner site', target: 'browser' })))).toMatchObject({ status: 'unsupported' });
    expect(c.node.queued()).toBe(0);

    const d = await setUp();
    let elapse!: () => void;
    useFillTimer(d.app.ctx, () => new Promise<void>(resolve => (elapse = resolve)));
    const turn = await d.startTurn(d.nora.id);
    const pending = call(d, turn.token, 'vault_fill', { entry: 'Partner site', target: 'browser' });
    const fill = await nextOf(d.node, 'secret.fill');
    elapse();
    expect(JSON.parse(textOf(await pending))).toMatchObject({ status: 'no_answer' });
    /* A late answer finds nothing to settle. */
    d.node.send({ type: 'secret.filled', requestId: fill.requestId, status: 'filled', filled: ['password'] });
    const [use] = await d.db.select().from(vaultLog).where(eq(vaultLog.kind, 'used'));
    expect(use!.status).toBe('no_answer');
  });

  it('types into the phone session the agent holds, on the phone node, and refuses another company\'s session', async () => {
    const c = await setUp(['phone']);
    const session = '20000000-0000-4000-8000-000000000001';
    usePhoneTargets(c.app.ctx, async (_ctx, agent, id) => {
      if (id !== session) throw new ApiError(403, 'forbidden', 'This phone session is not of your company.', 'vault_not_allowed');
      expect(agent.id).toBe(c.nora.id);
      return { node: builtinOf(ownMachine(c.config)), generation: 7 };
    });
    const { token } = await c.startTurn(c.nora.id);
    const pending = call(c, token, 'vault_fill', { entry: 'Partner site', target: 'phone', phoneSession: session, element: 'node-12', fields: ['password'] });
    const fill = await answerFill(c.node, { status: 'filled', filled: ['password'] });
    expect(fill.target).toEqual({ kind: 'phone', phoneSessionId: session, generation: 7, element: 'node-12' });
    expect(fill.fields).toEqual(['password']);
    expect(JSON.parse(textOf(await pending))).toEqual({ entry: 'Partner site', target: 'phone', status: 'filled', filled: ['password'] });
    const foreign = await call(c, token, 'vault_fill', { entry: 'Partner site', target: 'phone', phoneSession: '20000000-0000-4000-8000-000000000002', fields: ['password'] });
    expect(JSON.parse(textOf(foreign))).toMatchObject({ error: { code: 'forbidden' } });
    const noField = await call(c, token, 'vault_fill', { entry: 'Partner site', target: 'phone', phoneSession: session });
    expect(noField.isError).toBe(true);
  });

  it('takes the answer of the node a fill went to, never of another node', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id);
    let elapse!: () => void;
    useFillTimer(c.app.ctx, () => new Promise<void>(resolve => (elapse = resolve)));
    const pending = call(c, token, 'vault_fill', { entry: 'Partner site', target: 'browser' });
    const fill = await nextOf(c.node, 'secret.fill');
    const stranger = await connectNode(c.wsUrl, 'unknown-node-key-0123456789abcdef').catch(() => null);
    stranger?.send({ type: 'secret.filled', requestId: fill.requestId, status: 'signed_in', filled: ['login'] });
    elapse();
    expect(JSON.parse(textOf(await pending))).toMatchObject({ status: 'no_answer' });
  });
});
