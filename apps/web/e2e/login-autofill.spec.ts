import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { detail, serveApi, TASKS } from './api';

/* Hornhoof's own sign-in is filled only where a person signs in or sets their Hornhoof password (#1320). Everywhere a form
   holds a secret for somewhere else, no browser and no password manager may put the saved Hornhoof login into it.

   Chromium keeps a real saved login: its password manager fills a profile's logins into any form with a password field,
   which is how the email and the password once landed in the phone's pairing address and pairing code. Playwright's
   Firefox and WebKit keep none: Firefox runs with signon.rememberSignons off and can only store a login encrypted by its own
   NSS key, and WebKit has no password manager at all, as AutoFill is Safari's. There, and in Chromium too, each form is held
   to what every browser and manager reads before it fills a login: a password field, or a field marked username or
   current-password. A form with neither, and with the ignore marks of the managers on each field, gets nothing filled. */

const EMAIL = 'ivan@acme.com';
const PASSWORD = 'hornhoof-password-1320';
const MARKS = { 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' };
const SHOTS = process.env.SHOTS;

type Field = { label: string; tag: string; type: string; autocomplete: string | null; inputmode: string | null; marks: Record<string, string | null>; masked: string };

/* What a browser or a manager reads of each field of a form before it fills a login. */
const fieldsOf = (form: Locator): Promise<Field[]> => form.locator('input:not([type=checkbox], [type=radio], [type=file], [type=hidden]), textarea').evaluateAll((elements, marks) => elements.map(element => {
  const input = element as HTMLInputElement;
  return {
    label: input.labels?.[0]?.textContent ?? input.getAttribute('aria-label') ?? '',
    tag: input.tagName.toLowerCase(),
    type: input.type,
    autocomplete: input.getAttribute('autocomplete'),
    inputmode: input.getAttribute('inputmode'),
    marks: Object.fromEntries(marks.map(mark => [mark, input.getAttribute(mark)])),
    masked: getComputedStyle(input).getPropertyValue('-webkit-text-security').trim() || 'none',
  };
}), Object.keys(MARKS));

/* A form that holds a secret for somewhere else: no password field, no field open to a login, the ignore marks on each one,
   and each secret masked on screen in this very engine. */
async function holdsNoLogin(form: Locator, secrets: readonly string[]) {
  const fields = await fieldsOf(form);
  expect(fields.map(f => f.label)).toEqual(expect.arrayContaining([...secrets]));
  for (const field of fields) {
    expect(field.type, `${field.label} is no password field`).not.toBe('password');
    if (field.tag === 'textarea') continue;
    expect(['off', 'one-time-code'], `${field.label} takes no saved login`).toContain(field.autocomplete);
    expect(field.marks, `${field.label} carries the ignore marks`).toEqual(MARKS);
    expect(field.masked, `${field.label} is masked only if it is a secret`).toBe(secrets.includes(field.label) ? 'disc' : 'none');
  }
}

/* One computer of the company, online, that a phone can be added to. */
const MACHINE = {
  id: 'm1', hostname: 'work-pc', os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null, plans: [],
  load: { cpus: 8, load: 1, memFree: 8e9, memTotal: 16e9, jobs: 0, tests: 0, cpuModel: 'x', diskFree: 2e11, diskTotal: 5e11 }, lendsTests: false, running: { agents: [], parts: [] }, drain: null,
};

/* Machines, then Add phone, as a person opens them. */
async function openPhones(page: Page, words: Messages): Promise<Locator> {
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [MACHINE], builtin: null } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.goto('/');
  await page.getByRole('navigation', { name: words.shell.sections }).getByRole('button', { name: words.shell.tabs.machines, exact: true }).click();
  await page.getByRole('button', { name: words.phones.add, exact: true }).click();
  const form = page.getByRole('form', { name: words.phones.add, exact: true });
  await expect(form).toBeVisible();
  return form;
}

type Secret = { name: string; secrets: readonly string[]; open(page: Page): Promise<Locator> };

const settings = (page: Page) => page.getByRole('dialog', { name: en.settings.title, exact: true });

