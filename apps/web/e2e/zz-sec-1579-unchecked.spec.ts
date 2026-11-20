/* Throwaway security probe, #1579 rerun under #1686 on 6be3dfe9 (B2 in a real browser). Not for commit. Maps to zz-sec-1569-b2's
   card whose explanation dropped the list, seen by a person. Change from the #1579 version: a fourth item, #1623's new 'unstarted'. */
/// <reference types="node" />
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Decisions, Org, WaitingRequest } from '../src/types';
import { box, ME, serveApi, TASKS } from './api';

const OUT = process.env.HH_OUT ?? process.env.HH_SCREENSHOT_DIR;
const SHA = 'c4053494f51a1f26be4708a0124169ebc90ad4d7';
const STRAY = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const JOIN = 'f0e1d2c3b4a5968778695a4b3c2d1e0f9e8d7c6b';

function approval(lang: 'en' | 'ru'): WaitingRequest {
  return {
    id: 'req-release', kind: 'approval',
    text: `Release turn 40: main to ${SHA}.\n\nHornhoof checked as this was asked. Run 200 passed on this commit.`,
    /* The orchestrator's plain words, which leave the list out. */
    explained: lang === 'ru' ? 'Выпуск хода 40 готов. Одобрите, чтобы main перешел на этот коммит.' : 'Turn 40 is ready to ship. Approve to move main to this commit.',
    explaining: false, images: [], options: [], link: null, commit: SHA, commitUrl: `https://github.com/example/app/commit/${SHA}`,
    unchecked: [{ kind: 'commit', commit: STRAY }, { kind: 'merge', commit: JOIN }, { kind: 'unpinned', task: 1544 }, { kind: 'unstarted', task: 1623 }],
    at: '2026-11-19T20:50:00.000Z', ownerPersonId: 'p1', canAnswer: true, decidedBy: { kind: 'ceo_and_delegate', department: null },
    agent: { id: 'agent-head', name: lang === 'ru' ? 'Руководитель разработки' : 'Head of development' },
    task: { id: 't1', number: 1, title: TASKS[0]!.title, department: { id: 'd2', name: lang === 'ru' ? 'Разработка' : 'Development' } },
  };
}

const ORG: Org = { company: ME.company, orchestrator: null, agents: { total: 1, working: 1 }, people: [], departments: [{ id: 'd2', name: 'Development', templateKey: 'development', roleCode: 'DEV', about: '', agents: { total: 1, working: 1 }, products: [], teams: [], people: [], employees: [], roles: [] }] };

async function shell(route: Route, requests: WaitingRequest[]): Promise<boolean> {
  const url = new URL(route.request().url());
  const answers: Record<string, unknown> = {
    '/api/org': ORG,
    '/api/version': { version: '0.40.0', commit: 'turn-40' },
    '/api/updates': { current: { version: '0.40.0', commit: 'turn-40' }, available: false, latest: null, updater: { status: null, waiting: null } },
    '/api/restarts': { restarts: [] }, '/api/subscriptions': { subscriptions: [] }, '/api/machines': { machines: [] },
  };
  if (url.pathname in answers) { await route.fulfill({ json: answers[url.pathname] }); return true; }
  if (url.pathname === '/api/tasks' && url.search === '?status=all') { await route.fulfill({ json: { tasks: TASKS.slice(0, 2) } }); return true; }
  if (url.pathname === '/api/requests' && route.request().method() === 'GET') {
    await route.fulfill({ json: { requests, proposals: [], machineAccess: [], counts: { byPerson: {}, byAgent: {}, total: requests.length } } satisfies Decisions });
    return true;
  }
  return false;
}

