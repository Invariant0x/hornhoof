import { expect, test, type JSHandle, type Locator, type Page, type Route } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { EventView } from '../src/types';
import { AGENT_HIDDEN, chooseTerminal } from './api';
import { serveAgentWindow, SUB, type AgentFixture } from './agent-window-api';
import { checkPage, open, ORCHESTRATOR, ORCHESTRATOR_CARD, shot, VIEWERS, watchErrors, type Agent, type Settings, type Viewer } from './agent-window-steps';

const PICTURE_BYTES = 3 * 1024 * 1024;
const FILE_BYTES = 10 * 1024 * 1024;

type Upload = { agent: string; name: string; bytes: Buffer };
type Said = { agent: string; text: string; pictures?: string[] };
/* What reached the server from this person, and the keys that reached the terminal. */
type Server = { uploads: Upload[]; messages: Said[]; keys: string[] };

/* The server's side of a picture or any other file: it keeps one that holds something, up to its limit. */
async function serve(page: Page, viewer: Viewer, settings: Settings): Promise<Server> {
  const { me, types } = VIEWERS[viewer];
  const server: Server = { uploads: [], messages: [], keys: [] };
  const events: Record<string, EventView[]> = { orchestrator: [], b1: [] };
  const state = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: true, canType: types };
  await page.setViewportSize({ width: settings.width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, settings);
  await chooseTerminal(page);
  const live: AgentFixture = { awake: false, hasTask: false, messages: [], connections: 0, canType: types, orchestrator: ORCHESTRATOR, events: events.b1, viewer: me };
  await serveAgentWindow(page, live);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const post = route.request().method() === 'POST';
    const up = /^\/api\/agents\/(orchestrator|b1)\/pictures$/.exec(url.pathname);
    if (up && post) {
      const bytes = route.request().postDataBuffer() ?? Buffer.alloc(0);
      if (!bytes.length) return route.fulfill({ status: 400, json: { error: { code: 'validation', message: 'Empty.', reason: 'file_empty' } } });
      if (bytes.length > FILE_BYTES) return route.fulfill({ status: 413, json: { error: { code: 'validation', message: 'Too big.', reason: 'file_too_big' } } });
      const name = url.searchParams.get('name')!;
      server.uploads.push({ agent: up[1]!, name, bytes });
      return route.fulfill({ status: 201, json: { id: `pic${server.uploads.length}`, name } });
    }
    const said = /^\/api\/agents\/(orchestrator|b1)\/messages$/.exec(url.pathname);
    if (said && post) {
      const body = route.request().postDataJSON() as { text: string; pictures?: string[] };
      server.messages.push({ agent: said[1]!, ...body });
      const list = events[said[1]!]!;
      list.push({
        seq: list.length + 1, kind: 'message', jobId: 'j2', person: { id: me.person.id, name: me.person.name }, at: '2026-11-04T10:00:00.000Z',
        data: { text: body.text || 'screen.png', pictures: (body.pictures ?? []).map(id => ({ id, name: server.uploads[Number(id.slice(3)) - 1]!.name })) },
        message: { direction: 'in', from: { kind: 'person', id: me.person.id, name: me.person.name, role: null, department: null }, to: { kind: 'agent', id: said[1]!, name: said[1] === 'b1' ? 'Bruno' : 'Orchestrator', agentKind: said[1] === 'b1' ? 'worker' : 'orchestrator', role: null, department: null } },
      });
      return route.fulfill({ status: 202, json: { jobId: 'j2' } });
    }
    if (url.pathname.startsWith('/api/agents/s1')) return route.fulfill({ status: 403, json: AGENT_HIDDEN });
    if (url.pathname === '/api/me') return route.fulfill({ json: me });
    if (url.pathname === '/api/machines/access') return route.fulfill({ json: { views: [] } });
    if (url.pathname === '/api/agents/orchestrator') return route.fulfill({ json: ORCHESTRATOR_CARD });
    if (url.pathname === '/api/agents/orchestrator/start') return route.fulfill({ json: { started: false } });
    const after = Number(url.searchParams.get('after') ?? 0);
    if (url.pathname === '/api/agents/orchestrator/events') return route.fulfill({ json: { events: events.orchestrator!.filter(e => e.seq > after), state } });
    if (url.pathname === '/api/agents/b1/events') return route.fulfill({ json: { events: events.b1!.filter(e => e.seq > after), state } });
    return route.fallback();
  });
  const picture = /\/api\/attachments\/pic(\d+)$/;
  const show = (route: Route) => route.fulfill({ contentType: 'image/png', body: server.uploads[Number(picture.exec(route.request().url())![1]) - 1]!.bytes });
  /* A picture opens large in a tab of its own, which the page's routes do not reach. */
  await page.route(picture, show);
  await page.context().route(picture, show);
  await page.routeWebSocket('**/api/agents/*/terminal*', ws => {
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as { type: string; data?: string };
      if (frame.type === 'input') server.keys.push(frame.data!);
    });
    ws.send(JSON.stringify({ type: 'ready', write: types, message: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: 'The program runs on its plan.\r\n> ' }));
  });
  return server;
}

