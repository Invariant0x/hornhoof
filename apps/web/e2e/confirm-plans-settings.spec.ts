import { expect, test, type Locator, type Page } from '@playwright/test';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { en } from '../src/i18n/en';
import type { MachineView, Org, RepoKey, SubView } from '../src/types';
import type { PhoneView } from '../src/ui/Phones';
import { SUB } from './agent-window-api';
import { ME, serveApi } from './api';
import { taskStream } from './hub-turn-api';

/* Every Group C critical action (Plans, Phones, Repos, GitHub host key, Vault, Google Sheets) goes through ConfirmAction
   in Chromium: Cancel and Escape send zero mutations, confirming sends the mutation once, and secrets never appear in
   the confirmation dialog. */

const COMPANY = { kind: 'company' as const, id: null, name: 'Whole company' };
const MACHINE: MachineView = {
  id: 'm1', hostname: 'node-a', os: 'linux', arch: 'arm64', owner: { id: ME.person.id, name: ME.person.name },
  online: true, lastSeenAt: null, plans: [], load: null, lendsTests: false, running: { agents: [], parts: [] },
};
const KIMI: SubView = {
  ...SUB, id: 's-kimi', provider: 'kimi', kind: 'personal', label: 'Kimi', status: 'ready', online: true,
  owner: { id: 'p1', name: 'Ivan' }, place: COMPANY, agents: [],
  machines: [{ id: 'm1', hostname: 'node-a', status: 'ready', online: true }],
  fallbacks: [{ subscription: 's-claude', model: null }, { subscription: 's-codex', model: null }],
};
const BROKEN: SubView = {
  ...SUB, id: 's-broken', provider: 'claude', kind: 'personal', label: 'Broken Claude', status: 'needs_login', online: true,
  owner: { id: 'p1', name: 'Ivan' }, place: COMPANY, agents: [],
  machines: [{ id: 'm1', hostname: 'node-a', status: 'needs_login', online: true }],
  fallbacks: [],
};
const API_SUB: SubView = {
  ...SUB, id: 's-api', provider: 'openrouter', kind: 'api_key', label: 'OpenRouter', last4: 'WXYZ', status: 'ready', online: true,
  owner: { id: 'p1', name: 'Ivan' }, place: COMPANY, agents: [], machines: [], fallbacks: [],
  api: { baseUrl: 'https://openrouter.ai/api', protocol: 'anthropic' },
  models: [{ id: 'm-a', name: 'Model A' }],
  target: { kind: 'any', id: null },
};
const CLAUDE_FB: SubView = { ...SUB, id: 's-claude', provider: 'claude', label: 'Claude', owner: { id: 'p2', name: 'Design team' }, agents: [], fallbacks: [] };
const CODEX_FB: SubView = { ...SUB, id: 's-codex', provider: 'codex', label: 'Codex', owner: { id: 'p3', name: 'Product team' }, agents: [], fallbacks: [] };
const PHONE: PhoneView = {
  id: 'ph1', name: 'Office Pixel 8', machineId: 'm1', owner: { id: ME.person.id, name: ME.person.name },
  lending: true, online: true, stopping: false, state: 'available', connection: 'ready', queued: 0,
};

const question = (page: Page) => page.getByRole('alertdialog');

