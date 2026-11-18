import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { TaskLine } from '../src/types';
import { TrackerList } from '../src/ui/TrackerViews';
import { taskRoute } from './task-route';

const department = { id: 'marketing', name: 'Marketing' };
const executor = { id: 'luisa', name: 'Luisa Rivera', kind: 'worker' as const, role: null };
const responsible = { id: 'max', name: 'Max' };
const goal = { id: 'goal', number: 1, title: '500 subscribers' };
const since = '2026-11-14T12:00:00.000Z';

function task(over: Partial<TaskLine> = {}): TaskLine {
  return {
    id: 'plan', number: 267, title: 'Plan the mailing', brief: '', status: 'working', department, product: null,
    executor, assignee: executor, turn: null, parentId: null, waitsFor: [], echelons: taskRoute(), goal, responsible,
    createdAt: since, updatedAt: since, dueAt: null, time: { inStatusSince: since, workSeconds: 0, waitsOn: [] }, ...over,
  };
}

function list(tasks: TaskLine[], onAddTask = vi.fn()) {
  const rows = { selected: null, onOpenTask: vi.fn(), onOpenGoal: vi.fn() };
  render(<LanguageProvider><TrackerList tasks={tasks} all={tasks} rows={rows} empty="Empty" onAddTask={onAddTask} /></LanguageProvider>);
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
  expect(within(row).getByRole('img', { name: 'Ghost: a one-shot call, appears for one task and is gone' })).toHaveAttribute('data-worker-kind', 'ghost');
});

it('reads each task across one line, opens its goal and shows a late date', async () => {
  const user = userEvent.setup();
  const rows = list([task({ dueAt: '2020-01-01T00:00:00.000Z' })]);
  expect(screen.getByText('Name', { selector: '.tr-head span' })).toBeInTheDocument();
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  expect(within(row).getByText('Plan the mailing').compareDocumentPosition(within(row).getByText('#267')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(row).getByRole('img', { name: 'In work' })).toBeInTheDocument();
  expect(within(row).getByText(/1 Jan, late/)).toHaveClass('tp-late');
  await user.click(within(row).getByRole('link', { name: goal.title }));
  expect(rows.onOpenGoal).toHaveBeenCalledWith(goal.id);
});

it('collapses a status group and opens the task form from its last row', async () => {
  const user = userEvent.setup();
  const add = vi.fn();
  list([task(), task({ id: 'done', number: 270, title: 'Sent', status: 'done' })], add);
  const group = screen.getByRole('button', { name: 'In work: 1' });
  expect(screen.getByRole('listitem', { name: '#270 Sent' })).toBeInTheDocument();
  await user.click(group);
  expect(group).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('listitem', { name: '#267 Plan the mailing' })).toBeNull();
  await user.click(group);
  await user.click(screen.getByRole('button', { name: 'Add task' }));
  expect(add).toHaveBeenCalledOnce();
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
  expect(within(row).getByText('Waits for Max, 3 days')).toHaveClass('tr-wait');
  expect(within(row).getByText('needed for #413 Sales')).toBeInTheDocument();
  expect(row).not.toHaveTextContent('waits for Luisa');
  expect(within(screen.getByRole('listitem', { name: '#413 Send' })).getByText('After #267')).toHaveClass('tr-relation');
  expect(screen.getByRole('button', { name: 'Waits for a person: 1' })).toBeInTheDocument();
});

it('uses status shapes, stable identity marks and a colored priority arrow', () => {
  const rows = { selected: null, onOpenTask: vi.fn(), programOf: () => 'claude' as const };
  const tasks = [
    task({ priority: 'urgent' }), task({ id: 'done', number: 270, title: 'Sent', status: 'done' }),
    task({ id: 'open', number: 271, title: 'Draft', status: 'open' }),
    task({ id: 'wait', number: 272, title: 'Proof', status: 'waiting', time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind: 'person', who: { kind: 'person', ...responsible }, reason: null, since }] } }),
  ];
  render(<LanguageProvider><TrackerList tasks={tasks} all={tasks} rows={rows} empty="Empty" /></LanguageProvider>);
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  expect(within(row).getByRole('img', { name: 'Luisa Rivera' })).toHaveAttribute('data-program', 'claude');
  expect(within(row).getByRole('img', { name: 'Max' })).toHaveClass('tr-avatar');
  expect(within(row).getByText('Urgent')).toHaveClass('tr-priority', 'urgent');
  expect(within(row).getByText('Urgent').querySelector('.tr-priority-arrow')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'In work' })).toHaveClass('working');
  expect(screen.getByRole('img', { name: 'Done' })).toHaveClass('done');
  expect(screen.getByRole('img', { name: 'Not started' })).toHaveClass('open');
  expect(screen.getByRole('img', { name: 'Waits for a person' })).toHaveClass('waiting');
  expect(screen.getByRole('button', { name: 'Done: 1' }).closest('section')).toHaveClass('done');
});

