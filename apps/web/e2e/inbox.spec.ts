import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import type { InboxLetter, InboxView, MessageParty } from '../src/types';
import { CARD, serveAgentWindow, type AgentFixture } from './agent-window-api';
import { chooseTerminal } from './api';

/* An employee's inbox, a panel of its window: the count on the bar's icon, how letters come and the letters, in each built-in
   theme, in both shipped languages, at a desktop's width and a phone's, for one who may change it and one who only reads it,
   and with the page turned right to left. Nothing runs off the panel, the bar or the screen, the bar stays one line on a
   phone, the count beside the icon or on its corner covers no more than a third of it, the text takes the theme's own
   colours, and in every theme written in the same fonts each block stands where it does in the others. What each engine
   measured is kept in a file to compare the engines; the pictures are for Design. Time on the page is fixed, never waited on. */
test.describe.configure({ timeout: 0 });

const NOW = Date.parse('2026-11-14T18:30:00Z');
const WIDTHS = [1440, 375] as const;
const LANGS = ['en', 'ru'] as const;
type Lang = (typeof LANGS)[number];
type Words = { members: string; icon(n: number): string; panel: string; title: string; markAll: string; rule: string; inbox: string; direct: string; nowRule: string; nowInbox: string; nowDirect: string; readOnly: string; sumUnread(n: number): string; allRead: string; orchestrator: string; anna: string; markFailed: string };
const WORDS: Record<Lang, Words> = {
  en: {
    members: 'Members', icon: n => (n ? `Inbox: ${n} unread` : 'Inbox: all read'), panel: 'Inbox', title: 'Letters', markAll: 'Mark all as read',
    rule: 'Department rule', inbox: 'Through Inbox', direct: 'Direct', nowRule: 'Now: through Inbox, by department rule', nowInbox: 'Now: through Inbox', nowDirect: 'Now: direct',
    readOnly: 'The CEO or the head of the department can change it.', sumUnread: n => `${n} of 5 unread`, allRead: 'All read. 5 in total', orchestrator: 'Orchestrator', anna: 'Anna Smirnova',
    markFailed: 'Could not mark the letter. Try again.',
  },
  ru: {
    members: 'Сотрудники', icon: n => (n ? `Входящие: не прочитано ${n}` : 'Входящие: все прочитано'), panel: 'Входящие', title: 'Письма', markAll: 'Отметить все прочитанными',
    rule: 'По правилу отдела', inbox: 'Через входящие', direct: 'Прямая подача', nowRule: 'Сейчас: через входящие, по правилу отдела', nowInbox: 'Сейчас: через входящие', nowDirect: 'Сейчас: прямая подача',
    readOnly: 'Менять режим может CEO или руководитель отдела.', sumUnread: n => `Не прочитано ${n} из 5`, allRead: 'Все прочитаны. Всего 5', orchestrator: 'Оркестратор', anna: 'Анна Смирнова',
    markFailed: 'Не удалось отметить письмо. Попробуйте еще раз.',
  },
};
const fontsOf = (skin: string) => {
  const { fonts } = builtinSkin(skin)!;
  return `${fonts.display[0]} ${fonts.body[0]}`;
};

/* Five letters, one of each kind, three unread: a long task title, a letter of six lines, a double surname with a long role
   and a hash with no breaks in it, as they come in each language. */
