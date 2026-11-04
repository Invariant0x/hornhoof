import { expect, test } from '@playwright/test';
import { box } from './api';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  test(`one agent window in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ lang, theme }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', theme);
    }, { lang, theme });
    const words = lang === 'en' ? { subscriptions: 'Subscriptions', machines: 'Machines', card: 'Open the card of', open: 'Open Bruno', close: 'Close', task: 'Task', back: 'Back to terminal', minimize: 'Minimize', restore: 'Restore Bruno, Developer', full: 'Full screen', size: 'Restore size', noTask: 'No task', why: 'This agent has no current task.', write: 'Write to Bruno' } : { subscriptions: 'Подписки', machines: 'Машины', card: 'Открыть карточку', open: 'Открыть: Bruno', close: 'Закрыть', task: 'Задача', back: 'К терминалу', minimize: 'Свернуть', restore: 'Развернуть: Bruno, Разработчик', full: 'На весь экран', size: 'Обычный размер', noTask: 'Нет задачи', why: 'У агента сейчас нет задачи.', write: 'Сообщение для Bruno' };
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0 };
    await serveAgentWindow(page, live);
    const window = page.getByRole('complementary', { name: /^Bruno,/ });
    const capture = (name: string) => page.screenshot({ path: info.outputPath(`${name}-${lang}-${theme}-${width}.png`) });
    const nav = page.getByRole('navigation', { name: lang === 'en' ? 'Sections' : 'Разделы' });
    await page.goto('/');
    await page.getByRole('button', { name: /Development/ }).click();
    await page.getByRole('region', { name: lang === 'en' ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ }).click();
    await expect(window).toBeVisible();
    await expect(window.locator('.xterm-screen')).toBeVisible();
    await capture('map');
    const normal = await box(window);
    const connections = live.connections;
    expect(connections).toBeGreaterThan(0);
    if (width === 1440) await page.getByRole('button', { name: lang === 'en' ? 'About the department' : 'Об отделе', exact: true }).click();
    await window.getByRole('button', { name: words.task, exact: true }).click();
    const task = page.getByRole('complementary', { name: '#1 Checkout step 1' });
    await expect(task.getByRole('heading', { name: 'Checkout step 1' })).toBeVisible();
    await expect(task.getByText('The checkout form is being checked.')).toBeVisible();
    if (width === 1440) {
      await expect(window.locator('.xterm-screen')).toBeVisible();
      const left = await box(task);
      const right = await box(window.locator('.t-term'));
      expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1);
      expect(right.width).toBeGreaterThan(400);
      const drawer = await box(page.locator('.dv-drawer'));
      expect(drawer.x + drawer.width).toBeLessThanOrEqual((await box(window)).x);
    } else {
      await expect(window.locator('.t-term')).toBeHidden();
      expect((await box(task)).width).toBeLessThanOrEqual(width);
    }
    await capture('task');
    if (width === 1440) await page.getByRole('button', { name: lang === 'en' ? 'About the department' : 'Об отделе', exact: true }).click();
    await window.getByRole('button', { name: words.back }).click();
    await expect(task).toBeHidden();
    await expect(window.locator('.xterm-screen')).toBeVisible();
    expect(live.connections).toBe(connections);
    await window.getByRole('button', { name: words.full, exact: true }).click();
    const full = await box(window);
    expect(full).toMatchObject({ x: 0, y: 0, width, height: 900 });
    await capture('fullscreen');
    await window.getByRole('button', { name: words.minimize }).click();
    await expect(window).toBeHidden();
    const strip = page.getByRole('button', { name: words.restore });
    expect((await box(strip)).width).toBeLessThanOrEqual(36);
    await capture('strip');
    await nav.getByRole('button', { name: words.subscriptions, exact: true }).click();
    await expect(page.getByRole('heading', { name: words.subscriptions, exact: true })).toBeVisible();
    await strip.click();
    expect(await box(window)).toEqual(full);
    await window.getByRole('button', { name: words.size, exact: true }).click();
    expect(await box(window)).toMatchObject({ width: normal.width });
    await window.getByRole('button', { name: words.close, exact: true }).click();
    for (const source of ['subscriptions', 'machines'] as const) for (const awake of [false, true]) {
      live.awake = awake;
      await page.goto('/');
      await nav.getByRole('button', { name: words[source], exact: true }).click();
      await page.getByRole('button', { name: new RegExp(`${words.card}.*${source === 'subscriptions' ? 'Codex' : 'test-machine'}`) }).click();
      await page.getByRole('button', { name: words.open, exact: true }).click();
      await expect(window).toBeVisible();
      await expect(window).toHaveCount(1);
      if (!awake) {
        await window.getByRole('textbox', { name: words.write }).fill('Please check the cart');
        await window.getByRole('textbox', { name: words.write }).press('Enter');
        expect(live.messages.at(-1)).toEqual({ text: 'Please check the cart' });
      } else await expect(window.locator('.xterm-screen')).toBeVisible();
      await capture(`${source}-${awake ? 'working' : 'sleeping'}`);
      await window.getByRole('button', { name: words.close, exact: true }).click();
    }
    live.awake = false;
    live.hasTask = false;
    await page.goto('/');
    await page.getByRole('button', { name: /Development/ }).click();
    await page.getByRole('region', { name: lang === 'en' ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ }).click();
    await expect(window.getByRole('button', { name: words.noTask })).toBeDisabled();
    await expect(window.getByRole('status')).toHaveText(words.why);
    await expect(task).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}


test('a hidden terminal menu leaves Escape with the account menu', async ({ page }) => {
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0 };
  await serveAgentWindow(page, live);
  await page.goto('/');
  await page.getByRole('button', { name: /Development/ }).click();
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
  const window = page.getByRole('complementary', { name: 'Bruno, Developer' });
  await window.locator('.xterm-screen').click({ button: 'right' });
  await expect(window.getByRole('menu')).toBeVisible();
  await window.getByRole('button', { name: 'Minimize' }).focus();
  await page.keyboard.press('Enter');
  await expect(window).toBeHidden();
  await page.getByRole('button', { name: 'Account', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Log out' })).toBeHidden();
});

test('the mobile task leaves the hidden conversation unchanged by Ctrl+O', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const live: AgentFixture = { awake: false, hasTask: true, messages: [], connections: 0, events: [{
    seq: 1, kind: 'message', data: { text: 'Check the checkout.' }, jobId: null, person: null, at: '2026-11-04T00:00:00Z',
    message: { direction: 'in', from: { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null }, to: { kind: 'agent', id: 'b1', name: 'Bruno', role: null, department: null, agentKind: 'worker' } },
  }] };
  await serveAgentWindow(page, live);
  await page.goto('/');
  await page.getByRole('button', { name: /Development/ }).click();
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
  const window = page.getByRole('complementary', { name: 'Bruno, Developer' });
  const notice = window.getByRole('button', { name: 'Hornhoof notice to Bruno' });
  await expect(notice).toHaveAttribute('aria-expanded', 'false');
  await window.getByRole('button', { name: 'Task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Checkout step 1' })).toBeVisible();
  await expect(window.locator('.agent-conversation')).toBeHidden();
  await page.keyboard.press('Control+o');
  await window.getByRole('button', { name: 'Back to terminal' }).click();
  await expect(notice).toHaveAttribute('aria-expanded', 'false');
});
