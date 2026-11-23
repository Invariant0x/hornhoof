import { expect, test, type Page } from '@playwright/test';
import type { AgentCardView, Department, Employee, EventView, Org, PersonView, StructureItem, SubView } from '../src/types';
import { ME, serveApi, writeToOrchestrator } from './api';

/* End-to-end browser verification for every Group A confirmation (#1807):
   - PeopleAssistant: rename assistant (only when name changes), replace existing key, revoke key (first-time issue direct)
   - AgentCard & TelegramBot: disconnect plan (switching plans direct), reset instructions, remove employee, disconnect bot
   - AgentWindow: stop current work via Stop button and Escape shortcut (second Escape dismisses dialog only)
   - StructureCard: existing-department changes/removals confirm (all brand-new items apply directly)
   - SubUnits: rename sub-unit (unchanged closes directly), delete sub-unit */

type Mutation = { method: string; path: string; body?: unknown };

const WHOLE = { whole: true, departments: [], teams: [] };
const NONE = { whole: false, departments: [], teams: [] };
const ROLE_BE = { en: 'Backend engineer', ru: 'Бэкенд-разработчик' };
const ROLE_HEAD = { en: 'Head of development', ru: 'Руководитель разработки' };

const TEAM_KEY: SubView = {
  id: 's-key', provider: 'anthropic_api', kind: 'api_key', label: 'Team key', status: 'ready', online: true, last4: '1234',
  owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, machines: [], limits: null,
  budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: false, leaseMachine: null,
};
const OLEG_CODEX: SubView = {
  id: 's-codex', provider: 'codex', kind: 'personal', label: '', status: 'ready', online: true, last4: null,
  owner: { id: 'p2', name: 'Oleg' }, place: { kind: 'department', id: 'd2', name: 'Development' }, machines: [], limits: null,
  budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: false, leaseMachine: null,
};

const SASHA: Employee = {
  id: 's1', name: 'Sasha', roleId: 'DEV-HEAD', title: ROLE_HEAD, kind: 'head', model: '', modelName: null, provider: 'anthropic_api',
  effort: null, state: 'sleeping', status: 'idle', on: true, timer: null, task: null, context: null, program: null, alarm: null, retry: null, failure: null,
};
const BRUNO: Employee = {
  id: 'b1', name: 'Bruno', roleId: 'DEV-BE', title: ROLE_BE, kind: 'worker', model: 'claude-sonnet-5-5', modelName: 'Sonnet', provider: 'anthropic_api',
  effort: null, state: 'working', status: 'working', on: true, timer: null, task: null, context: null, program: null, alarm: null, retry: null, failure: null,
};

const DEV: Department = {
  id: 'd2', name: 'Development', templateKey: 'development', roleCode: 'DEV', about: '', agents: { total: 2, working: 1 },
  products: [], teams: [{ id: 'u1', name: 'Urgent fixes', about: '', stage: 0, gate: false, turnkey: false }],
  people: [], employees: [SASHA, BRUNO],
  roles: [
    { id: 'DEV-HEAD', title: ROLE_HEAD, description: ROLE_HEAD, kind: 'head', gate: null },
    { id: 'DEV-BE', title: ROLE_BE, description: ROLE_BE, kind: 'member', gate: null },
  ],
};
const FIN: Department = {
  id: 'd9', name: null, templateKey: 'finance', roleCode: 'FIN', about: '', agents: { total: 0, working: 0 },
  products: [], teams: [], people: [], employees: [], roles: [],
};

const ORG: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: TEAM_KEY, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 2, working: 1 },
  people: [],
  departments: [DEV, FIN],
};