function letters(lang: Lang): InboxLetter[] {
  const ru = lang === 'ru';
  const DESIGN = { id: 'd3', name: { en: 'Design', ru: 'Дизайн' } };
  const SUPPORT = { id: 'd4', name: { en: 'Customer support', ru: 'Поддержка клиентов' } };
  const anna: MessageParty = { kind: 'person', id: 'p9', name: WORDS[lang].anna, role: { en: 'CEO', ru: 'CEO' }, department: null };
  const orchestrator: MessageParty = { kind: 'agent', id: 'o1', name: 'Orchestrator', role: null, department: null, agentKind: 'orchestrator' };
  const kostya: MessageParty = { kind: 'agent', id: 'k1', name: ru ? 'Константин Константинопольский-Задунайский' : 'Konstantin Konstantinopolsky-Zadunaisky', role: { en: 'Head of customer support and internal services', ru: 'Руководитель отдела поддержки клиентов и внутренних сервисов' }, department: SUPPORT, agentKind: 'head' };
  const design: MessageParty = { kind: 'agent', id: 'h3', name: ru ? 'Руководитель дизайна' : 'Head of design', role: { en: 'Head of design', ru: 'Руководитель дизайна' }, department: DESIGN, agentKind: 'head' };
  const hornhoof: MessageParty = { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null };
  return [
    { id: '00000000-0000-4000-8000-000000000001', sender: anna, kind: 'message', source: null, receivedAt: '2026-11-14T18:12:00Z', unread: true,
      task: { id: 't1', number: 868, title: ru ? 'Эталон и приемка вкладки «Входящие» (Inbox) и переключателя режима инбокса в окне сотрудника' : 'The reference and acceptance of the Inbox tab and the inbox mode switch in the employee window' },
      text: ru ? 'Нужен вариант к 20:00. Возьми книгу 1.3 и файл тем с #868.' : 'I need a variant by 20:00. Take style book 1.3 and the themes file from #868.' },
    { id: '00000000-0000-4000-8000-000000000002', sender: orchestrator, kind: 'assignment', source: 'assigned', receivedAt: '2026-11-14T17:40:00Z', unread: true,
      task: { id: 't867', number: 867, title: ru ? 'Вкладка «Входящие» в окне сотрудника' : 'The Inbox tab in the employee window' },
      text: ru
        ? 'Разработка уже пишет код вкладки.\nПоля письма: отправитель, его роль или отдел, время, задача, текст и статус.\nСчетчик приходит вместе со списком.\nРежим хранится в карточке сотрудника.\nЕсли нужно другое поле, напиши на #867 до\nконца хода.'
        : 'Development is already writing the tab.\nA letter has its sender, their role or department, time, task, text and status.\nThe count comes with the list.\nThe mode is kept on the employee card.\nIf you need another field, write on #867 before\nthe turn ends.' },
    { id: '00000000-0000-4000-8000-000000000003', sender: kostya, kind: 'comment', source: 'comment', receivedAt: '2026-11-13T16:05:00Z', unread: true, task: null,
      text: ru ? 'Проверь, как переносится хэш a7b60e26546520a9af6c5f322f53fad5ea3ab1252ecfb6115ef6dfa95415d306 в узкой панели.' : 'Check how the hash a7b60e26546520a9af6c5f322f53fad5ea3ab1252ecfb6115ef6dfa95415d306 wraps in a narrow panel.' },
    { id: '00000000-0000-4000-8000-000000000004', sender: design, kind: 'report', source: 'reported', receivedAt: '2026-11-12T09:41:00Z', unread: false,
      task: { id: 't793', number: 793, title: ru ? 'Раздел «Темы» и скин «Пиксельная»' : 'Themes section and the Pixel skin' },
      text: ru ? 'Спасибо, вариант принят с правками.' : 'Thank you, the variant is accepted with changes.' },
    { id: '00000000-0000-4000-8000-000000000005', sender: hornhoof, kind: 'notification', source: 'review', receivedAt: '2026-11-11T12:00:00Z', unread: false,
      task: { id: 't782', number: 782, title: ru ? 'Книга стиля 1.2' : 'Style book 1.2' },
      text: ru ? 'Задача перешла на проверку.' : 'The task moved to review.' },
  ];
}

type Setup = { lang: Lang; skin?: string; width: number; readOnly?: boolean; unread?: number; failMark?: boolean };
type Opened = { window: Locator; bar: Locator; icon: Locator; panel: Locator; errors: string[]; marked: unknown[]; modes: unknown[] };

/* Opens the head Bruno's window from its department, and its inbox when asked. unread: what the card counts, 3 unless said. */
type WorldResident = { agentId: string | null; roleClass: string };
type WorldHandle = { __WORLD_PRODUCT__?: { getResidents: () => WorldResident[]; selectResidentByRoleClass: (roleClass?: string) => WorldResident | null } };

/* A world map draws its departments and residents on a canvas, with no card to click: the map's own handle selects the
   employee's resident there, as a click on it does, and that opens the window. */
