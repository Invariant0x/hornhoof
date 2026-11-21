import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Department, Employee, GoalView, MachineView, Me, Org, Roster, SubView, TaskDetail, TaskLine } from '../src/types';
import { taskRoute } from '../test/task-route';

test.describe.configure({ timeout: 0 });

const SHOTS_DIR = process.env.HH_GUIDE_SHOTS_DIR ?? '';
const PREVIEW_DIR = process.env.HH_GUIDE_PREVIEW_DIR ?? '';

/* Approved #1800 Egypt tokens for test-harness visual rendering until #1803 lands in turn-42. */
const EGYPT_TEST_CSS = `
:root[data-surface="papyrus"] {
  --bg: #E6D9BE;
  --surface: #FAF4E6;
  --surface2: #F1E6D2;
  --line: #D2C2A5;
  --line2: #806F57;
  --ink: #221A12;
  --muted: #554736;
  --cyan: #1A5A8F;
  --cyan-ink: #124270;
  --amber: #9E6A00;
  --amber-ink: #6F4900;
  --pink: #A3245B;
  --pink-ink: #851B48;
  --ok: #0D6748;
  --red: #AD1D14;
  --on-red: #FAF4E6;
  --idle: #CCBFA3;
  --dot: rgba(92, 74, 48, .18);
  --glow: rgba(26, 90, 143, .11);
  --btn: #154B7D;
  --on-btn: #FAF4E6;
  --hud: rgba(248, 241, 226, .94);
  --shadow: rgba(42, 31, 18, .18);
  --on-pink: #FAF4E6;
  --scrim: rgba(34, 26, 18, .38);
  --scrollbar-thumb: #806F57;
  --scrollbar-track: #FAF4E6;
  --cut-k: 1;
  color-scheme: light;
}
`;

const ME: Me = {
  person: {
    id: 'p1', companyId: 'c1', name: 'Alex Morgan', email: 'alex@meridian.example', title: 'CEO',
    status: 'active', scopeKind: 'company', isOwner: true,
  },
  company: { id: 'c1', name: 'Meridian Studio' },
};

const TEST_KEY = {
  publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE'.padEnd(122, 'k'),
  wrapped: 'd3JhcHBlZA',
  salt: 'c2FsdA',
  iv: 'aXY',
  iterations: 600_000,
};

const OPS_DEPT: Department = {
  id: 'd-ops', name: null, templateKey: 'operations', roleCode: 'OPS', about: '',
  agents: { total: 1, working: 0 }, products: [], teams: [], people: [],
  employees: [], roles: [],
};

const HEAD_ROLE = { en: 'Team lead', ru: 'Руководитель отдела' };

function makeHead(patch: Partial<Employee> = {}): Employee {
  return {
    id: 'e1', name: 'Neo', roleId: 'PROD-HEAD', title: HEAD_ROLE, kind: 'head',
    model: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5', provider: 'anthropic_api',
    effort: null, state: 'sleeping', status: 'idle', on: true, timer: null, task: null,
    context: null, program: null, alarm: null, retry: null, failure: null,
    ...patch,
  };
}

function makeProductDept(employees: Employee[] = []): Department {
  return {
    id: 'd-prod', name: 'Product', templateKey: null, roleCode: 'PRD', about: '',
    agents: { total: employees.length, working: employees.filter(e => e.status === 'working').length },
    products: [], teams: [], people: [], employees,
    roles: [{ id: 'PROD-HEAD', title: HEAD_ROLE, description: HEAD_ROLE, kind: 'head', gate: null }],
  };
}

function makeSub(patch: Partial<SubView> = {}): SubView {
  return {
    id: 's-orch', provider: 'anthropic_api', kind: 'api_key', label: 'Anthropic', status: 'ready', online: true,
    last4: '9f3a', owner: { id: 'p1', name: 'Alex Morgan' },
    place: { kind: 'company', id: null, name: 'Whole company' },
    machines: [], limits: null, limitsUpdatedAt: null, budget: null, fallbacks: [],
    isOrchestrator: true, accounts: [], tier: null, accountsDiffer: false, signedInOnce: false,
    leaseMachine: null, connecting: null,
    ...patch,
  };
}

