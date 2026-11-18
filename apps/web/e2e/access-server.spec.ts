import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Browser, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';

const HERE = dirname(fileURLToPath(import.meta.url));

type Boot = {
  url: string;
  tokens: Record<'ann' | 'bob' | 'olga' | 'wes' | 'clara' | 'ceo', string>;
  ids: Record<'ann' | 'bob' | 'olga' | 'wes' | 'clara' | 'ceo', string>;
  crew: Record<'mine' | 'other' | 'away' | 'far' | 'head' | 'owned' | 'wide' | 'deputy', { id: string; name: string }>;
  plans: Record<'ann' | 'bob' | 'olga' | 'wes' | 'clara', { id: string }>;
  dev: { id: string };
  sales: { id: string };
  hiddenTask: { id: string };
  ownTask: { id: string };
  awayTask: { id: string };
  controlPort: number;
};

type Server = Boot & { child: ChildProcessWithoutNullStreams; pages: Page[]; control(command: string): Promise<void>; closePages(): Promise<void>; stop(): Promise<void> };

/* The real server serves the built app, so a worker builds what this checkout holds, in a folder of its own. */
function builtWebApp(): string {
  const folder = mkdtempSync(join(tmpdir(), 'hh-access-web-'));
  execFileSync('npx', ['--no-install', 'vite', 'build', '--logLevel', 'warn', '--outDir', folder, '--emptyOutDir'], { cwd: resolve(HERE, '..'), stdio: 'inherit' });
  return folder;
}

async function startServer(webDist: string): Promise<Server> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/access-server-support.ts'], {
    cwd: resolve(HERE, '../../server'),
    env: { ...process.env, WEB_DIST: webDist },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pages: Page[] = [];
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
    process.stderr.write(chunk);
  });
  const boot = await new Promise<Boot>((done, fail) => {
    let started = false;
    createInterface({ input: child.stdout }).on('line', line => {
      if (started || !line.trim().startsWith('{"url"')) return;
      started = true;
      done(JSON.parse(line) as Boot);
    });
    child.once('exit', code => fail(new Error(`The server stopped early (${code}):\n${stderr}`)));
  });
  const controlSocket = connect(boot.controlPort, '127.0.0.1');
  const pending = new Map<string, { done(): void; fail(error: Error): void }>();
  let received = '';
  controlSocket.on('data', chunk => {
    received += String(chunk);
    const lines = received.split('\n');
    received = lines.pop()!;
    for (const line of lines) {
      if (!line.trim().startsWith('{"control"')) continue;
      const value = JSON.parse(line) as { control: string; error?: string };
      const request = pending.get(value.control);
      pending.delete(value.control);
      if (value.error) request?.fail(new Error(value.error));
      else request?.done();
    }
  });
  const control = (command: string) => new Promise<void>((done, fail) => {
    pending.set(command, { done, fail });
    controlSocket.write(JSON.stringify({ control: command }) + '\n');
  });
  const closePages = async () => {
    await Promise.all(pages.splice(0).map(page => page.context().close().catch(() => undefined)));
  };
  const stop = async () => {
    await closePages();
    if (child.exitCode !== null) return;
    await new Promise<void>(done => {
      child.once('exit', () => done());
      controlSocket.end();
      child.stdin.end();
    });
  };
  return { ...boot, child, pages, control, closePages, stop };
}

const test = base.extend<{}, { server: Server }>({
  server: [async ({}, use) => {
    const webDist = builtWebApp();
    const server = await startServer(webDist);
    try { await use(server); }
    finally {
      await server.stop();
      rmSync(webDist, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});

test.beforeEach(async ({ server }) => { await server.control('reset'); });

async function signedIn(browser: Browser, server: Server, who: keyof Boot['tokens'], lang: 'en' | 'ru', theme: 'light' | 'dark', width: number): Promise<Page> {
  const context = await browser.newContext({ baseURL: server.url, viewport: { width, height: 900 }, hasTouch: width === 375 });
  await context.addCookies([{ name: 'hh_session', value: server.tokens[who], url: new URL(server.url).origin }]);
  await context.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    /* These are about who sees an agent's terminal, so the windows open with it rather than the chat. */
    localStorage.setItem('hh-agent-view', 'terminal');
  }, { lang, theme });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('close', () => undefined));
  (page as Page & { __errors?: string[] }).__errors = errors;
  server.pages.push(page);
  return page;
}

const errorsOf = (page: Page) => (page as Page & { __errors?: string[] }).__errors ?? [];
const structure = (page: Page, name = en.dept.structure) => page.getByRole('region', { name, exact: true });

async function openAgent(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /^Development/ }).click();
  await structure(page).getByRole('button', { name, exact: true }).click();
  return page.getByRole('complementary', { name: new RegExp(name) });
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [375, 1440]) {
      test(`real server opens the company's work to everyone, with no refusal: ${lang} ${theme} ${width}`, async ({ browser, server }, info) => {
        try {
          const page = await signedIn(browser, server, 'ann', lang, theme, width);
          const heading = lang === 'en' ? 'Insufficient permissions' : 'Недостаточно прав';
          await page.goto(`/tasks/${server.hiddenTask.id}`);
          await expect(page.locator('body')).toContainText('Hidden work');
          await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);
          await page.screenshot({ path: info.outputPath(`real-open-task-${lang}-${theme}-${width}.png`) });
          await page.goto(`/departments/${server.sales.id}`);
          await expect(structure(page, (lang === 'en' ? en : ru).dept.structure).getByText('Awa', { exact: true })).toBeVisible();
          await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);
          await page.goto(`/agents/${server.crew.other.id}`);
          await expect(page.locator('body')).not.toContainText('Otto');
          await expect(page.getByRole('complementary')).toHaveCount(0);
          expect(errorsOf(page)).toEqual([]);
        } finally {
          await server.closePages();
        }
      });
    }
  }
}

