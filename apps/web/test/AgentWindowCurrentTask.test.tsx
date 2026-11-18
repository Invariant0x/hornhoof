import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { Shell } from '../src/screens/Shell';
import { AgentWindow } from '../src/screens/AgentWindow';
import { CARD, DEV_ORG, ME, ORG, RUNNING_AGENTS, SUBS, TASK_DETAIL, decisions, mockApi } from './api-mock';
import { fakeStream } from './fake-stream';
import { until } from './until';
import type { LiveMessage } from '../src/live';

const currentTask = { id: 't12', number: 12, title: 'Checkout API' };

it('opens the running orchestrator task instead of a newer assigned task', async () => {
  const assignee = { ...TASK_DETAIL.assignee!, id: ORG.orchestrator!.id };
  const current = { ...TASK_DETAIL, status: 'working', assignee };
  const next = { ...TASK_DETAIL, id: 't99', number: 99, title: 'Later work', status: 'open', assignee };
  const calls = mockApi({
    'GET /api/org': [200, ORG],
    'GET /api/agents/orchestrator': [200, { ...CARD, id: 'a1', kind: 'orchestrator', currentTask }],
    'GET /api/tasks?status=open': [200, { tasks: [next, current] }],
    'GET /api/tasks/t12': [200, { task: current }],
    'GET /api/tasks/t99': [200, { task: next }],
    'GET /api/requests': [200, decisions([])],
    'GET /api/agents/orchestrator/events?last=300': [200, { events: [], state: { ready: true, reason: null, busy: true, runningJobId: 'working-on-t12', queued: 0 } }],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
  });
  const user = userEvent.setup();
  render(<Shell me={ME} onSignOut={() => {}} />);
  /* Setup's welcome now opens the first contact, so the window opens from the map as a person opens it. */
  await user.click(await screen.findByRole('button', { name: 'Open the orchestrator' }));
  await until(() => screen.queryByTitle('Task'));
  await user.click(screen.getByRole('button', { name: 'Task' }));
  await until(() => screen.queryByRole('heading', { name: /Checkout API|Later work/ }));
  /* The running task alone, with the phone recordings its panel asks for; the newer t99 is never opened. */
  expect(calls.filter(c => c.path.startsWith('/api/tasks/')).map(c => c.path)).toEqual(['/api/tasks/t12', '/api/tasks/t12/phone-recordings']);
});

it('opens a product employee task without a map employee', async () => {
  const org = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: [], products: [{ id: 'product', name: 'Checkout' }] })) };
  mockApi({
    'GET /api/org': [200, org],
    'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, agents: [{ ...RUNNING_AGENTS[0]!, canOpen: true }] }] }],
    'GET /api/requests': [200, decisions([])],
    'GET /api/agents/b1': [200, { ...CARD, product: { id: 'product', name: 'Checkout' }, currentTask }],
    'GET /api/agents/b1/events?last=300': [200, { events: [], state: { ready: true, reason: null, busy: true, runningJobId: 'working-on-t12', queued: 0 } }],
    'GET /api/tasks/t12': [200, { task: TASK_DETAIL }],
  });
  const user = userEvent.setup();
  render(<Shell me={{ ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } }} onSignOut={() => {}} />);
  await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Subscriptions & API' }));
  await user.click(await screen.findByRole('button', { name: 'Open the card of Claude' }));
  await user.click(screen.getByRole('button', { name: 'Open Bruno' }));
  const window = await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
  await user.click(within(window).getByRole('button', { name: 'Task' }));
  expect(await screen.findByRole('complementary', { name: '#12 Checkout API' })).toBeInTheDocument();
});

it.each<LiveMessage>([{ type: 'task', id: 't12', spot: { departmentId: 'd2' } }, { type: 'working', working: 0 }, { type: 'reconnected' }])('refreshes the task after $type changes without a map refresh', async message => {
  let current: typeof currentTask | null = currentTask;
  mockApi({
    'GET /api/agents/b1': () => [200, { ...CARD, currentTask: current }],
    'GET /api/agents/b1/events?last=300': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
    'GET /api/tasks/t12': [200, { task: TASK_DETAIL }],
  });
  const stream = fakeStream();
  const user = userEvent.setup();
  render(<AgentWindow me={ME} org={DEV_ORG} agentId="b1" onClose={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Task' }));
  await screen.findByRole('complementary', { name: '#12 Checkout API' });
  current = null;
  if (message.type === 'reconnected') act(() => stream.sources().forEach(source => { source.fire('error'); source.fire('open'); }));
  else stream.send(message);
  expect(await screen.findByRole('button', { name: 'No task' })).toBeDisabled();
  await waitFor(() => expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument());
});
