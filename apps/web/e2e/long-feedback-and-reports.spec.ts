import { pageFolder, startServer } from './real-server';
/// <reference types="node" />
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { openTaskAction, openTaskCard } from './api';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_CWD = process.env.HH_E2E_SERVER_CWD ?? resolve(HERE, '../../server');
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };

const sha256 = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');

function buildLongText(tag: string, length: number): string {
  const head = `[${tag}:HEAD] Полный длинный текст UTF-8 / Complete UTF-8 prose (${length} chars).\n`;
  const tail = `\n[${tag}:TAIL] Конец проверенного текста / End of verified prose.`;
  const line = 'Раздел проверки: подробные выводы ревью, команды и результаты без усечения / Detailed review section.\n';
  const middleLen = length - head.length - tail.length;
  const middle = line.repeat(Math.ceil(middleLen / line.length)).slice(0, middleLen);
  const out = `${head}${middle}${tail}`;
  if (out.length !== length) throw new Error(`Expected ${length}, got ${out.length}`);
  return out;
}

type ScenarioBoot = {
  taskId: string;
  taskNumber: number;
  choiceRequestId: string;
  pickTaskId: string;
  pickTaskNumber: number;
  pickRequestId: string;
  verdictFileId: string;
  verdictSha256: string;
};

type RealServerBoot = {
  origin: string;
  ceoSession: string;
  ceoId: string;
  devMemberSession: string;
  opsMemberSession: string;
  stop: () => Promise<void>;
};

