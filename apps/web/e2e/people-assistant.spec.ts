import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Messages } from '../src/i18n/en';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { PersonView } from '../src/types';
import { box, serveApi } from './api';

const WHOLE = { whole: true, departments: [], teams: [] };
const NONE = { whole: false, departments: [], teams: [] };
const AVA: PersonView = {
  id: 'h1', name: 'Ava', email: null, title: 'Personal assistant', status: 'active', isOwner: false, access: NONE,
  assistant: { owner: { id: 'p2', name: 'Maya Chen Alderbrook-Riverstone' }, program: 'openclaw', eventsUrl: 'http://192.168.1.5:18789/hooks/wake', skillsUrl: null, key: null, agent: null },
};
/* The CEO, a person with a long name, and her assistant, with a key made already. */
const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: WHOLE },
  { id: 'p2', name: 'Maya Chen Alderbrook-Riverstone', email: 'maya@moonfern.example', title: 'CMO', status: 'active', isOwner: false, access: WHOLE },
  { ...AVA, assistant: { ...AVA.assistant!, key: { createdAt: '2026-11-11T10:00:00.000Z' } } },
];
const KEY = `hha_${'K7x-Qp'.repeat(7)}a`;
const SECRET = `hhs_${'s3_Vb9'.repeat(7)}z`;
/* OpenClaw's settings as the server gives them, with their longest lines: the address and the key. */
const SETUP = {
  file: '~/.openclaw/openclaw.json',
  text: ['{', '  mcp: {', '    servers: {', '      hornhoof: {', '        url: "https://acme.hornhoof.app/api/assistant/mcp",', '        transport: "streamable-http",', `        headers: { Authorization: "Bearer ${KEY}" },`, '      },', '    },', '  },', '  hooks: {', '    enabled: true,', `    token: "${SECRET}",`, '  },', '}'].join('\n'),
};
const MADE = { key: KEY, signingSecret: SECRET, address: 'https://acme.hornhoof.app', setup: SETUP, person: PEOPLE[2] };
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };

/* The People screen as the CEO meets it, with the errors the page logs. */
async function openPeople(page: Page, lang: 'en' | 'ru', theme: 'light' | 'dark', width: number): Promise<string[]> {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await serveApi(page);
  const EXTRA: Record<string, unknown> = {
    '/api/version': { version: '0.5.0', commit: 'task-180' },
    '/api/updates': { current: { version: '0.5.0', commit: 'task-180' }, available: false, latest: null, updater: { status: null, waiting: null } },
  };
  await page.route('**/api/{version,updates}', route => route.fulfill({ json: EXTRA[new URL(route.request().url()).pathname] }));
  await page.route('**/api/people**', route => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (method === 'GET' && pathname === '/api/people') return route.fulfill({ json: { people: PEOPLE } });
    if (method === 'POST' && pathname === '/api/people/h1/key') return route.fulfill({ status: 201, json: MADE });
    return route.fallback();
  });
  await page.goto('/');
  await page.getByRole('button', { name: MESSAGES[lang].shell.tabs.people, exact: true }).click();
  await expect(page.locator('table.ptable')).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return errors;
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/* Each box sits inside the other, give or take a pixel. */
async function inside(inner: Locator, outer: Locator, what: string) {
  const i = await box(inner);
  const o = await box(outer);
  expect(i.x, `${what}: start`).toBeGreaterThanOrEqual(o.x - 1);
  expect(i.x + i.width, `${what}: end`).toBeLessThanOrEqual(o.x + o.width + 1);
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`an assistant is listed with its owner, added by its card in the choice and its key shown once, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        const errors = await openPeople(page, lang, theme, width);
        const table = page.locator('table.ptable');
        await table.screenshot({ path: info.outputPath(`people-assistant-${width}-${lang}-${theme}.png`) });
        /* A row in the narrow layout names its columns too, so it is found by its own button. */
        const row = table.locator('tr', { has: page.getByRole('button', { name: t.people.editLabel('Ava'), exact: true }) });
        const note = row.getByText(t.people.assistantOf(AVA.assistant!.owner.name), { exact: true });
        await expect(note).toBeVisible();
        await inside(note, row.locator('td').first(), 'whom it acts for, in its cell');
        const name = await box(row.locator('.pname'));
        const under = await box(note);
        expect(under.x, 'whom it acts for starts where the name starts').toBeGreaterThanOrEqual(name.x - 1);
        expect(under.y, 'whom it acts for is under the name').toBeGreaterThanOrEqual(name.y + name.height - 1);
        await expect(row.getByText(t.people.sameAs(AVA.assistant!.owner.name), { exact: true })).toBeVisible();
        expect(await noSideScroll(page), 'no sideways scroll with the list').toBe(true);

        await page.getByRole('button', { name: t.people.invitePerson, exact: true }).click();
        const assistant = page.getByRole('radio', { name: t.people.kindAssistant, exact: true });
        await page.locator('label.kind-card', { has: assistant }).click();
        await expect(assistant).toBeChecked();
        const form = page.locator('.panel', { has: page.getByRole('button', { name: t.people.createAssistant, exact: true }) });
        await expect(form.getByLabel(t.people.assistantOwner, { exact: true })).toBeVisible();
        await expect(form.getByLabel(t.people.program, { exact: true })).toBeVisible();
        await form.screenshot({ path: info.outputPath(`assistant-new-${width}-${lang}-${theme}.png`) });
        for (const field of [t.people.assistantOwner, t.people.program, t.people.eventsUrl]) await inside(form.getByLabel(field, { exact: true }), form, field);
        expect(await noSideScroll(page), 'no sideways scroll with the form').toBe(true);
        await form.getByRole('button', { name: t.common.cancel, exact: true }).click();

        await row.getByRole('button', { name: t.people.editLabel('Ava'), exact: true }).click();
        const card = page.locator('.panel', { has: page.getByRole('heading', { name: t.people.editHeading('Ava'), exact: true }) });
        await expect(card.getByText(t.people.actsFor(AVA.assistant!.owner.name), { exact: true })).toBeVisible();
        await card.getByRole('button', { name: t.people.replaceKey, exact: true }).click();
        const key = card.getByText(MADE.key, { exact: true });
        await expect(key).toBeVisible();
        await expect(card.getByText(MADE.signingSecret, { exact: true })).toBeVisible();
        await card.screenshot({ path: info.outputPath(`assistant-key-${width}-${lang}-${theme}.png`) });
        await inside(key, card, 'the key');
        for (const shown of [key, card.getByText(MADE.signingSecret, { exact: true })]) {
          expect((await box(shown)).width, 'a key keeps a readable width, its Copy under it').toBeGreaterThan((await box(card)).width * 0.4);
        }
        await inside(card.getByRole('button', { name: t.people.copySecret, exact: true }), card, 'Copy signing secret');
        await inside(card.getByRole('button', { name: t.people.copyForAssistant, exact: true }), card, 'Copy for the assistant');
        const setup = card.locator('pre', { hasText: 'streamable-http' });
        await expect(card.getByText(t.people.setupFor('OpenClaw'), { exact: true })).toBeVisible();
        await setup.scrollIntoViewIfNeeded();
        await inside(setup, card, "OpenClaw's settings");
        await inside(card.getByRole('button', { name: t.people.copySetup, exact: true }), card, 'Copy settings');
        expect(await noSideScroll(page), 'no sideways scroll with the key').toBe(true);
        await card.getByRole('button', { name: t.people.hideKey, exact: true }).click();
        await expect(key).toHaveCount(0);
        expect(errors).toEqual([]);
      });
    }
  }
}
