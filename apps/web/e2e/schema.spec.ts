import { expect, test, type Page } from '@playwright/test';
import type { Department, DeptRole, Employee, Org } from '../src/types';
import { schemaLayout, stepPaths } from '../src/screens/schema';
import { toD } from '../src/ui/wires';
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
const RETURNED = '2026-11-05T11:59:00.000Z';

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
  employees: [employee('head', 'Hana', 'DEV-HEAD', 'head'), ...ROLES.map(r => employee(r.id.toLowerCase(), r.title.en, r.id))],
  roles: ROLES,
  workLines: [{ upstreamAgentId: 'head', downstreamAgentId: 'dev-eng', working: false, workEpoch: 1, returnedEpoch: 1, returnedAt: RETURNED }],
  reworkAt: RETURNED,
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
  { lang: 'en', theme: 'light', final: 'final turn check, once per turn', observer: 'turn observer', gate: (n: number) => `gate ${n}` },
  { lang: 'ru', theme: 'dark', final: 'финальная проверка хода, один раз за ход', observer: 'наблюдатель хода', gate: (n: number) => `рубеж ${n}` },
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

    const frame = (title: string) => page.locator('.frame').filter({ has: page.locator('.fn', { hasText: title }) });
    const architect = frame(ROLES[0]!.title[look.lang]);
    const developer = frame(ROLES[1]!.title[look.lang]);
    const reviewer = frame(ROLES[2]!.title[look.lang]);
    const security = frame(ROLES[3]!.title[look.lang]);
    const final = frame(ROLES[4]!.title[look.lang]);
    const observer = frame(ROLES[5]!.title[look.lang]);
    await expect(final).toContainText(look.final);
    await expect(final).not.toHaveClass(/gt/);
    await expect(observer).toContainText(look.observer);
    expect(await page.locator('.dcanvas .gl').allTextContents()).toEqual([look.gate(1), look.gate(2)]);

    const schema = schemaLayout(DEPARTMENT, 0);
    const paths = stepPaths(schema);
    const backs = ['dev-rev', 'dev-sec'].map(from => paths.back(from, 'dev-eng')!);
    const amber = page.locator('.wires path.live.a[data-work="dev-eng"]');
    await expect(amber).toHaveCount(2);
    const dots = page.locator('.dview circle.pt.a animateMotion');
    await expect(dots).toHaveCount(4);
    const drawn = await page.locator('.dview .wires .rl').evaluateAll(paths => paths.map(path => path.getAttribute('d')));
    for (const line of schema.lines.filter(l => l.cls === 'rl')) expect(drawn).toContain(toD(line.pts));
    for (const [index, back] of backs.entries()) {
      await expect(amber.nth(index)).toHaveAttribute('d', toD(back));
      for (let j = 0; j < 2; j++) expect(await dots.nth(index * 2 + j).getAttribute('path')).toBe(toD(back));
      for (let i = 1; i < back.length; i++) {
        const segment = [back[i - 1]!, back[i]!];
        if (segment[0][0] === segment[1][0]) {
          expect(drawn).toContain(toD(segment));
        } else {
          const y = segment[0][1], xs = segment.map(p => p[0]);
          expect(schema.lines.some(l => l.cls === 'rl' && l.pts[0]![1] === y && l.pts[1]![1] === y && xs.every(x => x >= Math.min(l.pts[0]![0], l.pts[1]![0]) && x <= Math.max(l.pts[0]![0], l.pts[1]![0])))).toBe(true);
        }
      }
    }

    const boxes = await Promise.all([architect, developer, reviewer, security, final, observer].map(async f => (await f.boundingBox())!));
    for (let i = 0; i < 4; i++) expect(boxes[i]!.x).toBeLessThan(boxes[i + 1]!.x);
    expect(boxes[5]!.x).toBeLessThan(boxes[0]!.x);

    if (look.lang === 'en') {
      for (let i = 0; i < 3; i++) await page.locator('.dview .zoom button').nth(1).click();
      await expect.poll(() => page.locator('.dview circle.pt.a').evaluateAll(circles => {
        const horizontal = [...document.querySelectorAll<SVGPathElement>('.dview .wires .rl')].find(path => path.getBBox().height === 0);
        if (!horizontal) return false;
        const y = horizontal.getBoundingClientRect().y;
        return circles.some(circle => Math.abs(circle.getBoundingClientRect().y - y) < 4);
      })).toBe(true);
      const returnEvidence = info.outputPath('development-return-line.png');
      await page.screenshot({ path: returnEvidence, fullPage: true });
      await info.attach('development-return-line.png', { path: returnEvidence, contentType: 'image/png' });
    }

    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
