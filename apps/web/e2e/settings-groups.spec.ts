import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { LANGUAGES } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { builtinSkin } from '../src/skins/registry';
import { builtinFile, skinText } from '../src/skins/validate';
import type { VaultEntry } from '../src/ui/Vault';
import { ME, serveApi } from './api';
import { cutByNavigation } from './look-steps';

/* The short account menu, Settings as Design's variant A draws it (Profile first, then five groups) and About with
   writing to the developers, as a person meets them: in a light and a dark skin, in the longest and the shortest shipped
   language and right to left, at the widths of a desktop, a laptop, a small laptop and a phone. Every group keeps its
   parts on one shared edge and its buttons on the end edge of the column, every field, list and button is a 44 px target,
   no word breaks where it would fit a line of its own, nothing runs off the screen, and a picture of each look is kept. */

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const WIDTHS = [1440, 1280, 1024, 375];
/* Light, and Cyberpunk, the dark default. */
const SKINS = ['light', 'cyberpunk'];
/* Russian runs longer than English on these screens. */
const LANGS = ['en', 'ru'] as const;
/* No shipped language is written right to left yet, so English is also laid out mirrored, on Settings. */
const RTL_WIDTHS = [1440, 375];
/* The parts of the window in their order, each at its address: Appearance & language at /settings itself. */
const GROUPS = [
  { id: 'profile', path: '/settings/profile' },
  { id: 'appearance', path: '/settings' },
  { id: 'integrations', path: '/settings/integrations' },
  { id: 'passwords', path: '/settings/passwords' },
  { id: 'company', path: '/settings/company' },
] as const;
type GroupId = (typeof GROUPS)[number]['id'];
const SHOTS = process.env.SHOTS;

const GOOGLE = { kind: 'service_account', account: 'sheets-bot@acme.iam.gserviceaccount.com', shareEmail: 'ivan@acme.com', keyLast4: '9876' };
const EMPTY_VAULT: { entries: VaultEntry[] } = { entries: [] };
const FORBIDDEN = { status: 403, json: { error: { code: 'forbidden', message: 'Forbidden.' } } };
/* A person who sees only some departments: no company link, no backups, no company keys. */
const LISTED = { ...ME, person: { ...ME.person, name: 'Lisa', email: 'lisa@acme.com', title: 'Designer', scopeKind: 'listed', isOwner: false } };

async function prepare(page: Page, lang: string, skin: string, width: number, person: 'whole' | 'listed' = 'whole'): Promise<string[]> {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.addInitScript(({ lang, skin }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
  }, { lang, skin });
  const problems: string[] = [];
  page.on('pageerror', error => { if (!cutByNavigation(page, error)) problems.push(error.message); });
  /* The updates the CEO's banner asks for are left unanswered, as the server of a test gives none; a person without the
     whole company is refused what is not theirs, as the server does. */
  const refused = person === 'listed' ? ['/api/google-sheets', '/api/repo-host'] : [];
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/') && path !== '/api/updates' && !refused.includes(path) && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  await serveApi(page);
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.24.0', commit: 'c6bd5a8', migrations: 1 } }));
  await page.route('**/api/updates/current', route => route.fulfill({ json: { version: '0.24.0', commit: 'c6bd5a8' } }));
  await page.route('**/api/vault', route => route.fulfill({ json: EMPTY_VAULT }));
  await page.route('**/api/link', route => route.fulfill({ json: { link: { name: 'acme', url: 'https://acme.hornhoof.org' }, domain: 'hornhoof.org' } }));
  if (person === 'listed') {
    await page.route('**/api/me', route => route.fulfill({ json: LISTED }));
    for (const path of refused) await page.route(`**${path}`, route => route.fulfill(FORBIDDEN));
  } else {
    await page.route('**/api/google-sheets', route => route.fulfill({ json: { google: GOOGLE } }));
  }
  return problems;
}

