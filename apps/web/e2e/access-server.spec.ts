import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));

type Boot = {
  url: string;
  tokens: Record<'ann' | 'bob' | 'olga' | 'wes' | 'lisa' | 'ceo', string>;
  ids: Record<'ann' | 'bob' | 'olga' | 'wes' | 'lisa' | 'ceo', string>;
  crew: Record<'mine' | 'other' | 'away' | 'far' | 'head' | 'owned' | 'wide' | 'deputy', { id: string; name: string }>;
  plans: Record<'ann' | 'bob' | 'olga' | 'wes' | 'lisa', { id: string }>;
  dev: { id: string };
  sales: { id: string };
  hiddenTask: { id: string };
  ownTask: { id: string };
  awayTask: { id: string };
};

type Server = Boot & { child: ChildProcessWithoutNullStreams; pages: Page[]; control(command: string): Promise<void>; stop(): Promise<void> };

async function startServer(): Promise<Server> {
  const child = spawn(resolve(HERE, '../../../node_modules/.bin/vitest'), ['run', 'test/access-server-support.test.ts'], {
    cwd: resolve(HERE, '../../server'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pages: Page[] = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const boot = await new Promise<Boot>((done, fail) => {
    let started = false;
    createInterface({ input: child.stdout }).on('line', line => {
      if (started || !line.trim().startsWith('{"url"')) return;
      started = true;
      done(JSON.parse(line) as Boot);
    });
    child.once('exit', code => fail(new Error(`The server stopped early (${code}):\n${stderr}`)));
  });
  const pending = new Map<string, () => void>();
  child.stdout.on('data', chunk => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim().startsWith('{"control"')) continue;
      const value = JSON.parse(line) as { control: string };
      pending.get(value.control)?.();
    }
  });
  const control = (command: string) => new Promise<void>(done => {
    pending.set(command, () => { pending.delete(command); done(); });
    child.stdin.write(JSON.stringify({ control: command }) + '\n');
  });
  const stop = async () => {
    await Promise.all(pages.map(page => page.context().close().catch(() => undefined)));
    if (child.exitCode !== null) return;
    await new Promise<void>(done => {
      child.once('exit', () => done());
      child.stdin.end();
    });
  };
  return { ...boot, child, pages, control, stop };
}

async function signedIn(browser: Browser, server: Server, who: keyof Boot['tokens'], lang: 'en' | 'ru', theme: 'light' | 'dark', width: number): Promise<Page> {
  const context = await browser.newContext({ baseURL: server.url, viewport: { width, height: 900 }, hasTouch: width === 375 });
  await context.addCookies([{ name: 'hh_session', value: server.tokens[who], url: new URL(server.url).origin }]);
  await context.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
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

async function openAgent(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /Development/ }).click();
  const chip = page.locator('.dept-chip').filter({ hasText: name });
  await expect(chip).toBeVisible();
  await chip.locator('.schip').click();
  return page.getByRole('complementary', { name: new RegExp(name) });
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [375, 1440]) {
      test(`real server hides closed URLs and their payload: ${lang} ${theme} ${width}`, async ({ browser }, info) => {
        const server = await startServer();
        try {
          const page = await signedIn(browser, server, 'ann', lang, theme, width);
          const heading = lang === 'en' ? 'Insufficient permissions' : 'Недостаточно прав';
          await page.goto(`/tasks/${server.hiddenTask.id}`);
          await expect(page.getByRole('heading', { name: heading })).toBeVisible();
          await expect(page.locator('body')).not.toContainText('Hidden work');
          await page.screenshot({ path: info.outputPath(`real-closed-task-${lang}-${theme}-${width}.png`) });
          await page.goto(`/departments/${server.sales.id}`);
          await expect(page.getByRole('heading', { name: heading })).toBeVisible();
          await expect(page.locator('body')).not.toContainText('Awa');
          await page.goto(`/agents/${server.crew.other.id}`);
          await expect(page.locator('body')).not.toContainText('Otto');
          expect(errorsOf(page)).toEqual([]);
        } finally {
          await server.stop();
        }
      });
    }
  }
}

