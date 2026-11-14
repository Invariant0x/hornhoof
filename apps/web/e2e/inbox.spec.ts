import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import type { InboxLetter, InboxView } from '../src/types';
import { CARD, serveAgentWindow, type AgentFixture } from './agent-window-api';
import { chooseTerminal } from './api';

/* An employee's inbox in its window: the counter on its icon, how letters come and every letter, in each built-in theme, on
   both shipped languages, at a desktop's width and a phone's, and with the page turned right to left. Nothing runs off the
   panel or the screen, the counter sits on the icon's end corner, text takes the theme's own colours, and in every theme
   written in the same fonts each block stands where it does in the others. What each engine measured is kept in a file, so
   the three engines can be compared with each other; the pictures are for Design. */
test.describe.configure({ timeout: 0 });

const WIDTHS = [1440, 375] as const;
const LANGS = ['en', 'ru'] as const;
type Lang = (typeof LANGS)[number];
const WORDS = {
  en: { members: 'Members', icon: 'Inbox, 2 unread', panel: 'Inbox', markAll: 'Mark all as read', direct: 'Direct delivery' },
  ru: { members: 'Сотрудники', icon: 'Входящие, 2 непрочитанных', panel: 'Входящие', markAll: 'Отметить все прочитанными', direct: 'Прямая подача' },
};
const fontsOf = (skin: string) => {
  const { fonts } = builtinSkin(skin)!;
  return `${fonts.display[0]} ${fonts.body[0]}`;
};

const DEV = { id: 'd2', name: { en: 'Development', ru: 'Разработка' } };
const HANA = { kind: 'agent' as const, id: 'h1', name: 'Hana Wolkenstein-Rodenegg', role: { en: 'Head of development', ru: 'Руководитель разработки' }, department: DEV, agentKind: 'head' as const };
const RITA = { kind: 'agent' as const, id: 'r1', name: 'Rita', role: { en: 'Backend developer', ru: 'Бэкенд-разработчик' }, department: DEV, agentKind: 'worker' as const };
const HORNHOOF = { kind: 'hornhoof' as const, id: null, name: 'Hornhoof', role: null, department: null };
const LETTERS: InboxLetter[] = [
  { id: 'l1', sender: HANA, kind: 'assignment', source: 'assigned', task: { number: 1, title: 'Checkout step 1: totals, rounding and the receipt for every currency' }, at: '2026-11-14T08:00:00Z', text: 'Take #1 and keep the branch small.', status: 'read' },
  { id: 'l2', sender: RITA, kind: 'message', source: null, task: { number: 1, title: 'Checkout step 1: totals, rounding and the receipt for every currency' }, at: '2026-11-14T08:05:00Z', text: 'I pushed the fixtures to apps/server/test/fixtures/checkout/very-long-file-name-without-any-breaks-for-rounding.json\nSee the branch task-869-checkout-totals-rounding.', status: 'unread' },
  { id: 'l3', sender: HORNHOOF, kind: 'notification', source: 'tests', task: null, at: '2026-11-14T08:06:00Z', text: 'The test run ended: 1656 passed, 0 failed.', status: 'unread' },
];
const VIEW: InboxView = { unread: 2, letters: LETTERS, mode: { own: null, inherited: 'inbox', effective: 'inbox' }, canChange: true };

type Opened = { panel: Locator; icon: Locator; errors: string[]; marked: unknown[]; modes: unknown[] };