/* Each form with a secret that a browser could take for a sign-in, opened as a person opens it. */
const FORMS: Secret[] = [
  {
    name: 'Add phone', secrets: [],
    open: page => openPhones(page, en),
  },
  {
    name: 'a saved sign-in of the vault', secrets: [en.vault.password, en.vault.code],
    async open(page) {
      await page.goto('/settings/passwords');
      await settings(page).getByRole('button', { name: en.vault.add, exact: true }).click();
      return page.getByRole('form', { name: en.vault.addTitle, exact: true });
    },
  },
  {
    name: 'the GitHub key', secrets: [en.repoHost.key],
    async open(page) {
      await page.goto('/settings/integrations');
      const part = settings(page).getByRole('article', { name: en.repoHost.title, exact: true });
      await part.getByRole('button', { name: en.repoHost.save, exact: true }).click();
      return part.locator('form');
    },
  },
  {
    name: 'the Google key', secrets: [],
    async open(page) {
      await page.goto('/settings/integrations');
      const part = settings(page).getByRole('article', { name: en.googleSheets.title, exact: true });
      await part.getByRole('button', { name: en.googleSheets.connect, exact: true }).click();
      return part.locator('form');
    },
  },
  {
    name: 'an API key', secrets: [en.subs.apiKey],
    async open(page) {
      await page.goto('/subscriptions');
      await page.getByRole('button', { name: en.subs.connectApi, exact: true }).click();
      return page.getByRole('form', { name: en.subs.connectApi, exact: true });
    },
  },
  {
    name: 'a secret hidden in a task', secrets: [en.tasks.hideSecret.value],
    async open(page) {
      await page.route('**/api/tasks/t1', route => route.fulfill({ json: { task: { ...detail(TASKS[0]!), body: 'token=abc123456789', mayHideSecret: true } } }));
      await page.goto('/tasks/t1');
      const panel = page.getByRole('complementary', { name: '#1 Checkout step 1' });
      await panel.getByRole('button', { name: en.tasks.hideSecret.action, exact: true }).click();
      return panel.getByRole('form', { name: en.tasks.hideSecret.action, exact: true });
    },
  },
  {
    name: "a department's repository", secrets: [en.dept.token],
    async open(page) {
      await page.goto('/departments/d2');
      await page.getByRole('button', { name: en.dept.about, exact: true }).click();
      await page.getByRole('button', { name: en.dept.connectRepository, exact: true }).click();
      return page.locator('form.repo-form').filter({ has: page.getByLabel(en.dept.token, { exact: true }) });
    },
  },
];

async function signedIn(page: Page) {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await serveApi(page);
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  return failures;
}

/* The sign-in screen, as a browser that is signed out sees it. */
async function login(page: Page): Promise<Locator> {
  await page.route('**/api/me', route => route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'Sign in.' } } }));
  await page.goto('/');
  const form = page.locator('form').filter({ has: page.getByLabel(en.common.password, { exact: true }) });
  await expect(form).toBeVisible();
  return form;
}

test('the sign-in screen keeps the email as the username and the current password', async ({ page }) => {
  await serveApi(page);
  const form = await login(page);
  const fields = await fieldsOf(form);
  expect(fields.map(({ label, type, autocomplete }) => ({ label, type, autocomplete }))).toEqual([
    { label: en.common.email, type: 'email', autocomplete: 'username' },
    { label: en.common.password, type: 'password', autocomplete: 'current-password' },
  ]);
});

for (const secret of FORMS) {
  test(`${secret.name} gives a browser and a password manager no field for the Hornhoof login`, async ({ page }) => {
    const failures = await signedIn(page);
    const form = await secret.open(page);
    await expect(form).toBeVisible();
    await holdsNoLogin(form, secret.secrets);
    expect(failures).toEqual([]);
  });
}

