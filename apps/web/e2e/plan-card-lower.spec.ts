import { writeFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Messages } from '../src/i18n';
import type { SubView } from '../src/types';
import { SUB } from './agent-window-api';
import { box, serveApi } from './api';
import { focusRing, offences, sizes } from './owner-screens-look';
import type { Measured } from './owner-screens-sizes';

/* The lower part of a working plan's card on Subscriptions & API (#1444), built from Design's variant B of #1432 with its
   amendments: Settings and Fallback plans as bands across the card, the fallback plans numbered with a labelled model
   field whose whole value shows, and one foot of the card's actions with one filled button and Remove apart at its end.
   Every answer of the server is the test's own. Run in Chromium, Firefox and WebKit by plan-card-lower.config.ts, which
   compares the sizes each test leaves between the engines. */

type Lang = 'en' | 'ru';
type Theme = 'light' | 'dark';
type Look = { lang: Lang; theme: Theme; width: number; dir: 'ltr' | 'rtl' };
const MESSAGES: Record<Lang, Messages> = { en, ru };
/* Dark is the default skin, Cyberpunk. */
const SKIN: Record<Theme, string> = { light: 'light', dark: 'cyberpunk' };
const lookName = ({ lang, theme, width, dir }: Look) => `${lang}, ${theme}, ${width}px${dir === 'rtl' ? ', right to left' : ''}`;
const fileName = ({ lang, theme, width, dir }: Look) => `${theme === 'dark' ? 'cyberpunk' : 'light'}-${dir === 'rtl' ? 'rtl' : lang}-${width}`;

const plan = (id: string, provider: SubView['provider'], owner: string, models: { id: string; name: string }[]): SubView =>
  ({ ...SUB, id, provider, label: provider, owner: { id: `p-${id}`, name: owner }, agents: [], fallbacks: [], models });

/* The plans the card names as fallbacks, as Design's fixtures: short names in English, long ones in Russian. */
const FALLBACKS: Record<Lang, SubView[]> = {
  en: [
    plan('s-claude', 'claude', 'Design team', [{ id: 'sonnet', name: 'Sonnet' }, { id: 'review', name: 'Long-context review model' }]),
    plan('s-codex', 'codex', 'Product research', [{ id: 'research', name: 'Long-context research model' }, { id: 'review', name: 'Long-context review model' }]),
    plan('s-glm', 'glm', 'Evening reserve', [{ id: 'review', name: 'Long-context review model' }]),
  ],
  ru: [
    plan('s-claude', 'claude', 'Международная команда проектирования и дизайна', [{ id: 'sonnet', name: 'Модель для подготовки и проверки технических описаний' }, { id: 'review', name: 'Модель для многоязычного анализа и проверки технических описаний с расширенным контекстом' }]),
    plan('s-codex', 'codex', 'Исследовательская команда для обработки больших коллекций документов', [{ id: 'research', name: 'Модель для многоязычного анализа и обобщения исследовательских материалов с расширенным контекстом' }]),
    plan('s-glm', 'glm', 'Проверка интеграций и вечерних запусков', [{ id: 'review', name: 'Модель для пакетной проверки клиентских интеграций' }]),
  ],
};
const CHOSEN = [{ subscription: 's-claude', model: 'sonnet' }, { subscription: 's-codex', model: 'research' }, { subscription: 's-glm', model: null }];
/* One more plan of the company, which Add offers. */
const SPARE = plan('s-agy', 'antigravity', 'Team reserve', []);
/* The card's plan: Ivan's own Kimi, ready on its machine, so its foot has Run a test, Use for the orchestrator, Paste the key
   and Remove, as Design's reference. */
const KIMI: SubView = { ...SUB, id: 's-kimi', provider: 'kimi', label: 'Kimi', owner: { id: 'p1', name: 'Ivan' }, agents: [], fallbacks: CHOSEN,
  machines: [{ id: 'm1', hostname: 'example-node-01', status: 'ready', online: true }] };

async function opened(page: Page, look: Look, kimi: SubView = KIMI): Promise<{ card: Locator; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  await page.setViewportSize({ width: look.width, height: 900 });
  await page.addInitScript(({ lang, skin }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
  }, { lang: look.lang, skin: SKIN[look.theme] });
  await serveApi(page);
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [kimi, ...FALLBACKS[look.lang], SPARE] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.goto('/');
  const t = MESSAGES[look.lang];
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();
  await page.getByRole('button', { name: t.tables.openCard('Kimi') }).click();
  if (look.dir === 'rtl') await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await page.evaluate(async () => { await document.fonts.ready; });
  const card = page.getByRole('article', { name: 'Kimi, Ivan' });
  await expect(card.locator('.plan-card-actions')).toBeVisible();
  return { card, errors };
}

