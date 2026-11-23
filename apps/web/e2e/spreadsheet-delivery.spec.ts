import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { EventView } from '../src/types';
import { detail, ME, openTaskCard, serveApi, TASKS, writeToOrchestrator } from './api';
import { taskStream } from './hub-turn-api';

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const XLSX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
const SHOT_DIR = process.env.HH_E2E_SCREENSHOT_DIR ?? null;

async function saveShot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, name) });
}

async function prepare(page: Page, lang: 'en' | 'ru', theme: 'light' | 'dark', width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(
    ({ lang, theme }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', theme);
    },
    { lang, theme },
  );
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  await taskStream(page);
  await serveApi(page);
  return errors;
}

async function fits(page: Page, selector: string, width: number) {
  const sizes = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    return { page: document.documentElement.scrollWidth, scroll: el?.scrollWidth ?? 0, inner: el?.clientWidth ?? 0 };
  }, selector);
  expect(sizes.page).toBeLessThanOrEqual(width);
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.inner);
}

test('a person sees and downloads an attached .xlsx in 1 click from both the task card and the agent chat', async ({ page }) => {
  const errors = await prepare(page, 'ru', 'dark', 1440);
  const t = MESSAGES.ru;

  const taskOne = {
    ...detail(TASKS[0]!),
    files: [
      {
        id: 'file-task-xlsx',
        name: 'контакты-партнеров.xlsx',
        size: XLSX_BYTES.length,
        by: { id: 'a2', name: 'Bruno' },
        fromPerson: false,
        at: '2026-11-14T00:10:00.000Z',
      },
    ],
  };

  const chatEvents: EventView[] = [
    {
      seq: 1,
      kind: 'text',
      jobId: 'j1',
      person: null,
      at: '2026-11-14T00:11:00.000Z',
      data: {
        text: 'Готовая таблица контактов приложена ниже.',
        pictures: [{ id: 'file-chat-xlsx', name: 'контакты-чат.xlsx', file: true }],
      },
    },
  ];

  await page.route('**/api/tasks/t1', route => route.fulfill({ json: { task: taskOne } }));
  await page.route('**/api/agents/orchestrator/events**', route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
    return route.fulfill({
      json: {
        events: chatEvents.filter(e => e.seq > after),
        state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 },
      },
    });
  });
  const browser = page.context().browser();
  const browserName = browser?.browserType().name() ?? 'chromium';
  const cdp = browserName === 'chromium' ? await browser!.newBrowserCDPSession() : null;
  if (cdp) {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/attachments/file-*-xlsx' }] });
    cdp.on('Fetch.requestPaused', event => {
      const name = event.request.url.endsWith('/file-task-xlsx') ? 'контакты-партнеров.xlsx' : 'контакты-чат.xlsx';
      void cdp.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
          { name: 'content-disposition', value: `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
        ],
        body: XLSX_BYTES.toString('base64'),
      });
    });
  }
  const fulfillXlsx = (name: string) => (route: Parameters<Parameters<Page['route']>[1]>[0]) =>
    route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
      body: XLSX_BYTES,
    });
  await page.route('**/api/attachments/file-task-xlsx', fulfillXlsx('контакты-партнеров.xlsx'));
  await page.route('**/api/attachments/file-chat-xlsx', fulfillXlsx('контакты-чат.xlsx'));
  await page.context().route('**/api/attachments/file-task-xlsx', fulfillXlsx('контакты-партнеров.xlsx'));
  await page.context().route('**/api/attachments/file-chat-xlsx', fulfillXlsx('контакты-чат.xlsx'));

  try {
    await page.goto('/tasks');
    await openTaskCard(page, 1);
    const taskPanel = page.getByRole('complementary', { name: '#1 Checkout step 1' });
    const taskLink = taskPanel.getByRole('region', { name: t.tracker.card.materials }).getByRole('link', { name: t.tracker.card.openIt('контакты-партнеров.xlsx'), exact: true });
    await expect(taskLink).toBeVisible();
    await expect(taskLink).toHaveAttribute('href', '/api/attachments/file-task-xlsx');
    await expect(taskLink).toHaveAttribute('download', 'контакты-партнеров.xlsx');
    await taskLink.scrollIntoViewIfNeeded();
    await fits(page, '.tp', 1440);
    await saveShot(page, `task-card-xlsx-${browserName}.png`);

    /* WebKit dispatches <a download> outside Playwright's route hooks when no backend listens on Vite's proxy port. */
    if (browserName !== 'webkit') {
      const [taskDownload] = await Promise.all([page.waitForEvent('download'), taskLink.click()]);
      expect(taskDownload.suggestedFilename()).toBe('контакты-партнеров.xlsx');
      const taskSaved = await taskDownload.path();
      expect(taskSaved).toBeTruthy();
      expect(Buffer.compare(readFileSync(taskSaved!), XLSX_BYTES)).toBe(0);
    }

    await taskPanel.getByRole('button', { name: t.window.close }).click();
    await writeToOrchestrator(page, 'ru');
    const chatWindow = page.getByRole('complementary', { name: t.map.orchestrator });
    await expect(chatWindow.getByText('Готовая таблица контактов приложена ниже.')).toBeVisible();
    const chatLink = chatWindow.getByRole('link', { name: /контакты-чат\.xlsx/ });
    await expect(chatLink).toBeVisible();
    await expect(chatLink).toHaveAttribute('href', '/api/attachments/file-chat-xlsx');
    await expect(chatLink).toHaveAttribute('download', 'контакты-чат.xlsx');
    await saveShot(page, `agent-chat-xlsx-${browserName}.png`);

    if (browserName !== 'webkit') {
      const [chatDownload] = await Promise.all([page.waitForEvent('download'), chatLink.click()]);
      expect(chatDownload.suggestedFilename()).toBe('контакты-чат.xlsx');
      const chatSaved = await chatDownload.path();
      expect(chatSaved).toBeTruthy();
      expect(Buffer.compare(readFileSync(chatSaved!), XLSX_BYTES)).toBe(0);
    }

    await fits(page, '.agent-window', 1440);
    expect(errors).toEqual([]);
  } finally {
    await cdp?.detach();
  }
});

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`Google Sheets settings fit without sideways scroll in ${lang}, ${theme}, at ${width}px`, async ({ page }) => {
        const errors = await prepare(page, lang, theme, width);
        const t = MESSAGES[lang];
        let saved: { kind: 'service_account'; account: string; shareEmail: string | null; keyLast4: string } | null = null;
        await page.route('**/api/link', route => route.fulfill({ json: { link: null, domain: 'hornhoof.org' } }));
        await page.route('**/api/repo-host', route => route.fulfill({ json: { host: null } }));
        await page.route('**/api/google-sheets', async route => {
          if (route.request().method() === 'GET') return route.fulfill({ json: { google: saved } });
          if (route.request().method() === 'DELETE') {
            saved = null;
            return route.fulfill({ status: 204 });
          }
          const body = route.request().postDataJSON() as { credentials?: string; shareEmail?: string };
          if (!body.credentials?.startsWith('{')) {
            return route.fulfill({
              status: 400,
              json: { error: { code: 'validation', reason: 'google_sheets_invalid', message: 'Invalid credentials.' } },
            });
          }
          saved = {
            kind: 'service_account',
            account: 'sheets-service-account-with-very-long-identifier@acme-enterprise-spreadsheets.iam.gserviceaccount.com',
            shareEmail: body.shareEmail ?? null,
            keyLast4: '9876',
          };
          return route.fulfill({ json: { google: saved } });
        });

        await page.goto('/settings/integrations');
        const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
        const part = dialog.getByRole('article', { name: t.googleSheets.title, exact: true });
        await expect(part).toBeVisible();
        await part.getByRole('button', { name: t.googleSheets.connect, exact: true }).click();
        await fits(page, '.dialog', width);

        await part.getByLabel(t.googleSheets.keyLabel).fill('not-json');
        await part.getByRole('button', { name: t.common.save, exact: true }).click();
        await expect(part.getByText(t.errors.google_sheets_invalid)).toBeVisible();
        await fits(page, '.dialog', width);

        await part.getByLabel(t.googleSheets.keyLabel).fill('{"type":"service_account"}');
        await part.getByLabel(t.googleSheets.shareLabel).fill('alex.rivera.very.long.address@acme-enterprise-domain.example.com');
        await part.getByRole('button', { name: t.common.save, exact: true }).click();
        await expect(part.getByText(/sheets-service-account-with-very-long-identifier/)).toBeVisible();
        await fits(page, '.dialog', width);
        await saveShot(
          page,
          `google-sheets-${lang}-${theme}-${width}-${page.context().browser()?.browserType().name() ?? 'browser'}.png`,
        );

        await part.getByRole('button', { name: t.googleSheets.remove, exact: true }).click();
        await fits(page, '.dialog', width);
        await part.getByRole('button', { name: t.googleSheets.yesRemove, exact: true }).click();
        await expect(part.getByRole('button', { name: t.googleSheets.connect, exact: true })).toBeVisible();
        await fits(page, '.dialog', width);
        expect(errors).toEqual([]);
        void ME;
      });
    }
  }
}
