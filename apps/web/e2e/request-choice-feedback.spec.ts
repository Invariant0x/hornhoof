import { startServer } from './real-server';
/// <reference types="node" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { LANGUAGES, type Language } from '../src/i18n';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Decisions, Org, WaitingRequest } from '../src/types';
import { openTaskAction, box, ME, openTaskCard, serveApi, TASKS } from './api';

const HERE = dirname(fileURLToPath(import.meta.url));

const MESSAGES: Record<Language, Messages> = { en, ru };
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;
const RTL_LANGUAGE_CODES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi']);

function requestCopyScore(t: Messages): number {
  return [
    t.tasks.yourAnswer,
    t.tasks.sendAnswer,
    t.tasks.approve,
    t.tasks.decline,
    t.tasks.decidedByCeo,
    t.tasks.note,
    t.tasks.choiceNote,
    t.tasks.choiceHint,
    t.tasks.sendFeedback,
    t.tasks.sending,
    t.tasks.cancelTask,
    t.tasks.openTerminal('Agent'),
    t.tasks.stuckText('Agent', 404),
  ].join('').length;
}

const SORTED_SHIPPED_LOCALES = [...LANGUAGES]
  .map(entry => ({ id: entry.id, score: requestCopyScore(MESSAGES[entry.id]) }))
  .sort((a, b) => b.score - a.score);
const LONGEST_SHIPPED_LOCALE = SORTED_SHIPPED_LOCALES[0]!.id;
const SHORTEST_SHIPPED_LOCALE = SORTED_SHIPPED_LOCALES.at(-1)!.id;
const SHIPPED_RTL_LOCALES = LANGUAGES.map(l => l.id).filter(id => RTL_LANGUAGE_CODES.has(id));
const CHECKED_LOCALES: readonly Language[] = Array.from(new Set([LONGEST_SHIPPED_LOCALE, SHORTEST_SHIPPED_LOCALE]));

type ShotProvenance = {
  file: string;
  provenance: 'playwright-route-fixture' | 'real-fastify-pglite-server';
  lang: Language;
  theme: 'light' | 'dark';
  width: number;
  surface: string;
};

const PROVENANCE: ShotProvenance[] = [];

async function saveScreenshot(
  page: Page,
  info: TestInfo,
  meta: ShotProvenance,
  exportToDir = true,
) {
  await page.screenshot({ path: info.outputPath(meta.file), fullPage: true });
  if (SCREENSHOT_DIR && exportToDir) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, meta.file), fullPage: true });
    PROVENANCE.push(meta);
  }
}