const REAL_SERVER_SCRIPT = `
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { buildApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { hashToken } from './src/crypto/tokens.js';
import { applyMissingMigrations, MIGRATIONS } from './src/db/client.js';
import * as schema from './src/db/schema.js';
import { setupCode } from './src/modules/setup/code.js';
import { ask, createTask, submit, verdict } from './src/modules/tasks/engine.js';
import { testPort } from '../../test-support/ports.mjs';

const secret = Buffer.alloc(32, 9).toString('base64');
const base = 'a'.repeat(40);
const commit = 'b'.repeat(40);
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
  readCompare: async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['docs/report.md'], diff: '@@ -1 +1 @@\\n-old\\n+new' }),
});

let fx = null;

app.post('/__e2e/scenario', async req => {
  const body = req.body;
  await db.update(schema.requests).set({ status: 'cancelled' }).where(eq(schema.requests.status, 'open'));

  const mainTask = (await createTask(app.ctx, { agentId: fx.head.id }, {
    title: body.lang === 'ru' ? 'Полный отчет и выбор макета хода' : 'Full report and turn layout choice',
    brief: body.lang === 'ru' ? 'Проверка полного чтения 12000+ символов и отправки отзыва.' : 'Verify 12,000+ char full report reading and feedback submission.',
    body: '',
    departmentId: fx.dev.id,
    assigneeAgentId: fx.worker.id,
    executor: true,
    reviewerAgentId: fx.reviewer.id,
    paths: ['docs/report.md'],
    small: true,
    riskClass: 'none',
  })).task;

  const checklistBytes = Buffer.from('1. Check RU/EN\\n2. Check light/dark\\n3. Check 1440/375\\n', 'utf8');
  await db.insert(schema.attachments).values({
    companyId: fx.acme.id,
    taskId: mainTask.id,
    agentId: fx.worker.id,
    name: 'audit-checklist.txt',
    mediaType: 'text/plain',
    bytes: checklistBytes,
    size: checklistBytes.length,
  });

  await submit(app.ctx, fx.worker.id, mainTask.id, {
    summary: body.submitSummary,
    evidence: body.submitEvidence,
    review: { baseCommit: base },
  });
  await verdict(app.ctx, fx.reviewer.id, mainTask.id, {
    pass: false,
    comment: body.verdictComment,
    reviewedCommit: commit,
    findings: 1,
  });

  /* A failing verdict keeps the work with Review, which repairs it itself, so the one who holds it asks. */
  const choiceReq = (await ask(app.ctx, fx.reviewer.id, mainTask.id, {
    kind: 'choice',
    topic: body.withPickTask ? 'people' : 'task',
    text: body.lang === 'ru'
      ? 'Какой вариант отображения длинного отчета и файлов задачи удобнее?'
      : 'Which layout for reading long reports and task files works better?',
    options: [
      {
        label: body.lang === 'ru'
          ? 'Вариант А: раскрытие текста в журнале и список файлов задачи'
          : 'Option A: inline expansion in the log plus task files list',
        image: null,
      },
      {
        label: body.lang === 'ru'
          ? 'Вариант Б: отдельная вкладка вложений'
          : 'Option B: separate attachments tab',
        image: null,
      },
    ],
  })).request;

  let pickTaskId = '';
  let pickTaskNumber = 0;
  let pickRequestId = '';
  if (body.withPickTask) {
    const pickTask = (await createTask(app.ctx, { personId: fx.ceo.id }, {
      title: 'Explicit option pick with long comment',
      brief: '',
      body: '',
      departmentId: fx.dev.id,
      assigneeAgentId: fx.designer.id,
      executor: true,
      paths: ['docs/report.md'],
      small: true,
    })).task;
    const pickReq = (await ask(app.ctx, fx.designer.id, pickTask.id, {
      kind: 'choice',
      topic: 'task',
      text: 'Which spacing step should we keep?',
      options: [
        { label: 'Option A: 8px step', image: null },
        { label: 'Option B: 12px step', image: null },
      ],
    })).request;
    pickTaskId = pickTask.id;
    pickTaskNumber = pickTask.number;
    pickRequestId = pickReq.id;
  }

  const verdictEvents = await db.select().from(schema.taskEvents).where(and(eq(schema.taskEvents.taskId, mainTask.id), eq(schema.taskEvents.kind, 'verdict')));
  const fullRef = verdictEvents[0].data.fullTexts[0];

  return {
    taskId: mainTask.id,
    taskNumber: mainTask.number,
    choiceRequestId: choiceReq.id,
    pickTaskId,
    pickTaskNumber,
    pickRequestId,
    verdictFileId: fullRef.id,
    verdictSha256: fullRef.sha256,
  };
});

app.get('/__e2e/request/:id', async req => {
  const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id));
  return { request: row };
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
const ceoSession = setupRes.cookies.find(c => c.name === 'hh_session')?.value;
if (!ceoSession) throw new Error('Setup failed: ' + setupRes.statusCode + ' ' + setupRes.body);

const [acme] = await db.select().from(schema.companies);
const [ceo] = await db.select().from(schema.people);
const [sub] = await db.select().from(schema.subscriptions);
const [dev] = await db.insert(schema.departments).values({ companyId: acme.id, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
const [ops] = await db.insert(schema.departments).values({ companyId: acme.id, templateKey: 'operations', roleCode: 'OPS' }).returning();

async function makePersonSession(name, email, deptId) {
  const [person] = await db.insert(schema.people).values({
    companyId: acme.id,
    name,
    email,
    title: 'Engineer',
    status: 'active',
    scopeKind: 'listed',
  }).returning();
  await db.insert(schema.personAccess).values({ companyId: acme.id, personId: person.id, departmentId: deptId });
  const token = 'sess-' + email + '-0123456789abcdef';
  await db.insert(schema.sessions).values({
    tokenHash: hashToken(token),
    personId: person.id,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return token;
}

const devMemberSession = await makePersonSession('Daria', 'daria@acme.com', dev.id);
const opsMemberSession = await makePersonSession('Oleg', 'oleg@acme.com', ops.id);
const [daria] = await db.select().from(schema.people).where(eq(schema.people.email, 'daria@acme.com'));
await db.update(schema.subscriptions).set({ ownerPersonId: daria.id }).where(eq(schema.subscriptions.id, sub.id));

const hire = async (name, kind, roleKey) => {
  const [agent] = await db.insert(schema.agents).values({
    companyId: acme.id,
    departmentId: dev.id,
    subscriptionId: sub.id,
    kind,
    name,
    roleKey,
    /* A known model with the abilities of its role, so the required route can hand the work to a checker. */
    model: 'claude-opus-5-5',
    skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(skill => skill.on).map(skill => skill.id) ?? [],
  }).returning();
  return agent;
};

const head = await hire('Hana', 'head', 'DEV-HEAD');
const worker = await hire('Bruno', 'worker', 'DEV-BE');
const reviewer = await hire('Rita', 'worker', 'DEV-REV');
const designer = await hire('Interface Designer', 'worker', 'DEV-FE');
/* No turn is laid out: the team sets the route, so the work of these members goes through the echelons, and the department's
   open turn opens by itself as a result is accepted into it. */
fx = { acme, ceo, dev, head, worker, reviewer, designer };

const origin = await app.listen({ host: '127.0.0.1', port: await testPort() });
process.stdout.write(JSON.stringify({
  origin,
  ceoSession,
  ceoId: ceo.id,
  devMemberSession,
  opsMemberSession,
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

async function startRealServer(publicUrl: string, webDist: string): Promise<RealServerBoot> {
  return startServer<Omit<RealServerBoot, 'stop'>>(REAL_SERVER_SCRIPT, { cwd: SERVER_CWD, publicUrl, invalidBoot: 'Invalid server boot line', env: { HH_WEB_DIST: webDist } });
}

async function createScenario(
  origin: string,
  webOrigin: string,
  lang: 'en' | 'ru',
  texts: { submitSummary: string; submitEvidence: string; verdictComment: string },
  withPickTask = false,
): Promise<ScenarioBoot> {
  const res = await fetch(`${origin}/__e2e/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: webOrigin },
    body: JSON.stringify({ lang, ...texts, withPickTask }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ScenarioBoot;
}