/* What breaks the lower part as drawn: a piece out of the card, a name cut or ended in dots, a page wider than its window. */
async function whole(card: Locator): Promise<string[]> {
  return card.evaluate(root => {
    const out: string[] = [];
    const frame = root.getBoundingClientRect();
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    const parts = root.querySelectorAll(':is(.plan-settings, .plan-fallbacks, .plan-card-actions) :not(.sr, .sr *)');
    for (const el of parts) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < frame.left - 0.5 || r.right > frame.right + 0.5)) out.push(`${name(el)} stands out of the card`);
    }
    for (const el of root.querySelectorAll('.fallback-name, .model-value, .model-choice, .plan-settings select, :is(.plan-settings, .plan-fallbacks, .plan-card-actions) button')) {
      const s = getComputedStyle(el);
      if (s.textOverflow === 'ellipsis' && el.tagName !== 'SELECT') out.push(`${name(el)} ends its words in dots`);
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${name(el)} is cut: ${el.scrollWidth} in ${el.clientWidth}`);
    }
    if (document.documentElement.scrollWidth > innerWidth) out.push(`the page is ${document.documentElement.scrollWidth}px wide in ${innerWidth}`);
    return out;
  });
}

/* How far the words of each model field start from the inside of its frame, on its start side: Design's amendment 1 wants
   the field's padding, 12 px, and nothing before it. */
async function valueStarts(card: Locator): Promise<number[]> {
  return card.locator('.fallback-model .field').evaluateAll(fields => fields.map(field => {
    const frame = field.querySelector<HTMLElement>('select, .model-trigger')!;
    const words = document.createRange();
    words.selectNodeContents(field.querySelector('.model-value bdi')!);
    const text = words.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const s = getComputedStyle(frame);
    const rtl = s.direction === 'rtl';
    return Math.round((rtl ? f.right - parseFloat(s.borderRightWidth) - text.right : text.left - f.left - parseFloat(s.borderLeftWidth)) * 10) / 10;
  }));
}

/* Where Remove stands in the foot: its gap to the button before it on its row, the line between them, and how far it is
   from the foot's end edge. */
async function removePlace(card: Locator) {
  return card.locator('.plan-card-actions .form-foot').evaluate(foot => {
    const remove = foot.querySelector<HTMLElement>('.plan-remove')!;
    const before = remove.previousElementSibling as HTMLElement | null;
    const rtl = getComputedStyle(foot).direction === 'rtl';
    const r = remove.getBoundingClientRect();
    const f = foot.getBoundingClientRect();
    const b = before?.getBoundingClientRect();
    const line = getComputedStyle(remove, '::before');
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.color = 'var(--line)';
    const lineInk = getComputedStyle(probe).color;
    probe.style.color = 'var(--pink-ink)';
    const pink = getComputedStyle(probe).color;
    probe.remove();
    return {
      last: remove === foot.lastElementChild,
      sameRow: b ? Math.abs(b.top - r.top) <= 1 : false,
      gap: b ? Math.round((rtl ? b.left - r.right : r.left - b.right) * 10) / 10 : null,
      fromEnd: Math.round((rtl ? r.left - f.left : f.right - r.right) * 10) / 10,
      line: { width: line.width, height: Math.round(parseFloat(line.height)), ink: line.backgroundColor === lineInk },
      height: Math.round(r.height),
      danger: getComputedStyle(remove).color === pink && getComputedStyle(remove).boxShadow.includes(pink),
    };
  });
}

/* A picture of a piece in a window as tall as the page's longest scrolling part, so none of the card scrolls away inside
   the page; the window is given back as it was. */
async function shoot(page: Page, piece: Locator, path: string): Promise<void> {
  const size = page.viewportSize()!;
  const tall = await page.evaluate(() => Math.max(innerHeight, ...[...document.querySelectorAll('*')].map(el => el.getBoundingClientRect().top + el.scrollHeight)));
  await page.setViewportSize({ width: size.width, height: Math.min(8000, Math.ceil(tall)) });
  await piece.screenshot({ path });
  await page.setViewportSize(size);
}

const filledButtons = (card: Locator) => card.locator('.plan-card-actions .form-foot > button:not(.ghost)');

const PIECES = {
  settings: '.plan-settings', fallbacks: '.plan-fallbacks', entry: '.fallback-list > .entry', name: '.fallback-name', model: '.fallback-model .field',
  moves: '.fallback-moves', add: '.fallback-add > button', foot: '.plan-card-actions', action: '.plan-card-actions .form-foot > button',
};

const FULL: Look[] = [
  ...(['en', 'ru'] as const).flatMap(lang => (['light', 'dark'] as const).flatMap(theme => [1440, 375].map(width => ({ lang, theme, width, dir: 'ltr' as const })))),
  { lang: 'en', theme: 'dark', width: 375, dir: 'rtl' },
  { lang: 'en', theme: 'dark', width: 1440, dir: 'rtl' },
];

for (const look of FULL) {
  test(`the lower part of a plan's card with three fallback plans, in ${lookName(look)}`, async ({ page, browserName }, info) => {
    const t = MESSAGES[look.lang];
    const { card, errors } = await opened(page, look);
    const entries = card.locator('.fallback-list > .entry');
    await expect(entries).toHaveCount(3);
    await expect(entries.locator('.fallback-position')).toHaveText(['1', '2', '3']);
    await expect(entries.locator('.fallback-model label')).toHaveText([t.subs.fallbackModelField, t.subs.fallbackModelField, t.subs.fallbackModelField]);
    const models = FALLBACKS[look.lang].map((p, i) => p.models!.find(m => m.id === CHOSEN[i]!.model)?.name ?? t.subs.fallbackModel);
    await expect(entries.locator('.model-value')).toHaveText(models);
    expect(await whole(card)).toEqual([]);
    for (const start of await valueStarts(card)) expect(Math.abs(start - 12), `the model's words start ${start}px inside its field`).toBeLessThanOrEqual(1);

    /* Each record's moves stand in one row at the end edge, the same edge for all; Add stands at that edge after the list. */
    const band = await box(card.locator('.plan-fallbacks'));
    const ends = await card.locator('.fallback-moves').evaluateAll(groups => groups.map(g => {
      const r = [...g.children].map(b => b.getBoundingClientRect());
      const rtl = getComputedStyle(g).direction === 'rtl';
      return { rows: new Set(r.map(b => Math.round(b.top))).size, end: Math.round(rtl ? Math.min(...r.map(b => b.left)) : Math.max(...r.map(b => b.right))) };
    }));
    for (const end of ends) expect(end).toEqual({ rows: 1, end: ends[0]!.end });
    const add = await box(card.locator('.fallback-add > button'));
    const bandEnd = look.dir === 'rtl' ? band.x : band.x + band.width;
    expect(Math.abs((look.dir === 'rtl' ? add.x : add.x + add.width) - bandEnd)).toBeLessThanOrEqual(1);
    expect(Math.abs(ends[0]!.end - bandEnd)).toBeLessThanOrEqual(1);

    /* One filled button, Run a test; Remove last at the end edge, apart from the rest. */
    await expect(filledButtons(card)).toHaveText([t.subs.runTest]);
    await expect(card.locator('.plan-card-actions .form-foot > button')).toHaveText([t.subs.runTest, t.subs.useForOrchestrator, t.subs.pasteKey, t.subs.remove]);
    const remove = await removePlace(card);
    expect(remove).toMatchObject({ last: true, danger: true });
    expect(Math.abs(remove.fromEnd)).toBeLessThanOrEqual(1);
    if (remove.sameRow) {
      expect(Math.abs(remove.gap! - 16)).toBeLessThanOrEqual(1);
      expect(remove.line).toEqual({ width: '1px', height: remove.height, ink: true });
    }
    /* Design's rules for the screen: targets, groups at their end edge, Remove in pink and last. */
    expect.soft(await offences(card.locator('.plan-card-actions'), { danger: [t.subs.remove], groups: '.form-foot' })).toEqual([]);
    expect.soft(await offences(card.locator('.plan-fallbacks'), { danger: [], groups: '.fallback-moves' })).toEqual([]);
    expect.soft(await offences(card.locator('.plan-settings'), { danger: [], groups: '.form-foot' })).toEqual([]);

    const measured: Measured[] = [{ browser: browserName, look: lookName(look), screen: 'plan card, three fallback plans', sizes: await sizes(card, PIECES) }];
    writeFileSync(info.outputPath('sizes.json'), JSON.stringify(measured));
    await shoot(page, card, info.outputPath(`card-full-${fileName(look)}-${browserName}.png`));
    expect(errors).toEqual([]);
  });
}

