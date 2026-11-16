import { taskRoute } from './task-route';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { EventView } from '../src/types';
import { CARD, DEV_ORG, ME, ORG, PEOPLE, TASK_DETAIL, decisions, mockApi } from './api-mock';
import { fakeStream } from './fake-stream';

const task = { id: 't12', number: 12, title: 'Checkout API', echelons: taskRoute(), stage: 0, gateCount: 0, bounces: 0 };
function company(hasTask = true, busy = false, events: EventView[] = []) {
  const org = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: d.employees.map(a => a.id === 'b1' ? { ...a, task: hasTask ? task : null } : a) })) };
  const card = { ...CARD, currentTask: hasTask ? { id: task.id, number: task.number, title: task.title } : null };
  const calls = mockApi({
    'GET /api/org': [200, org],
    'GET /api/people': [200, { people: PEOPLE }],
    'GET /api/requests': [200, decisions([])],
    'GET /api/agents/b1': [200, card],
    'GET /api/agents/b1/events?last=300': [200, { events, state: { ready: true, reason: null, busy, runningJobId: busy ? 'j1' : null, queued: 0 } }],
    'GET /api/tasks/t12': [200, { task: TASK_DETAIL }],
    'GET /api/tasks?status=open': [200, { tasks: [] }],
    'GET /api/updates': [200, { current: { version: '0.5.1', commit: 'abc1234', migrations: 1 }, available: false, latest: null, versions: [], updater: { present: false, status: null, waiting: null } }],
    'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
    'POST /api/agents/b1/stop': [200, {}],
    'DELETE /api/agents/b1': [200, {}],
  });
  return { calls, org, card };
}

async function openEmployee(user: ReturnType<typeof userEvent.setup>) {
  render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
  await user.click(await screen.findByRole('button', { name: /^Development/ }));
  await user.click(await screen.findByRole('button', { name: /Bruno/ }));
  return screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
}

afterEach(() => localStorage.clear());

