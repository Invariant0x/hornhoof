import { expect, test } from '@playwright/test';
import { HUB_TURN, serveHubTurn } from './hub-turn-api';

test.use({ reducedMotion: 'reduce' });

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`hub turn progress in ${lang} ${theme} ${width}`, async ({ page }, info) => {
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
        const live = await serveHubTurn(page);
        const label = (done: number, total: number) => lang === 'en' ? `${done} of ${total} tasks done` : `Готово ${done} из ${total} задач`;
        const tasksTab = lang === 'en' ? 'Tasks' : 'Задачи';
        const mapTab = lang === 'en' ? 'Map' : 'Карта';
        await page.goto('/');
        const initialDocument = await page.evaluateHandle(() => document);
        const hub = page.locator('.hub-turn');
        await expect(hub.locator('b')).toHaveText(lang === 'en' ? 'Turn 3' : 'Ход 3');
        await expect(hub).toContainText(label(3, 17));
        await expect(hub).not.toContainText(HUB_TURN.goal);
        await expect(hub).toHaveAttribute('title', `${HUB_TURN.title}\n${HUB_TURN.goal}`);
        await expect(hub.getByRole('progressbar', { name: label(3, 17) })).toHaveAttribute('aria-valuenow', '18');
        await page.evaluate(() => document.fonts.ready);
        const geometry = await hub.evaluate((e: HTMLElement) => ({ width: e.offsetWidth, height: e.offsetHeight, scrollWidth: e.scrollWidth }));
        await info.attach('hub-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        /* The previous one-line goal on this fixture measured 36 CSS pixels high. */
        expect(geometry.height).toBeLessThanOrEqual(36);
        expect(geometry.width).toBe(152);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
        const track = await hub.locator('.turn-track').boundingBox();
        const fill = await hub.locator('.turn-track i').boundingBox();
        expect(fill!.width / track!.width).toBeCloseTo(0.18, 2);
        await hub.hover();
        expect(await hub.evaluate(e => {
          const r = e.getBoundingClientRect();
          return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        })).toBe(true);
        await page.screenshot({ path: info.outputPath(`after-map-${lang}-${theme}-${width}.png`), animations: 'disabled' });

        const progress = await hub.locator('.turn-progress').innerHTML();
        await page.getByRole('button', { name: tasksTab, exact: true }).click();
        const tracker = page.getByRole('progressbar', { name: label(3, 17) });
        await expect(tracker).toHaveAttribute('aria-valuenow', '18');
        expect(await tracker.locator('..').innerHTML()).toBe(progress);
        await page.getByRole('button', { name: mapTab, exact: true }).click();
        await expect(hub).toContainText(label(3, 17));

        await live.updateTasks({ done: 4, total: 17 });
        await expect(hub.getByRole('progressbar', { name: label(4, 17) })).toHaveAttribute('aria-valuenow', '24');
        await live.updateTasks({ done: 4, total: 18 });
        await expect(hub.getByRole('progressbar', { name: label(4, 18) })).toHaveAttribute('aria-valuenow', '22');
        await page.getByRole('button', { name: tasksTab, exact: true }).click();
        await expect(page.getByRole('progressbar', { name: label(4, 18) })).toHaveAttribute('aria-valuenow', '22');
        await page.getByRole('button', { name: mapTab, exact: true }).click();
        await expect(hub).toContainText(label(4, 18));
        await live.updateTasks({ done: 1000, total: 1000 });
        await expect(hub.getByRole('progressbar', { name: label(1000, 1000) })).toHaveAttribute('aria-valuenow', '100');
        const large = await hub.evaluate((e: HTMLElement) => ({ width: e.offsetWidth, height: e.offsetHeight, scrollWidth: e.scrollWidth }));
        expect(large.height).toBeLessThanOrEqual(36);
        expect(large.width).toBe(152);
        expect(large.scrollWidth).toBeLessThanOrEqual(large.width);
        await live.closeTurn();
        await expect(hub).toHaveCount(0);
        expect(await page.evaluate(initial => document === initial, initialDocument)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        expect(failures).toEqual([]);
      });
    }
  }
}
