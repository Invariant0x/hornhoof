import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AgentCardView, Employee, Org, SubView } from '../src/types';
import { box, ME, serveApi, TASKS } from './api';

test.use({ locale: 'en-US' });

const LONG_DEPT = {
  id: 'd-long',
  name: 'Research and development with a long department name',
};

const LONG_PRODUCT = {
  id: 'prod-long',
  name: 'Enterprise autonomous multi-region cloud orchestration platform',
};

const SUB: SubView = {
  id: 's-claude',
  provider: 'claude',
  kind: 'personal',
  label: 'Claude personal subscription with a very long display label',
  last4: null,
  status: 'ready',
  online: true,
  owner: { id: 'p1', name: 'Ivan' },
  place: { kind: 'company', id: null, name: 'Whole company' },
  limits: {
    status: 'allowed',
    windows: [{ name: 'five_hour', utilization: 0.42, resetsAt: '2099-10-29T18:00:00.000Z' }],
  },
  budget: 80,
  isOrchestrator: false,
  accounts: [],
  tier: 'max',
  accountsDiffer: false,
  signedInOnce: true,
  leaseMachine: null,
  machines: [{ id: 'm1', hostname: 'dev-laptop', status: 'ready', online: true }],
  agents: [],
};

const HEAD_TITLE = { en: 'Head of development', ru: 'Руководитель разработки' };
const BE_TITLE = { en: 'Backend engineer', ru: 'Бэкенд-разработчик' };

const HEAD: Employee = {
  id: 'b0',
  name: 'Dana',
  roleId: 'DEV-HEAD',
  title: HEAD_TITLE,
  kind: 'head',
  model: '',
  modelName: null,
  provider: 'claude',
  effort: null,
  state: 'sleeping',
  status: 'idle',
  on: true,
  timer: null,
  task: null,
  context: null,
  program: null,
  alarm: null,
  retry: null,
  failure: null,
};

const EMPLOYEE: Employee = {
  id: 'b1',
  name: 'Bruno',
  roleId: 'DEV-BE',
  title: BE_TITLE,
  kind: 'worker',
  model: 'claude-sonnet-5-5',
  modelName: 'Claude Sonnet 5.5',
  provider: 'claude',
  effort: 'high',
  state: 'sleeping',
  status: 'idle',
  on: true,
  timer: 120,
  task: null,
  context: null,
  program: null,
  alarm: null,
  retry: null,
  failure: null,
};

const SONNET = { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (long model display name for mobile check)', efforts: ['low', 'high', 'max'] };

const ORG_VIEW: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: SUB, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 1, working: 0 },
  people: [],
  departments: [
    {
      id: LONG_DEPT.id,
      name: LONG_DEPT.name,
      templateKey: 'development',
      roleCode: 'CTO',
      about: '',
      agents: { total: 1, working: 0 },
      products: [LONG_PRODUCT],
      teams: [],
      people: [],
      employees: [HEAD, EMPLOYEE],
      roles: [
        {
          id: 'DEV-HEAD',
          title: HEAD_TITLE,
          description: { en: 'Leads development.', ru: 'Ведет разработку.' },
          kind: 'head',
          gate: null,
        },
        {
          id: 'DEV-BE',
          title: BE_TITLE,
          description: { en: 'Builds the server side.', ru: 'Делает серверную часть.' },
          kind: 'member',
          gate: null,
        },
      ],
    },
  ],
};

const BRUNO_CARD: AgentCardView = {
  currentTask: null,
  id: 'b1',
  kind: 'worker',
  name: 'Bruno',
  role: { id: 'DEV-BE', title: BE_TITLE, description: { en: 'Builds the API.', ru: 'Строит API.' }, effort: 'xhigh' },
  department: LONG_DEPT,
  product: null,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  subscription: SUB,
  machine: null,
  state: 'sleeping',
  program: null,
  alarm: null,
  retry: null,
  failure: null,
  skills: [],
  parts: [],
  raw: '',
  runsOn: [{ subscription: SUB, models: [SONNET] }],
  changes: [],
  interrupted: [],
  timer: { minutes: 120, order: 'Check PRs', forWork: false, lastAt: null },
  canEdit: true,
  canRemove: true,
};

