import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { PROGRAM_NAMES } from '../src/providers';
import type { EventView } from '../src/types';
import { box } from './api';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';

/* An agent's window opens as a chat a person reads at once: their words on one side, the agent's on the other, the
   program's steps in one quiet line, and the terminal one click away for those who want it. */
type Settings = { lang: 'en' | 'ru'; theme: 'light' | 'dark'; width: number };

const AT = '2026-11-04T10:00:00Z';
const LONG = 'https://checkout.example.com/orders/2026/11/04/receipts/very-long-path-without-any-break-that-must-wrap-inside-the-bubble';
const ev = (seq: number, kind: EventView['kind'], data: unknown, extra: Partial<EventView> = {}): EventView => ({ seq, kind, data, jobId: 'j1', person: null, at: AT, ...extra });
const EVENTS: EventView[] = [
  ev(1, 'message', { text: `Please check the checkout form. The receipt is at ${LONG}` }, { person: { id: 'p1', name: 'Ivan' } }),
  ev(2, 'tool', { name: 'Bash', input: 'npm test -- checkout' }),
  ev(3, 'tool_result', { ok: true, summary: '12 passed' }),
  ev(4, 'text', { text: 'The checkout form works. **All 12 checks pass.**' }),
];

async function prepare(page: Page, info: TestInfo, { lang, theme, width }: Settings, state: Partial<AgentFixture> = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const live: AgentFixture = { awake: true, hasTask: false, messages: [], connections: 0, events: EVENTS, ...state };
  await serveAgentWindow(page, live);
  return {
    t: lang === 'en' ? en : ru, errors, live,
    window: page.getByRole('complementary', { name: /^Bruno,/ }),
    capture: (name: string) => page.screenshot({ path: info.outputPath(`${name}-${lang}-${theme}-${width}.png`) }),
  };
}

