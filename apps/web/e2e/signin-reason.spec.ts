import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { SubView } from '../src/types';
import { serveApi } from './api';

/* A sign-in whose program ended at once: the owner reads under the plan's row the code and the last line the program
   said, as the node sends it, instead of the plain words. The longest the node sends is 200 characters, here one word
   with no place to break; it wraps inside the page in both languages, both themes, left to right and
   right to left, wide and narrow. The pictures are for the check against the style book. */
test.describe.configure({ timeout: 0 });
const SHOTS = 'e2e/results/signin-reason-shots';
mkdirSync(SHOTS, { recursive: true });

const NODE = 'n-1';
/* The longest line the node sends: 199 characters and its mark of the cut, one word with no place to break. */
const LINE = `Error:${'x'.repeat(193)}…`;
const CODEX: SubView = {
  id: 's-codex', provider: 'codex', kind: 'personal', label: 'Codex', last4: null, tier: null, status: 'needs_login', online: true,
  owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, limits: null, limitsUpdatedAt: null,
  budget: null, isOrchestrator: false, accounts: [], accountsDiffer: false, signedInOnce: false, leaseMachine: null, agents: [],
  machines: [{ id: 'm1', hostname: 'dev-laptop', status: 'needs_login', online: true }],
} as unknown as SubView;

type Look = { lang: 'en' | 'ru'; theme: 'cyberpunk' | 'light'; dir: 'ltr' | 'rtl'; width: number };
const LOOKS: Look[] = [
  ...(['en', 'ru'] as const).flatMap(lang => (['cyberpunk', 'light'] as const).flatMap(theme => [1440, 375].map(width => ({ lang, theme, dir: 'ltr' as const, width })))),
  { lang: 'ru', theme: 'light', dir: 'rtl', width: 375 },
];

const pathOf = (url: URL | string) => new URL(url.toString()).pathname;

const T0 = Date.parse('2026-11-16T12:00:00Z');

/* The page opens on the plan, with a stand-in for the stream that the test speaks into, as the machine's word of how the
   sign-in ended would come, and one for the sign-in terminal, which no server answers here. The page runs on the test's
   clock, paused: its timers and frames, the guard's frame watch among them, move only when the test moves them, so a slow
   machine never turns the page light and lays the banner over the card. It says whether the terminal reached its
   stand-in. */
async function openPlan(page: Page, { lang, theme, dir, width }: Look): Promise<() => boolean> {
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0 + 60_000);
  await page.setViewportSize({ width, height: 900 });
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
  }, { lang, theme });
  await serveApi(page);
  await page.route(url => pathOf(url) === '/api/subscriptions', route => route.fulfill({ json: { subscriptions: [CODEX] } }));
  await page.route(url => pathOf(url) === '/api/subscriptions/s-codex/signin', route => route.fulfill({ json: { nodeId: NODE, hostname: 'dev-laptop' } }));
  let terminal = false;
  await page.routeWebSocket(url => pathOf(url) === '/api/subscriptions/s-codex/signin/terminal', ws => {
    terminal = true;
    ws.onMessage(() => {});
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(direction => { document.documentElement.dir = direction; }, dir);
  return () => terminal;
}

const ENDED = { type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: false, error: 'The sign-in ended before it finished, so nothing changed.', code: 1, line: LINE, owner: 'p1' };

for (const look of LOOKS) {
  const t = look.lang === 'en' ? en : ru;
  const name = `${look.lang}-${look.theme}-${look.dir}-${look.width}`;
  test(`a sign-in that ended early says why under its plan, the longest reason inside the page ${name}`, async ({ page, browserName }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const terminalReached = await openPlan(page, look);
    await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();
    await page.getByRole('button', { name: t.tables.openCard('Codex'), exact: true }).click();
    await page.getByRole('button', { name: t.subs.signInLabel('Codex'), exact: true }).click();
    await expect(page.getByRole('heading', { name: t.subs.signingIn('dev-laptop'), exact: true })).toBeVisible();
    await expect.poll(terminalReached).toBe(true);
    await page.evaluate(data => (window as unknown as { hhSay(data: string): void }).hhSay(data), JSON.stringify(ENDED));
    const note = page.getByRole('status').filter({ hasText: t.subs.signInEnded(1, LINE) });
    await expect(note).toHaveText(t.subs.signInEnded(1, LINE));
    await expect(page.getByText(t.subs.signInErrors.unfinished, { exact: true })).toHaveCount(0);
    await page.evaluate(async () => { await document.fonts.ready; });
    /* Nothing runs off sideways: the reason wraps inside its row and the page. */
    const box = (await note.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(look.width);
    expect(await note.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    /* The page kept every effect: no banner of a light page lies over the card in the picture. */
    expect(await page.evaluate(() => document.documentElement.dataset.light ?? null)).toBeNull();
    await note.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${SHOTS}/${browserName}-${name}.png`, animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}