/* A real picture, drawn by the browser the test runs in, as if taken from a screen, ready to be dragged or pasted. */
const picture = (page: Page, name: string, type = 'image/png', noise = false): Promise<JSHandle<DataTransfer>> =>
  page.evaluateHandle(
    async ({ name, type, noise }) => {
      const canvas = document.createElement('canvas');
      canvas.width = noise ? 1800 : 480;
      canvas.height = noise ? 1200 : 300;
      const paint = canvas.getContext('2d')!;
      if (noise) {
        const image = paint.createImageData(canvas.width, canvas.height);
        for (let i = 0; i < image.data.length; i += 1) image.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
        paint.putImageData(image, 0, 0);
      } else {
        paint.fillStyle = '#1d4ed8';
        paint.fillRect(0, 0, 480, 300);
        paint.fillStyle = '#fbbf24';
        paint.fillRect(40, 40, 240, 60);
        paint.fillStyle = '#ffffff';
        paint.fillRect(40, 130, 400, 20);
        paint.fillRect(40, 170, 320, 20);
      }
      const blob = await new Promise<Blob>(done => canvas.toBlob(b => done(b!), type));
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], name, { type }));
      return transfer;
    },
    { name, type, noise },
  );

/* A file of any kind, under whatever name and type it comes. */
const file = (page: Page, name: string, type: string, text: string): Promise<JSHandle<DataTransfer>> =>
  page.evaluateHandle(
    ({ name, type, text }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], name, { type }));
      return transfer;
    },
    { name, type, text },
  );

const paste = (where: Locator, clipboardData: JSHandle<DataTransfer>) =>
  where.evaluate((el, data) => el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })), clipboardData);

const lineOf = (window: Locator, agent: Agent, t: typeof en | typeof ru) => window.getByRole('textbox', { name: agent === 'orchestrator' ? t.window.placeholder : t.window.writeTo('Bruno'), exact: true });

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  const t = lang === 'en' ? en : ru;
  test.describe(`a picture for an agent in ${lang}, ${theme}, at ${width}px`, () => {
    test('dragged on the terminal of an employee by someone with no plan of theirs, its line goes in there with no Enter', async ({ page }, info) => {
      const errors = watchErrors(page);
      const server = await serve(page, 'delegate', settings);
      const window = await open(page, 'b1', lang);
      const terminal = window.locator('.t-xterm');
      await expect(window.locator('.xterm-screen')).toBeVisible();
      const shotOne = await picture(page, 'screen.png');

      await terminal.dispatchEvent('dragenter', { dataTransfer: shotOne });
      const where = window.getByText(t.window.dropPictures);
      await expect(where).toBeVisible();
      await shot(page, info, 'dragging', settings);
      await terminal.dispatchEvent('dragover', { dataTransfer: shotOne });
      await terminal.dispatchEvent('drop', { dataTransfer: shotOne });
      await expect(where).toHaveCount(0);

      await expect.poll(() => server.keys).toEqual(['screen.png: hh-fetch message pic1']);
      expect(server.uploads.map(u => u.name)).toEqual(['screen.png']);
      expect(server.messages).toEqual([]);
      await expect(lineOf(window, 'b1', t)).toHaveCount(0);
      await shot(page, info, 'inserted', settings);
      await checkPage(page, errors);
    });

    test('pasted in the log of the orchestrator, it goes alone', async ({ page }, info) => {
      const errors = watchErrors(page);
      const server = await serve(page, 'delegate', settings);
      const window = await open(page, 'orchestrator', lang);
      await window.getByRole('button', { name: t.window.showChat, exact: true }).click();
      const line = lineOf(window, 'orchestrator', t);
      await line.click();
      await paste(line, await picture(page, 'screen.png'));
      await expect(window.getByRole('img', { name: 'screen.png', exact: true })).toBeVisible();
      await shot(page, info, 'pasted', settings);
      await window.getByRole('button', { name: t.window.chat.send, exact: true }).click();
      await expect.poll(() => server.messages).toEqual([{ agent: 'orchestrator', text: '', pictures: ['pic1'] }]);
      await expect(window.getByRole('link', { name: t.window.openPicture('screen.png'), exact: true })).toBeVisible();
      await checkPage(page, errors);
    });

    test('an SVG, a renamed file and a document go up as files, and an empty one is turned away, saying why', async ({ page }, info) => {
      const errors = watchErrors(page);
      const server = await serve(page, 'delegate', settings);
      const window = await open(page, 'b1', lang);
      const terminal = window.locator('.t-xterm');
      await expect(window.locator('.xterm-screen')).toBeVisible();
      await window.locator('.xterm-screen').click();
      await page.keyboard.type('A draft');
      await expect.poll(() => server.keys.join('')).toBe('A draft');
      const refusal = window.getByRole('alert').filter({ hasText: t.errors.file_empty });
      await terminal.dispatchEvent('drop', { dataTransfer: await file(page, 'Reports', '', '') });
      await expect(refusal).toBeVisible();
      await shot(page, info, 'refused', settings);
      expect(server.uploads).toEqual([]);
      /* Nothing of the empty one went in, the words before it stay, and each file after it goes up as it is. */
      expect(server.keys.join('')).toBe('A draft');
      const sent = [
        ['logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
        ['notes.png', 'image/png', 'plain words, not a picture'],
        ['report.pdf', 'application/pdf', '%PDF-1.7 a report'],
      ] as const;
      for (const [n, [name, type, text]] of sent.entries()) {
        await terminal.dispatchEvent('drop', { dataTransfer: await file(page, name, type, text) });
        await expect.poll(() => server.keys.at(-1)).toBe(`${name}: hh-fetch message pic${n + 1}`);
      }
      await expect(refusal).toHaveCount(0);
      expect(server.uploads.map(u => [u.name, u.bytes.toString()])).toEqual(sent.map(([name, , text]) => [name, text]));
      expect(server.messages).toEqual([]);
      await shot(page, info, 'files', settings);
      await checkPage(page, errors);
    });
  });
}