async function openInbox(page: Page, lang: Lang, skin: string, width: number): Promise<Opened> {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.addInitScript(({ lang, skin }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
  }, { lang, skin });
  await chooseTerminal(page);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`); });
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, head: true };
  await serveAgentWindow(page, live);
  const marked: unknown[] = [];
  const modes: unknown[] = [];
  let view = VIEW;
  await page.route('**/api/agents/b1', route => route.fulfill({ json: { ...CARD, kind: 'head', currentTask: { id: 't1', number: 1, title: 'Checkout step 1' }, inboxUnread: view.unread } }));
  await page.route('**/api/agents/b1/inbox', route => route.fulfill({ json: view }));
  await page.route('**/api/agents/b1/inbox/read', route => {
    marked.push(route.request().postDataJSON());
    view = { ...view, unread: 0, letters: view.letters.map(l => ({ ...l, status: 'read' as const })) };
    return route.fulfill({ json: { unread: 0 } });
  });
  await page.route('**/api/agents/b1/inbox-mode', route => {
    const { mode } = route.request().postDataJSON() as { mode: 'inbox' | 'direct' | null };
    modes.push(mode);
    view = { ...view, mode: { own: mode, inherited: 'inbox', effective: mode ?? 'inbox' } };
    return route.fulfill({ json: { mode: view.mode } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Development|^Разработка/ }).first().click();
  await page.getByRole('region', { name: WORDS[lang].members }).getByRole('button', { name: /Bruno/ }).click();
  const window = page.getByRole('complementary', { name: /^Bruno,/ });
  const icon = window.locator(':scope > .t-bar').getByRole('button', { name: WORDS[lang].icon, exact: true });
  await icon.click();
  const panel = window.getByRole('complementary', { name: WORDS[lang].panel, exact: true });
  await expect(panel.getByRole('listitem')).toHaveCount(3);
  await expect(page.locator('html')).toHaveAttribute('data-theme', skin);
  return { panel, icon, errors, marked, modes };
}

/* Where every block and control of the panel stands, with its padding, margin, border and font. */
async function geometry(panel: Locator): Promise<Record<string, unknown>[]> {
  return panel.evaluate(root => {
    const selectors = [':scope', '.inbox', '.inbox > p', '.choice', '.choice label', '.inbox-foot', '.inbox-foot > *', '.entry', '.entry-main > *', '.entry-actions > *', '.badge'];
    const seen = new Set<Element>();
    const out: Record<string, unknown>[] = [];
    const origin = root.getBoundingClientRect();
    for (const selector of selectors) {
      for (const element of selector === ':scope' ? [root] : [...root.querySelectorAll(selector)]) {
        if (seen.has(element)) continue;
        seen.add(element);
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        out.push({
          what: `${selector} ${element.textContent?.trim().slice(0, 24) ?? ''}`,
          x: Math.round((box.x - origin.x) * 100) / 100, y: Math.round((box.y - origin.y) * 100) / 100,
          width: Math.round(box.width * 100) / 100, height: Math.round(box.height * 100) / 100,
          padding: style.padding, margin: style.margin, border: style.borderWidth, font: `${style.fontFamily.split(',')[0]} ${style.fontSize} ${style.lineHeight} ${style.fontWeight}`,
        });
      }
    }
    return out;
  });
}

/* What runs past its box: the page sideways, the panel sideways, an entry out of the panel, a button's words out of it. */
async function overflows(page: Page, panel: Locator): Promise<string[]> {
  const page_ = await page.evaluate(() => (document.scrollingElement!.scrollWidth > document.scrollingElement!.clientWidth + 1 ? ['the page scrolls sideways'] : []));
  const inside = await panel.evaluate(root => {
    const out: string[] = [];
    const list = root.querySelector('.inbox')!;
    if (list.scrollWidth > list.clientWidth + 1) out.push('the panel scrolls sideways');
    const edge = list.getBoundingClientRect();
    for (const entry of list.querySelectorAll('.entry, .choice label, .inbox-foot')) {
      const box = entry.getBoundingClientRect();
      if (box.left < edge.left - 1 || box.right > edge.right + 1) out.push(`${entry.textContent?.slice(0, 30)} runs out of the panel`);
    }
    for (const button of list.querySelectorAll('button')) {
      if (button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1) out.push(`${button.textContent} is cut`);
    }
    return out;
  });
  return [...page_, ...inside];
}

/* Text and lines take the theme's own colours: each is the colour its token gives. */
async function colours(panel: Locator): Promise<string[]> {
  return panel.evaluate(root => {
    const probe = document.createElement('span');
    root.appendChild(probe);
    const token = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const wrong: string[] = [];
    const expectColour = (selector: string, name: string) => {
      for (const e of root.querySelectorAll(selector)) if (getComputedStyle(e).color !== token(name)) wrong.push(`${selector} is not ${name}`);
    };
    expectColour('.inbox-text', '--ink');
    expectColour('.entry-meta', '--muted');
    expectColour('.inbox-unread', '--cyan-ink');
    probe.remove();
    return wrong;
  });
}

/* A picture of the whole panel for Design: the window grows in height until the panel scrolls no more, and goes back after. */
async function shoot(page: Page, panel: Locator, path: string) {
  const size = page.viewportSize()!;
  const hidden = await panel.locator('.inbox').evaluate(e => e.scrollHeight - e.clientHeight);
  if (hidden > 0) await page.setViewportSize({ width: size.width, height: size.height + hidden + 2 });
  await panel.screenshot({ path, animations: 'disabled' });
  if (hidden > 0) await page.setViewportSize(size);
}

function keep(info: TestInfo, name: string, body: unknown) {
  const path = info.outputPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
}

for (const lang of LANGS) {
  for (const width of WIDTHS) {
    test(`keeps the inbox inside its panel in every built-in theme, the same in each one of the same fonts: ${lang}, ${width}px`, async ({ page, browserName }, info) => {
      const report: Record<string, unknown> = { browserName, lang, width, geometry: {} };
      const first = new Map<string, Record<string, unknown>[]>();
      for (const { id: skin } of BUILTIN_SKINS) {
        const { panel, icon, errors } = await openInbox(page, lang, skin, width);
        expect(await overflows(page, panel), `${skin}`).toEqual([]);
        expect(await colours(panel), `${skin}`).toEqual([]);
        const count = icon.locator('.panel-count');
        await expect(count).toHaveText('2');
        const [onIcon, iconBox] = [(await count.boundingBox())!, (await icon.boundingBox())!];
        expect(Math.abs(onIcon.x + onIcon.width - (iconBox.x + iconBox.width)), `${skin}: the counter sits on the icon's end corner`).toBeLessThanOrEqual(1);
        expect(Math.abs(onIcon.y - iconBox.y), `${skin}: the counter sits on the icon's top`).toBeLessThanOrEqual(1);
        const now = await geometry(panel);
        const same = first.get(fontsOf(skin));
        if (same) expect(now, `${lang} ${width} ${skin} stands as the others in its fonts`).toEqual(same);
        else {
          first.set(fontsOf(skin), now);
          (report.geometry as Record<string, unknown>)[skin] = now;
        }
        await shoot(page, panel, info.outputPath(`${browserName}/${lang}-${width}-${skin}.png`));
        expect(errors).toEqual([]);
        await page.close().catch(() => {});
        page = await page.context().newPage();
      }
      keep(info, `${browserName}/inbox-geometry-${lang}-${width}.json`, report);
    });
  }
}