test('real server shows everyone the whole department and its work, and opens only the agents of the person', async ({ browser, server }) => {
  try {
    const ann = await signedIn(browser, server, 'ann', 'en', 'light', 1440);
    await ann.goto('/');
    /* Each department's card says what it works on now, its newest open task: Own work in Development, Away work in Sales. */
    await expect(ann.locator('.map')).toContainText('Own work');
    await expect(ann.locator('.map')).toContainText('Away work');
    await ann.getByRole('button', { name: /^Development/ }).click();
    for (const name of ['Mina', 'Otto', 'Hana', 'Oleg']) await expect(structure(ann).getByText(name, { exact: true })).toBeVisible();
    await ann.getByRole('button', { name: 'Tree', exact: true }).click();
    for (const name of ['Mina', 'Otto']) await expect(ann.locator('.tv-labs')).toContainText(name);
    await expect(ann.locator('.tv-in')).toContainText('Hidden work');
    /* The tracker (#1152) lists the department's whole work when she picks the department among its lists. */
    await ann.getByRole('navigation').getByRole('button', { name: 'Tasks', exact: true }).click();
    await ann.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: /^Development/ }).click();
    await expect(ann.getByRole('heading', { level: 1, name: 'Development' })).toBeVisible();
    await expect(ann.locator('.tr-main')).toContainText('Own work');
    await expect(ann.locator('.tr-main')).toContainText('Hidden work');
    await ann.goto(`/departments/${server.dev.id}`);
    await expect(structure(ann).getByText('Otto', { exact: true })).toBeVisible();
    await expect(structure(ann).getByRole('button', { name: 'Otto', exact: true })).toHaveCount(0);
    /* The staff map still explains why Otto's window stays closed. */
    await ann.getByRole('button', { name: en.dept.staffMap, exact: true }).click();
    await ann.getByRole('region', { name: en.dept.schema, exact: true }).locator('.dept-chip', { hasText: 'Otto' }).locator('.schip').click();
    await expect(ann.getByText(en.dept.closedAgent('Otto')).first()).toBeVisible();
    await expect(ann.getByRole('complementary', { name: /Otto/ })).toHaveCount(0);
    const window = await openAgent(ann, 'Mina');
    await expect(window).toBeVisible();
    expect(errorsOf(ann)).toEqual([]);
  } finally {
    await server.closePages();
  }
});

test('real server lets the department owner see every agent of their department and full viewers see all', async ({ browser, server }) => {
  try {
    const olga = await signedIn(browser, server, 'olga', 'en', 'light', 1440);
    await olga.goto(`/departments/${server.dev.id}`);
    for (const name of ['Mina', 'Otto', 'Hana', 'Oleg']) await expect(structure(olga).getByText(name, { exact: true })).toBeVisible();
    for (const who of ['ceo', 'clara'] as const) {
      const viewer = await signedIn(browser, server, who, 'en', 'light', 1440);
      await viewer.goto(`/departments/${server.dev.id}`);
      for (const name of ['Mina', 'Otto', 'Hana', 'Oleg']) await expect(structure(viewer).getByText(name, { exact: true })).toBeVisible();
      await viewer.goto(`/departments/${server.sales.id}`);
      for (const name of ['Awa', 'Fara', 'Wanda', 'Lena']) await expect(structure(viewer).getByText(name, { exact: true })).toBeVisible();
      await viewer.close();
    }
  } finally {
    await server.closePages();
  }
});

test('real server closes an open terminal with 4403 when the plan moves', async ({ browser, server }) => {
  try {
    const ann = await signedIn(browser, server, 'ann', 'en', 'light', 1440);
    await server.control('turn-mine-ann');
    const window = await openAgent(ann, 'Mina');
    await expect(window.locator('.xterm-screen')).toContainText('Mina private terminal');
    await server.control('move-mine-bob');
    await expect(window.locator('.xterm-screen')).toHaveCount(0);
    await expect(window).toHaveCount(0);
    expect(errorsOf(ann)).toEqual([]);
  } finally {
    await server.closePages();
  }
});

test('real server keeps the new owner card without exposing the previous owner terminal', async ({ browser, server }) => {
  try {
    await server.control('move-other-ann-running');
    const ann = await signedIn(browser, server, 'ann', 'en', 'light', 1440);
    const window = await openAgent(ann, 'Otto');
    await expect(window.locator('.xterm-screen')).toHaveCount(0);
    await expect(window).toBeVisible();
    await expect(window).not.toContainText('Mina private terminal');
    expect(errorsOf(ann)).toEqual([]);
  } finally {
    await server.closePages();
  }
});

test('real server drops the old owner view even while their program keeps running', async ({ browser, server }) => {
  try {
    await server.control('turn-other-bob');
    const bob = await signedIn(browser, server, 'bob', 'en', 'light', 1440);
    const window = await openAgent(bob, 'Otto');
    await expect(window.locator('.xterm-screen')).toContainText('Mina private terminal');
    await server.control('move-other-ann-idle');
    await server.control('turn-other-ann');
    await expect(window.locator('.xterm-screen')).toHaveCount(0);
    await expect(window).toHaveCount(0);
    expect(errorsOf(bob)).toEqual([]);
  } finally {
    await server.closePages();
  }
});
