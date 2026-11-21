/// <reference types="node" />
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';

test.describe.configure({ timeout: 0 });

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;

type Boot = { origin: string; sessions: Record<'ceo' | 'deputy' | 'whole' | 'listed', string>; listedId: string };

/* A real server on a fresh database, with the four kinds of people the server's rename guard tells apart: the CEO, the
   deputy, someone with the whole company and someone with one department. */
const SERVER = `
import { PGlite } from '@electric-sql/pglite';
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
const config = loadConfig({ HORNHOOF_SECRET: secret, UPDATE_CHECK_MS: '0', PUBLIC_URL: process.env.HH_PUBLIC_URL });
const app = await buildApp({ db, config });

const sessionOf = res => {
  const session = res.cookies.find(c => c.name === 'hh_session')?.value;
  if (!session) throw new Error('No session: ' + res.statusCode + ' ' + res.body);
  return session;
};
const ceo = sessionOf(await app.inject({
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
}));
const asCeo = { cookies: { hh_session: ceo } };
const [acme] = await db.select().from(schema.companies);
const [marketing] = await db.insert(schema.departments).values({ companyId: acme.id, name: 'Marketing', roleCode: 'CMO' }).returning();
const join = async (name, access) => {
  const invited = await app.inject({ method: 'POST', url: '/api/people/invite', payload: { name, email: name.toLowerCase() + '@acme.com', title: '', access }, ...asCeo });
  const token = invited.json().inviteUrl.split('/invite/')[1];
  const accepted = await app.inject({ method: 'POST', url: '/api/invites/' + token + '/accept', payload: { password: 'a long enough password' } });
  return { id: invited.json().person.id, session: sessionOf(accepted) };
};
const dana = await join('Dana', { whole: true });
const maria = await join('Maria', { whole: true });
const olga = await join('Olga', { departments: [marketing.id] });
await app.inject({ method: 'PUT', url: '/api/people/' + dana.id + '/ceo-delegate', payload: { isCeoDelegate: true }, ...asCeo });

const origin = await app.listen({ host: '127.0.0.1', port: await testPort() });
process.stdout.write(JSON.stringify({ origin, sessions: { ceo, deputy: dana.session, whole: maria.session, listed: olga.session }, listedId: olga.id }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => void app.close().then(() => client.close()).then(() => process.exit(0)));
`;

