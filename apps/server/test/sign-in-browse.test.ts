import { Decrypter, armor, generateX25519Identity, identityToRecipient } from 'age-encryption';
import type { SiteSession } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { useBrowseTimer } from '../src/modules/sign-ins/browse.js';
import { keepSignIn } from '../src/modules/sign-ins/store.js';
import { as, connectNode, nextOf, until, type FakeNode } from './helpers.js';
import { NODE_KEY, vaultCompany } from './vault-fixture.js';

/* hh-browse of an employee opening a page with the sign-in saved for it: Hornhoof seals the sign-in to the node of the
   employee's turn, the node reads the page, and hh-browse gets only what the page shows. */

const COOKIE = 'cookie-marker-91e4c07d3b';
const LIMITS = { timeoutMs: 30_000, maxText: 20_000, maxLinks: 100, maxBytes: 20 * 1024 * 1024 };
const UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0';
const session = (expires = -1): SiteSession => ({
  cookies: [{ name: 'sid', value: COOKIE, domain: '.partner.example', path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [],
});
const page = { status: 'ok', reason: null, address: 'https://www.partner.example/account', finalAddress: 'https://www.partner.example/account', httpStatus: 200, title: 'Account', text: 'Signed in as Nora', textLength: 17, links: [], linkCount: 0, notes: [] };

async function setUp(hello: Record<string, unknown> = { signedInBrowse: true }) {
  const c = await vaultCompany();
  const identity = await generateX25519Identity();
  const node = await connectNode(c.wsUrl, NODE_KEY);
  node.send({ type: 'hello', version: '0.31.0', loggedIn: true, running: [], publicKey: await identityToRecipient(identity), ...hello });
  await until(async () => (await c.app.inject({ url: '/api/agents/orchestrator/events', ...as(c.ceoSession) })).json().state.ready);
  const open = async (sealed: string) => {
    const d = new Decrypter();
    d.addIdentity(identity);
    return JSON.parse(await d.decrypt(armor.decode(sealed), 'text')) as unknown;
  };
  const keep = (agentId: string, kept = session()) =>
    keepSignIn(c.app.ctx, { companyId: c.companyId, agentId, site: 'https://accounts.partner.example', session: kept, source: 'person', savedBy: c.clara.id, userAgent: UA });
  const ask = (token: string, address = 'https://www.partner.example/account') =>
    c.app.inject({ method: 'POST', url: '/api/attachments/browse', headers: { authorization: `Bearer ${token}` }, payload: { address, screenshot: true, fullPage: false, waitFor: null, limits: LIMITS } });
  return { ...c, node, open, keep, ask };
}

/* Whether the node got a message of that type by the time a request had its answer: what it got waits in its queue. */
async function got(node: FakeNode, type: string): Promise<boolean> {
  const types: string[] = [];
  while (node.queued() > 0) types.push((await node.next()).type);
  return types.includes(type);
}

describe("a page hh-browse opens with the employee's saved sign-in", () => {
  it('seals the sign-in of the site to the node of the turn, which reads the page, and answers with the page only', async () => {
    const c = await setUp();
    await c.keep(c.nora.id);
    const { token, job } = await c.startTurn(c.nora.id);
    const pending = c.ask(token);
    const browse = await nextOf(c.node, 'signin.browse');
    expect(browse).toMatchObject({ jobId: job.id, address: 'https://www.partner.example/account', screenshot: true, fullPage: false, waitFor: null, limits: LIMITS });
    expect(browse.sealed).not.toContain(COOKIE);
    expect(await c.open(browse.sealed)).toEqual({ session: session(), userAgent: UA });
    c.node.send({ type: 'signin.browsed', requestId: browse.requestId, page, shot: 'iVBORw0KGgo=' } as never);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'browsed', site: 'https://accounts.partner.example', page, shot: 'iVBORw0KGgo=' });
    expect(res.body).not.toContain(COOKIE);
  });

  it("answers none where the employee has no sign-in, and never opens a page with another employee's", async () => {
    const c = await setUp();
    await c.keep(c.nora.id);
    const { token } = await c.startTurn(c.sammy.id);
    const res = await c.ask(token);
    expect(res.json()).toEqual({ kind: 'none' });
    expect(res.body).not.toContain(COOKIE);
    expect(await got(c.node, 'signin.browse')).toBe(false);
    const other = await c.ask((await c.startTurn(c.nora.id)).token, 'https://elsewhere.example/');
    expect(other.json()).toEqual({ kind: 'none' });
  });

  it('tells a sign-in whose cookies all expired, without opening any page', async () => {
    const c = await setUp();
    await c.keep(c.nora.id, session(1_000_000));
    const res = await c.ask((await c.startTurn(c.nora.id)).token);
    expect(res.json()).toMatchObject({ kind: 'expired', site: 'https://accounts.partner.example' });
    expect(await got(c.node, 'signin.browse')).toBe(false);
  });

  it('says the sign-in could not be used on a node that does not open such pages, or that does not answer', async () => {
    const old = await setUp({});
    await old.keep(old.nora.id);
    expect((await old.ask((await old.startTurn(old.nora.id)).token)).json()).toEqual({ kind: 'unavailable', site: 'https://accounts.partner.example', reason: 'unsupported' });
    expect(await got(old.node, 'signin.browse')).toBe(false);

    const silent = await setUp();
    await silent.keep(silent.nora.id);
    useBrowseTimer(silent.app.ctx, () => Promise.resolve());
    const res = await silent.ask((await silent.startTurn(silent.nora.id)).token);
    expect(res.json()).toEqual({ kind: 'unavailable', site: 'https://accounts.partner.example', reason: 'no_answer' });
  });

  it('takes the answer of the node the page went to, and refuses a call with no turn', async () => {
    const c = await setUp();
    await c.keep(c.nora.id);
    expect((await c.app.inject({ method: 'POST', url: '/api/attachments/browse', payload: { address: 'https://www.partner.example/' } })).statusCode).toBe(401);
    const { token } = await c.startTurn(c.nora.id);
    expect((await c.app.inject({ method: 'POST', url: '/api/attachments/browse', headers: { authorization: `Bearer ${token}` }, payload: { address: 'ftp://partner.example/' } })).statusCode).toBe(400);
    const pending = c.ask(token);
    const browse = await nextOf(c.node, 'signin.browse');
    const stranger = await connectNode(c.wsUrl, 'unknown-node-key-0123456789abcdef').catch(() => null);
    stranger?.send({ type: 'signin.browsed', requestId: browse.requestId, page: { ...page, text: 'forged' } } as never);
    c.node.send({ type: 'signin.browsed', requestId: browse.requestId, page } as never);
    expect((await pending).json()).toMatchObject({ kind: 'browsed', page: { text: 'Signed in as Nora' } });
  });
});
