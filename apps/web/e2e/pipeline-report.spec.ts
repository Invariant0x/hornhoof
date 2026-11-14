import type { DepartmentPipeline, PipelineRow, PipelineTurn } from '@hornhoof/protocol/pipeline-report';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { serveApi } from './api';
import { wholeTurn } from './whole-turn';

const HOUR = 3600, MINUTE = 60;
const turn = (number: number, title: string, source: PipelineTurn['source']): PipelineTurn => ({
  number, title, status: source === 'live' ? 'open' : 'closed', openedAt: '2026-11-04T14:16:00.000Z', closedAt: source === 'live' ? null : '2026-11-04T21:00:00.000Z', source,
});
const percent = (value: number | null, base: number | null) => {
  if (value === null || base === null) return null;
  if (base === 0) return value === 0 ? 0 : null;
  return Math.round(((value - base) / base) * 100);
};
const line = (section: PipelineRow['section'], key: string, unit: PipelineRow['unit'], value: number | null, previous: number | null, baseline: number | null): PipelineRow => ({
  section, key, unit, value, previous, baseline, vsPrevious: percent(value, previous), vsBaseline: percent(value, baseline),
});
const ROWS: PipelineRow[] = [
  line('tasks', 'tasks.total', 'count', 63, 48, 63),
  line('tasks', 'tasks.done', 'count', 42, 40, 42),
  line('time', 'toAcceptance.median', 'seconds', 4 * HOUR, 5 * HOUR, 5 * HOUR),
  line('time', 'toAcceptance.worst', 'seconds', 12 * HOUR + 5 * MINUTE, 11 * HOUR, 14 * HOUR),
  line('time', 'toFirstSubmit.median', 'seconds', 77 * MINUTE, 96 * MINUTE, 96 * MINUTE),
  line('time', 'criticalPath', 'seconds', 5 * HOUR + 20 * MINUTE, 6 * HOUR, 6 * HOUR + 44 * MINUTE),
  line('stages', 'stages.work', 'seconds', 40 * HOUR, 44 * HOUR, 44 * HOUR),
  line('stages', 'stages.review', 'seconds', 11 * HOUR, 9 * HOUR, 9 * HOUR),
  line('agents', 'agents.lost', 'seconds', 40 * MINUTE, 2 * HOUR, 2 * HOUR),
  line('waits', 'waits.testRuns.count', 'count', 7, 11, 11),
  line('waits', 'waits.testRuns.seconds', 'seconds', 3 * HOUR, 6 * HOUR, 6 * HOUR),
  line('waits', 'waits.testRuns.partQueue', 'seconds', 35 * MINUTE, 0, 0),
  line('waits', 'waits.external.machine.seconds', 'seconds', 50 * MINUTE, 0, 30 * MINUTE),
  line('problems', 'submitsPerTask', 'ratio', 1.2, 1, 1),
  line('problems', 'failures', 'count', 0, 2, 2),
  line('problems', 'interrupted', 'count', 3, 14, 14),
  line('problems', 'selectionMisses', 'count', null, null, null),
  line('quality', 'quality.laterBugs', 'count', 2, 4, 4),
  line('quality', 'returns', 'count', 9, 6, 6),
  line('kinds', 'kinds.unknown_path.tasks', 'count', 8, 5, 5),
  line('kinds', 'kinds.unknown_path.toAcceptance', 'seconds', 6 * HOUR, 7 * HOUR, 7 * HOUR),
  line('tests', 'tests.total', 'seconds', 2600.4, 3100.2, 3100.2),
  line('tests', 'tests.setup', 'seconds', 1170.5, 1395.1, 1395.1),
  line('tests', 'tests.package.apps/server', 'seconds', 2100.1, 2500, 2500),
];
const REPORT: DepartmentPipeline = {
  turn: turn(9, 'Payments', 'live'),
  previous: turn(8, 'Waits', 'closed'),
  baseline: turn(7, 'Reviews', 'rebuilt'),
  turns: [9, 8, 7, 6],
  department: {
    department: { id: 'd2', name: 'Development' },
    described: false,
    criticalPath: [353, 354, 358, 362],
    rows: ROWS,
    tests: {
      packages: [
        { package: 'apps/server', files: 141, totalMs: 2_100_100, setupMs: 945_000, testsMs: 1_140_000, teardownMs: 15_100, medianFileMs: 11_200, tests: 2850, medianTestMs: 310, slowerThanMedian: 1390 },
        { package: 'packages/protocol', files: 4, totalMs: 8_400, setupMs: null, testsMs: null, teardownMs: null, medianFileMs: 2_000, tests: null, medianTestMs: null, slowerThanMedian: null },
      ],
      slowestFiles: [
        { package: 'apps/server', file: 'test/modules/tasks/a-very-long-folder-name-that-goes-on-and-on/turns-and-their-reads-of-the-whole-department.test.ts', totalMs: 73_400, setupMs: 42_000, testsMs: 31_000, teardownMs: 400, parts: 2 },
        { package: 'apps/server', file: 'test/migrations.test.ts', totalMs: 41_200, setupMs: null, testsMs: null, teardownMs: null, parts: 1 },
      ],
      slowestTests: [{ package: 'apps/server', file: 'test/migrations.test.ts', name: 'migration 0062 fills the kind and risk class of open tasks from the first line of the body', ms: 9_800 }],
      overBudgetFiles: [
        { package: 'apps/server', file: 'test/modules/tasks/a-very-long-folder-name-that-goes-on-and-on/turns-and-their-reads-of-the-whole-department.test.ts', totalMs: 73_400, setupMs: 42_000, testsMs: 31_000, teardownMs: 400, parts: 2 },
        { package: 'apps/server', file: 'test/migrations.test.ts', totalMs: 41_200, setupMs: null, testsMs: null, teardownMs: null, parts: 1 },
      ],
      overBudgetTests: [{ package: 'apps/server', file: 'test/migrations.test.ts', name: 'migration 0062 fills the kind and risk class of open tasks from the first line of the body', ms: 9_800 }],
    },
  },
};

