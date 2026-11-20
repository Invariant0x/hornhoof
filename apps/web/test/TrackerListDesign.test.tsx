import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { TaskLine } from '../src/types';
import { TrackerList } from '../src/ui/TrackerViews';
import { decl } from './css';
import { taskRoute } from './task-route';

const department = { id: 'marketing', name: 'Marketing' };
const executor = { id: 'leo', name: 'Leo Park', kind: 'worker' as const, role: null };
const responsible = { id: 'maya', name: 'Maya' };
const goal = { id: 'goal', number: 1, title: '500 subscribers' };
const since = '2026-11-14T12:00:00.000Z';

function task(over: Partial<TaskLine> = {}): TaskLine {
  return {
    id: 'plan', number: 267, title: 'Plan the mailing', brief: '', status: 'working', department, product: null,
    executor, assignee: executor, turn: null, parentId: null, waitsFor: [], echelons: taskRoute(), goal, responsible,
    createdAt: since, updatedAt: since, dueAt: null, time: { inStatusSince: since, workSeconds: 0, waitsOn: [] }, ...over,
  };
}

function list(tasks: TaskLine[]) {
  const rows = { selected: null, onOpenTask: vi.fn() };
  render(<LanguageProvider><TrackerList tasks={tasks} all={tasks} rows={rows} empty="Empty" /></LanguageProvider>);
  return rows;
}

it('keeps the executor name and program color alongside a generalist mark and marks a one-shot stage', () => {
  const oneShot = { review: { fanOut: 2, judge: null } };
  const example = task({ echelons: { ...taskRoute(), stage: 'review', phase: 'active', oneShot } });
  const rows = { selected: null, onOpenTask: vi.fn(), programOf: () => 'claude' as const, turnkeyOf: (id: string) => id === executor.id };
  render(<LanguageProvider><TrackerList tasks={[example]} all={[example]} rows={rows} empty="Empty" /></LanguageProvider>);
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  const mark = within(row).getByRole('img', { name: executor.name });
  expect(mark).toHaveAttribute('data-program', 'claude');
  expect(mark).toHaveAttribute('data-worker-kind', 'generalist');
  expect(mark).toHaveAccessibleDescription('Generalist: does a task whole');
  expect(mark.querySelector('svg rect')).toBeInTheDocument();
  const call = within(row).getByRole('img', { name: 'One-shot call: starts from zero each time, no memory' });
  expect(call.querySelector('path[d="M8 1 15 8 8 15 1 8Z"]')).toBeInTheDocument();
});

/* Ivan's word of 20.11 (#1770): the program the executor works in now, as its logo right after the initials, named for a
   screen reader and in a tooltip. A member with no plan and the person who answers for the task get none. */
it('puts the logo of the program the executor works in right after its initials, and none without a plan', () => {
  const planless = task({ id: 'idle', number: 268, title: 'Pick the recipients', executor: { ...executor, id: 'nora', name: 'Nora Lee' }, assignee: { ...executor, id: 'nora', name: 'Nora Lee' } });
  const rows = { selected: null, onOpenTask: vi.fn(), programOf: (id: string) => (id === executor.id ? 'codex' as const : null) };
  const tasks = [task(), planless];
  render(<LanguageProvider><TrackerList tasks={tasks} all={tasks} rows={rows} empty="Empty" /></LanguageProvider>);
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  const logo = within(row).getByRole('img', { name: 'Codex' });
  expect(logo).toHaveClass('pm', 'codex');
  expect(logo.querySelector('title')).toHaveTextContent('Codex');
  expect(within(row).getByRole('img', { name: executor.name }).nextElementSibling).toBe(logo);
  expect(within(row).getByRole('img', { name: responsible.name }).parentElement!.querySelector('.pm')).toBeNull();
  const idle = screen.getByRole('listitem', { name: '#268 Pick the recipients' });
  expect(within(idle).getByRole('img', { name: 'Nora Lee' })).toHaveAttribute('data-program', 'other');
  expect(idle.querySelector('.pm')).toBeNull();
});

