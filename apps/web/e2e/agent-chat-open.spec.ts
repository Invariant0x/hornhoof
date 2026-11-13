import { expect, test, type Locator, type Page } from '@playwright/test';
import type { EventView } from '../src/types';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';

/* A chat with a long history opens on its newest line from the first frame it shows, and nothing in it moves; switching away
   and back brings it on its newest line again. Every frame the browser draws is written down: where the chat stands, how many
   lines it shows and how many of them still move in. Waits go by frames and states, never by the clock. */

const AT = '2026-11-04T10:00:00Z';
/* The most events the server sends at a time. */
const PAGE = 500;
const ev = (seq: number): EventView =>
  seq % 2
    ? { seq, kind: 'message', data: { text: `Question ${seq}: please check the checkout form again.` }, jobId: 'j1', person: { id: 'p1', name: 'Ivan' }, at: AT }
    : { seq, kind: 'text', data: { text: `Answer ${seq}. The checkout form works and **all checks pass**.` }, jobId: 'j1', person: null, at: AT };
const HISTORY = Array.from({ length: PAGE + 100 }, (_, i) => ev(i + 1));
const STATE = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: false, canType: true, turnRefused: null };

type Frame = { top: number; height: number; view: number; lines: number; moving: number };
type Seen = { chatFrames: Frame[]; live(message: unknown): void };

/* Before the page loads: a stand-in for the server's live stream, and a note of every frame of the chat while it is shown. */
function watchFrames() {
  const seen = window as unknown as Window & Seen;
  seen.chatFrames = [];
  const tick = () => {
    const log = document.querySelector<HTMLElement>('.t-log.chat');
    if (log && !log.closest('[hidden]')) {
      const lines = [...log.children].filter(c => c.classList.contains('t-line'));
      const moving = lines.filter(line => line.getAnimations().some(a => a.playState === 'running')).length;
      seen.chatFrames.push({ top: log.scrollTop, height: log.scrollHeight, view: log.clientHeight, lines: lines.length, moving });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const streams: EventTarget[] = [];
  class Stream extends EventTarget {
    static readonly CLOSED = 2;
    readyState = 1;
    constructor() {
      super();
      streams.push(this);
    }
    close() {
      this.readyState = 2;
    }
  }
  Object.assign(window, { EventSource: Stream });
  seen.live = message => streams.forEach(s => s.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })));
}

const frames = (page: Page) => page.evaluate(() => (window as unknown as Seen).chatFrames);
const frameCount = async (page: Page) => (await frames(page)).length;
const framesAfter = async (page: Page, from: number) => (await frames(page)).slice(from);
/* Lets the browser draw this many more frames of the chat. */
const drawn = (page: Page, from: number, more: number) => page.waitForFunction(n => (window as unknown as Seen).chatFrames.length >= n, from + more);
const atEnd = (f: Frame) => f.top >= f.height - f.view - 1;
/* The person scrolls the chat, and the browser tells of it, as it does at its next frame. */
const scrollTo = (chat: Locator, top: number | 'end') =>
  chat.evaluate((el, to) => new Promise<void>(done => {
    el.addEventListener('scroll', () => done(), { once: true });
    el.scrollTo({ top: to === 'end' ? el.scrollHeight : to });
  }), top);

async function openChat(page: Page, live: AgentFixture, releaseOnce: { held: Promise<void> | null }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(watchFrames);
  await serveAgentWindow(page, live);
  /* History comes a page at a time from the oldest, as the server sends it; the second page waits until the test lets it go. */
  await page.route('**/api/agents/b1/events*', async route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
    if (after === PAGE && releaseOnce.held) {
      const held = releaseOnce.held;
      releaseOnce.held = null;
      await held;
    }
    await route.fulfill({ json: { events: (live.events ?? []).filter(e => e.seq > after).slice(0, PAGE), state: STATE } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Development/ }).click();
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
}

const sendLine = (page: Page, live: AgentFixture, seq: number) => {
  const event = ev(seq);
  live.events!.push(event);
  return page.evaluate(e => (window as unknown as Seen).live({ type: 'agent_event', agentId: 'b1', event: e }), event);
};

test('a chat with a long history opens on its newest line, and comes back on it after switching away', async ({ page }, info) => {
  const live: AgentFixture = { awake: false, hasTask: false, messages: [], connections: 0, events: [...HISTORY] };
  let release!: () => void;
  const hold = { held: new Promise<void>(resolve => (release = resolve)) as Promise<void> | null };
  const secondPage = page.waitForRequest(r => r.url().includes(`/api/agents/b1/events?after=${PAGE}`));
  await openChat(page, live, hold);
  await secondPage;
  /* The first page is in and frames go by while the rest is on its way: the chat shows none of its old lines meanwhile. */
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
  release();
  const chat = page.getByRole('log', { name: 'Conversation' });
  await expect(chat).toBeVisible();
  await drawn(page, 0, 10);
  const opening = await frames(page);
  await info.attach('open-frames.json', { body: JSON.stringify(opening, null, 1), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath(`open-${info.project.name}.png`) });
  expect(opening.filter(f => f.lines !== HISTORY.length || !atEnd(f) || f.moving > 0)).toEqual([]);

  /* Open, at its end: a new line shows, and only it moves in. */
  let from = await frameCount(page);
  await sendLine(page, live, HISTORY.length + 1);
  await expect(chat.locator(':scope > .t-line')).toHaveCount(HISTORY.length + 1);
  await drawn(page, from, 5);
  expect((await framesAfter(page, from)).filter(f => f.lines === HISTORY.length + 1 && !atEnd(f))).toEqual([]);

  /* Switching away: the window hides, and lines keep coming to it. */
  await page.getByRole('button', { name: 'Minimize' }).click();
  await expect(chat).toBeHidden();
  for (const seq of [HISTORY.length + 2, HISTORY.length + 3]) await sendLine(page, live, seq);
  from = await frameCount(page);
  await page.getByRole('button', { name: 'Restore Bruno, Developer' }).click();
  await expect(chat).toBeVisible();
  await drawn(page, from, 10);
  const back = await framesAfter(page, from);
  await info.attach('switch-back-frames.json', { body: JSON.stringify(back, null, 1), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath(`switch-back-${info.project.name}.png`) });
  expect(back.filter(f => f.lines !== HISTORY.length + 3 || !atEnd(f) || f.moving > 0)).toEqual([]);
});

test('a person who scrolled up to read stays where they read while new lines come', async ({ page }) => {
  const live: AgentFixture = { awake: false, hasTask: false, messages: [], connections: 0, events: HISTORY.slice(0, 60) };
  await openChat(page, live, { held: null });
  const chat = page.getByRole('log', { name: 'Conversation' });
  await expect(chat.locator(':scope > .t-line')).toHaveCount(60);
  await scrollTo(chat, 200);
  await sendLine(page, live, 61);
  await expect(chat.locator(':scope > .t-line')).toHaveCount(61);
  const from = await frameCount(page);
  await drawn(page, from, 5);
  expect((await framesAfter(page, from)).filter(f => f.top !== 200)).toEqual([]);
  /* Back at the end, the chat follows the next line again. */
  await scrollTo(chat, 'end');
  await sendLine(page, live, 62);
  await expect(chat.locator(':scope > .t-line')).toHaveCount(62);
  await expect.poll(() => chat.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true);
});
