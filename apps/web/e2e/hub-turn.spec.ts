import { expect, test, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { FIVE, ONE, serveHubTurn, THREE, type Company } from './hub-turn-api';

test.use({ reducedMotion: 'reduce' });

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };

/* A department's card, by the start of its name; its strip, and the squares lit in it. */
const card = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });
const bar = (page: Page, name: string) => card(page, name).locator('.dept-turn [role="progressbar"]');
const with_ = (company: Company, name: string, progress: [number, number]): Company => company.map(d => (d.name === name ? { ...d, progress } : d));

async function open(page: Page, lang: 'en' | 'ru', theme: 'light' | 'dark', width: number, start: Company = ONE) {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [];
  const failures: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  page.on('requestfailed', r => failures.push(r.url()));
  page.on('response', r => { if (r.status() >= 400) failures.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const live = await serveHubTurn(page, start);
  await page.goto('/');
  await expect(page.locator('.hub')).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { live, errors, failures };
}

/* Each strip and its counter fit their card on one line, every card holds what it shows, the tag on the hub stays inside its
   inner circle under the count, and the page never scrolls sideways. */
async function looksRight(page: Page) {
  const found = await page.evaluate(() => {
    const strips = [...document.querySelectorAll<HTMLElement>('.dept-turn')].map(s => {
      const card = s.closest<HTMLElement>('button.dept')!.getBoundingClientRect(), r = s.getBoundingClientRect();
      const head = s.querySelector<HTMLElement>('.dt-head')!;
      return {
        inside: r.left >= card.left && r.right <= card.right + 0.5 && r.top >= card.top && r.bottom <= card.bottom + 0.5,
        wide: s.scrollWidth <= s.clientWidth,
        oneLine: head.offsetHeight <= 16,
      };
    });
    const cards = [...document.querySelectorAll<HTMLElement>('button.dept .edge-in')].map(e => e.scrollHeight <= e.clientHeight && e.scrollWidth <= e.clientWidth);
    const hub = document.querySelector<HTMLElement>('.hub')!, tag = document.querySelector<HTMLElement>('.hub-focus-tag');
    let tagFits = true;
    if (tag) {
      const h = hub.getBoundingClientRect(), r = tag.getBoundingClientRect(), k = h.width / 240;
      const cx = h.left + h.width / 2, cy = h.top + h.height / 2;
      const corners = [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]];
      const num = document.querySelector<HTMLElement>('.hub-num')!.getBoundingClientRect();
      tagFits = corners.every(([x, y]) => Math.hypot(x! - cx, y! - cy) / k <= 88) && r.top >= num.bottom - 0.5;
    }
    return { strips, cards, tagFits, scroll: document.documentElement.scrollWidth <= innerWidth };
  });
  expect(found.strips.every(s => s.inside && s.wide && s.oneLine), JSON.stringify(found.strips)).toBe(true);
  expect(found.cards.every(Boolean), JSON.stringify(found.cards)).toBe(true);
  expect(found.tagFits).toBe(true);
  expect(found.scroll).toBe(true);
}

/* The hub's sectors, by the department each belongs to, with their classes. */
const sectors = (page: Page) => page.locator('.hub .turn-sec').evaluateAll(gs => gs.map(g => [g.getAttribute('data-dept'), g.getAttribute('class')]));

/* What a lit square, the strip's edge and a lit sector are painted with. */
const paints = (page: Page) =>
  page.evaluate(() => ({
    square: getComputedStyle(document.querySelector('.dept-sq i.on')!).backgroundColor,
    edge: getComputedStyle(document.querySelector('.dept-turn')!).borderLeftColor,
    arc: getComputedStyle(document.querySelector('.turn-sec-fill')!).stroke,
  }));

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375, 360]) {
      test(`each department working in the turn shows it in its card and on the hub in ${lang} ${theme} ${width}`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        const label = (done: number, total: number) => t.tasks.turnProgress(done, total);
        const shot = (name: string) => page.screenshot({ path: info.outputPath(`hub-${name}-${lang}-${theme}-${width}.png`), animations: 'disabled' });
        const { live, errors, failures } = await open(page, lang, theme, width);
        const initialDocument = await page.evaluateHandle(() => document);
        const hub = page.locator('.hub');
        const tag = hub.locator('.hub-focus-tag');

        /* One department works in the turn; Operations works all the time. */
        await expect(page.locator('.hub-turn')).toHaveCount(0);
        await expect(page.locator('.hub-lbl')).toHaveCount(0);
        const dev = bar(page, 'Development');
        await expect(dev).toHaveAttribute('aria-label', label(3, 17));
        await expect(dev).toHaveAttribute('aria-valuenow', '18');
        await expect(dev.locator('i')).toHaveCount(20);
        await expect(dev.locator('i.on')).toHaveCount(4);
        await expect(card(page, 'Development').locator('.dt-turn')).toHaveText(t.tasks.turn(3));
        await expect(card(page, 'Development').locator('.dt-cnt')).toHaveText(label(3, 17));
        await expect(card(page, 'Operations').locator('.dept-turn')).toHaveCount(0);
        await expect(hub.locator('.hub-hz')).toHaveAttribute('d', 'M 64 120 L 176 120');
        await expect(hub.locator('.hub-eq')).toHaveCount(1);
        await expect(hub.locator('.turn-sec')).toHaveCount(1);
        await expect(hub.locator('.turn-sec-bg')).toHaveAttribute('pathLength', '19.72');
        await expect(hub.locator('.turn-sec-fill')).toHaveAttribute('pathLength', '3.72');
        await expect(tag).toHaveText(t.tasks.turn(3));
        /* A card that works all the time keeps its task line right under its squares, as its neighbour does, with the room for
           a strip below it. */
        const underSquares = (name: string) => card(page, name).locator('.edge-in').evaluate(e => e.querySelector('.now')!.getBoundingClientRect().top - e.querySelector('.cells')!.getBoundingClientRect().bottom);
        expect(await underSquares('Operations')).toBeCloseTo(await underSquares('Development'), 1);
        const paint = await paints(page);
        expect(paint.square).toBe(paint.edge);
        expect(paint.arc).toBe(paint.edge);
        await looksRight(page);
        await shot('one');

        /* The Tasks screen keeps the whole turn's progress as it was. */
        await page.getByRole('button', { name: t.shell.tabs.tasks, exact: true }).click();
        await expect(page.getByRole('progressbar', { name: label(3, 17) })).toHaveAttribute('aria-valuenow', '18');
        await page.getByRole('button', { name: t.shell.tabs.map, exact: true }).click();
        await expect(dev).toHaveAttribute('aria-valuenow', '18');

        /* Tasks close while the map is open. */
        await live.show(with_(ONE, 'Development', [4, 17]));
        await expect(dev).toHaveAttribute('aria-valuenow', '24');
        await expect(dev.locator('i.on')).toHaveCount(5);
        await live.show(with_(ONE, 'Development', [1000, 1000]));
        await expect(dev).toHaveAttribute('aria-label', label(1000, 1000));
        await expect(dev).toHaveAttribute('aria-valuenow', '100');
        await expect(dev.locator('i.on')).toHaveCount(20);
        await expect(hub.locator('.turn-sec-fill')).toHaveAttribute('pathLength', '19.72');
        await looksRight(page);

        /* Three departments work: three sectors in the order of the cards, and no sum of them at rest. */
        await live.show(THREE);
        await expect(hub.locator('.turn-sec')).toHaveCount(3);
        await expect(hub.locator('.turn-sec-sep')).toHaveCount(2);
        expect(await sectors(page)).toEqual([['d1', 'turn-sec'], ['d3', 'turn-sec'], ['d4', 'turn-sec']]);
        await expect(tag).toHaveCount(0);
        await expect(hub).not.toContainText('%');
        await looksRight(page);
        await shot('three');
        await card(page, 'Marketing').hover();
        await expect(tag).toHaveText(`CMO · ${t.tasks.turn(3)}`);
        expect(await sectors(page)).toEqual([['d1', 'turn-sec dim'], ['d3', 'turn-sec active'], ['d4', 'turn-sec dim']]);
        await looksRight(page);
        await page.mouse.move(0, 0);
        await expect(tag).toHaveCount(0);

        /* Five departments work; a card focused from the keyboard names its turn on the hub. */
        await live.show(FIVE);
        await expect(hub.locator('.turn-sec')).toHaveCount(5);
        await expect(hub.locator('.turn-sec-sep')).toHaveCount(4);
        await expect(page.locator('.dept-turn')).toHaveCount(5);
        await card(page, 'Development').focus();
        await expect(tag).toHaveText(`CTO · ${t.tasks.turn(3)}`);
        await looksRight(page);
        await shot('five');
        await card(page, 'Development').blur();
        await expect(tag).toHaveCount(0);

        /* The turn closes: the cards and the hub go back to how they were. */
        await live.closeTurn();
        await expect(page.locator('.dept-turn')).toHaveCount(0);
        await expect(hub.locator('.turn-sec, .hub-eq, .hub-focus-tag')).toHaveCount(0);
        expect(await page.locator('button.dept').evaluateAll(cards => cards.map(c => (c as HTMLElement).style.height))).toEqual(Array(6).fill('160px'));
        await looksRight(page);
        await shot('closed');
        expect(await page.evaluate(initial => document === initial, initialDocument)).toBe(true);
        expect(errors).toEqual([]);
        expect(failures).toEqual([]);
      });
    }
  }
}

