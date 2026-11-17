import { expect, test, type Locator, type Page } from '@playwright/test';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';
import { chooseTerminal } from './api';

type Options = {
  lang: 'en' | 'ru';
  theme: 'light' | 'dark';
  width: number;
  control?: boolean;
  message?: boolean;
  legacyPicture?: boolean;
  pictureStatus?: number;
};

const COPY = {
  en: {
    members: 'Members', control: "Only the owner of this agent's subscription can control its program. Ask the owner, or write an ordinary message.",
    uploading: 'Uploading the file...', uploaded: 'The file path is in the terminal. Press Enter to send it.', denied: 'This file is too big. A file is at most 10 MB.',
    notSent: 'Not sent',
  },
  ru: {
    members: 'Сотрудники', control: 'Управлять программой агента может только владелец его подписки. Попросите владельца или напишите обычное сообщение.',
    uploading: 'Файл загружается...', uploaded: 'Путь к файлу вставлен в терминал. Нажмите Enter для отправки.', denied: 'Файл слишком большой. Предел для файла 10 МБ.',
    notSent: 'Не отправлено',
  },
};

async function openTerminal(page: Page, options: Options) {
  const control = options.control ?? false;
  const message = options.message ?? control;
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, canType: control };
  const inputs: string[] = [];
  const errors: string[] = [];
  let uploads = 0;
  /* The upload is answered when the test says so, once it has seen the page wait for it. */
  let answer = () => {};
  const answered = new Promise<void>(resolve => { answer = resolve; });
  await page.setViewportSize({ width: options.width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, options);
  await chooseTerminal(page);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error' && !(options.pictureStatus === 413 && msg.location().url.includes('/pictures'))) errors.push(msg.text());
  });
  page.on('requestfailed', request => errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
  await serveAgentWindow(page, live);
  await page.route('**/api/agents/b1/pictures?*', async route => {
    uploads++;
    await answered;
    const status = options.pictureStatus ?? 201;
    const body = status === 201
      ? options.legacyPicture ? { id: 'p1', name: 'screen.png' } : { id: 'p1', name: 'screen.png', insert: "'/home/agent/screen.png' " }
      : { error: { code: 'validation', message: 'A file is at most 10 MB.', reason: 'file_too_big' } };
    await route.fulfill({ status, json: body });
  });
  await page.routeWebSocket('**/api/agents/b1/terminal*', ws => {
    live.connections++;
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as { type: string; data?: string };
      if (frame.type === 'input') inputs.push(frame.data!);
    });
    ws.send(JSON.stringify({ type: 'ready', write: control, ...(options.message === undefined ? {} : { message }) }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: '\x1b[?2004hTERMINAL-READY\r\n> ' }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^(Development|Разработка)/ }).click();
  await page.getByRole('region', { name: COPY[options.lang].members }).getByRole('button', { name: /Bruno/ }).click();
  const window = page.getByRole('complementary', { name: /^Bruno,/ });
  const textarea = window.locator('.xterm-helper-textarea');
  await expect(window.locator('.xterm-rows')).toContainText('TERMINAL-READY');
  return { window, textarea, inputs, errors, uploads: () => uploads, answer };
}

async function pasteText(page: Page, text: string) {
  await page.locator('.xterm-helper-textarea').evaluate((el, value) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', value);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, text);
}

async function pictureEvent(page: Page, kind: 'paste' | 'drop') {
  await page.locator('.t-xterm').evaluate((el, eventKind) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'screen.png', { type: 'image/png' }));
    if (eventKind === 'paste') el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    else el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, kind);
}

/* A note stands at the foot of the window, under the terminal and never over it, inside the window (#1115). */
async function expectAtFoot(window: Locator, notice: Locator) {
  const term = await window.locator('.t-term').boundingBox();
  const frame = await window.boundingBox();
  const note = await notice.boundingBox();
  expect(note).not.toBeNull();
  expect(note!.y).toBeGreaterThanOrEqual(term!.y + term!.height - 0.5);
  expect(note!.x).toBeGreaterThanOrEqual(frame!.x - 0.5);
  expect(note!.x + note!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 0.5);
  expect(note!.y + note!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 0.5);
}

