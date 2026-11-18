import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { box } from './api';
import type { ComputerAccessView } from '../src/types';
import { CLOSED, OPEN, openWindow } from './computer-strip-api';

/* The agent's screen holds its terminal and short notes (#1115, Design #1102). A note of the program or of Hornhoof,
   such as the program sleeping until the agent's next task or the machine low on memory, stands at the foot of the
   window, under the terminal and the input line inside it, never over either; several stand one under another, each
   led by a word in a frame. A note of standing access links to the machine in Machines. */

test.describe.configure({ timeout: 180_000 });

type Look = { lang: 'en' | 'ru'; dir: 'ltr' | 'rtl'; theme: 'light' | 'dark'; width: 1440 | 375 };
const LOOKS: Look[] = (['en', 'ru'] as const).flatMap(lang =>
  (['ltr', 'rtl'] as const).flatMap(dir => (['light', 'dark'] as const).flatMap(theme => ([1440, 375] as const).map(width => ({ lang, dir, theme, width })))),
);
const named = ({ lang, dir, theme, width }: Look) => `${lang} ${dir} ${theme} ${width}`;
const messages = { en, ru };

const LIMIT = new Date(Date.now() + 3 * 3_600_000).toISOString();
/* Enough lines that the input line stands on the terminal's last row. */
const PROMPT = '> write here';
const DATA = `${Array.from({ length: 80 }, (_, i) => `step ${i + 1} of the work`).join('\r\n')}\r\n${PROMPT}`;
/* The machine is low on memory and the plan at its limit, on top of the program asleep. */
const HELD = { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: true, memoryWait: true, limitUntil: LIMIT } };

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

async function openNotes(page: Page, look: Look, program: Record<string, unknown>, first: ComputerAccessView = CLOSED, others: ComputerAccessView[] = []) {
  if (look.dir === 'rtl') await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; }));
  const opened = await openWindow(page, look, first, others, { '/api/agents/orchestrator/events': HELD }, { program, data: DATA });
  await page.evaluate(async () => { await document.fonts.ready; });
  return opened;
}

/* A note, by its words: the whole note, which says them to a screen reader, led by its framed word. */
const noteOf = (window: Locator, text: string) => window.getByRole('status').filter({ hasText: text });

/* Each note on the screen, under the terminal and its input line, inside the window; one under another. */
async function expectStacked(page: Page, window: Locator, notes: Locator[], width: number) {
  for (const note of notes) await expect(note).toBeVisible();
  const term = await box(window.locator('.t-term'));
  const input = window.locator('.xterm-rows > div').filter({ hasText: PROMPT });
  await expect(input).toBeVisible();
  const line = await box(input);
  expect(line.y + line.height).toBeLessThanOrEqual(term.y + term.height + 0.5);
  expect(term.height).toBeGreaterThanOrEqual(155.5);
  const frame = await box(window);
  const boxes = await Promise.all(notes.map(box));
  for (const b of boxes) {
    expect(overlaps(b, term), 'a note lies over the terminal').toBe(false);
    expect(overlaps(b, line), 'a note lies over the input line').toBe(false);
    expect(b.y).toBeGreaterThanOrEqual(term.y + term.height - 0.5);
    expect(b.x).toBeGreaterThanOrEqual(frame.x - 0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!), 'two notes lie on each other').toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

for (const look of LOOKS) {
  const t = messages[look.lang].window;

  test(`notes stand under the terminal and its input line, one under another: ${named(look)}`, async ({ page }) => {
    const { window, errors } = await openNotes(page, look, { asleep: true });
    const asleep = noteOf(window, t.asleep('Claude').split('Claude')[1]!.trim().slice(0, 30));
    const memory = noteOf(window, t.memoryWait);
    const limit = noteOf(window, t.limitUntil('').split(' ').slice(0, 4).join(' '));
    await expectStacked(page, window, [asleep, memory, limit], look.width);
    await page.screenshot({ path: test.info().outputPath('agent-notes.png'), animations: 'disabled' });
    /* The three that are not the memory's stand in one column, each under the one before. */
    const [a, l] = [await box(asleep), await box(limit)];
    expect(Math.abs(a.x - l.x)).toBeLessThanOrEqual(1);
    /* Each is led by the word of its kind, in a frame. */
    for (const [note, word] of [[asleep, t.notes.asleep], [memory, t.notes.wait], [limit, t.notes.wait]] as const) {
      const framed = note.getByText(word, { exact: true });
      await expect(framed).toBeVisible();
      expect(await framed.evaluate(el => parseFloat(getComputedStyle(el).borderTopWidth))).toBeGreaterThanOrEqual(1);
    }
    /* Right to left, the words keep their order and their full stop at the end. */
    if (look.dir === 'rtl') expect(await memory.evaluate(el => getComputedStyle(el).direction)).toBe('rtl');
    /* Its words keep their own order: they start with the framed word and end with their full stop. */
    expect(await memory.getByText(t.memoryWait, { exact: true }).evaluate(el => getComputedStyle(el).direction)).toBe('ltr');
    expect(errors).toEqual([]);
  });

  test(`standing access appears as a note that leads to Machines: ${named(look)}`, async ({ page }) => {
    const { window, errors, posts } = await openNotes(page, look, { running: true }, OPEN);
    await expect(window.getByRole('button', { name: t.computerClose, exact: true })).toHaveCount(0);
    const open = noteOf(window, t.computerStanding('node-a'));
    await expectStacked(page, window, [open], look.width);
    await page.screenshot({ path: test.info().outputPath('agent-access-notes.png'), animations: 'disabled' });
    await expect(open.getByText(t.notes.access, { exact: true })).toBeVisible();
    await page.route(url => url.pathname === '/api/machines' || url.pathname === '/api/subscriptions', route =>
      route.fulfill({ json: new URL(route.request().url()).pathname === '/api/machines' ? { machines: [], builtin: null } : { subscriptions: [] } }),
    );
    await open.getByRole('link', { name: t.notes.manage, exact: true }).click();
    await expect(page).toHaveURL(/\/machines\/node-a$/);
    await expect(window).toBeHidden();
    expect(posts).toEqual([]);
    expect(errors).toEqual([]);
  });
}
