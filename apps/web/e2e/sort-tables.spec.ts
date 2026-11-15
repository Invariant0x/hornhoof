/// <reference types="node" />
import { writeFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Messages } from '../src/i18n';
import type { BacklogItem, BuiltinView, DataView, MachineView, PersonView } from '../src/types';
import { box, brokenHeaderWords, tableFits } from './api';
import { around, focusRing, sizes, wholePage } from './owner-screens-look';
import type { Measured } from './owner-screens-sizes';
import { DEV, serveTasksBoard } from './tasks-board/api';

/* Touch targets of 44px, unclipped 2px focus rings at 2px offset, RTL inline alignment and cross-browser size parity
   within 1px across Machines, Backlog and People in English and Russian, Light and Cyberpunk, at 1440px and 375px. */
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const GIB = 1024 ** 3;
const WHOLE = { whole: true, departments: [], teams: [] };

type Look = { lang: 'en' | 'ru'; skin: 'light' | 'cyberpunk'; width: number; dir: 'ltr' | 'rtl' };
const LOOKS: Look[] = [
  ...(['en', 'ru'] as const).flatMap(lang => (['light', 'cyberpunk'] as const).flatMap(skin => [1440, 375].map(width => ({ lang, skin, width, dir: 'ltr' as const })))),
  { lang: 'en', skin: 'light', width: 1440, dir: 'rtl' },
  { lang: 'ru', skin: 'cyberpunk', width: 375, dir: 'rtl' },
];

const placed = (over: Partial<DataView>): DataView => ({ number: null, why: null, pin: null, unfit: null, copy: null, leftAt: null, ...over });

const MACHINES: MachineView[] = [
  {
    id: 'm1', hostname: 'rack-01', os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null,
    plans: [{ id: 's1', provider: 'claude', status: 'ready', online: true }], data: placed({ number: 1, why: 'server' }),
    load: { cpus: 16, load: 2, memFree: 24 * GIB, memTotal: 32 * GIB, jobs: 1, tests: 0, cpuModel: 'EPYC', diskFree: 400 * GIB, diskTotal: 512 * GIB },
    lendsTests: true, running: { agents: [], parts: [] },
  },
  {
    id: 'm2', hostname: 'dev-studio', os: 'darwin', arch: 'arm64', owner: { id: 'p2', name: 'Dana' }, online: true, lastSeenAt: null,
    plans: [{ id: 's2', provider: 'codex', status: 'ready', online: true }], data: placed({ number: 2, why: 'always.best_link', copy: { line: 'ready' } }),
    load: { cpus: 12, load: 1, memFree: 18 * GIB, memTotal: 24 * GIB, jobs: 0, tests: 0, cpuModel: 'M4 Pro', diskFree: 300 * GIB, diskTotal: 512 * GIB },
    lendsTests: true, running: { agents: [], parts: [] },
  },
  {
    id: 'm3', hostname: 'build-node-west', os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: false,
    lastSeenAt: '2026-11-15T09:00:00.000Z', plans: [], data: placed({ why: 'out', pin: 'none' }), load: null, lendsTests: false,
    running: { agents: [], parts: [] },
  },
];
const BUILTIN: BuiltinView = { online: true, load: null, running: { agents: [], parts: [] }, machine: { id: 'm1', hostname: 'rack-01' } };

const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan Korol', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: WHOLE },
  { id: 'p2', name: 'Dana Konstantinopolskaya', email: 'dana@acme.com', title: 'Head of operations', status: 'invited', isOwner: false, isCeoDelegate: true, access: WHOLE },
  { id: 'p3', name: 'Mia', email: 'mia@acme.com', title: 'CTO', status: 'disabled', isOwner: false, access: WHOLE },
];

const BACKLOG_ITEMS: BacklogItem[] = [
  { id: 'b1', departmentId: DEV.id, title: 'Gift cards for partner shops', text: 'Let partner shops issue and redeem gift cards.', by: { id: 'p1', name: 'Ivan' }, at: '2026-11-14T10:00:00.000Z' },
  { id: 'b2', departmentId: DEV.id, title: 'Export monthly tax summary', text: 'Build CSV and XLSX tax summary export.', by: { id: 'p2', name: 'Dana' }, at: '2026-11-14T11:00:00.000Z' },
  { id: 'b3', departmentId: DEV.id, title: 'Webhook retry backoff', text: 'Retry failed delivery with bounded backoff.', by: { id: 'p1', name: 'Ivan' }, at: '2026-11-14T12:00:00.000Z' },
];

