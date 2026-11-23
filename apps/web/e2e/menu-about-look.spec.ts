import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { FeedbackShown, Improvement } from '../src/types';
import { ME, serveApi } from './api';
import { cutByNavigation } from './look-steps';

/* The short account menu and About with writing to the developers, as Design's reference draws them (#970, findings 1 to
   7 and 10): menu rows are lines of the panel 44 px high in groups with a line between them, About is 480 px with a 44 px
   cross and Feedback closed until opened, and what each engine draws is measured, so the engines can be compared within
   1 px. A picture of each look is kept, in the folder SHOTS names when it is set. */

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const SKINS = ['light', 'cyberpunk'];
const WIDTHS = [1440, 375];
const SHOTS = process.env.SHOTS;

const OPEN: Improvement = {
  id: 'i1', title: 'Check card numbers before sending them', text: 'The card form sends numbers the bank turns down.', seen: 2, status: 'open', result: null,
  at: '2026-11-15T08:00:00.000Z', updatedAt: '2026-11-15T09:00:00.000Z', agent: { id: 'b1', name: 'Bruno' }, department: { id: 'd2', name: 'Development' },
  decidedBy: null, tasks: [], parts: null, scope: 'company', code: null,
};
const SHOWN: FeedbackShown = {
  report: { kind: 'bug', title: 'The menu closes too soon', text: 'On a phone the menu closes on a swipe.', facts: { version: '0.24.1', platform: ['linux x64', 'darwin arm64'], errorCode: null } },
  hidden: { secret: 0, email: 1, address: 0, path: 0 },
  digest: 'd'.repeat(64),
};
const LISTED = { ...ME, person: { ...ME.person, name: 'Lisa', email: 'lisa@acme.com', scopeKind: 'listed', isOwner: false } };

type Look = { lang: 'en' | 'ru'; skin: string; width: number; dir?: 'ltr' | 'rtl'; person?: 'whole' | 'listed' };

/* The answers of the server: the whole company's menu with every row it can have, or a listed person's. */
async function prepare(page: Page, { lang, skin, width, person = 'whole' }: Look): Promise<string[]> {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.addInitScript(({ lang, skin }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
  }, { lang, skin });
  const problems: string[] = [];
  page.on('pageerror', error => { if (!cutByNavigation(page, error)) problems.push(error.message); });
  await serveApi(page);
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.24.1', commit: 'b3a32a3', migrations: 1 } }));
  await page.route('**/api/updates/current', route => route.fulfill({ json: { version: '0.24.1', commit: 'b3a32a3' } }));
  await page.route('**/api/feedback/preview', route => route.fulfill({ json: SHOWN }));
  if (person === 'listed') {
    await page.route('**/api/me', route => route.fulfill({ json: LISTED }));
  } else {
    await page.route('**/api/feedback', route => route.fulfill({ json: { inbox: true } }));
    await page.route('**/api/improvements', route => route.fulfill({ json: { improvements: [OPEN, { ...OPEN, id: 'i2' }, { ...OPEN, id: 'i3' }] } }));
  }
  return problems;
}

const lookName = ({ lang, skin, width, dir = 'ltr', person = 'whole' }: Look) => `${person === 'listed' ? 'person-' : ''}${lang}-${dir}-${skin}-${width}`;

async function direction(page: Page, dir: string) {
  await page.evaluate(value => { document.documentElement.dir = value; }, dir);
}

function where(info: TestInfo, name: string) {
  const file = `${name}-${info.project.name}.png`;
  return SHOTS ? `${SHOTS}/${file}` : info.outputPath(file);
}

/* A picture of the page, made as tall as the open dialog when it is taller than the screen. */
async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const viewport = page.viewportSize()!;
  const content = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll<HTMLElement>('.dialog')].map(box => box.scrollHeight)));
  if (content + 64 > viewport.height) await page.setViewportSize({ width: viewport.width, height: content + 64 });
  await page.screenshot({ path: where(info, name), animations: 'disabled' });
  await page.setViewportSize(viewport);
}