for (const [lang, theme, width] of [['en', 'light', 1440], ['ru', 'dark', 375]] as const) {
  test(`a department switched to work all the time leaves the turn on the map in ${lang} ${theme} ${width}`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    const { live, errors, failures } = await open(page, lang, theme, width);
    await expect(bar(page, 'Development')).toHaveAttribute('aria-valuenow', '18');
    await card(page, 'Development').click();
    await page.getByRole('button', { name: t.dept.about, exact: true }).click();
    const how = page.getByRole('region', { name: t.dept.workMode.title, exact: true });
    const turns = how.getByRole('radio', { name: t.dept.workMode.turns, exact: true });
    const always = how.getByRole('radio', { name: t.dept.workMode.continuous, exact: true });
    await expect(turns).toBeChecked();
    await expect(how).toContainText(t.dept.workMode.turnsHint);
    await expect(how).toContainText(t.dept.workMode.continuousHint);
    expect(await page.evaluate(() => {
      const drawer = document.querySelector('.dv-drawer')!;
      return document.documentElement.scrollWidth <= innerWidth && drawer.scrollWidth <= drawer.clientWidth;
    })).toBe(true);
    await how.screenshot({ path: info.outputPath(`work-mode-${lang}-${theme}-${width}.png`) });
    await page.screenshot({ path: info.outputPath(`work-mode-page-${lang}-${theme}-${width}.png`) });

    await always.check();
    await expect(always).toBeChecked();
    expect(live.puts).toEqual([{ workMode: 'continuous' }]);
    await page.getByRole('button', { name: t.dept.close, exact: true }).click();
    await page.getByRole('button', { name: t.dept.back, exact: true }).click();
    await expect(card(page, 'Development')).toBeVisible();
    await expect(page.locator('.dept-turn')).toHaveCount(0);
    await expect(page.locator('.hub .turn-sec, .hub .hub-eq, .hub .hub-focus-tag')).toHaveCount(0);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  });
}