test.afterAll(() => {
  if (!SCREENSHOT_DIR) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  writeFileSync(
    resolve(SCREENSHOT_DIR, 'requests-500-provenance.json'),
    JSON.stringify(
      {
        shippedLocales: SORTED_SHIPPED_LOCALES,
        longestLocale: LONGEST_SHIPPED_LOCALE,
        shortestLocale: SHORTEST_SHIPPED_LOCALE,
        rtlLocales: SHIPPED_RTL_LOCALES,
        rtlStatus: SHIPPED_RTL_LOCALES.length === 0 ? 'NOT_AVAILABLE' : 'CHECKED',
        visualVerdict: 'PENDING_DESIGN_478',
        screenshots: PROVENANCE,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
});

function svgPng(svg: string): Buffer {
  return Buffer.from(svg, 'utf8');
}

const OVERVIEW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="160" viewBox="0 0 520 160">
  <rect width="520" height="160" fill="#131820"/>
  <circle cx="260" cy="54" r="34" fill="none" stroke="#29c5e6" stroke-width="2.5"/>
  <rect x="110" y="106" width="300" height="28" fill="#1b222d" stroke="#2f3b4c"/>
  <rect x="122" y="115" width="18" height="10" fill="#29c5e6"/>
  <rect x="146" y="115" width="18" height="10" fill="#29c5e6"/>
  <rect x="170" y="115" width="18" height="10" fill="#2b3646"/>
</svg>`;

const OPTION_A_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="140" viewBox="0 0 420 140">
  <rect width="420" height="140" fill="#141a22"/>
  <rect x="24" y="28" width="372" height="36" fill="#1d2531" stroke="#29c5e6" stroke-width="1.5"/>
  <rect x="38" y="40" width="14" height="12" fill="#29c5e6"/>
  <rect x="58" y="40" width="14" height="12" fill="#29c5e6"/>
  <rect x="78" y="40" width="14" height="12" fill="#29c5e6"/>
  <rect x="98" y="40" width="14" height="12" fill="#324054"/>
  <rect x="24" y="82" width="180" height="28" fill="#1d2531" stroke="#2f3b4c"/>
</svg>`;

const OPTION_B_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="140" viewBox="0 0 420 140">
  <rect width="420" height="140" fill="#141a22"/>
  <rect x="24" y="24" width="176" height="44" fill="#1d2531" stroke="#2f3b4c"/>
  <rect x="36" y="52" width="120" height="6" fill="#29c5e6"/>
  <rect x="220" y="24" width="176" height="44" fill="#1d2531" stroke="#2f3b4c"/>
  <rect x="232" y="52" width="84" height="6" fill="#29c5e6"/>
  <rect x="24" y="82" width="372" height="30" fill="#1d2531" stroke="#29c5e6" stroke-width="1.5"/>
</svg>`;

function makeChoiceRequest(lang: 'en' | 'ru'): WaitingRequest {
  const ruLang = lang === 'ru';
  return {
    id: 'req-choice-demo',
    kind: 'choice',
    text: ruLang
      ? 'Какой вариант блока прогресса под кругом на карте подходит лучше: компактная плашка Argon с квадратиками отделов или широкая полоса со счетчиками?'
      : 'Which turn progress layout under the map circle fits better: the compact Argon plate with department squares or the wide counter strip?',
    explained: ruLang
      ? 'Дизайнер подготовил два макета прогресса хода под центральным кругом для 1, 2-3 и 4-5 отделов.'
      : 'The designer prepared two turn-progress layouts under the central circle for 1, 2-3, and 4-5 departments.',
    explaining: false,
    images: ['pic-overview'],
    options: [
      {
        label: ruLang
          ? 'Вариант А (Argon): компактная плашка под кругом с синими квадратиками по числу отделов и подписью этапа'
          : 'Option A (Argon): compact plate under the circle with blue department squares and stage caption',
        image: 'pic-a',
      },
      {
        label: ruLang
          ? 'Вариант Б: широкая полоса со счетчиками'
          : 'Option B: wide strip with counters',
        image: 'pic-b',
      },
    ],
    link: 'https://preview.example.com/turn-progress-options',
    commit: null,
    commitUrl: null,
    at: '2026-11-05T15:20:00.000Z',
    ownerPersonId: 'p1',
    canAnswer: true,
    decidedBy: { kind: 'ceo_and_delegate', department: null },
    agent: {
      id: 'agent-gemini-designer',
      name: ruLang ? 'Дизайнер интерфейса (Gemini)' : 'Interface Designer (Gemini)',
    },
    task: {
      id: 't1',
      number: 402,
      title: ruLang
        ? 'Варианты прогресса хода под кругом на карте'
        : 'Turn progress options under the map circle',
      department: { id: 'd2', name: ruLang ? 'Разработка' : 'Development' },
    },
  };
}

const ORG: Org = {
  company: ME.company,
  orchestrator: null,
  agents: { total: 1, working: 1 },
  people: [],
  departments: [
    {
      id: 'd2',
      name: 'Development',
      templateKey: 'development',
      roleCode: 'DEV',
      about: '',
      agents: { total: 1, working: 1 },
      products: [],
      teams: [],
      people: [],
      employees: [],
      roles: [],
    },
  ],
};

async function fulfillShellRequestsRoute(route: Route, getRequests: () => WaitingRequest[]): Promise<boolean> {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/org') {
    await route.fulfill({ json: ORG });
    return true;
  }
  if (url.pathname === '/api/version') {
    await route.fulfill({ json: { version: '0.7.0', commit: 'task-500' } });
    return true;
  }
  if (url.pathname === '/api/updates') {
    await route.fulfill({ json: { current: { version: '0.7.0', commit: 'task-500' }, available: false, latest: null, updater: { status: null, waiting: null } } });
    return true;
  }
  if (url.pathname === '/api/restarts') {
    await route.fulfill({ json: { restarts: [] } });
    return true;
  }
  if (url.pathname === '/api/subscriptions') {
    await route.fulfill({ json: { subscriptions: [] } });
    return true;
  }
  if (url.pathname === '/api/machines') {
    await route.fulfill({ json: { machines: [] } });
    return true;
  }
  if (url.pathname === '/api/tasks' && url.search === '?status=all') {
    await route.fulfill({ json: { tasks: TASKS.slice(0, 2) } });
    return true;
  }
  if (url.pathname === '/api/requests' && route.request().method() === 'GET') {
    const requests = getRequests();
    await route.fulfill({
      json: {
        requests,
        proposals: [],
        machineAccess: [],
        counts: { byPerson: {}, byAgent: {}, total: requests.length },
      } satisfies Decisions,
    });
    return true;
  }
  return false;
}

async function openTasksWithChoice(page: Page, lang: 'en' | 'ru', theme: 'light' | 'dark', width: number) {
  await page.setViewportSize({ width, height: 960 });
  await page.addInitScript(
    ({ l, th }) => {
      localStorage.setItem('hh-lang', l);
      localStorage.setItem('hh-theme', th);
    },
    { l: lang, th: theme },
  );
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  page.on('response', res => {
    if (res.status() === 404) errors.push(`404: ${res.url()}`);
  });

  await serveApi(page);
  let current: WaitingRequest[] = [makeChoiceRequest(lang)];
  const posts: { url: string; body: unknown }[] = [];
  let failNext = false;

  await page.route('**/api/**', async route => {
    if (await fulfillShellRequestsRoute(route, () => current)) return;
    const url = new URL(route.request().url());
    if (url.pathname === '/api/attachments/pic-overview') {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svgPng(OVERVIEW_SVG) });
    }
    if (url.pathname === '/api/attachments/pic-a') {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svgPng(OPTION_A_SVG) });
    }
    if (url.pathname === '/api/attachments/pic-b') {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svgPng(OPTION_B_SVG) });
    }
    if (url.pathname === '/api/requests/req-choice-demo' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as unknown;
      posts.push({ url: url.pathname, body });
      if (failNext) {
        failNext = false;
        return route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } });
      }
      current = [];
      return route.fulfill({ json: { request: { id: 'req-choice-demo', status: 'answered', picked: null } } });
    }
    return route.fallback();
  });

  await page.goto('/tasks');
  const t = MESSAGES[lang];
  const card = page.getByRole('article', { name: /^#402 / });
  await expect(card).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return {
    t,
    card,
    errors,
    posts,
    failOnce: () => {
      failNext = true;
    },
  };
}

for (const lang of ['ru', 'en'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375] as const) {
      test(`aligns choice options and feedback form cleanly in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const { t, card, errors, posts } = await openTasksWithChoice(page, lang, theme, width);

        const options = card.locator('.opts > .opt');
        await expect(options).toHaveCount(2);
        const field = card.getByLabel(t.tasks.choiceNote);
        const send = card.getByRole('button', { name: t.tasks.sendFeedback, exact: true });
        await expect(send).toBeDisabled();

        const sampleFeedback =
          lang === 'ru'
            ? 'Ни один из двух макетов пока не выбираю.\nПокажите синие квадратики прямо внутри существующих плашек отделов.'
            : 'Neither option is picked yet.\nShow the blue progress squares directly inside the existing department chips.';
        await field.fill(sampleFeedback);
        await expect(send).toBeEnabled();

        /* Size viewport to fit the internal .screen scroll container so topbar, header, options, and Send all appear together. */
        const neededHeight = await page.evaluate(() => {
          const scroller = document.querySelector<HTMLElement>('.screen, .page') ?? document.documentElement;
          return Math.max(960, scroller.scrollHeight + 40);
        });
        await page.setViewportSize({ width, height: neededHeight });
        await page.evaluate(() => {
          for (const el of document.querySelectorAll<HTMLElement>('.screen, .page')) el.scrollTop = 0;
          window.scrollTo(0, 0);
        });
        await field.blur();

        const termBtn = card.locator('.req-term');
        const termBox = await box(termBtn);
        const boxA = await box(options.nth(0));
        const boxB = await box(options.nth(1));
        const cardBox = await box(card);
        const fieldBox = await box(field);
        const sendBox = await box(send);

        const docScrollWidth = await page.evaluate(() => {
          const scroller = document.querySelector<HTMLElement>('.screen, .page');
          return Math.max(document.documentElement.scrollWidth, scroller?.scrollWidth ?? 0);
        });
        expect(docScrollWidth, 'no horizontal page or screen overflow').toBeLessThanOrEqual(width);
        expect(cardBox.x).toBeGreaterThanOrEqual(0);
        expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(width);
        expect(termBox.x).toBeGreaterThanOrEqual(cardBox.x);
        expect(termBox.x + termBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);

        if (width === 1440) {
          /* Side-by-side equal columns on desktop, even with unequal label lengths. */
          expect(Math.abs(boxA.y - boxB.y)).toBeLessThanOrEqual(1);
          expect(Math.abs(boxA.height - boxB.height)).toBeLessThanOrEqual(1);
          expect(Math.abs(boxA.width - boxB.width)).toBeLessThanOrEqual(2);
          expect(boxB.x - (boxA.x + boxA.width)).toBeGreaterThanOrEqual(8);
        } else {
          /* Full-width stacked cards on 375px mobile, aligned with the textarea. */
          expect(boxB.y).toBeGreaterThanOrEqual(boxA.y + boxA.height + 8);
          expect(Math.abs(boxA.width - boxB.width)).toBeLessThanOrEqual(1);
          expect(Math.abs(boxA.width - fieldBox.width)).toBeLessThanOrEqual(1);
        }

        /* Left edges of first option, feedback textarea, and Send button line up cleanly. */
        expect(Math.abs(boxA.x - fieldBox.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(sendBox.x - fieldBox.x)).toBeLessThanOrEqual(1);
        expect(fieldBox.y).toBeGreaterThanOrEqual(Math.max(boxA.y + boxA.height, boxB.y + boxB.height) + 6);
        expect(sendBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height + 6);

        const shotName = `choice-feedback-${lang}-${theme}-${width}.png`;
        await saveScreenshot(page, info, {
          file: shotName,
          provenance: 'playwright-route-fixture',
          lang,
          theme,
          width,
          surface: '/tasks WaitingForYou choice card',
        });

        await send.click();
        await expect.poll(() => posts.at(-1)).toEqual({
          url: '/api/requests/req-choice-demo',
          body: { answer: sampleFeedback },
        });
        await expect(card).toBeHidden();
        expect(errors).toEqual([]);
      });
    }
  }
}