test.describe('a picture for an agent', () => {
  const settings = { lang: 'en', theme: 'dark', width: 1440 } as const;

  test('pastes a picture directly into the terminal without opening a separate line', async ({ page }, info) => {
    const errors = watchErrors(page);
    const server = await serve(page, 'owner', settings);
    const window = await open(page, 'b1', 'en');
    const line = lineOf(window, 'b1', en);
    await expect(window.locator('.xterm-screen')).toBeVisible();
    await expect(line).toHaveCount(0);
    const helper = window.locator('.xterm-helper-textarea');
    await expect(helper).toBeFocused();

    await paste(helper, await picture(page, 'screen.png'));
    await expect(window.getByRole('status').filter({ hasText: en.window.pictureUploaded })).toBeVisible();
    await expect(line).toHaveCount(0);
    await expect(helper).toBeFocused();
    expect(server.uploads.map(u => u.name)).toEqual(['screen.png']);
    expect(server.messages).toEqual([]);
    expect(server.keys).toEqual(['screen.png: hh-fetch message pic1']);
    await shot(page, info, 'owner-direct-picture', settings);
    await page.keyboard.type('hi');
    await expect.poll(() => server.keys.join('')).toBe('screen.png: hh-fetch message pic1hi');
    await checkPage(page, errors);
  });

  test('made smaller in the browser when too big, rather than turned away', async ({ page }) => {
    const errors = watchErrors(page);
    const server = await serve(page, 'delegate', settings);
    const window = await open(page, 'b1', 'en');
    await expect(window.locator('.xterm-screen')).toBeVisible();
    const big = await picture(page, 'big.png', 'image/png', true);
    expect(await big.evaluate(t => t.files[0]!.size)).toBeGreaterThan(PICTURE_BYTES);
    await window.locator('.t-xterm').dispatchEvent('drop', { dataTransfer: big });
    await expect.poll(() => server.keys).toEqual(['big.jpg: hh-fetch message pic1']);
    const sent = server.uploads[0]!;
    expect(sent.name).toBe('big.jpg');
    expect(sent.bytes.length).toBeLessThanOrEqual(PICTURE_BYTES);
    expect(sent.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    await checkPage(page, errors);
  });

  test('leaves words pasted into the terminal to the program', async ({ page }) => {
    const server = await serve(page, 'owner', settings);
    const window = await open(page, 'b1', 'en');
    const helper = window.locator('.xterm-helper-textarea');
    await expect(helper).toBeFocused();
    const words = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'words');
      return transfer;
    });
    await paste(helper, words);
    await expect.poll(() => server.keys.join('')).toContain('words');
    await expect(window.locator('.t-tray')).toHaveCount(0);
  });

  test('takes nothing from a person turned away from the employee', async ({ page }) => {
    const server = await serve(page, 'department', settings);
    await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [{ ...SUB, agents: [{ id: 's1', canOpen: true, name: 'Sam', title: { en: 'Seller', ru: 'Продавец' }, task: null, busy: false }] }] } }));
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: en.shell.tabs.subscriptions, exact: true }).click();
    await page.getByRole('button', { name: /Open the card of.*Codex/ }).click();
    await page.getByRole('button', { name: en.window.openAgent('Sam'), exact: true }).click();
    const window = page.getByRole('dialog', { name: en.routes.accessDenied });
    await expect(window).toBeVisible();
    await expect(page.locator('aside.orch')).toHaveCount(0);
    await window.dispatchEvent('dragenter', { dataTransfer: await picture(page, 'screen.png') });
    await expect(window.getByText(en.window.dropPictures)).toHaveCount(0);
    await window.dispatchEvent('drop', { dataTransfer: await picture(page, 'screen.png') });
    await expect(window.locator('.t-tray')).toHaveCount(0);
    expect(server.uploads).toEqual([]);
    expect(server.messages).toEqual([]);
    expect(server.keys).toEqual([]);
  });
});
