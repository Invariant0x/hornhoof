import { expect, test, type JSHandle, type Locator, type Page, type Route } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { EventView } from '../src/types';
import { serveAgentWindow, SUB, type AgentFixture } from './agent-window-api';
import { checkPage, open, ORCHESTRATOR, ORCHESTRATOR_CARD, shot, VIEWERS, watchErrors, type Agent, type Settings, type Viewer } from './agent-window-steps';

const PICTURE_BYTES = 3 * 1024 * 1024;
const REFUSED = { error: { code: 'forbidden', message: 'This employee works in a department you do not have.', reason: 'not_your_department' } };

type Upload = { agent: string; name: string; bytes: Buffer };
type Said = { agent: string; text: string; pictures?: string[] };
/* What reached the server from this person, and the keys that reached the terminal. */
type Server = { uploads: Upload[]; messages: Said[]; keys: string[] };

const isPicture = (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));

/* The server's side of a picture, as it judges one: by what the bytes hold. */
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
  const live: AgentFixture = { awake: false, hasTask: false, messages: [], connections: 0, canType: types, orchestrator: ORCHESTRATOR, events: events.b1 };
  await serveAgentWindow(page, live);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const post = route.request().method() === 'POST';
    const up = /^\/api\/agents\/(orchestrator|b1)\/pictures$/.exec(url.pathname);
    if (up && post) {
      const bytes = route.request().postDataBuffer() ?? Buffer.alloc(0);
      if (bytes.length > PICTURE_BYTES) return route.fulfill({ status: 413, json: { error: { code: 'validation', message: 'Too big.', reason: 'picture_too_big' } } });
      if (!isPicture(bytes)) return route.fulfill({ status: 400, json: { error: { code: 'validation', message: 'Not a picture.', reason: 'picture_invalid' } } });
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
    if (url.pathname.startsWith('/api/agents/s1')) return route.fulfill({ status: 403, json: REFUSED });
    if (url.pathname === '/api/me') return route.fulfill({ json: me });
    if (url.pathname === '/api/computer') return route.fulfill({ json: { available: false, until: null, asked: null } });
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
    ws.send(JSON.stringify({ type: 'ready', write: types }));
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

/* Anything that is no picture, under whatever name and type it comes. */
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
    test('dragged into the terminal view of an employee, it goes with the words and stands by them in the log', async ({ page }, info) => {
      const errors = watchErrors(page);
      const server = await serve(page, 'delegate', settings);
      const window = await open(page, 'b1', lang);
      const line = lineOf(window, 'b1', t);
      await expect(window.locator('.xterm-screen')).toBeVisible();
      const shotOne = await picture(page, 'screen.png');

      await window.dispatchEvent('dragenter', { dataTransfer: shotOne });
      const where = window.getByText(t.window.dropPictures);
      await expect(where).toBeVisible();
      await shot(page, info, 'dragging', settings);
      await window.dispatchEvent('dragover', { dataTransfer: shotOne });
      await window.dispatchEvent('drop', { dataTransfer: shotOne });
      await expect(where).toHaveCount(0);

      await expect(window.getByRole('img', { name: 'screen.png', exact: true })).toBeVisible();
      await window.dispatchEvent('drop', { dataTransfer: await picture(page, 'second.png') });
      await expect(window.getByRole('img', { name: 'second.png', exact: true })).toBeVisible();
      await window.dispatchEvent('drop', { dataTransfer: await picture(page, 'taken-back.png') });
      await window.getByRole('button', { name: t.window.removePicture('taken-back.png'), exact: true }).click();
      await expect(window.getByRole('img', { name: 'taken-back.png', exact: true })).toHaveCount(0);
      await expect(line).toBeFocused();
      await line.fill('The button is cut off here');
      await shot(page, info, 'preview', settings);
      await checkPage(page, errors);

      await line.press('Enter');
      await expect.poll(() => server.messages).toEqual([{ agent: 'b1', text: 'The button is cut off here', pictures: ['pic1', 'pic2'] }]);
      expect(server.uploads.map(u => u.name)).toEqual(['screen.png', 'second.png']);
      await expect(window.getByRole('img', { name: 'screen.png', exact: true })).toHaveCount(0);

      await window.getByRole('button', { name: t.window.showLog, exact: true }).click();
      const large = window.getByRole('link', { name: t.window.openPicture('screen.png'), exact: true });
      await expect(large).toBeVisible();
      await expect(large.getByRole('img')).toHaveJSProperty('complete', true);
      expect(await large.getByRole('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(480);
      await shot(page, info, 'conversation', settings);
      const opened = page.waitForEvent('popup');
      await large.click();
      const tab = await opened;
      await tab.waitForLoadState();
      expect(new URL(tab.url()).pathname).toBe('/api/attachments/pic1');
      await tab.close();
      await checkPage(page, errors);
    });

    test('pasted in the log of the orchestrator, it goes alone', async ({ page }, info) => {
      const errors = watchErrors(page);
      const server = await serve(page, 'delegate', settings);
      const window = await open(page, 'orchestrator', lang);
      await window.getByRole('button', { name: t.window.showLog, exact: true }).click();
      const line = lineOf(window, 'orchestrator', t);
      await line.click();
      await paste(line, await picture(page, 'screen.png'));
      await expect(window.getByRole('img', { name: 'screen.png', exact: true })).toBeVisible();
      await shot(page, info, 'pasted', settings);
      await window.getByRole('button', { name: t.window.sendPictures, exact: true }).click();
      await expect.poll(() => server.messages).toEqual([{ agent: 'orchestrator', text: '', pictures: ['pic1'] }]);
      await expect(window.getByRole('link', { name: t.window.openPicture('screen.png'), exact: true })).toBeVisible();
      await checkPage(page, errors);
    });

    test('an SVG, a renamed file and what the server refuses are turned away, each saying why', async ({ page }, info) => {
      const errors = watchErrors(page);
      const server = await serve(page, 'delegate', settings);
      const window = await open(page, 'b1', lang);
      const refusal = window.getByRole('alert').filter({ hasText: t.errors.picture_invalid });
      await window.dispatchEvent('drop', { dataTransfer: await file(page, 'logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>') });
      await expect(refusal).toBeVisible();
      await expect(window.locator('.t-tray')).toHaveCount(0);
      await shot(page, info, 'refused', settings);
      await window.dispatchEvent('drop', { dataTransfer: await file(page, 'notes.png', 'image/png', 'plain words, not a picture') });
      await expect(refusal).toBeVisible();
      await expect(window.getByRole('img', { name: 'notes.png', exact: true })).toHaveCount(0);
      expect(server.uploads).toEqual([]);
      expect(server.messages).toEqual([]);
      await checkPage(page, errors.filter(e => !e.includes('ERR_') && !e.includes('blob:')));
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
    await window.dispatchEvent('drop', { dataTransfer: big });
    const line = lineOf(window, 'b1', en);
    await expect(window.getByRole('img', { name: 'big.jpg', exact: true })).toBeVisible({ timeout: 15_000 });
    await line.press('Enter');
    await expect.poll(() => server.messages.length).toBe(1);
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
    const alert = page.getByRole('alert').filter({ hasText: en.errors.not_your_department });
    await expect(alert).toBeVisible();
    const window = page.locator('aside.orch');
    await window.dispatchEvent('dragenter', { dataTransfer: await picture(page, 'screen.png') });
    await expect(window.getByText(en.window.dropPictures)).toHaveCount(0);
    await window.dispatchEvent('drop', { dataTransfer: await picture(page, 'screen.png') });
    await expect(window.locator('.t-tray')).toHaveCount(0);
    expect(server.uploads).toEqual([]);
  });
});