it('expands under the parent title and keeps child facts in their columns', async () => {
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
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await user.click(toggle);
  const inline = within(parent).getByRole('listitem', { name: '#268 Pick the recipients' });
  expect(inline).toHaveTextContent('Low');
  expect(within(inline).getByRole('img', { name: 'Max' })).toBeInTheDocument();
  expect(inline.querySelector('.tr-task-name')).toHaveStyle('--tr-depth: 1');
  rerender(view(false));
  expect(within(parent).queryByRole('listitem', { name: '#268 Pick the recipients' })).toBeNull();
  rerender(view(true));
  expect(within(parent).getByRole('listitem', { name: '#268 Pick the recipients' })).toBeInTheDocument();
});

it('keeps complete names and labels with long task text in the stacked row', () => {
  const longTitle = 'UnbrokenTitle'.repeat(9);
  list([task({ title: longTitle, dueAt: '2020-01-01T00:00:00.000Z' })]);
  const row = screen.getByRole('listitem', { name: `#267 ${longTitle}` });
  expect(within(row).getByRole('button', { name: longTitle })).toBeInTheDocument();
  expect(within(row).getByText('Luisa Rivera')).toHaveClass('tr-id-name');
  expect(within(row).getByText('Max')).toHaveClass('tr-id-name');
  expect([...row.querySelectorAll('.tr-k')].map(label => label.textContent)).toEqual(['Executor', 'Responsible', 'Priority', 'Goal', 'Due']);
  expect(within(row).getByRole('link', { name: goal.title })).toBeInTheDocument();
});

it('groups person waits, active work, timers and failures by what each task needs', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T12:00:00.000Z'));
  const until = new Date(2026, 10, 18, 14, 0).toISOString();
  const external = (id: string, number: number, on?: NonNullable<TaskLine['externalWait']>['on'], extra: Partial<NonNullable<TaskLine['externalWait']>> = {}) =>
    task({ id, number, title: id, status: 'waiting', externalWait: { since, until, reason: 'Publish the draft', on, ...extra } });
  const examples = [
    external('Approval', 1, { kind: 'external', event: 'ceo' }),
    external('Employee', 2, { kind: 'employee', employee: 'trinity', name: 'Trinity' }),
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
  expect(work).toHaveTextContent('Trinity is on it');
  expect(work).toHaveTextContent('Test running');
  expect(within(work).getByText(/Fires at 14:00, 18 Nov/)).toHaveClass('scheduled');
  expect(work).toHaveTextContent('After #1317');
  expect(work).toHaveTextContent('Publish the draft');
  expect(screen.getByRole('region', { name: 'Waits for a person: 1' })).toHaveTextContent('Waits for the CEO');
  expect(screen.getByRole('region', { name: 'Failures: 2' })).toHaveTextContent('Machine unavailable');
  expect(screen.getByRole('region', { name: 'Failures: 2' })).toHaveTextContent('Time ran out');
  expect(screen.getByRole('region', { name: 'Stopped: 1' })).toHaveTextContent('Stopped work');
});

it('gives a long goal its own text wrap and keeps the link name in full', () => {
  const title = 'A goal '.repeat(20) + 'Identifier'.repeat(10);
  list([task({ goal: { ...goal, title } })]);
  const link = screen.getByRole('link', { name: title });
  expect(link).toHaveAttribute('dir', 'auto');
  expect(link).toHaveAttribute('href', expect.stringContaining('goal'));
});

it('surfaces a failed subtask while its parent stays folded', () => {
  const child = task({ id: 'failure', number: 268, parentId: 'plan', title: 'Check the addresses',
    time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind: 'run', who: null, reason: '42', since, failure: 'run' }] } });
  list([task(), child]);
  const failures = screen.getByRole('region', { name: 'Failures: 1' });
  expect(within(failures).getByRole('listitem', { name: '#268 Check the addresses' })).toHaveTextContent('Test run 42 failed');
  expect(within(screen.getByRole('region', { name: 'In work: 1' })).getByRole('button', { name: 'Subtasks: 0 of 1 done' })).toHaveAttribute('aria-expanded', 'false');
});
