import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { SubView } from '../src/types';
import { serveApi } from './api';

/* 19.11: after the sign-in code, nothing on the plan's card changed while its program connected, and an Antigravity plan
   took so long that its owner could not tell whether it worked or hung. From the first step its node reports until the
   plan is ready, its card and its sign-in window show a turning ring, the step in plain words and the time since the code;
   then the ready card. A failure says why and what to do; past the one limit of the whole connection the owner can try
   again or stop. The machine's words come through a stand-in for the stream, and the page runs on the test's clock. */
test.describe.configure({ timeout: 180_000 });
const SHOTS = 'e2e/results/signin-progress-shots';
mkdirSync(SHOTS, { recursive: true });

const NODE = 'n-1';
const HOST = 'dev-laptop';
const MINUTE = 60_000;
const LIMIT = 10 * MINUTE;
const T0 = Date.parse('2026-11-19T22:00:00Z');
/* The code was entered a minute after the page's clock started. */
const CODE_AT = T0 + MINUTE;

type Provider = 'codex' | 'antigravity';
const NAMES: Record<Provider, string> = { codex: 'Codex', antigravity: 'Antigravity' };

const plan = (provider: Provider, status: 'needs_login' | 'ready'): SubView => ({
  id: `s-${provider}`, provider, kind: 'personal', label: NAMES[provider], last4: null, tier: null, status, online: true,
  owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, limits: null, limitsUpdatedAt: null,
  budget: null, fallbacks: [], isOrchestrator: false, accounts: [], accountsDiffer: false, signedInOnce: status === 'ready', leaseMachine: null, agents: [],
  machines: [{ id: 'm1', hostname: HOST, status, online: true }], api: null, models: [], target: null, connecting: null,
} as unknown as SubView);

type State = 'connecting' | 'failed' | 'too_long';
const connection = (step: string, state: State = 'connecting', more: { error?: string; line?: string } = {}) => ({
  nodeId: NODE, hostname: HOST, state, step, since: new Date(CODE_AT).toISOString(), until: new Date(CODE_AT + LIMIT).toISOString(),
  error: more.error ?? null, code: null, line: more.line ?? null,
});

type Look = { lang: 'en' | 'ru'; theme: 'cyberpunk' | 'light'; width: number };
const words = (look: { lang: 'en' | 'ru' }) => (look.lang === 'en' ? en : ru);

const pathOf = (url: URL | string) => new URL(url.toString()).pathname;

type Connection = ReturnType<typeof connection> | null;
/* connect: the machine's word of where the plan's connection is, as the stream says it and as the list then gives it. */
type Opened = { posted: string[]; plans: { now: SubView[] }; terminal: () => boolean; connect(provider: Provider, c: Connection): Promise<void> };

/* The page opens on the plans, with a stand-in for the stream that the test speaks into, as the machine's words would come,
   and one for the sign-in terminal. The page's clock is paused a minute after it started: the time since the code moves
   only when the test moves it. */
