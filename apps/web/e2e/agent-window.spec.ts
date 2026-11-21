import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { PROGRAM_NAMES } from '../src/providers';
import { box, chooseTerminal } from './api';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';

type Settings = { lang: 'en' | 'ru'; theme: 'light' | 'dark'; width: number };

async function prepare(page: Page, info: TestInfo, { lang, theme, width }: Settings, state: Partial<AgentFixture> = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  await chooseTerminal(page);
  const words = lang === 'en' ? { subscriptions: 'Subscriptions & API', machines: 'Machines', card: 'Open the card of', open: 'Open Bruno', close: 'Close', task: 'Task', back: 'Back to terminal', minimize: 'Minimize', restore: 'Restore Bruno, Developer', full: 'Full screen', size: 'Restore size', noTask: 'No task', why: 'This agent has no current task.', write: 'Write to Bruno' } : { subscriptions: 'Подписки и API', machines: 'Машины', card: 'Открыть карточку', open: 'Открыть: Bruno', close: 'Закрыть', task: 'Задача', back: 'К терминалу', minimize: 'Свернуть', restore: 'Развернуть: Bruno, Разработчик', full: 'На весь экран', size: 'Обычный размер', noTask: 'Нет задачи', why: 'У агента сейчас нет задачи.', write: 'Сообщение для Bruno' };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, ...state };
  await serveAgentWindow(page, live);
  return {
    words, errors, live,
    window: page.getByRole('complementary', { name: /^Bruno,/ }),
    nav: page.getByRole('navigation', { name: lang === 'en' ? 'Sections' : 'Разделы' }),
    capture: (name: string) => page.screenshot({ path: info.outputPath(`${name}-${lang}-${theme}-${width}.png`) }),
  };
}

async function openFromMap(page: Page, lang: Settings['lang']) {
  await page.goto('/');
  await page.getByRole('button', { name: /^Development/ }).click();
  await page.getByRole('region', { name: lang === 'en' ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ }).click();
}

/* A program that sleeps shows no terminal: the terminal view says why, and the chat takes the words that wake it up. */
async function expectAsleep(window: Locator, lang: Settings['lang']) {
  const t = lang === 'en' ? en : ru;
  await expect(window.getByRole('status', { name: t.window.showTerminal, exact: true })).toHaveText(t.window.noTerminal.asleep(PROGRAM_NAMES.codex));
  await expect(window.locator('.xterm-screen')).toHaveCount(0);
  return t;
}

async function checkSurface(page: Page, errors: string[]) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
}

