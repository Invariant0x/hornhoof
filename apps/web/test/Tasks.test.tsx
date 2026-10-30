import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { Me } from '../src/types';
import { CLOSED_TASKS, DEV_ORG, ME, mockApi, REQUESTS, TASKS, TURN } from './api-mock';
import { fakeStream } from './fake-stream';

const OPEN = '/api/tasks?status=open';

function shell(routes: Record<string, unknown> = {}, me: Me = ME) {
  const calls = mockApi({
    'GET /api/org': [200, DEV_ORG],
    'GET /api/requests': [200, { requests: REQUESTS }],
    'GET /api/turns/current': [200, { turn: TURN }],
    [`GET ${OPEN}`]: [200, { tasks: TASKS }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(
    <LanguageProvider>
      <Shell me={me} onSignOut={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

async function openTasks(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
  return screen.findByRole('heading', { level: 1, name: 'Tasks' });
}

describe('the tracker', () => {
  it('counts what waits for people in the navigation', async () => {
    shell();
    expect(await screen.findByRole('button', { name: 'Tasks, 2 waiting for you' })).toBeInTheDocument();
  });

  it('shows the open turn with its progress, and lets the whole company close it', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/turns/u3/close': [200, { turn: { ...TURN, status: 'closed' } }] });
    await openTasks(user);
    const turn = screen.getByRole('region', { name: 'Turn 3' });
    expect(turn).toHaveTextContent('Take payments');
    expect(turn).toHaveTextContent('2 of 5 tasks done');
    await user.click(within(turn).getByRole('button', { name: 'Close turn' }));
    await user.click(within(turn).getByRole('button', { name: 'Yes, close it' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/turns/u3/close')).toBe(true);
  });

  it('starts a turn with its goal when none is open', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'GET /api/turns/current': [200, { turn: null }], 'POST /api/turns': [201, { turn: TURN }] });
    await openTasks(user);
    await user.type(screen.getByLabelText('Goal of the next turn'), 'Take payments');
    await user.click(screen.getByRole('button', { name: 'Start turn' }));
    expect(calls.find(c => c.method === 'POST' && c.path === '/api/turns')?.body).toEqual({ goal: 'Take payments' });
  });

  it('shows no turn controls to people with part of the company', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/turns/current': [200, { turn: null }] }, { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } });
    await openTasks(user);
    expect(screen.queryByRole('button', { name: 'Start turn' })).not.toBeInTheDocument();
  });

  it('answers a question and takes it off the list', async () => {
    const user = userEvent.setup();
    let answered = false;
    const calls = shell({
      'GET /api/requests': () => [200, { requests: answered ? REQUESTS.slice(1) : REQUESTS }],
      'POST /api/requests/r1': () => {
        answered = true;
        return [200, { request: { id: 'r1', status: 'answered' } }];
      },
    });
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    const question = within(waiting).getByRole('article', { name: /#9/ });
    expect(question).toHaveTextContent('Stripe or Adyen?');
    expect(question).toHaveTextContent('Dana');
    await user.type(within(question).getByLabelText('Your answer'), 'Stripe');
    await user.click(within(question).getByRole('button', { name: 'Answer' }));
    expect(calls.find(c => c.path === '/api/requests/r1')?.body).toEqual({ answer: 'Stripe' });
    await waitFor(() => expect(within(waiting).queryByRole('article', { name: /#9/ })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Tasks, 1 waiting for you' })).toBeInTheDocument();
  });

  it('shows the exact commit an approval is for, with Approve and Decline', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/requests/r2': [200, { request: { id: 'r2', status: 'approved' } }] });
    await openTasks(user);
    const approval = within(screen.getByRole('region', { name: 'Waiting for you' })).getByRole('article', { name: /#10/ });
    expect(approval).toHaveTextContent('a'.repeat(40));
    expect(within(approval).getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    await user.click(within(approval).getByRole('button', { name: 'Approve' }));
    expect(calls.find(c => c.path === '/api/requests/r2')?.body).toEqual({ approve: true });
  });

  it('groups tasks by state, newest first, and filters them by department', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'GET /api/tasks?status=open&department=d2': [200, { tasks: TASKS.slice(0, 1) }] });
    await openTasks(user);
    const groups = screen.getAllByRole('region', { name: /^(Waiting for a person|In review|In progress)$/ });
    expect(groups.map(g => g.getAttribute('aria-label'))).toEqual(['Waiting for a person', 'In review', 'In progress']);
    const review = within(groups[1]!).getByRole('button', { name: /#12/ });
    expect(review).toHaveTextContent('Checkout API');
    expect(review).toHaveTextContent('Gate 2 of 3');
    expect(review).toHaveTextContent('Tom');
    expect(review).toHaveTextContent('Development');
    await user.selectOptions(screen.getByLabelText('Department'), 'd2');
    await waitFor(() => expect(screen.queryByRole('button', { name: /#11/ })).not.toBeInTheDocument());
    expect(calls.some(c => c.path === '/api/tasks?status=open&department=d2')).toBe(true);
  });

  it('shows closed tasks on request', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks?status=closed': [200, { tasks: CLOSED_TASKS }] });
    await openTasks(user);
    await user.click(screen.getByRole('button', { name: 'Closed' }));
    expect(within(await screen.findByRole('region', { name: 'Done' })).getByRole('button', { name: /#8/ })).toHaveTextContent('Login page');
  });

  it('fetches the tasks again when one changes', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    let moved = false;
    shell({ [`GET ${OPEN}`]: () => [200, { tasks: moved ? [{ ...TASKS[1]!, status: 'review', stage: 1, gateCount: 3 }] : TASKS }] });
    await openTasks(user);
    moved = true;
    stream.send({ type: 'task', id: 't11' });
    expect(within(await screen.findByRole('region', { name: 'In review' })).getByRole('button', { name: /#11/ })).toHaveTextContent('Gate 1 of 3');
  });
});
