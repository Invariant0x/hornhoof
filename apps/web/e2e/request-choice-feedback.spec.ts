import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Decisions, Org, WaitingRequest } from '../src/types';
import { box, ME, serveApi, TASKS } from './api';

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;

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

  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/org') return route.fulfill({ json: ORG });
    if (url.pathname === '/api/version') return route.fulfill({ json: { version: '0.7.0', commit: 'task-415' } });
    if (url.pathname === '/api/updates') {
      return route.fulfill({ json: { current: { version: '0.7.0', commit: 'task-415' }, available: false, latest: null, updater: { status: null, waiting: null } } });
    }
    if (url.pathname === '/api/restarts') return route.fulfill({ json: { restarts: [] } });
    if (url.pathname === '/api/subscriptions') return route.fulfill({ json: { subscriptions: [] } });
    if (url.pathname === '/api/machines') return route.fulfill({ json: { machines: [] } });
    if (url.pathname === '/api/tasks' && url.search === '?status=all') {
      return route.fulfill({ json: { tasks: TASKS.slice(0, 2) } });
    }
    if (url.pathname === '/api/attachments/pic-overview') {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svgPng(OVERVIEW_SVG) });
    }
    if (url.pathname === '/api/attachments/pic-a') {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svgPng(OPTION_A_SVG) });
    }
    if (url.pathname === '/api/attachments/pic-b') {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svgPng(OPTION_B_SVG) });
    }
    if (url.pathname === '/api/requests') {
      const body: Decisions = {
        requests: current,
        proposals: [],
        computerAccess: null,
        counts: { byPerson: {}, byAgent: {}, total: current.length },
      };
      return route.fulfill({ json: body });
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

        const options = card.locator('.req-option');
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
        await page.screenshot({ path: info.outputPath(shotName), fullPage: true });
        if (SCREENSHOT_DIR) {
          mkdirSync(SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: resolve(SCREENSHOT_DIR, shotName), fullPage: true });
        }

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
  await card.locator('.req-option').nth(0).click();
  await expect.poll(() => posts).toEqual([
    { url: '/api/requests/req-choice-demo', body: { answer: feedback } },
    { url: '/api/requests/req-choice-demo', body: { pick: 0, answer: feedback } },
  ]);
  await expect(card).toBeHidden();
});