const EMPTY = FULL.filter(look => look.dir === 'ltr');

for (const look of EMPTY) {
  test(`the lower part of a plan's card with no fallback plan named, in ${lookName(look)}`, async ({ page, browserName }, info) => {
    const t = MESSAGES[look.lang];
    const { card, errors } = await opened(page, look, { ...KIMI, fallbacks: [] });
    const band = card.locator('.plan-fallbacks');
    /* The rule that any plan with room serves stands in place of the explanation and the list. */
    await expect(band.locator('.part-note')).toHaveText([t.subs.fallbacksAny]);
    await expect(band.locator('ol')).toHaveCount(0);
    const add = await box(band.locator('.fallback-add > button'));
    const frame = await box(band);
    expect(Math.abs(add.x + add.width - (frame.x + frame.width))).toBeLessThanOrEqual(1);
    expect(await whole(card)).toEqual([]);
    await expect(filledButtons(card)).toHaveText([t.subs.runTest]);
    const measured: Measured[] = [{ browser: browserName, look: lookName(look), screen: 'plan card, no fallback plan', sizes: await sizes(card, PIECES) }];
    writeFileSync(info.outputPath('sizes.json'), JSON.stringify(measured));
    await shoot(page, card, info.outputPath(`card-empty-${fileName(look)}-${browserName}.png`));
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 375]) {
  const look: Look = { lang: 'en', theme: 'light', width, dir: 'ltr' };

  test(`fills only the first action when the plan cannot run a test, in ${lookName(look)}`, async ({ page, browserName }, info) => {
    const { card, errors } = await opened(page, look, { ...KIMI, online: false });
    await expect(card.locator('.plan-card-actions .form-foot > button')).toHaveText([en.subs.useForOrchestrator, en.subs.pasteKey, en.subs.remove]);
    await expect(filledButtons(card)).toHaveText([en.subs.useForOrchestrator]);
    expect((await removePlace(card)).last).toBe(true);
    await card.locator('.plan-card-actions').screenshot({ path: info.outputPath(`foot-no-test-${fileName(look)}-${browserName}.png`) });
    expect(errors).toEqual([]);
  });

  test(`asks before removing in place of the foot, and gives the focus back to Remove on cancel, in ${lookName(look)}`, async ({ page, browserName }, info) => {
    const { card, errors } = await opened(page, look);
    const foot = card.locator('.plan-card-actions');
    const remove = foot.getByRole('button', { name: en.subs.removeLabel('Kimi'), exact: true });
    /* Where a piece stands in the card, which keeps its place however far the page scrolled to show the focus. */
    const inCard = async (piece: Locator) => (await box(piece)).y - (await box(card)).y;
    await remove.focus();
    const before = await inCard(foot.locator('.form-foot'));
    await page.keyboard.press('Enter');
    await expect(foot.getByText(en.subs.removeAsk('Kimi'))).toBeVisible();
    await expect(foot.locator('.form-foot')).toHaveCount(0);
    expect(Math.abs(await inCard(foot.locator('.ask')) - before), 'the question stands where the foot stood').toBeLessThanOrEqual(1);
    const cancel = foot.getByRole('button', { name: en.common.cancel, exact: true });
    await expect(cancel).toBeFocused();
    await foot.screenshot({ path: info.outputPath(`remove-question-${fileName(look)}-${browserName}.png`) });
    await page.keyboard.press('Enter');
    await expect(foot.locator('.form-foot')).toHaveCount(1);
    await expect(remove).toBeFocused();
    expect(errors).toEqual([]);
  });

  test(`shows the focus on every control of the lower part, in the order of the card, in ${lookName(look)}`, async ({ page, browserName }, info) => {
    const { card, errors } = await opened(page, look);
    const settings = card.locator('.plan-settings select');
    await settings.focus();
    await page.keyboard.press('Shift+Tab');
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => Boolean(document.activeElement?.closest(':is(.plan-settings, .plan-fallbacks, .plan-card-actions)')));
      if (!inside) break;
      const named = await page.evaluate(() => document.activeElement!.getAttribute('aria-label') ?? document.activeElement!.textContent ?? '');
      /* Past the page's last control Firefox leaves the focus where it was, as it goes to the browser's own bar. */
      if (named === seen.at(-1)) break;
      seen.push(named);
      expect(await focusRing(page), `the ring of ${named}`).toBe('ring');
      if (named === en.subs.fallbackModelLabel('Codex, Product research')) await page.locator(':focus').evaluate(el => el.closest('.entry')!.scrollIntoView({ block: 'center' }));
      if (named === en.subs.fallbackModelLabel('Codex, Product research') || named === en.subs.runTestLabel('Kimi')) {
        const at = (await page.locator(':focus').boundingBox())!;
        await page.screenshot({ path: info.outputPath(`focus-${named === en.subs.runTestLabel('Kimi') ? 'run-test' : 'model'}-${fileName(look)}-${browserName}.png`),
          clip: { x: Math.max(0, at.x - 16), y: Math.max(0, at.y - 16), width: Math.min(look.width - Math.max(0, at.x - 16), at.width + 32), height: at.height + 32 } });
      }
    }
    expect(seen).toEqual([
      en.subs.shareLabel('Kimi'),
      en.subs.fallbackModelLabel('Claude, Design team'), en.subs.fallbackDownLabel('Claude, Design team'), en.subs.fallbackRemoveLabel('Claude, Design team'),
      en.subs.fallbackModelLabel('Codex, Product research'), en.subs.fallbackUpLabel('Codex, Product research'), en.subs.fallbackDownLabel('Codex, Product research'), en.subs.fallbackRemoveLabel('Codex, Product research'),
      en.subs.fallbackModelLabel('GLM, Evening reserve'), en.subs.fallbackUpLabel('GLM, Evening reserve'), en.subs.fallbackRemoveLabel('GLM, Evening reserve'),
      en.subs.fallbackAddLabel('Kimi, Ivan'),
      en.subs.runTestLabel('Kimi'), en.subs.useForOrchestratorLabel('Kimi'), en.subs.pasteKeyLabel('Kimi'), en.subs.removeLabel('Kimi'),
    ]);
    expect(errors).toEqual([]);
  });
}

