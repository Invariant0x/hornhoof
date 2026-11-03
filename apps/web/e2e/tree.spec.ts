import { expect, test, type Page } from '@playwright/test';
import { serveApi } from './api';
import { wholeTurn } from './whole-turn';

async function serveTree(page: Page, live: { during: boolean }) {
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()), path = url.pathname + url.search;
    const { tree, org } = wholeTurn(live.during);
    const routes: Record<string, unknown> = {
      '/api/org': org,
      '/api/departments/d2/tree': { tree },
      '/api/tasks?status=open&department=d2': { tasks: [] },
      '/api/version': { version: '0.5.0', commit: 'task-148' },
      '/api/updates': { current: { version: '0.5.0', commit: 'task-148' }, available: false, latest: null, updater: { status: null, waiting: null } },
    };
    return path in routes ? route.fulfill({ json: routes[path] }) : route.fallback();
  });
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`whole-turn tree in ${lang}, ${theme}, ${width}px`, async ({ page }, info) => {
        test.setTimeout(90_000);
        await page.setViewportSize({ width, height: 1200 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const live = { during: true };
        await serveTree(page, live);
        for (const during of [true, false]) {
          live.during = during;
          await page.goto('/');
          await page.getByRole('button', { name: lang === 'en' ? /Development/ : /Разработка/ }).click();
          await page.getByRole('button', { name: lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
          const graph = page.getByRole('group', { name: lang === 'en' ? 'Tree of turn 4' : 'Дерево хода 4' });
          await expect(graph).toBeVisible();
          const labs = page.locator('.tv-labs');
          if (width === 375) await expect(labs.getByRole('button', { name: /Ostap/ }).getByText('#140', { exact: true })).toBeVisible();
          await expect(labs.getByRole('button', { name: /Bruno/ })).toHaveCount(1);
          await expect(labs.getByRole('button', { name: /Vera/ })).toHaveCount(1);
          await expect(labs.getByRole('button', { name: /Gleb/ })).toHaveCount(1);
          await expect(graph.getByRole('button', { name: /#90/ })).not.toHaveCount(0);
          await expect(graph.getByRole('button', { name: /#121/ })).not.toHaveCount(0);
          await expect(graph.locator('.seg.al').first()).toHaveCSS('stroke', theme === 'light' ? 'rgb(211, 47, 47)' : 'rgb(255, 107, 107)');
          expect(await graph.evaluate(svg => [...svg.querySelectorAll<SVGGraphicsElement>('.bdg')].every(b => b.getBBox().x + b.getBBox().width <= (svg as SVGSVGElement).viewBox.baseVal.width))).toBe(true);
          expect(await graph.locator('.ic-ok').count()).toBeGreaterThanOrEqual(during ? 4 : 5);
          const oldTask = graph.getByRole('button', { name: /#62 Night checkout work/ }).first();
          await oldTask.scrollIntoViewIfNeeded();
          await oldTask.focus();
          await page.keyboard.press('Enter');
          await expect(page.getByRole('dialog', { name: /#62 Night checkout work/ })).toBeVisible();
          await page.keyboard.press('Escape');
          const oldReview = graph.getByRole('button', { name: /Vera, #90/ }).first();
          await oldReview.scrollIntoViewIfNeeded();
          await oldReview.click();
          const card = page.getByRole('dialog', { name: /#90/ });
          await expect(card).toContainText(lang === 'en' ? '2 findings' : '2 находки');
          await page.keyboard.press('Escape');
          await page.locator('.tv-scroll').evaluate(el => { el.scrollLeft = 0; });
          await page.screenshot({ path: info.outputPath(`tree-${width}-${lang}-${theme}-${during ? 'review' : 'after'}-start.png`) });
          await page.locator('.tv-scroll').evaluate(el => { el.scrollLeft = el.scrollWidth; });
          expect(await graph.locator('.g-now').evaluate(el => el.getBoundingClientRect().x)).toBeGreaterThan(await labs.evaluate(el => el.getBoundingClientRect().right));
          if (during) {
            await expect(labs.getByRole('button', { name: /Bruno/ })).toContainText(lang === 'en' ? 'waits for Hana since' : 'ждет Hana с');
            await expect(labs.getByRole('button', { name: /Ostap/ })).toContainText(lang === 'en' ? 'Image build, until' : 'Image build, до');
          } else {
            await expect(labs.getByRole('button', { name: /Sid/ })).toBeVisible();
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await page.screenshot({ path: info.outputPath(`tree-${width}-${lang}-${theme}-${during ? 'review' : 'after'}-end.png`) });
          await page.getByRole('button', { name: lang === 'en' ? 'Speed' : 'Скорость', exact: true }).click();
          const speed = page.getByRole('complementary', { name: lang === 'en' ? 'Speed' : 'Скорость' });
          await expect(speed.getByText(lang === 'en' ? 'Interrupted' : 'Прерывание', { exact: true })).toBeVisible();
          await expect(speed.getByText(lang === 'en' ? 'Queued' : 'В очереди', { exact: true })).toBeVisible();
          await page.screenshot({ path: info.outputPath(`speed-${width}-${lang}-${theme}-${during ? 'review' : 'after'}.png`) });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }
        expect(errors).toEqual([]);
      });
    }
  }
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`tree edges in ${lang}, ${theme}`, async ({ page }, info) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 375, height: 1200 });
      await page.addInitScript(({ lang, theme }) => {
        localStorage.setItem('hh-lang', lang);
        localStorage.setItem('hh-theme', theme);
      }, { lang, theme });
      await serveTree(page, { during: true });
      await page.route('**/api/org', route => {
        const { org } = wholeTurn(true);
        org.departments[0]!.employees.find(e => e.name === 'Bruno')!.name = 'Bruno Very Long Employee Name For A Narrow Screen';
        return route.fulfill({ json: org });
      });
      let mode: 'pending' | 'empty' | 'error' | 'long' = 'pending';
      let release = () => {};
      const held = new Promise<void>(resolve => { release = resolve; });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/departments/d2/tree', async route => {
        if (mode === 'pending') await held;
        if (mode === 'error') return route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } });
        const { tree } = wholeTurn(true);
        if (mode === 'empty') return route.fulfill({ json: { tree: { ...tree, turn: null, lines: [], reviews: [], review: null, time: [], idle: [] } } });
        const longName = 'Bruno Very Long Employee Name For A Narrow Screen';
        tree.lines = tree.lines.map(l => l.agent.name === 'Bruno' ? { ...l, agent: { ...l.agent, name: longName } } : l);
        return route.fulfill({ json: { tree } });
      });
      const open = async () => {
        await page.goto('/');
        await page.getByRole('button', { name: lang === 'en' ? /Development/ : /Разработка/ }).click();
        await page.getByRole('button', { name: lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
      };
      await open();
      await expect(page.locator('.tv-empty')).toHaveText(lang === 'en' ? 'Loading…' : 'Загрузка…');
      await page.screenshot({ path: info.outputPath('tree-loading.png') });
      mode = 'empty';
      release();
      await expect(page.locator('.tv-empty')).toHaveText(lang === 'en' ? 'No turn is open now.' : 'Сейчас нет открытого хода.');
      await page.screenshot({ path: info.outputPath('tree-empty.png') });
      mode = 'error';
      const failed = page.waitForResponse(r => r.url().endsWith('/api/departments/d2/tree') && r.status() === 503);
      await open();
      await failed;
      await expect(page.locator('.tv-empty')).toHaveText(lang === 'en' ? 'This is not available right now.' : 'Сейчас это недоступно.');
      await page.screenshot({ path: info.outputPath('tree-error.png') });
      mode = 'long';
      await open();
      await expect(page.getByRole('group', { name: lang === 'en' ? 'Tree of turn 4' : 'Дерево хода 4' })).toBeVisible();
      await page.getByRole('button', { name: lang === 'en' ? 'Key' : 'Обозначения', exact: true }).click();
      await expect(page.locator('.lgd-l')).toContainText(lang === 'en' ? 'no recorded state' : 'нет записанного состояния');
      await page.screenshot({ path: info.outputPath('tree-long-name-key.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}
