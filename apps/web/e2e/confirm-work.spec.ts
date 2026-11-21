import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import type { ApprovalPolicyView, BacklogItem, Decisions, MergeConflict, NoteView, Org, Pipeline } from '../src/types';
import { openAgent } from './agent-window-panels-api';
import { detail, ME, openTaskAction, serveApi, TASKS } from './api';

test.use({ locale: 'en-US' });

const question = (page: Page) => page.getByRole('alertdialog');

async function cancelAndEscape(page: Page, trigger: () => Promise<unknown>, expectZero: () => void) {
  await trigger();
  await expect(question(page)).toHaveCount(1);
  await question(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  expectZero();

  await trigger();
  await expect(question(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(question(page)).toHaveCount(0);
  expectZero();
}

async function confirmYes(page: Page, verb: string) {
  await question(page).getByRole('button', { name: verb, exact: true }).click();
  await expect(question(page)).toHaveCount(0);
}

const bdis = (dialog: Locator) => dialog.locator('bdi').allTextContents();

test('confirms cancelling, pausing, and hiding a secret in TaskPanel', async ({ page }) => {
  await serveApi(page);
  const mutations: { method: string; path: string; body?: unknown }[] = [];
  const task = { ...detail(TASKS[0]!), body: 'SecretToken9876!', mayPause: true, mayHideSecret: true };
  await page.route('**/api/tasks/t1**', route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'GET' && path === '/api/tasks/t1') return route.fulfill({ json: { task } });
    if (req.method() !== 'GET') {
      mutations.push({ method: req.method(), path, body: req.postDataJSON() });
      return route.fulfill({ json: { task } });
    }
    return route.fallback();
  });

  await page.goto('/tasks/t1');
  const panel = page.getByRole('complementary', { name: '#1 Checkout step 1' });
  await expect(panel).toBeVisible();

  /* Hide secret: never puts secret text in the confirmation dialog. */
  await openTaskAction(panel, en, en.tasks.hideSecret.action);
  const secretInput = panel.getByLabel(en.tasks.hideSecret.value);
  await secretInput.fill('SecretToken9876!');
  const submitSecret = () => panel.getByRole('button', { name: en.tasks.hideSecret.confirm, exact: true }).click();
  await cancelAndEscape(page, submitSecret, () => expect(mutations).toEqual([]));
  await expect(secretInput).toHaveValue('SecretToken9876!');
  await submitSecret();
  await expect(question(page)).toHaveAccessibleName(en.tasks.confirm.hideSecret.title);
  expect(await bdis(question(page))).toEqual(['#1 Checkout step 1']);
  await expect(question(page)).toContainText(en.confirm.final);
  await expect(question(page)).not.toContainText('SecretToken9876!');
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmYes(page, en.tasks.confirm.hideSecret.yes);
  await expect.poll(() => mutations).toEqual([{ method: 'POST', path: '/api/tasks/t1/hide-secret', body: { value: 'SecretToken9876!' } }]);

  /* Pause task: keeps typed reason on Cancel and Escape. */
  mutations.length = 0;
  await panel.getByRole('button', { name: en.tasks.pause, exact: true }).click();
  const reason = panel.getByRole('textbox', { name: en.tasks.pauseWhy });
  await reason.fill('Wait for release.');
  const submitPause = () => panel.getByRole('button', { name: en.tasks.yesPause, exact: true }).click();
  await cancelAndEscape(page, submitPause, () => expect(mutations).toEqual([]));
  await expect(reason).toHaveValue('Wait for release.');
  await submitPause();
  await expect(question(page)).toHaveAccessibleName(en.tasks.confirm.pause.title);
  expect(await bdis(question(page))).toEqual(['#1 Checkout step 1']);
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmYes(page, en.tasks.confirm.pause.yes);
  await expect.poll(() => mutations).toEqual([{ method: 'PUT', path: '/api/tasks/t1/paused', body: { paused: true, reason: 'Wait for release.' } }]);

  /* Cancel task from TaskMenu. */
  mutations.length = 0;
  await openTaskAction(panel, en, en.tasks.cancelTask);
  await expect(question(page)).toHaveAccessibleName(en.tasks.confirm.cancel.title);
  expect(await bdis(question(page))).toEqual(['#1 Checkout step 1']);
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await question(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(question(page)).toHaveCount(0);
  expect(mutations).toEqual([]);
  await panel.getByRole('button', { name: en.tasks.cancelTask, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(question(page)).toHaveCount(0);
  await expect(panel).toBeVisible();
  expect(mutations).toEqual([]);
  await panel.getByRole('button', { name: en.tasks.cancelTask, exact: true }).click();
  await confirmYes(page, en.tasks.confirm.cancel.yes);
  await expect.poll(() => mutations).toEqual([{ method: 'POST', path: '/api/tasks/t1/cancel', body: {} }]);
});

test('confirms cancelling a stuck task in Requests and applying merge decisions in MergeCard', async ({ page }) => {
  await serveApi(page);
  const mutations: { method: string; path: string; body?: unknown }[] = [];
  const merge = { id: 'm1', label: 'office-pc', after: null, open: 2, ownerPersonId: ME.person.id };
  const conflicts: MergeConflict[] = [
    {
      id: 'c1', merge: 'm1', label: 'office-pc', table: 'people', topic: 'people', what: 'Maria (maria@acme.test)', kind: 'differs', cols: ['name'],
      here: { name: '"Maria Here"' }, there: { name: '"Maria There"' }, at: null, task: null, whose: 'ceo', picked: null,
    },
    {
      id: 'c2', merge: 'm1', label: 'office-pc', table: 'machines', topic: 'machines', what: 'dev-box', kind: 'differs', cols: ['hostname'],
      here: { hostname: '"dev-box"' }, there: { hostname: '"dev-box-2"' }, at: null, task: null, whose: 'ceo', picked: null,
    },
  ];
  const decisions: Decisions = {
    requests: [{
      id: 'r-stuck', kind: 'stuck', text: 'Stuck', commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false,
      at: '2026-11-10T09:00:00.000Z', agent: { id: 'b1', name: 'Bruno' }, task: { id: 't1', number: 1, title: 'Checkout step 1', department: { id: 'd2', name: 'Development' } },
      ownerPersonId: ME.person.id, canAnswer: true,
    }],
    proposals: [],
    machineAccess: [],
    merges: [merge],
    counts: { byPerson: { [ME.person.id]: 2 }, byAgent: { b1: 1 }, total: 2 },
  };
  await page.route('**/api/**', route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/requests') return route.fulfill({ json: decisions });
    if (path === '/api/merges/m1/conflicts') return route.fulfill({ json: { conflicts } });
    if (path === '/api/tasks/t1/cancel' && req.method() === 'POST') {
      mutations.push({ method: 'POST', path, body: req.postDataJSON() });
      return route.fulfill({ json: {} });
    }
    if (path === '/api/merges/pick' && req.method() === 'POST') {
      mutations.push({ method: 'POST', path, body: req.postDataJSON() });
      return route.fulfill({ json: { settled: 1, here: 1, there: 0, refused: [], tasks: [] } });
    }
    return route.fallback();
  });

  await page.goto('/tasks?show=waits');

  /* Stuck task cancel preserves draft text on Cancel and Escape. */
  const stuckCard = page.getByRole('article', { name: '#1 Checkout step 1' });
  const draft = stuckCard.getByLabel(en.tasks.yourAnswer);
  await draft.fill('Try restarting the worker');
  const clickCancel = () => stuckCard.getByRole('button', { name: en.tasks.cancelTask, exact: true }).click();
  await cancelAndEscape(page, clickCancel, () => expect(mutations).toEqual([]));
  await expect(draft).toHaveValue('Try restarting the worker');
  await clickCancel();
  expect(await bdis(question(page))).toEqual(['#1 Checkout step 1']);
  await confirmYes(page, en.tasks.confirm.cancel.yes);
  await expect.poll(() => mutations).toEqual([{ method: 'POST', path: '/api/tasks/t1/cancel', body: {} }]);

  /* MergeCard: all four actions confirm with conflict/section and merge title in <bdi>. */
  const card = page.getByRole('region', { name: 'office-pc' });
  const people = card.getByRole('group', { name: 'People' });
  const maria = people.getByRole('group', { name: 'Maria (maria@acme.test)' });
  const machines = card.getByRole('group', { name: 'Machines' });

  for (const [label, trigger, expectedBdis, expectedBody] of [
    ['keepHere', () => maria.getByRole('button', { name: en.merge.keepHere, exact: true }).click(), ['Maria (maria@acme.test)', 'office-pc'], { ids: ['c1'], take: 'here' }],
    ['takeThere', () => maria.getByRole('button', { name: en.merge.takeThere, exact: true }).click(), ['Maria (maria@acme.test)', 'office-pc'], { ids: ['c1'], take: 'there' }],
    ['keepAll', () => people.getByRole('button', { name: en.merge.keepAll, exact: true }).click(), ['People', 'office-pc'], { merge: 'm1', table: 'people', take: 'here' }],
    ['takeAll', () => machines.getByRole('button', { name: en.merge.takeAll, exact: true }).click(), ['Machines', 'office-pc'], { merge: 'm1', table: 'machines', take: 'there' }],
  ] as const) {
    mutations.length = 0;
    await cancelAndEscape(page, trigger, () => expect(mutations, label).toEqual([]));
    await expect(card).toBeVisible();
    await trigger();
    expect(await bdis(question(page)), label).toEqual([...expectedBdis]);
    await expect(question(page)).toContainText(en.confirm.final);
    await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await confirmYes(page, en.merge.confirm.yes);
    await expect.poll(() => mutations, { message: label }).toEqual([{ method: 'POST', path: '/api/merges/pick', body: expectedBody }]);
  }
});

test('confirms removing a saved pipeline stage and deleting a backlog item', async ({ page }) => {
  await serveApi(page);
  const mutations: { method: string; path: string; body?: unknown }[] = [];
  const org: Org = {
    company: ME.company,
    orchestrator: null,
    agents: { total: 1, working: 0 },
    people: [],
    departments: [{
      id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', agents: { total: 1, working: 0 },
      products: [], teams: [], people: [],
      employees: [{ id: 'b0', kind: 'head', name: 'Dana', roleId: 'DEV-HEAD', title: { en: 'Head', ru: 'Глава' }, model: 'claude-sonnet-4-6', modelName: null, provider: 'claude', effort: null, state: 'sleeping', on: true, timer: null, status: 'idle', task: null, context: null, teamId: null, program: null, alarm: null, retry: null, failure: null }],
      roles: [
        { id: 'DEV-BE', kind: 'member', title: { en: 'Developer', ru: 'Разработчик' }, description: { en: '', ru: '' }, gate: null },
        { id: 'DEV-HEAD', kind: 'head', title: { en: 'Head', ru: 'Глава' }, description: { en: '', ru: '' }, gate: null },
      ],
    }],
  };
  const pipeline: Pipeline = {
    id: 'pl1', department: { id: 'd2', name: 'Development' }, name: 'Flow', why: '', archived: false, version: 1, mayEdit: true,
    stages: [
      { id: 's1', parentId: null, name: 'Build', ownerRole: 'DEV-BE', owner: null, position: 0 },
      { id: 's2', parentId: 's1', name: 'Check', ownerRole: 'DEV-HEAD', owner: null, position: 0 },
    ],
  };
  let backlog: BacklogItem[] = [{ id: 'i1', departmentId: 'd2', title: 'Price page', text: 'List plans.', by: { id: 'p1', name: 'Ivan' }, at: '2026-11-10T09:00:00.000Z' }];
  await page.route('**/api/**', route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/org') return route.fulfill({ json: org });
    if (path === '/api/pipelines') return route.fulfill({ json: { pipelines: [pipeline] } });
    if (path === '/api/pipelines/pl1' && req.method() === 'PATCH') {
      mutations.push({ method: 'PATCH', path, body: req.postDataJSON() });
      return route.fulfill({ json: { pipeline } });
    }
    if (path === '/api/departments/d2/backlog') return route.fulfill({ json: { items: backlog } });
    if (path === '/api/departments/d2/backlog/i1' && req.method() === 'DELETE') {
      mutations.push({ method: 'DELETE', path });
      backlog = [];
      return route.fulfill({ json: { items: [] } });
    }
    return route.fallback();
  });

  /* PipelineForm: removing a saved stage confirms before PATCH. */
  await page.goto('/tasks?department=d2&pipeline=pl1');
  await page.getByRole('button', { name: en.tracker.side.create, exact: true }).click();
  await page.getByRole('button', { name: en.tracker.actions.editPipeline, exact: true }).click();
  const stage2 = page.getByRole('group', { name: 'Stage 2' });
  await stage2.getByRole('button', { name: en.tracker.form.removeStage, exact: true }).click();
  const save = () => page.getByRole('button', { name: en.tracker.form.save, exact: true }).click();
  await cancelAndEscape(page, save, () => expect(mutations).toEqual([]));
  await save();
  await expect(question(page)).toHaveAccessibleName(en.tracker.confirm.removeStage.title);
  expect(await bdis(question(page))).toEqual(['Check', 'Flow']);
  await expect(question(page)).toContainText(en.confirm.final);
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmYes(page, en.tracker.confirm.removeStage.yes);
  await expect.poll(() => mutations.map(m => [m.method, m.path])).toEqual([['PATCH', '/api/pipelines/pl1']]);

  /* Backlog: deleting a saved item confirms before DELETE. */
  mutations.length = 0;
  await page.goto('/tasks?show=turns');
  const remove = () => page.getByRole('button', { name: en.backlog.removeLabel('Price page'), exact: true }).click();
  await cancelAndEscape(page, remove, () => expect(mutations).toEqual([]));
  await remove();
  await expect(question(page)).toHaveAccessibleName(en.backlog.confirm.remove.title);
  expect(await bdis(question(page))).toEqual(['Price page']);
  await expect(question(page)).toContainText(en.confirm.final);
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmYes(page, en.backlog.confirm.remove.yes);
  await expect.poll(() => mutations).toEqual([{ method: 'DELETE', path: '/api/departments/d2/backlog/i1' }]);
});

test('confirms deleting a note in Notebook', async ({ page }) => {
  const { openPanel } = await openAgent(page, { lang: 'en', theme: 'light', width: 1440 }, 'orchestrator');
  const mutations: string[] = [];
  let notes: NoteView[] = [{ number: 1, text: 'Keep PRs small.', by: { kind: 'person', id: 'p1', name: 'Ivan' }, updatedAt: '2026-11-10T09:00:00.000Z' }];
  await page.route('**/api/notebook', route => route.fulfill({ json: { notes } }));
  await page.route('**/api/notebook/1', route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    mutations.push('DELETE /api/notebook/1');
    notes = [];
    return route.fulfill({ status: 204 });
  });
  const notebook = await openPanel('notebook');
  const remove = () => notebook.getByRole('button', { name: en.notebook.removeNote(1), exact: true }).click();
  await cancelAndEscape(page, remove, () => expect(mutations).toEqual([]));
  await expect(notebook).toBeVisible();
  await remove();
  await expect(question(page)).toHaveAccessibleName(en.notebook.confirm.remove.title);
  expect(await bdis(question(page))).toEqual(['#1']);
  await expect(question(page)).toContainText(en.confirm.final);
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmYes(page, en.notebook.confirm.remove.yes);
  await expect.poll(() => mutations).toEqual(['DELETE /api/notebook/1']);
});

test('confirms changing department owner, approval rules, and autonomous release in ApprovalPolicy', async ({ page }) => {
  await serveApi(page);
  const mutations: { path: string; body: unknown }[] = [];
  let policy: ApprovalPolicyView = {
    departmentId: 'd2',
    owner: null,
    canSetOwner: true,
    canChangePolicy: true,
    autonomousRelease: false,
    canSetAutonomousRelease: true,
    hasAutonomousReleases: false,
    candidates: [{ id: 'p2', name: 'Dana', title: 'COO' }],
    rules: [
      { channel: 'message', mode: 'every' },
      { channel: 'price', mode: 'every' },
      { channel: 'commit', mode: 'every' },
    ],
  };
  await page.route('**/api/**', route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/departments/d2/approval-policy') return route.fulfill({ json: policy });
    if (path === '/api/autonomous-releases') return route.fulfill({ json: { entries: [] } });
    if (path === '/api/departments/d2/owner' && req.method() === 'PUT') {
      const body = req.postDataJSON() as { personId: string | null };
      mutations.push({ path, body });
      policy = { ...policy, owner: body.personId ? { id: 'p2', name: 'Dana' } : null };
      return route.fulfill({ json: { ownerPersonId: body.personId } });
    }
    if (path === '/api/departments/d2/approval-policy/autonomous-release' && req.method() === 'PUT') {
      const body = req.postDataJSON() as { enabled: boolean };
      mutations.push({ path, body });
      policy = { ...policy, autonomousRelease: body.enabled };
      return route.fulfill({ json: policy });
    }
    if (path.startsWith('/api/departments/d2/approval-policy/') && req.method() === 'PUT') {
      const channel = path.split('/').pop() as ApprovalPolicyView['rules'][number]['channel'];
      const body = req.postDataJSON() as object;
      mutations.push({ path, body });
      policy = { ...policy, rules: policy.rules.map(r => (r.channel === channel ? ({ channel, ...body } as ApprovalPolicyView['rules'][number]) : r)) };
      return route.fulfill({ json: policy });
    }
    return route.fallback();
  });

  await page.goto('/departments/d2');
  await page.getByRole('button', { name: en.dept.about, exact: true }).click();
  const a = en.dept.approvals;
  const part = page.getByRole('region', { name: a.title, exact: true });

  /* Change owner: non-danger, Cancel/Escape keeps select at current owner. */
  const owner = part.getByRole('combobox', { name: a.owner, exact: true });
  await cancelAndEscape(page, () => owner.selectOption('p2'), () => expect(mutations).toEqual([]));
  await expect(owner).toHaveValue('');
  await owner.selectOption('p2');
  expect(await bdis(question(page))).toEqual(['Dana', 'Development']);
  await expect(question(page).getByRole('button', { name: a.confirm.owner.yes, exact: true })).toBeFocused();
  await confirmYes(page, a.confirm.owner.yes);
  await expect.poll(() => mutations).toEqual([{ path: '/api/departments/d2/owner', body: { personId: 'p2' } }]);
  await expect(owner).toHaveValue('p2');

  /* Direct dropdown rule change to "none": danger, Cancel/Escape reverts dropdown. */
  mutations.length = 0;
  const msgSelect = part.getByRole('group', { name: a.channels.message, exact: true }).getByRole('combobox', { name: a.mode, exact: true });
  await cancelAndEscape(page, () => msgSelect.selectOption('none'), () => expect(mutations).toEqual([]));
  await expect(msgSelect).toHaveValue('every');
  await msgSelect.selectOption('none');
  expect(await bdis(question(page))).toEqual(['Messages', 'Development', 'No approval']);
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmYes(page, a.confirm.rule.yes);
  await expect.poll(() => mutations).toEqual([{ path: '/api/departments/d2/approval-policy/message', body: { mode: 'none' } }]);
  await expect(msgSelect).toHaveValue('none');

  /* within_limits rule change: Save confirms, Cancel/Escape keeps inputs editable. */
  mutations.length = 0;
  const price = part.getByRole('group', { name: a.channels.price, exact: true });
  await price.getByRole('combobox', { name: a.mode, exact: true }).selectOption('within_limits');
  await expect(question(page)).toHaveCount(0);
  await price.getByRole('spinbutton', { name: a.limit, exact: true }).fill('250');
  await price.getByRole('textbox', { name: a.unit, exact: true }).fill('USD');
  const savePrice = () => price.getByRole('button', { name: en.common.save, exact: true }).click();
  await cancelAndEscape(page, savePrice, () => expect(mutations).toEqual([]));
  await expect(price.getByRole('spinbutton', { name: a.limit, exact: true })).toHaveValue('250');
  await savePrice();
  expect(await bdis(question(page))).toEqual(['Prices', 'Development', 'No approval up to 250 USD']);
  await expect(question(page).getByRole('button', { name: a.confirm.rule.yes, exact: true })).toBeFocused();
  await confirmYes(page, a.confirm.rule.yes);
  await expect.poll(() => mutations).toEqual([{ path: '/api/departments/d2/approval-policy/price', body: { mode: 'within_limits', limit: 250, unit: 'USD' } }]);

  /* Autonomous release: enable is danger, disable is non-danger. */
  mutations.length = 0;
  const autoSwitch = part.getByRole('switch', { name: a.autonomousRelease, exact: true });
  await cancelAndEscape(page, () => autoSwitch.click(), () => expect(mutations).toEqual([]));
  await expect(autoSwitch).not.toBeChecked();
  await autoSwitch.click();
  expect(await bdis(question(page))).toEqual(['Development']);
  await expect(question(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmYes(page, a.confirm.enableAutonomous.yes);
  await expect.poll(() => mutations).toEqual([{ path: '/api/departments/d2/approval-policy/autonomous-release', body: { enabled: true } }]);
  await expect(autoSwitch).toBeChecked();

  mutations.length = 0;
  await cancelAndEscape(page, () => autoSwitch.click(), () => expect(mutations).toEqual([]));
  await expect(autoSwitch).toBeChecked();
  await autoSwitch.click();
  expect(await bdis(question(page))).toEqual(['Development']);
  await expect(question(page).getByRole('button', { name: a.confirm.disableAutonomous.yes, exact: true })).toBeFocused();
  await confirmYes(page, a.confirm.disableAutonomous.yes);
  await expect.poll(() => mutations).toEqual([{ path: '/api/departments/d2/approval-policy/autonomous-release', body: { enabled: false } }]);
  await expect(autoSwitch).not.toBeChecked();
});