test('the pairing code is six digits a phone gives once, not a password', async ({ page }) => {
  await signedIn(page);
  const form = await FORMS[0]!.open(page);
  const fields = await fieldsOf(form);
  expect(fields.find(f => f.label === en.phones.pairingCode)).toMatchObject({ type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', masked: 'none' });
  expect(fields.find(f => f.label === en.phones.pairingAddress)).toMatchObject({ type: 'text', autocomplete: 'off' });
});

/* The pictures for Design: each changed form, and the pairing code refused and in focus, in both languages and skins. */
test('pictures of the changed forms', async ({ page, browserName }) => {
  test.skip(!SHOTS || browserName !== 'chromium', 'Only when SHOTS names a folder, in Chromium.');
  for (const [language, skin] of [['en', 'light'], ['ru', 'dark']] as const) for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(({ language, skin }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', skin);
    }, { language, skin });
    await signedIn(page);
    const words = (language === 'en' ? en : ru).phones;
    const form = await openPhones(page, language === 'en' ? en : ru);
    await form.getByLabel(words.name, { exact: true }).fill('Pixel');
    await form.getByLabel(words.address, { exact: true }).fill('192.168.1.80:5555');
    await form.getByLabel(words.pairingAddress, { exact: true }).fill('192.168.1.80:43111');
    await form.getByLabel(words.pairingCode, { exact: true }).fill('12');
    await form.getByRole('button', { name: words.find, exact: true }).click();
    await expect(form.getByLabel(words.pairingCode, { exact: true })).toBeFocused();
    await page.evaluate(async () => { await document.fonts.ready; });
    await form.screenshot({ path: `${SHOTS}/1321-pairing-refused-${language}-${skin}-${width}.png` });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem('hh-lang', 'en'); localStorage.setItem('hh-theme', 'light'); });
  await signedIn(page);
  for (const secret of FORMS) {
    const form = await secret.open(page);
    for (const label of secret.secrets) await form.getByLabel(label, { exact: true }).fill('secret-value-1321');
    await page.evaluate(async () => { await document.fonts.ready; });
    await form.screenshot({ path: `${SHOTS}/1321-${secret.name.replace(/[^a-z]+/gi, '-')}.png` });
  }
});

/* The login as Chromium keeps it on Linux, where Playwright runs it with the basic password store: AES-128-CBC under the
   store's fixed key, as Chromium's own os_crypt writes it. */
function sealed(password: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1'), Buffer.alloc(16, ' '));
  return Buffer.concat([Buffer.from('v10'), cipher.update(password, 'utf8'), cipher.final()]);
}

/* A Chromium profile that holds the Hornhoof login of this site, as after a person chose Save on the sign-in screen. The
   full Chromium, as the headless shell has no password manager. */
async function withSavedLogin(dir: string, site: string): Promise<BrowserContext> {
  mkdirSync(dir, { recursive: true });
  await (await chromium.launchPersistentContext(dir, { channel: 'chromium' })).close();
  const db = new DatabaseSync(`${dir}/Default/Login Data`);
  const now = (BigInt(Date.now()) + 11_644_473_600_000n) * 1000n;
  db.prepare(`INSERT INTO logins (origin_url, action_url, username_element, username_value, password_element, password_value, submit_element,
    signon_realm, date_created, blacklisted_by_user, scheme, password_type, times_used, date_last_used, date_password_modified)
    VALUES (?, ?, '', ?, '', ?, '', ?, ?, 0, 0, 0, 1, ?, ?)`).run(`${site}/`, `${site}/`, EMAIL, sealed(PASSWORD), `${site}/`, now, now, now);
  db.close();
  return chromium.launchPersistentContext(dir, { channel: 'chromium', baseURL: site });
}

const filled = (scope: Locator) => scope.locator('input, textarea').evaluateAll(elements => elements.filter(element => element.matches(':autofill')).map(element => (element as HTMLInputElement).labels?.[0]?.textContent ?? element.outerHTML));

/* A sign-in form of the test's own, put on the page after the form under check. Chromium fills the forms it finds in the
   order it finds them, so once this one is filled, the form before it got what it ever gets. */
async function settled(page: Page) {
  await page.evaluate(() => {
    const form = document.createElement('form');
    form.id = 'probe';
    form.innerHTML = '<input type="email" autocomplete="username"><input type="password" autocomplete="current-password">';
    document.body.append(form);
  });
  await expect.poll(() => filled(page.locator('#probe'))).toHaveLength(2);
  await page.evaluate(() => document.getElementById('probe')!.remove());
}

test('a saved Hornhoof login fills the sign-in screen and nothing in the forms with secrets', async ({ browserName }, info) => {
  test.skip(browserName !== 'chromium' || process.platform !== 'linux', 'Only Chromium keeps a saved login under Playwright, and its store is read here as Linux keeps it.');
  const context = await withSavedLogin(info.outputPath('profile'), info.project.use.baseURL!);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await signedIn(page);
    const signIn = await login(page);
    await expect.poll(() => filled(signIn)).toEqual([en.common.email, en.common.password]);
    await page.unroute('**/api/me');
    for (const secret of FORMS) {
      const form = await secret.open(page);
      await expect(form).toBeVisible();
      await settled(page);
      expect.soft(await filled(form), `${secret.name} gets nothing of the saved login`).toEqual([]);
    }
  } finally {
    await context.close();
  }
});