async function open(page: Page, language: string, theme: string, reports: Record<string, { status: number; body: unknown }>) {
  const { org, department, tree } = wholeTurn(false);
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const fixed: Record<string, unknown> = { '/api/org': org, [`/api/departments/${department.id}/tree`]: { tree } };
    if (url.pathname in fixed) return route.fulfill({ json: fixed[url.pathname] });
    const report = reports[url.pathname + url.search];
    return report ? route.fulfill({ status: report.status, json: report.body }) : route.fallback();
  });
  await page.addInitScript(([lang, look]) => {
    localStorage.setItem('hh-lang', lang!);
    localStorage.setItem('hh-theme', look!);
  }, [language, theme]);
  await page.goto('/');
  await page.getByRole('button', { name: language === 'en' ? /^Development/ : /^Разработка/ }).click();
  await page.getByRole('button', { name: language === 'en' ? 'Speed' : 'Скорость', exact: true }).click();
  await page.getByRole('tab', { name: language === 'en' ? 'Report' : 'Отчет', exact: true }).click();
  return page.locator('.dv-drawer.spd');
}

const PATH = '/api/departments/d2/pipeline';

async function shoot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

for (const language of ['en', 'ru']) for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
  test(`the report ${language} ${theme} ${width}`, async ({ page }, info) => {
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) problems.push(message.text()); });
    await page.setViewportSize({ width, height: width === 375 ? 667 : 900 });
    const drawer = await open(page, language, theme, { [PATH]: { status: 200, body: { report: REPORT } } });
    const en = language === 'en';

    await expect(drawer.getByText(en ? 'From issue to acceptance, median' : 'От выдачи до принятия, медиана', { exact: true })).toBeVisible();
    const body = drawer.locator('.dv-drawer-b');
    await expect(body).toContainText(en ? 'to turn 8:' : 'к ходу 8:');
    await expect(body).toContainText(en ? 'to turn 7:' : 'к ходу 7:');
    await expect(body).toContainText('−20%');
    await expect(body).not.toContainText('—');
    if (!en) await expect(body).not.toContainText('ё');

    /* Nothing runs off to the side, not on a phone and not with a long file path. */
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const box = (await body.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    for (const row of await body.locator('.pr-row').all()) {
      const edge = (await row.boundingBox())!;
      expect(edge.x + edge.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }

    /* A better number and a worse one do not look the same, and neither hides on its background. */
    const median = body.locator('.pr-row', { hasText: en ? 'From issue to first hand-in, median' : 'От выдачи до первой сдачи, медиана' });
    const good = await median.locator('.good').first().evaluate(element => getComputedStyle(element).color);
    const review = body.locator('.pr-row', { hasText: en ? 'Review' : 'Проверка' }).first();
    const bad = await review.locator('.bad').first().evaluate(element => getComputedStyle(element).color);
    expect(good).not.toBe(bad);

    await shoot(page, info, `report-${language}-${theme}-${width}-top`);
    await body.getByRole('heading', { level: 4, name: en ? 'Test time' : 'Время тестов' }).scrollIntoViewIfNeeded();
    await body.evaluate(element => element.scrollTo({ top: element.scrollHeight }));
    await expect(body).toContainText('turns-and-their-reads-of-the-whole-department.test.ts');
    await expect(body).toContainText(en ? 'Files over 30 s' : 'Файлы дольше 30 с');
    await shoot(page, info, `report-${language}-${theme}-${width}-tests`);
    expect(problems).toEqual([]);
  });
}

