import { expect, test, type Locator, type Page } from '@playwright/test';
import type { BuiltinView, DataView, MachineView, Org } from '../src/types';
import { ME, box, serveApi } from './api';

const GIB = 1024 ** 3;
/* Tall enough at phone width to show the open cards without scrolling under the top bar. */
const SIZES = [[1440, 900], [375, 2600]] as const;
const WORDS = {
  en: {
    tab: 'Machines', open: 'Open the card of', priority: 'Priority',
    best: 'Always online, best connection to machine 1', pinned: 'Number set by hand', out: 'Never takes the server: set by hand',
    scope: "Cannot take the server: the company's data stays only on machines of people who see the whole company, and Marat sees 2 departments.",
    line: 'If machine 1 goes away, machine 2 takes the server, then 3.', outChoice: 'Does not take the server', pick: (host: string) => `Priority of ${host}`,
    onlyCopy: (host: string) => `${host} holds the only up-to-date copy; give another machine a place first.`,
  },
  ru: {
    tab: 'Машины', open: 'Открыть карточку', priority: 'Приоритет',
    best: 'Всегда в сети, лучшая связь с машиной 1', pinned: 'Номер задан вручную', out: 'Никогда не берет сервер: так задано вручную',
    scope: 'Не может взять сервер: данные компании хранятся только на машинах тех, кто видит всю компанию, а Marat видит 2 отдела.',
    line: 'Если машина 1 пропадет, сервер возьмет машина 2, за ней 3.', outChoice: 'Не берет сервер', pick: (host: string) => `Приоритет ${host}`,
    onlyCopy: (host: string) => `${host} хранит единственную актуальную копию; сначала дайте место другой машине.`,
  },
};

const LONG = 'build-box-with-a-rather-long-name-of-its-own';
const placed = (over: Partial<DataView>): DataView => ({ number: null, why: null, pin: null, unfit: null, copy: null, leftAt: null, ...over });
const machine = (id: string, hostname: string, data: DataView): MachineView => ({
  id, hostname, os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null, plans: [],
  load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
  lendsTests: true, running: { agents: [], parts: [] }, data,
});
/* The server's machine, two copies of which one stands where the CEO put it, the next in line, one kept out by hand and
   one that cannot take the server. */
const MACHINES: MachineView[] = [
  machine('m4', 'lab-nuc', placed({ number: 4, why: 'next' })),
  machine('m6', 'marat-pc', placed({ unfit: { why: 'scope', person: 'Marat', departments: 2 } })),
  machine('m2', 'ivan-studio', placed({ number: 2, why: 'always.best_link', copy: { line: 'ready' } })),
  machine('m5', 'olga-air', placed({ why: 'out', pin: 'none' })),
  machine('m1', 'rack-01', placed({ number: 1, why: 'server' })),
  machine('m3', LONG, placed({ number: 3, why: 'pinned', pin: 3, copy: { line: 'making', progress: 40 } })),
];
const BUILTIN: BuiltinView = { online: true, load: null, running: { agents: [], parts: [] }, machine: { id: 'm1', hostname: 'rack-01' } };

type Sent = { path: string; body: unknown };

