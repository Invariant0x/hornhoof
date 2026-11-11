import { expect, test, type Page } from '@playwright/test';
import { box } from './api';
import { serveTree } from './tree-api';

test.use({ hasTouch: true });

async function openTree(page: Page, lang: 'en' | 'ru', theme: 'light' | 'dark', width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { if (r.method() !== 'GET') writes.push(r.method() + ' ' + new URL(r.url()).pathname); });
  await serveTree(page, { during: true });
  await page.goto('/');
  await page.getByRole('button', { name: lang === 'en' ? /^Development/ : /^Разработка/ }).click();
  await page.getByRole('button', { name: lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
  await expect(page.locator('.tv-in')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { errors, writes };
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      const variant = `${lang}, ${theme}, ${width}px`;
      const close = lang === 'en' ? 'Close' : 'Закрыть';

      test(`read-only tree navigation in ${variant}`, async ({ page }, info) => {
        const { errors, writes } = await openTree(page, lang, theme, width);
        const world = page.locator('.tv-in'), viewport = page.locator('.tv-scroll');
        const drawing = await world.locator('svg[role="group"]').innerHTML();
        const initial = await box(world);
        await page.locator('.dview').getByRole('button', { name: lang === 'en' ? 'Zoom in' : 'Увеличить', exact: true }).click();
        expect((await box(world)).width / initial.width).toBeCloseTo(1.2);
        const area = await box(viewport), before = await box(world), dx = Math.min(140, area.width / 4);
        await page.mouse.move(area.x + area.width / 2, area.y + area.height - 100);
        await page.mouse.down();
        await page.mouse.move(area.x + area.width / 2 + dx, area.y + area.height - 45, { steps: 5 });
        await page.mouse.up();
        expect((await box(world)).x - before.x).toBeCloseTo(dx);
        expect((await box(world)).y - before.y).toBeCloseTo(55);
        const shifted = await box(world);
        await page.mouse.move(area.x + 32, area.y + 32);
        await page.mouse.wheel(0, -100);
        await expect.poll(async () => (await box(world)).width).toBeGreaterThan(shifted.width);
        const touchBefore = await box(world), touch = await page.context().newCDPSession(page);
        const point = { x: area.x + area.width / 2, y: area.y + area.height - 100 };
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + 35, y: point.y + 25 }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await touch.detach();
        expect((await box(world)).x - touchBefore.x).toBeCloseTo(35);
        expect((await box(world)).y - touchBefore.y).toBeCloseTo(25);
        expect(await world.locator('svg[role="group"]').innerHTML()).toBe(drawing);
        await page.screenshot({ path: info.outputPath(`tree-moved-${lang}-${theme}-${width}.png`) });
        expect(writes).toEqual([]);
        expect(errors).toEqual([]);
      });

      test(`left department panels in ${variant}`, async ({ page }, info) => {
        const { errors, writes } = await openTree(page, lang, theme, width);
        const names = lang === 'en' ? ['Department tasks', 'About the department', 'Speed'] : ['Задачи отдела', 'Об отделе', 'Скорость'];
        const panels = [];
        for (const name of names) {
          await page.getByRole('button', { name, exact: true }).click();
          const panel = page.getByRole('complementary', { name, exact: true });
          await expect(panel).toBeVisible();
          panels.push(await box(panel));
          if (name !== names[2]) await panel.getByRole('button', { name: close, exact: true }).click();
        }
        expect(panels[0]!.x).toBe(16);
        expect(panels[1]).toEqual(panels[0]);
        expect(panels[2]).toEqual(panels[0]);
        await page.screenshot({ path: info.outputPath(`speed-left-${lang}-${theme}-${width}.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(writes).toEqual([]);
        expect(errors).toEqual([]);
      });

      test(`agent window from the tree in ${variant}`, async ({ page }, info) => {
        const { errors } = await openTree(page, lang, theme, width);
        const speedName = lang === 'en' ? 'Speed' : 'Скорость';
        await page.getByRole('button', { name: speedName, exact: true }).click();
        const speed = page.getByRole('complementary', { name: speedName, exact: true });
        const leftFrame = await box(speed);
        await speed.getByRole('button', { name: close, exact: true }).click();
        await page.locator('.tv-labs').getByRole('button', { name: /Bruno/ }).click();
        const preview = page.locator('.tv-card');
        await expect(preview).toBeVisible();
        await preview.locator('h4').getByRole('button', { name: /^Bruno/ }).click();
        const agent = page.getByRole('complementary', { name: 'Bruno', exact: true });
        await expect(agent).toBeVisible();
        await expect(page.locator('.tv-card')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`tree-agent-${lang}-${theme}-${width}.png`) });
        await agent.getByRole('button', { name: lang === 'en' ? 'Card' : 'Карточка', exact: true }).click();
        const card = agent.getByRole('complementary', { name: lang === 'en' ? 'Card: Bruno' : 'Карточка: Bruno', exact: true });
        await expect(card).toHaveClass('acard');
        expect(await box(card)).toMatchObject({ width: width === 375 ? width : leftFrame.width });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      });
    }
  }
}

/* A stream a mock ended brings the browser back within seconds, and on each return the whole app fetches what it missed: pages
   then keep working on their own, and tests time out on a busy machine. It has to stay open. */
test('an idle page keeps its stream and asks for nothing again', async ({ page }) => {
  /* The stream is asked for first; an answer to it would come before the answers that open the tree. */
  const answered: string[] = [];
  page.on('response', r => { if (new URL(r.url()).pathname === '/api/stream') answered.push(r.url()); });
  await page.clock.install();
  const { errors } = await openTree(page, 'en', 'dark', 1440);
  const asked: string[] = [];
  page.on('request', r => asked.push(new URL(r.url()).pathname));
  /* A minute of the page's own timers passes on its clock at once. */
  await page.clock.runFor(60_000);
  expect(answered).toEqual([]);
  expect(asked.filter(path => path === '/api/stream' || path === '/api/org')).toEqual([]);
  expect(errors).toEqual([]);
});