test('picks a turn with the keyboard and keeps the focus on the picker', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const drawer = await open(page, 'en', 'light', {
    [PATH]: { status: 200, body: { report: REPORT } },
    [`${PATH}?turn=7`]: { status: 200, body: { report: { ...REPORT, turn: turn(7, 'Reviews', 'rebuilt'), previous: turn(6, 'Old', 'closed'), baseline: null } } },
  });
  const picker = drawer.getByRole('combobox', { name: 'Turn', exact: true });
  await expect(picker).toHaveValue('9');
  await picker.focus();
  await picker.selectOption('7');
  await expect(drawer.getByText(/worked out later from the events of the turn/)).toBeVisible();
  await expect(drawer.getByText(/Changes are to turn 6/)).toBeVisible();
  await expect(picker).toBeFocused();
  await expect(picker).toHaveValue('7');
});

test('walks the three tabs with the arrow keys', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const drawer = await open(page, 'en', 'dark', { [PATH]: { status: 200, body: { report: REPORT } } });
  const tab = (name: string) => drawer.getByRole('tab', { name, exact: true });
  await tab('Report').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab('Speed')).toBeFocused();
  await expect(tab('Speed')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(tab('Report')).toBeFocused();
  await expect(drawer.getByText('From issue to acceptance, median', { exact: true })).toBeVisible();
});

for (const [name, reports, text] of [
  ['no turn has run', { [PATH]: { status: 404, body: { error: { code: 'not_found', message: 'No turn has run yet.', reason: 'turn_unknown' } } } }, 'This department has not run a turn yet, so there is nothing to report.'],
  ['the department had no tasks', { [PATH]: { status: 200, body: { report: { ...REPORT, department: null } } } }, 'This department had no tasks in turn 9.'],
] as const) {
  test(`says so when ${name}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const drawer = await open(page, 'en', 'light', reports);
    await expect(drawer.getByText(text)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shoot(page, info, `report-${name.replaceAll(' ', '-')}`);
  });
}

test('tries again after a failure', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const reports: Record<string, { status: number; body: unknown }> = { [PATH]: { status: 500, body: { error: { code: 'internal', message: 'Something went wrong.' } } } };
  const drawer = await open(page, 'en', 'light', reports);
  await expect(drawer.getByRole('alert')).toHaveText('Something went wrong.');
  reports[PATH] = { status: 200, body: { report: REPORT } };
  await drawer.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(drawer.getByText('From issue to acceptance, median', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('alert')).toHaveCount(0);
});