function makePanelRequests(lang: Language): WaitingRequest[] {
  const ruLang = lang === 'ru';
  const taskOne = {
    id: 't1',
    number: 1,
    title: TASKS[0]!.title,
    department: { id: 'd2', name: ruLang ? 'Разработка' : 'Development' },
  };
  const sha = 'c4053494f51a1f26be4708a0124169ebc90ad4d7';
  return [
    {
      id: 'req-approval-500',
      kind: 'approval',
      text: ruLang
        ? 'Одобрить слияние артефакта https://internal.acme.example/releases/turn-8/artifacts/bundle_sha256_5477f3dd64688d1bac477a09d8aa66b8218ec0b3f8a0e361df1b229e13ad7f50 перед проверкой?'
        : 'Approve merging artifact https://internal.acme.example/releases/turn-8/artifacts/bundle_sha256_5477f3dd64688d1bac477a09d8aa66b8218ec0b3f8a0e361df1b229e13ad7f50 before verification?',
      explained: null,
      explaining: false,
      images: [],
      options: [],
      link: 'https://internal.acme.example/releases/turn-8/compare/3e372c980b2913e9df7ac24ab249416a60703df4',
      commit: sha,
      commitUrl: `https://github.com/acme/hornhoof/commit/${sha}`,
      at: '2026-11-05T16:10:00.000Z',
      ownerPersonId: 'p1',
      canAnswer: true,
      decidedBy: { kind: 'ceo_and_delegate', department: null },
      agent: { id: 'agent-dev-1', name: ruLang ? 'Разработчик фронтенда (Алиса)' : 'Frontend Developer (Alice)' },
      task: taskOne,
    },
    {
      id: 'req-stuck-500',
      kind: 'stuck',
      text: '',
      explained: null,
      explaining: false,
      images: [],
      options: [],
      link: null,
      commit: null,
      commitUrl: null,
      at: '2026-11-05T16:12:00.000Z',
      ownerPersonId: 'p1',
      canAnswer: true,
      decidedBy: { kind: 'ceo_and_delegate', department: null },
      agent: { id: 'agent-dev-2', name: ruLang ? 'Инженер проверки (Борис)' : 'Verification Engineer (Boris)' },
      task: taskOne,
    },
    {
      id: 'req-readonly-500',
      kind: 'choice',
      text: ruLang
        ? 'Выбор политики хранения отчетов для следующего шага.'
        : 'Choose the report retention policy for the next step.',
      explained: null,
      explaining: false,
      images: [],
      options: [
        { label: ruLang ? 'Вариант 1: хранить полные архивы 30 дней' : 'Option 1: retain full archives for 30 days', image: null },
        { label: ruLang ? 'Вариант 2: хранить сводку и хеши 90 дней' : 'Option 2: retain summary and hashes for 90 days', image: null },
      ],
      link: null,
      commit: null,
      commitUrl: null,
      at: '2026-11-05T16:14:00.000Z',
      ownerPersonId: 'p2',
      canAnswer: false,
      decidedBy: { kind: 'department_and_ceo', department: taskOne.department },
      agent: { id: 'agent-dev-3', name: ruLang ? 'Архитектор (Вера)' : 'Architect (Vera)' },
      task: taskOne,
    },
  ];
}