async function proxyRealApi(page: Page, serverOrigin: string, intercept?: (url: URL, method: string) => { status: number; body: unknown } | null) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/stream') {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
      return;
    }
    const mocked = intercept?.(url, route.request().method()) ?? null;
    if (mocked) {
      await route.fulfill({ status: mocked.status, json: mocked.body });
      return;
    }
    const response = await route.fetch({ url: `${serverOrigin}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

test.describe.configure({ mode: 'serial' });

let srv: RealServerBoot;
let webDist: string | undefined;

test.beforeAll(async () => {
  /* Server startup waits for the readiness line rather than the clock; 0 disables Playwright's 30 s hook timeout. */
  test.setTimeout(0);
  /* The server has a page of its own to name at /api/build, so the page's asks for it are answered, not logged as 404 (#1923). */
  const folder = (webDist = pageFolder('hh-feedback-web-'));
  srv = await startRealServer(`http://localhost:${process.env.HORNHOOF_BROWSER_PORT ?? '4179'}`, folder);
});

/* The page still asks the server while a test ends, and what it asked then has no test left to answer. It leaves the app
   first, so it asks nothing more. */
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test.afterAll(async () => {
  await srv?.stop();
  if (webDist) rmSync(webDist, { recursive: true, force: true });
});

const LANGUAGES = ['ru', 'en'] as const;
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [1440, 375] as const;