describe('agent window task and controls', () => {
  it('starts the header with Close, Minimize and Full screen in keyboard order and keeps their actions', async () => {
    company();
    const user = userEvent.setup();
    const window = await openEmployee(user);
    const [close, minimize, full] = within(window).getAllByRole('button');
    expect(close).toHaveAccessibleName('Close');
    expect(minimize).toHaveAccessibleName('Minimize');
    expect(full).toHaveAccessibleName('Full screen');
    close!.focus();
    await user.keyboard('{Tab}');
    expect(minimize).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(window).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore Bruno, Backend engineer' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(window).toBeVisible();
    expect(window).toHaveFocus();
    close!.focus();
    await user.keyboard('{Tab}{Tab}');
    expect(full).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(full).toHaveAccessibleName('Restore size');
    expect(full).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Enter}');
    expect(full).toHaveAccessibleName('Full screen');
    expect(full).toHaveAttribute('aria-pressed', 'false');
    close!.focus();
    await user.keyboard('{Enter}');
    expect(window).not.toBeInTheDocument();
  });

  it('updates a coalesced report in place when another sender joins the same event', async () => {
    const stream = fakeStream();
    const message: NonNullable<EventView['message']> = { direction: 'in', from: { kind: 'agent', id: 'h1', name: 'Hana', role: null, department: null }, to: { kind: 'agent', id: 'b1', name: 'Bruno', role: null, department: null }, notification: { source: 'reported', tasks: [{ id: 't1', number: 223 }] } };
    const event: EventView = { seq: 1, kind: 'message', data: { text: 'Release verified.' }, jobId: 'j1', person: null, at: '2026-11-04T14:00:00Z', message };
    company(true, false, [event]);
    const window = await openEmployee(userEvent.setup());
    fireEvent.click(await within(window).findByRole('button', { name: 'Message from Hana via Hornhoof to Bruno' }));
    stream.send({ type: 'agent_event', agentId: 'b1', event: { ...event, seq: 2, message: { ...message, originSeq: 1, revision: 1, senders: [message.from, { ...message.from, id: 'h2', name: 'Rita' }] } } });
    expect(await within(window).findByRole('button', { name: 'Message from Hana, Rita via Hornhoof to Bruno' })).toBeInTheDocument();
    stream.send({ type: 'agent_event', agentId: 'b1', event });
    expect(await within(window).findByRole('button', { name: 'Message from Hana, Rita via Hornhoof to Bruno' })).toBeInTheDocument();
    expect(within(window).queryByRole('button', { name: 'Message from Hana via Hornhoof to Bruno' })).not.toBeInTheDocument();
    expect(within(window).getByText('Release verified.')).toBeVisible();
  });

  it.each(['About the department', 'Speed', 'Account', 'About', 'Settings', 'Versions'])('keeps Escape with %s instead of stopping the busy agent', async name => {
    const { calls } = company(true, true);
    const user = userEvent.setup();
    const window = await openEmployee(user);
    if (['Account', 'About', 'Settings', 'Versions'].includes(name)) {
      await user.click(screen.getByRole('button', { name: 'Account' }));
      if (name !== 'Account') await user.click(screen.getByRole('button', { name }));
    } else await user.click(screen.getByRole('button', { name }));
    const surface = name === 'Account' ? screen.getByRole('button', { name: 'Log out' })
      : ['About', 'Settings', 'Versions'].includes(name) ? await screen.findByRole('dialog')
      : await screen.findByRole('complementary', { name });
    await user.keyboard('{Escape}');
    expect(surface).not.toBeInTheDocument();
    expect(calls.filter(c => c.path.endsWith('/stop'))).toHaveLength(0);
    expect(window).toBeVisible();
    await user.keyboard('{Escape}');
    expect(calls.filter(c => c.path.endsWith('/stop'))).toHaveLength(1);
  });

  it('closes the account dialog before the drawer underneath on separate Escapes', async () => {
    const { calls } = company(true, true);
    const user = userEvent.setup();
    await openEmployee(user);
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    const drawer = screen.getByRole('complementary', { name: 'Speed' });
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'About' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(drawer).toBeVisible();
    expect(calls.filter(c => c.path.endsWith('/stop'))).toHaveLength(0);
    await user.keyboard('{Escape}');
    expect(drawer).not.toBeInTheDocument();
    expect(calls.filter(c => c.path.endsWith('/stop'))).toHaveLength(0);
  });

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
    expect(within(window).queryByRole('button', { name: 'Back to terminal' })).not.toBeInTheDocument();
    await user.click(within(window).getByRole('button', { name: 'Back to conversation' }));
    expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument();
    expect(input).toHaveValue('Keep this draft');
  });

  it('closes the window with the card when the employee is removed from the company', async () => {
    const { calls } = company();
    const user = userEvent.setup();
    const window = await openEmployee(user);
    await user.click(within(window).getByRole('button', { name: 'Card' }));
    const card = await within(window).findByRole('complementary', { name: 'Card: Bruno' });
    await user.click(await within(card).findByRole('button', { name: 'Remove from the company' }));
    await user.click(within(card).getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(window).not.toBeInTheDocument());
    expect(calls).toContainEqual({ method: 'DELETE', path: '/api/agents/b1', body: undefined });
  });

  it('shows an employee without a task only its switched off button, in Russian', async () => {
    company(false);
    localStorage.setItem('hh-lang', 'ru');
    const user = userEvent.setup();
    render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: /^Разработка/ }));
    await user.click(await screen.findByRole('button', { name: /Bruno/ }));
    const button = await screen.findByRole('button', { name: 'Нет задачи' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Нет задачи');
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('У агента сейчас нет задачи.')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument();
  });

  it('adds no line to the header while the card is on its way', async () => {
    mockApi({
      'GET /api/org': [200, DEV_ORG],
      'GET /api/requests': [200, decisions([])],
      'GET /api/agents/b1': () => new Promise(() => {}),
      'GET /api/agents/b1/events?last=300': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
    });
    const user = userEvent.setup();
    render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: /^Development/ }));
    await user.click(await screen.findByRole('button', { name: /Bruno/ }));
    const button = await screen.findByRole('button', { name: 'No task' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No task');
    expect(button.closest('.t-bar')?.querySelector('p')).toBeNull();
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

  it('returns the department ticker and layout space while minimized, including reopening the same agent', async () => {
    company();
    const user = userEvent.setup();
    const window = await openEmployee(user);
    const main = screen.getByRole('main');
    expect(main).toHaveClass('with-window');
    expect(main.querySelector('.dview .ticker')).not.toBeInTheDocument();
    await user.click(within(window).getByRole('button', { name: 'Minimize' }));
    expect(main).not.toHaveClass('with-window');
    expect(main.querySelector('.dview .ticker')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Restore Bruno, Backend engineer' }));
    expect(main).toHaveClass('with-window');
    expect(main.querySelector('.dview .ticker')).not.toBeInTheDocument();
    await user.click(within(window).getByRole('button', { name: 'Minimize' }));
    await user.click(within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ }));
    expect(main).toHaveClass('with-window');
    expect(window).toBeVisible();
    expect(main.querySelector('.dview .ticker')).not.toBeInTheDocument();
  });

  it('closes a task that no longer belongs to the employee when the live company changes', async () => {
    const { org, card } = company();
    const stream = fakeStream();
    const user = userEvent.setup();
    const window = await openEmployee(user);
    await user.click(within(window).getByRole('button', { name: 'Task' }));
    expect(await screen.findByRole('complementary', { name: '#12 Checkout API' })).toBeInTheDocument();
    for (const d of org.departments) for (const a of d.employees) a.task = null;
    card.currentTask = null;
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
      'GET /api/agents/orchestrator': [200, { ...CARD, id: 'a1', kind: 'orchestrator', currentTask: { id: 't12', number: 12, title: 'Checkout API' } }],
      'GET /api/tasks?status=open': [200, { tasks: [{ ...TASK_DETAIL, assignee: null }, own] }],
      'GET /api/tasks/t12': [200, { task: own }],
      'GET /api/requests': [200, decisions([])],
      'GET /api/agents/orchestrator/events?last=300': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
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
    const noticeButton = await screen.findByRole('button', { name: 'Hornhoof, recorded service message to Bruno' });
    expect(noticeButton).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(window).getByRole('button', { name: 'Minimize' }));
    const restore = screen.getByRole('button', { name: 'Restore Bruno, Backend engineer' });
    expect(fireEvent.keyDown(restore, { key: 'o', ctrlKey: true })).toBe(true);
    await user.click(restore);
    expect(noticeButton).toHaveAttribute('aria-expanded', 'false');
  });

});