async function assertRequestCardsFit(cards: Locator, rightLimit: number) {
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('aria-busy', 'false');
    const cardBox = await box(card);
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(rightLimit + 1);
    const cardOverflows = await card.evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth + 1);
    expect(cardOverflows, 'request card has no internal horizontal overflow').toBe(false);

    const term = card.locator('.req-term');
    if (await term.count()) {
      const termBox = await box(term);
      expect(termBox.x).toBeGreaterThanOrEqual(cardBox.x - 1);
      expect(termBox.x + termBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    }

    const commit = card.locator('.req-commit');
    if ((await commit.count()) > 0) {
      const commitBox = await box(commit);
      expect(commitBox.x).toBeGreaterThanOrEqual(cardBox.x - 1);
      expect(commitBox.x + commitBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    }

    const actions = card.locator('.req-actions');
    if ((await actions.count()) > 0) {
      const actionsBox = await box(actions);
      expect(actionsBox.x).toBeGreaterThanOrEqual(cardBox.x - 1);
      expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
      const btns = actions.locator('button');
      const btnCount = await btns.count();
      const boxes = [];
      for (let b = 0; b < btnCount; b++) {
        const btn = btns.nth(b);
        await expect(btn).toBeVisible();
        const bBox = await box(btn);
        expect(bBox.height).toBeGreaterThanOrEqual(30);
        expect(bBox.x).toBeGreaterThanOrEqual(actionsBox.x - 1);
        expect(bBox.x + bBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
        const clipped = await btn.evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth + 1);
        expect(clipped, 'action button label is not clipped').toBe(false);
        boxes.push(bBox);
      }
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const left = boxes[a]!;
          const right = boxes[b]!;
          const separated =
            left.x + left.width <= right.x + 1 ||
            right.x + right.width <= left.x + 1 ||
            left.y + left.height <= right.y + 1 ||
            right.y + right.height <= left.y + 1;
          expect(separated, 'action buttons never overlap').toBe(true);
        }
      }
    }
  }
}

test('derives longest and shortest shipped locales dynamically and records RTL availability honestly', () => {
  expect(LONGEST_SHIPPED_LOCALE).toBe('ru');
  expect(SHORTEST_SHIPPED_LOCALE).toBe('en');
  expect(SHIPPED_RTL_LOCALES).toEqual([]);
});

