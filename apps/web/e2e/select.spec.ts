import { expect, test, type Locator, type Page } from '@playwright/test';
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

const SUB = {
  id: 's-claude',
  provider: 'claude' as const,
  kind: 'personal' as const,
  label: 'Claude personal subscription with a very long display label',
  last4: null,
  status: 'ready' as const,
  online: true,
  owner: { id: 'p1', name: 'Ivan' },
  place: { kind: 'company' as const, id: null, name: 'Whole company' },
  limits: {
    status: 'allowed' as const,
    windows: [{ name: 'five_hour' as const, utilization: 0.42, resetsAt: '2099-10-29T18:00:00.000Z' }],
  },
  budget: 80,
  isOrchestrator: false,
  accounts: [],
  tier: 'max' as const,
  accountsDiffer: false,
  signedInOnce: true,
  leaseMachine: null,
  machines: [{ id: 'm1', hostname: 'ivan-mbp', status: 'ready' as const, online: true }],
  agents: [],
};

const HEAD_TITLE = { en: 'Head of development', ru: 'Руководитель разработки' };
const BE_TITLE = { en: 'Backend engineer', ru: 'Бэкенд-разработчик' };

const HEAD = {
  id: 'b0',
  name: 'Dana',
  roleId: 'DEV-HEAD',
  title: HEAD_TITLE,
  kind: 'head' as const,
  model: '',
  modelName: null,
  provider: 'claude' as const,
  effort: null,
  state: 'sleeping' as const,
  status: 'idle' as const,
  on: true,
  timer: null,
  task: null,
  context: null,
};

const EMPLOYEE = {
  id: 'b1',
  name: 'Bruno',
  roleId: 'DEV-BE',
  title: BE_TITLE,
  kind: 'worker' as const,
  model: 'claude-sonnet-5-5',
  modelName: 'Claude Sonnet 5.5',
  provider: 'claude' as const,
  effort: 'high',
  state: 'sleeping' as const,
  status: 'idle' as const,
  on: true,
  timer: { everyHours: 2, order: 'Check PRs', forWork: false, lastAt: null },
  task: null,
  context: null,
};

const SONNET = { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (long model display name for mobile check)', efforts: ['low', 'high', 'max'] };

async function serveSelectScreens(page: Page) {
  await serveApi(page);
  await page.route('**/api/org', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        company: ME.company,
        orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: SUB, context: null },
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
      }),
    }),
  );
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
        computerAccess: null,
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
      body: JSON.stringify({
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
        skills: [],
        parts: [],
        raw: '',
        instructions: { length: 100, max: 200_000 },
        runsOn: [{ subscription: SUB, models: [SONNET] }],
        changes: [],
        interrupted: [],
        timer: EMPLOYEE.timer,
        canEdit: true,
      }),
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

test('keeps the department select, its arrow and the search box inside a 375 px phone screen and preserves 1280 px layout when a department name is long', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await serveSelectScreens(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Tasks/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();

  const deptSelect = page.getByLabel('Department');
  const search = page.getByLabel('Search tasks');

  for (const value of ['', LONG_DEPT.id]) {
    if (value) await deptSelect.selectOption(value);
    const sBox = await expectSelectInsideViewport(deptSelect, 375);
    const qBox = await box(search);
    expect(sBox.x).toBe(16);
    expect(sBox.x + sBox.width).toBe(359);
    expect(qBox.x).toBe(16);
    expect(qBox.x + qBox.width).toBe(359);
  }

  /* StaffCard selects on Tasks screen */
  const staffSelects = page.locator('.staff-pick select');
  await expect(staffSelects).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expectSelectInsideViewport(staffSelects.nth(i), 375);
  }

  /* Subscriptions select.sel */
  await page.getByRole('button', { name: 'Subscriptions' }).click();
  await page.getByRole('button', { name: /Claude/ }).click();
  const subSelect = page.locator('select.sel');
  await expectSelectInsideViewport(subSelect, 375);

  /* Department NewTask select and AgentCard selects (3 in .ac-pick + 1 in .ac-timer) */
  await page.getByRole('button', { name: 'Map' }).click();
  await page.getByRole('button', { name: new RegExp(LONG_DEPT.name) }).click();
  await page.getByRole('button', { name: 'Department tasks' }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expectSelectInsideViewport(page.locator('.new-task select'), 375);

  await page.locator('.dv-drawer .zbtn').click();
  await page.getByRole('button', { name: /Bruno/ }).click();
  await page.getByRole('button', { name: 'Card', exact: true }).click();
  const cardSelects = page.locator('.acard select');
  await expect(cardSelects).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expectSelectInsideViewport(cardSelects.nth(i), 375);
  }

  /* Desktop 1280x800 layout on Tasks keeps filter and search side by side */
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Tasks/ }).click();
  const dBox1280 = await expectSelectInsideViewport(deptSelect, 1280);
  const qBox1280 = await box(search);
  expect(dBox1280.y).toBe(qBox1280.y);
  expect(dBox1280.x + dBox1280.width).toBeLessThan(qBox1280.x);
});
