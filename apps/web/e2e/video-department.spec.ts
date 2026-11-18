/// <reference types="node" />
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Language } from '../src/i18n';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { routePath } from '../src/routes';
import { startServer } from './real-server';

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGES: Record<Language, Messages> = { en, ru };
const SHOT_DIR = process.env.HH_E2E_SCREENSHOT_DIR ? resolve(process.env.HH_E2E_SCREENSHOT_DIR) : null;
/* The stages of the default route, in their order, as the template lays them out. */
const STAGES = ['Take the brief', 'Write the script and shot list', 'Draw the storyboard', 'Make the character and style sheets', 'Generate draft shots',
  'Check continuity', 'Edit the cut', 'Check quality', 'Make final shots', 'Deliver the video'] as const;

/* A real server set up from the Video studio kit, with no plan yet: what a person sees right after setup. */
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
import { testPort } from '../../test-support/ports.mjs';

const secret = Buffer.alloc(32, 7).toString('base64');
const client = new PGlite();
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: MIGRATIONS });
await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });
const config = loadConfig({ HORNHOOF_SECRET: secret, UPDATE_CHECK_MS: '0', PUBLIC_URL: process.env.HH_PUBLIC_URL ?? 'http://localhost:4179' });
const app = await buildApp({ db, config });
const setup = await app.inject({
  method: 'POST',
  url: '/api/setup',
  payload: {
    code: setupCode(Buffer.from(secret, 'base64')), companyName: 'Acme', name: 'Ivan', email: 'ivan@acme.com',
    password: 'correct horse battery', template: 'video', orchestrator: { mode: 'later' },
  },
});
const session = setup.cookies.find(c => c.name === 'hh_session')?.value;
if (!session) throw new Error('Setup failed: ' + setup.statusCode + ' ' + setup.body);
const [video] = await db.select().from(schema.departments).where(eq(schema.departments.templateKey, 'video_production'));
const origin = await app.listen({ host: '127.0.0.1', port: await testPort() });
process.stdout.write(JSON.stringify({ origin, session, video: video.id }) + '\\n');

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

type Boot = { origin: string; session: string; video: string };
let server: (Boot & { stop: () => Promise<void> }) | null = null;

test.beforeAll(async ({}, info) => {
  const publicUrl = String(info.project.use.baseURL ?? 'http://localhost:4179');
  server = await startServer<Boot>(REAL_SERVER_SCRIPT, { cwd: resolve(HERE, '../../server'), publicUrl, invalidBoot: 'Invalid server boot line' });
});

test.afterAll(async () => {
  await server?.stop();
});

