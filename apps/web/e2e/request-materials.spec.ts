import { taskRoute } from '../test/task-route';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../src/i18n/en';
import { LANGUAGES, type Language } from '../src/i18n/index';
import { ru } from '../src/i18n/ru';
import type { Decisions, Me, Org, TaskDepartments, TaskLine, WaitingRequest } from '../src/types';
import { startServer } from './real-server';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const SHOT_DIR = process.env.HH_E2E_SCREENSHOT_DIR ? resolve(process.env.HH_E2E_SCREENSHOT_DIR) : null;
const SOURCE_SHA = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

const DICTS = { en, ru } as const;
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAADmklEQVR4nO3boU1FQRRFUSrAYRGUQA30H4qgEByCYHg/+cPmrGSJkUfcLefh4f0DqDq/ALjs/ALgsq/X49MzkCBgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhtwZ8/hMG/C8ChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAh7K4BAwcJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIuzXgl9c3/pTfXsDxwXwj4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm4TsDTBFwn4GkCrhPwNAHXCXiagOsEPE3AdQKeJuA6AU8TcJ2Apwm47q4BAwcJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCE/RAw0HN+AXDZ+QXAVZ86F6WhE4pguwAAAABJRU5ErkJggg==',
  'base64',
);
const ALT_PREVIEW_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAChUlEQVR4nO3boRECURQEQSLAYRGEcDEQMZERAhKD4qj/bqiu6gDWjNzT87EBUafxBcDXBAxh74DPlyuQIGAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGF7Ax4/YcCfETCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGFLAwYGCRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCNsb8G27Az8kYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAhbGjAwSMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQ5M8CxCBjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjClgYMDBIwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhzgxwLAKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGsKUBA4MEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmDMDHIuAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMKWBgwMEjCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCPsQMJAjYAgTMIS9ACDWIaizQwNAAAAAAElFTkSuQmCC',
  'base64',
);

const ME_CEO: Me = {
  person: { id: 'p-ceo', companyId: 'c1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', scopeKind: 'company', isOwner: true },
  company: { id: 'c1', name: 'Acme' },
};

const ORG_FIXTURE: Org = {
  company: { id: 'c1', name: 'Acme' },
  orchestrator: {
    id: 'a-orch',
    name: 'Orchestrator',
    model: 'claude-opus-5-5',
    effort: null,
    subscription: {
      id: 's1',
      provider: 'anthropic_api',
      kind: 'api_key',
      label: 'Orchestrator',
      status: 'ready',
      online: true,
      last4: '9f3a',
      owner: { id: 'p-ceo', name: 'Ivan' },
      place: { kind: 'company', id: null, name: 'Whole company' },
      machines: [],
      limits: null,
      budget: null,
      isOrchestrator: true,
      accounts: [],
      tier: null,
      accountsDiffer: false,
      signedInOnce: false,
      leaseMachine: null,
    },
    context: null,
    program: null,
    alarm: null,
    retry: null,
    failure: null,
  },
  agents: { total: 2, working: 1 },
  people: [{ id: 'p-ceo', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: { whole: true, departments: [], teams: [] } }],
  departments: [
    {
      id: 'd-dsn',
      name: 'Design',
      templateKey: 'design',
      roleCode: 'DSN',
      about: '',
      agents: { total: 1, working: 1 },
      products: [],
      teams: [],
      people: [],
      employees: [
        {
          id: 'a-dsn',
          name: 'Head of Design',
          roleId: 'DSN-HEAD',
          title: { en: 'Head of Design', ru: 'Руководитель дизайна' },
          kind: 'head',
          model: 'claude-opus-5-5',
          modelName: 'Claude Opus 5.5',
          provider: 'claude',
          effort: null,
          state: 'working',
          status: 'working',
          on: true,
          timer: null,
          task: { echelons: taskRoute(), id: 't508', number: 508, title: 'Question materials' },
          context: null,
          program: null,
          alarm: null,
          retry: null,
          failure: null,
        },
      ],
      roles: [],
    },
  ],
};
/* The departments whose tasks the CEO reads, as the server gives them for the Tasks screen. */
const TASK_DEPARTMENTS: TaskDepartments = { whole: true, departments: ORG_FIXTURE.departments.map(d => ({ id: d.id, name: d.name, templateKey: d.templateKey, mine: true })) };

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