it('reads each task across one line and shows a late date', () => {
  list([task({ dueAt: '2020-01-01T00:00:00.000Z' })]);
  expect(screen.getByText('Name', { selector: '.tr-head span' })).toBeInTheDocument();
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  expect(within(row).getByText('Plan the mailing').compareDocumentPosition(within(row).getByText('#267')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  /* The number stands on the title's own line, as in the mockup, not on a second line under it. */
  expect(within(row).getByText('#267').closest('.tr-name')).toContainElement(within(row).getByRole('button', { name: 'Plan the mailing' }));
  expect(row.querySelector('.tr-meta')).toBeNull();
  expect(within(row).getByRole('img', { name: 'In work' })).toBeInTheDocument();
  expect(within(row).getByText(/1 Jan, late/)).toHaveClass('tp-late');
});

/* The goal is the task card's to show: the list gives its width to the task's own words. */
it('shows no goal in a task row', () => {
  list([task()]);
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  expect(within(row).queryByRole('link', { name: goal.title })).toBeNull();
  expect(row).not.toHaveTextContent(goal.title);
  expect(screen.queryByText('Goal', { selector: '.tr-head span' })).toBeNull();
});

it('collapses a status group, keeps the headings under the first pill and adds no task row of its own', async () => {
  const user = userEvent.setup();
  list([task(), task({ id: 'done', number: 270, title: 'Sent', status: 'done' })]);
  const group = screen.getByRole('button', { name: 'In work: 1' });
  expect(screen.getByRole('listitem', { name: '#270 Sent' })).toBeInTheDocument();
  /* The column names stand once, inside the first group right under its pill, as the mockup's first table head. */
  const heads = document.querySelectorAll('.tr-head');
  expect(heads).toHaveLength(1);
  expect(group.closest('section')).toContainElement(heads[0] as HTMLElement);
  expect(group.closest('h2')!.compareDocumentPosition(heads[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(group);
  expect(group).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('listitem', { name: '#267 Plan the mailing' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add task' })).toBeNull();
});

it('shows typed waits for tasks and people and the other department that needs the work', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T12:00:00.000Z'));
  const blocker = task({ status: 'waiting', time: { inStatusSince: since, workSeconds: 0, waitsOn: [
    { kind: 'person', who: { kind: 'person', ...responsible }, reason: null, since },
    { kind: 'review', who: { kind: 'agent', id: executor.id, name: executor.name }, reason: null, since },
  ] } });
  const waiting = task({ id: 'send', number: 413, title: 'Send', status: 'waiting', department: { id: 'sales', name: 'Sales' }, waitsFor: [267],
    time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind: 'after', who: null, reason: '#267', since }] } });
  list([blocker, waiting]);
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  expect(within(row).getByText('Waits for Maya, 3 days')).toHaveClass('tr-wait');
  expect(within(row).getByText('needed for #413 Sales')).toBeInTheDocument();
  expect(row).not.toHaveTextContent('waits for Leo');
  expect(within(screen.getByRole('listitem', { name: '#413 Send' })).getByText('After #267')).toHaveClass('tr-relation');
  expect(screen.getByRole('button', { name: 'Waits for a person: 1' })).toBeInTheDocument();
});

it('uses status shapes and stable identity marks, and leaves priority to the card', () => {
  const rows = { selected: null, onOpenTask: vi.fn(), programOf: () => 'claude' as const };
  const tasks = [
    task({ priority: 'urgent' }), task({ id: 'done', number: 270, title: 'Sent', status: 'done' }),
    task({ id: 'open', number: 271, title: 'Draft', status: 'open' }),
    task({ id: 'wait', number: 272, title: 'Proof', status: 'waiting', time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind: 'person', who: { kind: 'person', ...responsible }, reason: null, since }] } }),
  ];
  render(<LanguageProvider><TrackerList tasks={tasks} all={tasks} rows={rows} empty="Empty" /></LanguageProvider>);
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  expect(within(row).getByRole('img', { name: 'Leo Park' })).toHaveAttribute('data-program', 'claude');
  expect(within(row).getByRole('img', { name: 'Maya' })).toHaveClass('tr-avatar');
  expect(row.querySelector('.tr-priority')).toBeNull();
  expect(screen.getByRole('img', { name: 'In work' })).toHaveClass('working');
  expect(screen.getByRole('img', { name: 'Done' })).toHaveClass('done');
  expect(screen.getByRole('img', { name: 'Not started' })).toHaveClass('open');
  expect(screen.getByRole('img', { name: 'Waits for a person' })).toHaveClass('waiting');
  expect(screen.getByRole('button', { name: 'Done: 1' }).closest('section')).toHaveClass('done');
});