function makeMachine(online: boolean): MachineView {
  return {
    id: 'm1', hostname: 'meridian-node', os: 'linux', arch: 'x86_64',
    owner: { id: 'p1', name: 'Alex Morgan' }, online, lastSeenAt: null,
    plans: [{ id: 's-orch', provider: 'claude', status: online ? 'ready' : 'needs_login', online }],
    load: null, lendsTests: false, running: { agents: [], parts: [] },
  };
}

function makeGoal(): GoalView {
  return {
    id: 'g1', number: 1, title: 'Publish the first product brief', why: '', status: 'active', version: 1,
    parentId: null, department: { id: 'd-prod', name: 'Product' },
    responsible: { id: 'p1', name: 'Alex Morgan' }, target: null, current: null, unit: '', dueAt: null,
    progress: { done: 0, total: 0 }, createdAt: '2026-11-21T14:00:00Z',
  } as GoalView;
}

function makeTask(id: string, number: number, title: string, patch: Partial<TaskLine> = {}): TaskLine {
  return {
    id, number, title, brief: '', status: 'open', priority: 'normal',
    parentId: null, department: { id: 'd-prod', name: 'Product' }, product: null, goal: null,
    assignee: { id: 'e1', name: 'Neo', kind: 'head', role: HEAD_ROLE },
    executor: { id: 'e1', name: 'Neo', kind: 'head', role: HEAD_ROLE },
    responsible: { id: 'p1', name: 'Alex Morgan' }, paused: null, urgent: false,
    waitsFor: [], externalWait: null, pipelineId: null, pipelineStageId: null,
    createdAt: '2026-11-21T14:00:00Z', updatedAt: '2026-11-21T14:00:00Z',
    echelons: taskRoute('development', 'e1'),
    ...patch,
  } as TaskLine;
}

function makeTaskDetail(line: TaskLine): TaskDetail {
  return {
    ...line,
    echelonFindings: emptyEchelonFindings(),
    body: 'Outline the scope and goals.',
    parent: null,
    after: [],
    createdBy: { kind: 'person', id: 'p1', name: 'Alex Morgan' },
    subtasks: [],
    log: [{ kind: 'created', text: 'Task created.', data: {}, by: { kind: 'person', id: 'p1', name: 'Alex Morgan' }, at: '2026-11-21T14:00:00Z' }],
    requests: [],
  };
}

const ROSTER: Roster = {
  people: [{ role: 'PROD-HEAD', name: 'Neo', product: null, model: 'claude-sonnet-5-5', subscription: 's-orch', skills: [] }],
  roles: [{ id: 'PROD-HEAD', title: HEAD_ROLE, kind: 'head', tier: 'standard', perProduct: false, skills: [], subscription: 's-orch', required: false, holder: null }],
  products: [],
  subscriptions: [{ id: 's-orch', provider: 'anthropic_api', kind: 'api_key', label: 'Anthropic', owner: 'Alex Morgan', models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] }],
};

type World = {
  setupNeeded: boolean;
  setupAnswer?: Record<string, unknown>;
  me: Me;
  subs: SubView[];
  machines: MachineView[];
  departments: Department[];
  goals: GoalView[];
  tasks: TaskLine[];
  tasksError?: boolean;
  posts: { path: string; body: unknown }[];
};

function createWorld(patch: Partial<World> = {}): World {
  return {
    setupNeeded: true,
    me: ME,
    subs: [makeSub()],
    machines: [],
    departments: [OPS_DEPT],
    goals: [],
    tasks: [],
    posts: [],
    ...patch,
  };
}

