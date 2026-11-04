import { expect, test, type Locator, type Page } from '@playwright/test';
import type { SubView } from '../src/types';
import { box, serveApi } from './api';

/* The card of a plan that does not work is one block across it. The plan the CEO saw, ready on the Mac but with nodes too
   old for the sign-in from Hornhoof, turns into that block once Sign in finds them, and a plan waiting for its sign-in or
   for its machine is that block from the start, the latter with its install command. A working plan keeps its three
   blocks. In a real browser, as jsdom lays out nothing. */

const MAC = '0xs-MacBook-Pro.local';
const UPDATE = 'curl -fsSL https://hq.acme.com/install.sh | bash';
const OLD = { error: { code: 'conflict', message: `The nodes on ${MAC} are older than the sign-in from Hornhoof needs.`, reason: 'signin_unsupported', details: { machines: [MAC], command: UPDATE } } };

/* Signed in by hand on the Mac alone, so Sign in from Hornhoof is still to do. */
const READY: SubView = {
  id: 's-codex', provider: 'codex', kind: 'personal', label: 'Codex', status: 'ready', online: true, last4: null,
  owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' },
  machines: [{ id: 'm1', hostname: MAC, status: 'ready', online: true }], limits: null, budget: null, isOrchestrator: false,
  accounts: [{ nodeId: 'n1', hostname: MAC, tier: 'pro' }], tier: 'Pro', accountsDiffer: false, signedInOnce: false, leaseMachine: null, agents: [],
};
const LOGIN: SubView = { ...READY, id: 's-claude', provider: 'claude', label: 'Claude', status: 'needs_login', tier: null, accounts: [], machines: [{ id: 'm2', hostname: MAC, status: 'needs_login', online: true }] };
/* Connected a moment ago: its install command has not been run yet, and Done has closed the block at the top. */
const WAITING: SubView = { ...READY, id: 's-kimi', provider: 'kimi', label: 'Kimi', status: 'waiting_machine', online: false, tier: null, accounts: [], machines: [] };
const INSTALL = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join DEMO_ONLY';
/* Its command ran out: Make a new command stands in its place. */
const EXPIRED: SubView = { ...WAITING, id: 's-glm', provider: 'glm', label: 'GLM' };
const installCommand = () => ({ id: 'c'.repeat(64), kind: 'plans', subscriptionIds: [WAITING.id], dismissedSubscriptionIds: [WAITING.id], plans: ['Kimi'], machine: null, command: INSTALL, expiresAt: new Date(Date.now() + 21 * 3600_000 + 60_000).toISOString() });

const WORDS = {
  en: { tab: 'Subscriptions', open: 'Open the card of ', signIn: 'Sign in to Codex', old: `The nodes on ${MAC} are older`, lifetime: 'Valid for 21 more hours.', fresh: 'New command for GLM' },
  ru: { tab: 'Подписки', open: 'Открыть карточку ', signIn: 'Войти в Codex', old: `Ноды на ${MAC} старше`, lifetime: 'Действует еще 21 ч.', fresh: 'Новая команда для GLM' },
};

async function servePlans(page: Page) {
  await serveApi(page);
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.5.0', commit: 'task-189' } }));
  await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.5.0', commit: 'task-189' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [READY, LOGIN, WAITING, EXPIRED] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [installCommand()] } }));
  await page.route('**/api/subscriptions/s-codex/signin', route => route.fulfill({ status: 409, json: OLD }));
}

/* The block fills the card's blocks, whatever their columns and rows, with no empty rows under it, and nothing in it sticks
   out. */
async function across(card: Locator) {
  const blocks = await box(card.locator('.blocks'));
  const block = card.locator('.blk-fix');
  const own = await box(block);
  expect(Math.abs(own.x - blocks.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(own.width - blocks.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(own.height - blocks.height)).toBeLessThanOrEqual(1);
  for (const inner of await block.locator('p, .command-box, .machine-actions').all()) {
    const b = await box(inner);
    expect(b.x + b.width).toBeLessThanOrEqual(own.x + own.width + 1);
  }
  await expect(card.locator('.blocks > .blk')).toHaveCount(1);
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`a plan that does not work is one block across its card, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const words = WORDS[lang];
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        /* Failed calls by their address; the sign-in's 409 is the answer this test asks for. */
        page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
        page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/signin')) errors.push(`${response.status()} ${response.url()}`); });
        await servePlans(page);
        await page.goto('/');
        await page.getByRole('button', { name: words.tab, exact: true }).click();
        await page.getByRole('button', { name: `${words.open}Codex` }).click();
        await page.getByRole('button', { name: `${words.open}Claude` }).click();
        await page.getByRole('button', { name: `${words.open}Kimi` }).click();
        await page.getByRole('button', { name: `${words.open}GLM` }).click();
        const codex = page.getByRole('article', { name: 'Codex, Ivan' });
        const claude = page.getByRole('article', { name: 'Claude, Ivan' });
        const kimi = page.getByRole('article', { name: 'Kimi, Ivan' });
        const glm = page.getByRole('article', { name: 'GLM, Ivan' });

        /* Working: its three blocks, as before. */
        await expect(codex.locator('.blocks > .blk')).toHaveCount(3);
        await codex.screenshot({ path: info.outputPath(`189-working-${lang}-${theme}-${width}.png`) });

        /* Waiting for its sign-in: one block from the start. */
        await across(claude);
        await claude.screenshot({ path: info.outputPath(`189-login-${lang}-${theme}-${width}.png`) });

        /* Waiting for its machine: one block from the start, with the install command, Copy and how long it works. */
        await expect(kimi.getByText(INSTALL)).toBeVisible();
        await expect(kimi.getByText(words.lifetime)).toBeVisible();
        await across(kimi);
        await kimi.scrollIntoViewIfNeeded();
        await kimi.screenshot({ path: info.outputPath(`189-waiting-${lang}-${theme}-${width}.png`) });

        /* Its command ran out: Make a new command, as wide as its words, where the command was, and Remove under it. */
        await across(glm);
        const fresh = await box(glm.getByRole('button', { name: words.fresh }));
        const block = await box(glm.locator('.blk-fix'));
        expect(Math.abs(fresh.x - block.x)).toBeLessThanOrEqual(1);
        expect(fresh.width).toBeLessThan(block.width * 0.75);
        await glm.scrollIntoViewIfNeeded();
        await glm.screenshot({ path: info.outputPath(`189-expired-${lang}-${theme}-${width}.png`) });

        /* Sign in finds the nodes too old: the same card turns into the block, with the command. */
        await codex.getByRole('button', { name: words.signIn }).click();
        await expect(codex.getByText(words.old)).toBeVisible();
        await expect(codex.getByText(UPDATE)).toBeVisible();
        await across(codex);
        await codex.scrollIntoViewIfNeeded();
        await codex.screenshot({ path: info.outputPath(`189-after-${lang}-${theme}-${width}.png`) });

        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      });
    }
  }
}
