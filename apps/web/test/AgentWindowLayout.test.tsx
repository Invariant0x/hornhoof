import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { EventView } from '../src/types';
import { CARD, DEV_ORG, ME, ORG, TASK_DETAIL, decisions, mockApi } from './api-mock';
import { fakeStream } from './fake-stream';

const task = { id: 't12', number: 12, title: 'Checkout API', stage: 0, gateCount: 0, bounces: 0 };
function company(hasTask = true, busy = false, events: EventView[] = []) {
  const org = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: d.employees.map(a => a.id === 'b1' ? { ...a, task: hasTask ? task : null } : a) })) };
  const calls = mockApi({
    'GET /api/org': [200, org],
    'GET /api/requests': [200, decisions([])],
    'GET /api/agents/b1': [200, CARD],
    'GET /api/agents/b1/events?after=0': [200, { events, state: { ready: true, reason: null, busy, runningJobId: busy ? 'j1' : null, queued: 0 } }],
    'GET /api/tasks/t12': [200, { task: TASK_DETAIL }],
    'GET /api/tasks?status=open': [200, { tasks: [] }],
  });
  return { calls, org };
}

async function openEmployee(user: ReturnType<typeof userEvent.setup>) {
  render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
  await user.click(await screen.findByRole('button', { name: /Development/ }));
  await user.click(await screen.findByRole('button', { name: /Bruno/ }));
  return screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
}

afterEach(() => localStorage.clear());

describe('agent window task and controls', () => {
  it('opens the current task with its existing details and log, and returns to the conversation without losing a draft', async () => {
    company();
    const user = userEvent.setup();
    const window = await openEmployee(user);
    const input = within(window).getByRole('textbox', { name: 'Write to Bruno' });
    await user.type(input, 'Keep this draft');
    expect(within(window).getByRole('button', { name: 'Task' })).toHaveAttribute('title', 'Task');
    await user.click(within(window).getByRole('button', { name: 'Task' }));
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    expect(within(panel).getByText('POST /checkout takes a', { exact: false })).toBeInTheDocument();
    expect(within(panel).getByRole('list', { name: 'Log' })).toHaveTextContent('Endpoint done.');
    await user.click(within(window).getByRole('button', { name: 'Back to terminal' }));
    expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument();
    expect(input).toHaveValue('Keep this draft');
  });

  it('explains why an employee without a task cannot open it, in Russian', async () => {
    company(false);
    localStorage.setItem('hh-lang', 'ru');
    const user = userEvent.setup();
    render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: /Разработка/ }));
    await user.click(await screen.findByRole('button', { name: /Bruno/ }));
    const button = await screen.findByRole('button', { name: 'Нет задачи' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby');
    expect(screen.getByRole('status')).toHaveTextContent('У агента сейчас нет задачи.');
    expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument();
  });

  it('minimizes to a restore button while the rest of the app works, preserving the window size and draft', async () => {
    company();
    const user = userEvent.setup();
    const window = await openEmployee(user);
    const input = within(window).getByRole('textbox', { name: 'Write to Bruno' });
    await user.type(input, 'Keep this draft');
    await user.click(within(window).getByRole('button', { name: 'Full screen' }));
    expect(within(window).getByRole('button', { name: 'Restore size' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(window).getByRole('button', { name: 'Minimize' }));
    expect(window).not.toBeVisible();
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'People' }));
    expect(await screen.findByRole('heading', { name: 'People' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore Bruno, Backend engineer' }));
    expect(window).toBeVisible();
    expect(window).toHaveFocus();
    expect(input).toHaveValue('Keep this draft');
    await user.click(within(window).getByRole('button', { name: 'Restore size' }));
    expect(within(window).getByRole('button', { name: 'Full screen' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(window).getByRole('button', { name: 'Close' }));
    expect(window).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Restore Bruno/ })).not.toBeInTheDocument();
  });

  it('closes a task that no longer belongs to the employee when the live company changes', async () => {
    const { org } = company();
    const stream = fakeStream();
    const user = userEvent.setup();
    const window = await openEmployee(user);
    await user.click(within(window).getByRole('button', { name: 'Task' }));
    expect(await screen.findByRole('complementary', { name: '#12 Checkout API' })).toBeInTheDocument();
    for (const d of org.departments) for (const a of d.employees) a.task = null;
    stream.send({ type: 'org' });
    expect(await within(window).findByRole('button', { name: 'No task' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument());
  });
  it('keeps Escape with the open task or other screens while minimized, and stops only a visible busy agent', async () => {
    const { calls } = company(true, true);
    const user = userEvent.setup();
    const window = await openEmployee(user);
    await user.click(within(window).getByRole('button', { name: 'Task' }));
    expect(await screen.findByRole('complementary', { name: '#12 Checkout API' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument();
    expect(calls.filter(c => c.path.endsWith('/stop'))).toHaveLength(0);
    await user.click(within(window).getByRole('button', { name: 'Minimize' }));
    await user.keyboard('{Escape}');
    expect(calls.filter(c => c.path.endsWith('/stop'))).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Restore Bruno, Backend engineer' }));
    await user.keyboard('{Escape}');
    expect(calls.filter(c => c.path.endsWith('/stop'))).toHaveLength(1);
  });

  it('restores a minimized window when the same employee is opened again', async () => {
    company();
    const user = userEvent.setup();
    const window = await openEmployee(user);
    await user.click(within(window).getByRole('button', { name: 'Minimize' }));
    await user.click(within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ }));
    await waitFor(() => expect(window).toBeVisible());
    expect(screen.queryByRole('button', { name: /^Restore Bruno/ })).not.toBeInTheDocument();
  });

  it('opens the task assigned to the orchestrator without treating unassigned tasks as his', async () => {
    const own = { ...TASK_DETAIL, assignee: { ...TASK_DETAIL.assignee!, id: ORG.orchestrator!.id } };
    mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/tasks?status=open': [200, { tasks: [{ ...TASK_DETAIL, assignee: null }, own] }],
      'GET /api/tasks/t12': [200, { task: own }],
      'GET /api/requests': [200, decisions([])],
      'GET /api/agents/orchestrator/events?after=0': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
      'POST /api/agents/orchestrator/start': [200, { started: false }],
    });
    const user = userEvent.setup();
    render(<Shell me={ME} welcome onSignOut={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Task' }));
    expect(await screen.findByRole('complementary', { name: '#12 Checkout API' })).toBeInTheDocument();
  });

  it('leaves Ctrl+O to the page while the conversation is minimized', async () => {
    const notice: EventView = { seq: 1, kind: 'message', data: { text: 'Check the checkout.' }, jobId: null, person: null, at: '2026-11-04T00:00:00Z', message: {
      direction: 'in', from: { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null },
      to: { kind: 'agent', id: 'b1', name: 'Bruno', role: null, department: null, agentKind: 'worker' },
    } };
    company(true, false, [notice]);
    const user = userEvent.setup();
    const window = await openEmployee(user);
    const noticeButton = await screen.findByRole('button', { name: 'Hornhoof notice to Bruno' });
    expect(noticeButton).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(window).getByRole('button', { name: 'Minimize' }));
    const restore = screen.getByRole('button', { name: 'Restore Bruno, Backend engineer' });
    expect(fireEvent.keyDown(restore, { key: 'o', ctrlKey: true })).toBe(true);
    await user.click(restore);
    expect(noticeButton).toHaveAttribute('aria-expanded', 'false');
  });

});
