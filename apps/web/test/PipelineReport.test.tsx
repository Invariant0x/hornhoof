import type { DepartmentPipeline, DepartmentReport, PipelineRow, PipelineTurn } from '@hornhoof/protocol/pipeline-report';
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { PipelineReport } from '../src/screens/PipelineReport';
import { SpeedPanel } from '../src/screens/SpeedPanel';
import { useDepartmentPipeline } from '../src/tasks';
import type { Department } from '../src/types';
import { DEV_ORG, DEV_TREE, mockApi } from './api-mock';
import { decl } from './css';

const DEPARTMENT = DEV_ORG.departments.find(d => d.id === 'd2') as Department;
const PATH = 'GET /api/departments/d2/pipeline';

const turn = (number: number, source: PipelineTurn['source'] = 'closed'): PipelineTurn => ({
  number, title: `Turn ${number}`, status: source === 'live' ? 'open' : 'closed', openedAt: '2026-11-04T14:16:00.000Z', closedAt: source === 'live' ? null : '2026-11-04T21:00:00.000Z', source,
});
const row = (section: PipelineRow['section'], key: string, unit: PipelineRow['unit'], value: number | null, previous: number | null, baseline: number | null, vsPrevious: number | null, vsBaseline: number | null): PipelineRow => ({ section, key, unit, value, previous, baseline, vsPrevious, vsBaseline });

const ROWS: PipelineRow[] = [
  row('tasks', 'tasks.total', 'count', 63, 40, 50, 58, 26),
  row('time', 'toAcceptance.median', 'seconds', 5760, 7200, 2880, -20, 100),
  row('time', 'criticalPath', 'seconds', 3600, 3600, 3600, 0, 0),
  row('waits', 'waits.testRuns.seconds', 'seconds', 21600, 0, 10800, null, 100),
  row('problems', 'selectionMisses', 'count', null, null, null, null, null),
  row('kinds', 'kinds.bug.tasks', 'count', 4, 2, 4, 100, 0),
  row('tests', 'tests.total', 'seconds', 33.5, 33.5, 33.5, 0, 0),
];
const DEV: DepartmentReport = {
  department: { id: 'd2', name: 'Development' },
  described: false,
  criticalPath: [12, 15],
  rows: ROWS,
  tests: {
    packages: [{ package: 'apps/server', files: 2, totalMs: 33_500, setupMs: 1400, testsMs: 32_000, teardownMs: 100, medianFileMs: 16_000, tests: 40, medianTestMs: 200, slowerThanMedian: 19 }],
    slowestFiles: [{ package: 'apps/server', file: 'test/a/very/long/path/of/a/test/file/that/has/to/wrap/on/a/phone/turns-and-reads.test.ts', totalMs: 33_500, setupMs: 1400, testsMs: 32_000, teardownMs: 100, parts: 2 }],
    slowestTests: [{ package: 'apps/server', file: 'test/turns.test.ts', name: 'closes a turn and keeps its snapshot', ms: 2204 }],
    overBudgetFiles: [{ package: 'apps/server', file: 'test/a/very/long/path/of/a/test/file/that/has/to/wrap/on/a/phone/turns-and-reads.test.ts', totalMs: 33_500, setupMs: 1400, testsMs: 32_000, teardownMs: 100, parts: 2 }],
    overBudgetTests: [{ package: 'apps/server', file: 'test/turns.test.ts', name: 'closes a turn and keeps its snapshot', ms: 2204 }],
  },
};
const REPORT: DepartmentPipeline = { turn: turn(9, 'live'), previous: turn(8), baseline: turn(7, 'rebuilt'), turns: [9, 8, 7], department: DEV };
const ok = (report: DepartmentPipeline): [number, unknown] => [200, { report }];

function show(route: unknown = ok(REPORT), rest: Record<string, unknown> = {}) {
  const calls = mockApi({ [PATH]: route as [number, unknown], ...(rest as Record<string, [number, unknown]>) });
  render(<LanguageProvider><PipelineReport department={DEPARTMENT} /></LanguageProvider>);
  return calls;
}

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

afterEach(cleanup);

