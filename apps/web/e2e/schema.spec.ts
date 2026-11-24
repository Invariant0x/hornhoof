import { expect, test, type Page } from '@playwright/test';
import type { Department, DeptRole, Employee, Org } from '../src/types';
import { taskRoute } from '../test/task-route';
import { ME, serveApi } from './api';
import { say } from '@hornhoof/protocol';

const role = (id: string, en: string, ru: string, gate: number | null = null, schema?: 'before_work' | 'final_check' | 'observer'): DeptRole => ({
  id,
  title: { en, ru },
  description: { en: `${en} description`, ru: `${ru} description` },
  kind: id === 'DEV-HEAD' ? 'head' : 'member',
  gate,
  ...(schema ? { schema } : {}),
});

const employee = (id: string, name: string, roleId: string, kind: Employee['kind'] = 'worker', teamId?: string): Employee => ({
  id,
  name,
  roleId,
  title: null,
  kind,
  model: '',
  modelName: null,
  provider: 'claude',
  state: 'sleeping',
  status: 'idle',
  on: true,
  effort: null,
  timer: null,
  task: null,
  context: null,
  program: null,
  alarm: null,
  retry: null,
  failure: null,
  ...(teamId ? { teamId } : {}),
});

/* The development roles as the template keeps them, listed out of their order on purpose. */
const ROLES = [
  role('DEV-HEAD', 'Head of development', 'Глава разработки'),
  role('DEV-TEST', 'Test engineer', 'Инженер по тестированию', null, 'final_check'),
  role('DEV-SEC', 'Security engineer', 'Инженер по безопасности', 2),
  role('DEV-REV', 'Code reviewer', 'Ревьюер кода', 1),
  role('DEV-ENG', 'Developer', 'Разработчик'),
  role('DEV-ARCH', 'Architect', 'Архитектор', null, 'before_work'),
  role('DEV-PERF', 'Performance engineer', 'Инженер по производительности', null, 'observer'),
];
const PIPELINE = ['DEV-ARCH', 'DEV-ENG', 'DEV-REV', 'DEV-SEC', 'DEV-TEST'];
const title = (id: string, lang: 'en' | 'ru') => say(ROLES.find(r => r.id === id)!.title, lang);

const NOW = '2026-11-05T12:00:00.000Z';
const STAFF: Employee[] = [
  employee('head', 'Hana', 'DEV-HEAD', 'head'),
  employee('ada', 'Ada', 'DEV-ARCH'),
  employee('bruno', 'Bruno', 'DEV-ENG'),
  employee('dina', 'Dina', 'DEV-ENG'),
  employee('rita', 'Rita', 'DEV-REV'),
  employee('roma', 'Roma', 'DEV-REV'),
  employee('sam', 'Sam', 'DEV-SEC'),
  employee('tom', 'Tom', 'DEV-TEST'),
  employee('pat', 'Pat', 'DEV-PERF'),
  employee('leo', 'Leo', 'DEV-ENG', 'worker', 'core'),
  employee('nora', 'Nora', 'DEV-ENG', 'worker', 'core'),
];

/* Task #12 stands at review: Rita leads that stage, Bruno who made it only refers to it. */
function atReview(staff: Employee[]): Employee[] {
  const task = { id: 'task-12', number: 12, title: 'Checkout API', echelons: taskRoute('review', 'rita') };
  return staff.map(e => (e.id === 'rita' ? { ...e, status: 'working', state: 'working', task } : e.id === 'bruno' ? { ...e, status: 'handed', task } : e));
}

function org(employees: Employee[]): Org {
  const department: Department = {
    id: 'd2',
    name: null,
    templateKey: 'development',
    roleCode: 'DEV',
    about: '',
    agents: { total: employees.length, working: employees.filter(e => e.status === 'working').length },
    products: [],
    teams: [{ id: 'core', name: 'Core', about: '', stage: 0, gate: false, turnkey: false }],
    people: [],
    employees,
    roles: ROLES,
    workLines: [],
    reworkAt: null,
  };
  return { company: ME.company, orchestrator: null, agents: department.agents, people: [], serverNow: NOW, departments: [department] };
}