const BRUNO_CARD: AgentCardView = {
  id: 'b1', currentTask: null, kind: 'worker', name: 'Bruno',
  role: { id: 'DEV-BE', title: ROLE_BE, description: ROLE_BE },
  department: { id: 'd2', name: 'Development' }, product: null, team: null, teams: DEV.teams,
  model: 'claude-sonnet-5-5', effort: null, subscription: TEAM_KEY, machine: null, state: 'working',
  retry: null, failure: null, skills: [], parts: [], raw: '',
  runsOn: [{ subscription: TEAM_KEY, models: [] }, { subscription: OLEG_CODEX, models: [] }],
  changes: [], interrupted: [], timer: null, canEdit: true, canRemove: true,
};
const SASHA_CARD: AgentCardView = {
  ...BRUNO_CARD, id: 's1', kind: 'head', name: 'Sasha',
  role: { id: 'DEV-HEAD', title: ROLE_HEAD, description: ROLE_HEAD },
  state: 'sleeping', telegram: { username: 'acme_dev_bot' },
};

const question = (page: Page) => page.getByRole('alertdialog');
const bdiTexts = (page: Page) => question(page).locator('bdi').allTextContents();

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  return errors;
}

const META_ROUTES: Record<string, unknown> = {
  '/api/version': { version: '0.8.1', commit: 'confirm-e2e' },
  '/api/updates': { current: { version: '0.8.1', commit: 'confirm-e2e' }, available: false, latest: null, updater: { status: null, waiting: null } },
  '/api/subscriptions': { subscriptions: [TEAM_KEY, OLEG_CODEX] },
};

async function serveMeta(page: Page) {
  await serveApi(page);
  await page.route('**/api/{version,updates,subscriptions}', route => route.fulfill({ json: META_ROUTES[new URL(route.request().url()).pathname] }));
}

async function setupPeople(page: Page) {
  const mutations: Mutation[] = [];
  let ava: PersonView = {
    id: 'h1', name: 'Ava', email: null, title: '', status: 'active', isOwner: false, access: NONE,
    assistant: { owner: { id: 'p2', name: 'Maria' }, program: 'avaclone', eventsUrl: null, skillsUrl: null, key: null, agent: null },
  };
  const maria: PersonView = { id: 'p2', name: 'Maria', email: 'maria@acme.com', title: 'CTO', status: 'active', isOwner: false, access: WHOLE };
  const ceo: PersonView = { ...ME.person, email: 'ivan@acme.com', access: WHOLE };

  await serveMeta(page);
  await page.route('**/api/people**', route => {
    const req = route.request();
    const method = req.method();
    const { pathname } = new URL(req.url());
    const body = req.postData() ? (req.postDataJSON() as Record<string, unknown>) : undefined;
    if (method === 'GET' && pathname === '/api/people') return route.fulfill({ json: { people: [ceo, maria, ava] } });
    mutations.push({ method, path: pathname, body });
    if (pathname === '/api/people/h1/key' && method === 'POST') {
      ava = { ...ava, assistant: { ...ava.assistant!, key: { createdAt: '2026-11-11T10:00:00.000Z' } } };
      return route.fulfill({ status: 201, json: { key: 'hha_TESTKEY', signingSecret: 'hhs_TESTSECRET', address: 'https://acme.hornhoof.app', person: ava } });
    }
    if (pathname === '/api/people/h1/key' && method === 'DELETE') {
      ava = { ...ava, assistant: { ...ava.assistant!, key: null } };
      return route.fulfill({ json: { person: ava } });
    }
    if (pathname === '/api/people/h1' && method === 'PATCH') {
      ava = { ...ava, ...(body as Partial<PersonView>) };
      return route.fulfill({ json: { person: ava } });
    }
    if (pathname === '/api/people/h1/assistant' && method === 'PATCH') {
      return route.fulfill({ json: { person: ava } });
    }
    return route.fallback();
  });
  await page.goto('/people');
  return mutations;
}