for (const options of [
  { lang: 'en', theme: 'light', width: 1440, message: true },
  { lang: 'en', theme: 'dark', width: 375, message: true },
  { lang: 'ru', theme: 'light', width: 375, message: true },
  { lang: 'ru', theme: 'dark', width: 1440, legacyPicture: true, control: true },
] as const) {
  test(`picture input in ${options.lang} ${options.theme} ${options.width}`, async ({ page }, info) => {
    const terminal = await openTerminal(page, options);
    await pictureEvent(page, options.width === 375 ? 'drop' : 'paste');
    await expect(terminal.window.getByRole('status').filter({ hasText: COPY[options.lang].uploading })).toBeVisible();
    terminal.answer();
    const uploaded = terminal.window.getByRole('status').filter({ hasText: COPY[options.lang].uploaded });
    await expect(uploaded).toBeVisible();
    await expectAtFoot(terminal.window, uploaded);
    const inserted = options.legacyPicture ? 'screen.png: hh-fetch message p1' : "'/home/agent/screen.png' ";
    expect(terminal.inputs.join('')).toBe(inserted);
    expect(terminal.uploads()).toBe(1);
    await expect(terminal.window.locator('.t-tray')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${options.lang}-${options.theme}-${options.width}-picture.png`) });
    expect(terminal.errors).toEqual([]);
  });
}

test('message access allows text, Enter and ordinary paste but not program control', async ({ page }, info) => {
  const terminal = await openTerminal(page, { lang: 'en', theme: 'dark', width: 1440, message: true });
  await terminal.textarea.focus();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminal.inputs.join('')).toBe('hello\r');
  await page.keyboard.type('/login');
  await expect(terminal.window.getByRole('alert').filter({ hasText: COPY.en.control })).toBeVisible();
  await page.keyboard.press('Control+c');
  expect(terminal.inputs.join('')).toBe('hello\r');
  await page.keyboard.press('Enter');
  await pasteText(page, 'ordinary /text !words');
  await expect.poll(() => terminal.inputs.join('')).toBe('hello\r\r\x1b[200~ordinary /text !words\x1b[201~');
  await page.screenshot({ path: info.outputPath('message-without-control.png') });
  expect(terminal.errors).toEqual([]);
});

test('read-only access sends neither keys nor pictures', async ({ page }) => {
  const terminal = await openTerminal(page, { lang: 'en', theme: 'light', width: 1440 });
  await terminal.textarea.focus();
  await page.keyboard.type('hello');
  await pictureEvent(page, 'paste');
  await pictureEvent(page, 'drop');
  await expect(terminal.window.locator('.xterm-rows')).toContainText('TERMINAL-READY');
  expect(terminal.inputs).toEqual([]);
  expect(terminal.uploads()).toBe(0);
  expect(terminal.errors).toEqual([]);
});

test('a refused picture shows the reason and inserts no partial input', async ({ page }, info) => {
  const terminal = await openTerminal(page, { lang: 'en', theme: 'dark', width: 1440, message: true, pictureStatus: 413 });
  await pictureEvent(page, 'drop');
  terminal.answer();
  /* The reason, led by the framed word of a note that did not go (#1115). */
  const refused = terminal.window.getByRole('alert');
  await expect(refused).toHaveText(`${COPY.en.notSent} ${COPY.en.denied}`);
  await expect(refused.getByText(COPY.en.notSent, { exact: true })).toBeVisible();
  expect(terminal.inputs).toEqual([]);
  expect(terminal.uploads()).toBe(1);
  await page.screenshot({ path: info.outputPath('picture-refused.png') });
  expect(terminal.errors).toEqual([]);
});

test('reconnect rechecks kept text and commands against the new rights', async ({ page }) => {
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, canType: true };
  const inputs: string[] = [];
  const sockets: { close(options: { code: number; reason: string }): void }[] = [];
  let downgraded = false;
  await page.setViewportSize({ width: 1440, height: 900 });
  await serveAgentWindow(page, live);
  await chooseTerminal(page);
  await page.routeWebSocket('**/api/agents/b1/terminal*', ws => {
    sockets.push(ws);
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as { type: string; data?: string };
      if (frame.type === 'input') inputs.push(frame.data!);
    });
    ws.send(JSON.stringify({ type: 'ready', write: !downgraded, message: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: downgraded ? 'SECOND-READY\r\n> ' : 'FIRST-READY\r\n> ' }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Development/ }).click();
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
  const textarea = page.locator('.xterm-helper-textarea');
  await expect(page.locator('.xterm-rows')).toContainText('FIRST-READY');
  downgraded = true;
  sockets.at(-1)!.close({ code: 4410, reason: 'node_offline' });
  await textarea.focus();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/login');
  await expect(page.locator('.xterm-rows')).toContainText('SECOND-READY');
  await expect.poll(() => inputs.join('')).toBe('hello\r');
  await expect(page.getByRole('alert').filter({ hasText: COPY.en.control })).toBeVisible();
});