it('opens subtasks as a tree under the parent title and keeps child facts in their columns', async () => {
  const user = userEvent.setup();
  const child = task({ id: 'child', parentId: 'plan', number: 268, title: 'Pick the recipients', status: 'open', priority: 'low' });
  const tasks = [task(), child];
  const rows = { selected: null, onOpenTask: vi.fn() };
  const view = (showSubtasks: boolean) => <LanguageProvider><TrackerList tasks={tasks} all={tasks} rows={rows} empty="Empty" showSubtasks={showSubtasks} /></LanguageProvider>;
  const { rerender } = render(view(true));
  const parent = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  const toggle = within(parent).getByRole('button', { name: 'Subtasks: 0 of 1 done' });
  expect(toggle.closest('.tr-name')).toContainElement(within(parent).getByRole('button', { name: 'Plan the mailing' }));
  expect(within(parent).getByText('1', { selector: '.tr-branch-count' }).querySelector('svg')).toBeInTheDocument();
  /* "Subtasks: show" shows them: the tree stands open, as the mockup's first task. */
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const inline = within(parent).getByRole('listitem', { name: '#268 Pick the recipients' });
  expect(inline).not.toHaveTextContent('Low');
  expect(within(inline).getByRole('img', { name: 'Maya' })).toBeInTheDocument();
  await user.click(toggle);
  expect(within(parent).queryByRole('listitem', { name: '#268 Pick the recipients' })).toBeNull();
  await user.click(toggle);
  expect(within(parent).getByRole('listitem', { name: '#268 Pick the recipients' }).querySelector('.tr-row-line')).toHaveStyle('--tr-depth: 1');
  rerender(view(false));
  expect(within(parent).queryByRole('listitem', { name: '#268 Pick the recipients' })).toBeNull();
  rerender(view(true));
  expect(within(parent).getByRole('listitem', { name: '#268 Pick the recipients' })).toBeInTheDocument();
});

it('puts the caret, status and title in one line, and a leaf row starts at its status ring', () => {
  const child = task({ id: 'child', parentId: 'plan', number: 268, title: 'Pick the recipients', status: 'open' });
  const leaf = task({ id: 'leaf', number: 269, title: 'Write the copy' });
  list([task(), child, leaf]);
  const parent = within(screen.getByRole('listitem', { name: '#267 Plan the mailing' }));
  const title = parent.getByRole('button', { name: 'Plan the mailing' });
  const name = title.closest('.tr-name')!;
  expect.soft([...name.children].slice(0, 2)).toEqual([parent.getByRole('button', { name: 'Subtasks: 0 of 1 done' }), parent.getByRole('img', { name: 'In work' })]);
  expect.soft(title.parentElement).toHaveClass('tr-line');
  const single = within(screen.getByRole('listitem', { name: '#269 Write the copy' }));
  const singleTitle = single.getByRole('button', { name: leaf.title });
  expect.soft(singleTitle.closest('.tr-name')!.firstElementChild).toBe(single.getByRole('img', { name: 'In work' }));
  expect.soft(single.queryByRole('button', { name: /Subtasks/ })).toBeNull();
});

it('puts the count, number and wait note after the title on its line', () => {
  const parent = task({ time: { inStatusSince: since, workSeconds: 0, waitsOn: [
    { kind: 'review', who: { kind: 'agent', id: executor.id, name: executor.name }, reason: 'Check the mailing', since },
  ] } });
  list([parent, task({ id: 'child', parentId: parent.id, number: 268, title: 'Pick the recipients' })]);
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  const title = within(row).getByRole('button', { name: parent.title });
  const count = within(row).getByText('1', { selector: '.tr-branch-count' });
  const number = within(row).getByText('#267');
  const note = row.querySelector('.tr-wait');
  expect.soft([...count.parentElement!.children]).toEqual([title, count, number, note]);
  expect.soft(count.parentElement).toHaveClass('tr-line');
});

