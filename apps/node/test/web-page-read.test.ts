import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PageSample } from '../src/web-page/collect.js';
import { exitCode, formatResult, judgePage, type BrowseResult } from '../src/web-page/read.js';

/* What collectPage returned in Chromium (headless shell 156) for the pages beside each sample, served from a local stand with
   every other request blocked; the stand's address was written as https://shop.example. */
const sample = (name: string): PageSample => JSON.parse(readFileSync(new URL(`./fixtures/web-pages/${name}.json`, import.meta.url), 'utf8')) as PageSample;
const ok = { status: 200, headers: { 'content-type': 'text/html' } };

describe('what hh-browse makes of a page', () => {
  it('reads an ordinary page and a page its scripts built as ok', () => {
    expect(judgePage({ requested: 'https://shop.example/article', finalUrl: 'https://shop.example/article', answer: ok, sample: sample('article') })).toEqual({ status: 'ok', reason: null, notes: [] });
    expect(judgePage({ requested: 'https://shop.example/catalogue', finalUrl: 'https://shop.example/catalogue', answer: ok, sample: sample('rendered') })).toEqual({ status: 'ok', reason: null, notes: [] });
  });

  it('says a sign-in is needed for a sign-in form, a redirect to a sign-in address and an answer 401', () => {
    expect(judgePage({ requested: 'https://shop.example/portal/login', finalUrl: 'https://shop.example/portal/login', answer: ok, sample: sample('sign-in') }).status).toBe('login_required');
    const redirected = { ...sample('article'), passwordFields: 0, title: 'Partner portal', text: 'Continue with your work email', textLength: 29, links: [], linkCount: 0 };
    expect(judgePage({ requested: 'https://shop.example/partners/reports', finalUrl: 'https://shop.example/users/sign_in?next=%2Fpartners%2Freports', answer: ok, sample: redirected }).status).toBe('login_required');
    const denied = judgePage({ requested: 'https://shop.example/api', finalUrl: 'https://shop.example/api', answer: { status: 401, headers: { 'www-authenticate': 'Basic realm="shop"' } }, sample: sample('not-found') });
    expect(denied).toMatchObject({ status: 'login_required', reason: expect.stringMatching(/401/) });
  });

  it('says a robot check stands in the way for a challenge page, a captcha gate, a challenge header and an answer 429', () => {
    const challenge = judgePage({ requested: 'https://shop.example/challenge', finalUrl: 'https://shop.example/challenge', answer: { status: 403, headers: { server: 'cloudflare' } }, sample: sample('challenge') });
    expect(challenge.status).toBe('robot_check');
    expect(judgePage({ requested: 'https://shop.example/check', finalUrl: 'https://shop.example/check', answer: ok, sample: sample('captcha-gate') }).status).toBe('robot_check');
    expect(judgePage({ requested: 'https://shop.example/', finalUrl: 'https://shop.example/', answer: { status: 403, headers: { 'cf-mitigated': 'challenge' } }, sample: sample('article') }).status).toBe('robot_check');
    expect(judgePage({ requested: 'https://shop.example/', finalUrl: 'https://shop.example/', answer: { status: 429, headers: {} }, sample: sample('article') })).toMatchObject({ status: 'robot_check', reason: expect.stringMatching(/429|too many/i) });
  });

  it('reads a long page whose form carries a robot check widget, and notes the widget', () => {
    const judged = judgePage({ requested: 'https://shop.example/contact', finalUrl: 'https://shop.example/contact', answer: ok, sample: sample('form-with-recaptcha') });
    expect(judged.status).toBe('ok');
    expect(judged.notes).toEqual([expect.stringMatching(/robot check widget/)]);
  });

  it('calls any other answer from 400 up an http error', () => {
    expect(judgePage({ requested: 'https://shop.example/missing', finalUrl: 'https://shop.example/missing', answer: { status: 404, headers: {} }, sample: sample('not-found') })).toEqual({ status: 'http_error', reason: 'The site answered 404.', notes: [] });
  });

  it('says a sign-in is needed on a sign-in address that names it, also for a long page with a password field there', () => {
    const page = { ...sample('article'), passwordFields: 0 };
    const at = (path: string, more: Partial<PageSample> = {}) => judgePage({ requested: `https://shop.example${path}`, finalUrl: `https://shop.example${path}`, answer: ok, sample: { ...page, ...more } }).status;
    expect(at('/login', { title: 'Log in to the shop' })).toBe('login_required');
    expect(at('/login', { text: `Sign in with your account. ${page.text}` })).toBe('login_required');
    const long = { text: 'Garden notes for small balconies. '.repeat(80), textLength: 2720 };
    expect(at('/login', { ...long, passwordFields: 1 })).toBe('login_required');
    expect(at('/login')).toBe('ok');
    expect(at('/articles/login-tips', { ...long, passwordFields: 1 })).toBe('ok');
    expect(judgePage({ requested: 'https://shop.example/', finalUrl: 'https://shop.example/', answer: { status: 407, headers: {} }, sample: page })).toMatchObject({ status: 'login_required', reason: expect.stringMatching(/407/) });
  });

  it('takes a short page that is little more than a robot check widget for a robot check, also with no answer at all', () => {
    const gate = { ...sample('article'), text: 'Please confirm.', textLength: 15, links: [], linkCount: 0, markers: ['.h-captcha'] };
    expect(judgePage({ requested: 'https://shop.example/', finalUrl: 'https://shop.example/', answer: null, sample: gate })).toMatchObject({ status: 'robot_check' });
    const framed = { ...gate, markers: [], frames: ['https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html'] };
    expect(judgePage({ requested: 'https://shop.example/', finalUrl: 'https://shop.example/', answer: null, sample: framed })).toMatchObject({ status: 'robot_check' });
    expect(judgePage({ requested: 'https://shop.example/', finalUrl: 'https://shop.example/', answer: null, sample: { ...sample('article'), title: 'Just a moment...' } }).status).toBe('robot_check');
  });

  it('prints where the page ended, its notes, links without words, links it holds back and the next step of each status', () => {
    const base: BrowseResult = {
      status: 'ok', reason: null, address: 'https://shop.example/', finalAddress: 'https://shop.example/home', httpStatus: null,
      title: null, text: 'Home', textLength: 4, links: [{ text: '', url: 'https://shop.example/logo' }], linkCount: 1, screenshot: null, notes: ['The page was still loading.'],
    };
    expect(formatResult(base)).toBe([
      'Status: ok', 'Address: https://shop.example/', 'Final address: https://shop.example/home', 'Note: The page was still loading.',
      '', 'Text (4 characters):', 'Home', '', 'Links (1):', '- https://shop.example/logo', '',
    ].join('\n'));
    expect(formatResult({ ...base, links: [], linkCount: 7 })).toContain('\nLinks: 7, none shown; --max-links shows them.\n');
    expect(formatResult({ ...base, links: [], linkCount: 0 })).toContain('\nLinks: none\n');
    expect(formatResult({ ...base, links: [{ text: 'Sets', url: 'https://shop.example/sets' }], linkCount: 5 })).toContain('\nLinks (1 of 5):\n- Sets: https://shop.example/sets\n');
    const refused = formatResult({ ...base, status: 'refused', reason: 'The address is refused: a loopback address.', finalAddress: null, text: null, links: [], linkCount: 0, notes: [] });
    expect(refused).toBe('Status: refused\nReason: The address is refused: a loopback address.\nAddress: https://shop.example/\nNext: This address stays refused: go on with the other addresses.\n');
    expect(formatResult({ ...base, status: 'failed', reason: 'The browser could not start.', text: null })).toMatch(/\nNext: Try the address once more[^\n]*for a person[^\n]*\n$/);
    expect(formatResult({ ...base, status: 'robot_check', reason: 'The page checks.', text: null })).toMatch(/\nNext: Never try to get past it/);
  });

  it('prints the page, its links and the next step a person needs, and exits 0 only when the page was reached', () => {
    const page = sample('rendered');
    const result: BrowseResult = {
      status: 'ok', reason: null, address: 'https://shop.example/catalogue', finalAddress: 'https://shop.example/catalogue', httpStatus: 200,
      title: page.title, text: page.text, textLength: page.textLength, links: page.links, linkCount: page.linkCount, screenshot: '/work/catalogue.png', notes: [],
    };
    const printed = formatResult(result);
    expect(printed).toMatch(/^Status: ok\n/);
    expect(printed).toContain('Title: Spring catalogue');
    expect(printed).toContain('Hand trowel costs 12 EUR');
    expect(printed).toContain('- Pruner: https://shop.example/items/2');
    expect(printed).toMatch(/Screenshot: \/work\/catalogue\.png[^\n]*hh-attach/);
    const login = formatResult({ ...result, status: 'login_required', reason: 'The page asks to sign in.', screenshot: null });
    expect(login).toMatch(/^Status: login_required\n/);
    /* A sign-in is the agent's own: it types the vault's sign-in in a real browser, as hh-browse signs in nowhere. */
    expect(login).toMatch(/\nNext: Sign in yourself, as a person does: take the site's sign-in with vault_entries and vault_entry[^\n]*real browser on your machine/);
    expect(login).toMatch(/code the site sends to a person's phone[^\n]*tell your head[^\n]*go on with the other addresses meanwhile/);
    expect(login).not.toMatch(/never try to get past|for a person in your report/i);
    const cut = formatResult({ ...result, text: 'a'.repeat(10), textLength: 50 });
    expect(cut).toMatch(/first 10 of 50 characters/);
    expect([exitCode('ok'), exitCode('login_required'), exitCode('robot_check'), exitCode('http_error'), exitCode('refused'), exitCode('failed')]).toEqual([0, 0, 0, 0, 2, 1]);
  });
});