async function selectExtremeLocales(page: Page): Promise<Language[]> {
  const registered = LANGUAGES.map(l => l.id);
  const samples = Object.fromEntries(registered.map(code => [code, collectStrings(DICTS[code]).join(' ')]));
  const ranked = await page.evaluate(async (byLang: Record<string, string>) => {
    await document.fonts.ready;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = '400 14px Onest, sans-serif';
    return Object.entries(byLang)
      .map(([code, text]) => ({ code, width: ctx.measureText(text).width }))
      .sort((a, b) => a.width - b.width)
      .map(entry => entry.code);
  }, samples);
  const shortest = (ranked[0] ?? 'en') as Language;
  const longest = (ranked.at(-1) ?? 'ru') as Language;
  return shortest === longest ? [shortest] : [shortest, longest];
}

const EMIT_SHOTS = new Set<string>();

async function saveShot(page: Page, info: TestInfo, name: string, emitToLog = false) {
  const bytes = await page.screenshot();
  await info.attach(name, { body: bytes, contentType: 'image/png' });
  if (SHOT_DIR) {
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(resolve(SHOT_DIR, name), bytes);
  }
  if (emitToLog && process.env.HH_EMIT_SCREENSHOTS === '1' && !EMIT_SHOTS.has(name)) {
    EMIT_SHOTS.add(name);
    const sha = createHash('sha256').update(bytes).digest('hex');
    process.stdout.write(`HH_SHOT ${name} ${sha} ${bytes.toString('base64')}\n`);
  }
}

async function mountFixtureRoutes(page: Page) {
  const reqId = '11111111-1111-4111-8111-111111111111';
  const mdId = '22222222-2222-4222-8222-222222222222';
  const pdfId = '33333333-3333-4333-8333-333333333333';
  const deniedId = '44444444-4444-4444-8444-444444444444';
  const linkId = '55555555-5555-4555-8555-555555555555';

  const legacyChoice: WaitingRequest = {
    id: 'req-legacy-478',
    kind: 'choice',
    text: 'Technical layout details for panel action placement.',
    explained: 'Compare the two panel layouts and choose which one ships.',
    explaining: false,
    commit: null,
    commitUrl: null,
    images: ['att-common'],
    link: 'https://preview.acme.example/tasks/478',
    options: [
      { label: 'Columns: tasks show at once, wider panel', image: 'att-a' },
      { label: 'List: single column with bottom action group', image: 'att-b' },
    ],
    at: '2026-11-06T01:00:00.000Z',
    agent: { id: 'a-dsn', name: 'Head of Design' },
    task: { id: 't478', number: 478, title: 'Panel action layout', department: { id: 'd-dsn', name: 'Design' } },
    ownerPersonId: 'p-ceo',
    canAnswer: true,
  };

  const manifestQuestion = {
    id: reqId,
    kind: 'question' as const,
    text: 'Review the audit summary and attached report.',
    explained: 'Read the full summary and report before sending your answer.',
    explaining: false,
    commit: null,
    commitUrl: null,
    images: [],
    link: null,
    options: [],
    materialRevision: 1,
    at: '2026-11-06T01:05:00.000Z',
    agent: { id: 'a-dsn', name: 'Head of Design' },
    task: { echelons: taskRoute(), id: 't508', number: 508, title: 'Question materials review', department: { id: 'd-dsn', name: 'Design' } },
    ownerPersonId: 'p-ceo',
    canAnswer: true,
  } as unknown as WaitingRequest;

  const tasks: TaskLine[] = [
    {
      echelons: taskRoute('development', 'a-dsn'),
      id: 't478',
      number: 478,
      title: 'Panel action layout',
      brief: 'Compare panel layouts.',
      status: 'waiting',
      department: { id: 'd-dsn', name: 'Design' },
      product: null,
      assignee: { id: 'a-dsn', name: 'Head of Design', kind: 'head', role: { en: 'Head of Design', ru: 'Руководитель дизайна' } },
      turn: 8,
      parentId: null,
      waitsFor: [],
      createdAt: '2026-11-06T00:50:00.000Z',
      updatedAt: '2026-11-06T01:00:00.000Z',
    },
  ];

  const posts: { url: string; body: unknown }[] = [];
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST') {
      posts.push({ url: url.pathname, body: req.postDataJSON() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    /* A set-up company, as a server says: the app takes no other answer for it. */
    if (url.pathname === '/api/setup') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ needed: false }) });
      return;
    }
    if (url.pathname === '/api/me') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME_CEO) });
      return;
    }
    if (url.pathname === '/api/org') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ORG_FIXTURE) });
      return;
    }
    if (url.pathname === '/api/task-departments') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TASK_DEPARTMENTS) });
      return;
    }
    if (url.pathname === '/api/tasks') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tasks) });
      return;
    }
    if (url.pathname === '/api/requests') {
      const payload: Decisions = {
        requests: [legacyChoice, manifestQuestion],
        proposals: [],
        machineAccess: [],
        counts: { byPerson: { 'p-ceo': 2 }, byAgent: { 'a-dsn': 2 }, total: 2 },
      };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      return;
    }
    if (url.pathname.startsWith('/api/attachments/')) {
      const body = url.pathname.endsWith('/att-b') ? ALT_PREVIEW_PNG : ONE_PIXEL_PNG;
      await route.fulfill({ status: 200, contentType: 'image/png', body });
      return;
    }
    if (url.pathname === `/api/requests/${reqId}/materials`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          materialRevision: 1,
          materialDigest: 'a'.repeat(64),
          common: [
            {
              id: mdId,
              name: 'What we compare and why.md',
              kind: 'document',
              format: 'markdown',
              state: 'available',
              contentUrl: `/api/requests/${reqId}/materials/${mdId}/content`,
              downloadUrl: `/api/requests/${reqId}/materials/${mdId}/download`,
              size: 1024,
              sha256: 'b'.repeat(64),
              mediaType: 'text/markdown',
            },
            {
              id: pdfId,
              name: 'Corrupted scan.pdf',
              kind: 'document',
              format: 'pdf',
              state: 'available',
              contentUrl: `/api/requests/${reqId}/materials/${pdfId}/content`,
              downloadUrl: `/api/requests/${reqId}/materials/${pdfId}/download`,
              size: 2048,
              sha256: 'c'.repeat(64),
              mediaType: 'application/pdf',
            },
            { id: deniedId, name: 'Restricted finance note.pdf', kind: 'document', format: 'pdf', state: 'denied' },
            { id: linkId, name: 'Staging result', kind: 'link', state: 'available', url: 'https://staging.acme.example/tasks/508' },
          ],
          options: [],
        }),
      });
      return;
    }
    if (url.pathname === `/api/requests/${reqId}/materials/${mdId}/content`) {
      const md = '## Comparison Notes\n\nEvery line wraps cleanly without sideways scroll.\n\n- Option 1 keeps columns.\n- Option 2 stacks entries.\n\nEND_OF_NOTES';
      await route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: md });
      return;
    }
    if (url.pathname === `/api/requests/${reqId}/materials/${pdfId}/content`) {
      await route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from([0x00, 0x01, 0x02]) });
      return;
    }
    if (url.pathname === '/api/stream') {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return posts;
}