async function openBruno(page: Page, lang: Settings['lang']) {
  await page.goto('/');
  await page.getByRole('button', { name: /^Development/ }).click();
  await page.getByRole('region', { name: lang === 'en' ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ }).click();
}

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  test(`an agent's window opens as a chat a person reads at once, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
    const { t, errors, live, window, capture } = await prepare(page, info, settings);
    await openBruno(page, lang);
    const chat = window.getByRole('log', { name: t.window.chat.conversation });
    await expect(chat).toBeVisible();
    await expect(window.locator('.t-term')).toHaveCount(0);
    expect(live.connections).toBe(0);

    /* The person's words on the end side, the agent's on the start side, neither wider than the chat. */
    const frame = await box(chat);
    const mine = await box(chat.locator('article', { hasText: 'Please check the checkout form.' }).locator('.chat-body'));
    const answer = await box(chat.locator('article', { hasText: 'The checkout form works.' }).locator('.chat-body'));
    expect(mine.x + mine.width).toBeGreaterThan(answer.x + answer.width);
    expect(answer.x).toBeLessThan(mine.x);
    for (const bubble of [mine, answer]) {
      expect(bubble.x).toBeGreaterThanOrEqual(frame.x);
      expect(bubble.x + bubble.width).toBeLessThanOrEqual(frame.x + frame.width);
    }
    expect(await chat.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    /* The steps fold into one quiet line, which opens on a click. */
    const steps = chat.getByRole('button', { name: t.window.chat.steps(1) });
    await expect(steps).toHaveAttribute('aria-expanded', 'false');
    await expect(chat.getByText('npm test -- checkout')).toHaveCount(0);
    await expect(window.getByRole('status', { name: t.window.chat.state })).toHaveText(new RegExp(t.window.chat.working));
    const send = window.getByRole('button', { name: t.window.chat.send, exact: true });
    const sendBox = await box(send);
    expect(sendBox.width).toBeGreaterThanOrEqual(44);
    expect(sendBox.height).toBeGreaterThanOrEqual(44);
    await capture('chat');
    await steps.click();
    await expect(chat.getByText('npm test -- checkout', { exact: false })).toBeVisible();
    expect(await chat.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);

    /* Writing goes out from the line under the chat. */
    await window.getByRole('textbox', { name: t.window.writeTo('Bruno') }).fill('Thank you.');
    await send.click();
    await expect.poll(() => live.messages).toEqual([{ text: 'Thank you.' }]);
    expect(errors).toEqual([]);
  });
}

for (const settings of [{ lang: 'en', theme: 'light', width: 1440 }, { lang: 'ru', theme: 'dark', width: 375 }] as const) {
  const { lang, theme, width } = settings;
  test(`the terminal is one click away, and the browser keeps the choice for the next time, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
    const { t, errors, window, capture } = await prepare(page, info, settings);
    await openBruno(page, lang);
    const chat = window.getByRole('log', { name: t.window.chat.conversation });
    await window.getByRole('button', { name: t.window.showTerminal, exact: true }).click();
    await expect(window.locator('.xterm-screen')).toBeVisible();
    await expect(chat).toHaveCount(0);
    await capture('terminal');
    /* The page loaded anew opens the window with the terminal, and the chat is one click back. */
    await openBruno(page, lang);
    await expect(window.locator('.xterm-screen')).toBeVisible();
    await window.getByRole('button', { name: t.window.showChat, exact: true }).click();
    await expect(chat).toBeVisible();
    await expect(window.locator('.t-term')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('the chat says that an agent with nothing to do sleeps until its next task, and its terminal says so too', async ({ page }, info) => {
  const { t, window } = await prepare(page, info, { lang: 'en', theme: 'light', width: 1440 }, { awake: false });
  await openBruno(page, 'en');
  await expect(window.getByRole('status', { name: t.window.chat.state })).toHaveText(t.window.chat.asleep);
  await window.getByRole('button', { name: t.window.showTerminal, exact: true }).click();
  await expect(window.getByRole('status', { name: t.window.showTerminal, exact: true })).toHaveText(t.window.noTerminal.asleep(PROGRAM_NAMES.codex));
  await expect(window.locator('.xterm-screen')).toHaveCount(0);
});

/* The switch to the terminal says its word beside its icon in every window, awake or asleep, at every width; on a phone a
   window with an inbox gives the word's room to the inbox's icon, as Design set it in #869, and the switch keeps its icon
   and its name. */
for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  test(`the terminal switch says its word for an agent awake and asleep, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
    const { t, errors, live, window, capture } = await prepare(page, info, settings);
    const fits = async () => {
      const frame = await box(window);
      for (const button of await window.locator('.t-bar > button').all()) {
        const b = await box(button);
        expect(b.x).toBeGreaterThanOrEqual(frame.x - 0.5);
        expect(b.x + b.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    const phone = width === 375;
    const says = async (label: string) => {
      const button = window.getByRole('button', { name: label, exact: true });
      await expect(button.locator('span')).toHaveText(label);
      if (phone) await expect(window.locator('.t-bar [data-panel="inbox"]')).toBeVisible();
      await expect(button.locator('span')).toBeVisible({ visible: !phone });
      await expect(button).toHaveAttribute('title', label);
      await expect(button.locator('svg')).toBeVisible();
      return button;
    };
    await openBruno(page, lang);
    await expect(window.getByRole('log', { name: t.window.chat.conversation })).toBeVisible();
    await fits();
    await capture('agent-awake-chat');
    await (await says(t.window.showTerminal)).click();
    await expect(window.locator('.xterm-screen')).toBeVisible();
    await says(t.window.showChat);
    await fits();
    await capture('agent-awake-terminal');

    /* The program sleeps: the window opens on the terminal, as last chosen, and says why it is not there. */
    live.awake = false;
    await openBruno(page, lang);
    await expect(window.getByRole('status', { name: t.window.showTerminal, exact: true })).toHaveText(t.window.noTerminal.asleep(PROGRAM_NAMES.codex));
    await says(t.window.showChat);
    await fits();
    await capture('agent-asleep-terminal');
    await (await says(t.window.showChat)).click();
    await expect(window.getByRole('status', { name: t.window.chat.state })).toHaveText(t.window.chat.asleep);
    await says(t.window.showTerminal);
    await fits();
    await capture('agent-asleep-chat');
    expect(errors).toEqual([]);
  });
}