async function setupDepartment(page: Page) {
  const mutations: Mutation[] = [];
  let brunoCard = { ...BRUNO_CARD };
  let sashaCard = { ...SASHA_CARD };
  await serveMeta(page);
  await page.route('**/api/**', route => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());
    const path = url.pathname;
    const body = req.postData() ? (req.postDataJSON() as Record<string, unknown>) : undefined;
    if (path === '/api/org' && method === 'GET') return route.fulfill({ json: ORG });
    if (path === '/api/departments/d2/approval-policy') return route.fulfill({ json: { departmentId: 'd2', owner: null, canSetOwner: true, canChangePolicy: true, candidates: [], rules: [] } });
    if (path === '/api/departments/d2/tree') return route.fulfill({ json: { tree: { now: '2026-11-21T00:00:00Z', turn: null, repository: true, stage: 'work', lines: [], review: null, time: [], idle: [] } } });
    if (path === '/api/tasks' && method === 'GET') return route.fulfill({ json: { tasks: [] } });
    if (path === '/api/agents/b1' && method === 'GET') return route.fulfill({ json: brunoCard });
    if (path === '/api/agents/s1' && method === 'GET') return route.fulfill({ json: sashaCard });
    if (path === '/api/agents/b1/events') return route.fulfill({ json: { events: [], state: { ready: true, reason: null, busy: true, runningJobId: 'j1', queued: 0, terminal: false } } });
    if (path === '/api/agents/s1/events') return route.fulfill({ json: { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: false } } });
    if (path === '/api/agents/b1/inbox' || path === '/api/agents/s1/inbox') {
      return route.fulfill({ json: { unreadCount: 0, total: 0, letters: [], more: false, mode: null, inheritedMode: 'inbox', effectiveMode: 'inbox', canChangeMode: false, canMarkRead: false } });
    }
    if (method !== 'GET') {
      mutations.push({ method, path, body });
      if (path === '/api/agents/b1/stop' && method === 'POST') return route.fulfill({ status: 202, json: {} });
      if (path === '/api/agents/b1' && method === 'PATCH') {
        const subId = body?.subscription as string | null | undefined;
        const picked = subId === null ? null : brunoCard.runsOn.find(r => r.subscription.id === subId)?.subscription ?? brunoCard.subscription;
        brunoCard = { ...brunoCard, subscription: picked };
        return route.fulfill({ json: brunoCard });
      }
      if (path === '/api/agents/b1/reset' && method === 'POST') return route.fulfill({ json: brunoCard });
      if (path === '/api/agents/b1' && method === 'DELETE') return route.fulfill({ status: 204 });
      if (path === '/api/agents/s1/telegram' && method === 'DELETE') {
        sashaCard = { ...sashaCard, telegram: null };
        return route.fulfill({ status: 204 });
      }
      if (path === '/api/departments/d2/teams/u1' && method === 'PATCH') return route.fulfill({ json: { team: { ...DEV.teams[0]!, name: String(body?.name ?? '') } } });
      if (path === '/api/departments/d2/teams/u1' && method === 'DELETE') return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await page.goto('/departments/d2');
  return mutations;
}

async function setupStructureProposal(page: Page, proposalId: string, items: StructureItem[]) {
  const mutations: Mutation[] = [];
  const proposalEvent: EventView = {
    seq: 1, kind: 'proposal', jobId: 'j1', person: null, at: '2026-11-21T00:00:00Z',
    data: { proposalId, brief: 'Update company structure.', items },
  };
  await serveMeta(page);
  await page.route('**/api/**', route => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;
    if (path === '/api/org' && method === 'GET') return route.fulfill({ json: ORG });
    if (path === '/api/agents/orchestrator/start' && method === 'POST') return route.fulfill({ json: { started: false } });
    if (path === '/api/agents/orchestrator/inbox' && method === 'GET') {
      return route.fulfill({ json: { unreadCount: 0, total: 0, letters: [], more: false, mode: null, inheritedMode: 'inbox', effectiveMode: 'inbox', canChangeMode: false, canMarkRead: false } });
    }
    if (path === '/api/agents/orchestrator/events' && method === 'GET') {
      return route.fulfill({ json: { events: [proposalEvent], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: false } } });
    }
    if (path === '/api/departments/build' && method === 'POST') {
      mutations.push({ method, path, body: req.postDataJSON() });
      return route.fulfill({ status: 201, json: { created: [], removed: [] } });
    }
    return route.fallback();
  });
  await page.goto('/tasks');
  await writeToOrchestrator(page, 'en');
  await expect(page.getByRole('heading', { name: 'Company structure' })).toBeVisible();
  return mutations;
}