async function serveSelectScreens(page: Page) {
  await serveApi(page);
  await page.route('**/api/org', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ORG_VIEW),
    }),
  );
  await page.route('**/api/task-departments', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ whole: true, mayPlanCompany: true, departments: [{ id: LONG_DEPT.id, name: LONG_DEPT.name, templateKey: null, mine: true, mayPlan: true }] }),
    }),
  );
  await page.route('**/api/departments/*/backlog', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
  await page.route('**/api/tasks?*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: TASKS.map(t => ({ ...t, department: LONG_DEPT })) }),
    }),
  );
  await page.route('**/api/requests', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        requests: [],
        proposals: [
          {
            id: 'prop-staff',
            kind: 'staff',
            brief: 'Hire the backend engineer.',
            department: LONG_DEPT,
            ownerPersonId: 'p1',
            items: [{ role: 'DEV-BE', name: 'Backend engineer', product: null, model: '', subscription: 's-claude', skills: [] }],
          },
        ],
        machineAccess: [],
        counts: { byPerson: { p1: 1 }, byAgent: {}, total: 1 },
      }),
    }),
  );
  await page.route(`**/api/departments/${LONG_DEPT.id}/roster`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        people: [{ role: 'DEV-BE', name: 'Backend engineer', product: null, model: '', subscription: 's-claude', skills: [] }],
        roles: [{ id: 'DEV-BE', title: BE_TITLE, kind: 'member', tier: 'standard', perProduct: false, skills: [], subscription: 's-claude' }],
        products: [LONG_PRODUCT],
        subscriptions: [{ id: 's-claude', provider: 'claude', kind: 'personal', label: SUB.label, owner: 'Ivan', models: [SONNET] }],
      }),
    }),
  );
  await page.route('**/api/subscriptions', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ subscriptions: [SUB] }),
    }),
  );
  await page.route('**/api/agents/b1', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(BRUNO_CARD),
    }),
  );
}

async function expectSelectInsideViewport(select: Locator, viewportWidth: number) {
  await expect(select).toBeVisible();
  const b = await box(select);
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(viewportWidth);
  const style = await select.evaluate(el => {
    const cs = getComputedStyle(el);
    return {
      appearance: cs.appearance,
      textOverflow: cs.textOverflow,
      overflowX: cs.overflowX,
      backgroundPosition: cs.backgroundPosition,
      paddingRight: parseFloat(cs.paddingRight),
    };
  });
  expect(style.appearance).toBe('none');
  expect(style.textOverflow).toBe('ellipsis');
  expect(['hidden', 'clip']).toContain(style.overflowX);
  expect(style.backgroundPosition).toContain('calc(100% - 15px)');
  expect(style.paddingRight).toBeGreaterThanOrEqual(28);
  return b;
}

/* The choice of a department wraps a long name inside the page, as wide as the search box under it; on a phone both run
   from gutter to gutter. */
async function expectChoiceInside(page: Page, phone: boolean) {
  const choice = await box(page.getByRole('combobox', { name: 'Department' }));
  const search = await box(page.getByLabel('Search tasks'));
  if (phone) {
    /* On a phone each stays inside the screen's 16 px edges. */
    for (const b of [choice, search]) {
      expect(b.x).toBeGreaterThanOrEqual(16);
      expect(b.x + b.width).toBeLessThanOrEqual(359);
    }
  } else {
    /* At a desk neither goes past the screen nor over the other. */
    for (const b of [choice, search]) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    const apart = choice.y + choice.height <= search.y || search.y + search.height <= choice.y || choice.x + choice.width <= search.x || search.x + search.width <= choice.x;
    expect(apart).toBe(true);
  }
  expect(await page.getByRole('main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
}

test('keeps the department choice and the search box inside a 375 px phone screen and a 1280 px one when a department name is long', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await serveSelectScreens(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Tasks/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible();

  /* StaffCard selects in what waits for the person */
  const staffSelects = page.locator('.staff-pick select');
  await expect(staffSelects).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expectSelectInsideViewport(staffSelects.nth(i), 375);
  }

  /* The department choice of the turns and releases: a long name stays inside it, as does the search box. */
  await page.goto('/tasks?show=turns');
  const department = page.getByRole('combobox', { name: 'Department' });
  for (const name of [LONG_DEPT.name, "The orchestrator's own work"]) {
    await department.selectOption({ label: name });
    await expect(department.locator('option:checked')).toHaveText(name);
    await expectChoiceInside(page, true);
  }

  /* Subscriptions select.sel */
  await page.getByRole('button', { name: 'Subscriptions & API' }).click();
  await page.getByRole('button', { name: /Claude/ }).click();
  const subSelect = page.locator('select.sel');
  await expectSelectInsideViewport(subSelect, 375);

  /* Department NewTask select and AgentCard selects (3 in .ac-pick + 1 in .ac-timer) */
  await page.getByRole('button', { name: 'Map' }).click();
  await page.getByRole('button', { name: new RegExp(`^${LONG_DEPT.name}`) }).click();
  await page.getByRole('button', { name: 'Department tasks' }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expectSelectInsideViewport(page.locator('.new-task select'), 375);

  await page.goBack();
  await page.getByRole('button', { name: /Bruno/ }).click();
  await page.getByRole('button', { name: 'Card', exact: true }).click();
  const cardSelects = page.locator('.acard select');
  await expect(cardSelects).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expectSelectInsideViewport(cardSelects.nth(i), 375);
  }

  /* Desktop 1280x800 layout on Tasks */
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tasks?show=turns');
  await page.getByRole('combobox', { name: 'Department' }).selectOption({ label: LONG_DEPT.name });
  await expectChoiceInside(page, false);
});
