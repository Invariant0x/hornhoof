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
  expect(within(row).getByText('waits for Max for 3 days')).toHaveClass('tr-wait');
  expect(within(row).getByText('needed for #413 Sales')).toBeInTheDocument();
  expect(row).not.toHaveTextContent('waits for Luisa');
  expect(within(screen.getByRole('listitem', { name: '#413 Send' })).getByText('waits for #267')).toHaveClass('tr-relation');
  expect(screen.getByRole('button', { name: 'Waits for a person: 1' })).toBeInTheDocument();
});

it('uses status shapes, stable identity marks and a colored priority arrow', () => {
  const rows = { selected: null, onOpenTask: vi.fn(), programOf: () => 'claude' as const };
  const tasks = [
    task({ priority: 'urgent' }), task({ id: 'done', number: 270, title: 'Sent', status: 'done' }),
    task({ id: 'open', number: 271, title: 'Draft', status: 'open' }),
    task({ id: 'wait', number: 272, title: 'Proof', status: 'waiting' }),
  ];
  render(<LanguageProvider><TrackerList tasks={tasks} all={tasks} rows={rows} empty="Empty" /></LanguageProvider>);
  const row = screen.getByRole('listitem', { name: '#267 Plan the mailing' });
  expect(within(row).getByRole('img', { name: 'Luisa Rivera' })).toHaveAttribute('data-program', 'claude');
  expect(within(row).getByRole('img', { name: 'Max' })).toHaveClass('tr-avatar');
  expect(within(row).getByText('Urgent')).toHaveClass('tr-priority', 'urgent');
  expect(within(within(row).getByText('Urgent')).getByTestId('priority-arrow')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'In work' })).toHaveClass('working');
  expect(screen.getByRole('img', { name: 'Done' })).toHaveClass('done');
  expect(screen.getByRole('img', { name: 'Not started' })).toHaveClass('open');
  expect(screen.getByRole('img', { name: 'Waiting' })).toHaveClass('waiting');
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