async function openPlans(page: Page, look: Look, list: SubView[]): Promise<Opened> {
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(CODE_AT);
  await page.setViewportSize({ width: look.width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    const streams: EventTarget[] = [];
    class Stream extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      constructor() { super(); streams.push(this); }
      close() { this.readyState = 2; }
    }
    Object.assign(window, { EventSource: Stream, hhSay: (data: string) => { for (const s of streams) s.dispatchEvent(new MessageEvent('message', { data })); } });
  }, look);
  await serveApi(page);
  const plans = { now: list };
  const posted: string[] = [];
  const connections = new Map<string, Connection>();
  await page.route(url => pathOf(url) === '/api/subscriptions', route => route.fulfill({ json: { subscriptions: plans.now.map(p => ({ ...p, connecting: connections.get(p.id) ?? null })) } }));
  await page.route(url => /^\/api\/subscriptions\/[^/]+\/(signin|connecting\/(cancel|retry))$/.test(pathOf(url)), route => {
    posted.push(pathOf(route.request().url()));
    /* A new sign-in, Try again and Stop each end what the plan's connection said, as the server does. */
    connections.delete(pathOf(route.request().url()).split('/')[3]!);
    return pathOf(route.request().url()).endsWith('/signin') ? route.fulfill({ json: { nodeId: NODE, hostname: HOST } }) : route.fulfill({ status: 204 });
  });
  let terminal = false;
  await page.routeWebSocket(url => pathOf(url).endsWith('/signin/terminal'), ws => {
    terminal = true;
    ws.onMessage(() => {});
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation').getByRole('button', { name: words(look).shell.tabs.subscriptions, exact: true }).click();
  const connect = async (provider: Provider, c: Connection) => {
    connections.set(`s-${provider}`, c);
    await say(page, { type: 'subscription.connecting', subscriptionId: `s-${provider}`, connecting: c, owner: 'p1' });
  };
  return { posted, plans, terminal: () => terminal, connect };
}

/* Moves the page's clock on. The plans screen reads its plans again on the way, every 5 s; that answer is in before the
   test says anything new, so it cannot put back an older step after a newer one. */
async function later(page: Page, ms: number) {
  const reread = page.waitForResponse(r => pathOf(r.url()) === '/api/subscriptions');
  await page.clock.fastForward(ms);
  await reread;
  await page.evaluate(() => new Promise(done => { const c = new MessageChannel(); c.port1.onmessage = () => done(null); c.port2.postMessage(0); }));
}

const say = (page: Page, m: object) => page.evaluate(data => (window as unknown as { hhSay(data: string): void }).hhSay(data), JSON.stringify(m));

/* The connection's part of the plan's card, by its name. */
const part = (page: Page, look: Look, provider: Provider) => page.getByRole('group', { name: words(look).subs.connection.label(NAMES[provider]), exact: true });

async function openCard(page: Page, look: Look, provider: Provider) {
  await page.getByRole('button', { name: words(look).tables.openCard(NAMES[provider]), exact: true }).click();
}

/* Nothing of the part is cut or runs off sideways, and the page does not scroll sideways. */
async function wholeInside(page: Page, shown: Locator, width: number) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const box = (await shown.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await shown.evaluate(el => [el, ...el.querySelectorAll('*')].every(e => e.scrollWidth <= e.clientWidth + 1))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/* The turning mark stands before the words, on their first line, not above them. */
async function expectBeside(mark: Locator, words: Locator) {
  const [m, w] = await Promise.all([mark.boundingBox(), words.boundingBox()]);
  expect(m!.x + m!.width).toBeLessThanOrEqual(w!.x);
  expect(m!.y + m!.height / 2).toBeGreaterThan(w!.y);
  expect(m!.y + m!.height / 2).toBeLessThan(w!.y + w!.height);
}

const EN: Look = { lang: 'en', theme: 'cyberpunk', width: 1440 };

test.describe('a plan connecting after its sign-in code', () => {
  test('Codex: the sign-in window, then the card, show the ring, the step its node reports and the time since the code, until the ready card', async ({ page }) => {
    const t = words(EN);
    const opened = await openPlans(page, EN, [plan('codex', 'needs_login')]);
    await openCard(page, EN, 'codex');
    await page.getByRole('button', { name: t.subs.signInLabel('Codex'), exact: true }).click();
    const window = page.locator('.signin');
    await expect(window.getByRole('heading', { name: t.subs.signingIn(HOST), exact: true })).toBeVisible();
    await expect.poll(opened.terminal).toBe(true);
    await expect(part(page, EN, 'codex')).toHaveCount(0);
    await opened.connect('codex', connection('checking'));
    const shown = window.getByRole('group', { name: t.subs.connection.label('Codex'), exact: true });
    await expect(shown.locator('.waiting-mark')).toBeVisible();
    await expectBeside(shown.locator('.waiting-mark'), shown.getByText(t.subs.connection.steps.checking, { exact: true }));
    await expect(shown.getByRole('status')).toContainText(t.subs.connection.steps.checking);
    await expect(shown.getByRole('status')).toContainText(t.subs.connection.passed(t.subs.connection.seconds(0)));
    await later(page, 65_000);
    await expect(shown.getByRole('status')).toContainText(t.subs.connection.passed(t.subs.connection.minutes(1, 5)));
    await opened.connect('codex', connection('saving'));
    await expect(shown.getByRole('status')).toContainText(t.subs.connection.steps.saving);
    /* The sign-in window closes once the sign-in is kept; the card goes on showing the connection. */
    await say(page, { type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: true, error: null, code: null, line: null, owner: 'p1' });
    await expect(window).toHaveCount(0);
    await opened.connect('codex', connection('models'));
    await expect(part(page, EN, 'codex').getByRole('status')).toContainText(t.subs.connection.steps.models);
    await expect(part(page, EN, 'codex').locator('.waiting-mark')).toBeVisible();
    opened.plans.now = [plan('codex', 'ready')];
    await opened.connect('codex', null);
    await expect(part(page, EN, 'codex')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: t.cards.aboutPlan, exact: true })).toBeVisible();
  });

  test('Antigravity: the card shows the steps of a sign-in in the install window, the time since the code, then the ready card', async ({ page }) => {
    const t = words(EN);
    const opened = await openPlans(page, EN, [plan('antigravity', 'needs_login')]);
    await openCard(page, EN, 'antigravity');
    await expect(part(page, EN, 'antigravity')).toHaveCount(0);
    await opened.connect('antigravity', connection('checking'));
    const shown = part(page, EN, 'antigravity');
    await expect(shown.locator('.waiting-mark')).toBeVisible();
    await expect(shown.getByRole('status')).toContainText(t.subs.connection.steps.checking);
    await later(page, 2 * MINUTE + 10_000);
    await opened.connect('antigravity', connection('signed_in'));
    await expect(shown.getByRole('status')).toContainText(t.subs.connection.steps.signed_in);
    await opened.connect('antigravity', connection('limits'));
    await expect(shown.getByRole('status')).toContainText(t.subs.connection.steps.limits);
    await expect(shown.getByRole('status')).toContainText(t.subs.connection.passed(t.subs.connection.minutes(2, 10)));
    opened.plans.now = [plan('antigravity', 'ready')];
    await opened.connect('antigravity', null);
    await expect(shown).toHaveCount(0);
    await expect(page.getByRole('heading', { name: t.cards.aboutPlan, exact: true })).toBeVisible();
  });

  test('Codex: a failed connection says why and what to do, with no ring, and Try again signs in again', async ({ page }) => {
    const t = words(EN);
    const opened = await openPlans(page, EN, [plan('codex', 'needs_login')]);
    await openCard(page, EN, 'codex');
    await opened.connect('codex', connection('checking', 'failed', { error: 'The program did not take the new sign-in, so nothing changed.' }));
    const shown = part(page, EN, 'codex');
    await expect(shown.getByRole('alert')).toHaveText(t.subs.signInErrors.notTaken);
    await expect(shown).toContainText(t.subs.connection.next.signInAgain);
    await expect(shown.locator('.waiting-mark')).toHaveCount(0);
    await shown.getByRole('button', { name: t.subs.connection.retryLabel('Codex'), exact: true }).click();
    await expect.poll(() => opened.posted).toContain('/api/subscriptions/s-codex/signin');
    await expect(page.locator('.signin').getByRole('heading', { name: t.subs.signingIn(HOST), exact: true })).toBeVisible();
    await expect(shown).toHaveCount(0);
  });

  test('Antigravity: a failed connection gives the last line its program said, and what to do on the machine', async ({ page }) => {
    const t = words(EN);
    const opened = await openPlans(page, EN, [plan('antigravity', 'needs_login')]);
    await openCard(page, EN, 'antigravity');
    const line = 'Google did not take the code: invalid_grant';
    await opened.connect('antigravity', connection('checking', 'failed', { error: 'The sign-in ended before it finished, so nothing changed.', line }));
    const shown = part(page, EN, 'antigravity');
    await expect(shown.getByRole('alert')).toContainText(line);
    await expect(shown).toContainText(t.subs.connection.next.installWindow(HOST));
    await expect(shown.locator('.waiting-mark')).toHaveCount(0);
  });

  for (const provider of ['codex', 'antigravity'] as const) {
    test(`${NAMES[provider]}: past the limit of the whole connection the owner sees it, and can try again, with a visible focus ring, or stop`, async ({ page }) => {
      const t = words(EN);
      const opened = await openPlans(page, EN, [plan(provider, 'needs_login')]);
      await openCard(page, EN, provider);
      await opened.connect(provider, connection('models'));
      const shown = part(page, EN, provider);
      await expect(shown.locator('.waiting-mark')).toBeVisible();
      await later(page, LIMIT);
      await opened.connect(provider, connection('models', 'too_long'));
      await expect(shown.getByRole('alert')).toHaveText(t.common.tooLong);
        await expect(shown).toContainText(t.subs.connection.tooLongNext(10));
      await expect(shown).toContainText(t.subs.connection.steps.models);
      await expect(shown.locator('.waiting-mark')).toHaveCount(0);
      const retry = shown.getByRole('button', { name: t.subs.connection.retryLabel(NAMES[provider]), exact: true });
      const cancel = shown.getByRole('button', { name: t.subs.connection.cancelLabel(NAMES[provider]), exact: true });
      await expect(cancel).toBeVisible();
      await cancel.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(retry).toBeFocused();
      const ring = await retry.evaluate(el => { const s = getComputedStyle(el); return { visible: el.matches(':focus-visible'), style: s.outlineStyle, width: s.outlineWidth }; });
      expect(ring).toEqual({ visible: true, style: 'solid', width: '2px' });
      if (provider === 'antigravity') {
        /* Try again has its node check the sign-in again: the plan connects anew, with no way to stop it until it stalls. */
        await retry.press('Enter');
        await expect.poll(() => opened.posted).toContain('/api/subscriptions/s-antigravity/connecting/retry');
        await opened.connect(provider, connection('checking'));
        await expect(shown.getByRole('status')).toContainText(t.subs.connection.steps.checking);
        await expect(shown.getByRole('button')).toHaveCount(0);
        return;
      }
      await cancel.click();
      await expect.poll(() => opened.posted).toContain(`/api/subscriptions/s-${provider}/connecting/cancel`);
      await expect(shown).toHaveCount(0);
    });
  }

  test('the ring turns only for a person who did not ask for less motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const opened = await openPlans(page, EN, [plan('antigravity', 'needs_login')]);
    await openCard(page, EN, 'antigravity');
    await opened.connect('antigravity', connection('checking'));
    const ring = part(page, EN, 'antigravity').locator('.waiting-mark');
    await expect(ring).toBeVisible();
    expect(await ring.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await ring.evaluate(el => getComputedStyle(el).animationName)).not.toBe('none');
  });
});