for (const lang of CHECKED_LOCALES) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375] as const) {
      test(`wraps action groups, commit SHAs, and long URLs in /tasks and narrow TaskPanel in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 960 });
        await page.addInitScript(
          ({ l, th }) => {
            localStorage.setItem('hh-lang', l);
            localStorage.setItem('hh-theme', th);
          },
          { l: lang, th: theme },
        );
        const errors: string[] = [];
        page.on('pageerror', err => errors.push(err.message));
        page.on('console', msg => {
          if (msg.type() === 'error') errors.push(msg.text());
        });

        await serveApi(page);
        const panelRequests = makePanelRequests(lang);
        await page.route('**/api/**', async route => {
          if (await fulfillShellRequestsRoute(route, () => panelRequests)) return;
          return route.fallback();
        });

        await page.goto('/tasks');
        const mainCards = page.locator('.page article.req');
        /* The page holds what this person can answer; the read-only choice of another person waits under Waiting for people (#1806). */
        await expect(mainCards).toHaveCount(2);
        await expect(mainCards.filter({ hasText: panelRequests.find(request => !request.canAnswer)!.text })).toHaveCount(0);
        await page.evaluate(async () => {
          await document.fonts.ready;
        });

        const mainOverflow = await page.evaluate(() => {
          const scroller = document.querySelector<HTMLElement>('.screen, .page');
          const offenders = [...document.querySelectorAll<HTMLElement>('body *')]
            .filter(el => el.getBoundingClientRect().right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1)
            .slice(0, 20)
            .map(el => ({ tag: el.tagName, className: el.className, right: el.getBoundingClientRect().right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: el.textContent?.slice(0, 100) }));
          return { width: Math.max(document.documentElement.scrollWidth, scroller?.scrollWidth ?? 0), offenders };
        });
        expect(mainOverflow.width, JSON.stringify(mainOverflow.offenders)).toBeLessThanOrEqual(width);
        await assertRequestCardsFit(mainCards, width);

        /* Only requests this person can answer appear on the card face. */
        await mainCards.first().locator('header button.linkish').click();
        const aside = page.locator('aside');
        const panelCards = aside.locator('.tp-question article.req');
        await expect(panelCards).toHaveCount(2);

        const asideOverflow = await aside.evaluate((el: HTMLElement) => {
          const body = el.querySelector<HTMLElement>('.ac-body');
          const offenders = [...el.querySelectorAll<HTMLElement>('*, .ac-body *')]
            .filter(item => item.scrollWidth > item.clientWidth + 1)
            .slice(0, 20)
            .map(item => ({ tag: item.tagName, className: item.className, right: item.getBoundingClientRect().right, scrollWidth: item.scrollWidth, clientWidth: item.clientWidth, text: item.textContent?.slice(0, 100) }));
          return { overflow: el.scrollWidth > el.clientWidth + 1 || (body ? body.scrollWidth > body.clientWidth + 1 : false), offenders };
        });
        expect(asideOverflow.overflow, JSON.stringify(asideOverflow.offenders)).toBe(false);
        const asideBox = await box(aside);
        expect(asideBox.x + asideBox.width).toBeLessThanOrEqual(width + 1);
        await assertRequestCardsFit(panelCards, asideBox.x + asideBox.width);

        await saveScreenshot(
          page,
          info,
          {
            file: `requests-panel-${lang}-${theme}-${width}.png`,
            provenance: 'playwright-route-fixture',
            lang,
            theme,
            width,
            surface: 'TaskPanel with the approval and stuck question this person can answer',
          },
          theme === 'dark',
        );
        expect(errors).toEqual([]);
      });
    }
  }
}

test('shows accessible sending status, preserves draft on server failure, and supports keyboard and touch on 375px', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'ru');
      localStorage.setItem('hh-theme', 'dark');
    });
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await serveApi(page);
    let current = makePanelRequests('ru').slice(0, 2);
    const posts: { url: string; body: unknown }[] = [];
    let releaseFirstPost: (() => void) | null = null;
    let attempt = 0;

    await page.route('**/api/**', async route => {
      if (await fulfillShellRequestsRoute(route, () => current)) return;
      const url = new URL(route.request().url());
      if (url.pathname === '/api/requests/req-approval-500' && route.request().method() === 'POST') {
        attempt += 1;
        posts.push({ url: url.pathname, body: route.request().postDataJSON() });
        if (attempt === 1) {
          await new Promise<void>(resolvePost => {
            releaseFirstPost = resolvePost;
          });
          return route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } });
        }
        current = current.slice(1);
        return route.fulfill({ json: { request: { id: 'req-approval-500', status: 'approved' } } });
      }
      if (url.pathname === '/api/tasks/t1/cancel' && route.request().method() === 'POST') {
        posts.push({ url: url.pathname, body: route.request().postDataJSON() });
        current = [];
        return route.fulfill({ json: {} });
      }
      return route.fallback();
    });

    await page.goto('/tasks');
    const cards = page.locator('.page article.req');
    await expect(cards).toHaveCount(2);
    const approvalCard = cards.nth(0);
    const stuckCard = cards.nth(1);

    const draft = 'Проверено по бюджету Q4.\nСохранить комментарий при ошибке сети.';
    const noteField = approvalCard.getByLabel(ru.tasks.note);
    const approveBtn = approvalCard.getByRole('button', { name: ru.tasks.approve, exact: true });
    const declineBtn = approvalCard.getByRole('button', { name: ru.tasks.decline, exact: true });
    await noteField.fill(draft);

    /* Submit via keyboard Tab -> Enter and inspect live in-flight state before server responds. */
    await noteField.focus();
    await page.keyboard.press('Tab');
    await expect(approveBtn).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(approvalCard).toHaveAttribute('aria-busy', 'true');
    const statusLine = approvalCard.getByRole('status');
    await expect(statusLine).toHaveText(ru.tasks.sending);
    await expect(approvalCard.getByRole('alert')).toHaveCount(0);
    await expect(approveBtn).toBeDisabled();
    await expect(declineBtn).toBeDisabled();
    await expect(stuckCard).toHaveAttribute('aria-busy', 'false');

    const cardBox = await box(approvalCard);
    const statusBox = await box(statusLine);
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    await saveScreenshot(page, info, {
      file: 'requests-sending-ru-dark-375.png',
      provenance: 'playwright-route-fixture',
      lang: 'ru',
      theme: 'dark',
      width: 375,
      surface: '/tasks approval card in-flight sending state',
    });

    /* Complete first request with 503 and verify alert + preserved draft + no horizontal overflow. */
    await expect.poll(() => releaseFirstPost !== null).toBe(true);
    releaseFirstPost!();

    const alertLine = approvalCard.getByRole('alert');
    await expect(alertLine).toHaveText(ru.errors.codes.unavailable);
    await expect(approvalCard).toHaveAttribute('aria-busy', 'false');
    await expect(approvalCard.getByRole('status')).toHaveCount(0);
    await expect(noteField).toHaveValue(draft);
    await expect(approveBtn).toBeEnabled();
    const alertBox = await box(alertLine);
    expect(alertBox.x + alertBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    await saveScreenshot(page, info, {
      file: 'requests-error-ru-dark-375.png',
      provenance: 'playwright-route-fixture',
      lang: 'ru',
      theme: 'dark',
      width: 375,
      surface: '/tasks approval card 503 failure state with preserved draft',
    });

    /* Retry via mobile touch tap, then cancel stuck task via touch tap without extra confirmation dialog. */
    await approveBtn.tap();
    await expect(cards).toHaveCount(1);
    const cancelBtn = cards.nth(0).getByRole('button', { name: ru.tasks.cancelTask, exact: true });
    await cancelBtn.tap();
    await expect(cards).toHaveCount(0);

    expect(posts).toEqual([
      { url: '/api/requests/req-approval-500', body: { approve: true, answer: draft } },
      { url: '/api/requests/req-approval-500', body: { approve: true, answer: draft } },
      { url: '/api/tasks/t1/cancel', body: {} },
    ]);
    expect(errors).toEqual(['Failed to load resource: the server responded with a status of 503 (Service Unavailable)']);
  } finally {
    await context.close();
  }
});

test('preserves multi-line feedback on server error and succeeds on retry, and keeps pick: 0 exact', async ({ page }) => {
  const { t, card, posts, failOnce } = await openTasksWithChoice(page, 'ru', 'dark', 1440);
  const feedback = 'Строка 1: пока без выбора.\nСтрока 2: переработать отступы.';
  const field = card.getByLabel(t.tasks.choiceNote);
  const send = card.getByRole('button', { name: t.tasks.sendFeedback, exact: true });

  failOnce();
  await field.fill(feedback);
  await send.click();

  await expect(card.getByRole('alert')).toHaveText(t.errors.codes.unavailable);
  await expect(field).toHaveValue(feedback);
  await expect(send).toBeEnabled();

  /* Choosing option 0 after editing note sends exact pick: 0 with comment. */
  await card.getByRole('button', { name: t.tasks.chooseOption(1), exact: true }).click();
  await expect.poll(() => posts).toEqual([
    { url: '/api/requests/req-choice-demo', body: { answer: feedback } },
    { url: '/api/requests/req-choice-demo', body: { pick: 0, answer: feedback } },
  ]);
  await expect(card).toBeHidden();
});

type RealServerBoot = {
  origin: string;
  session: string;
  ceoId: string;
  designerId: string;
  freeTaskId: string;
  freeTaskNumber: number;
  freeRequestId: string;
  pickTaskId: string;
  pickTaskNumber: number;
  pickRequestId: string;
  stop: () => Promise<void>;
};

type RealServerState = {
  freeRequest: { status: string; picked: number | null; answer: string | null; answeredBy: string | null; answeredByAgentId: string | null };
  pickRequest: { status: string; picked: number | null; answer: string | null; answeredBy: string | null; answeredByAgentId: string | null };
  freeTaskAnswered: { personId: string | null; agentId: string | null; text: string; data: unknown }[];
  pickTaskAnswered: { personId: string | null; agentId: string | null; text: string; data: unknown }[];
  designerMessages: { data: { text?: string; actor?: unknown; notification?: { source?: string; tasks?: { id: string; number: number }[] } } }[];
};

const REAL_SERVER_SCRIPT = `
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { buildApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { applyMissingMigrations, MIGRATIONS } from './src/db/client.js';
import * as schema from './src/db/schema.js';
import { setupCode } from './src/modules/setup/code.js';
import { ask, createTask } from './src/modules/tasks/engine.js';
import { testPort } from '../../test-support/ports.mjs';

const secret = Buffer.alloc(32, 7).toString('base64');
const commit = 'a'.repeat(40);
const client = new PGlite();
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: MIGRATIONS });
await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });

const config = loadConfig({
  HORNHOOF_SECRET: secret,
  UPDATE_CHECK_MS: '0',
  PUBLIC_URL: process.env.HH_PUBLIC_URL ?? 'http://localhost:4179',
  WEB_DIST: process.env.HH_WEB_DIST,
});
const app = await buildApp({
  db,
  config,
  readCommit: async (_repo, want) => ({ branch: 'branch' in want ? want.branch : 'task-' + want.task, commitSha: commit }),
  markCommit: async () => ({ ok: true }),
  readCompare: async () => ({ complete: true, baseSha: commit, headSha: commit, paths: [], diff: '' }),
});

let ids = { freeRequestId: '', pickRequestId: '', freeTaskId: '', pickTaskId: '', designerId: '' };
app.get('/__e2e/state', async () => {
  const [freeRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, ids.freeRequestId));
  const [pickRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, ids.pickRequestId));
  const freeTaskAnswered = await db.select().from(schema.taskEvents).where(and(eq(schema.taskEvents.taskId, ids.freeTaskId), eq(schema.taskEvents.kind, 'answered')));
  const pickTaskAnswered = await db.select().from(schema.taskEvents).where(and(eq(schema.taskEvents.taskId, ids.pickTaskId), eq(schema.taskEvents.kind, 'answered')));
  const designerMessages = await db.select().from(schema.agentEvents).where(and(eq(schema.agentEvents.agentId, ids.designerId), eq(schema.agentEvents.kind, 'message')));
  return { freeRequest: freeRow, pickRequest: pickRow, freeTaskAnswered, pickTaskAnswered, designerMessages };
});