/* Turns the page right to left, as a language written that way would. */
async function direction(page: Page, dir: string) {
  await page.evaluate(value => { document.documentElement.dir = value; }, dir);
}

/* A picture of the whole window: the page is made as tall as what the window holds, its heading and its whole body, then
   given back its height. */
async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const viewport = page.viewportSize()!;
  const content = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll<HTMLElement>('.dialog')].map(box => { const body = box.querySelector<HTMLElement>('.settings-scroll'); return body ? box.getBoundingClientRect().height - body.clientHeight + body.scrollHeight : box.scrollHeight; })));
  /* A window can end between pixels, and a page is a whole number of them. */
  if (content + 64 > viewport.height) await page.setViewportSize({ width: viewport.width, height: Math.ceil(content + 64) });
  const file = `${name}-${info.project.name}.png`;
  await page.screenshot({ path: SHOTS ? `${SHOTS}/${file}` : info.outputPath(file), animations: 'disabled' });
  await page.setViewportSize(viewport);
}

/* What Design checks on the open group, measured on what is drawn. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const rtl = document.documentElement.dir === 'rtl';
    const dialog = document.querySelector<HTMLElement>('.settings-window')!;
    const main = dialog.querySelector('.settings-main')!.getBoundingClientRect();
    const group = dialog.querySelector<HTMLElement>('.sgroup')!;
    const shown = (element: Element) => element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility !== 'hidden';
    const end = (box: DOMRect) => (rtl ? box.left : box.right);
    const say = (element: Element) => `${element.tagName.toLowerCase()}.${element.className} "${element.textContent?.trim().slice(0, 30)}"`;
    const parts = [...dialog.querySelectorAll<HTMLElement>('.settings-main > .sgroup > *, .sgroup > :is(.settings-group, .integrations) > *')].filter(shown);
    const off = parts.filter(part => {
      const box = part.getBoundingClientRect();
      return Math.abs(box.left - main.left) > 1 || Math.abs(box.right - main.right) > 1;
    }).map(say);
    const targets = [...dialog.querySelectorAll('.settings-nav .btn, .settings-window > header .btn')];
    targets.push(...group.querySelectorAll('.btn, select, input:not([type="checkbox"], [type="radio"], [type="file"])'));
    const small = targets.filter(shown).filter(target => Math.round(target.getBoundingClientRect().height) < 44).map(say);
    /* The last button of each row of actions ends where the column ends; on a skin's card, where the card's content ends. */
    const edge: string[] = [];
    for (const row of group.querySelectorAll(':is(.settings-actions, .repo-actions, .skins-add)')) {
      const buttons = [...row.querySelectorAll(':scope > .btn, :scope > .entry-actions > .btn')].filter(shown);
      const last = buttons.at(-1);
      if (last && Math.abs(end(last.getBoundingClientRect()) - end(main)) > 1) edge.push(say(last));
    }
    for (const card of group.querySelectorAll<HTMLElement>('.skin-card')) {
      const last = [...card.querySelectorAll('.skin-actions > .btn')].at(-1);
      const box = card.getBoundingClientRect();
      const inner = rtl ? box.left + 13 : box.right - 13;
      if (last && Math.abs(end(last.getBoundingClientRect()) - inner) > 1) edge.push(say(last));
    }
    /* A word broken over two lines although it would fit a line of its own. */
    const broken: string[] = [];
    const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement!;
      if (parent.closest('select, option, textarea') || !shown(parent)) continue;
      const room = parent.getBoundingClientRect().width;
      const text = node.textContent ?? '';
      for (const match of text.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
        const lines = new Set(rects.map(rect => Math.round(rect.top)));
        const width = rects.reduce((sum, rect) => sum + rect.width, 0);
        if (lines.size > 1 && width <= room) broken.push(match[0]);
      }
    }
    const nav = dialog.querySelector('.settings-nav')!.getBoundingClientRect();
    return {
      pageScroll: document.documentElement.scrollWidth > innerWidth,
      windowScroll: dialog.scrollWidth > dialog.clientWidth,
      parts: parts.length,
      off,
      small,
      edge,
      broken,
      navStart: rtl ? nav.right >= main.right : nav.left <= main.left,
    };
  });
}