it('draws the rows, rings, pills and chips at the mockup sizes', () => {
  const desktop = 'tr-list (width > 640px)';
  expect.soft(decl('.tr-cells', 'grid-template-columns', desktop)).toBe('subgrid');
  /* td: 7px 8px around a 22px avatar, 13.5px, a line under each row, the cells in the middle of its height: a 37px row.
     What is pressed in a row is 24px high for a mouse (WCAG 2.5.8), so 6px above and below keep the row at 37px. Each cell
     keeps its own 8px at both sides, so the shares of the columns are the mockup's to the pixel. */
  expect.soft(decl('.tr-list', '--row')).toBe('var(--tracker-target-fine)');
  expect.soft(decl('.tr-cells', 'padding')).toBe('6px 0');
  expect.soft(decl('.tr-cells > *', 'padding-inline')).toBe('8px');
  expect.soft(decl('.tr-cells', 'font-size')).toBe('13.5px');
  expect.soft(decl('.tr-cells', 'border-block-end')).toBe('1px solid var(--line)');
  expect.soft(decl('.tr-cells', 'align-items')).toBe('center');
  /* th: 500 12px, muted, 6px 8px. */
  expect.soft(decl('.tr-head', 'font')).toBe('500 12px var(--f-body)');
  expect.soft(decl('.tr-head', 'padding-block')).toBe('6px');
  /* .nm: a flex line with 8px gaps that wraps; a subtask starts 44px in. */
  expect.soft(decl('.tr-name', 'display')).toBe('flex');
  expect.soft(decl('.tr-name', 'gap')).toBe('8px');
  expect.soft(decl('.tr-line', 'flex-wrap')).toBe('wrap');
  expect.soft(decl('.tr-task-name', 'padding-inline-start') ?? '').toContain('36px');
  /* .dot: a 14px ring of 2px; .caret 18px; .num 12px mono; .subn 12px; .tg 11px 600 with a border. */
  /* Its size and ring are tokens of their own since the working-now core (#1628): the same 14 px and 2 px. */
  expect.soft(decl('.tr-status-dot', 'inline-size')).toBe('var(--tracker-dot-size)');
  expect.soft(decl(':root', '--tracker-dot-size')).toBe('14px');
  expect.soft(decl('.tr-status-dot', 'border')).toBe('var(--tracker-dot-ring) solid var(--line2)');
  expect.soft(decl(':root', '--tracker-dot-ring')).toBe('2px');
  expect.soft(decl('.tr-status-dot.open', 'border-style')).toBe('dashed');
  expect.soft(decl('.tr-row-caret', 'inline-size')).toBe('18px');
  expect.soft(decl('.tr-line .tr-no', 'font')).toBe('12px var(--f-mono)');
  expect.soft(decl('.tr-branch-count', 'font-size')).toBe('12px');
  expect.soft(decl('.tr-line :is(.tr-wait, .tr-relation)', 'font')).toBe('600 11px var(--f-body)');
  expect.soft(decl('.tr-line :is(.tr-wait, .tr-relation)', 'padding')).toBe('1px 6px');
  expect.soft(decl('.tr-line .tr-wait.person', 'color')).toBe('var(--pink-ink)');
  expect.soft(decl('.tr-line .tr-wait.person', 'font-size')).toBe('inherit');
  /* .pill and .grp: 600 12px display, 3px 10px, uppercase, .03em; 14px above the group, 4px under it, 10px between. */
  expect.soft(decl('.tr-status-pill', 'font')).toBe('600 12px var(--f-display)');
  expect.soft(decl('.tr-status-pill', 'padding')).toBe('3px 10px');
  expect.soft(decl('.tr-status-pill', 'letter-spacing')).toBe('.03em');
  expect.soft(decl('.tr-status-pill', '--cut')).toBe('calc(5px * var(--cut-k))');
  expect.soft(decl('.tr-group-head', 'margin')).toBe('14px 0 4px');
  expect.soft(decl('.tr-group-toggle', 'gap')).toBe('10px');
  expect.soft(decl('.tr-group-toggle .tr-count', 'font')).toBe('13px var(--f-body)');
  /* .late and the due date in ink or attention text. */
  expect.soft(decl('.tr-row-line .tp-late', 'color')).toBe('var(--pink-ink)');
  expect.soft(decl('.tr-title', 'overflow-wrap')).toBe('anywhere');
  expect.soft(decl('.tr-title', 'font-weight')).toBe('400');
});

it.each([null, 'plan'])('shares the mockup column proportions with selection %s', selected => {
  const example = task();
  const rows = { selected, onOpenTask: vi.fn() };
  render(<LanguageProvider><TrackerList tasks={[example]} all={[example]} rows={rows} empty="Empty" /></LanguageProvider>);
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  const desktop = 'tr-list (width > 640px)';
  const people = '.tr-cell.tr-cell-person';
  for (const name of [executor.name, responsible.name]) {
    expect.soft(within(row).getByRole('img', { name }).closest(people)).toBeInTheDocument();
  }
  /* The task takes two thirds of the width, the executor, the responsible and the due date a ninth each, none under what
     its words and marks need. */
  expect.soft(decl('.tr-list-grid', 'grid-template-columns', desktop)).toBe('minmax(min-content, 6fr) repeat(3, minmax(min-content, 1fr))');
  /* An avatar is 22px: a circle for a person, a 4px square for an employee, with the page's colour around it. */
  expect.soft(decl('.tr-mark:is(.tr-avatar, .tr-executor)', 'min-inline-size')).toBe('22px');
  expect.soft(decl('.tr-mark:is(.tr-avatar, .tr-executor)', 'font')).toBe('600 10.5px var(--f-body)');
  expect.soft(decl('.tr-mark:is(.tr-avatar, .tr-executor)', 'border')).toBe('2px solid var(--bg)');
  expect.soft(decl('.tr-executor', 'border-radius')).toBe('4px');
  /* A column heading keeps its words whole, so a narrow column widens to its longest word instead of splitting it by letters. */
  expect.soft(decl('.tr-head > span', 'overflow-wrap')).toBe('normal');
  expect(row.firstElementChild?.classList.contains('on')).toBe(Boolean(selected));
});

