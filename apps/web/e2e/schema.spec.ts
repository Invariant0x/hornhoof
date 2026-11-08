import { expect, test, type Page } from '@playwright/test';
import type { Department, DeptRole, Employee, Org } from '../src/types';
import { taskRoute } from '../test/task-route';
import type { EchelonStage } from '@hornhoof/protocol/echelons';
import { ME, serveApi } from './api';

const role = (id: string, en: string, ru: string, gate: number | null = null, schema?: 'before_work' | 'final_check' | 'observer'): DeptRole => ({
  id,
  title: { en, ru },
  description: { en: `${en} description`, ru: `${ru} description` },
  kind: 'member',
  gate,
  ...(schema ? { schema } : {}),
});

const employee = (id: string, name: string, roleId: string, kind: Employee['kind'] = 'worker'): Employee => ({
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
});

const ROLES = [
  role('DEV-ARCH', 'Architect', 'Архитектор', null, 'before_work'),
  role('DEV-ENG', 'Developer', 'Разработчик'),
  role('DEV-REV', 'Code reviewer', 'Ревьюер кода', 1),
  role('DEV-SEC', 'Security engineer', 'Инженер по безопасности', 2),
  role('DEV-TEST', 'Test engineer', 'Инженер по тестированию', null, 'final_check'),
  role('DEV-PERF', 'Performance engineer', 'Инженер по производительности', null, 'observer'),
];

const NOW = '2026-11-05T12:00:00.000Z';
const STAGES: EchelonStage[] = ['architecture', 'development', 'review', 'security', 'tests'];

function owner(id: string, name: string, roleId: string, stage: EchelonStage, index: number): Employee {
  const echelons = taskRoute(stage, id);
  echelons.stages = echelons.stages.map(step => step.stage === stage ? { ...step, status: 'active' } : step);
  return { ...employee(id, name, roleId), status: 'working', task: { id: `task-${index}`, number: index + 1, title: `Work ${index + 1}`, stage: 0, gateCount: 0, bounces: 0, echelons } };
}

const DEPARTMENT: Department = {
  id: 'd2',
  name: null,
  templateKey: 'development',
  roleCode: 'DEV',
  about: '',
  agents: { total: 7, working: 0 },
  products: [],
  teams: [],
  people: [],
  employees: [employee('head', 'Hana', 'DEV-HEAD', 'head'), ...ROLES.map((r, i) => i < STAGES.length ? owner(r.id.toLowerCase(), r.title.en, r.id, STAGES[i]!, i) : employee(r.id.toLowerCase(), r.title.en, r.id))],
  roles: ROLES,
  workLines: [],
  reworkAt: null,
};

const ORG: Org = {
  company: ME.company,
  orchestrator: null,
  agents: DEPARTMENT.agents,
  people: [],
  serverNow: NOW,
  departments: [DEPARTMENT],
};

async function serveSchema(page: Page) {
  await serveApi(page);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const routes: Record<string, unknown> = {
      '/api/org': ORG,
      '/api/version': { version: '0.7.0', commit: 'schema-check' },
      '/api/updates': { current: { version: '0.7.0', commit: 'schema-check' }, available: false, latest: null, updater: { status: null, waiting: null } },
    };
    return path in routes ? route.fulfill({ json: routes[path] }) : route.fallback();
  });
}

for (const look of [
  { lang: 'en', theme: 'light', observer: 'turn observer' },
  { lang: 'ru', theme: 'dark', observer: 'наблюдатель хода' },
] as const) {
  test(`orders the development pipeline and places the observer outside it: ${look.lang}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(look => {
      localStorage.setItem('hh-lang', look.lang);
      localStorage.setItem('hh-theme', look.theme);
    }, look);
    await serveSchema(page);
    await page.goto('/');
    await page.getByRole('button', { name: look.lang === 'en' ? /Development/ : /Разработка/ }).click();
    await expect(page.locator('.dcanvas')).toBeVisible();
    await page.locator('.dview .zoom').getByRole('button', { name: look.lang === 'en' ? 'Show everything' : 'Показать все' }).click();

    const evidence = info.outputPath(`development-${look.lang}.png`);
    await page.screenshot({ path: evidence, fullPage: true });
    await info.attach(`development-${look.lang}.png`, { path: evidence, contentType: 'image/png' });

    const frames = ['Architecture', 'Development', 'Review', 'Security', 'Tests'].map(name => page.getByRole('group', { name, exact: true }));
    for (const frame of frames) await expect(frame).toBeVisible();
    await expect(page.getByRole('group', { name: 'Cleanup', exact: true })).toHaveCount(0);
    const observer = page.locator('.frame').filter({ has: page.locator('.fn', { hasText: ROLES[5]!.title[look.lang] }) });
    await expect(observer).toContainText(look.observer);
    const boxes = await Promise.all([...frames, observer].map(async frame => (await frame.boundingBox())!));
    for (let i = 0; i < frames.length - 1; i++) expect(boxes[i]!.x).toBeLessThan(boxes[i + 1]!.x);
    expect(boxes[5]!.x).toBeLessThan(boxes[0]!.x);
    await expect(page.locator('.dview .wires .rl')).toHaveCount(0);

    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