async function startServer(publicUrl: string): Promise<Boot & { stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', SERVER], {
    cwd: resolve(HERE, '../../server'),
    env: { ...process.env, HH_PUBLIC_URL: publicUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const boot = await new Promise<Boot>((done, fail) => {
    createInterface({ input: child.stdout }).once('line', line => done(JSON.parse(line) as Boot));
    child.once('exit', code => fail(new Error(`The server stopped early (${code}):\n${stderr}`)));
  });
  const stop = () => new Promise<void>(done => {
    if (child.exitCode !== null) return done();
    child.once('exit', () => done());
    child.stdin.end();
  });
  return { ...boot, stop };
}

for (const lang of ['en', 'ru'] as const) {
  const m = MESSAGES[lang];

  test(`the name in the edit form against a real server, in ${lang}`, async ({ browser, baseURL }) => {
    const web = baseURL!;
    const server = await startServer(web);
    const errors: string[] = [];
    const contexts: BrowserContext[] = [];
    let stopping = false;
    /* The People screen, signed in as one of them, every call going to the real server. */
    const signedIn = async (browser: Browser, who: keyof Boot['sessions']): Promise<Page> => {
      const context = await browser.newContext({ baseURL: web, viewport: { width: 1440, height: 960 } });
      contexts.push(context);
      await context.addCookies([{ name: 'hh_session', value: server.sessions[who], url: web }]);
      await context.addInitScript(lang => localStorage.setItem('hh-lang', lang), lang);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/stream') return;
        /* The page goes on asking where the company runs after the test's server has stopped: only such a call ends
           unanswered, and a call that fails while the server runs still fails the scenario. */
        const response = await route.fetch({ url: `${server.origin}${url.pathname}${url.search}` }).catch(err => {
          if (stopping) return null;
          throw err;
        });
        if (response) await route.fulfill({ response });
        else await route.abort().catch(() => undefined);
      });
      await page.goto('/people');
      return page;
    };
    const edit = (page: Page, name: string) => page.getByRole('button', { name: m.people.editLabel(name), exact: true }).click();
    const nameField = (page: Page) => page.getByLabel(m.common.name, { exact: true });
    const titleField = (page: Page) => page.getByLabel(m.common.title, { exact: true });
    const save = (page: Page) => page.getByRole('button', { name: m.common.save, exact: true }).click();
    const confirmRename = (page: Page) => page.getByRole('alertdialog', { name: m.confirm.renamePerson.title }).getByRole('button', { name: m.confirm.renamePerson.yes, exact: true }).click();
    const row = (page: Page, name: string) => page.locator('table.ptable tr', { hasText: name });

    try {
      /* The whole company alone does not let you rename anyone else, on the screen or on the server, and the title still saves. */
      const whole = await signedIn(browser, 'whole');
      await edit(whole, 'Olga');
      await expect(titleField(whole)).toBeVisible();
      await expect(nameField(whole)).toHaveCount(0);
      await titleField(whole).fill('Head of ads');
      await save(whole);
      await expect(row(whole, 'Olga')).toContainText('Head of ads');
      const refused = await whole.evaluate(async id => (await fetch(`/api/people/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nope' }) })).status, server.listedId);
      expect(refused).toBe(403);

      /* The CEO renames someone else, above the title and together with it; the list and the map show what was saved. */
      const ceo = await signedIn(browser, 'ceo');
      await edit(ceo, 'Maria');
      await expect(nameField(ceo)).toHaveValue('Maria');
      if (SCREENSHOT_DIR) await ceo.screenshot({ path: `${SCREENSHOT_DIR}/people-edit-name-${lang}.png` });
      const [nameBox, titleBox] = [await nameField(ceo).boundingBox(), await titleField(ceo).boundingBox()];
      expect(nameBox!.y + nameBox!.height).toBeLessThanOrEqual(titleBox!.y);
      expect(nameBox!.x).toBe(titleBox!.x);
      await nameField(ceo).fill('Maria Ray');
      await titleField(ceo).fill('Head of sales');
      await save(ceo);
      await confirmRename(ceo);
      await expect(row(ceo, 'Maria Ray')).toContainText('Head of sales');
      await ceo.reload();
      await expect(row(ceo, 'Maria Ray')).toContainText('Head of sales');
      await ceo.goto('/');
      await expect(ceo.getByText('Maria Ray', { exact: true })).toBeVisible();

      /* The deputy renames someone else, and may rename the CEO, whose access stays out of the form. */
      const deputy = await signedIn(browser, 'deputy');
      await edit(deputy, 'Olga');
      await nameField(deputy).fill('Olga Lee');
      await save(deputy);
      await confirmRename(deputy);
      await expect(row(deputy, 'Olga Lee')).toBeVisible();
      await edit(deputy, 'Ivan');
      await expect(nameField(deputy)).toHaveValue('Ivan');
      await deputy.getByRole('button', { name: m.common.cancel, exact: true }).click();
      await ceo.reload();
      await expect(ceo.getByText('Olga Lee', { exact: true })).toBeVisible();

      /* Someone with one department renames themselves, and the shell shows it, but no one else. */
      const listed = await signedIn(browser, 'listed');
      await edit(listed, 'Olga Lee');
      await nameField(listed).fill('Olga Lane');
      await save(listed);
      await confirmRename(listed);
      await expect(row(listed, 'Olga Lane')).toBeVisible();
      await listed.getByRole('button', { name: m.shell.account, exact: true }).click();
      await expect(listed.locator('.account-menu').getByText('Olga Lane', { exact: true })).toBeVisible();

      expect(errors).toEqual([]);
    } finally {
      stopping = true;
      /* A page left open asks the stopped server for updates every five minutes, and that failure lands on whichever
         test then runs in this worker. */
      for (const context of contexts) await context.close();
      await server.stop();
    }
  });
}