/* The skins' grid: how many columns its cards stand in, and the width it has. */
async function skinGrid(page: Page) {
  return page.evaluate(() => {
    const wrap = document.querySelector('.skin-wrap')!.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.skin-card')].map(card => card.getBoundingClientRect());
    return { room: wrap.width, columns: new Set(cards.map(card => Math.round(card.left))).size, widths: cards.map(card => Math.round(card.width * 100) / 100), lastWidth: cards.at(-1)!.width };
  });
}

async function openGroup(page: Page, t: Messages, group: GroupId, path: string, dir: string, shown: readonly GroupId[]) {
  await page.goto(path);
  await direction(page, dir);
  const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
  const nav = dialog.getByRole('navigation', { name: t.settings.groupsLabel, exact: true });
  await expect(nav.getByRole('button')).toHaveText(shown.map(id => t.settings.groups[id]));
  await expect(nav.getByRole('button', { name: t.settings.groups[group], exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(dialog.getByRole('heading', { name: t.settings.groups[group], level: 3, exact: true })).toBeVisible();
  const found = await navigation(page);
  expect(found.current, `${group} ${dir}: only the open group is the current page`).toEqual([t.settings.groups[group]]);
  expect(found.marked, `${group} ${dir}: the open group stands out in the list`).toEqual([]);
  expect(found.headingFirst, `${group} ${dir}: the open group's heading stands at its top`).toBe(true);
  expect(found.cut, `${group} ${dir}: no item of the list is cut`).toEqual([]);
  expect(found.broken, `${group} ${dir}: no word of an item breaks`).toEqual([]);
  if (found.narrow) expect(found.rows, `${group} ${dir}: at a phone width the items stand in rows`).toBeGreaterThan(1);
  return dialog;
}

/* Design took one group at a time on three conditions (#970, finding 3): the open item stands out and is the current
   page, the heading of the open group stands at the top of the window's body, beside the list or under it, and at a
   phone's width the items wrap in rows of whole words. */
async function navigation(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('.settings-nav')!;
    const items = [...nav.querySelectorAll<HTMLElement>('.btn')];
    const open = items.filter(item => item.getAttribute('aria-current') === 'page');
    const style = (item: Element) => getComputedStyle(item);
    const look = (item: Element) => `${style(item).backgroundColor} ${style(item).color} ${style(item).borderInlineStartColor} ${style(item).boxShadow}`;
    const marked = open.flatMap(item => items.filter(other => other !== item && look(other) === look(item)).map(other => other.textContent ?? ''));
    const body = document.querySelector('.settings-scroll')!;
    const heading = document.querySelector<HTMLElement>('.sgroup > .g-head > h3')!;
    const group = document.querySelector('.sgroup')!;
    const top = heading.getBoundingClientRect().top;
    const narrow = innerWidth <= 760;
    const navBox = nav.getBoundingClientRect();
    const headingFirst = group.firstElementChild?.firstElementChild === heading && body.scrollTop === 0
      && (narrow ? top >= navBox.bottom && top - navBox.bottom <= 24 : Math.abs(top - navBox.top) <= 1);
    const broken: string[] = [];
    for (const item of items) {
      const range = document.createRange();
      range.selectNodeContents(item);
      const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
      const words = (item.textContent ?? '').split(/\s+/).filter(Boolean);
      if (lines.size > words.length) broken.push(item.textContent ?? '');
    }
    return {
      current: open.map(item => item.textContent ?? ''),
      marked: marked.concat(open.length ? [] : ['none']),
      headingFirst,
      cut: items.filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.textContent ?? ''),
      broken,
      narrow,
      rows: new Set(items.map(item => Math.round(item.getBoundingClientRect().top))).size,
    };
  });
}