async function serveSchema(page: Page, body: Org) {
  await serveApi(page);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const routes: Record<string, unknown> = {
      '/api/org': body,
      '/api/version': { version: '0.7.0', commit: 'schema-check' },
      '/api/updates': { current: { version: '0.7.0', commit: 'schema-check' }, available: false, latest: null, updater: { status: null, waiting: null } },
    };
    return path in routes ? route.fulfill({ json: routes[path] }) : route.fallback();
  });
}

const left = async (page: Page, name: string) => (await page.getByRole('group', { name, exact: true }).boundingBox())!.x;

for (const look of [
  { lang: 'en', theme: 'light', gate: 'Gate' },
  { lang: 'ru', theme: 'dark', gate: 'Рубеж' },
] as const) {
  for (const state of [
    { name: 'without tasks', file: 'idle', staff: STAFF },
    { name: 'with a task at review', file: 'review', staff: atReview(STAFF) },
  ] as const) {
    test(`stands the roles of development left to right by gates, ${state.name}: ${look.lang} ${look.theme}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.addInitScript(look => {
        localStorage.setItem('hh-lang', look.lang);
        localStorage.setItem('hh-theme', look.theme);
      }, look);
      await serveSchema(page, org(state.staff));
      await page.goto('/');
      await page.getByRole('button', { name: look.lang === 'en' ? /^Development/ : /^Разработка/ }).click();
      await expect(page.locator('.dcanvas')).toBeVisible();
      await page.locator('.dview .zoom').getByRole('button', { name: look.lang === 'en' ? 'Show everything' : 'Показать все' }).click();

      const evidence = info.outputPath(`development-${state.file}-${look.lang}.png`);
      await page.screenshot({ path: evidence, fullPage: true });
      await info.attach(`development-${state.file}-${look.lang}.png`, { path: evidence, contentType: 'image/png' });

      /* The roles stand in the order of the stages, with the gates numbered between them. */
      const names = PIPELINE.map(id => title(id, look.lang));
      for (const name of names) await expect(page.getByRole('group', { name, exact: true })).toBeVisible();
      const xs = await Promise.all(names.map(name => left(page, name)));
      for (let i = 1; i < xs.length; i++) expect(xs[i - 1]!).toBeLessThan(xs[i]!);
      const gates = page.locator('.dcanvas span.gl');
      await expect(gates).toHaveText([1, 2, 3].map(n => `${look.gate} ${n}`));
      const gateXs = await gates.evaluateAll(all => all.map(g => g.getBoundingClientRect().x));
      for (const [i, x] of gateXs.entries()) {
        expect(x).toBeGreaterThan(xs[i + 1]!);
        expect(x).toBeLessThan(xs[i + 2]!);
      }
      await expect(page.locator('.dview .wires .gd')).toHaveCount(3);
      await expect(page.locator('.dview .wires .rl')).toHaveCount(0);

      /* Everyone stays in its role's frame; only Core and the observer stand apart, left of the pipeline. */
      const frame = (id: string) => page.getByRole('group', { name: title(id, look.lang), exact: true });
      for (const [id, who] of [['DEV-ARCH', 'Ada'], ['DEV-ENG', 'Bruno'], ['DEV-ENG', 'Dina'], ['DEV-REV', 'Rita'], ['DEV-REV', 'Roma'], ['DEV-SEC', 'Sam'], ['DEV-TEST', 'Tom'], ['DEV-PERF', 'Pat']] as const) {
        await expect(frame(id).getByRole('button', { name: new RegExp(who) })).toBeVisible();
      }
      const core = page.getByRole('group', { name: 'Core', exact: true });
      await expect(core.getByRole('button', { name: /Leo/ })).toBeVisible();
      await expect(core.getByRole('button', { name: /Nora/ })).toBeVisible();
      expect(await left(page, 'Core')).toBeLessThan(xs[0]!);
      expect(await left(page, title('DEV-PERF', look.lang))).toBeLessThan(xs[0]!);

      /* Who leads a stage now is marked in its own frame, and only there. */
      const leads = page.locator('.dview .schip.lead');
      if (state.file === 'review') {
        await expect(leads).toHaveCount(1);
        await expect(frame('DEV-REV').locator('.schip.lead')).toContainText('Rita');
        await expect(frame('DEV-REV').locator('.schip.lead')).toContainText(look.lang === 'en' ? 'Review #12 Checkout API' : '#12 Checkout API');
      } else {
        await expect(leads).toHaveCount(0);
      }

      await page.setViewportSize({ width: 375, height: 812 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}