for (const look of [{ lang: 'en', theme: 'light', width: 375, dir: 'ltr' }, { lang: 'ru', theme: 'light', width: 375, dir: 'ltr' }, { lang: 'en', theme: 'dark', width: 375, dir: 'rtl' }] as Look[]) {
  test(`keeps Remove apart and on the end edge of its row on a phone, in ${lookName(look)}`, async ({ page, browserName }, info) => {
    const { card, errors } = await opened(page, look);
    const remove = await removePlace(card);
    expect(remove.last).toBe(true);
    expect(Math.abs(remove.fromEnd), 'Remove ends its row at the end edge').toBeLessThanOrEqual(1);
    if (remove.sameRow) expect(Math.abs(remove.gap! - 16)).toBeLessThanOrEqual(1);
    expect(remove.danger).toBe(true);
    /* Every button of the foot is a finger's target. */
    for (const b of await card.locator('.plan-card-actions .form-foot > button').all()) {
      const r = await box(b);
      expect(Math.round(r.height)).toBeGreaterThanOrEqual(44);
      expect(Math.round(r.width)).toBeGreaterThanOrEqual(44);
    }
    await card.locator('.plan-card-actions').screenshot({ path: info.outputPath(`foot-${fileName(look)}-${browserName}.png`) });
    expect(errors).toEqual([]);
  });
}