const ALL: readonly GroupId[] = GROUPS.map(group => group.id);

/* The pink buttons of the open group, each with whether its words are --pink-ink and it is last of its row, and its
   filled buttons, each with whether it is filled with --btn. */
async function tonesOf(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const token = (name: string, property: 'color' | 'backgroundColor') => {
      probe.style.cssText = property === 'color' ? `color: var(${name})` : `background-color: var(${name})`;
      return getComputedStyle(probe)[property];
    };
    const pink = token('--pink-ink', 'color');
    const fill = token('--btn', 'backgroundColor');
    probe.remove();
    const group = document.querySelector('.sgroup')!;
    const words = (button: Element) => button.textContent?.trim() ?? '';
    return {
      danger: [...group.querySelectorAll('.btn.danger')].map(button => [words(button), getComputedStyle(button).color === pink, button.parentElement!.lastElementChild === button]),
      main: [...group.querySelectorAll('.btn:not(.ghost)')].map(button => [words(button), getComputedStyle(button).backgroundColor === fill]),
    };
  });
}

/* Checks a group the person has, and waits for what it holds. */
async function checkGroup(page: Page, t: Messages, group: GroupId, look: string) {
  const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
  if (group === 'profile') await expect(dialog.getByRole('textbox', { name: t.common.name, exact: true })).toBeVisible();
  if (group === 'appearance') {
    const list = dialog.getByRole('combobox', { name: t.language.title, exact: true });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveText(LANGUAGES.map(language => language.name));
    const box = (await list.boundingBox())!;
    const room = await list.evaluate(element => element.parentElement!.parentElement!.getBoundingClientRect().width);
    expect(Math.abs(box.height - 44), `${look}: the list is 44 px high`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.width - Math.min(360, room)), `${look}: the list is as wide as its place, at most 360 px`).toBeLessThanOrEqual(1);
    const gaps = await dialog.locator('.lang-part').evaluate(part => {
      const [heading, hint, wrap] = [part.querySelector('h4')!, part.querySelector(':scope > p')!, part.querySelector('.select-wrap')!].map(element => element.getBoundingClientRect());
      return [Math.round((hint!.top - heading!.bottom) * 10) / 10, Math.round((wrap!.top - hint!.bottom) * 10) / 10];
    });
    expect(gaps, `${look}: the hint 4 px under the heading, the list 8 px under the hint`).toEqual([4, 8]);
    const grid = await skinGrid(page);
    expect(grid.columns, `${look}: ${grid.room} px of room`).toBe(grid.room >= 560 ? 2 : 1);
    await expect(dialog.locator('.skin-card[data-current]').getByText(t.skins.applied, { exact: true })).toBeVisible();
    await expect(dialog.locator('.skin-card .btn:not(.ghost)')).toHaveCount(0);
  }
  if (group === 'integrations') {
    await expect(dialog.getByRole('article', { name: t.googleSheets.title, exact: true }).getByText(t.integrations.connected, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('article', { name: t.repoHost.title, exact: true }).getByText(t.integrations.notConnected, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('article')).toHaveCount(2);
    const tones = await tonesOf(page);
    expect(tones.danger, `${look}: Disconnect is pink, last of its row`).toEqual([[t.googleSheets.remove, true, true]]);
    expect(tones.main, `${look}: Save a key, the one action of a record with no key, is the main button`).toEqual([[t.repoHost.save, true]]);
  }
  if (group === 'passwords') await expect(dialog.getByText(t.vault.none, { exact: true })).toBeVisible();
  if (group === 'company') {
    await expect(dialog.getByRole('link', { name: 'https://acme.hornhoof.org', exact: true })).toBeVisible();
    expect((await tonesOf(page)).danger, `${look}: Remove link is pink, last of its row`).toEqual([[t.settings.remove, true, true]]);
    await expect(dialog.getByRole('heading', { name: t.repoHost.title, exact: true })).toHaveCount(0);
  }
  const found = await layout(page);
  expect(found.pageScroll, `${look}: the page does not scroll sideways`).toBe(false);
  expect(found.windowScroll, `${look}: the window does not scroll sideways`).toBe(false);
  expect(found.parts, `${look}: the group has parts`).toBeGreaterThan(0);
  expect(found.off, `${look}: every part on the shared edge`).toEqual([]);
  expect(found.small, `${look}: 44 px targets`).toEqual([]);
  expect(found.edge, `${look}: buttons on the end edge`).toEqual([]);
  expect(found.broken, `${look}: no word broken that fits a line`).toEqual([]);
  expect(found.navStart, `${look}: the groups stand at the start`).toBe(true);
}

for (const skin of SKINS) for (const lang of LANGS) for (const width of WIDTHS) {
  const look = `${lang}-ltr-${skin}-${width}`;
  test(`the short menu, Settings with Profile first and its five groups, and About: ${look}`, async ({ page }, info) => {
    test.setTimeout(0);
    const t = MESSAGES[lang];
    const problems = await prepare(page, lang, skin, width);
    await page.goto('/');
    await page.getByRole('button', { name: t.shell.account, exact: true }).click();
    const menu = page.locator('.account-menu');
    await expect(menu.getByRole('button')).toHaveText([t.firstContact.title, t.settings.menu, new RegExp(`^${t.shell.tabs.improvements}`), t.updates.menu, t.about.menu, t.shell.logOut]);
    await expect(menu.getByRole('group')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, info, `menu-${look}`);
    /* The menu's Settings opens the window on Profile. */
    await menu.getByRole('button', { name: t.settings.menu, exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/profile$/);
    for (const { id, path } of GROUPS) {
      await openGroup(page, t, id, path, 'ltr', ALL);
      await checkGroup(page, t, id, `${look} ${id}`);
      await shot(page, info, `settings-${id}-${look}`);
    }
    await page.goto('/about');
    const about = page.getByRole('dialog', { name: t.about.title, exact: true });
    await expect(about.getByRole('region', { name: t.feedback.section, exact: true }).getByRole('button', { name: t.feedback.write, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await about.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await shot(page, info, `about-${look}`);
    expect(problems).toEqual([]);
  });
}

for (const skin of SKINS) for (const width of RTL_WIDTHS) {
  const look = `en-rtl-${skin}-${width}`;
  test(`Settings mirrored right to left, Profile first and five groups: ${look}`, async ({ page }, info) => {
    test.setTimeout(0);
    const problems = await prepare(page, 'en', skin, width);
    for (const { id, path } of GROUPS) {
      await openGroup(page, en, id, path, 'rtl', ALL);
      await checkGroup(page, en, id, `${look} ${id}`);
      await shot(page, info, `settings-${id}-${look}`);
    }
    expect(problems).toEqual([]);
  });
}

for (const skin of SKINS) for (const { lang, dir } of [{ lang: 'en', dir: 'ltr' }, { lang: 'ru', dir: 'ltr' }, { lang: 'en', dir: 'rtl' }] as const) for (const width of RTL_WIDTHS) {
  const look = `${lang}-${dir}-${skin}-${width}`;
  test(`the language list with its focus ring, and open, each language named in itself: ${look}`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    const problems = await prepare(page, lang, skin, width);
    const dialog = await openGroup(page, t, 'appearance', '/settings', dir, ALL);
    const list = dialog.getByRole('combobox', { name: t.language.title, exact: true });
    await list.focus();
    expect(await list.evaluate(element => { const style = getComputedStyle(element); return `${style.outlineWidth} ${style.outlineStyle} ${style.outlineOffset}`; })).toBe('2px solid 2px');
    const part = dialog.locator('.lang-part');
    const file = (name: string) => `${name}-${look}-${info.project.name}.png`;
    await part.screenshot({ path: SHOTS ? `${SHOTS}/${file('settings-lang-focus')}` : info.outputPath(file('settings-lang-focus')), animations: 'disabled' });
    /* The open list is drawn by the browser or the system and no script can take its picture; the same list is shown
       open as a list box, every language on its own line, as Design shows it. */
    await page.addStyleTag({ content: '.select-wrap::after { display: none; } .lang-select[size] { block-size: auto; padding: 0; line-height: 1.45; } .lang-select[size] option { padding: 8px 12px; }' });
    await expect(list.getByRole('option')).toHaveText(LANGUAGES.map(language => language.name));
    expect(await list.getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('lang')))).toEqual(LANGUAGES.map(language => language.id));
    await list.evaluate((element, size) => { (element as HTMLSelectElement).size = size; }, LANGUAGES.length);
    await part.screenshot({ path: SHOTS ? `${SHOTS}/${file('settings-lang-open')}` : info.outputPath(file('settings-lang-open')), animations: 'disabled' });
    expect(problems).toEqual([]);
  });
}

for (const skin of SKINS) for (const width of RTL_WIDTHS) {
  const look = `ru-ltr-${skin}-${width}`;
  test(`a person without the whole company has Profile and only the groups the server gives them: ${look}`, async ({ page }, info) => {
    test.setTimeout(0);
    const t = ru;
    const problems = await prepare(page, 'ru', skin, width, 'listed');
    await page.goto('/');
    await page.getByRole('button', { name: t.shell.account, exact: true }).click();
    await expect(page.locator('.account-menu').getByRole('button')).toHaveText([t.firstContact.title, t.settings.menu, t.about.menu, t.shell.logOut]);
    await shot(page, info, `menu-person-${look}`);
    const shown: GroupId[] = ['profile', 'appearance', 'passwords'];
    for (const id of shown) {
      await openGroup(page, t, id, GROUPS.find(group => group.id === id)!.path, 'ltr', shown);
      await checkGroup(page, t, id, `${look} ${id}`);
      await shot(page, info, `settings-person-${id}-${look}`);
    }
    /* Company & access would be empty for them: it is not in the list, and its address says so. */
    await page.goto('/settings/company');
    const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
    await expect(dialog.getByRole('navigation', { name: t.settings.groupsLabel, exact: true }).getByRole('button')).toHaveText(shown.map(id => t.settings.groups[id]));
    await expect(dialog.getByRole('heading', { name: t.routes.accessDenied, exact: true })).toBeVisible();
    expect(problems).toEqual([]);
  });
}

for (const skin of SKINS) for (const width of RTL_WIDTHS) {
  const look = `ru-ltr-${skin}-${width}`;
  test(`odd last card takes the whole row, no card has a filled button: ${look}`, async ({ page }, info) => {
    const problems = await prepare(page, 'ru', skin, width);
    const dialog = await openGroup(page, ru, 'appearance', '/settings', 'ltr', ALL);
    const initial = await skinGrid(page);
    expect(initial.widths).toHaveLength(5);
    expect(Math.abs(initial.lastWidth - initial.room), `${look}: the fifth card takes the row`).toBeLessThanOrEqual(1);
    const dusk = builtinFile(builtinSkin('cyberpunk')!, { ru: 'Сумерки', en: 'Dusk' });
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'dusk.json', mimeType: 'application/json', buffer: Buffer.from(skinText(dusk)) });
    await expect(dialog.getByRole('status')).toHaveText(ru.skins.added('Сумерки'));
    const grid = await skinGrid(page);
    expect(grid.widths).toHaveLength(6);
    await expect(dialog.locator('.skin-card .btn:not(.ghost)')).toHaveCount(0);
    await checkGroup(page, ru, 'appearance', `${look} six skins`);
    await shot(page, info, `settings-skins-6-${look}`);
    expect(problems).toEqual([]);
  });
}