const setupRes = await app.inject({
  method: 'POST',
  url: '/api/setup',
  payload: {
    code: setupCode(Buffer.from(secret, 'base64')),
    companyName: 'Acme',
    name: 'Ivan',
    email: 'ivan@acme.com',
    password: 'correct horse battery',
    orchestrator: { mode: 'api_key', provider: 'anthropic_api', apiKey: 'sk-ant-api03-test-key-9f3a' },
  },
});
const session = setupRes.cookies.find(c => c.name === 'hh_session')?.value;
if (!session) throw new Error('Setup failed: ' + setupRes.statusCode + ' ' + setupRes.body);

const [acme] = await db.select().from(schema.companies);
const [ceo] = await db.select().from(schema.people);
const [sub] = await db.select().from(schema.subscriptions);
const [dev] = await db.insert(schema.departments).values({ companyId: acme.id, templateKey: 'development', roleCode: 'DEV' }).returning();
const [designer] = await db.insert(schema.agents).values({
  companyId: acme.id,
  departmentId: dev.id,
  subscriptionId: sub.id,
  kind: 'worker',
  name: 'Дизайнер интерфейса (Gemini)',
  roleKey: 'DEV-FE',
  model: '',
}).returning();

const freeTask = (await createTask(app.ctx, { personId: ceo.id }, {
  title: 'Варианты прогресса хода под кругом',
  brief: '',
  body: '',
  departmentId: dev.id,
  assigneeAgentId: designer.id,
  executor: true,
  gates: [],
})).task;
const freeRequest = (await ask(app.ctx, designer.id, freeTask.id, {
  kind: 'choice',
  topic: 'task',
  text: 'Какой вариант блока прогресса под кругом подходит лучше?',
  options: [
    { label: 'Вариант А (Argon): компактная плашка с квадратиками отделов', image: null },
    { label: 'Вариант Б: широкая полоса со счетчиками', image: null },
  ],
})).request;

const pickTask = (await createTask(app.ctx, { personId: ceo.id }, {
  title: 'Плотность отступов карточек отделов',
  brief: '',
  body: '',
  departmentId: dev.id,
  assigneeAgentId: designer.id,
  executor: true,
  gates: [],
})).task;
const pickRequest = (await ask(app.ctx, designer.id, pickTask.id, {
  kind: 'choice',
  topic: 'task',
  text: 'Какой шаг отступов оставляем в карточке?',
  options: [
    { label: 'Вариант А: шаг 8px', image: null },
    { label: 'Вариант Б: шаг 12px', image: null },
  ],
})).request;

ids = {
  freeRequestId: freeRequest.id,
  pickRequestId: pickRequest.id,
  freeTaskId: freeTask.id,
  pickTaskId: pickTask.id,
  designerId: designer.id,
};