test('renders materials list and fullscreen viewer across dynamic shipped locales, 375/1440 widths, and light/dark themes without sideways scroll or accidental answers', async ({ page }, info) => {
  test.setTimeout(0);
  await page.goto('about:blank');
  const locales = await selectExtremeLocales(page);
  const posts = await mountFixtureRoutes(page);

  for (const lang of locales) {
    const t = DICTS[lang];
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [375, 1440] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(
          ([l, th]) => {
            localStorage.setItem('hh-lang', l);
            localStorage.setItem('hh-theme', th);
          },
          [lang, theme] as const,
        );
        await page.goto('/tasks');
        await page.evaluate(() => document.fonts.ready);

        const choiceCard = page.getByRole('article', { name: /#478 / });
        await expect(choiceCard).toBeVisible();
        const scrollOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(scrollOverflow, `list overflow at ${lang} ${theme} ${width}`).toBeLessThanOrEqual(1);
        const termBox = await choiceCard.locator('button.req-term').boundingBox();
        expect(termBox?.height ?? 0, `req-term >= 44px at ${lang} ${theme} ${width}`).toBeGreaterThanOrEqual(43.5);
        const pickBox = await choiceCard.locator('ol.opts .entry-actions button').first().boundingBox();
        expect(pickBox?.height ?? 0, `choose option >= 44px at ${lang} ${theme} ${width}`).toBeGreaterThanOrEqual(43.5);
        const emitKey =
          (lang === 'ru' && theme === 'dark' && (width === 375 || width === 1440)) ||
          (lang === 'en' && theme === 'light' && (width === 375 || width === 1440));
        await saveShot(page, info, `materials-list-${lang}-${theme}-${width}-${SOURCE_SHA.slice(0, 8)}.png`, emitKey);

        /* Open option 1 image in fullscreen viewer and verify zero answer posts. */
        const opt1Pic = choiceCard.locator('ol.opts button.mat.mat-large').first();
        await opt1Pic.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        const viewerOverflow = await page.evaluate(() => {
          const mv = document.querySelector<HTMLElement>('.mv')!;
          return mv.scrollWidth - mv.clientWidth;
        });
        expect(viewerOverflow, `viewer overflow at ${lang} ${theme} ${width}`).toBeLessThanOrEqual(1);
        const emitViewer = (lang === 'ru' && theme === 'dark' && width === 375) || (lang === 'en' && theme === 'light' && width === 1440);
        await saveShot(page, info, `materials-viewer-${lang}-${theme}-${width}-${SOURCE_SHA.slice(0, 8)}.png`, emitViewer);

        await dialog.getByRole('button', { name: t.tasks.materials.close }).click();
        await expect(dialog).toBeHidden();
        expect(posts).toEqual([]);

        if (lang === 'ru' && theme === 'dark' && width === 1440) {
          const ordinaryCard = page.getByRole('article', { name: /#508 / });
          await ordinaryCard.scrollIntoViewIfNeeded();
          await expect(ordinaryCard).toBeVisible();
          await saveShot(page, info, `ordinary-question-read-states-ru-dark-1440-${SOURCE_SHA.slice(0, 8)}.png`, true);
          await ordinaryCard.getByRole('button', { name: /What we compare and why\.md/ }).click();
          const mdDialog = page.getByRole('dialog');
          await expect(mdDialog).toBeVisible();
          await expect(mdDialog).toContainText('END_OF_NOTES');
          await saveShot(page, info, `viewer-markdown-doc-ru-dark-1440-${SOURCE_SHA.slice(0, 8)}.png`, true);
          await mdDialog.getByRole('button', { name: t.tasks.materials.close }).click();
          await expect(mdDialog).toBeHidden();
        }
        if (lang === 'en' && theme === 'dark' && width === 375) {
          await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
          await opt1Pic.click();
          await expect(dialog).toBeVisible();
          const rtlOverflow = await page.evaluate(() => {
            const mv = document.querySelector<HTMLElement>('.mv')!;
            return mv.scrollWidth - mv.clientWidth;
          });
          expect(rtlOverflow, 'RTL viewer overflow at 375').toBeLessThanOrEqual(1);
          await saveShot(page, info, `materials-viewer-rtl-en-dark-375-${SOURCE_SHA.slice(0, 8)}.png`, true);
          await dialog.getByRole('button', { name: t.tasks.materials.close }).click();
          await expect(dialog).toBeHidden();
          await page.evaluate(() => document.documentElement.removeAttribute('dir'));
        }
      }
    }
  }
});

type RealServerBoot = {
  origin: string;
  session: string;
  legacyTaskNumber: number;
  legacyRequestId: string;
  freeTaskNumber: number;
  freeRequestId: string;
  stop: () => Promise<void>;
};

const REAL_SERVER_SCRIPT = `
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { buildApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { applyMissingMigrations, MIGRATIONS } from './src/db/client.js';
import * as schema from './src/db/schema.js';
import { setupCode } from './src/modules/setup/code.js';
import { ask, createTask } from './src/modules/tasks/engine.js';
import { testPort } from '../../test-support/ports.mjs';

const secret = Buffer.alloc(32, 9).toString('base64');
const commit = 'a'.repeat(40);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAChUlEQVR4nO3boRECURQEQSLAYRGEcDEQMZERAhKD4qj/bqiu6gDWjNzT87EBUafxBcDXBAxh74DPlyuQIGAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGF7Ax4/YcCfETCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGFLAwYGCRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCNsb8G27Az8kYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAhbGjAwSMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQ5M8CxCBjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjClgYMDBIwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhzgxwLAKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGsKUBA4MEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmDMDHIuAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMKWBgwMEjCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCPsQMJAjYAgTMIS9ACDWIaizQwNAAAAAAElFTkSuQmCC', 'base64');
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

let ids = { legacyRequestId: '', freeRequestId: '' };
app.get('/__e2e/state', async () => {
  const [legacyRequest] = await db.select().from(schema.requests).where(eq(schema.requests.id, ids.legacyRequestId));
  const [freeRequest] = await db.select().from(schema.requests).where(eq(schema.requests.id, ids.freeRequestId));
  return { legacyRequest, freeRequest };
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
if (!session) throw new Error('Setup failed');

const [acme] = await db.select().from(schema.companies);
const [ceo] = await db.select().from(schema.people);
const [sub] = await db.select().from(schema.subscriptions);
const [dsn] = await db.insert(schema.departments).values({ companyId: acme.id, templateKey: 'design', roleCode: 'DSN' }).returning();
const [designer] = await db.insert(schema.agents).values({
  companyId: acme.id,
  departmentId: dsn.id,
  subscriptionId: sub.id,
  kind: 'worker',
  name: 'Глава дизайна',
  roleKey: 'DSN-HEAD',
  model: '',
}).returning();

const legacyTask = (await createTask(app.ctx, { personId: ceo.id }, {
  title: 'Выбор края и размера кнопок записи',
  brief: '',
  body: '',
  departmentId: dsn.id,
  assigneeAgentId: designer.id,
  executor: true,
})).task;

const [attA] = await db.insert(schema.attachments).values({
  companyId: acme.id,
  agentId: designer.id,
  mediaType: 'image/png',
  bytes: png,
  size: png.byteLength,
}).returning();
const [attB] = await db.insert(schema.attachments).values({
  companyId: acme.id,
  agentId: designer.id,
  mediaType: 'image/png',
  bytes: png,
  size: png.byteLength,
}).returning();

const legacyReq = (await ask(app.ctx, designer.id, legacyTask.id, {
  kind: 'choice',
  topic: 'task',
  text: 'Сравните два варианта расположения кнопок в панели.',
  options: [
    { label: 'Вариант А: кнопки у начала строки', image: attA.id },
    { label: 'Вариант Б: кнопки у конца строки, от 44 px', image: attB.id },
  ],
})).request;

const freeTask = (await createTask(app.ctx, { personId: ceo.id }, {
  title: 'Варианты без вложений',
  brief: '',
  body: '',
  departmentId: dsn.id,
  assigneeAgentId: designer.id,
  executor: true,
})).task;
const freeReq = (await ask(app.ctx, designer.id, freeTask.id, {
  kind: 'choice',
  topic: 'task',
  text: 'Какой порядок вкладок берем?',
  options: [
    { label: 'Сначала Задачи', image: null },
    { label: 'Сначала Компания', image: null },
  ],
})).request;

ids = { legacyRequestId: legacyReq.id, freeRequestId: freeReq.id };
const origin = await app.listen({ host: '127.0.0.1', port: await testPort() });
process.stdout.write(JSON.stringify({
  origin,
  session,
  legacyTaskNumber: legacyTask.number,
  legacyRequestId: legacyReq.id,
  freeTaskNumber: freeTask.number,
  freeRequestId: freeReq.id,
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
  return startServer<Omit<RealServerBoot, 'stop'>>(REAL_SERVER_SCRIPT, { cwd: resolve(HERE, '../../server'), publicUrl, invalidBoot: 'Invalid boot JSON' });
}

test('separates legacy option.image preview from explicit choice and send-without-choice on a real Fastify + PGlite server', async ({ page, baseURL }, info) => {
  test.setTimeout(0);
  const webOrigin = baseURL ?? 'http://localhost:4179';
  const srv = await startRealServer(webOrigin);
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'ru');
      localStorage.setItem('hh-theme', 'dark');
    });
    await page.context().addCookies([{ name: 'hh_session', value: srv.session, url: webOrigin }]);

    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/stream') return;
      const response = await route.fetch({ url: `${srv.origin}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });

    await page.goto('/tasks');
    const legacyCard = page.locator('.waiting').getByRole('article', { name: new RegExp(`^#${srv.legacyTaskNumber} `) });
    const freeCard = page.locator('.waiting').getByRole('article', { name: new RegExp(`^#${srv.freeTaskNumber} `) });
    await expect(legacyCard).toBeVisible();
    await expect(freeCard).toBeVisible();

    const draft = 'Берем вариант Б, кнопки от 44 px у конца строки';
    await legacyCard.getByLabel(ru.tasks.choiceNote).fill(draft);

    /* Preview option 1 and option 2 images, zoom, and close: real DB request MUST remain open! */
    await legacyCard.locator('ol.opts button.mat.mat-large').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Картинка 1 из 2')).toBeVisible();
    await dialog.getByRole('button', { name: new RegExp(`^${ru.tasks.materials.next}`) }).click();
    await expect(dialog.getByText('Картинка 2 из 2')).toBeVisible();
    await dialog.getByRole('button', { name: ru.tasks.materials.zoomIn }).click();
    await expect(dialog.getByText('×1.5')).toBeVisible();
    await saveShot(page, info, `real-server-legacy-viewer-ru-dark-1440-${SOURCE_SHA.slice(0, 8)}.png`, true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    const beforeAnswer = (await (await fetch(`${srv.origin}/__e2e/state`)).json()) as {
      legacyRequest: { status: string; picked: number | null; answer: string | null };
      freeRequest: { status: string; picked: number | null; answer: string | null };
    };
    expect(beforeAnswer.legacyRequest.status).toBe('open');
    expect(beforeAnswer.legacyRequest.picked).toBeNull();
    await expect(legacyCard.getByLabel(ru.tasks.choiceNote)).toHaveValue(draft);

    /* Explicit Choose option 2 button records picked: 1 with preserved draft. */
    await legacyCard.getByRole('button', { name: ru.tasks.chooseOption(2) }).click();
    await expect(legacyCard).toBeHidden();

    /* Choice without option materials uses .choice-list and Отправить без выбора. */
    expect(await freeCard.locator('.choice-list > button').count()).toBe(2);
    await freeCard.getByLabel(ru.tasks.choiceNote).fill('Нужен третий вариант с закреплением');
    await freeCard.getByRole('button', { name: ru.tasks.sendFeedback, exact: true }).click();
    await expect(freeCard).toBeHidden();

    const afterAnswer = (await (await fetch(`${srv.origin}/__e2e/state`)).json()) as {
      legacyRequest: { status: string; picked: number | null; answer: string | null };
      freeRequest: { status: string; picked: number | null; answer: string | null };
    };
    expect(afterAnswer.legacyRequest).toMatchObject({ status: 'answered', picked: 1, answer: draft });
    expect(afterAnswer.freeRequest).toMatchObject({ status: 'answered', picked: null, answer: 'Нужен третий вариант с закреплением' });
  } finally {
    await srv.stop();
  }
});