/* The pictures for the check against the style book: each state of an Antigravity plan, on a phone and a desktop, in both
   languages and two skins. The longest words of each state wrap inside the card. */
const LOOKS: Look[] = (['en', 'ru'] as const).flatMap(lang => (['cyberpunk', 'light'] as const).flatMap(theme => [375, 1440].map(width => ({ lang, theme, width }))));
const STATES = ['connecting', 'ready', 'failed', 'too_long'] as const;

for (const look of LOOKS) {
  const name = `${look.lang}-${look.theme}-${look.width}`;
  test(`each state of a connection wraps inside its card ${name}`, async ({ page, browserName }) => {
    const t = words(look);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const opened = await openPlans(page, look, [plan('antigravity', 'needs_login')]);
    await openCard(page, look, 'antigravity');
    const shown = part(page, look, 'antigravity');
    for (const state of STATES) {
      if (state === 'ready') {
        opened.plans.now = [plan('antigravity', 'ready')];
        await opened.connect('antigravity', null);
        await expect(shown).toHaveCount(0);
        const card = page.getByRole('heading', { name: t.cards.aboutPlan, exact: true });
        await expect(card).toBeVisible();
        await card.evaluate(el => el.scrollIntoView({ block: 'center' }));
        await page.screenshot({ path: `${SHOTS}/${browserName}-${name}-${state}.png`, animations: 'disabled' });
        opened.plans.now = [plan('antigravity', 'needs_login')];
        await say(page, { type: 'reconnected' });
        await expect(page.getByRole('heading', { name: t.cards.aboutPlan, exact: true })).toHaveCount(0);
        continue;
      }
      if (state === 'connecting') {
        await opened.connect('antigravity', connection('account'));
        await later(page, MINUTE + 5_000);
        await expect(shown.getByRole('status')).toContainText(t.subs.connection.steps.account);
        await expectBeside(shown.locator('.waiting-mark'), shown.getByText(t.subs.connection.steps.account, { exact: true }));
      }
      if (state === 'failed') {
        await opened.connect('antigravity', connection('checking', 'failed', { error: 'The sign-in ended before it finished, so nothing changed.', line: 'Antigravity CLI did not finish signing in.' }));
        await expect(shown.getByRole('alert')).toBeVisible();
      }
      if (state === 'too_long') {
        await opened.connect('antigravity', connection('models', 'too_long'));
        await expect(shown.getByRole('alert')).toHaveText(t.common.tooLong);
        await expect(shown).toContainText(t.subs.connection.tooLongNext(10));
        await shown.getByRole('button', { name: t.subs.connection.cancelLabel('Antigravity'), exact: true }).focus();
        await page.keyboard.press('Shift+Tab');
      }
      await wholeInside(page, shown, look.width);
      await shown.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: `${SHOTS}/${browserName}-${name}-${state}.png`, animations: 'disabled' });
    }
    expect(errors).toEqual([]);
  });
}
