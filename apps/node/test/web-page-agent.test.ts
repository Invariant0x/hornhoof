import { describe, expect, it } from 'vitest';
import { browseAsAgent, type AgentBrowseDeps } from '../src/web-page/agent.js';
import type { BrowseRequest } from '../src/web-page/browse.js';
import type { BrowseResult } from '../src/web-page/read.js';

/* hh-browse in an agent's turn: it asks Hornhoof first whether a sign-in is saved for the page's site. With one, the node
   reads the page and hh-browse prints what it got; with none, hh-browse reads the page itself as before. The answers of
   Hornhoof here are recorded ones. */

const LIMITS = { timeoutMs: 30_000, maxText: 20_000, maxLinks: 100, maxBytes: 20 * 1024 * 1024 };
const asked = (more: Partial<BrowseRequest> = {}): BrowseRequest => ({ address: 'https://www.partner.example/account', screenshot: null, fullPage: false, waitFor: null, limits: LIMITS, ...more });
const local: BrowseResult = {
  status: 'login_required', reason: 'The page asks to sign in.', address: 'https://www.partner.example/account', finalAddress: 'https://www.partner.example/login', httpStatus: 200,
  title: 'Sign in', text: 'Sign in', textLength: 7, links: [], linkCount: 0, screenshot: null, notes: [],
};
const page = { status: 'ok', reason: null, address: 'https://www.partner.example/account', finalAddress: 'https://www.partner.example/account', httpStatus: 200, title: 'Account', text: 'Signed in as Nora', textLength: 17, links: [], linkCount: 0, notes: [] };

function setUp(answer: { status?: number; body?: unknown; throws?: boolean } = {}, env: { url?: string; pass?: string } = { url: 'http://hornhoof.test/api/attachments', pass: 'tok-turn-1' }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const read: BrowseRequest[] = [];
  const written = new Map<string, Buffer>();
  const deps: AgentBrowseDeps = {
    url: env.url,
    pass: env.pass,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (answer.throws) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(answer.body ?? { kind: 'none' }), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
    },
    local: async request => (read.push(request), local),
    writeFile: (path, bytes) => void written.set(path, bytes),
  };
  return { deps, calls, read, written };
}

describe('hh-browse asking for a saved sign-in in a turn', () => {
  it('reads the page itself outside a turn, asking nobody', async () => {
    const { deps, calls, read } = setUp({}, {});
    expect(await browseAsAgent(asked(), deps)).toBe(local);
    expect(calls).toEqual([]);
    expect(read).toHaveLength(1);
  });

  it("asks Hornhoof with the turn's token, and reads the page itself where no sign-in is saved", async () => {
    const { deps, calls, read } = setUp({ body: { kind: 'none' } });
    expect(await browseAsAgent(asked({ screenshot: '/work/account.png' }), deps)).toBe(local);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://hornhoof.test/api/attachments/browse');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer tok-turn-1', 'content-type': 'application/json' } });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ address: 'https://www.partner.example/account', screenshot: true, fullPage: false, waitFor: null, limits: LIMITS });
    expect(read).toHaveLength(1);
  });

  it('prints the page the node read with the saved sign-in, and saves its picture where it was asked', async () => {
    const { deps, read, written } = setUp({ body: { kind: 'browsed', site: 'https://accounts.partner.example', page, shot: Buffer.from('PNG of the account').toString('base64') } });
    const result = await browseAsAgent(asked({ screenshot: '/work/account.png' }), deps);
    expect(read).toEqual([]);
    expect(result).toMatchObject({ ...page, screenshot: '/work/account.png', notes: ['The page was opened with the sign-in saved for you for https://accounts.partner.example.'] });
    expect(written.get('/work/account.png')?.toString()).toBe('PNG of the account');
  });

  it('says plainly that the saved sign-in expired, so a person signs in again, without reading the page', async () => {
    const { deps, read } = setUp({ body: { kind: 'expired', site: 'https://accounts.partner.example', savedAt: '2030-01-01T00:00:00.000Z' } });
    const result = await browseAsAgent(asked(), deps);
    expect(read).toEqual([]);
    expect(result).toMatchObject({ status: 'login_required', reason: 'The sign-in saved for you for https://accounts.partner.example has expired. A person needs to sign you in again.', address: 'https://www.partner.example/account', text: null });
  });

  it('reads the page without the sign-in when it cannot be used now, and says why', async () => {
    const { deps, read } = setUp({ body: { kind: 'unavailable', site: 'https://accounts.partner.example', reason: 'node_offline' } });
    const result = await browseAsAgent(asked(), deps);
    expect(read).toHaveLength(1);
    expect(result.status).toBe('login_required');
    expect(result.notes).toEqual(['The sign-in saved for you for https://accounts.partner.example could not be used, as the machine of your turn is not connected; the page was read without it.']);
  });

  it('reads the page itself when Hornhoof cannot be asked, and says so', async () => {
    for (const answer of [{ throws: true }, { status: 503, body: { error: { message: 'Try again.' } } }]) {
      const { deps, read } = setUp(answer);
      const result = await browseAsAgent(asked(), deps);
      expect(read, JSON.stringify(answer)).toHaveLength(1);
      expect(result.notes, JSON.stringify(answer)).toEqual(['Hornhoof could not be asked for a sign-in saved for you, so the page was read without one.']);
    }
  });
});
