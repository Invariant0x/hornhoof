import { describe, expect, it } from 'vitest';
import { BROWSED_SHOT_MAX, parseNodeMessage, parseServerMessage, SignedInPlain } from '../src/index.js';

const REQUEST = '10000000-0000-4000-8000-000000000001';
const JOB = '10000000-0000-4000-8000-000000000003';

const browse = (over: Record<string, unknown> = {}) => ({
  type: 'signin.browse',
  requestId: REQUEST,
  jobId: JOB,
  sealed: '-----BEGIN AGE ENCRYPTED FILE-----\nabc\n-----END AGE ENCRYPTED FILE-----\n',
  address: 'https://partner.example/account',
  fullPage: false,
  waitFor: null,
  screenshot: true,
  limits: { timeoutMs: 30_000, maxText: 20_000, maxLinks: 100, maxBytes: 20 * 1024 * 1024 },
  expiresAt: '2030-01-01T00:01:00.000Z',
  ...over,
});

const page = (over: Record<string, unknown> = {}) => ({
  status: 'ok', reason: null, address: 'https://partner.example/account', finalAddress: 'https://partner.example/account', httpStatus: 200,
  title: 'Account', text: 'Signed in as Nora', textLength: 17, links: [{ text: 'Home', url: 'https://partner.example/' }], linkCount: 1, notes: [],
  ...over,
});

const browsed = (over: Record<string, unknown> = {}) => ({ type: 'signin.browsed', requestId: REQUEST, page: page(), ...over });

describe('signed-in browse messages', () => {
  it('carries a page to open with a saved sign-in from the server to a node, and the page read back', () => {
    expect(parseServerMessage(JSON.stringify(browse()))).toEqual(browse());
    expect(parseNodeMessage(JSON.stringify(browsed()))).toEqual(browsed());
    const shot = browsed({ shot: 'iVBORw0KGgo=' });
    expect(parseNodeMessage(JSON.stringify(shot))).toEqual(shot);
    const failed = { type: 'signin.browsed', requestId: REQUEST, page: null, failure: 'expired' };
    expect(parseNodeMessage(JSON.stringify(failed))).toEqual(failed);
  });

  it('opens only a web address, within the limits hh-browse has', () => {
    expect(parseServerMessage(JSON.stringify(browse({ address: 'file:///etc/passwd' })))).toBeNull();
    expect(parseServerMessage(JSON.stringify(browse({ limits: { timeoutMs: 600_000, maxText: 20_000, maxLinks: 100, maxBytes: 1 } })))).toBeNull();
    expect(parseServerMessage(JSON.stringify(browse({ extra: 1 })))).toBeNull();
  });

  it('refuses a picture larger than a frame carries and a page status hh-browse does not know', () => {
    expect(parseNodeMessage(JSON.stringify(browsed({ shot: 'A'.repeat(BROWSED_SHOT_MAX + 4) })))).toBeNull();
    expect(parseNodeMessage(JSON.stringify(browsed({ page: page({ status: 'signed_in' }) })))).toBeNull();
  });

  it('holds a session and the user agent it was made in once the node opens it', () => {
    const plain = { session: { cookies: [], origins: [] }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0' };
    expect(SignedInPlain.parse(plain)).toEqual(plain);
    expect(() => SignedInPlain.parse({ ...plain, password: 'x' })).toThrow();
  });

  it('tells in its hello that a node opens pages with a saved sign-in', () => {
    const hello = { type: 'hello', version: '0.31.0', loggedIn: true, running: [], signedInBrowse: true };
    expect(parseNodeMessage(JSON.stringify(hello))).toMatchObject({ signedInBrowse: true });
  });
});