async function checkLeftControls(window: Locator, labels: string[]) {
  const header = window.locator(':scope > .t-bar');
  const frame = await box(header);
  const controls = await Promise.all(labels.map(label => box(header.getByRole('button', { name: label, exact: true }))));
  const [close, minimize, full] = controls;
  const closeButton = header.getByRole('button', { name: labels[0]!, exact: true });
  const page = window.page();
  await closeButton.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  await expect(closeButton).toHaveCSS('outline-offset', '-2px');
  const controlSize = (page.viewportSize()?.width ?? 0) <= 760 ? 28 : 26;
  for (const [index, label] of labels.entries()) {
    const button = header.getByRole('button', { name: label, exact: true });
    const control = controls[index]!;
    expect(control.width, `${label} width`).toBe(controlSize);
    expect(control.height, `${label} height`).toBe(controlSize);
    const icon = await box(button.locator('svg'));
    expect(Math.abs(control.x + control.width / 2 - icon.x - icon.width / 2), `${label} icon centers on x`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(control.y + control.height / 2 - icon.y - icon.height / 2), `${label} icon centers on y`).toBeLessThanOrEqual(0.5);
  }
  expect(close!.x - frame.x).toBeLessThanOrEqual(12);
  expect(close!.x).toBeGreaterThanOrEqual(frame.x);
  expect(close!.x + close!.width).toBeLessThanOrEqual(minimize!.x);
  expect(minimize!.x + minimize!.width).toBeLessThanOrEqual(full!.x);
  expect(controls.map(control => control.y)).toEqual([close!.y, close!.y, close!.y]);
  expect(full!.x + full!.width).toBeLessThanOrEqual((await box(header.locator('.agent-window-title'))).x);
  for (const button of await header.locator('button').all()) {
    const rect = await box(button);
    expect(rect.x).toBeGreaterThanOrEqual(frame.x);
    expect(rect.x + rect.width).toBeLessThanOrEqual(frame.x + frame.width);
    for (const control of controls) {
      if (rect.x === control.x && rect.y === control.y) continue;
      const overlaps = rect.x < control.x + control.width && rect.x + rect.width > control.x && rect.y < control.y + control.height && rect.y + rect.height > control.y;
      expect(overlaps).toBe(false);
    }
  }
}

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  test.describe(`one agent window in ${lang}, ${theme}, at ${width}px`, () => {
    test('from the map, with its task and window controls', async ({ page }, info) => {
      const { words, errors, live, window, nav, capture } = await prepare(page, info, settings);
      await openFromMap(page, lang);
      await expect(window).toBeVisible();
      await expect(window.locator('.xterm-screen')).toBeVisible();
      await checkLeftControls(window, [words.close, words.minimize, words.full]);
      await capture('map');
      const normal = await box(window);
      const connections = live.connections;
      expect(connections).toBeGreaterThan(0);
      const about = page.getByRole('button', { name: lang === 'en' ? 'About the department' : 'Об отделе', exact: true });
      if (width === 1440) await about.click();
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
      await checkLeftControls(window, [words.close, words.minimize, words.full]);
      await capture('task');
      if (width === 1440) {
        /* Beside the terminal there is nothing to go back to. */
        await about.click();
        await expect(window.getByRole('button', { name: words.back })).toHaveCount(0);
        await task.getByRole('button', { name: words.close, exact: true }).click();
      } else await window.getByRole('button', { name: words.back }).click();
      await expect(task).toBeHidden();
      await expect(window.locator('.xterm-screen')).toBeVisible();
      expect(live.connections).toBe(connections);
      await window.getByRole('button', { name: words.full, exact: true }).click();
      const full = await box(window);
      expect(full).toMatchObject({ x: 0, y: 0, width, height: 900 });
      await checkLeftControls(window, [words.close, words.minimize, words.size]);
      await capture('fullscreen');
      await window.getByRole('button', { name: words.minimize }).click();
      await expect(window).toBeHidden();
      const strip = page.getByRole('button', { name: words.restore });
      const stripPlace = await box(strip);
      if (width === 1440) expect(stripPlace.width).toBeLessThanOrEqual(36);
      else {
        /* In a row at the foot of a phone's screen. */
        expect(stripPlace.height).toBeLessThanOrEqual(44);
        expect(stripPlace.y + stripPlace.height).toBeGreaterThanOrEqual(898);
        expect(stripPlace.x + stripPlace.width).toBeLessThanOrEqual(width);
      }
      await capture('strip');
      await nav.getByRole('button', { name: words.subscriptions, exact: true }).click();
      await expect(page.getByRole('heading', { name: words.subscriptions, exact: true })).toBeVisible();
      await strip.click();
      /* Whole again, over the whole of this screen: every screen fills the viewport with no bottom version bar (#1874). */
      expect(await box(window)).toEqual(await box(page.locator('.app-screen')));
      await expect(strip).toBeHidden();
      await expect(window).toBeFocused();
      await checkLeftControls(window, [words.close, words.minimize, words.size]);
      expect(live.connections).toBe(connections);
      await window.getByRole('button', { name: words.size, exact: true }).click();
      expect(await box(window)).toMatchObject({ width: normal.width });
      await checkLeftControls(window, [words.close, words.minimize, words.full]);
      await window.getByRole('button', { name: words.close, exact: true }).click();
      await expect(window).toHaveCount(0);
      await checkSurface(page, errors);
    });

    for (const source of ['subscriptions', 'machines'] as const) {
      test(`from ${source}, working and sleeping`, async ({ page }, info) => {
        const { words, errors, live, window, nav, capture } = await prepare(page, info, settings);
        for (const awake of [false, true]) {
          live.awake = awake;
          await page.goto('/');
          await nav.getByRole('button', { name: words[source], exact: true }).click();
          await page.getByRole('button', { name: new RegExp(`${words.card}.*${source === 'subscriptions' ? 'Codex' : 'test-machine'}`) }).click();
          await page.getByRole('button', { name: words.open, exact: true }).click();
          await expect(window).toBeVisible();
          await expect(window).toHaveCount(1);
          if (!awake) {
            const t = await expectAsleep(window, lang);
            await window.getByRole('button', { name: t.window.showChat, exact: true }).click();
            await window.getByRole('textbox', { name: words.write }).fill('Please check the cart');
            await window.getByRole('textbox', { name: words.write }).press('Enter');
            await expect.poll(() => live.messages.at(-1)).toEqual({ text: 'Please check the cart' });
          } else await expect(window.locator('.xterm-screen')).toBeVisible();
          await capture(`${source}-${awake ? 'working' : 'sleeping'}`);
          await window.getByRole('button', { name: words.close, exact: true }).click();
        }
        await checkSurface(page, errors);
      });
    }

    test('without a current task', async ({ page }, info) => {
      const { words, errors, window } = await prepare(page, info, settings, { awake: false, hasTask: false });
      await openFromMap(page, lang);
      await expect(window.getByRole('button', { name: words.noTask })).toBeDisabled();
      await expectAsleep(window, lang);
      await expect(window.getByText(words.why)).toHaveCount(0);
      await expect(page.getByRole('complementary', { name: '#1 Checkout step 1' })).toHaveCount(0);
      await checkSurface(page, errors);
    });

    test('the header stands the same with a task and without', async ({ page }, info) => {
      const { words, errors, live, window, capture } = await prepare(page, info, settings);
      const bar = window.locator(':scope > .t-bar');
      const close = bar.getByRole('button', { name: words.close, exact: true });
      const task = bar.getByRole('button', { name: words.task, exact: true });
      const noTask = bar.getByRole('button', { name: words.noTask, exact: true });
      await openFromMap(page, lang);
      await expect(task).toBeEnabled();
      /* The bar is laid out in its own fonts before it is measured. */
      await page.evaluate(() => document.fonts.ready);
      const [withTask, closeWithTask, buttonWithTask] = [await box(bar), await box(close), await box(task)];
      expect(withTask.height, 'the header is one row').toBeLessThanOrEqual(40);
      await capture('header-with-task');
      live.hasTask = false;
      await openFromMap(page, lang);
      await expect(noTask).toBeDisabled();
      await page.evaluate(() => document.fonts.ready);
      expect(await box(bar)).toEqual(withTask);
      expect(await box(close)).toEqual(closeWithTask);
      expect(await box(noTask), 'nothing in the bar moves').toEqual(buttonWithTask);
      await checkLeftControls(window, [words.close, words.minimize, words.full]);
      await capture('header-without-task');
      await checkSurface(page, errors);
    });
  });
}

test('a hidden terminal menu leaves Escape with the account menu', async ({ page }) => {
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0 };
  await serveAgentWindow(page, live);
  await chooseTerminal(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Development/ }).click();
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
  await page.getByRole('button', { name: /^Development/ }).click();
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
  const window = page.getByRole('complementary', { name: 'Bruno, Developer' });
  const notice = window.getByRole('button', { name: 'Hornhoof, recorded service message to Bruno' });
  await expect(notice).toHaveAttribute('aria-expanded', 'false');
  await window.getByRole('button', { name: 'Task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Checkout step 1' })).toBeVisible();
  await expect(window.locator('.agent-conversation')).toBeHidden();
  await page.keyboard.press('Control+o');
  await window.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(notice).toHaveAttribute('aria-expanded', 'false');
});
