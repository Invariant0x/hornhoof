import { expect, test } from '@playwright/test';
import { box } from './api';
import { openTree, variants } from './tree-navigation-steps';

/* Moving and zooming the tree, and a page that stays quiet; tree-navigation-steps.ts says what the tree holds. */
test.use({ hasTouch: true });

for (const { lang, theme, width, variant } of variants()) {
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