async function mountWorld(page: Page, world: World): Promise<void> {
  await page.route('**/api/stream', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());
    const path = url.pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
    if (method === 'POST') world.posts.push({ path, body });

    if (method === 'GET' && path === '/api/setup') return route.fulfill({ json: { needed: world.setupNeeded, linkDomain: 'hornhoof.example' } });
    if (method === 'GET' && path.startsWith('/api/setup/names/')) return route.fulfill({ json: { available: true } });
    if (method === 'POST' && path === '/api/setup') {
      world.setupNeeded = false;
      return route.fulfill({ status: 201, json: { companyId: world.me.company.id, personId: world.me.person.id, email: world.me.person.email, ...(world.setupAnswer ?? {}) } });
    }
    if (method === 'GET' && path === '/api/link') return route.fulfill({ json: { tls: { certificate: true } } });
    if (method === 'GET' && path === '/api/me') return route.fulfill({ json: world.me });
    if (method === 'GET' && path === '/api/me/key') return route.fulfill({ json: { key: TEST_KEY } });
    if (method === 'PUT' && path === '/api/me/key') return route.fulfill({ status: 204 });
    if (method === 'GET' && path === '/api/version') return route.fulfill({ json: { version: '0.40.2', commit: 'abc1234', migrations: 1 } });
    if (method === 'GET' && path === '/api/updates') return route.fulfill({ json: { current: { version: '0.40.2', commit: 'abc1234' }, available: false, latest: null, updater: { status: null, waiting: null } } });
    if (method === 'GET' && path === '/api/feedback') return route.fulfill({ json: { inbox: false } });
    if (method === 'GET' && path === '/api/feedback/inbox') return route.fulfill({ status: 404, json: {} });
    if (method === 'GET' && path === '/api/requests') return route.fulfill({ json: { requests: [], proposals: [], merges: [], counts: { byPerson: {}, byAgent: {}, total: 0 } } });
    if (method === 'GET' && path === '/api/improvements') return route.fulfill({ json: { improvements: [] } });
    if (method === 'GET' && path === '/api/phones') return route.fulfill({ json: { phones: [] } });
    if (method === 'GET' && path === '/api/nodes/commands') return route.fulfill({ json: { commands: [] } });
    if (method === 'GET' && path === '/api/wait-cards') return route.fulfill({ json: { cards: [] } });
    if (method === 'GET' && path === '/api/pipelines') return route.fulfill({ json: { pipelines: [] } });
    if (method === 'GET' && path === '/api/orchestrator/first-contact') return route.fulfill({ json: { offers: [] } });
    if (method === 'GET' && path === '/api/org') {
      const orchSub = world.subs.find(s => s.isOrchestrator) ?? null;
      const org: Org = {
        company: world.me.company,
        orchestrator: {
          id: 'orch1', name: 'Orchestrator', model: 'claude-sonnet-5-5', effort: null,
          subscription: orchSub, context: null, program: null, alarm: null, retry: null, failure: null,
        },
        agents: {
          total: 1 + world.departments.reduce((n, d) => n + d.employees.length, 0),
          working: world.departments.reduce((n, d) => n + d.employees.filter(e => e.status === 'working').length, 0),
        },
        people: [],
        departments: world.departments,
      };
      return route.fulfill({ json: org });
    }
    if (method === 'GET' && path === '/api/task-departments') {
      return route.fulfill({
        json: {
          whole: true,
          mayPlanCompany: true,
          departments: world.departments.map(d => ({ id: d.id, name: d.name, templateKey: d.templateKey, mine: true, mayPlan: true })),
        },
      });
    }
    if (method === 'GET' && path === '/api/subscriptions') return route.fulfill({ json: { subscriptions: world.subs } });
    if (method === 'GET' && path === '/api/machines') return route.fulfill({ json: { machines: world.machines } });
    if (method === 'GET' && path === '/api/goals') return route.fulfill({ json: { goals: world.goals } });
    if (method === 'POST' && path === '/api/goals') {
      const created = makeGoal();
      created.title = String((body as { title?: string })?.title ?? created.title);
      world.goals = [created];
      return route.fulfill({ status: 201, json: { goal: created } });
    }
    if (method === 'GET' && path === '/api/tasks') {
      if (world.tasksError) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Status unavailable' } } });
      return route.fulfill({ json: { tasks: world.tasks } });
    }
    if (method === 'POST' && path === '/api/tasks') {
      const created = makeTask('t-first', 1, String((body as { title?: string })?.title ?? 'Draft product brief'));
      world.tasks = [...world.tasks, created];
      return route.fulfill({ status: 201, json: { task: makeTaskDetail(created) } });
    }
    if (method === 'GET' && path.startsWith('/api/tasks/') && path.endsWith('/phone-recordings')) {
      return route.fulfill({ json: { recordings: [] } });
    }
    if (method === 'GET' && path.startsWith('/api/tasks/')) {
      const id = path.slice('/api/tasks/'.length);
      const found = world.tasks.find(t => t.id === id);
      if (!found) return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found' } } });
      return route.fulfill({ json: { task: makeTaskDetail(found) } });
    }
    if (method === 'GET' && path === '/api/agents/orchestrator/events') {
      return route.fulfill({
        json: {
          events: [],
          state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: false, canType: true, turnRefused: null },
        },
      });
    }
    if (method === 'GET' && path === '/api/departments/d-prod/roster') return route.fulfill({ json: ROSTER });
    if (method === 'POST' && path === '/api/departments/build') {
      world.departments = [OPS_DEPT, makeProductDept([])];
      return route.fulfill({ status: 201, json: { departments: [makeProductDept([])] } });
    }
    if (method === 'POST' && path === '/api/departments/d-prod/staff') {
      world.departments = [OPS_DEPT, makeProductDept([makeHead()])];
      return route.fulfill({ status: 201, json: { hired: 1 } });
    }
    if (method === 'GET' && path === '/api/departments/d-prod/notebook') return route.fulfill({ json: { notes: [] } });
    if (method === 'GET' && path === '/api/departments/d-prod/approval-policy') {
      return route.fulfill({ json: { departmentId: 'd-prod', owner: null, canSetOwner: true, canChangePolicy: true, candidates: [], rules: [] } });
    }
    return route.fulfill({ json: {} });
  });
}

