import type { SignedInBrowse, SignedInBrowsed, SignedInPlain } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import type { BrowseRequest } from '../src/web-page/browse.js';
import type { BrowseResult } from '../src/web-page/read.js';
import { openSignedIn, type SignedInDeps } from '../src/web-page/signed-in.js';

/* A page an agent's hh-browse opens with its saved sign-in, in the node's own process: the node opens what Hornhoof
   sealed to it, hides every value of the sign-in, reads the page and answers with what it shows. */

const COOKIE = 'cookie-marker-7c41d09be2';
const STORED = 'stored-marker-3a9f2e61c8';
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const plain: SignedInPlain = {
  session: {
    cookies: [
      { name: 'sid', value: COOKIE, domain: '.partner.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'theme', value: 'dark', domain: 'partner.example', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' },
    ],
    origins: [{ origin: 'https://partner.example', localStorage: [{ name: 'token', value: STORED }] }],
  },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
};

const message = (over: Partial<SignedInBrowse> = {}): SignedInBrowse => ({
  type: 'signin.browse',
  requestId: '10000000-0000-4000-8000-000000000001',
  jobId: '10000000-0000-4000-8000-000000000002',
  sealed: 'sealed-for-this-node',
  address: 'https://partner.example/account',
  fullPage: false,
  waitFor: null,
  screenshot: true,
  limits: { timeoutMs: 30_000, maxText: 20_000, maxLinks: 100, maxBytes: 20 * 1024 * 1024 },
  expiresAt: '2030-01-01T00:01:00.000Z',
  ...over,
});

const page = (over: Partial<BrowseResult> = {}): BrowseResult => ({
  status: 'ok', reason: null, address: 'https://partner.example/account', finalAddress: 'https://partner.example/account', httpStatus: 200,
  title: 'Account', text: `Signed in as Nora. Debug: ${COOKIE} ${STORED} dark`, textLength: 60, links: [{ text: 'Me', url: `https://partner.example/me?t=${STORED}` }], linkCount: 1,
  screenshot: null, notes: [],
  ...over,
});

function setUp(o: { opened?: unknown; result?: BrowseResult; shot?: Buffer | null; fails?: boolean } = {}) {
  const sent: SignedInBrowsed[] = [];
  const hidden: string[] = [];
  const asked: BrowseRequest[] = [];
  const deps: SignedInDeps = {
    open: async sealed => {
      if (sealed !== 'sealed-for-this-node') throw new Error('no identity matched');
      return new TextEncoder().encode(JSON.stringify(o.opened ?? plain));
    },
    hide: values => void hidden.push(...values),
    send: m => void sent.push(m),
    browse: async request => {
      asked.push(request);
      if (o.fails) throw new Error('browser crashed');
      return { result: o.result ?? page(), shot: o.shot === undefined ? Buffer.from('PNG of the account') : o.shot };
    },
    now: () => NOW,
  };
  return { deps, sent, hidden, asked };
}

describe('a page opened with a saved sign-in on the node', () => {
  it('opens the sign-in, hides its values before anything, reads the page with it and answers with no value in it', async () => {
    const { deps, sent, hidden, asked } = setUp();
    await openSignedIn(message(), deps);
    expect(hidden).toEqual([COOKIE, STORED]);
    expect(asked).toEqual([{ address: 'https://partner.example/account', screenshot: true, fullPage: false, waitFor: null, limits: message().limits, signIn: plain }]);
    expect(sent).toHaveLength(1);
    const [answer] = sent;
    expect(answer).toMatchObject({ type: 'signin.browsed', requestId: message().requestId, shot: Buffer.from('PNG of the account').toString('base64') });
    expect(answer!.page).toMatchObject({ status: 'ok', title: 'Account', text: 'Signed in as Nora. Debug: [hidden] [hidden] dark' });
    expect(JSON.stringify(answer)).not.toContain(COOKIE);
    expect(JSON.stringify(answer)).not.toContain(STORED);
    expect(answer!.page).not.toHaveProperty('screenshot');
  });

  it('says plainly when the saved sign-in did not get past the sign-in, so a person signs in again', async () => {
    const { deps, sent } = setUp({ result: page({ status: 'login_required', reason: 'The page asks to sign in.', text: 'Sign in', textLength: 7, links: [], linkCount: 0 }) });
    await openSignedIn(message(), deps);
    expect(sent[0]!.page).toMatchObject({ status: 'login_required', reason: 'The page asks to sign in.' });
    expect(sent[0]!.page!.notes).toContain('The sign-in saved for you did not get past the sign-in of this site: it has expired, or the site ended it. A person needs to sign you in again.');
  });

  it('starts nothing for a request that came too late, or a sign-in sealed to another node', async () => {
    const late = setUp();
    await openSignedIn(message({ expiresAt: '2029-12-31T23:59:59.000Z' }), late.deps);
    expect(late.sent).toEqual([{ type: 'signin.browsed', requestId: message().requestId, page: null, failure: 'expired' }]);
    expect(late.asked).toEqual([]);

    const foreign = setUp();
    await openSignedIn(message({ sealed: 'sealed-for-another-node' }), foreign.deps);
    expect(foreign.sent).toEqual([{ type: 'signin.browsed', requestId: message().requestId, page: null, failure: 'unopened' }]);
    expect(foreign.asked).toEqual([]);

    const strange = setUp({ opened: { ...plain, password: 'pw' } });
    await openSignedIn(message(), strange.deps);
    expect(strange.sent[0]).toMatchObject({ page: null, failure: 'unopened' });
    expect(strange.asked).toEqual([]);
  });

  it('answers failed, with no words of the browser, when the page could not be read at all', async () => {
    const { deps, sent } = setUp({ fails: true });
    await openSignedIn(message(), deps);
    expect(sent).toEqual([{ type: 'signin.browsed', requestId: message().requestId, page: null, failure: 'failed' }]);
  });

  it('leaves out a picture larger than one answer carries, and says so', async () => {
    const { deps, sent } = setUp({ shot: Buffer.alloc(2_000_000, 1) });
    await openSignedIn(message(), deps);
    expect(sent[0]).not.toHaveProperty('shot');
    expect(sent[0]!.page!.notes).toContain('The screenshot was too large to send and was left out; --full-page off makes it smaller.');
  });
});