it('keeps complete names and labels with long task text in the stacked row', () => {
  const longTitle = 'UnbrokenTitle'.repeat(9);
  list([task({ title: longTitle, dueAt: '2020-01-01T00:00:00.000Z' })]);
  const row = screen.getByRole('listitem', { name: `#267 ${longTitle}` });
  expect(within(row).getByRole('button', { name: longTitle })).toBeInTheDocument();
  expect(within(row).getByText('Leo Park')).toHaveClass('tr-id-name');
  expect(within(row).getByText('Maya')).toHaveClass('tr-id-name');
  const facts = [...row.querySelectorAll('.tr-k')].map(label => label.textContent);
  expect(facts).toEqual(['Executor', 'Responsible', 'Due']);
  expect([...document.querySelectorAll('.tr-head > span')].map(label => label.textContent)).toEqual(['Name', ...facts]);
});

it('groups person waits, active work, timers and failures by what each task needs', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T12:00:00.000Z'));
  const until = new Date(2026, 10, 18, 14, 0).toISOString();
  const external = (id: string, number: number, on?: NonNullable<TaskLine['externalWait']>['on'], extra: Partial<NonNullable<TaskLine['externalWait']>> = {}) =>
    task({ id, number, title: id, status: 'waiting', externalWait: { since, until, reason: 'Publish the draft', on, ...extra } });
  const examples = [
    external('Approval', 1, { kind: 'external', event: 'ceo' }),
    external('Employee', 2, { kind: 'employee', employee: 'abel', name: 'Abel' }),
    external('Checks', 3, undefined, { run: 'test' }),
    external('Scheduled', 4, { kind: 'external', event: 'time' }),
    external('Unavailable', 5, { kind: 'external', event: 'machine' }),
    external('Expired', 6, { kind: 'external', event: 'other' }, { until: since }),
    external('Outside work', 7, { kind: 'external', event: 'other' }),
    task({ id: 'after', number: 8, title: 'Follow-up', status: 'waiting', waitsFor: [1317] }),
    task({ id: 'stopped', number: 9, title: 'Stopped work', status: 'blocked' }),
  ];
  list(examples);
  const work = screen.getByRole('region', { name: 'In work: 5' });
  expect(work).toHaveTextContent('Abel is on it');
  expect(work).toHaveTextContent('Test running');
  expect(within(work).getByText(/Fires at 14:00, 18 Nov/)).toHaveClass('scheduled');
  expect(work).toHaveTextContent('After #1317');
  expect(work).toHaveTextContent('Publish the draft');
  expect(screen.getByRole('region', { name: 'Waits for a person: 1' })).toHaveTextContent('Waits for the CEO');
  expect(screen.getByRole('region', { name: 'Failures: 2' })).toHaveTextContent('Machine unavailable');
  expect(screen.getByRole('region', { name: 'Failures: 2' })).toHaveTextContent('Time ran out');
  expect(screen.getByRole('region', { name: 'Stopped: 1' })).toHaveTextContent('Stopped work');
});

it('surfaces a failed subtask in Failures as well as under its task', () => {
  const child = task({ id: 'failure', number: 268, parentId: 'plan', title: 'Check the addresses',
    time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind: 'run', who: null, reason: '42', since, failure: 'run' }] } });
  list([task(), child]);
  const failures = screen.getByRole('region', { name: 'Failures: 1' });
  expect(within(failures).getByRole('listitem', { name: '#268 Check the addresses' })).toHaveTextContent('Test run #42 failed');
  expect(within(screen.getByRole('region', { name: 'In work: 1' })).getByRole('listitem', { name: '#268 Check the addresses' })).toBeInTheDocument();
});

/* Goals have their own page; the list of tasks holds no goal cards. */
it('keeps goal cards out of the task list', () => {
  list([task()]);
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(document.querySelector('.tr-goals')).toBeNull();
});
