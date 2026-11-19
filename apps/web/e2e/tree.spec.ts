import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { serveApi, writeToOrchestrator } from './api';
import { wholeTurn } from './whole-turn';
import { serveTree } from './tree-api';


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
          await page.getByRole('button', { name: lang === 'en' ? /^Development/ : /^Разработка/ }).click();
          await page.getByRole('button', { name: lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
          const graph = page.getByRole('group', { name: lang === 'en' ? 'Tree of turn 4' : 'Дерево хода 4' });
          await expect(graph).toBeVisible();
          const labs = page.locator('.tv-labs');
          await expect(labs.getByRole('button', { name: /Ostap/ })).toContainText(during ? '#140 Checkout step 140' : (lang === 'en' ? en : ru).dept.waitsForTask);
          await expect(labs.getByRole('button', { name: /Bruno/ })).toHaveCount(1);
          await expect(labs.getByRole('button', { name: /Vera/ })).toHaveCount(1);
          await expect(labs.getByRole('button', { name: /Gleb/ })).toHaveCount(1);
          await expect(graph.getByRole('button', { name: /#90/ })).not.toHaveCount(0);
          await expect(graph.getByRole('button', { name: /#121/ })).not.toHaveCount(0);
          await expect(graph.locator('.seg.al').first()).toHaveCSS('stroke', theme === 'light' ? 'rgb(198, 40, 40)' : 'rgb(255, 107, 107)');
          expect(await graph.evaluate(svg => [...svg.querySelectorAll<SVGGraphicsElement>('.bdg')].every(b => b.getBBox().x + b.getBBox().width <= (svg as SVGSVGElement).viewBox.baseVal.width))).toBe(true);
          /* Since 0.17.0 a check is a task of its own: its card shows the stage, the stage's owner and the findings, not verdict marks. */
          await expect(graph.locator('.ic-ok')).toHaveCount(0);
          const route = (lang === 'en' ? en : ru).tasks.echelons;
          for (const [name, number, stage, findings] of [['Vera', 121, 'review', 2], ['Rita', 122, 'tests', 0], ['Gleb', 123, 'security', 0]] as const) {
            const check = graph.getByRole('button', { name: new RegExp(`^${name}, #${number} `) }).first();
            await check.scrollIntoViewIfNeeded();
            await check.focus();
            await page.keyboard.press('Enter');
            const card = page.locator('.tv-card'), step = card.locator('li[aria-current="step"]');
            await expect(card.getByRole('button', { name: `#${number} Check checkout step ${number}` })).toBeVisible();
            await expect(step).toContainText(route.stages[stage]);
            await expect(step).toContainText(route.owner(name));
            await expect(card.getByRole('region', { name: route.findings.heading })).toContainText(route.findings.unique(findings));
            await page.keyboard.press('Escape');
            await expect(card).toHaveCount(0);
          }
          const oldAlarm = graph.getByRole('button', { name: lang === 'en' ? /Hana: program frozen since 06:11/ : /Hana: программа замерла с 06:11/ }).first();
          await oldAlarm.scrollIntoViewIfNeeded();
          await oldAlarm.focus();
          await expect(oldAlarm).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(page.locator('.tv-card')).toBeVisible();
          await page.locator('.tv-card h4').getByRole('button', { name: /^Hana/ }).focus();
          await page.keyboard.press('Enter');
          const headWindow = page.getByRole('complementary', { name: 'Hana', exact: true });
          await expect(headWindow).toBeVisible();
          await expect(page.locator('.tv-card')).toHaveCount(0);
          await headWindow.getByRole('button', { name: lang === 'en' ? 'Close' : 'Закрыть', exact: true }).click();
          const oldTask = graph.getByRole('button', { name: /#62 Night checkout work/ }).first();
          await oldTask.scrollIntoViewIfNeeded();
          await oldTask.focus();
          await page.keyboard.press('Enter');
          await expect(page.locator('.tv-card')).toBeVisible();
          await page.locator('.tv-card h4').getByRole('button', { name: /^Bruno/ }).focus();
          await page.keyboard.press('Enter');
          const agentWindow = page.getByRole('complementary', { name: 'Bruno', exact: true });
          await expect(agentWindow).toBeVisible();
          await page.screenshot({ path: info.outputPath(`tree-agent-${width}-${lang}-${theme}.png`) });
          await agentWindow.getByRole('button', { name: lang === 'en' ? 'Close' : 'Закрыть', exact: true }).click();
          const oldReview = graph.getByRole('button', { name: /Vera, #90/ }).first();
          await oldReview.scrollIntoViewIfNeeded();
          await oldReview.focus();
          await page.keyboard.press('Enter');
          await expect(page.locator('.tv-card')).toBeVisible();
          await page.locator('.tv-card h4').getByRole('button', { name: /^Vera/ }).focus();
          await page.keyboard.press('Enter');
          const reviewer = page.getByRole('complementary', { name: 'Vera', exact: true });
          await expect(reviewer).toBeVisible();
          await reviewer.getByRole('button', { name: lang === 'en' ? 'Close' : 'Закрыть', exact: true }).click();
          await page.locator('.dview').getByRole('button', { name: lang === 'en' ? 'Show everything' : 'Показать все', exact: true }).click();
          await page.screenshot({ path: info.outputPath(`tree-${width}-${lang}-${theme}-${during ? 'review' : 'after'}-start.png`) });

          expect(await graph.locator('.g-now').evaluate(el => el.getBoundingClientRect().x)).toBeGreaterThan(await labs.evaluate(el => el.getBoundingClientRect().right));
          if (during) {
            await expect(graph.locator('.bdg').filter({ hasText: lang === 'en' ? 'waits for Hana since' : 'ждет Hana с' }).first()).toBeVisible();
            await expect(graph.locator('.bdg').filter({ hasText: lang === 'en' ? 'Image build, until' : 'Image build, до' }).first()).toBeVisible();
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
        if (mode === 'empty') return route.fulfill({ json: { tree: { ...tree, turn: null, lines: [], time: [], idle: [] } } });
        const longName = 'Bruno Very Long Employee Name For A Narrow Screen';
        tree.lines = tree.lines.map(l => l.agent.name === 'Bruno' ? { ...l, agent: { ...l.agent, name: longName } } : l);
        return route.fulfill({ json: { tree } });
      });
      const open = async () => {
        await page.goto('/');
        await page.getByRole('button', { name: lang === 'en' ? /^Development/ : /^Разработка/ }).click();
        await page.getByRole('button', { name: lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
      };
      await open();
      await expect(page.locator('.tv-empty')).toHaveText(lang === 'en' ? 'Loading…' : 'Загрузка…');
      await page.screenshot({ path: info.outputPath('tree-loading.png') });
      mode = 'empty';
      release();
      await expect(page.locator('.tv-empty')).toHaveText(lang === 'en' ? 'This department runs no turn now.' : 'Сейчас у отдела нет открытого хода.');
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

for (const lang of ['en', 'ru'] as const) {
  test(`program history stays out of conversation lines in ${lang}`, async ({ page }, info) => {
    const theme = lang === 'en' ? 'light' : 'dark';
    await page.setViewportSize({ width: lang === 'en' ? 375 : 1440, height: 900 });
    await page.addInitScript(({ lang, theme }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', theme);
    }, { lang, theme });
    await serveApi(page);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url()), path = url.pathname + url.search;
      const event = (seq: number, kind: string, data: unknown) => ({ seq, kind, data, at: '2026-11-03T10:00:00Z', jobId: 'j1', person: null });
      const state = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };
      const routes: Record<string, unknown> = {
        '/api/agents/orchestrator/events?last=300': { events: [event(1, 'text', { text: 'Starting checkout.' }),
          event(2, 'program', { program: { state: 'thinking', since: Date.parse('2026-11-03T10:00:00Z'), tool: null }, alarm: null }),
          event(3, 'text', { text: 'Checkout is ready.' })], state },
        '/api/agents/orchestrator/events?after=3': { events: [], state },
        '/api/agents/orchestrator/start': { started: false },
        '/api/nodes/commands': { commands: [] },
        '/api/machines/access': { views: [] },
        '/api/version': { version: '0.5.0', commit: 'task-148' },
        '/api/updates': { current: { version: '0.5.0', commit: 'task-148' }, available: false, latest: null, updater: { status: null, waiting: null } },
      };
      return path in routes ? route.fulfill({ json: routes[path] }) : route.fallback();
    });
    await page.goto('/');
    await page.getByRole('button', { name: lang === 'en' ? 'Tasks' : 'Задачи', exact: true }).click();
    await writeToOrchestrator(page, lang);
    const panel = page.getByRole('complementary', { name: lang === 'en' ? 'Orchestrator' : 'Оркестратор' });
    await expect(panel.getByText('Checkout is ready.', { exact: true })).toBeVisible();
    await expect(panel.locator('.t-line')).toHaveCount(2);
    await page.screenshot({ path: info.outputPath(`program-log-${lang}-${theme}.png`) });
    expect(errors).toEqual([]);
  });
}
