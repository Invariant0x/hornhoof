import type { SiteSession } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { servesPage } from '../src/modules/sign-ins/store.js';

/* Which pages a saved sign-in opens: those a browser would send one of its cookies to, or whose own origin keeps its
   stored values. A host beside the sign-in's, as another person's page on a site that gives each its own, gets nothing. */

const cookie = (domain: string) => ({ name: 'sid', value: 'v', domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const });
const session = (domains: string[], origins: string[] = []): SiteSession => ({ cookies: domains.map(cookie), origins: origins.map(origin => ({ origin, localStorage: [{ name: 'token', value: 'v' }] })) });

describe('the pages a saved sign-in serves', () => {
  it('serves the hosts its cookies go to, as a browser sends them', () => {
    const s = session(['.partner.example']);
    expect(servesPage('https://accounts.partner.example', s, 'https://www.partner.example/account')).toBe(true);
    expect(servesPage('https://accounts.partner.example', s, 'https://partner.example/')).toBe(true);
    expect(servesPage('https://accounts.partner.example', s, 'https://elsewhere.example/')).toBe(false);
  });

  it("never serves a host beside its own, where none of its cookies would go", () => {
    const s = session(['www.artstation.com']);
    expect(servesPage('https://www.artstation.com', s, 'https://www.artstation.com/my')).toBe(true);
    expect(servesPage('https://www.artstation.com', s, 'https://someone.artstation.com/')).toBe(false);
    expect(servesPage('https://www.artstation.com', s, 'https://artstation.com.evil.example/')).toBe(false);
  });

  it('serves the origins its stored values are of, and nothing else without a cookie', () => {
    const s = session([], ['https://app.partner.example']);
    expect(servesPage('https://app.partner.example', s, 'https://app.partner.example/board')).toBe(true);
    expect(servesPage('https://app.partner.example', s, 'https://www.partner.example/')).toBe(false);
    expect(servesPage('https://app.partner.example', s, 'https://partner.example/')).toBe(false);
    expect(servesPage('https://app.partner.example', s, 'not an address')).toBe(false);
  });

  it('never serves a page a step down from https', () => {
    expect(servesPage('https://www.partner.example', session(['.partner.example']), 'http://www.partner.example/account')).toBe(false);
    expect(servesPage('http://intranet.example', session(['intranet.example']), 'http://intranet.example/')).toBe(true);
  });
});