/* What a check found, kept beside the pictures for Design. */
function keep(info: TestInfo, name: string, body: unknown) {
  const path = SHOTS ? `${SHOTS}/checks/${name}-${info.project.name}.json` : info.outputPath(`${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
}

async function openMenu(page: Page, t: Messages) {
  await page.goto('/');
  await page.getByRole('button', { name: t.shell.account, exact: true }).click();
  const menu = page.locator('.account-menu');
  await expect(menu).toBeVisible();
  return menu;
}

/* The menu as drawn: its panel, each row with where its words start and end and its frame, each line, and words broken. */
async function menuLayout(menu: Locator) {
  return menu.evaluate(panel => {
    const rtl = getComputedStyle(panel).direction === 'rtl';
    const round = (value: number) => Math.round(value * 100) / 100;
    const box = panel.getBoundingClientRect();
    const inner = box.width - 2 - 12;
    const rows = [...panel.querySelectorAll<HTMLElement>('.mi')].map(row => {
      const r = row.getBoundingClientRect();
      const words = row.firstElementChild!.getBoundingClientRect();
      const count = row.querySelector('.nav-count')?.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        text: row.firstElementChild!.textContent ?? '',
        height: round(r.height), width: round(r.width), inner: round(inner),
        start: round(rtl ? r.right - words.right : words.left - r.left),
        countEnd: count ? round(rtl ? count.left - r.left : r.right - count.right) : null,
        border: style.borderTopWidth, align: style.textAlign, font: `${style.fontWeight} ${style.fontSize}`,
      };
    });
    const seps = [...panel.querySelectorAll('hr.am-sep')].map(sep => {
      const style = getComputedStyle(sep);
      return { height: round(sep.getBoundingClientRect().height), margin: `${style.marginTop} ${style.marginBottom}`, line: `${style.borderTopWidth} ${style.borderTopStyle}` };
    });
    const order = [...panel.children].map(child => (child.matches('hr') ? '—' : child.matches('.am-head') ? 'head' : child.firstElementChild?.textContent ?? ''));
    const broken: string[] = [];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const room = node.parentElement!.getBoundingClientRect().width;
      for (const match of (node.textContent ?? '').matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
        if (new Set(rects.map(rect => Math.round(rect.top))).size > 1 && rects.reduce((sum, rect) => sum + rect.width, 0) <= room) broken.push(match[0]);
      }
    }
    return { panel: { left: round(box.left), right: round(box.right), width: round(box.width) }, rows, seps, order, broken, pageScroll: document.documentElement.scrollWidth > innerWidth };
  });
}

function checkMenu(found: Awaited<ReturnType<typeof menuLayout>>, width: number, look: string) {
  expect(Math.abs(found.panel.width - Math.min(280, width - 32)), `${look}: the panel is 280 px or the screen less 32 px`).toBeLessThanOrEqual(0.5);
  expect(found.panel.left, `${look}: the panel stays on the screen`).toBeGreaterThanOrEqual(0);
  expect(found.panel.right, `${look}: the panel stays on the screen`).toBeLessThanOrEqual(width);
  expect(found.pageScroll, `${look}: the page does not scroll sideways`).toBe(false);
  for (const row of found.rows) {
    expect(Math.round(row.height), `${look} "${row.text}": a row is 44 px or taller`).toBeGreaterThanOrEqual(44);
    expect(Math.abs(row.width - row.inner), `${look} "${row.text}": a row takes the whole panel`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(row.start - 12), `${look} "${row.text}": its words start 12 px in`).toBeLessThanOrEqual(1);
    if (row.countEnd !== null) expect(Math.abs(row.countEnd - 12), `${look} "${row.text}": its count ends 12 px in`).toBeLessThanOrEqual(1);
    expect([row.border, row.align, row.font], `${look} "${row.text}": no frame, words at the start, 500 14 px`).toEqual(['0px', 'start', '500 14px']);
  }
  for (const sep of found.seps) expect([sep.height, sep.margin, sep.line], `${look}: a line of 1 px, 6 px above and below`).toEqual([1, '6px 6px', '1px solid']);
  expect(found.broken, `${look}: no word broken that fits a line`).toEqual([]);
}

const WHOLE_ORDER = (t: Messages) => ['head', '\u2014', t.firstContact.title, t.settings.menu, '\u2014', t.shell.tabs.improvements, t.inbox.menu, t.updates.menu, '\u2014', t.about.menu, t.shell.logOut];
const LISTED_ORDER = (t: Messages) => ['head', '—', t.firstContact.title, t.settings.menu, '—', t.about.menu, t.shell.logOut];

const LOOKS: Look[] = [
  ...SKINS.flatMap(skin => (['en', 'ru'] as const).flatMap(lang => WIDTHS.map(width => ({ lang, skin, width })))),
  ...SKINS.flatMap(skin => WIDTHS.map(width => ({ lang: 'en' as const, skin, width, dir: 'rtl' as const }))),
];

for (const look of LOOKS) {
  const name = lookName(look);
  test(`the menu with every row it can have, and the menu of a person who sees only some departments: ${name}`, async ({ page }, info) => {
    const t = MESSAGES[look.lang];
    const problems = await prepare(page, look);
    let menu = await openMenu(page, t);
    await direction(page, look.dir ?? 'ltr');
    await expect(menu.getByRole('button', { name: t.improvements.nav(3), exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: t.inbox.menu, exact: true })).toBeVisible();
    const found = await menuLayout(menu);
    expect(found.order, name).toEqual(WHOLE_ORDER(t));
    checkMenu(found, look.width, name);
    await shot(page, info, `menu-${name}`);

    const listed = await page.context().newPage();
    const more = await prepare(listed, { ...look, person: 'listed' });
    menu = await openMenu(listed, t);
    await direction(listed, look.dir ?? 'ltr');
    const alone = await menuLayout(menu);
    expect(alone.order, `${name} listed`).toEqual(LISTED_ORDER(t));
    checkMenu(alone, look.width, `${name} listed`);
    await shot(listed, info, `menu-person-${name}`);
    await listed.close();
    expect([...problems, ...more]).toEqual([]);
  });

  test(`About as the reference draws it, Feedback closed: ${name}`, async ({ page }, info) => {
    const t = MESSAGES[look.lang];
    const problems = await prepare(page, look);
    await page.goto('/about');
    await direction(page, look.dir ?? 'ltr');
    const dialog = page.getByRole('dialog', { name: t.about.title, exact: true });
    await expect(dialog.getByText('0.24.1 (b3a32a3)', { exact: true })).toBeVisible();
    const feedback = dialog.getByRole('region', { name: t.feedback.section, exact: true });
    await expect(feedback.getByRole('button', { name: t.feedback.write, exact: true })).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    const found = await aboutLayout(dialog);
    expect(Math.abs(found.width - Math.min(480, look.width - 32)), `${name}: 480 px or the screen less 32 px`).toBeLessThanOrEqual(0.5);
    expect([Math.round(found.cross.width), Math.round(found.cross.height)], `${name}: a 44 px cross`).toEqual([44, 44]);
    expect(found.crossAtEnd, `${name}: the cross on the end edge`).toBe(true);
    expect(found.fonts, `${name}: 14 px text, 13.5 px facts, 12 px author`).toEqual([14, 13.5, 12]);
    expect(Math.abs(found.room - 18), `${name}: 18 px of room for a scrollbar at its end`).toBeLessThanOrEqual(0.5);
    expect(found.writeAtEnd, `${name}: Write to developers on the end edge`).toBe(true);
    expect(found.sideways, `${name}: nothing scrolls sideways`).toBe(false);
    await shot(page, info, `about-${name}`);
    expect(problems).toEqual([]);
  });
}

/* About as drawn: its width, its cross, its text sizes, the room its end keeps beside the column, and its buttons' edges. */
async function aboutLayout(dialog: Locator) {
  return dialog.evaluate(box => {
    const rtl = getComputedStyle(box).direction === 'rtl';
    const rect = box.getBoundingClientRect();
    const cross = box.querySelector('header .btn')!.getBoundingClientRect();
    const facts = box.querySelector('.facts')!.getBoundingClientRect();
    const write = box.querySelector('.about-feedback .form-foot > .btn:last-child')!.getBoundingClientRect();
    const size = (selector: string) => parseFloat(getComputedStyle(box.querySelector(selector)!).fontSize);
    const style = getComputedStyle(box);
    return {
      width: rect.width,
      cross: { width: cross.width, height: cross.height },
      crossAtEnd: rtl ? Math.abs(cross.left - facts.left) <= 1 : Math.abs(cross.right - facts.right) <= 1,
      fonts: [size(':scope > p'), size('.facts'), size('.about-author')],
      /* From the end of the column to the inside of the border: 18 px of padding, the room for a scrollbar beside it. */
      room: (rtl ? facts.left - rect.left : rect.right - facts.right) - 1 - parseFloat(style.paddingInlineStart),
      writeAtEnd: rtl ? Math.abs(write.left - facts.left) <= 1 : Math.abs(write.right - facts.right) <= 1,
      sideways: document.documentElement.scrollWidth > innerWidth || box.scrollWidth > box.clientWidth,
    };
  });
}

/* Every state of writing to the developers in About, as a person passes through them. */
for (const lang of ['en', 'ru'] as const) for (const width of WIDTHS) {
  const look: Look = { lang, skin: 'light', width };
  const name = lookName(look);
  test(`Feedback in About: closed, the form, a title missing, what goes, sending, sent and a refusal: ${name}`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    const problems = await prepare(page, look);
    /* Each sending waits until the test lets it through, so its state can be seen. */
    const waiting: (() => void)[] = [];
    let let_ = 0;
    const release = async () => {
      await expect.poll(() => waiting.length).toBeGreaterThan(let_);
      waiting[let_++]!();
    };
    let refuse = false;
    await page.route('**/api/feedback', async route => {
      if (route.request().method() !== 'POST') return route.fulfill({ json: { inbox: false } });
      await new Promise<void>(resolve => { waiting.push(resolve); });
      return refuse
        ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', reason: 'relay_unreachable', message: 'hornhoof.org does not answer now.' } } })
        : route.fulfill({ json: { sent: true } });
    });
    await page.goto('/about');
    const dialog = page.getByRole('dialog', { name: t.about.title, exact: true });
    const part = dialog.getByRole('region', { name: t.feedback.section, exact: true });
    const write = part.getByRole('button', { name: t.feedback.write, exact: true });
    await expect(write).toBeVisible();
    await shot(page, info, `feedback-closed-${name}`);
    await write.click();
    await expect(part.getByRole('button', { name: t.feedback.kinds.bug, exact: true })).toBeFocused();
    const title = part.getByLabel(t.feedback.titleLabel, { exact: true });
    expect(Math.round((await title.boundingBox())!.height), `${name}: the title field is 44 px`).toBe(44);
    /* A main button holds its busy words too, hidden: the shown words are the ones not hidden. */
    const foot = await part.locator('.form-foot').evaluate(row => [...row.children].map(button => `${button.className} ${button.querySelector('.busy-swap > :not([aria-hidden])')?.textContent ?? button.textContent}`));
    expect(foot, `${name}: Next the main button, Cancel beside it`).toEqual([`btn ${t.common.next}`, `btn ghost ${t.common.cancel}`]);
    await part.getByRole('button', { name: t.common.next, exact: true }).click();
    await expect(part.getByText(t.feedback.titleRequired, { exact: true })).toBeVisible();
    await shot(page, info, `feedback-invalid-${name}`);
    await title.fill('The menu closes too soon');
    await part.getByLabel(t.feedback.text, { exact: true }).fill('On a phone the menu closes on a swipe.');
    await shot(page, info, `feedback-form-${name}`);
    await part.getByRole('button', { name: t.common.cancel, exact: true }).click();
    await expect(write).toBeFocused();
    await expect(dialog).toBeVisible();
    await write.click();
    await part.getByLabel(t.feedback.titleLabel, { exact: true }).fill('The menu closes too soon');
    await part.getByRole('button', { name: t.common.next, exact: true }).click();
    await expect(part.getByRole('region', { name: t.feedback.check, exact: true })).toBeVisible();
    await shot(page, info, `feedback-check-${name}`);
    await part.getByRole('button', { name: t.feedback.send, exact: true }).click();
    await expect(part.getByRole('button', { name: t.feedback.sending, exact: true })).toHaveAttribute('aria-busy', 'true');
    await shot(page, info, `feedback-sending-${name}`);
    await release();
    await expect(part.getByText(t.feedback.sent, { exact: true })).toBeVisible();
    await shot(page, info, `feedback-sent-${name}`);
    await part.getByRole('button', { name: t.common.done, exact: true }).click();
    await expect(write).toBeFocused();
    await expect(dialog).toBeVisible();
    refuse = true;
    await write.click();
    await part.getByLabel(t.feedback.titleLabel, { exact: true }).fill('The menu closes too soon');
    await part.getByRole('button', { name: t.common.next, exact: true }).click();
    await part.getByRole('button', { name: t.feedback.send, exact: true }).click();
    await release();
    await expect(part.getByRole('alert')).toBeVisible();
    await expect(part.getByRole('button', { name: t.feedback.send, exact: true })).toBeEnabled();
    await shot(page, info, `feedback-error-${name}`);
    expect(problems.filter(problem => !problem.includes('503'))).toEqual([]);
  });
}

/* A visible ring around what the keyboard reaches: a row of the menu, the cross of About, an item of the list of Settings
   and a button of a group. */
for (const skin of SKINS) for (const width of WIDTHS) {
  const look: Look = { lang: 'ru', skin, width };
  const name = lookName(look);
  test(`the focus ring of menu rows, About's cross, the list of Settings and a button: ${name}`, async ({ page }, info) => {
    const t = MESSAGES.ru;
    const problems = await prepare(page, look);
    const ring = (target: Locator) => target.evaluate(element => {
      const style = getComputedStyle(element);
      return `${element.matches(':focus-visible')} ${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset}`;
    });
    const menu = await openMenu(page, t);
    const settings = menu.getByRole('button', { name: t.settings.menu, exact: true });
    /* Talk to the orchestrator, then Settings. */
    await page.keyboard.press('Tab');
    await expect(menu.getByRole('button', { name: t.firstContact.title, exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(settings).toBeFocused();
    expect(await ring(settings), `${name}: the menu row`).toBe('true solid 2px 2px');
    await shot(page, info, `focus-menu-${name}`);
    await page.keyboard.press('Escape');

    await page.goto('/about');
    const about = page.getByRole('dialog', { name: t.about.title, exact: true });
    await expect(about).toBeFocused();
    await page.keyboard.press('Tab');
    const cross = about.getByRole('button', { name: t.about.close, exact: true });
    await expect(cross).toBeFocused();
    expect(await ring(cross), `${name}: the cross`).toBe('true solid 2px 2px');
    await shot(page, info, `focus-about-close-${name}`);

    await page.goto('/settings/integrations');
    const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
    await expect(dialog.getByRole('article', { name: t.googleSheets.title, exact: true })).toBeVisible();
    const nav = dialog.getByRole('navigation', { name: t.settings.groupsLabel, exact: true });
    const item = nav.getByRole('button', { name: t.settings.groups.appearance, exact: true });
    /* From Profile the keyboard reaches Appearance & language. Firefox stops on a body that scrolls on its way from Done. */
    await nav.getByRole('button', { name: t.settings.groups.profile, exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(item).toBeFocused();
    expect(await ring(item), `${name}: an item of the list`).toBe('true solid 2px 2px');
    await shot(page, info, `focus-settings-nav-${name}`);
    const change = dialog.getByRole('article', { name: t.googleSheets.title, exact: true }).getByRole('button').first();
    await change.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(change).toBeFocused();
    expect(await ring(change), `${name}: a button of the group`).toBe('true solid 2px 2px');
    await shot(page, info, `focus-settings-button-${name}`);
    expect(problems).toEqual([]);
  });
}

/* Integrations with the pink Disconnect, the main Save a key and the question before disconnecting, and Company & access
   with the pink Remove link and its question. */
for (const lang of ['en', 'ru'] as const) for (const width of WIDTHS) {
  const look: Look = { lang, skin: 'light', width };
  const name = lookName(look);
  test(`the questions before disconnecting Google Sheets and removing the link: ${name}`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    const problems = await prepare(page, look);
    await page.route('**/api/google-sheets', route => route.fulfill({ json: { google: { kind: 'service_account', account: 'sheets-bot@acme.iam.gserviceaccount.com', shareEmail: 'ivan@acme.com', keyLast4: '9876' } } }));
    await page.route('**/api/link', route => route.fulfill({ json: { link: { name: 'acme', url: 'https://acme.hornhoof.org' }, domain: 'hornhoof.org' } }));
    await page.goto('/settings/integrations');
    const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
    const google = dialog.getByRole('article', { name: t.googleSheets.title, exact: true });
    await google.getByRole('button', { name: t.googleSheets.remove, exact: true }).click();
    const googleAsk = page.getByRole('alertdialog', { name: t.googleSheets.confirm.disconnect.title });
    await expect(googleAsk).toHaveAccessibleDescription(t.googleSheets.confirm.disconnect.effect('sheets-bot@acme.iam.gserviceaccount.com'));
    await shot(page, info, `settings-integrations-ask-${name}`);
    await googleAsk.getByRole('button', { name: t.common.cancel, exact: true }).click();
    await page.goto('/settings/company');
    await dialog.getByRole('button', { name: t.settings.remove, exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: t.confirm.removeLink.title })).toHaveAccessibleDescription(t.settings.removeAsk('https://acme.hornhoof.org'));
    await shot(page, info, `settings-company-ask-${name}`);
    expect(problems).toEqual([]);
  });
}

/* The sizes Design compares between the engines (#970, findings 7 and 10), kept for each engine; a script compares them. */
for (const lang of ['en', 'ru'] as const) for (const width of WIDTHS) {
  const look: Look = { lang, skin: 'cyberpunk', width };
  const name = lookName(look);
  test(`the sizes Design compares between engines: ${name}`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    const problems = await prepare(page, look);
    await page.route('**/api/google-sheets', route => route.fulfill({ json: { google: { kind: 'service_account', account: 'sheets-bot@acme.iam.gserviceaccount.com', shareEmail: 'ivan@acme.com', keyLast4: '9876' } } }));
    const sizes: Record<string, number> = {};
    const take = async (prefix: string, root: Locator, selectors: Record<string, string>) => {
      const found = await root.evaluate((element, selectors) => {
        const origin = element.getBoundingClientRect();
        const out: Record<string, number> = {};
        const round = (value: number) => Math.round(value * 100) / 100;
        for (const [key, selector] of Object.entries(selectors)) {
          [...element.querySelectorAll(selector)].forEach((part, index) => {
            const box = part.getBoundingClientRect();
            const at = `${key}${index ? `.${index}` : ''}`;
            out[`${at}.x`] = round(box.left - origin.left);
            out[`${at}.end`] = round(box.right - origin.left);
            out[`${at}.y`] = round(box.top - origin.top);
            out[`${at}.w`] = round(box.width);
            out[`${at}.h`] = round(box.height);
          });
        }
        out['self.w'] = round(origin.width);
        out['self.h'] = round(origin.height);
        return out;
      }, selectors);
      for (const [key, value] of Object.entries(found)) sizes[`${prefix}.${key}`] = value;
    };
    const menu = await openMenu(page, t);
    await expect(menu.getByRole('button', { name: t.inbox.menu, exact: true })).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await take('menu', menu, { head: '.am-head', row: '.mi', line: '.am-sep', count: '.nav-count' });
    await page.goto('/about');
    const about = page.getByRole('dialog', { name: t.about.title, exact: true });
    await expect(about.getByText('0.24.1 (b3a32a3)', { exact: true })).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await take('about', about, { cross: 'header .btn', title: 'h2', text: ':scope > p', facts: '.facts', term: '.facts dt', author: '.about-author', line: '.about-sep', feedback: '.about-feedback', write: '.about-feedback .btn' });
    await about.getByRole('button', { name: t.feedback.write, exact: true }).click();
    await take('about-form', about, { kind: '.fb-kinds button', field: '.field input', text: 'textarea', foot: '.form-foot > .btn' });
    await page.goto('/settings/integrations');
    const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
    await expect(dialog.getByRole('article', { name: t.repoHost.title, exact: true })).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await take('integrations', dialog, { nav: '.settings-nav .btn', main: '.settings-main', card: '.integration', button: '.integration .btn', state: '.integration-state' });
    await page.goto('/settings');
    await expect(dialog.getByRole('combobox', { name: t.language.title, exact: true })).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await take('language', dialog.locator('.lang-part'), { heading: 'h4', hint: ':scope > p', list: 'select' });
    keep(info, `sizes-${name}`, sizes);
    expect(Object.keys(sizes).length).toBeGreaterThan(50);
    expect(problems).toEqual([]);
  });
}