test('opens the whole names of long models as radio buttons under the field, in ru, light, 375px', async ({ page, browserName }, info) => {
  const look: Look = { lang: 'ru', theme: 'light', width: 375, dir: 'ltr' };
  const saved: unknown[] = [];
  const { card, errors } = await opened(page, look);
  await page.route('**/api/subscriptions/s-kimi', async route => {
    saved.push(route.request().postDataJSON());
    return route.fulfill({ json: { subscription: { ...KIMI, ...(route.request().postDataJSON() as object) } } });
  });
  const name = 'Claude, Международная команда проектирования и дизайна';
  const field = card.getByRole('button', { name: ru.subs.fallbackModelLabel(name), exact: true });
  await field.click();
  const group = card.getByRole('group', { name: ru.subs.fallbackModelLabel(name), exact: true });
  await expect(group.getByRole('radio')).toHaveCount(3);
  expect(await whole(card)).toEqual([]);
  await group.scrollIntoViewIfNeeded();
  await card.locator('.fallback-list > .entry').first().screenshot({ path: info.outputPath(`model-list-${fileName(look)}-${browserName}.png`) });
  await group.getByText('Модель для многоязычного анализа и проверки технических описаний с расширенным контекстом').click();
  await expect.poll(() => saved).toEqual([{ fallbacks: [{ subscription: 's-claude', model: 'review' }, CHOSEN[1], CHOSEN[2]] }]);
  await expect(field).toBeFocused();
  await expect(group).toHaveCount(0);
  expect(errors).toEqual([]);
});