async function openFromWorld(page: Page, agentId: string) {
  await page.waitForFunction(id => (window as unknown as WorldHandle).__WORLD_PRODUCT__?.getResidents().some(r => r.agentId === id) ?? false, agentId);
  const picked = await page.evaluate(id => {
    const world = (window as unknown as WorldHandle).__WORLD_PRODUCT__!;
    const resident = world.getResidents().find(r => r.agentId === id)!;
    return world.selectResidentByRoleClass(resident.roleClass)?.agentId ?? null;
  }, agentId);
  expect(picked, 'the first resident of its role class is the employee').toBe(agentId);
}

async function openWindow(page: Page, { lang, skin = 'cyberpunk', width, readOnly = false, unread, failMark = false }: Setup): Promise<Opened> {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(({ lang, skin }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
  }, { lang, skin });
  await chooseTerminal(page);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`);
  });
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, head: true };
  await serveAgentWindow(page, live);
  const marked: unknown[] = [];
  const modes: unknown[] = [];
  const all = letters(lang);
  let view: InboxView = { unreadCount: 3, total: 5, letters: all, more: false, mode: null, inheritedMode: 'inbox', effectiveMode: 'inbox', canChangeMode: !readOnly, canMarkRead: !readOnly };
  await page.route('**/api/agents/b1', route => route.fulfill({ json: { ...CARD, kind: 'head', currentTask: { id: 't1', number: 1, title: 'Checkout step 1' }, inboxUnread: unread ?? view.unreadCount } }));
  await page.route(url => url.pathname === '/api/agents/b1/inbox', route => route.fulfill({ json: view }));
  await page.route('**/api/agents/b1/inbox/read', route => {
    const body = route.request().postDataJSON() as { ids?: string[]; all?: true };
    marked.push(body);
    if (failMark) return route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'No.' } } });
    const letters = view.letters.map(l => (body.all || body.ids?.includes(l.id) ? { ...l, unread: false } : l));
    view = { ...view, letters, unreadCount: letters.filter(l => l.unread).length };
    return route.fulfill({ json: { unreadCount: view.unreadCount } });
  });
  await page.route('**/api/agents/b1/inbox-mode', route => {
    const { mode } = route.request().postDataJSON() as { mode: 'inbox' | 'direct' | null };
    modes.push(mode);
    view = { ...view, mode, effectiveMode: mode ?? 'inbox' };
    return route.fulfill({ json: { mode: { own: mode, inherited: 'inbox', effective: view.effectiveMode } } });
  });
  await page.goto('/');
  if (builtinSkin(skin)?.world) await openFromWorld(page, 'b1');
  else {
    await page.getByRole('button', { name: /^Development|^Разработка/ }).first().click();
    await page.getByRole('region', { name: WORDS[lang].members }).getByRole('button', { name: /Bruno/ }).click();
  }
  const window = page.getByRole('complementary', { name: /^Bruno,/ });
  const bar = window.locator(':scope > .t-bar');
  const icon = bar.locator('[data-panel="inbox"]');
  await expect(icon).toHaveAccessibleName(WORDS[lang].icon(unread ?? 3));
  await expect(page.locator('html')).toHaveAttribute('data-theme', skin);
  const panel = window.getByRole('complementary', { name: WORDS[lang].panel, exact: true });
  return { window, bar, icon, panel, errors, marked, modes };
}

async function openInbox(page: Page, setup: Setup): Promise<Opened> {
  const opened = await openWindow(page, setup);
  await opened.icon.click();
  await expect(opened.panel.getByRole('listitem')).toHaveCount(5);
  return opened;
}

/* Where every block and control of the panel stands, with its padding, margin, border and font. */
async function geometry(panel: Locator): Promise<Record<string, unknown>[]> {
  return panel.evaluate(root => {
    const selectors = [':scope', '.ac-body', '.inbox-mode', '.inbox-choices label', '.inbox-now', '.inbox-what', '.inbox-sum', '.inbox-sum-text > *', '.inbox-sum button', '.entry', '.entry-main > *', '.entry-actions > *'];
    const seen = new Set<Element>();
    const out: Record<string, unknown>[] = [];
    const origin = root.getBoundingClientRect();
    const round = (n: number) => Math.round(n * 100) / 100;
    for (const selector of selectors) {
      for (const element of selector === ':scope' ? [root] : [...root.querySelectorAll(selector)]) {
        if (seen.has(element)) continue;
        seen.add(element);
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        out.push({
          what: `${selector} ${element.textContent?.trim().slice(0, 24) ?? ''}`,
          x: round(box.x - origin.x), y: round(box.y - origin.y), width: round(box.width), height: round(box.height),
          padding: style.padding, margin: style.margin, border: style.borderWidth, font: `${style.fontFamily.split(',')[0]} ${style.fontSize} ${style.lineHeight} ${style.fontWeight}`,
        });
      }
    }
    return out;
  });
}

/* What runs past its box or hides it: the page sideways, the panel's body sideways, a block out of the body, a button's
   words out of it, any text cut with an ellipsis, a control under 44 px. */
async function overflows(page: Page, panel: Locator): Promise<string[]> {
  const sideways = await page.evaluate(() => (document.scrollingElement!.scrollWidth > document.scrollingElement!.clientWidth + 1 ? ['the page scrolls sideways'] : []));
  const inside = await panel.evaluate(root => {
    const out: string[] = [];
    const body = root.querySelector('.ac-body')!;
    if (body.scrollWidth > body.clientWidth + 1) out.push('the panel scrolls sideways');
    const edge = body.getBoundingClientRect();
    for (const block of body.querySelectorAll('.entry, .entry-main > *, .inbox-choices label, .inbox-sum, .inbox-mode > *')) {
      const box = block.getBoundingClientRect();
      if (box.left < edge.left - 1 || box.right > edge.right + 1) out.push(`${block.textContent?.slice(0, 30)} runs out of the panel`);
    }
    for (const element of body.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      if (style.textOverflow === 'ellipsis') out.push(`${element.textContent?.slice(0, 30)} is cut with an ellipsis`);
    }
    for (const button of body.querySelectorAll('button')) {
      if (button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1) out.push(`${button.textContent} is cut`);
      if (!button.classList.contains('t-link') && button.getBoundingClientRect().height < 44 - 0.5) out.push(`${button.textContent} is under 44 px`);
    }
    for (const label of body.querySelectorAll('.inbox-choices label')) if (label.getBoundingClientRect().height < 44 - 0.5) out.push(`${label.textContent} is under 44 px`);
    return out;
  });
  return [...sideways, ...inside];
}

/* Text, lines and marks take the theme's own colours: each is the colour its token gives. */
async function colours(root: Locator): Promise<string[]> {
  return root.evaluate(root => {
    const probe = document.createElement('span');
    root.appendChild(probe);
    const token = (name: string, what: 'color' | 'backgroundColor') => {
      probe.style.color = '';
      probe.style.backgroundColor = '';
      probe.style[what] = `var(${name})`;
      return getComputedStyle(probe)[what];
    };
    const wrong: string[] = [];
    const expectColour = (selector: string, name: string, what: 'color' | 'backgroundColor' = 'color', pseudo?: string) => {
      const found = root.querySelectorAll(selector);
      if (!found.length) wrong.push(`${selector} is missing`);
      for (const e of found) if (getComputedStyle(e, pseudo)[what] !== token(name, what)) wrong.push(`${selector}${pseudo ?? ''} ${what} is not ${name}`);
    };
    if (root.querySelector('.ac-body')) {
      expectColour('.inbox-text', '--ink');
      expectColour('.inbox-meta', '--muted');
      expectColour('.inbox-kind', '--ink');
      expectColour('.inbox-state.new', '--cyan-ink');
      expectColour('.inbox-state.old', '--muted');
      expectColour('.inbox-from b', '--ink');
      expectColour('.inbox-from span', '--muted');
      expectColour('.inbox-now', '--ink');
      expectColour('.inbox-what', '--muted');
      expectColour('.inbox-sum p', '--muted');
      expectColour('.inbox .t-link', '--cyan-ink');
      expectColour('.entry.unread', '--cyan-ink', 'backgroundColor', '::before');
      if (root.querySelector('.inbox-choices')) {
        expectColour('.inbox-choices label.on', '--cyan-ink');
        expectColour('.inbox-choices label.on', '--glow', 'backgroundColor');
        expectColour('.inbox-choices label:not(.on)', '--surface2', 'backgroundColor');
      }
    } else {
      expectColour('.panel-count', '--pink', 'backgroundColor');
      expectColour('.panel-count', '--on-pink');
    }
    probe.remove();
    return wrong;
  });
}

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/* The bar: one line on a phone, the count whole, beside the icon on a desktop and on its end corner on a phone, covering no
   more than a third of it, the button as large as the ones beside it and named in full. */
async function checkBar(bar: Locator, icon: Locator, width: number, shown: string, rtl = false) {
  const { line, scrolls } = await bar.evaluate(e => {
    const tops = [...e.querySelectorAll(':scope > button, :scope > .window-controls')].map(b => Math.round(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2));
    return { line: Math.max(...tops) - Math.min(...tops), scrolls: e.scrollWidth - e.clientWidth };
  });
  expect(line, 'every button of the bar stands on one line').toBeLessThanOrEqual(1);
  if (width < 761) expect(scrolls, 'the bar does not scroll on a phone').toBeLessThanOrEqual(1);
  expect(await colours(bar)).toEqual([]);
  const count = icon.locator('.panel-count');
  await expect(count).toHaveText(shown);
  expect(await count.evaluate(e => e.scrollWidth - e.clientWidth), 'the count shows whole').toBeLessThanOrEqual(0);
  await expect(count).toHaveAttribute('aria-hidden', 'true');
  const [mark, button, svg, card] = [(await count.boundingBox())!, (await icon.boundingBox())!, (await icon.locator('svg').boundingBox())!, (await bar.locator('[data-panel="card"]').boundingBox())!];
  expect(button.width, 'the button is no narrower than the one beside it').toBeGreaterThanOrEqual(card.width - 0.5);
  expect(button.height, 'the button is no lower than the one beside it').toBeGreaterThanOrEqual(card.height - 0.5);
  expect(overlap(mark, svg) / (svg.width * svg.height), 'the count covers no more than a third of the icon').toBeLessThanOrEqual(1 / 3);
  if (width > 760) {
    expect(button.height).toBeGreaterThanOrEqual(34 - 0.5);
    const gap = rtl ? svg.x - (mark.x + mark.width) : mark.x - (svg.x + svg.width);
    expect(Math.abs(gap - 4), 'the count stands 4 px beside the icon').toBeLessThanOrEqual(1);
    expect(mark.x >= button.x - 0.5 && mark.x + mark.width <= button.x + button.width + 0.5, 'the count is inside its button').toBe(true);
    return;
  }
  expect(Math.abs(button.width - card.width), 'the count does not widen the button').toBeLessThanOrEqual(0.5);
  expect(mark.height).toBeGreaterThanOrEqual(16);
  expect(mark.width).toBeGreaterThanOrEqual(16);
  if (rtl) expect(mark.x, 'the count sits on the icon\'s left corner').toBeLessThan(svg.x);
  else expect(mark.x + mark.width, 'the count sits on the icon\'s right corner').toBeGreaterThan(svg.x + svg.width);
  expect(mark.y, 'the count sits on the icon\'s top').toBeLessThan(svg.y);
  const ring = await count.evaluate(e => {
    const probe = document.createElement('span');
    e.parentElement!.appendChild(probe);
    probe.style.color = 'var(--surface)';
    const surface = getComputedStyle(probe).color;
    probe.remove();
    return { shadow: getComputedStyle(e).boxShadow, surface };
  });
  expect(ring.shadow, 'the count has a 2 px ring of the bar\'s colour').toContain(`${ring.surface} 0px 0px 0px 2px`);
}

/* The window and its panel as a person sees them: the page grows in height until the panel scrolls no more, and goes back. */
async function shoot(page: Page, panel: Locator, path: string) {
  const size = page.viewportSize()!;
  const hidden = await panel.locator('.ac-body').evaluate(e => e.scrollHeight - e.clientHeight);
  if (hidden > 0) await page.setViewportSize({ width: size.width, height: size.height + hidden + 2 });
  await page.screenshot({ path, animations: 'disabled' });
  if (hidden > 0) await page.setViewportSize(size);
}

function keep(info: TestInfo, name: string, body: unknown) {
  const path = info.outputPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
}

async function freshPage(page: Page): Promise<Page> {
  await page.close().catch(() => {});
  return page.context().newPage();
}

for (const lang of LANGS) {
  for (const width of WIDTHS) {
    test(`keeps the inbox and its count in their places in every built-in theme, the same in each one of the same fonts: ${lang}, ${width}px`, async ({ page, browserName }, info) => {
      const report: Record<string, unknown> = { browserName, lang, width, geometry: {} };
      const first = new Map<string, Record<string, unknown>[]>();
      for (const { id: skin } of BUILTIN_SKINS) {
        const { bar, icon, panel, errors } = await openWindow(page, { lang, skin, width });
        await checkBar(bar, icon, width, '3');
        await icon.click();
        await expect(panel.getByRole('listitem')).toHaveCount(5);
        await checkBar(bar, icon, width, '3');
        expect(await overflows(page, panel), skin).toEqual([]);
        expect(await colours(panel), skin).toEqual([]);
        const now = await geometry(panel);
        const same = first.get(fontsOf(skin));
        if (same) expect(now, `${lang} ${width} ${skin} stands as the others in its fonts`).toEqual(same);
        else {
          first.set(fontsOf(skin), now);
          (report.geometry as Record<string, unknown>)[skin] = now;
        }
        await shoot(page, panel, info.outputPath(`${browserName}/inbox-${width}-${lang}-${skin}.png`));
        expect(errors).toEqual([]);
        page = await freshPage(page);
      }
      keep(info, `${browserName}/inbox-geometry-${lang}-${width}.json`, report);
    });
  }
}

test('shows how letters come to one who may not change it, with no choices and no marking, in every built-in theme', async ({ page, browserName }, info) => {
  for (const { id: skin } of BUILTIN_SKINS) {
    for (const [lang, width] of [['ru', 1440], ['ru', 375], ['en', 1440]] as const) {
      const { panel, errors } = await openInbox(page, { lang, skin, width, readOnly: true });
      await expect(panel.getByText(WORDS[lang].nowRule, { exact: true })).toBeVisible();
      await expect(panel.getByText(WORDS[lang].readOnly, { exact: true })).toBeVisible();
      await expect(panel.getByRole('radio')).toHaveCount(0);
      await expect(panel.getByRole('button', { name: WORDS[lang].markAll })).toHaveCount(0);
      await expect(panel.locator('.entry-actions button')).toHaveCount(1);
      expect(await overflows(page, panel), skin).toEqual([]);
      expect(await colours(panel), skin).toEqual([]);
      await shoot(page, panel, info.outputPath(`${browserName}/inbox-readonly-${width}-${lang}-${skin}.png`));
      expect(errors).toEqual([]);
      page = await freshPage(page);
    }
  }
});

test('opens a letter without marking it, marks letters read only by the buttons, and switches how letters come by keys', async ({ page }) => {
  const words = WORDS.en;
  const { window, bar, icon, panel, marked, modes, errors } = await openInbox(page, { lang: 'en', width: 1440 });
  const sum = panel.locator('.inbox-sum p');
  await expect(sum).toHaveText(words.sumUnread(3));
  const open = panel.getByRole('button', { name: `Open the letter from ${words.orchestrator}` });
  await open.click();
  await expect(panel.getByRole('button', { name: `Fold the letter from ${words.orchestrator}` })).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByText(/the turn ends\./)).toBeVisible();
  await panel.getByRole('button', { name: `Fold the letter from ${words.orchestrator}` }).click();
  await expect(sum).toHaveText(words.sumUnread(3));
  await expect(icon).toHaveAccessibleName(words.icon(3));
  expect(marked).toEqual([]);

  const rule = panel.getByRole('radio', { name: words.rule });
  await expect(rule).toBeChecked();
  await rule.focus();
  await page.keyboard.press('ArrowDown');
  await expect(panel.getByRole('radio', { name: words.inbox })).toBeChecked();
  await expect(panel.getByText(words.nowInbox, { exact: true })).toBeVisible();
  const ring = await panel.locator('.inbox-choices label.on').evaluate(e => getComputedStyle(e).outlineWidth + ' ' + getComputedStyle(e).outlineStyle);
  expect(ring, 'the picked choice shows the focus').toBe('2px solid');
  await page.keyboard.press('ArrowDown');
  await expect(panel.getByRole('radio', { name: words.direct })).toBeChecked();
  await expect(panel.getByText(words.nowDirect, { exact: true })).toBeVisible();
  expect(modes).toEqual(['inbox', 'direct']);

  await panel.getByRole('button', { name: `Mark the letter from ${words.anna} as read` }).click();
  await expect(icon).toHaveAccessibleName(words.icon(2));
  await expect(sum).toHaveText(words.sumUnread(2));
  await expect(panel.getByRole('heading', { name: words.title })).toBeFocused();
  await checkBar(bar, icon, 1440, '2');
  await panel.getByRole('button', { name: words.markAll, exact: true }).click();
  await expect(sum).toHaveText(words.allRead);
  await expect(panel.getByRole('button', { name: words.markAll, exact: true })).toHaveCount(0);
  await expect(icon).toHaveAccessibleName(words.icon(0));
  await expect(icon.locator('.panel-count')).toHaveCount(0);
  expect(marked).toEqual([{ ids: ['00000000-0000-4000-8000-000000000001'] }, { all: true }]);

  await panel.getByRole('button', { name: /^#868 / }).click();
  await expect(window.getByText('The task details stay beside the terminal on a wide screen.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('keeps a letter unread and says so when marking it fails', async ({ page }) => {
  const words = WORDS.ru;
  const { icon, panel, errors } = await openInbox(page, { lang: 'ru', width: 375, failMark: true });
  await panel.getByRole('button', { name: `Отметить прочитанным письмо от ${words.anna}` }).click();
  await expect(panel.getByRole('alert')).toHaveText(words.markFailed);
  await expect(panel.locator('.inbox-sum p')).toHaveText(words.sumUnread(3));
  await expect(icon).toHaveAccessibleName(words.icon(3));
  expect(await overflows(page, panel)).toEqual([]);
  expect(errors.filter(e => !e.includes('500'))).toEqual([]);
});

test('shows 99+ whole past 99, named with the whole number, at both widths', async ({ page, browserName }, info) => {
  for (const lang of LANGS) {
    for (const width of WIDTHS) {
      const { bar, icon, panel, errors } = await openWindow(page, { lang, width, unread: 128 });
      await expect(icon).toHaveAccessibleName(WORDS[lang].icon(128));
      await expect(icon).toHaveAttribute('title', WORDS[lang].icon(128));
      await checkBar(bar, icon, width, '99+');
      await icon.click();
      await expect(panel.getByRole('listitem')).toHaveCount(5);
      /* The open inbox counts 3, and the bar hears it. */
      await checkBar(bar, icon, width, '3');
      await bar.screenshot({ path: info.outputPath(`${browserName}/inbox-bar-${width}-${lang}.png`), animations: 'disabled' });
      expect(errors).toEqual([]);
      page = await freshPage(page);
    }
  }
});

test('mirrors the inbox for a language written right to left: the count on the left, the stripe and buttons mirrored', async ({ page, browserName }, info) => {
  /* No shipped language is written right to left yet; this checks the rule on English with the page turned. */
  for (const width of WIDTHS) {
    const { bar, icon, panel, errors } = await openWindow(page, { lang: 'en', width, unread: 128 });
    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
    });
    await checkBar(bar, icon, width, '99+', true);
    await icon.click();
    await expect(panel.getByRole('listitem')).toHaveCount(5);
    const body = (await panel.locator('.ac-body').boundingBox())!;
    const mark = (await panel.getByRole('button', { name: `Mark the letter from ${WORDS.en.anna} as read` }).boundingBox())!;
    expect(mark.x - body.x, "a letter's buttons stand at the end, the left edge").toBeLessThan(body.width / 2);
    const stripe = await panel.locator('.entry.unread').first().evaluate(e => ({ right: getComputedStyle(e, '::before').right, padding: getComputedStyle(e).paddingRight }));
    expect(stripe, 'the stripe of an unread letter stands at its start, the right edge').toEqual({ right: '0px', padding: '12px' });
    expect(await overflows(page, panel)).toEqual([]);
    await shoot(page, panel, info.outputPath(`${browserName}/inbox-rtl-${width}-en.png`));
    expect(errors).toEqual([]);
    page = await freshPage(page);
  }
});