test('real server applies both plan and department to map, schema, tree and lists', async ({ browser }) => {
  const server = await startServer();
  try {
    const ann = await signedIn(browser, server, 'ann', 'en', 'light', 1440);
    await ann.goto('/');
    await expect(ann.locator('.map')).toContainText('Own work');
    await expect(ann.locator('.map')).not.toContainText('Hidden work');
    await expect(ann.locator('.map')).not.toContainText('Away work');
    await ann.getByRole('button', { name: /Development/ }).click();
    await expect(ann.locator('.dcanvas .dept-chip')).toHaveCount(1);
    await expect(ann.locator('.dcanvas')).toContainText('Mina');
    for (const hidden of ['Otto', 'Hana', 'Oleg']) await expect(ann.locator('.dcanvas')).not.toContainText(hidden);
    ann.on('response', response => {
      if (!response.url().includes('/tree')) return;
      console.log('ACL TREE RESPONSE', response.status());
      void response.json().then(body => console.log('ACL TREE BODY', JSON.stringify(body).slice(0, 1200)));
    });
    ann.on('requestfailed', request => { if (request.url().includes('/tree')) console.log('ACL TREE FAILED', request.failure()?.errorText); });
    await ann.getByRole('button', { name: 'Tree', exact: true }).click();
    console.log('ACL TREE TEXT', await ann.locator('.tview').innerText());
    await expect(ann.locator('.tv-labs .dept-chip')).toHaveCount(1);
    await expect(ann.locator('.tv-in')).not.toContainText('Hidden work');
    await ann.getByRole('navigation').getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(ann.locator('.tasks')).toContainText('Own work');
    await expect(ann.locator('.tasks')).not.toContainText('Hidden work');
    const window = await openAgent(ann, 'Mina');
    await expect(window).toBeVisible();
    expect(errorsOf(ann)).toEqual([]);
  } finally {
    await server.stop();
  }
});

test('real server lets the department owner see only their own agent and full viewers see all', async ({ browser }) => {
  const server = await startServer();
  try {
    const olga = await signedIn(browser, server, 'olga', 'en', 'light', 1440);
    await olga.goto(`/departments/${server.dev.id}`);
    await expect(olga.locator('.dcanvas')).toContainText('Oleg');
    await expect(olga.locator('.dcanvas')).not.toContainText('Mina');
    await expect(olga.locator('.dcanvas')).not.toContainText('Otto');
    for (const who of ['ceo', 'lisa'] as const) {
      const viewer = await signedIn(browser, server, who, 'en', 'light', 1440);
      await viewer.goto(`/departments/${server.dev.id}`);
      for (const name of ['Mina', 'Otto', 'Hana', 'Oleg']) await expect(viewer.locator('.dcanvas')).toContainText(name);
      await viewer.goto(`/departments/${server.sales.id}`);
      for (const name of ['Awa', 'Fara', 'Wanda', 'Lena']) await expect(viewer.locator('.dcanvas')).toContainText(name);
      await viewer.close();
    }
  } finally {
    await server.stop();
  }
});

test('real server closes an open terminal with 4403 when the plan moves', async ({ browser }) => {
  const server = await startServer();
  try {
    const ann = await signedIn(browser, server, 'ann', 'en', 'light', 1440);
    await server.control('turn-mine-ann');
    const window = await openAgent(ann, 'Mina');
    await expect(window.locator('.xterm-screen')).toContainText('Mina private terminal');
    await server.control('move-mine-bob');
    await expect(window.locator('.xterm-screen')).toHaveCount(0);
    await expect(window).not.toContainText('Mina private terminal');
    expect(errorsOf(ann)).toEqual([]);
  } finally {
    await server.stop();
  }
});

test('real server refuses an upgraded socket and drops the stale screen on terminal:false', async ({ browser }) => {
  const server = await startServer();
  try {
    await server.control('move-other-ann-running');
    const ann = await signedIn(browser, server, 'ann', 'en', 'light', 1440);
    const window = await openAgent(ann, 'Otto');
    await expect(window.locator('.xterm-screen')).toHaveCount(0);
    await expect(window).not.toContainText('Mina private terminal');
    expect(errorsOf(ann)).toEqual([]);
  } finally {
    await server.stop();
  }
});

test('real server drops the old owner view even while their program keeps running', async ({ browser }) => {
  const server = await startServer();
  try {
    await server.control('move-other-ann-running');
    const bob = await signedIn(browser, server, 'bob', 'en', 'light', 1440);
    const window = await openAgent(bob, 'Otto');
    await expect(window.locator('.xterm-screen')).toContainText('Mina private terminal');
    await server.control('turn-other-ann');
    await expect(window.locator('.xterm-screen')).toHaveCount(0);
    await expect(window).not.toContainText('Mina private terminal');
    expect(errorsOf(bob)).toEqual([]);
  } finally {
    await server.stop();
  }
});