const origin = await app.listen({ host: '127.0.0.1', port: await testPort() });
process.stdout.write(JSON.stringify({
  origin,
  session,
  ceoId: ceo.id,
  designerId: designer.id,
  freeTaskId: freeTask.id,
  freeTaskNumber: freeTask.number,
  freeRequestId: freeRequest.id,
  pickTaskId: pickTask.id,
  pickTaskNumber: pickTask.number,
  pickRequestId: pickRequest.id,
}) + '\\n');

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await client.close();
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
`;

/* A server answers /api/build, which the page asks every few minutes, only with a page of its own to name. Left to find the
   built app in this checkout, it answered 404 wherever the app was not built, and the browser logs each as a console error.
   The server gets a small page of its own, as a production one has. */
function pageFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'hh-choice-web-'));
  writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Hornhoof</title>\n');
  return folder;
}

async function startRealServer(publicUrl: string, webDist: string): Promise<RealServerBoot> {
  return startServer<Omit<RealServerBoot, 'stop'>>(REAL_SERVER_SCRIPT, { cwd: resolve(HERE, '../../server'), publicUrl, invalidBoot: 'Invalid server boot line', env: { HH_WEB_DIST: webDist } });
}

test('saves neutral feedback without pick, delivers words to author, and preserves explicit pick: 0 on a real server', async ({ page, baseURL }, info) => {
  test.setTimeout(0);
  const webOrigin = baseURL ?? 'http://localhost:4179';
  const webDist = pageFolder();
  const srv = await startRealServer(webOrigin, webDist).catch(err => {
    rmSync(webDist, { recursive: true, force: true });
    throw err;
  });
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'ru');
      localStorage.setItem('hh-theme', 'dark');
    });
    await page.context().addCookies([{ name: 'hh_session', value: srv.session, url: webOrigin }]);

    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/stream') return;
      const response = await route.fetch({ url: `${srv.origin}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });

    await page.goto('/tasks');
    const freeCard = page.locator('.waiting').getByRole('article', { name: new RegExp(`^#${srv.freeTaskNumber} `) });
    const pickCard = page.locator('.waiting').getByRole('article', { name: new RegExp(`^#${srv.pickTaskNumber} `) });
    await expect(freeCard).toBeVisible();
    await expect(pickCard).toBeVisible();
    await expect(freeCard).toHaveAttribute('aria-busy', 'false');

    /* 1. Authorized person sends multi-line feedback without picking any option. */
    const freeFeedback = 'Ни один вариант пока не подходит.\nСделайте синие квадратики внутри существующих плашек отделов.';
    await freeCard.getByLabel(ru.tasks.choiceNote).fill(`  ${freeFeedback}  `);
    await saveScreenshot(page, info, {
      file: 'requests-real-server-before-ru-dark-1440.png',
      provenance: 'real-fastify-pglite-server',
      lang: 'ru',
      theme: 'dark',
      width: 1440,
      surface: '/tasks WaitingForYou backed by real Fastify + PGlite server',
    });
    await freeCard.getByRole('button', { name: ru.tasks.sendFeedback, exact: true }).click();
    await expect(freeCard).toBeHidden();

    /* 2. Authorized person picks option 0 with a comment on a second choice request. */
    const pickComment = 'Оставляем шаг 8px, проверьте мобильный экран 375px';
    await pickCard.getByLabel(ru.tasks.choiceNote).fill(`  ${pickComment}  `);
    await pickCard.locator('.req-option').nth(0).click();
    await expect(pickCard).toBeHidden();

    /* Open the first task's detail panel in the real UI and verify neutral answered state and text. */
    await openTaskCard(page, srv.freeTaskNumber);
    const panel = page.locator('aside');
    await openTaskAction(panel, ru, ru.tasks.details);
    await expect(panel).toContainText(freeFeedback);
    await expect(panel).toContainText(ru.tasks.requestStates.answered);
    await expect(panel).not.toContainText(/Picked \d|Approved|Declined/);
    await saveScreenshot(page, info, {
      file: 'requests-real-server-after-ru-dark-1440.png',
      provenance: 'real-fastify-pglite-server',
      lang: 'ru',
      theme: 'dark',
      width: 1440,
      surface: 'TaskPanel aside showing persisted answered request from real Fastify + PGlite server',
    });

    /* Inspect real server database state, task detail API, and delivery to the asking designer agent. */
    const stateRes = await fetch(`${srv.origin}/__e2e/state`);
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as RealServerState;

    expect(state.freeRequest).toMatchObject({
      status: 'answered',
      picked: null,
      answer: freeFeedback,
      answeredBy: srv.ceoId,
      answeredByAgentId: null,
    });
    expect(state.freeTaskAnswered).toEqual([
      expect.objectContaining({
        personId: srv.ceoId,
        agentId: null,
        text: freeFeedback,
        /* The answer moves the task from waiting back to work, and the line says so. */
        data: { requestId: srv.freeRequestId, kind: 'choice', status: 'answered', fromStatus: 'waiting', toStatus: 'working' },
      }),
    ]);

    const freeDeliveries = state.designerMessages.filter(
      m => m.data.notification?.source === 'answered' && m.data.notification.tasks?.some(t => t.id === srv.freeTaskId),
    );
    expect(freeDeliveries).toHaveLength(1);
    expect(freeDeliveries[0]!.data.actor).toEqual({
      kind: 'person',
      id: srv.ceoId,
      name: 'Ivan',
      role: { en: 'CEO', ru: 'CEO' },
      department: null,
    });
    expect(freeDeliveries[0]!.data.text).toContain(freeFeedback);
    expect(freeDeliveries[0]!.data.text).not.toMatch(/Picked \d|Approved|Declined/);

    expect(state.pickRequest).toMatchObject({
      status: 'answered',
      picked: 0,
      answer: pickComment,
      answeredBy: srv.ceoId,
      answeredByAgentId: null,
    });
    expect(state.pickTaskAnswered).toEqual([
      expect.objectContaining({
        personId: srv.ceoId,
        agentId: null,
        text: `Picked 1: Вариант А: шаг 8px. ${pickComment}`,
      }),
    ]);
    const pickDeliveries = state.designerMessages.filter(
      m => m.data.notification?.source === 'answered' && m.data.notification.tasks?.some(t => t.id === srv.pickTaskId),
    );
    expect(pickDeliveries).toHaveLength(1);
    expect(pickDeliveries[0]!.data.text).toContain(`Picked 1: Вариант А: шаг 8px. ${pickComment}`);

    const detailRes = await fetch(`${srv.origin}/api/tasks/${srv.freeTaskId}`, {
      headers: { cookie: `hh_session=${srv.session}` },
    });
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as { task: { requests: { id: string; status: string; picked: number | null; answer: string | null }[] } };
    expect(detailJson.task.requests).toEqual([
      expect.objectContaining({ id: srv.freeRequestId, status: 'answered', picked: null, answer: freeFeedback }),
    ]);

    expect(errors).toEqual([]);
  } finally {
    await srv.stop();
    rmSync(webDist, { recursive: true, force: true });
  }
});
