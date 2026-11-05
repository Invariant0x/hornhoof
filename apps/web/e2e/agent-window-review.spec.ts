import { expect, test } from '@playwright/test';
import { ME } from './api';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  test(`product task, inaccessible agents and company failure in ${lang}, ${theme}, ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ lang, theme }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', theme);
    }, { lang, theme });
    const live: AgentFixture = { awake: false, hasTask: true, messages: [], connections: 0, productOnly: true, privateAgent: true };
    await serveAgentWindow(page, live);
    await page.route('**/api/me', route => route.fulfill({ json: { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } } }));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const words = lang === 'en'
      ? { subscriptions: 'Subscriptions', machines: 'Machines', card: 'Open the card of', open: 'Open Bruno', privateOpen: 'Open Private agent', task: 'Task', back: 'Back to conversation', close: 'Close' }
      : { subscriptions: 'Подписки', machines: 'Машины', card: 'Открыть карточку', open: 'Открыть: Bruno', privateOpen: 'Открыть: Private agent', task: 'Задача', back: 'К переписке', close: 'Закрыть' };
    for (const source of ['subscriptions', 'machines'] as const) {
      await page.goto('/');
      await page.getByRole('navigation').getByRole('button', { name: words[source], exact: true }).click();
      await page.getByRole('button', { name: new RegExp(`${words.card}.*${source === 'subscriptions' ? 'Codex' : 'test-machine'}`) }).click();
      await expect(page.getByText('Private agent', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: words.privateOpen, exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`access-${source}-${lang}-${theme}-${width}.png`) });
      await page.getByRole('button', { name: words.open, exact: true }).click();
      const window = page.getByRole('complementary', { name: /^Bruno,/ });
      await window.getByRole('button', { name: words.task, exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Checkout step 1', exact: true })).toBeVisible();
      /* Only a phone gives the conversation's place to the panel: on a wide screen it stays in sight and there is no way back to it. */
      const back = window.getByRole('button', { name: words.back, exact: true });
      await expect(back).toHaveCount(width === 375 ? 1 : 0);
      await page.screenshot({ path: info.outputPath(`product-task-${source}-${lang}-${theme}-${width}.png`) });
      if (width === 375) await back.click();
      else await window.getByRole('complementary', { name: /Checkout step 1/ }).getByRole('button', { name: words.close, exact: true }).click();
      await expect(window.getByRole('textbox')).toBeVisible();
      await window.getByRole('button', { name: words.close, exact: true }).click();
    }
    live.orgFailure = true;
    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: words.machines, exact: true }).click();
    await page.getByRole('button', { name: new RegExp(`${words.card}.*test-machine`) }).click();
    await page.getByRole('button', { name: words.open, exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(lang === 'en' ? 'Company temporarily unavailable' : 'Что-то пошло не так.');
    await expect(page.getByRole('alert')).toBeInViewport();
    await expect.poll(() => page.getByRole('alert').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    await page.screenshot({ path: info.outputPath(`company-failure-${lang}-${theme}-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