/* refuse: the answer to a choice; none takes it. */
async function openMachines(page: Page, language: 'en' | 'ru', theme: 'light' | 'dark', refuse?: { status: number; reason: string }): Promise<Sent[]> {
  const sent: Sent[] = [];
  await serveApi(page);
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', theme);
  }, { language, theme });
  const org: Org = { company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [], departments: [] };
  await page.route('**/api/org', route => route.fulfill({ json: org }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: MACHINES, builtin: BUILTIN, priority: true, copies: { leader: 'rack-01', copies: [{ hostname: 'ivan-studio', sync: true }, { hostname: LONG, sync: false }], onlySince: null } } }));
  await page.route('**/api/machines/*/priority', route => {
    sent.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return refuse ? route.fulfill({ status: refuse.status, json: { error: { code: 'conflict', reason: refuse.reason, message: 'Refused.' } } }) : route.fulfill({ status: 204 });
  });
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
  await page.goto('/');
  await page.getByRole('button', { name: WORDS[language].tab, exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  return sent;
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/* Whether one box lies within another, to the pixel a browser may round by. */
async function within(inner: Locator, outer: Locator): Promise<boolean> {
  const [a, b] = [await box(inner), await box(outer)];
  return a.x >= b.x - 1 && a.x + a.width <= b.x + b.width + 1;
}

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const [width, height] of SIZES) {
  const place = `${language} ${theme} ${width}`;
  const w = WORDS[language];
  const shot = (name: string) => `${name}-${language}-${theme}-${width}.png`;
  const card = (page: Page, hostname: string) => page.getByRole('article', { name: hostname });
  const open = (page: Page, hostname: string) => page.getByRole('button', { name: `${w.open} ${hostname}`, exact: true }).click();

  test(`orders the machines by their place, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await openMachines(page, language, theme);
    const rows = page.locator('tr.rm');
    await expect(rows).toHaveCount(6);
    expect(await rows.evaluateAll(all => all.map(row => row.getAttribute('aria-label')))).toEqual(['rack-01', 'ivan-studio', LONG, 'lab-nuc', 'marat-pc', 'olga-air']);
    /* On a wide screen the column's header stands on one line, as tall as the others. */
    if (width > 780) expect(new Set(await page.locator('table.dt thead th button').evaluateAll(all => all.map(one => Math.round(one.getBoundingClientRect().height)))).size).toBe(1);
    /* The number's box is as tall in every row, and the server's is filled. */
    const boxes = page.locator('td.k-prio .pn');
    await expect(boxes).toHaveCount(4);
    expect(new Set(await boxes.evaluateAll(all => all.map(one => Math.round(one.getBoundingClientRect().height))))).toEqual(new Set([22]));
    const filled = await boxes.evaluateAll(all => all.map(one => getComputedStyle(one).backgroundColor));
    expect(filled[0]).not.toBe(filled[1]);
    expect(filled[1]).toBe(filled[2]);
    /* A machine with no number has a dash, and its words for a reader of the screen. */
    await expect(page.locator('td.k-prio .pdash')).toHaveCount(2);
    for (const dash of await page.locator('td.k-prio .pdash').all()) await expect(dash).toBeVisible();
    for (const cell of await page.locator('td.k-prio').all()) expect(await within(cell, page.locator('table.dt'))).toBe(true);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('table')), fullPage: true });
  });

  test(`shows the place, the choice and why in the cards, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await openMachines(page, language, theme);
    /* One card is open at a time, so each is looked at in turn. */
    await open(page, LONG);
    const pinned = card(page, LONG);
    await expect(pinned.getByText(w.pinned)).toBeVisible();
    const group = pinned.getByRole('radiogroup', { name: w.priority });
    const pick = pinned.getByRole('combobox', { name: w.pick(LONG) });
    await expect(pick).toHaveValue('3');
    /* Every choice and the list of places stay inside the card, each radio a square of its own size. */
    for (const one of [...(await group.getByRole('radio').all()), pick, group]) expect(await within(one, pinned)).toBe(true);
    for (const radio of await group.getByRole('radio').all()) {
      const size = await box(radio);
      expect([Math.round(size.width), Math.round(size.height)]).toEqual([16, 16]);
    }
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('pinned')), fullPage: true });
    await open(page, 'ivan-studio');
    await expect(card(page, 'ivan-studio').getByText(w.best)).toBeVisible();
    await open(page, 'olga-air');
    await expect(card(page, 'olga-air').getByText(w.out)).toBeVisible();
    await expect(card(page, 'olga-air').getByRole('radio', { name: w.outChoice })).toBeChecked();
    await open(page, 'rack-01');
    await expect(card(page, 'rack-01').getByText(w.line)).toBeVisible();
    await expect(card(page, 'rack-01').getByRole('radio')).toHaveCount(0);
    /* The long reason wraps inside its card, with no choice under it. */
    await open(page, 'marat-pc');
    const reason = card(page, 'marat-pc').getByText(w.scope);
    await expect(reason).toBeVisible();
    expect(await within(reason, card(page, 'marat-pc'))).toBe(true);
    await expect(card(page, 'marat-pc').getByRole('radio')).toHaveCount(0);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('unfit')), fullPage: true });
  });

  test(`sends the CEO's choice and words a refusal, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const sent = await openMachines(page, language, theme, { status: 409, reason: 'only_copy' });
    await open(page, 'ivan-studio');
    const copy = card(page, 'ivan-studio');
    await copy.getByRole('radio', { name: w.outChoice }).click();
    const refusal = copy.getByRole('alert');
    await expect(refusal).toHaveText(w.onlyCopy('ivan-studio'));
    expect(sent).toEqual([{ path: '/api/machines/m2/priority', body: { pin: 'none' } }]);
    expect(await within(refusal, copy)).toBe(true);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('refused')), fullPage: true });
  });
}