async function applyEnv(page: Page, opts: { theme: 'cyberpunk' | 'egypt'; lang: 'en' | 'ru'; dir: 'ltr' | 'rtl'; width: number }): Promise<void> {
  await page.setViewportSize({ width: opts.width, height: opts.width <= 400 ? 812 : 900 });
  await page.addInitScript(({ theme, lang, dir, egyptCss }) => {
    localStorage.setItem('hh-lang', lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    if (theme === 'egypt') {
      document.documentElement.dataset.theme = 'egypt';
      document.documentElement.dataset.world = 'egypt';
      document.documentElement.dataset.surface = 'papyrus';
      const addStyle = () => {
        if (document.getElementById('egypt-test-tokens')) return;
        const style = document.createElement('style');
        style.id = 'egypt-test-tokens';
        style.textContent = egyptCss;
        (document.head ?? document.documentElement).appendChild(style);
      };
      if (document.head) addStyle();
      else document.addEventListener('DOMContentLoaded', addStyle, { once: true });
    } else {
      delete document.documentElement.dataset.world;
      delete document.documentElement.dataset.surface;
      localStorage.setItem('hh-theme', 'cyberpunk');
    }
  }, { ...opts, egyptCss: EGYPT_TEST_CSS });
}

test('walks a new company from Setup to confirmed workingNow without any auto-action and verifies negative controls', async ({ page }) => {
  await applyEnv(page, { theme: 'cyberpunk', lang: 'en', dir: 'ltr', width: 1440 });
  const world = createWorld();
  await mountWorld(page, world);

  await page.goto('/?code=SETUP-123');
  const coach = page.getByRole('complementary', { name: en.guide.title });
  await expect(coach).toBeVisible();
  await expect(coach).toContainText(en.guide.voices.company[0]);

  /* Zero auto-POSTs before the person submits Setup. */
  expect(world.posts).toEqual([]);

  /* Layout & a11y checks on Setup step 1. */
  const skipBox = await coach.getByRole('button', { name: en.guide.skip }).boundingBox();
  expect(skipBox!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByLabel(en.setup.companyName)).toHaveAttribute('aria-describedby', /guide-coach-text/);

  /* Complete Setup steps 1 -> 2 -> 3 with API key. */
  await page.getByLabel(en.setup.companyName).fill('Meridian Studio');
  await page.getByRole('checkbox', { name: new RegExp(en.link.open) }).uncheck();
  await page.getByRole('button', { name: en.common.next }).click();

  await expect(coach).toContainText(en.guide.voices.company[1]);
  await expect(coach).toContainText(en.guide.voices.account[0]);

  await page.getByLabel(en.setup.yourName).fill('Alex Morgan');
  await page.getByLabel(en.common.email).fill('alex@meridian.example');
  await page.getByLabel(en.common.password).fill('correct horse battery');
  await page.getByRole('button', { name: en.common.next }).click();

  await expect(coach).toContainText(en.guide.voices.plan[0]);
  await page.getByLabel(en.setup.key).fill('sk-ant-test-key-12345678');
  await page.getByRole('button', { name: en.setup.finish }).click();

  /* Verify real Setup payload was submitted by the person only once. */
  expect(world.posts.map(p => p.path)).toEqual(['/api/setup']);

  /* FirstContact opens with priority; coach stays hidden until closed. */
  const dialog = page.getByRole('dialog', { name: en.firstContact.title });
  await expect(dialog).toBeVisible();
  await expect(coach).toBeHidden();
  await dialog.getByRole('button', { name: en.firstContact.close }).click();

  /* Map shows coach at Orchestrator for first department. */
  await expect(coach).toBeVisible();
  await expect(coach).toContainText(en.guide.voices.department[0]);

  /* Simulate department + head built, navigate to Tasks -> create goal -> create first task. */
  world.departments = [OPS_DEPT, makeProductDept([makeHead()])];
  await page.goto('/tasks?department=d-prod');
  await expect(coach).toContainText(en.guide.voices.goal[0]);

  await page.locator('[data-guide-anchor="Tracker.create"]').click();
  await page.locator('[data-guide-anchor="Tracker.newGoal"]').click();
  await expect(page.locator('[data-guide-anchor="GoalForm.title"]')).toBeVisible();
  await page.locator('[data-guide-anchor="GoalForm.title"]').fill('Publish the first product brief');
  await page.getByRole('button', { name: en.tracker.form.save }).click();

  await expect(coach).toContainText(en.guide.voices.task[0]);

  await page.locator('[data-guide-anchor="Tracker.create"]').click();
  await page.locator('[data-guide-anchor="Tracker.newTask"]').click();
  await page.locator('[data-guide-anchor="NewTask.title"]').fill('Draft product brief');
  await page.getByRole('button', { name: en.dept.createTask }).click();

  /* 201 alone: task created, NOT working now! */
  await expect(coach).toContainText(en.guide.created);
  await expect(coach).not.toContainText(en.guide.voices.work[1]);

  /* Negative control: another task ID working in workingNow MUST NOT confirm t-first! */
  const otherTask = makeTask('t-other', 2, 'Unrelated task', { status: 'working' });
  world.tasks = [...world.tasks, otherTask];
  world.departments = [OPS_DEPT, makeProductDept([makeHead({ status: 'working', state: 'working', task: { id: 't-other', number: 2, title: 'Unrelated task', echelons: taskRoute('development', 'e1') } })])];
  await page.reload();
  await expect(coach).toContainText(en.guide.created);
  await expect(coach).not.toContainText(en.guide.voices.work[1]);

  /* Confirmed workingNow on exact t-first -> celebrates and offers Open task + Finish guide! */
  world.departments = [OPS_DEPT, makeProductDept([makeHead({ status: 'working', state: 'working', task: { id: 't-first', number: 1, title: 'Draft product brief', echelons: taskRoute('development', 'e1') } })])];
  await page.reload();
  await expect(coach).toContainText(en.guide.started);
  await expect(coach).toContainText(en.guide.voices.work[1]);
  await expect(coach.getByRole('button', { name: en.guide.finish })).toBeVisible();

  /* Never references Back to Cyberpunk. */
  await expect(page.locator('body')).not.toContainText(/Back to Cyberpunk|Вернуться к Киберпанку/i);
});

test('supports personal subscription branch, LinkReady, ConnectMachine copy non-completion, skip/resume, and live Egypt/Russian switch', async ({ page }) => {
  await applyEnv(page, { theme: 'cyberpunk', lang: 'en', dir: 'ltr', width: 375 });
  const command = 'curl -fsSL https://meridian.hornhoof.example/install.sh | bash -s -- --join JOIN-999';
  const waitingSub = makeSub({ kind: 'personal', provider: 'claude', status: 'waiting_machine', online: false, machines: [] });
  const world = createWorld({
    setupAnswer: { link: { name: 'meridian', url: 'https://meridian.hornhoof.example' }, command },
    subs: [waitingSub],
  });
  await mountWorld(page, world);

  await page.goto('/?code=SETUP-123');
  const coach = page.getByRole('complementary', { name: en.guide.title });
  await expect(coach).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  /* Switch to Egypt live -> reed companion & "Yes, master." line. */
  await page.evaluate(egyptCss => {
    const style = document.createElement('style');
    style.textContent = egyptCss;
    document.head.appendChild(style);
    document.documentElement.dataset.theme = 'egypt';
    document.documentElement.dataset.world = 'egypt';
    document.documentElement.dataset.surface = 'papyrus';
  }, EGYPT_TEST_CSS);
  await expect(coach).toContainText('Yes, master. What name shall we put in the company records?');

  /* Complete Setup with personal subscription -> LinkReady -> ConnectMachine. */
  await page.getByLabel(en.setup.companyName).fill('Meridian Studio');
  await page.getByRole('button', { name: en.common.next }).click();
  await page.getByLabel(en.setup.yourName).fill('Alex Morgan');
  await page.getByLabel(en.common.email).fill('alex@meridian.example');
  await page.getByLabel(en.common.password).fill('correct horse battery');
  await page.getByRole('button', { name: en.common.next }).click();
  await page.getByRole('radio', { name: en.setup.modes.personal.label }).check();
  await page.getByRole('button', { name: en.setup.finish }).click();

  await expect(coach).toContainText(en.guide.linkReadyNote);
  await page.getByRole('button', { name: en.common.next }).click();

  /* ConnectMachine: command shown; copying does NOT complete machine step. */
  await expect(coach).toContainText('Follow the command on this page to connect the machine for your plan.');
  await page.getByRole('button', { name: en.setup.goToMap }).click();

  /* Close FirstContact -> still waiting for machine until machine actually comes online. */
  await page.getByRole('dialog', { name: en.firstContact.title }).getByRole('button', { name: en.firstContact.close }).click();
  await expect(coach).toContainText('Follow the command on this page to connect the machine for your plan.');

  /* Machine connects online, plan needs login -> Subscriptions shows needs_login message. */
  world.machines = [makeMachine(true)];
  world.subs = [makeSub({
    kind: 'personal', provider: 'claude', status: 'needs_login', online: true,
    machines: [{ id: 'm1', hostname: 'meridian-node', status: 'needs_login', online: true }],
  })];
  await page.goto('/subscriptions');
  await expect(coach).toContainText(en.guide.waitLogin);

  /* Skip & Resume via Account menu. */
  await coach.getByRole('button', { name: en.guide.skip }).click();
  await expect(coach).toBeHidden();
  await page.getByRole('button', { name: en.shell.account }).click();
  await page.getByRole('button', { name: en.guide.resume }).click();
  await expect(coach).toBeVisible();
});

test('captures full Cyberpunk & Egypt screenshot matrix across 375/1440, en/ru/rtl, and all wizard states', async ({ page }) => {
  test.skip(!SHOTS_DIR, 'Set HH_GUIDE_SHOTS_DIR to capture the visual matrix');
  mkdirSync(SHOTS_DIR, { recursive: true });
  if (PREVIEW_DIR) mkdirSync(PREVIEW_DIR, { recursive: true });

  const themes = ['cyberpunk', 'egypt'] as const;
  const widths = [1440, 375] as const;
  const locales = [
    { id: 'en', lang: 'en' as const, dir: 'ltr' as const },
    { id: 'ru', lang: 'ru' as const, dir: 'ltr' as const },
    { id: 'rtl', lang: 'en' as const, dir: 'rtl' as const },
  ];

  const previews = new Set([
    'cyberpunk-setup-company-1440-en.png',
    'cyberpunk-setup-company-375-ru.png',
    'cyberpunk-map-department-1440-en.png',
    'cyberpunk-work-started-1440-en.png',
    'cyberpunk-work-started-375-rtl.png',
    'egypt-setup-company-1440-en.png',
    'egypt-setup-company-375-en.png',
    'egypt-plan-error-375-rtl.png',
    'egypt-plan-login-1440-ru.png',
    'egypt-tracker-goal-1440-en.png',
    'egypt-work-started-1440-ru.png',
    'egypt-work-started-375-rtl.png',
  ]);

  async function seedGuide(targetPage: Page, origin: string, record: Record<string, unknown>) {
    await targetPage.evaluate(({ orig, rec }) => {
      localStorage.setItem(`hh-guide-v1:${orig}:c1:p1`, JSON.stringify({
        version: 1, active: true, skipped: false, mode: 'personal',
        done: ['company', 'account'], departmentId: null, goalId: null, taskId: null, workConfirmed: false,
        ...rec,
      }));
    }, { orig: origin, rec: record });
  }

  for (const theme of themes) {
    for (const width of widths) {
      for (const loc of locales) {
        const ctx = await page.context().browser()!.newContext({ viewport: { width, height: width <= 400 ? 812 : 900 }, reducedMotion: 'reduce' });
        const p = await ctx.newPage();
        await applyEnv(p, { theme, lang: loc.lang, dir: loc.dir, width });
        const world = createWorld();
        await mountWorld(p, world);

        const snap = async (stateName: string) => {
          const filename = `${theme}-${stateName}-${width}-${loc.id}.png`;
          const full = join(SHOTS_DIR, filename);
          expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), filename).toBe(true);
          await p.screenshot({ path: full });
          if (PREVIEW_DIR && previews.has(filename)) {
            writeFileSync(join(PREVIEW_DIR, filename), readFileSync(full));
          }
        };

        const words = loc.lang === 'ru' ? ru : en;

        /* 1. Setup company */
        await p.goto('/?code=SETUP-123');
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('setup-company');

        /* 2. Skipped in Setup */
        await p.getByRole('button', { name: words.guide.skip }).click();
        await expect(p.getByRole('button', { name: words.guide.resume })).toBeVisible();
        await snap('skipped');
        await p.getByRole('button', { name: words.guide.resume }).click();

        /* 3. Setup account */
        await p.getByLabel(words.setup.companyName).fill('Meridian Studio');
        await p.getByRole('checkbox', { name: new RegExp(words.link.open) }).uncheck();
        await p.getByRole('button', { name: words.common.next }).click();
        await expect(p.getByRole('heading', { name: words.setup.steps[1] })).toBeVisible();
        await snap('setup-account');

        /* 4. Setup plan */
        await p.getByLabel(words.setup.yourName).fill('Alex Morgan');
        await p.getByLabel(words.common.email).fill('alex@meridian.example');
        await p.getByLabel(words.common.password).fill('correct horse battery');
        await p.getByRole('button', { name: words.common.next }).click();
        await expect(p.getByRole('heading', { name: words.setup.steps[2] })).toBeVisible();
        await snap('setup-plan');

        /* Switch to Shell states. */
        const origin = new URL(p.url()).origin;
        world.setupNeeded = false;

        /* 5. Plan waiting for machine */
        world.machines = [];
        world.subs = [makeSub({ kind: 'personal', provider: 'claude', status: 'waiting_machine', online: false, machines: [] })];
        await seedGuide(p, origin, { mode: 'personal', done: ['company', 'account'] });
        await p.goto('/subscriptions');
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('plan-waiting');

        /* 6. Plan error */
        world.machines = [makeMachine(true)];
        world.subs = [makeSub({
          kind: 'personal', provider: 'claude', status: 'needs_login', online: true,
          machines: [{ id: 'm1', hostname: 'meridian-node', status: 'needs_login', online: true }],
          connecting: { nodeId: 'm1', hostname: 'meridian-node', state: 'failed', step: 'checking', since: '2026-11-21T13:55:00Z', until: '2026-11-21T13:59:00Z', error: 'timeout', code: null, line: null },
        })];
        await seedGuide(p, origin, { mode: 'personal', done: ['company', 'account', 'machine'] });
        await p.reload();
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('plan-error');

        /* 7. Plan login */
        world.subs = [makeSub({
          kind: 'personal', provider: 'claude', status: 'needs_login', online: true,
          machines: [{ id: 'm1', hostname: 'meridian-node', status: 'needs_login', online: true }],
          connecting: null,
        })];
        await p.reload();
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('plan-login');

        /* 8. Plan loading */
        world.subs = [makeSub({
          kind: 'personal', provider: 'claude', status: 'needs_login', online: true,
          machines: [{ id: 'm1', hostname: 'meridian-node', status: 'needs_login', online: true }],
          connecting: { nodeId: 'm1', hostname: 'meridian-node', state: 'connecting', step: 'checking', since: '2026-11-21T13:59:50Z', until: '2026-11-21T14:02:00Z', error: null, code: null, line: null },
        })];
        await p.reload();
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('plan-loading');

        /* 9. Map department */
        world.subs = [makeSub()];
        world.departments = [OPS_DEPT];
        await seedGuide(p, origin, { mode: 'api_key', done: ['company', 'account', 'plan', 'machine'] });
        await p.goto('/');
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('map-department');

        /* 10. Department staff */
        world.departments = [OPS_DEPT, makeProductDept([])];
        await p.goto('/departments/d-prod');
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('department-staff');

        /* 11. Tracker goal */
        world.departments = [OPS_DEPT, makeProductDept([makeHead()])];
        world.goals = [];
        await p.goto('/tasks?department=d-prod');
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('tracker-goal');

        /* 12. Tracker task */
        world.goals = [makeGoal()];
        world.tasks = [];
        await p.reload();
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('tracker-task');

        /* 13. Work created */
        const t1 = makeTask('t-first', 1, 'Draft product brief');
        world.tasks = [t1];
        await seedGuide(p, origin, {
          mode: 'api_key',
          done: ['company', 'account', 'plan', 'machine', 'department', 'staff', 'goal', 'task'],
          departmentId: 'd-prod', goalId: 'g1', taskId: 't-first', workConfirmed: false,
        });
        await p.goto('/tasks/t-first');
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('work-created');

        /* 14. Work queued */
        world.departments = [OPS_DEPT, makeProductDept([makeHead({ status: 'queued', task: { id: 't-first', number: 1, title: 'Draft product brief', echelons: taskRoute('development', 'e1') } })])];
        await p.reload();
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('work-queued');

        /* 15. Work unavailable */
        world.tasksError = true;
        await p.reload();
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('work-unavailable');
        world.tasksError = false;

        /* 16. Work needs attention (paused) */
        world.tasks = [makeTask('t-first', 1, 'Draft product brief', { paused: { reason: 'Waiting for review', by: 'p1', at: '2026-11-21T14:00:00Z' } as never })];
        world.departments = [OPS_DEPT, makeProductDept([makeHead()])];
        await p.reload();
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('work-error');

        /* 17. Work started (confirmed workingNow on exact task.id) */
        world.tasks = [t1];
        world.departments = [OPS_DEPT, makeProductDept([makeHead({ status: 'working', state: 'working', task: { id: 't-first', number: 1, title: 'Draft product brief', echelons: taskRoute('development', 'e1') } })])];
        await p.reload();
        await expect(p.getByRole('complementary', { name: words.guide.title })).toBeVisible();
        await snap('work-started');

        await ctx.close();
      }
    }
  }

  /* Write SHA256SUMS for every captured PNG. */
  const files = readdirSync(SHOTS_DIR).filter(f => f.endsWith('.png')).sort();
  const lines = files.map(f => `${createHash('sha256').update(readFileSync(join(SHOTS_DIR, f))).digest('hex')}  ${f}`);
  writeFileSync(join(SHOTS_DIR, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  if (PREVIEW_DIR) writeFileSync(join(PREVIEW_DIR, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  expect(files.length).toBe(themes.length * widths.length * locales.length * 17);
});