function buildTwoPagePdfBuffer(withEncrypt = false): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 7 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 8 0 R >> >> /Contents 5 0 R /Annots [9 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 8 0 R >> >> /Contents 6 0 R >>',
    ...['FIRST PAGE', 'LAST PAGE SENTINEL'].map(text => {
      const body = `BT /F1 16 Tf 24 96 Td (${text}) Tj ET`;
      return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
    }),
    '<< /S /JavaScript /JS (window.__hh_pdf_script_ran=true;fetch("https://forbidden.invalid/");) >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A << /S /URI /URI (https://forbidden.invalid/) >> >>',
  ];
  if (withEncrypt) {
    objects.push('<< /Filter /Standard /V 2 /R 3 /Length 128 /O <' + '00'.repeat(32) + '> /U <' + '11'.repeat(32) + '> /P -4 >>');
  }
  let src = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((body, idx) => {
    offsets.push(Buffer.byteLength(src));
    src += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(src);
  src += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  const encryptRef = withEncrypt ? ` /Encrypt ${objects.length} 0 R` : '';
  src += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(src, 'utf8');
}

test('renders real 2-page PDF via bundled pdfjs-dist without OpenAction or external fetches, handles malformed/encrypted PDFs and revoked content honestly, and verifies 3-option wide layout', async ({ page }, info) => {
  test.setTimeout(0);
  const reqId = '66666666-6666-4666-8666-666666666666';
  const validPdfId = '77777777-7777-4777-8777-777777777777';
  const badPdfId = '88888888-8888-4888-8888-888888888888';
  const encPdfId = '99999999-9999-4999-8999-999999999999';
  const revokedMdId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const opt1Img = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const opt2Img = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const opt3Img = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  const twoPagePdf = buildTwoPagePdfBuffer(false);
  const encryptedPdf = buildTwoPagePdfBuffer(true);
  const propId = 'prop-structure-512';
  const propDocId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const propDigest = 'f'.repeat(64);
  const posts: { url: string; body: unknown }[] = [];
  let externalPdfFetchCount = 0;

  await page.route('https://forbidden.invalid/**', async route => {
    externalPdfFetchCount += 1;
    await route.abort();
  });

  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST') {
      posts.push({ url: url.pathname, body: req.postDataJSON() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    if (url.pathname === '/api/setup') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ needed: false }) });
    if (url.pathname === '/api/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME_CEO) });
    if (url.pathname === '/api/org') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ORG_FIXTURE) });
    if (url.pathname === '/api/task-departments') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TASK_DEPARTMENTS) });
    if (url.pathname === '/api/tasks') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    if (url.pathname === '/api/requests') {
      const payload: Decisions = {
        requests: [{
          id: reqId,
          kind: 'choice',
          text: 'Compare three wide options and inspect attached PDF reports.',
          explained: 'Open the 2-page PDF report and compare the three layout options.',
          explaining: false,
          commit: null,
          commitUrl: null,
          images: [],
          link: null,
          options: [
            { label: 'Option 1: Dense three-column board', image: null },
            { label: 'Option 2: Balanced split view', image: null },
            { label: 'Option 3: Compact stacked list', image: null },
          ],
          materialRevision: 1,
          at: '2026-11-06T01:10:00.000Z',
          agent: { id: 'a-dsn', name: 'Head of Design' },
          task: { id: 't512', number: 512, title: 'Wide 3-option & PDF proof', department: { id: 'd-dsn', name: 'Design' } },
          ownerPersonId: 'p-ceo',
          canAnswer: true,
        } as unknown as WaitingRequest],
        proposals: [{
          id: propId,
          kind: 'structure',
          agent: { id: 'a-orch', name: 'Orchestrator' },
          department: null,
          brief: 'Создать отдел поддержки и финансов.',
          items: [{ template: 'support', checked: true, note: 'Поддержка клиентов.' }],
          materialRevision: 2,
          materialDigest: propDigest,
          at: '2026-11-06T01:12:00.000Z',
          ownerPersonId: 'p-ceo',
          canAnswer: true,
        }],
        machineAccess: [],
        counts: { byPerson: { 'p-ceo': 2 }, byAgent: { 'a-dsn': 1, 'a-orch': 1 }, total: 2 },
      };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    }
    if (url.pathname === `/api/proposals/${propId}/materials`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          materialRevision: 2,
          materialDigest: propDigest,
          common: [{
            id: propDocId,
            name: 'План структуры компании.md',
            kind: 'document',
            format: 'markdown',
            state: 'available',
            contentUrl: `/api/proposals/${propId}/materials/${propDocId}/content`,
            downloadUrl: null,
            size: 196,
            sha256: '9'.repeat(64),
            mediaType: 'text/markdown',
          }],
          options: [],
        }),
      });
    }
    if (url.pathname === `/api/proposals/${propId}/materials/${propDocId}/content`) {
      return route.fulfill({
        status: 200,
        contentType: 'text/markdown; charset=utf-8',
        body: '## План структуры\n\nИсходный документ предложения: отдел поддержки клиентов.\n\nКОНЕЦ_ПЛАНА',
      });
    }
    if (url.pathname === `/api/requests/${reqId}/materials`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          materialRevision: 1,
          materialDigest: 'e'.repeat(64),
          common: [
            { id: validPdfId, name: 'Audit report.pdf', kind: 'document', format: 'pdf', state: 'available', contentUrl: `/api/requests/${reqId}/materials/${validPdfId}/content`, downloadUrl: `/api/requests/${reqId}/materials/${validPdfId}/download`, size: twoPagePdf.byteLength, sha256: '1'.repeat(64), mediaType: 'application/pdf' },
            { id: badPdfId, name: 'Corrupted scan.pdf', kind: 'document', format: 'pdf', state: 'available', contentUrl: `/api/requests/${reqId}/materials/${badPdfId}/content`, downloadUrl: `/api/requests/${reqId}/materials/${badPdfId}/download`, size: 3, sha256: '2'.repeat(64), mediaType: 'application/pdf' },
            { id: encPdfId, name: 'Encrypted contract.pdf', kind: 'document', format: 'pdf', state: 'available', contentUrl: `/api/requests/${reqId}/materials/${encPdfId}/content`, downloadUrl: null, size: encryptedPdf.byteLength, sha256: '3'.repeat(64), mediaType: 'application/pdf' },
            { id: revokedMdId, name: 'Revoked note.md', kind: 'document', format: 'markdown', state: 'available', contentUrl: `/api/requests/${reqId}/materials/${revokedMdId}/content`, downloadUrl: null, size: 128, sha256: '4'.repeat(64), mediaType: 'text/markdown' },
          ],
          options: [
            { id: 'opt-0', materials: [{ id: opt1Img, name: 'Option 1 preview.png', kind: 'image', state: 'available', contentUrl: `/api/requests/${reqId}/materials/${opt1Img}/content`, downloadUrl: null, size: ONE_PIXEL_PNG.byteLength, sha256: '5'.repeat(64), mediaType: 'image/png' }] },
            { id: 'opt-1', materials: [{ id: opt2Img, name: 'Option 2 preview.png', kind: 'image', state: 'available', contentUrl: `/api/requests/${reqId}/materials/${opt2Img}/content`, downloadUrl: null, size: ONE_PIXEL_PNG.byteLength, sha256: '6'.repeat(64), mediaType: 'image/png' }] },
            { id: 'opt-2', materials: [{ id: opt3Img, name: 'Option 3 preview.png', kind: 'image', state: 'available', contentUrl: `/api/requests/${reqId}/materials/${opt3Img}/content`, downloadUrl: null, size: ONE_PIXEL_PNG.byteLength, sha256: '7'.repeat(64), mediaType: 'image/png' }] },
          ],
        }),
      });
    }
    if (url.pathname === `/api/requests/${reqId}/materials/${validPdfId}/content`) {
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: twoPagePdf });
    }
    if (url.pathname === `/api/requests/${reqId}/materials/${badPdfId}/content`) {
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from([0x00, 0x01, 0x02]) });
    }
    if (url.pathname === `/api/requests/${reqId}/materials/${encPdfId}/content`) {
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: encryptedPdf });
    }
    if (url.pathname === `/api/requests/${reqId}/materials/${revokedMdId}/content`) {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden', message: 'Access revoked' } }) });
    }
    if (url.pathname.endsWith('/content')) {
      const body = url.pathname.includes(opt2Img) ? ALT_PREVIEW_PNG : ONE_PIXEL_PNG;
      return route.fulfill({ status: 200, contentType: 'image/png', body });
    }
    if (url.pathname === '/api/stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    localStorage.setItem('hh-lang', 'ru');
    localStorage.setItem('hh-theme', 'dark');
  });
  await page.goto('/tasks');
  await page.evaluate(() => document.fonts.ready);

  const card = page.getByRole('article', { name: /#512 / });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await saveShot(page, info, `wide-3opts-pdf-list-ru-dark-1440-${SOURCE_SHA.slice(0, 8)}.png`, true);

  const draft = 'Сохраняем черновик при чтении PDF и отказе доступа';
  await card.getByLabel(ru.tasks.choiceNote).fill(draft);

  /* 1. Real 2-page PDF in Chromium via local pdfjs-dist legacy worker. */
  await card.getByRole('button', { name: /Audit report\.pdf/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.mv-page')).toHaveCount(2);
  await expect(dialog.locator('.mv-page canvas[data-rendered="true"]')).toHaveCount(2);
  await expect(dialog).toContainText('FIRST PAGE');
  await expect(dialog).toContainText('LAST PAGE SENTINEL');
  const firstCanvasNonEmpty = await dialog.locator('.mv-page canvas').first().evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d');
    if (!ctx || c.width === 0 || c.height === 0) return false;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! > 0 && (data[i]! < 240 || data[i + 1]! < 240 || data[i + 2]! < 240)) return true;
    }
    return false;
  });
  expect(firstCanvasNonEmpty).toBe(true);
  expect(externalPdfFetchCount).toBe(0);
  expect(await page.evaluate(() => (window as { __hh_pdf_script_ran?: boolean }).__hh_pdf_script_ran)).toBeUndefined();
  await saveShot(page, info, `viewer-pdf-2page-ru-dark-1440-${SOURCE_SHA.slice(0, 8)}.png`, true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  /* 2. Malformed PDF honest fallback with download button and zero fake pages. */
  await card.getByRole('button', { name: /Corrupted scan\.pdf/ }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(ru.tasks.materials.pdfUnavailable);
  await expect(dialog.locator('.mv-page')).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: ru.tasks.materials.downloadFile })).toBeVisible();
  await saveShot(page, info, `viewer-no-pdf-fallback-ru-dark-1440-${SOURCE_SHA.slice(0, 8)}.png`, true);
  await page.keyboard.press('Escape');

  /* 3. Encrypted PDF without download right -> honest no-download fallback, zero fake pages. */
  await card.getByRole('button', { name: /Encrypted contract\.pdf/ }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(ru.tasks.materials.pdfUnavailableNoDownload);
  await expect(dialog.locator('.mv-page')).toHaveCount(0);
  await page.keyboard.press('Escape');

  /* 4. Revoked content (403 on /content) -> error inside viewer, draft preserved. */
  await card.getByRole('button', { name: /Revoked note\.md/ }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.getByLabel(ru.tasks.choiceNote)).toHaveValue(draft);

  /* 5. Native stamped structure proposal rendered via Tasks.tsx opens sealed MaterialViewer with zero POSTs, then submits stamp. */
  await page.getByRole('button', { name: /План структуры компании\.md/ }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('КОНЕЦ_ПЛАНА');
  await expect(dialog).toContainText(ru.tasks.materials.proposalNote);
  await expect(dialog.getByRole('button', { name: ru.card.create(1) })).toHaveCount(0);
  await saveShot(page, info, `viewer-native-proposal-ru-dark-1440-${SOURCE_SHA.slice(0, 8)}.png`, true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(posts).toEqual([]);

  await page.getByRole('button', { name: ru.card.create(1) }).click();
  await expect.poll(() => posts).toEqual([{
    url: '/api/departments/build',
    body: {
      proposalId: propId,
      materialRevision: 2,
      materialDigest: propDigest,
      items: [{ template: 'support', note: 'Поддержка клиентов.', staff: true }],
    },
  }]);
});