for (const lang of LANGUAGES) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`sends 12,000-char feedback and reads full 12,000-char verdict and files on real server (${lang}, ${theme}, ${width}px)`, async ({ page, baseURL }) => {
        test.setTimeout(0);
        const webOrigin = baseURL ?? 'http://localhost:4179';
        const t = MESSAGES[lang];

        const submitSummary = buildLongText(`SUBMIT-SUMMARY-${lang.toUpperCase()}`, 12_100);
        const submitEvidence = buildLongText(`SUBMIT-EVIDENCE-${lang.toUpperCase()}`, 12_200);
        const verdictComment = buildLongText(`VERDICT-COMMENT-${lang.toUpperCase()}`, 12_400);
        const feedback12k = buildLongText(`CHOICE-FEEDBACK-${lang.toUpperCase()}`, 12_000);

        const sc = await createScenario(srv.origin, webOrigin, lang, { submitSummary, submitEvidence, verdictComment });

        await page.setViewportSize({ width, height: 960 });
        await page.addInitScript(
          ({ l, th }) => {
            localStorage.setItem('hh-lang', l);
            localStorage.setItem('hh-theme', th);
          },
          { l: lang, th: theme },
        );
        await page.context().addCookies([{ name: 'hh_session', value: srv.ceoSession, url: webOrigin }]);

        const errors: string[] = [];
        page.on('pageerror', err => errors.push(err.message));
        page.on('console', msg => {
          if (msg.type() === 'error') errors.push(msg.text());
        });
        page.on('response', res => {
          if (res.status() === 404) errors.push(`404: ${res.url()}`);
        });

        await proxyRealApi(page, srv.origin);
        await page.goto('/tasks');

        const card = page.locator('.waiting').getByRole('article', { name: new RegExp(`^#${sc.taskNumber} `) });
        await expect(card).toBeVisible();

        const noteField = card.getByLabel(t.tasks.choiceNote);
        await noteField.fill(feedback12k);
        expect((await noteField.inputValue()).length).toBe(12_000);

        await card.getByRole('button', { name: t.tasks.sendFeedback, exact: true }).click();
        await expect(card).toBeHidden();

        /* Open the task in TaskPanel to read full 12,000-char inline feedback, files, and full 12,400-char verdict. */
        await openTaskCard(page, sc.taskNumber);
        const panel = page.locator('aside');
        await expect(panel).toBeVisible();

        /* The card's materials show clean plain-words filenames without 64-char sha256 noise. */
        const filesRegion = panel.getByRole('region', { name: t.tracker.card.materials });
        await expect(filesRegion).toBeVisible();
        for (const name of ['verdict-text.txt', 'submitted-text.txt', 'submitted-evidence.txt', 'audit-checklist.txt']) {
          await expect(filesRegion.getByRole('link', { name: t.tracker.card.openIt(name) })).toBeVisible();
        }
        await expect(panel).not.toContainText(sc.verdictSha256);
        await expect(panel).not.toContainText('[Full text](/api/attachments/');

        await openTaskAction(panel, t, t.tasks.details);
        /* Full 12,000-character choice feedback is rendered inline without truncation or fake Picked/Approved/Declined prefix. */
        await expect(panel).toContainText(`[CHOICE-FEEDBACK-${lang.toUpperCase()}:HEAD]`);
        await expect(panel).toContainText(`[CHOICE-FEEDBACK-${lang.toUpperCase()}:TAIL]`);
        await expect(panel).not.toContainText(/Picked \d|Approved|Declined/);

        await openTaskAction(panel, t, t.tasks.fullLog);
        /* Expand the 12,400-char verdict via real GET /api/attachments/:id and verify head + tail in the browser. */
        const verdictEntry = panel.locator('ol.tp-log > li.verdict');
        await expect(verdictEntry).toContainText(`[VERDICT-COMMENT-${lang.toUpperCase()}:HEAD]`);
        await expect(verdictEntry).not.toContainText(`[VERDICT-COMMENT-${lang.toUpperCase()}:TAIL]`);

        if (SCREENSHOT_DIR) {
          mkdirSync(SCREENSHOT_DIR, { recursive: true });
          await verdictEntry.scrollIntoViewIfNeeded();
        }

        await verdictEntry.getByRole('button', { name: t.tasks.readFull }).click();
        await expect(verdictEntry.getByRole('button', { name: t.tasks.showLess })).toHaveAttribute('aria-expanded', 'true');
        await expect(verdictEntry).toContainText(`[VERDICT-COMMENT-${lang.toUpperCase()}:TAIL]`);

        /* Verify zero horizontal overflow on both the document and TaskPanel aside across 1440px and 375px. */
        const overflow = await page.evaluate(() => {
          const aside = document.querySelector('aside');
          return {
            docOverflow: document.documentElement.scrollWidth - window.innerWidth,
            asideOverflow: aside ? aside.scrollWidth - aside.clientWidth : 0,
          };
        });
        expect(overflow.docOverflow).toBeLessThanOrEqual(0);
        expect(overflow.asideOverflow).toBeLessThanOrEqual(0);

        if (SCREENSHOT_DIR) {
          await verdictEntry.locator('.req-actions').scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${SCREENSHOT_DIR}/long-log-controls-${lang}-${theme}-${width}.png`,
            fullPage: false,
          });
          await filesRegion.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${SCREENSHOT_DIR}/long-feedback-report-${lang}-${theme}-${width}.png`,
            fullPage: false,
          });
        }

        expect(errors).toEqual([]);
      });
    }
  }
}