async function brokenTargets(scope: Locator): Promise<string[]> {
  return scope.evaluate(root => {
    const out: string[] = [];
    for (const btn of root.querySelectorAll<HTMLElement>('.sorth, .sortb, .rowbtn, .chipf')) {
      const r = btn.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || getComputedStyle(btn).visibility === 'hidden') continue;
      const [w, h] = [Math.round(r.width), Math.round(r.height)];
      if (w < 44 || h < 44) out.push(`${btn.className} "${(btn.textContent ?? '').trim().slice(0, 30)}" is ${w}x${h}px`);
    }
    return out;
  });
}

async function brokenFilterWords(scope: Locator): Promise<string[]> {
  return scope.evaluate(root => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('.fgroup > .lbl, .fgroup .chipf')) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          const lines = new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top)));
          if (lines.size > 1) out.push(word[0]);
        }
      }
    }
    return out;
  });
}

async function checkMachineFilters(page: Page, section: Locator, t: Messages, dir: 'ltr' | 'rtl'): Promise<void> {
  const linkInk = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.color = 'var(--cyan-ink)';
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  const rows = section.locator('tr.rm');
  const groups: [string, string, number][] = [
    [t.tables.provider, 'Codex', 1],
    [t.tables.status, t.cards.offline, 1],
    [t.tables.testFilters, t.tables.lentFilter, 2],
  ];
  for (const [label, option, shown] of groups) {
    const group = section.getByRole('group', { name: label, exact: true });
    await expect(group).toHaveClass(/\bwhole\b/);
    const all = group.getByRole('button').first();
    await expect(all).toHaveText(`${t.tables.all}${MACHINES.length}`);
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    await expect(all).toHaveCSS('border-top-color', linkInk);
    const choice = group.getByRole('button', { name: new RegExp(`^${option}`) });
    await choice.click();
    await expect(all).toHaveAttribute('aria-pressed', 'false');
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
    await expect(choice).toHaveCSS('border-top-color', linkInk);
    await expect(rows).toHaveCount(shown);
    await all.click();
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(MACHINES.length);
  }
  if (dir === 'rtl') {
    const group = section.locator('.fgroup').first();
    const [lblBox, chipBox] = [await box(group.locator('.lbl')), await box(group.locator('.chipf').first())];
    expect(lblBox.x).toBeGreaterThanOrEqual(chipBox.x + chipBox.width);
  }
}

async function checkKeyboardFocus(page: Page, control: Locator, shotPath: string): Promise<void> {
  await control.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(control).toBeFocused();
  expect(await focusRing(page)).toBe('ring');
  await around(page, control, shotPath);
}

async function checkRtlChevron(rowButton: Locator): Promise<void> {
  const [btnBox, chevBox] = [await box(rowButton), await box(rowButton.locator('.chev'))];
  expect(chevBox.x + chevBox.width).toBeGreaterThanOrEqual(btnBox.x + btnBox.width - 4);
}

async function setupRoutes(page: Page, look: Look): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) errors.push(msg.text()); });
  page.on('response', res => { if (res.url().includes('/api/') && res.status() >= 400) errors.push(`${res.status()} ${res.url()}`); });
  await page.clock.install({ time: NOW });
  await page.setViewportSize({ width: look.width, height: 900 });
  await page.addInitScript(({ lang, skin, dir }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, look);
  await serveTasksBoard(page);
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.29.0', commit: 'task-1018' } }));
  await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.29.0', commit: 'task-1018' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
  await page.route('**/api/wait-cards*', route => route.fulfill({ json: { cards: [], next: null } }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: MACHINES, builtin: BUILTIN, priority: true, move: null, canMove: false, copies: null } }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
  await page.route('**/api/people', route => route.fulfill({ json: { people: PEOPLE } }));
  await page.route(`**/api/departments/${DEV.id}/backlog`, route => route.fulfill({ json: { items: BACKLOG_ITEMS } }));
  return errors;
}