/* The list is inside the card, every item in the person's words, and above the Approve button, with no sideways overflow. */
async function listBesideApprove(card: Locator, t: typeof en, right: number) {
  const list = card.locator('.req-unchecked');
  await expect(list).toBeVisible();
  await expect(list).toContainText(t.tasks.unchecked.heading(4));
  await expect(list).toContainText(t.tasks.unchecked.commit(STRAY));
  await expect(list).toContainText(t.tasks.unchecked.merge(JOIN));
  await expect(list).toContainText(t.tasks.unchecked.unpinned(1544));
  await expect(list).toContainText(t.tasks.unchecked.unstarted(1623));
  await expect(list).toContainText(t.tasks.unchecked.accept);
  await expect(list.locator('li')).toHaveCount(4);
  const approve = card.getByRole('button', { name: t.tasks.approve, exact: true });
  await expect(approve).toBeVisible();
  const [l, a, c] = [await box(list), await box(approve), await box(card)];
  expect(l.y + l.height).toBeLessThanOrEqual(a.y);
  expect(l.x).toBeGreaterThanOrEqual(c.x - 1);
  expect(l.x + l.width).toBeLessThanOrEqual(Math.min(c.x + c.width, right) + 1);
  expect(await list.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  for (const li of await list.locator('li').all()) {
    const style = await li.evaluate((el: HTMLElement) => { const s = getComputedStyle(el); return { overflow: s.overflow, textOverflow: s.textOverflow, clipped: el.scrollWidth > el.clientWidth + 1 }; });
    expect(style.textOverflow).not.toBe('ellipsis');
    expect(style.clipped).toBe(false);
  }
}

async function shot(page: Page, name: string, path: string) {
  await page.screenshot({ path, fullPage: true });
  if (OUT) { mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: resolve(OUT, name), fullPage: true }); }
}

for (const lang of ['en', 'ru'] as const) {
  for (const width of [1440, 375] as const) {
    test(`zz-sec-1686 the uncovered list shows beside Approve in the requests list and the task panel, ${lang}, ${width}px`, async ({ page }, info) => {
      const t = lang === 'ru' ? ru : en;
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(l => { localStorage.setItem('hh-lang', l); localStorage.setItem('hh-theme', 'light'); }, lang);
      const errors: string[] = [];
      page.on('pageerror', err => errors.push(err.message));
      await serveApi(page);
      const requests = [approval(lang)];
      await page.route('**/api/**', async route => { if (await shell(route, requests)) return; return route.fallback(); });
      await page.goto('/tasks');
      const card = page.locator('.page article.req').first();
      await expect(card).toBeVisible();
      await page.evaluate(async () => { await document.fonts.ready; });
      /* The explanation stands where the words were; the list is not folded into "In detail". */
      await expect(card.locator('.req-explained')).toBeVisible();
      await expect(card.locator('details.req-more .req-unchecked')).toHaveCount(0);
      await listBesideApprove(card, t, width);
      const pageWidth = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.querySelector<HTMLElement>('.screen, .page')?.scrollWidth ?? 0));
      expect(pageWidth).toBeLessThanOrEqual(width);
      const tall = await page.evaluate(() => Math.max(1000, (document.querySelector<HTMLElement>('.screen, .page') ?? document.documentElement).scrollHeight + 40));
      await page.setViewportSize({ width, height: tall });
      await shot(page, `zz-1686-requests-${lang}-${width}.png`, info.outputPath(`requests-${lang}-${width}.png`));

      await page.setViewportSize({ width, height: 1000 });
      await card.locator('header button.linkish').click();
      const aside = page.locator('aside');
      const inline = aside.locator('.tp-question article.req');
      await expect(inline).toHaveCount(1);
      await inline.scrollIntoViewIfNeeded();
      await listBesideApprove(inline, t, (await box(aside)).x + (await box(aside)).width);
      await inline.locator('.req-unchecked').scrollIntoViewIfNeeded();
      await shot(page, `zz-1686-taskpanel-${lang}-${width}.png`, info.outputPath(`taskpanel-${lang}-${width}.png`));
      expect(errors).toEqual([]);
    });
  }
}
