import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { box } from './api';
import { instrumentChipRenders, resetChipRenders, chipRenderNames, chipRenders, serveFullDepartment, openDepartment } from './tree-performance-helpers';

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

test('100 pan movements move the scene without rendering its chips', async ({ page }, info) => {
  await instrumentChipRenders(page);
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  await serveFullDepartment(page);
  await openDepartment(page, true);
  const scene = page.locator('.tv-in'), before = await scene.getAttribute('style');
  await resetChipRenders(page);
  const bounds = await box(page.locator('.tv-scroll')), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 0; i < 100; i++) await page.mouse.move(x + (i % 20) * 3, y + (i % 10) * 2);
  await page.mouse.up();
  const after = await scene.getAttribute('style'), renders = await chipRenders(page);
  const countPath = info.outputPath('pan-render-count.json');
  await writeFile(countPath, JSON.stringify({ movements: 100, before, after, renders }, null, 2));
  await info.attach('pan-render-count.json', { path: countPath, contentType: 'application/json' });
  expect(after, 'the pointer drag really moved the scene').not.toBe(before);
  expect(renders, 'no chip rendered after its initial mount').toBe(0);
});

test('a real employee update renders only the changed chip', async ({ page }, info) => {
  await instrumentChipRenders(page);
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  const served = await serveFullDepartment(page);
  await openDepartment(page, true);
  const title = 'A genuinely refreshed task title';
  const hana = page.locator('.tv-labs .dept-chip').filter({ has: page.locator('.mn', { hasText: /^Hana$/ }) }).locator('.schip');
  const originalHana = await hana.elementHandle();
  await resetChipRenders(page);
  served.renameBrunoTask(title);
  const response = page.waitForResponse(r => r.url().endsWith('/api/org'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await response;
  await expect(page.locator('.tv-labs .dept-chip').filter({ has: page.locator('.mn', { hasText: /^Bruno$/ }) })).toContainText(title);
  expect(await originalHana!.evaluate(el => el.isConnected), 'an unchanged chip is not remounted').toBe(true);
  const renders = await chipRenderNames(page);
  const updatePath = info.outputPath('update-render-count.json');
  await writeFile(updatePath, JSON.stringify({ title, renders }, null, 2));
  await info.attach('update-render-count.json', { path: updatePath, contentType: 'application/json' });
  expect(renders.length, 'the changed employee really rendered').toBeGreaterThan(0);
  expect([...new Set(renders)], 'only Bruno has new employee data').toEqual(['Bruno']);
});