for (const language of ['en', 'ru'] as const) {
  for (const width of [1440, 390]) {
    test(`shows every department of every kit card whole in its scheme at ${width} in ${language}`, async ({ page }, info) => {
      const t = MESSAGES[language];
      const errors: string[] = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(lang => localStorage.setItem('hh-lang', lang), language);
      /* A server that waits for its setup: the cards come from the catalog the page carries. */
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/setup') return route.fulfill({ json: { needed: true } });
        if (url.pathname.startsWith('/api/setup/names/')) return route.fulfill({ json: { name: decodeURIComponent(url.pathname.split('/').at(-1)!), free: true } });
        return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not here.' } } });
      });
      await page.goto('/setup?code=LINK-CODE-123');
      const pick = page.locator('.templates-pick');
      const video = page.getByRole('radio', { name: new RegExp(t.companyTemplates.video.name) });
      await expect(video).toBeVisible();
      await expect(page.locator('svg.scheme')).toHaveCount(11);

      /* Every line of every name lies inside its box: nothing cut, nothing hidden, no ellipsis. */
      const outside = await page.locator('text.scheme-name').evaluateAll(texts => texts.flatMap(text => {
        const box = (text.previousElementSibling as SVGGraphicsElement).getBBox(), own = (text as SVGGraphicsElement).getBBox();
        const name = text.querySelector('title')?.textContent ?? '';
        const style = getComputedStyle(text);
        const fits = own.x >= box.x - 0.5 && own.y >= box.y - 0.5 && own.x + own.width <= box.x + box.width + 0.5 && own.y + own.height <= box.y + box.height + 0.5;
        return fits && !text.textContent!.includes('\u2026') && style.textOverflow !== 'ellipsis' ? [] : [name];
      }));
      expect(outside).toEqual([]);
      const names = await page.locator('text.scheme-name title').allTextContents();
      expect(names).toContain(t.templates.video_production.name);
      /* The cards of a row are as high as each other, and every scheme as high as the others. */
      const cards = await page.locator('.template-card').evaluateAll(all => all.map(card => {
        const r = card.getBoundingClientRect(), scheme = card.querySelector('svg.scheme')!.getBoundingClientRect();
        return { top: Math.round(r.top), height: Math.round(r.height), scheme: Math.round(scheme.height), overflows: card.scrollWidth > card.clientWidth + 1 };
      }));
      for (const card of cards) expect(card.height).toBe(Math.max(...cards.filter(other => other.top === card.top).map(other => other.height)));
      expect(new Set(cards.map(card => card.scheme)).size).toBe(1);
      expect(cards.filter(card => card.overflows)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);

      if (SHOT_DIR) {
        mkdirSync(SHOT_DIR, { recursive: true });
        const file = join(SHOT_DIR, `kit-cards-${info.project.use.browserName}-${language}-${width}.png`);
        /* All the cards at once: the page grows by what its scrolling panels hold below the fold. */
        const hidden = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll<HTMLElement>('*')]
          .filter(el => /auto|scroll/.test(getComputedStyle(el).overflowY)).map(el => el.scrollHeight - el.clientHeight)));
        await page.setViewportSize({ width, height: Math.min(900 + hidden, 12_000) });
        await expect(video).toBeInViewport();
        await pick.screenshot({ path: file });
        await info.attach(`kit-cards-${language}-${width}`, { path: file, contentType: 'image/png' });
      }
    });

    test(`shows the whole Video production department right after setup at ${width} in ${language}`, async ({ page, baseURL }, info) => {
      const t = MESSAGES[language], srv = server!;
      const errors: string[] = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(lang => localStorage.setItem('hh-lang', lang), language);
      await page.context().addCookies([{ name: 'hh_session', value: srv.session, url: baseURL! }]);
      /* Every API call goes to the real server; the live stream stays open and quiet, and the CEO has saved the recovery
         file, so its banner leaves the department's heading in view. */
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/stream') return;
        if (url.pathname === '/api/backups/recovery') return route.fulfill({ json: { recoveryNeeded: false, linkChanged: false } });
        await route.fulfill({ response: await route.fetch({ url: `${srv.origin}${url.pathname}${url.search}` }) });
      });

      await page.goto(routePath({ kind: 'department', id: srv.video }));
      await expect(page.getByRole('heading', { level: 2, name: t.templates.video_production.name })).toBeVisible();
      const structure = page.getByRole('region', { name: t.dept.structure });
      const names = t.pipelineCatalog['video-production'];
      const main = structure.getByRole('region', { name: names.name, exact: true });
      await expect(main).toBeVisible();
      for (const stage of STAGES) await expect(main.getByRole('heading', { name: names.stages[stage], exact: true })).toBeVisible();
      /* A square for the permanent agent at every stage, waiting for a model, and diamonds for the drafts: three calls and the judge. */
      await expect(main.getByRole('img', { name: t.workers.permanent, exact: true })).toHaveCount(STAGES.length);
      await expect(main.getByText(t.dept.noModelYet, { exact: true })).toHaveCount(STAGES.length);
      const draft = main.locator('li').filter({ has: page.getByRole('heading', { name: names.stages['Generate draft shots'], exact: true }) });
      const diamonds = draft.getByRole('img', { name: new RegExp(`^${t.workers.ghost}`) });
      await expect(diamonds).toHaveCount(4);
      await expect(diamonds.last()).toHaveAccessibleName(new RegExp(`${t.workers.judge}`));
      const check = main.locator('li').filter({ has: page.getByRole('heading', { name: names.stages['Check continuity'], exact: true }) });
      await expect(check.getByRole('img', { name: new RegExp(`^${t.workers.ghost}`) })).toHaveCount(0);
      /* The other routes of the template are there too, and the turnkey member stands among the members. */
      for (const key of ['video-short-clip', 'video-character-sheet', 'video-reshoot'] as const) {
        await expect(structure.getByRole('region', { name: t.pipelineCatalog[key].name, exact: true })).toBeVisible();
      }
      await expect(structure.getByRole('heading', { name: t.dept.members, exact: true })).toBeVisible();
      /* The turnkey team goes by its template's title in the reader's language; employees keep their names. */
      await expect(structure.getByRole('heading', { name: { en: 'Turnkey team', ru: 'Команда под ключ' }[language], exact: true })).toBeVisible();
      /* A call's status is one unit: its words stay on one line, whatever the width. */
      const statuses = structure.locator('.call-marks.named .worker-name small');
      expect(await statuses.count()).toBeGreaterThan(0);
      expect(await statuses.evaluateAll(all => all.filter(status => status.getClientRects().length !== 1).map(status => status.textContent))).toEqual([]);

      /* Nothing scrolls sideways and no stage card is wider than its place. */
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const wide = await main.locator('.dv-stage').evaluateAll(cards => cards.filter(card => card.scrollWidth > card.clientWidth + 1).length);
      expect(wide).toBe(0);
      expect(errors).toEqual([]);

      if (SHOT_DIR) {
        mkdirSync(SHOT_DIR, { recursive: true });
        const shot = async (part: string) => {
          const file = join(SHOT_DIR, `video-department-${info.project.use.browserName}-${language}-${width}-${part}.png`);
          await page.screenshot({ path: file });
          await info.attach(`video-department-${language}-${width}-${part}`, { path: file, contentType: 'image/png' });
        };
        await shot('first-screen');
        /* The whole structure at once: the page grows by what its own scrolling panel holds below the fold. */
        const hidden = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll<HTMLElement>('*')]
          .filter(el => /auto|scroll/.test(getComputedStyle(el).overflowY)).map(el => el.scrollHeight - el.clientHeight)));
        await page.setViewportSize({ width, height: Math.min(900 + hidden, 12_000) });
        await expect(main.getByRole('heading', { name: names.stages['Deliver the video'], exact: true })).toBeInViewport();
        await shot('whole');
      }
    });
  }
}