async function cancelAndEscape(page: Page, trigger: Locator, title: string, writes: () => number, forbidden: string[] = []) {
  await trigger.click();
  const dialog = question(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(title);
  for (const secret of forbidden) await expect(dialog).not.toContainText(secret);
  await dialog.getByRole('button', { name: en.common.cancel, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes()).toBe(0);

  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(writes()).toBe(0);
}

async function confirmAndCheck(page: Page, trigger: Locator, yes: string, writes: () => number, expected = 1) {
  await trigger.click();
  await question(page).getByRole('button', { name: yes, exact: true }).click();
  await expect.poll(writes).toBe(expected);
  await expect(question(page)).toHaveCount(0);
}

async function prepareSubscriptions(page: Page, subs: SubView[]) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const writes: { method: string; path: string; body?: unknown }[] = [];
  const recipient = await identityToRecipient(await generateX25519Identity());
  let list = subs.map(s => ({ ...s }));
  await taskStream(page);
  await serveApi(page);
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: list } }));
  await page.route('**/api/subscriptions/*/models', route => route.fulfill({ json: { models: [{ id: 'm-a', name: 'Model A' }, { id: 'm-b', name: 'Model B' }] } }));
  await page.route('**/api/subscriptions/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const id = url.pathname.split('/')[3]!;
    if (req.method() === 'DELETE') {
      writes.push({ method: 'DELETE', path: url.pathname });
      list = list.filter(s => s.id !== id);
      return route.fulfill({ status: 204 });
    }
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Partial<SubView>;
      writes.push({ method: 'PATCH', path: url.pathname, body });
      list = list.map(s => (s.id === id ? { ...s, ...body } : s));
      return route.fulfill({ json: { subscription: list.find(s => s.id === id) } });
    }
    return route.fallback();
  });
  await page.route('**/api/subscriptions/*/tokens', route => route.fulfill({ json: { tokens: null, models: [] } }));
  await page.route('**/api/subscriptions/*/orchestrator', route => {
    writes.push({ method: 'POST', path: new URL(route.request().url()).pathname });
    return route.fulfill({ json: { subscription: { ...KIMI, isOrchestrator: true } } });
  });
  await page.route('**/api/subscriptions/*/recipients', route => {
    writes.push({ method: 'GET', path: new URL(route.request().url()).pathname });
    return route.fulfill({ json: { version: 2, recipients: [{ nodeId: 'm1', publicKey: recipient }] } });
  });
  await page.route('**/api/subscriptions/*/credential', route => {
    writes.push({ method: 'POST', path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/subscriptions');
  return { writes, errors };
}

test('Subscriptions: confirms removing personal plan, broken plan, API key and moving orchestrator', async ({ page }) => {
  const { writes, errors } = await prepareSubscriptions(page, [KIMI, BROKEN, API_SUB]);

  await page.getByRole('button', { name: en.tables.openCard('Kimi'), exact: true }).click();
  const kimiCard = page.getByRole('article', { name: 'Kimi, Ivan' });
  const moveBtn = kimiCard.getByRole('button', { name: en.subs.useForOrchestratorLabel('Kimi'), exact: true });
  await cancelAndEscape(page, moveBtn, en.subs.confirm.orchestrator.title, () => writes.length);
  await confirmAndCheck(page, moveBtn, en.subs.confirm.orchestrator.yes, () => writes.length, 1);
  expect(writes[0]).toEqual({ method: 'POST', path: '/api/subscriptions/s-kimi/orchestrator' });

  const removeKimi = kimiCard.getByRole('button', { name: en.subs.removeLabel('Kimi'), exact: true });
  await cancelAndEscape(page, removeKimi, en.subs.confirm.removePlan.title, () => writes.length - 1);
  await confirmAndCheck(page, removeKimi, en.subs.confirm.removePlan.yes, () => writes.length, 2);
  expect(writes[1]).toEqual({ method: 'DELETE', path: '/api/subscriptions/s-kimi' });

  await page.getByRole('button', { name: en.tables.openCard('Broken Claude'), exact: true }).click();
  const brokenCard = page.getByRole('article', { name: 'Broken Claude, Ivan' });
  const removeBroken = brokenCard.getByRole('button', { name: en.subs.removeLabel('Broken Claude'), exact: true });
  await cancelAndEscape(page, removeBroken, en.subs.confirm.removePlan.title, () => writes.length - 2);
  await confirmAndCheck(page, removeBroken, en.subs.confirm.removePlan.yes, () => writes.length, 3);
  expect(writes[2]).toEqual({ method: 'DELETE', path: '/api/subscriptions/s-broken' });

  await page.getByRole('button', { name: en.tables.openCard('OpenRouter'), exact: true }).click();
  const apiCard = page.getByRole('article', { name: 'OpenRouter' });
  const removeApi = apiCard.getByRole('button', { name: en.subs.removeLabel('OpenRouter'), exact: true });
  await cancelAndEscape(page, removeApi, en.subs.confirm.removeKey.title, () => writes.length - 3);
  await confirmAndCheck(page, removeApi, en.subs.confirm.removeKey.yes, () => writes.length, 4);
  expect(writes[3]).toEqual({ method: 'DELETE', path: '/api/subscriptions/s-api' });
  expect(errors).toEqual([]);
});

test('KeyForm, ApiForm and PlanFallbacks: confirms key replacement, API label/target change and fallback removal', async ({ page }) => {
  const { writes, errors } = await prepareSubscriptions(page, [KIMI, API_SUB, CLAUDE_FB, CODEX_FB]);
  const secretKey = 'sk-kimi-SECRET-KEY-9999';

  await page.getByRole('button', { name: en.tables.openCard('Kimi'), exact: true }).click();
  const kimiCard = page.getByRole('article', { name: 'Kimi, Ivan' });

  // 1. KeyForm: confirm before fetching recipients or posting credential, never show key value.
  await kimiCard.getByRole('button', { name: en.subs.pasteKeyLabel('Kimi'), exact: true }).click();
  await kimiCard.getByLabel(en.subs.keyField('Kimi'), { exact: true }).fill(secretKey);
  const saveKey = kimiCard.getByRole('button', { name: en.subs.connectKey, exact: true });
  await cancelAndEscape(page, saveKey, en.subs.confirm.replaceKey.title, () => writes.length, [secretKey]);
  await confirmAndCheck(page, saveKey, en.subs.confirm.replaceKey.yes, () => writes.filter(w => w.method === 'POST').length, 1);
  expect(writes.map(w => [w.method, w.path])).toEqual([
    ['GET', '/api/subscriptions/s-kimi/recipients'],
    ['POST', '/api/subscriptions/s-kimi/credential'],
  ]);

  // 2. PlanFallbacks: confirm removing fallback and move focus to next fallback control cleanly.
  const removeFirstFb = kimiCard.getByRole('button', { name: en.subs.fallbackRemoveLabel('Claude, Design team'), exact: true });
  await cancelAndEscape(page, removeFirstFb, en.subs.confirm.removeFallback.title, () => writes.filter(w => w.method === 'PATCH').length);
  await expect(removeFirstFb).toBeFocused();
  await confirmAndCheck(page, removeFirstFb, en.subs.confirm.removeFallback.yes, () => writes.filter(w => w.method === 'PATCH').length, 1);
  await expect(kimiCard.getByRole('combobox', { name: en.subs.fallbackModelLabel('Codex, Product team') })).toBeFocused();

  // 3. ApiForm: changing label and target confirms; models-only saves directly without dialog.
  await page.getByRole('button', { name: en.tables.openCard('OpenRouter'), exact: true }).click();
  const apiCard = page.getByRole('article', { name: 'OpenRouter' });
  await apiCard.getByRole('button', { name: en.subs.editApiLabel('OpenRouter'), exact: true }).click();
  await apiCard.getByLabel(en.subs.apiName, { exact: true }).fill('Company Router');
  await apiCard.getByLabel(en.subs.apiServes, { exact: true }).selectOption('orchestrator');
  const saveApi = apiCard.getByRole('button', { name: en.subs.saveChanges, exact: true });
  await cancelAndEscape(page, saveApi, en.subs.confirm.editApi.title, () => writes.filter(w => w.path === '/api/subscriptions/s-api').length);
  await confirmAndCheck(page, saveApi, en.subs.confirm.editApi.yes, () => writes.filter(w => w.path === '/api/subscriptions/s-api').length, 1);

  // Models-only edit saves directly without opening ConfirmAction.
  await apiCard.getByRole('button', { name: en.subs.editApiLabel('Company Router'), exact: true }).click();
  await apiCard.getByLabel(en.subs.modelId, { exact: true }).fill('m-b');
  await apiCard.getByRole('button', { name: en.subs.addModel, exact: true }).click();
  await apiCard.getByRole('button', { name: en.subs.saveChanges, exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  await expect.poll(() => writes.filter(w => w.path === '/api/subscriptions/s-api').length).toBe(2);
  expect(errors).toEqual([]);
});

test('Phones: confirms stopping a phone and resumes directly without confirmation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  let current: PhoneView = { ...PHONE };
  let stops = 0;
  let resumes = 0;
  await taskStream(page);
  await serveApi(page);
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [MACHINE], builtin: null, priority: false, move: null, canMove: false, copies: null } }));
  await page.route('**/api/phones', route => route.fulfill({ json: { phones: [current] } }));
  await page.route('**/api/phones/ph1/stop', route => {
    stops++;
    current = { ...PHONE, lending: false, state: 'owner' };
    return route.fulfill({ json: current });
  });
  await page.route('**/api/phones/ph1/resume', route => {
    resumes++;
    current = { ...PHONE, lending: true, state: 'available' };
    return route.fulfill({ json: current });
  });
  await page.goto('/machines');
  const card = page.getByRole('article', { name: PHONE.name });
  const stopBtn = card.getByRole('button', { name: en.phones.stop, exact: true });
  await cancelAndEscape(page, stopBtn, en.phones.confirm.stop.title, () => stops);
  await confirmAndCheck(page, stopBtn, en.phones.confirm.stop.yes, () => stops, 1);

  await card.getByRole('button', { name: en.phones.resume, exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  await expect.poll(() => resumes).toBe(1);
  expect(errors).toEqual([]);
});

test('RepoSettings: confirms updating existing repository (omitting token) and removing it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const secretToken = 'ghp_SECRET_REPO_TOKEN_8888';
  let repo: { url: string; branch: string; tokenLast4: string | null } | null = { url: 'https://github.com/acme/app', branch: 'main', tokenLast4: '1234' };
  let puts = 0;
  let deletes = 0;
  const org = (): Org => ({
    company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [],
    departments: [{ id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', ownerPersonId: null, agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [], repository: repo, repoHost: null }],
  });
  await taskStream(page);
  await serveApi(page);
  await page.route('**/api/org', route => route.fulfill({ json: org() }));
  await page.route('**/api/departments/d2/approval-policy', route => route.fulfill({ json: { departmentId: 'd2', owner: null, canSetOwner: false, canChangePolicy: false, candidates: [], rules: [] } }));
  await page.route('**/api/departments/d2/repository', async route => {
    if (route.request().method() === 'PUT') {
      puts++;
      const body = route.request().postDataJSON() as { url: string; branch: string };
      repo = { url: body.url, branch: body.branch, tokenLast4: '8888' };
      await route.fulfill({ json: { ok: true } });
      return page.evaluate(() => window.hubTaskEvent('org'));
    }
    if (route.request().method() === 'DELETE') {
      deletes++;
      repo = null;
      await route.fulfill({ status: 204 });
      return page.evaluate(() => window.hubTaskEvent('org'));
    }
    return route.fallback();
  });
  await page.goto('/departments/d2');
  await page.getByRole('button', { name: en.dept.about, exact: true }).click();
  await page.getByRole('button', { name: en.dept.change, exact: true }).click();
  await page.getByLabel(en.dept.address, { exact: true }).fill('https://github.com/acme/next-app');
  await page.getByLabel(en.dept.branch, { exact: true }).fill('release');
  await page.getByLabel(en.dept.token, { exact: true }).fill(secretToken);
  const saveBtn = page.getByRole('button', { name: en.common.save, exact: true });
  await cancelAndEscape(page, saveBtn, en.dept.repoConfirm.update.title, () => puts, [secretToken]);
  await confirmAndCheck(page, saveBtn, en.dept.repoConfirm.update.yes, () => puts, 1);

  const removeBtn = page.getByRole('button', { name: en.dept.remove, exact: true });
  await cancelAndEscape(page, removeBtn, en.dept.repoConfirm.remove.title, () => deletes);
  await confirmAndCheck(page, removeBtn, en.dept.repoConfirm.remove.yes, () => deletes, 1);
  expect(errors).toEqual([]);
});

test('Settings integrations and passwords: confirms GitHub key, Google Sheets disconnect and Vault actions without exposing secrets', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const secretHostKey = 'ghp_SECRET_HOST_KEY_7777';
  const secretPassword = 'SuperSecretPass!42';
  const secretTotp = 'JBSWY3DPEHPK3PXP';
  let host: RepoKey | null = { provider: 'github', owner: 'acme-org', tokenLast4: '1111' };
  let google: { kind: 'service_account'; account: string; shareEmail: string; keyLast4: string } | null = {
    kind: 'service_account', account: 'sheets-bot@acme.iam.gserviceaccount.com', shareEmail: 'ivan@acme.com', keyLast4: '9876',
  };
  let entries = [{ id: 'v1', name: 'Partner CRM', site: 'https://crm.example', login: 'ivan@acme.com', hasCode: false, createdBy: { id: 'p1', name: 'Ivan' }, createdAt: '2030-01-01T09:00:00.000Z' }];
  let hostPuts = 0;
  let hostDeletes = 0;
  let googleDeletes = 0;
  let vaultPatches = 0;
  let vaultDeletes = 0;

  await taskStream(page);
  await serveApi(page);
  await page.route('**/api/repo-host', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: { host } });
    if (method === 'PUT') {
      hostPuts++;
      const body = route.request().postDataJSON() as { owner: string };
      host = { provider: 'github', owner: body.owner, tokenLast4: '7777' };
      return route.fulfill({ json: { host } });
    }
    if (method === 'DELETE') {
      hostDeletes++;
      host = null;
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await page.route('**/api/google-sheets', route => {
    if (route.request().method() === 'DELETE') {
      googleDeletes++;
      google = null;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { google } });
  });
  await page.route('**/api/vault', route => route.fulfill({ json: { entries } }));
  await page.route('**/api/vault/v1', route => {
    if (route.request().method() === 'PATCH') {
      vaultPatches++;
      const body = route.request().postDataJSON() as { name?: string };
      entries = entries.map(e => (e.id === 'v1' ? { ...e, name: body.name ?? e.name, hasCode: true } : e));
      return route.fulfill({ json: { entry: entries[0] } });
    }
    if (route.request().method() === 'DELETE') {
      vaultDeletes++;
      entries = [];
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });

  // 1. Integrations: RepoHost replace + remove, Google Sheets disconnect.
  await page.goto('/settings/integrations');
  const settingsDialog = page.getByRole('dialog', { name: en.settings.title, exact: true });
  const repoCard = settingsDialog.getByRole('article', { name: en.repoHost.title, exact: true });
  await repoCard.getByRole('button', { name: en.repoHost.change, exact: true }).click();
  await repoCard.getByLabel(en.repoHost.key, { exact: true }).fill(secretHostKey);
  const saveHost = repoCard.getByRole('button', { name: en.common.save, exact: true });
  await cancelAndEscape(page, saveHost, en.repoHost.confirm.replace.title, () => hostPuts, [secretHostKey]);
  await confirmAndCheck(page, saveHost, en.repoHost.confirm.replace.yes, () => hostPuts, 1);

  const removeHost = repoCard.getByRole('button', { name: en.repoHost.remove, exact: true });
  await cancelAndEscape(page, removeHost, en.repoHost.confirm.remove.title, () => hostDeletes);
  await confirmAndCheck(page, removeHost, en.repoHost.confirm.remove.yes, () => hostDeletes, 1);

  const sheetsCard = settingsDialog.getByRole('article', { name: en.googleSheets.title, exact: true });
  const disconnectSheets = sheetsCard.getByRole('button', { name: en.googleSheets.remove, exact: true });
  await cancelAndEscape(page, disconnectSheets, en.googleSheets.confirm.disconnect.title, () => googleDeletes);
  await confirmAndCheck(page, disconnectSheets, en.googleSheets.confirm.disconnect.yes, () => googleDeletes, 1);

  // 2. Passwords (Vault): edit entry without leaking password/2FA code, and remove entry.
  await page.goto('/settings/passwords');
  const vaultGroup = page.getByRole('dialog', { name: en.settings.title, exact: true }).locator('.sgroup[data-group="passwords"]');
  await vaultGroup.getByRole('button', { name: en.vault.change, exact: true }).click();
  await vaultGroup.getByLabel(en.vault.name, { exact: true }).fill('Partner CRM Prod');
  await vaultGroup.getByLabel(en.vault.password, { exact: true }).fill(secretPassword);
  await vaultGroup.getByLabel(en.vault.code, { exact: true }).fill(secretTotp);
  const saveVault = vaultGroup.getByRole('button', { name: en.common.save, exact: true });
  await cancelAndEscape(page, saveVault, en.vault.confirm.edit.title, () => vaultPatches, [secretPassword, secretTotp]);
  await confirmAndCheck(page, saveVault, en.vault.confirm.edit.yes, () => vaultPatches, 1);

  const removeVault = vaultGroup.getByRole('button', { name: en.vault.remove, exact: true });
  await cancelAndEscape(page, removeVault, en.vault.confirm.remove.title, () => vaultDeletes);
  await confirmAndCheck(page, removeVault, en.vault.confirm.remove.yes, () => vaultDeletes, 1);
  expect(errors).toEqual([]);
});
