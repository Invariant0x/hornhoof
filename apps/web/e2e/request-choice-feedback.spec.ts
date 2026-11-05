/// <reference types="node" />
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Decisions, Org, WaitingRequest } from '../src/types';
import { box, ME, serveApi, TASKS } from './api';

const HERE = dirname(fileURLToPath(import.meta.url));

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

const origin = await app.listen({ host: '127.0.0.1', port: 0 });
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

async function startRealServer(publicUrl: string): Promise<RealServerBoot> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', REAL_SERVER_SCRIPT], {
    cwd: resolve(HERE, '../../server'),
    env: { ...process.env, HH_PUBLIC_URL: publicUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout });
  const boot = await new Promise<Omit<RealServerBoot, 'stop'>>((resolveBoot, rejectBoot) => {
    lines.once('line', line => {
      try {
        resolveBoot(JSON.parse(line) as Omit<RealServerBoot, 'stop'>);
      } catch (err) {
        rejectBoot(new Error(`Invalid server boot line: ${line} (${String(err)})\n${stderr}`));
      }
    });
    child.once('exit', code => {
      rejectBoot(new Error(`Real server exited early (${code}):\n${stderr}`));
    });
  });
  return {
    ...boot,
    stop: () =>
      new Promise<void>(done => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.stdin.end();
      }),
  };
}

test('saves neutral feedback without pick, delivers words to author, and preserves explicit pick: 0 on a real server', async ({ page, baseURL }) => {
  test.setTimeout(30_000);
  const webOrigin = baseURL ?? 'http://localhost:4179';
  const srv = await startRealServer(webOrigin);
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
    const freeCard = page.getByRole('article', { name: new RegExp(`^#${srv.freeTaskNumber} `) });
    const pickCard = page.getByRole('article', { name: new RegExp(`^#${srv.pickTaskNumber} `) });
    await expect(freeCard).toBeVisible();
    await expect(pickCard).toBeVisible();

    /* 1. Authorized person sends multi-line feedback without picking any option. */
    const freeFeedback = 'Ни один вариант пока не подходит.\nСделайте синие квадратики внутри существующих плашек отделов.';
    await freeCard.getByLabel(ru.tasks.choiceNote).fill(`  ${freeFeedback}  `);
    await freeCard.getByRole('button', { name: ru.tasks.sendFeedback, exact: true }).click();
    await expect(freeCard).toBeHidden();

    /* 2. Authorized person picks option 0 with a comment on a second choice request. */
    const pickComment = 'Оставляем шаг 8px, проверьте мобильный экран 375px';
    await pickCard.getByLabel(ru.tasks.choiceNote).fill(`  ${pickComment}  `);
    await pickCard.locator('.req-option').nth(0).click();
    await expect(pickCard).toBeHidden();

    /* Open the first task's detail panel in the real UI and verify neutral answered state and text. */
    await page.locator('.ttree').getByRole('button', { name: new RegExp(`#${srv.freeTaskNumber}\\b`) }).click();
    const panel = page.locator('aside');
    await expect(panel).toContainText(freeFeedback);
    await expect(panel).toContainText(ru.tasks.requestStates.answered);
    await expect(panel).not.toContainText(/Picked \d|Approved|Declined/);

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
        data: { requestId: srv.freeRequestId, kind: 'choice', status: 'answered' },
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
  }
});