async function checkMachines(page: Page, info: TestInfo, t: Messages, tag: string, browserName: string, dir: 'ltr' | 'rtl'): Promise<Measured> {
  await page.goto('/');
  await page.evaluate(d => { document.documentElement.dir = d; }, dir);
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.machines, exact: true }).click();
  const section = page.locator('section.machines');
  await expect(section.locator('tr.rm')).toHaveCount(MACHINES.length);
  await page.evaluate(() => document.fonts.ready);

  expect(await brokenTargets(section)).toEqual([]);
  expect(await brokenFilterWords(section)).toEqual([]);
  expect(await brokenHeaderWords(page)).toEqual([]);
  expect(await tableFits(page)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await checkMachineFilters(page, section, t, dir);

  const pieces = {
    head: '.people-head', pool: '.pool', tools: '.tools', filterGroup: '.fgroup', filterChip: '.fgroup .chipf',
    thead: '.dt > thead', sortbar: '.sortbar', row: 'tr.rm', sortHeader: 'thead .sorth', sortButton: '.sortbar .sortb', rowButton: '.rowbtn',
  };
  const allSizes = await sizes(section, pieces);
  delete allSizes['part height'];
  delete allSizes['part width'];
  const measured: Measured = { browser: browserName, look: tag, screen: 'machines', sizes: allSizes };
  await wholePage(page, info.outputPath(`machines-list-${tag}-${browserName}.png`));

  const filterChip = section.locator('.fgroup .chipf').first();
  const sortControl = (await section.locator('thead').isVisible()) ? section.locator('button.sorth').first() : section.locator('button.sortb').first();
  const rowButton = section.locator('tr.rm').first().locator('button.rowbtn');
  await checkKeyboardFocus(page, filterChip, info.outputPath(`machines-filter-focus-${tag}-${browserName}.png`));
  await checkKeyboardFocus(page, sortControl, info.outputPath(`machines-header-focus-${tag}-${browserName}.png`));
  await checkKeyboardFocus(page, rowButton, info.outputPath(`machines-row-focus-${tag}-${browserName}.png`));
  if (dir === 'rtl') await checkRtlChevron(rowButton);
  return measured;
}

async function checkPeople(page: Page, info: TestInfo, t: Messages, tag: string, browserName: string, dir: 'ltr' | 'rtl'): Promise<Measured> {
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.people, exact: true }).click();
  const section = page.locator('section.people');
  await expect(section.locator('.ptable > tbody > tr')).toHaveCount(PEOPLE.length);
  await page.evaluate(() => document.fonts.ready);

  expect(await section.locator('.fit').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const measured: Measured = { browser: browserName, look: tag, screen: 'people', sizes: await sizes(section, { head: '.people-head', table: '.fit' }) };
  await wholePage(page, info.outputPath(`people-list-${tag}-${browserName}.png`));
  if (dir === 'rtl') expect(await section.evaluate(el => getComputedStyle(el).direction)).toBe('rtl');
  return measured;
}

async function checkBacklog(page: Page, info: TestInfo, t: Messages, tag: string, browserName: string, dir: 'ltr' | 'rtl'): Promise<Measured> {
  await page.goto('/tasks');
  await page.evaluate(d => { document.documentElement.dir = d; }, dir);
  const view = page.getByRole('group', { name: t.tasks.board.view });
  await view.getByRole('radio', { name: t.tasks.board.views.releases }).check({ force: true });
  await page.getByRole('combobox', { name: t.tasks.department }).selectOption({ label: 'Development' });
  const backlog = page.locator('section.backlog');
  await expect(backlog.locator('tr.bl-row')).toHaveCount(BACKLOG_ITEMS.length);
  await page.evaluate(() => document.fonts.ready);

  expect(await brokenTargets(backlog)).toEqual([]);
  expect(await brokenHeaderWords(page)).toEqual([]);
  expect(await tableFits(page)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const measured: Measured = { browser: browserName, look: tag, screen: 'backlog', sizes: await sizes(backlog, { table: '.tbl', row: 'tr.bl-row', rowButton: '.rowbtn' }) };
  await backlog.screenshot({ path: info.outputPath(`backlog-list-${tag}-${browserName}.png`) });

  const rowButton = backlog.locator('tr.bl-row').first().locator('button.rowbtn');
  await checkKeyboardFocus(page, rowButton, info.outputPath(`backlog-row-focus-${tag}-${browserName}.png`));
  if (dir === 'rtl') await checkRtlChevron(rowButton);
  return measured;
}

for (const look of LOOKS) {
  const tag = `${look.lang}-${look.skin}-${look.width}-${look.dir}`;
  test(`keeps 44px targets, focus rings and 1px cross-browser sizes on Machines, People and Backlog, ${tag}`, async ({ page, browserName }, info) => {
    const t = MESSAGES[look.lang];
    const errors = await setupRoutes(page, look);
    const measured = [
      await checkMachines(page, info, t, tag, browserName, look.dir),
      await checkPeople(page, info, t, tag, browserName, look.dir),
      await checkBacklog(page, info, t, tag, browserName, look.dir),
    ];
    writeFileSync(info.outputPath('sizes.json'), JSON.stringify(measured));
    expect(errors).toEqual([]);
  });
}