describe('the report of a turn', () => {
  it('says it is loading until the report comes', async () => {
    show();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await screen.findByText('From issue to acceptance, median');
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('writes each number with its change to the previous and the baseline turn', async () => {
    show();
    await screen.findByText('From issue to acceptance, median');
    const median = rowOf('From issue to acceptance, median');
    expect(median).toHaveTextContent('1 h 36 min');
    expect(median).toHaveTextContent('to turn 8: −20%');
    expect(median).toHaveTextContent('to turn 7: +100%');
  });

  it('marks what got better and what got worse, by a sign as well as a colour', async () => {
    show();
    await screen.findByText('From issue to acceptance, median');
    const median = rowOf('From issue to acceptance, median');
    expect(within(median).getByText('−20%')).toHaveClass('good');
    expect(within(median).getByText('+100%')).toHaveClass('bad');
    expect(within(rowOf('All tasks')).getByText('+58%')).not.toHaveClass('bad');
    expect(within(rowOf('All tasks')).getByText('+58%')).not.toHaveClass('good');
  });

  it('says a number was zero rather than writing a percent of nothing', async () => {
    show();
    await screen.findByText('Test runs: total');
    expect(rowOf('Test runs: total')).toHaveTextContent('to turn 8: was 0');
  });

  it('says test selection has no data yet, with no percent', async () => {
    show();
    await screen.findByText('Missed by test selection');
    const misses = rowOf('Missed by test selection');
    expect(misses).toHaveTextContent('no data yet, comes with test selection');
    expect(misses).not.toHaveTextContent('to turn');
  });

  it('puts the numbers under their sections, in the order of the report', async () => {
    show();
    await screen.findByText('From issue to acceptance, median');
    const headings = screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent);
    expect(headings).toEqual(['Tasks', 'How long it took', 'Waits by reason', 'Hand-ins and failures', 'By kind of task', 'Test time']);
    expect(within(screen.getByRole('region', { name: 'Waits by reason' })).getByText('Test runs: total')).toBeInTheDocument();
  });

  it('names the turn, where its numbers come from and what it is compared with', async () => {
    show();
    await screen.findByText(/still running, counted just now/);
    expect(screen.getByText(/Changes are to this department's previous turn 8 and to its starting turn 7/)).toBeInTheDocument();
  });

  it('says when a closed turn was rebuilt from its events', async () => {
    show(ok({ ...REPORT, turn: turn(7, 'rebuilt'), previous: turn(6), baseline: null }));
    await screen.findByText(/worked out later from the events of the turn/);
    expect(screen.getByText(/Changes are to turn 6/)).toBeInTheDocument();
  });

  it('names a turn that is both previous and baseline once', async () => {
    show(ok({ ...REPORT, turn: turn(8, 'closed'), previous: turn(7), baseline: turn(7) }));
    await screen.findByText(/saved when the turn closed/);
    expect(screen.getByText(/Changes are to turn 7/)).toBeInTheDocument();
    const median = rowOf('From issue to acceptance, median');
    expect(within(median).getAllByText(/to turn 7/)).toHaveLength(1);
    expect(median).not.toHaveTextContent('to turn 8');
  });

  it('says there is nothing to compare the first turn with', async () => {
    show(ok({ ...REPORT, turn: turn(1), previous: null, baseline: null, turns: [1], department: { ...DEV, rows: [row('time', 'wholeTurn', 'seconds', 60, null, null, null, null)] } }));
    await screen.findByText(/This department has no earlier turn to compare with\./);
    expect(rowOf('Whole turn')).not.toHaveTextContent('to turn');
  });

  it('asks for the turn the person picks and keeps the picker while it loads', async () => {
    const user = userEvent.setup();
    let release: (answer: [number, unknown]) => void = () => {};
    const later = new Promise<[number, unknown]>(resolve => { release = resolve; });
    const calls = show(ok(REPORT), { [`${PATH}?turn=7`]: () => later });
    const picker = await screen.findByRole('combobox', { name: 'Turn' });
    expect(picker).toHaveValue('9');
    expect(within(picker).getAllByRole('option').map(o => o.textContent)).toEqual(['Turn 9', 'Turn 8', 'Turn 7']);
    await user.selectOptions(picker, '7');
    expect(calls.at(-1)?.path).toBe('/api/departments/d2/pipeline?turn=7');
    expect(screen.getByRole('combobox', { name: 'Turn' })).toHaveValue('7');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('From issue to acceptance, median')).not.toBeInTheDocument();
    await act(async () => { release(ok({ ...REPORT, turn: turn(7, 'rebuilt'), previous: null, baseline: null })); });
    expect(await screen.findByText('From issue to acceptance, median')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Turn' })).toHaveValue('7');
  });

  it('lists the tasks of the critical path', async () => {
    show();
    expect(await screen.findByText('Tasks on the critical path: #12, #15')).toBeInTheDocument();
  });

  it('has no line of tasks when the critical path has none', async () => {
    show(ok({ ...REPORT, department: { ...DEV, criticalPath: [] } }));
    await screen.findByText('From issue to acceptance, median');
    expect(screen.queryByText(/Tasks on the critical path/)).not.toBeInTheDocument();
  });

  it('shows test time by package, slowest files and slowest tests', async () => {
    show();
    const tests = await screen.findByRole('region', { name: 'Test time' });
    const pack = within(tests).getByRole('list', { name: 'By package' });
    expect(pack).toHaveTextContent('apps/server');
    expect(pack).toHaveTextContent('2 files');
    expect(pack).toHaveTextContent('setup 1.4 s');
    expect(pack).toHaveTextContent('tests 32 s');
    expect(pack).toHaveTextContent('teardown 0.1 s');
    expect(pack).toHaveTextContent('40 tests, median 0.2 s, 19 slower than the median');
    const files = within(tests).getByRole('list', { name: 'Slowest files' });
    expect(files).toHaveTextContent('turns-and-reads.test.ts');
    expect(files).toHaveTextContent('33.5 s');
    const slow = within(tests).getByRole('list', { name: 'Slowest tests' });
    expect(slow).toHaveTextContent('closes a turn and keeps its snapshot');
    expect(slow).toHaveTextContent('apps/server/test/turns.test.ts');
    expect(slow).toHaveTextContent('2.2 s');
  });

  it('names the files over 30 s and the tests over 1 s, and no such list when nothing is over', async () => {
    show();
    const tests = await screen.findByRole('region', { name: 'Test time' });
    const files = within(tests).getByRole('list', { name: 'Files over 30 s' });
    expect(files).toHaveTextContent('turns-and-reads.test.ts');
    expect(files).toHaveTextContent('33.5 s');
    const slow = within(tests).getByRole('list', { name: 'Tests over 1 s' });
    expect(slow).toHaveTextContent('closes a turn and keeps its snapshot');
    expect(slow).toHaveTextContent('apps/server/test/turns.test.ts');
    cleanup();
    show(ok({ ...REPORT, department: { ...DEV, tests: { ...DEV.tests, overBudgetFiles: [], overBudgetTests: [] } } }));
    const none = await screen.findByRole('region', { name: 'Test time' });
    expect(within(none).getByRole('list', { name: 'Slowest files' })).toBeInTheDocument();
    expect(within(none).queryByRole('list', { name: 'Files over 30 s' })).not.toBeInTheDocument();
    expect(within(none).queryByRole('list', { name: 'Tests over 1 s' })).not.toBeInTheDocument();
  });

  it('leaves out what an older log did not say', async () => {
    show(ok({ ...REPORT, department: { ...DEV, tests: { ...DEV.tests, packages: [{ ...DEV.tests.packages[0]!, setupMs: null, testsMs: null, teardownMs: null, tests: null, medianTestMs: null, slowerThanMedian: null }] } } }));
    const pack = await screen.findByRole('list', { name: 'By package' });
    expect(pack).not.toHaveTextContent('setup');
    expect(pack).not.toHaveTextContent('median');
    expect(pack).toHaveTextContent('2 files');
  });

  it('says a turn has no test times', async () => {
    show(ok({ ...REPORT, department: { ...DEV, rows: ROWS.filter(r => r.section !== 'tests'), tests: { packages: [], slowestFiles: [], slowestTests: [], overBudgetFiles: [], overBudgetTests: [] } } }));
    const tests = await screen.findByRole('region', { name: 'Test time' });
    expect(tests).toHaveTextContent('No test times in this turn.');
    expect(within(tests).queryByRole('list')).not.toBeInTheDocument();
  });

  it('says outright that a department without a description has no numbers of its own', async () => {
    show();
    expect(await screen.findByText('This department has no description yet, so the report has no numbers of its own for it.')).toBeInTheDocument();
  });

  it('says where the numbers of a described department come from', async () => {
    show(ok({ ...REPORT, department: { ...DEV, described: true } }));
    await screen.findByText(/Numbers of its own come from the description of the department/);
    expect(screen.queryByText(/has no description yet/)).not.toBeInTheDocument();
  });

  it('says the department had no tasks in the turn', async () => {
    show(ok({ ...REPORT, department: null }));
    expect(await screen.findByText('This department had no tasks in turn 9.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Turn' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 4 })).not.toBeInTheDocument();
  });

  it('says no turn has run yet, with nothing to try again', async () => {
    show([404, { error: { code: 'not_found', message: 'No turn has run yet.', reason: 'turn_unknown' } }]);
    expect(await screen.findByText('This department has not run a turn yet, so there is nothing to report.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('tells a person without the whole department why there is no report', async () => {
    show([404, { error: { code: 'not_found', message: 'This department does not exist.', reason: 'department_unknown' } }]);
    expect(await screen.findByText('Only people who reach the whole department see its report.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows a failure and tries again on request', async () => {
    const user = userEvent.setup();
    let failing = true;
    const calls = show(() => (failing ? [500, { error: { code: 'internal', message: 'Something went wrong on our side.' } }] : ok(REPORT)));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('From issue to acceptance, median');
    expect(calls).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps what it shows when a later refresh fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => { vi.useRealTimers(); });
    let failing = false;
    show(() => (failing ? [500, { error: { code: 'internal', message: 'Something went wrong on our side.' } }] : ok(REPORT)));
    await screen.findByText('From issue to acceptance, median');
    failing = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByText('From issue to acceptance, median')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('speaks Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    show();
    await screen.findByText('От выдачи до принятия, медиана');
    const median = rowOf('От выдачи до принятия, медиана');
    expect(median).toHaveTextContent('1 ч 36 мин');
    expect(median).toHaveTextContent('к ходу 8: −20%');
    expect(screen.getByRole('combobox', { name: 'Ход' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 4, name: 'Ожидания по причинам' })).toBeInTheDocument();
    expect(screen.getByText('Нет описания отдела, поэтому своих цифр отдела в отчете нет.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[ё—]/);
  });
});

describe('the report refreshes', () => {
  it('every minute while the turn runs and never after it closed', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const calls = mockApi({ [PATH]: ok(REPORT), [`${PATH}?turn=8`]: ok({ ...REPORT, turn: turn(8) }) });
    const { rerender, unmount } = renderHook(({ turn }) => useDepartmentPipeline('d2', turn), { initialProps: { turn: null as number | null } });
    await act(async () => {});
    expect(calls).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls).toHaveLength(2);
    rerender({ turn: 8 });
    await act(async () => {});
    expect(calls).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(calls).toHaveLength(3);
    unmount();
  });
});

describe('the third tab of the speed panel', () => {
  const panel = (tree = DEV_TREE) => render(<LanguageProvider><SpeedPanel tree={tree} department={DEPARTMENT} onAgent={() => {}} /></LanguageProvider>);

  it("frames the turn's totals on the surface with a line round them", () => {
    panel();
    const totals = document.querySelector('dl');
    expect(totals).toHaveClass('sum');
    /* jsdom lays nothing out, so the frame is read from theme.css: the drawer's own rule sets the grid, this one the frame. */
    expect(['padding', 'background', 'box-shadow', 'min-width'].map(p => decl('.sum', p))).toEqual(['12px 14px', 'var(--surface)', 'inset 0 0 0 1px var(--line)', '0']);
  });

  it('asks for the report only when it is opened', async () => {
    const user = userEvent.setup();
    const calls = mockApi({ [PATH]: ok(REPORT) });
    panel();
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('tab', { name: 'Report' }));
    expect(screen.getByRole('tab', { name: 'Report' })).toHaveAttribute('aria-selected', 'true');
    await within(screen.getByRole('tabpanel')).findByText('From issue to acceptance, median');
    expect(calls.map(c => c.path)).toEqual(['/api/departments/d2/pipeline']);
  });

  it('opens with no turn running, since a closed turn still has a report', async () => {
    const user = userEvent.setup();
    mockApi({ [PATH]: ok({ ...REPORT, turn: turn(8) }) });
    panel({ ...DEV_TREE, turn: null });
    expect(screen.getByRole('tabpanel')).toHaveTextContent('This department runs no turn now.');
    await user.click(screen.getByRole('tab', { name: 'Report' }));
    await within(screen.getByRole('tabpanel')).findByText('From issue to acceptance, median');
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('This department runs no turn now.');
  });

  it('keeps the line of the running turn off the report', async () => {
    const user = userEvent.setup();
    mockApi({ [PATH]: ok(REPORT) });
    panel();
    expect(document.querySelector('.spd-sub')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Report' }));
    await screen.findByText('From issue to acceptance, median');
    expect(document.querySelector('.spd-sub')).not.toBeInTheDocument();
  });

  it('walks all three tabs with the arrow keys, around the ends', async () => {
    const user = userEvent.setup();
    mockApi({ [PATH]: ok(REPORT) });
    panel();
    const tab = (name: string) => screen.getByRole('tab', { name });
    await user.click(tab('Speed'));
    await user.keyboard('{ArrowRight}');
    expect(tab('Idle')).toHaveFocus();
    expect(tab('Idle')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(tab('Report')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(tab('Speed')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tab('Report')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tab('Idle')).toHaveFocus();
    await user.keyboard('a');
    expect(tab('Idle')).toHaveAttribute('aria-selected', 'true');
  });
});
