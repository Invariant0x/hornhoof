import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { DEV_ORG, ME, mockApi, REQUESTS, TASK_DETAIL, TASKS, TURN } from './api-mock';

function shell(routes: Record<string, unknown> = {}) {
  const calls = mockApi({
    'GET /api/org': [200, DEV_ORG],
    'GET /api/requests': [200, { requests: [] }],
    'GET /api/turns': [200, { turns: [TURN] }],
    'GET /api/tasks?status=all': [200, { tasks: TASKS }],
    'GET /api/tasks/t12': [200, { task: TASK_DETAIL }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(
    <LanguageProvider>
      <Shell me={ME} onSignOut={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

async function openTask(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
  await user.click(await screen.findByRole('button', { name: /#12/ }));
  return screen.findByRole('complementary', { name: '#12 Checkout API' });
}

describe('a task', () => {
  it('puts what waits for the person at the top, with a field to answer, and says that writing to the agent counts too', async () => {
    const user = userEvent.setup();
    const stuck = {
      ...REQUESTS[0]!,
      id: 'r3',
      kind: 'stuck' as const,
      text: 'Ended 3 turns in a row on #12 without moving it. Tell it how to go on, or cancel the task.',
      agent: { id: 'b1', name: 'Bruno' },
      task: { ...REQUESTS[0]!.task, id: 't12', number: 12, title: 'Checkout API' },
    };
    const calls = shell({ 'GET /api/requests': [200, { requests: [REQUESTS[0], stuck] }], 'POST /api/requests/r3': [200, { request: { id: 'r3', status: 'answered' } }] });
    /* From the list of what waits, as a person goes. */
    await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
    await user.click(within(await screen.findByRole('region', { name: 'Waiting for you' })).getByRole('button', { name: /#12/ }));
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const waiting = await within(panel).findByRole('region', { name: 'Waiting for your answer' });
    /* Only this task's. */
    expect(within(waiting).getAllByRole('article')).toHaveLength(1);
    expect(waiting).toHaveTextContent('Bruno ended several turns in a row without moving #12. Write how it should go on, or cancel the task.');
    expect(waiting).not.toHaveTextContent('Ended 3 turns');
    expect(waiting).toHaveTextContent('Writing to the agent in its window or terminal counts as the answer too.');
    await user.type(within(waiting).getByLabelText('Your answer'), 'Run the tests first.');
    await user.click(within(waiting).getByRole('button', { name: 'Answer' }));
    expect(calls.find(c => c.path === '/api/requests/r3')?.body).toEqual({ answer: 'Run the tests first.' });
  });

  it('opens with where it stands at its gates, its brief, body, subtasks and log', async () => {
    const user = userEvent.setup();
    shell();
    const panel = await openTask(user);
    const gates = within(panel).getByRole('list', { name: 'Gates' });
    expect(within(gates).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Bruno, Backend engineer, did the work', 'Rita, Code reviewer, passed', 'Tom, Test engineer, checking now', 'Sam, Security engineer, next']);
    expect(panel).toHaveTextContent('Take card payments.');
    expect(within(panel).getByText('card token').tagName).toBe('STRONG');
    expect(within(panel).getByRole('button', { name: /#13 Refunds/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /#10 Payments/ })).toBeInTheDocument();
    const log = within(panel).getByRole('list', { name: 'Log' });
    expect(within(log).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      expect.stringContaining('Dana gave the task'),
      expect.stringMatching(/Bruno handed it in.*Endpoint done.*npm test: 42 passed/),
      expect.stringMatching(/Rita passed it.*Looks right./),
      expect.stringMatching(/Ivan commented.*EUR only./),
    ]);
  });

  it('posts a comment', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/tasks/t12/comments': [201, { task: TASK_DETAIL }] });
    const panel = await openTask(user);
    await user.type(within(panel).getByLabelText('Comment'), 'Ship it today.');
    await user.click(within(panel).getByRole('button', { name: 'Add comment' }));
    expect(calls.find(c => c.path === '/api/tasks/t12/comments')?.body).toEqual({ text: 'Ship it today.' });
  });

  it('asks before cancelling a task and the tasks under it', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/tasks/t12/cancel': [200, { task: { ...TASK_DETAIL, status: 'cancelled' } }] });
    const panel = await openTask(user);
    await user.click(within(panel).getByRole('button', { name: 'Cancel task' }));
    expect(calls.some(c => c.path === '/api/tasks/t12/cancel')).toBe(false);
    expect(panel).toHaveTextContent('Cancel #12 and its open subtasks?');
    await user.click(within(panel).getByRole('button', { name: 'Yes, cancel it' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/tasks/t12/cancel')).toBe(true);
  });

  it('opens a subtask from the list', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t13': [200, { task: { ...TASK_DETAIL, id: 't13', number: 13, title: 'Refunds', subtasks: [], parent: { id: 't12', number: 12, title: 'Checkout API' } } }] });
    const panel = await openTask(user);
    await user.click(within(panel).getByRole('button', { name: /#13 Refunds/ }));
    expect(await screen.findByRole('complementary', { name: '#13 Refunds' })).toBeInTheDocument();
  });
});