test('preserves 12,000-char input on refusal, supports pick: 0 + 12k comment and 12k task comment, and enforces canAnswer and attachment reachability on real server', async ({ page, baseURL }) => {
  test.setTimeout(0);
  const webOrigin = baseURL ?? 'http://localhost:4179';

  const submitSummary = buildLongText('EDGE-SUMMARY', 12_050);
  const submitEvidence = buildLongText('EDGE-EVIDENCE', 12_150);
  const verdictComment = buildLongText('EDGE-VERDICT', 12_300);
  const freeFeedback12k = buildLongText('EDGE-FREE-CHOICE', 12_000);
  const pickComment12k = buildLongText('EDGE-PICK0-COMMENT', 12_000);
  const taskComment12k = buildLongText('EDGE-TASK-COMMENT', 12_000);

  const sc = await createScenario(srv.origin, webOrigin, 'ru', { submitSummary, submitEvidence, verdictComment }, true);

  /* 1. Direct attachment verification: CEO gets UTF-8 bytes matching sha256; Ops member without task reach gets 404. */
  const ceoFileRes = await fetch(`${srv.origin}/api/attachments/${sc.verdictFileId}`, {
    headers: { cookie: `hh_session=${srv.ceoSession}` },
  });
  expect(ceoFileRes.status).toBe(200);
  expect(ceoFileRes.headers.get('content-type')).toContain('text/plain');
  expect(ceoFileRes.headers.get('content-type')).toContain('charset=utf-8');
  expect(ceoFileRes.headers.get('x-content-type-options')).toBe('nosniff');
  expect(ceoFileRes.headers.get('content-security-policy')).toBe("default-src 'none'");
  const ceoBytes = Buffer.from(await ceoFileRes.arrayBuffer());
  expect(ceoBytes.toString('utf8')).toBe(verdictComment);
  expect(sha256(ceoBytes)).toBe(sc.verdictSha256);

  const opsFileRes = await fetch(`${srv.origin}/api/attachments/${sc.verdictFileId}`, {
    headers: { cookie: `hh_session=${srv.opsMemberSession}` },
  });
  expect(opsFileRes.status).toBe(404);

  /* 2. Non-CEO Development member sees read-only choice (canAnswer: false) and server rejects POST with 403. */
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    localStorage.setItem('hh-lang', 'ru');
    localStorage.setItem('hh-theme', 'dark');
  });
  await page.context().addCookies([{ name: 'hh_session', value: srv.devMemberSession, url: webOrigin }]);

  let failFirstChoicePost = true;
  await proxyRealApi(page, srv.origin, (url, method) => {
    if (method === 'POST' && url.pathname === `/api/requests/${sc.choiceRequestId}` && failFirstChoicePost) {
      failFirstChoicePost = false;
      return {
        status: 413,
        body: { error: { code: 'validation', reason: 'attachment_invalid', message: 'The text is too large to send in one request.' } },
      };
    }
    return null;
  });

  await page.goto('/tasks');
  const readOnlyCard = page.locator('.waiting').getByRole('article', { name: new RegExp(`^#${sc.taskNumber} `) });
  await expect(readOnlyCard).toBeVisible();
  await expect(readOnlyCard).toContainText(ru.tasks.decidedByCeo);
  await expect(readOnlyCard.getByRole('textbox')).toHaveCount(0);
  await expect(readOnlyCard.getByRole('button', { name: ru.tasks.sendFeedback })).toHaveCount(0);

  const devPostRes = await fetch(`${srv.origin}/api/requests/${sc.choiceRequestId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: webOrigin, cookie: `hh_session=${srv.devMemberSession}` },
    body: JSON.stringify({ answer: freeFeedback12k }),
  });
  expect(devPostRes.status).toBe(403);

  /* 3. Switch to CEO session: first POST hits 413 refusal -> keeps request open + preserves all 12,000 chars + plain alert -> retry succeeds. */
  await page.context().addCookies([{ name: 'hh_session', value: srv.ceoSession, url: webOrigin }]);
  await page.reload();

  const freeCard = page.locator('.waiting').getByRole('article', { name: new RegExp(`^#${sc.taskNumber} `) });
  const pickCard = page.locator('.waiting').getByRole('article', { name: new RegExp(`^#${sc.pickTaskNumber} `) });
  await expect(freeCard).toBeVisible();
  await expect(pickCard).toBeVisible();

  const freeNote = freeCard.getByLabel(ru.tasks.choiceNote);
  await freeNote.fill(freeFeedback12k);
  await freeCard.getByRole('button', { name: ru.tasks.sendFeedback, exact: true }).click();

  await expect(freeCard.getByRole('alert')).toHaveText(ru.tasks.textTooLarge);
  await expect(freeCard).toBeVisible();
  expect(await freeNote.inputValue()).toBe(freeFeedback12k);

  /* Retry reaches real server and closes the card with neutral answered/picked:null. */
  await freeCard.getByRole('button', { name: ru.tasks.sendFeedback, exact: true }).click();
  await expect(freeCard).toBeHidden();

  /* 4. Second choice request: explicit pick: 0 alongside a 12,000-character comment. */
  await pickCard.getByLabel(ru.tasks.choiceNote).fill(pickComment12k);
  await pickCard.locator('.req-option').nth(0).click();
  await expect(pickCard).toBeHidden();

  const freeReqState = (await (await fetch(`${srv.origin}/__e2e/request/${sc.choiceRequestId}`)).json()) as {
    request: { status: string; picked: number | null; answer: string | null };
  };
  expect(freeReqState.request).toMatchObject({ status: 'answered', picked: null, answer: freeFeedback12k });

  const pickReqState = (await (await fetch(`${srv.origin}/__e2e/request/${sc.pickRequestId}`)).json()) as {
    request: { status: string; picked: number | null; answer: string | null };
  };
  expect(pickReqState.request).toMatchObject({ status: 'answered', picked: 0, answer: pickComment12k });

  /* 5. Post a 12,000-character task comment in TaskPanel and expand both submit evidence and the new comment. */
  await openTaskCard(page, sc.taskNumber);
  const panel = page.locator('aside');
  await expect(panel).toBeVisible();

  await openTaskAction(panel, ru, ru.tasks.fullLog);
  const subEntry = panel.locator('ol.tp-log > li.submitted');
  await subEntry.getByRole('button', { name: ru.tasks.readFull }).nth(1).click();
  await expect(subEntry).toContainText('[EDGE-EVIDENCE:TAIL]');

  await openTaskAction(panel, ru, ru.tasks.comment);
  const commentField = panel.getByLabel(ru.tasks.comment);
  await commentField.fill(taskComment12k);
  await panel.getByRole('button', { name: ru.tasks.addComment }).click();
  await expect(commentField).toHaveCount(0);
  await openTaskAction(panel, ru, ru.tasks.fullLog);

  const commentEntry = panel.locator('ol.tp-log > li.comment').last();
  await expect(commentEntry).toContainText('[EDGE-TASK-COMMENT:HEAD]');
  await commentEntry.getByRole('button', { name: ru.tasks.readFull }).click();
  await expect(commentEntry).toContainText('[EDGE-TASK-COMMENT:TAIL]');
});