test('marks letters read only by the button, and switches how letters come', async ({ page }) => {
  const { panel, icon, marked, modes, errors } = await openInbox(page, 'en', 'cyberpunk', 1440);
  expect(marked).toEqual([]);
  await panel.getByRole('radio', { name: WORDS.en.direct }).check();
  await expect(panel.getByRole('radio', { name: WORDS.en.direct })).toBeChecked();
  expect(modes).toEqual(['direct']);
  await panel.getByRole('button', { name: WORDS.en.markAll, exact: true }).click();
  await expect(panel.getByRole('button', { name: WORDS.en.markAll, exact: true })).toHaveCount(0);
  expect(marked).toEqual([{ all: true }]);
  await expect(icon).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('mirrors the inbox for a language written right to left: the counter on the left corner, buttons at the end', async ({ page }, info) => {
  /* No shipped language is written right to left yet; this checks the rule on English with the page turned. */
  for (const width of WIDTHS) {
    const { panel, icon, errors } = await openInbox(page, 'en', 'cyberpunk', width);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    const [onIcon, iconBox] = [(await icon.locator('.panel-count').boundingBox())!, (await icon.boundingBox())!];
    expect(Math.abs(onIcon.x - iconBox.x), 'the counter sits on the left corner').toBeLessThanOrEqual(1);
    const list = (await panel.locator('.inbox').boundingBox())!;
    const mark = (await panel.getByRole('button', { name: /^Mark the letter from Rita/ }).boundingBox())!;
    expect(mark.x - list.x, 'a letter\'s button stands at the end, the left edge').toBeLessThan(list.width / 2);
    expect(await overflows(page, panel)).toEqual([]);
    await shoot(page, panel, info.outputPath(`rtl-${width}-inbox.png`));
    expect(errors).toEqual([]);
    await page.close().catch(() => {});
    page = await page.context().newPage();
  }
});
