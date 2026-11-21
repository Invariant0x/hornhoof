import { expect, test, type Page } from '@playwright/test';
import type { MachineDrain, MachineView, Org } from '../src/types';
import { ME, serveApi } from './api';

const HOST = 'worker-linux';
const GIB = 1024 ** 3;
const VERSION = { version: '0.6.1', commit: 'a'.repeat(40), migrations: 51 };
const BUILD = { tag: 'latest', version: '0.6.2', commit: 'b'.repeat(40), created: '2026-11-04T10:00:00Z', title: 'Wait for agents before an update', migrations: 52 };
const LINE = { en: 'Waiting since 21:30 for agents to finish before the update: 3 turns left. It takes no new work until then', ru: 'С 21:30 ждет конца работы агентов перед обновлением: осталось 3 хода. До тех пор новой работы не берет' };
const ASK = { en: '3 agent turns are running.', ru: 'Идут 3 хода агентов.' };
const UPDATE = { en: 'Update', ru: 'Обновить' };
const CUT_TITLE = { en: 'Update now?', ru: 'Обновить сейчас?' };
const CANCEL = { en: 'Cancel', ru: 'Отмена' };
/* Tall enough at phone width to show the whole card without scrolling under the top bar. */
const SIZES = [[1440, 900], [375, 1800]] as const;

const WAITING: MachineDrain = { state: 'waiting', turnsLeft: 3, partsLeft: 0, since: '2026-11-04T21:30:00.000Z' };

/* newer: a newer build is out, so the update banner offers it. */
async function openMachines(page: Page, language: 'en' | 'ru', theme: 'light' | 'dark', drain: MachineDrain, newer = false) {
  await serveApi(page);
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', theme);
  }, { language, theme });
  const machine: MachineView = {
    id: 'm1', hostname: HOST, os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null, plans: [],
    load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 3, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
    lendsTests: true, running: { agents: [], parts: [] }, drain,
  };
  const org: Org = { company: ME.company, orchestrator: null, agents: { total: 1, working: 1 }, people: [], departments: [] };
  await page.route('**/api/org', route => route.fulfill({ json: org }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [machine], builtin: null } }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
  await page.route('**/api/version', route => route.fulfill({ json: { version: VERSION.version, commit: VERSION.commit } }));
  await page.route('**/api/updates', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, json: { error: { code: 'conflict', reason: 'turns_would_stop', message: 'Running turns would stop.', details: { turns: 3 } } } })
    : route.fulfill({ json: { current: VERSION, available: newer, checkedAt: null, latest: BUILD, versions: [BUILD], error: null, updater: { present: true, status: null, waiting: null } } }));
  await page.goto('/');
  await page.getByRole('button', { name: language === 'en' ? 'Machines' : 'Машины', exact: true }).click();
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const [width, height] of SIZES) {
  const place = `${language} ${theme} ${width}`;
  const shot = (name: string) => `${name}-${language}-${theme}-${width}.png`;

  test(`shows the wait in the card, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await openMachines(page, language, theme, WAITING);
    await page.getByRole('button', { name: `${language === 'en' ? 'Open the card of' : 'Открыть карточку'} ${HOST}`, exact: true }).click();
    const card = page.getByRole('article', { name: HOST });
    const line = card.getByText(LINE[language]);
    await expect(line).toBeVisible();
    const box = (await line.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('waiting')), fullPage: true });
  });

  test(`asks how many turns would stop, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await openMachines(page, language, theme, WAITING, true);
    await page.getByRole('button', { name: UPDATE[language], exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: UPDATE[language], exact: true }).click();
    const ask = page.getByRole('alertdialog', { name: CUT_TITLE[language] });
    await expect(ask.getByText(ASK[language])).toBeVisible();
    await expect(ask.getByRole('button', { name: CANCEL[language], exact: true })).toBeFocused();
    const [yes, no] = await Promise.all((await ask.getByRole('button').all()).map(button => button.boundingBox()));
    expect(no!.x - (yes!.x + yes!.width)).toBeGreaterThanOrEqual(8);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('confirm')) });
    await page.keyboard.press('Escape');
    await expect(ask).toBeHidden();
  });
}