test('confirms assistant rename, key replacement, and key revocation while keeping first-time key issue and unchanged-name save direct', async ({ page }) => {
  const errors = watchErrors(page);
  const mutations = await setupPeople(page);

  await page.getByRole('button', { name: 'Edit Ava', exact: true }).click();
  /* First-time Issue key runs directly without a confirmation dialog. */
  await page.getByRole('button', { name: 'Issue key', exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  await expect(page.getByText('hha_TESTKEY', { exact: true })).toBeVisible();
  expect(mutations).toEqual([{ method: 'POST', path: '/api/people/h1/key', body: undefined }]);
  await page.getByRole('button', { name: 'Hide key', exact: true }).click();

  /* Replace key opens confirmation, cancels cleanly, then confirms once. */
  await page.getByRole('button', { name: 'Replace key', exact: true }).click();
  await expect(question(page)).toHaveAccessibleName("Do you really want to replace this assistant's key?");
  await expect(question(page)).toHaveAccessibleDescription('The current key for Ava will stop working and a new one will be issued.');
  expect(await bdiTexts(page)).toEqual(['Ava']);
  await expect(question(page)).toContainText('This cannot be undone.');
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await question(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  expect(mutations).toHaveLength(1);

  await page.getByRole('button', { name: 'Replace key', exact: true }).click();
  await question(page).getByRole('button', { name: 'Replace key', exact: true }).click();
  await expect(page.getByText('hha_TESTKEY', { exact: true })).toBeVisible();
  expect(mutations.filter(m => m.method === 'POST' && m.path === '/api/people/h1/key')).toHaveLength(2);
  await page.getByRole('button', { name: 'Hide key', exact: true }).click();

  /* Revoke key opens confirmation, Escape cancels with zero DELETE, then confirms once. */
  await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
  await expect(question(page)).toHaveAccessibleName("Do you really want to revoke this assistant's key?");
  await expect(question(page)).toHaveAccessibleDescription('The key for Ava will stop working immediately.');
  expect(await bdiTexts(page)).toEqual(['Ava']);
  await expect(question(page)).toContainText('This cannot be undone.');
  await page.keyboard.press('Escape');
  await expect(question(page)).toHaveCount(0);
  expect(mutations.filter(m => m.method === 'DELETE')).toHaveLength(0);

  await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
  await question(page).getByRole('button', { name: 'Revoke key', exact: true }).click();
  await expect(page.getByText('No key yet.', { exact: true })).toBeVisible();
  expect(mutations.filter(m => m.method === 'DELETE' && m.path === '/api/people/h1/key')).toHaveLength(1);

  /* Saving without changing the assistant name runs directly. */
  await page.getByLabel('Title', { exact: true }).fill('Personal helper');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  await expect.poll(() => mutations.filter(m => m.method === 'PATCH')).toHaveLength(2);

  /* Renaming the assistant confirms with old and new names in <bdi>, cancels cleanly, then saves once. */
  await page.getByRole('button', { name: 'Edit Ava', exact: true }).click();
  await page.getByLabel('Assistant name', { exact: true }).fill('Nova');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(question(page)).toHaveAccessibleName('Do you really want to rename this assistant?');
  await expect(question(page)).toHaveAccessibleDescription('Ava will be renamed to Nova.');
  expect(await bdiTexts(page)).toEqual(['Ava', 'Nova']);
  await expect(question(page).getByRole('button', { name: 'Rename', exact: true })).toBeFocused();
  await question(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  expect(mutations.filter(m => m.method === 'PATCH')).toHaveLength(2);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await question(page).getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  await expect.poll(() => mutations.filter(m => m.method === 'PATCH')).toHaveLength(4);
  expect(errors).toEqual([]);
});

test('confirms stopping work (Stop button and Escape), disconnecting plan, resetting instructions, removing employee, and disconnecting Telegram bot', async ({ page }) => {
  const errors = watchErrors(page);
  const mutations = await setupDepartment(page);

  /* Open Bruno's window and verify Stop via button and Escape. */
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
  const brunoWindow = page.getByRole('complementary', { name: /^Bruno,/ });
  await expect(brunoWindow).toBeVisible();

  await brunoWindow.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(question(page)).toHaveAccessibleName('Do you really want to stop current work?');
  await expect(question(page)).toHaveAccessibleDescription('Bruno will stop its current turn right away.');
  expect(await bdiTexts(page)).toEqual(['Bruno']);
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await question(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(mutations.filter(m => m.path.endsWith('/stop'))).toHaveLength(0);

  await brunoWindow.getByRole('button', { name: 'Stop', exact: true }).click();
  await question(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => mutations.filter(m => m.path.endsWith('/stop'))).toHaveLength(1);
  await expect(question(page)).toHaveCount(0);

  /* Escape opens confirmation; a second Escape dismisses ONLY the dialog without sending /stop. */
  await brunoWindow.focus();
  await page.keyboard.press('Escape');
  await expect(question(page)).toHaveAccessibleName('Do you really want to stop current work?');
  expect(mutations.filter(m => m.path.endsWith('/stop'))).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(question(page)).toHaveCount(0);
  expect(mutations.filter(m => m.path.endsWith('/stop'))).toHaveLength(1);
  await brunoWindow.focus();
  await page.keyboard.press('Escape');
  await question(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => mutations.filter(m => m.path.endsWith('/stop'))).toHaveLength(2);
  await expect(question(page)).toHaveCount(0);

  /* Open Bruno's card: switching plans is direct, disconnecting confirms and keeps select controlled on Cancel. */
  await brunoWindow.getByRole('button', { name: 'Card', exact: true }).click();
  const brunoCard = brunoWindow.getByRole('complementary', { name: 'Card: Bruno', exact: true });
  const runsOn = brunoCard.getByRole('combobox', { name: 'Runs on', exact: true });
  await expect(runsOn).toHaveValue('s-key');
  await runsOn.selectOption('s-codex');
  await expect(question(page)).toHaveCount(0);
  await expect.poll(() => mutations.filter(m => m.method === 'PATCH' && m.path === '/api/agents/b1')).toHaveLength(1);
  await runsOn.selectOption('s-key');
  await expect.poll(() => mutations.filter(m => m.method === 'PATCH' && m.path === '/api/agents/b1')).toHaveLength(2);

  await runsOn.selectOption('');
  await expect(question(page)).toHaveAccessibleName('Do you really want to disconnect this plan?');
  await expect(question(page)).toHaveAccessibleDescription('Bruno will be disconnected from Team key (Anthropic) and will stop taking turns until another plan is chosen.');
  expect(await bdiTexts(page)).toEqual(['Bruno', 'Team key (Anthropic)']);
  await expect(runsOn).toHaveValue('s-key');
  await question(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(runsOn).toHaveValue('s-key');
  expect(mutations.filter(m => m.method === 'PATCH' && m.path === '/api/agents/b1')).toHaveLength(2);

  await runsOn.selectOption('');
  await question(page).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect.poll(() => mutations.filter(m => m.method === 'PATCH' && m.path === '/api/agents/b1')).toHaveLength(3);
  await expect(question(page)).toHaveCount(0);
  expect(mutations.filter(m => m.method === 'PATCH' && m.path === '/api/agents/b1').at(-1)?.body).toEqual({ subscription: null });
  await expect(runsOn).toHaveValue('');

  /* Reset to template confirms, cancels cleanly, then sends POST /reset once. */
  await brunoCard.getByRole('button', { name: 'Reset to template', exact: true }).click();
  await expect(question(page)).toHaveAccessibleName('Do you really want to reset these instructions?');
  await expect(question(page)).toHaveAccessibleDescription("Bruno's skills and effort choice will be reset to the template.");
  expect(await bdiTexts(page)).toEqual(['Bruno']);
  await expect(question(page)).toContainText('Its assignment is kept.');
  await expect(question(page)).toContainText('This cannot be undone.');
  await question(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  expect(mutations.filter(m => m.path.endsWith('/reset'))).toHaveLength(0);

  await brunoCard.getByRole('button', { name: 'Reset to template', exact: true }).click();
  await question(page).getByRole('button', { name: 'Reset', exact: true }).click();
  await expect.poll(() => mutations.filter(m => m.path.endsWith('/reset'))).toHaveLength(1);
  await expect(question(page)).toHaveCount(0);

  /* Remove employee confirms naming employee and department in <bdi>, Escape cancels, then DELETE sends once. */
  await brunoCard.getByRole('button', { name: 'Remove from the company', exact: true }).click();
  await expect(question(page)).toHaveAccessibleName('Do you really want to remove this employee?');
  await expect(question(page)).toHaveAccessibleDescription('Bruno will be removed from Development.');
  expect(await bdiTexts(page)).toEqual(['Bruno', 'Development']);
  await expect(question(page)).toContainText('Its conversation stays in the history.');
  await expect(question(page)).toContainText('This cannot be undone.');
  await page.keyboard.press('Escape');
  await expect(question(page)).toHaveCount(0);
  expect(mutations.filter(m => m.method === 'DELETE' && m.path === '/api/agents/b1')).toHaveLength(0);

  await brunoCard.getByRole('button', { name: 'Remove from the company', exact: true }).click();
  await question(page).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(() => mutations.filter(m => m.method === 'DELETE' && m.path === '/api/agents/b1')).toHaveLength(1);
  await expect(brunoWindow).toHaveCount(0);

  /* Open head Sasha's card and verify Telegram bot disconnect confirmation. */
  await page.getByRole('region', { name: 'Head' }).getByRole('button', { name: /Sasha/ }).click();
  const sashaWindow = page.getByRole('complementary', { name: /^Sasha,/ });
  await sashaWindow.getByRole('button', { name: 'Card', exact: true }).click();
  const sashaCard = sashaWindow.getByRole('complementary', { name: 'Card: Sasha', exact: true });
  const bot = sashaCard.getByRole('region', { name: 'Telegram bot', exact: true });
  await bot.getByRole('button', { name: 'Remove bot', exact: true }).click();
  await expect(question(page)).toHaveAccessibleName('Do you really want to disconnect this Telegram bot?');
  await expect(question(page)).toHaveAccessibleDescription('@acme_dev_bot will be disconnected from Sasha. Telegram messages will stop reaching them.');
  expect(await bdiTexts(page)).toEqual(['@acme_dev_bot', 'Sasha']);
  await page.keyboard.press('Escape');
  await expect(question(page)).toHaveCount(0);
  expect(mutations.filter(m => m.path === '/api/agents/s1/telegram')).toHaveLength(0);

  await bot.getByRole('button', { name: 'Remove bot', exact: true }).click();
  await question(page).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect.poll(() => mutations.filter(m => m.method === 'DELETE' && m.path === '/api/agents/s1/telegram')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('confirms sub-unit rename and deletion in About the department while closing unchanged rename directly', async ({ page }) => {
  const errors = watchErrors(page);
  const mutations = await setupDepartment(page);

  await page.getByRole('button', { name: 'About the department', exact: true }).click();
  const subUnits = page.getByRole('region', { name: 'Sub-units', exact: true });
  await expect(subUnits).toBeVisible();

  /* Unchanged sub-unit name closes rename mode without confirmation or PATCH. */
  await subUnits.getByRole('button', { name: 'Rename', exact: true }).click();
  await subUnits.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  await expect(subUnits.getByLabel('Sub-unit name', { exact: true })).toHaveCount(0);
  expect(mutations).toEqual([]);

  /* Changed sub-unit name confirms with team, department, and new name in <bdi>, cancels cleanly, then patches once. */
  await subUnits.getByRole('button', { name: 'Rename', exact: true }).click();
  await subUnits.getByLabel('Sub-unit name', { exact: true }).fill('Fast lane');
  await subUnits.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(question(page)).toHaveAccessibleName('Do you really want to rename this sub-unit?');
  await expect(question(page)).toHaveAccessibleDescription('Urgent fixes in Development will be renamed to Fast lane.');
  expect(await bdiTexts(page)).toEqual(['Urgent fixes', 'Development', 'Fast lane']);
  await expect(question(page).getByRole('button', { name: 'Rename', exact: true })).toBeFocused();
  await question(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(mutations).toEqual([]);

  await subUnits.getByRole('button', { name: 'Save', exact: true }).click();
  await question(page).getByRole('button', { name: 'Rename', exact: true }).click();
  await expect.poll(() => mutations.filter(m => m.method === 'PATCH' && m.path === '/api/departments/d2/teams/u1')).toHaveLength(1);
  expect(mutations[0]?.body).toEqual({ name: 'Fast lane' });

  /* Delete sub-unit confirms as danger+final, Escape cancels, then DELETE sends once. */
  await subUnits.getByRole('button', { name: 'Delete sub-unit', exact: true }).click();
  await expect(question(page)).toHaveAccessibleName('Do you really want to delete this sub-unit?');
  await expect(question(page)).toHaveAccessibleDescription("Urgent fixes will be deleted from Development. Its employees will return to the department's pipeline.");
  expect(await bdiTexts(page)).toEqual(['Urgent fixes', 'Development']);
  await expect(question(page)).toContainText('This cannot be undone.');
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(question(page)).toHaveCount(0);
  expect(mutations.filter(m => m.method === 'DELETE')).toHaveLength(0);

  await subUnits.getByRole('button', { name: 'Delete sub-unit', exact: true }).click();
  await question(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => mutations.filter(m => m.method === 'DELETE' && m.path === '/api/departments/d2/teams/u1')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('applies brand-new structure proposals directly without confirmation', async ({ page }) => {
  const errors = watchErrors(page);
  const newMutations = await setupStructureProposal(page, 'pr-new', [
    { template: 'support', checked: true, note: 'Help customers' },
  ]);
  await page.getByRole('button', { name: 'Create departments (1)', exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  await expect.poll(() => newMutations).toHaveLength(1);
  await expect(page.getByText('Applied', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('confirms existing-department changes and removals in structure proposals', async ({ page }) => {
  const errors = watchErrors(page);
  const changeMutations = await setupStructureProposal(page, 'pr-change', [
    { department: 'd2', checked: true, note: 'Add product', products: ['Mobile'] },
    { department: 'd9', checked: true, note: 'Drop', remove: true },
  ]);
  await page.getByRole('button', { name: 'Apply changes (2)', exact: true }).click();
  await expect(question(page)).toHaveAccessibleName('Do you really want to apply these structure changes?');
  await expect(question(page)).toHaveAccessibleDescription('Development will be updated (products: Mobile).');
  await expect(question(page)).toContainText('Finance will be removed from the company.');
  expect(await bdiTexts(page)).toEqual(['Development', 'Mobile', 'Finance']);
  await expect(question(page)).toContainText('This cannot be undone.');
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await question(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(changeMutations).toEqual([]);

  await page.getByRole('button', { name: 'Apply changes (2)', exact: true }).click();
  await question(page).getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect.poll(() => changeMutations).toHaveLength(1);
  await expect(page.getByText('Applied', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
