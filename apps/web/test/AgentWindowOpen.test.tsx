import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/screens/Shell';
import { CARD, DEV_ORG, MACHINES, ME, ORG, RUNNING_AGENTS, SUBS, decisions, mockApi } from './api-mock';

function company(busy: boolean) {
  const agents = [{ ...RUNNING_AGENTS[0]!, busy }];
  return mockApi({
    'GET /api/org': [200, DEV_ORG],
    'GET /api/requests': [200, decisions([])],
    'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, agents }] }],
    'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, running: { agents, parts: [] } }] }],
    'GET /api/agents/b1': [200, CARD],
    'GET /api/agents/b1/events?after=0': [200, { events: [], state: { ready: true, reason: null, busy, runningJobId: busy ? 'j1' : null, queued: 0 } }],
    'POST /api/agents/b1/messages': [200, { queued: true }],
  });
}

const tab = (name: string) => within(screen.getByRole('navigation')).getByRole('button', { name });

async function openList(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(tab(name));
  await user.click(await screen.findByRole('button', { name: name === 'Subscriptions' ? 'Open the card of Claude' : 'Open the card of ivan-mbp' }));
}

describe('one agent window', () => {
  it.each(['Subscriptions', 'Machines'])('shows an error when opening from %s while the company cannot load', async name => {
    const agents = [{ ...RUNNING_AGENTS[0]!, canOpen: true }];
    mockApi({
      'GET /api/org': [503, { error: { code: 'internal', message: 'Company temporarily unavailable' } }],
      'GET /api/requests': [200, decisions([])],
      'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, agents }] }],
      'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, running: { agents, parts: [] } }] }],
    });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await openList(user, name);
    await user.click(screen.getByRole('button', { name: 'Open Bruno' }));
    expect(await screen.findByText('Company temporarily unavailable')).toHaveAttribute('role', 'alert');
    expect(screen.getByText('Company temporarily unavailable')).toHaveFocus();
  });

  it.each(['Subscriptions', 'Machines'])('leaves inaccessible agents as text in %s', async name => {
    const agents = [{ ...RUNNING_AGENTS[0]!, canOpen: false }, { ...RUNNING_AGENTS[1]!, canOpen: true }];
    mockApi({
      'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, agents }] }],
      'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, running: { agents, parts: [] } }] }],
    });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await openList(user, name);
    expect(screen.getByText('Bruno')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Bruno' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Vera' })).toBeInTheDocument();
  });

  it.each(['Subscriptions', 'Machines'])('opens a working or sleeping employee from %s and sends a personal message', async name => {
    const calls = company(false);
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await openList(user, name);
    await user.click(screen.getByRole('button', { name: 'Open Bruno' }));
    const window = await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
    await user.type(within(window).getByRole('textbox', { name: 'Write to Bruno' }), 'Please check the cart{Enter}');
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/agents/b1/messages', body: { text: 'Please check the cart' } }));
  });

  it.each(['Subscriptions', 'Machines'])('opens the working employee from %s', async name => {
    company(true);
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await openList(user, name);
    await user.click(screen.getByRole('button', { name: 'Open Bruno' }));
    expect(await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeInTheDocument();
  });

  it('keeps the same window and draft when the employee is opened from another tab', async () => {
    company(false);
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await openList(user, 'Subscriptions');
    await user.click(screen.getByRole('button', { name: 'Open Bruno' }));
    const window = await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
    await user.type(within(window).getByRole('textbox'), 'Draft');
    await openList(user, 'Machines');
    await user.click(screen.getByRole('button', { name: 'Open Bruno' }));
    expect(screen.getAllByRole('complementary', { name: 'Bruno, Backend engineer' })).toEqual([window]);
    expect(within(window).getByRole('textbox')).toHaveValue('Draft');
  });
  it('opens the orchestrator from his real id even if the company answer arrives after the click', async () => {
    let answer: (reply: [number, unknown]) => void = () => {};
    const pending = new Promise<[number, unknown]>(resolve => { answer = resolve; });
    const calls = mockApi({
      'GET /api/org': () => pending,
      'GET /api/requests': [200, decisions([])],
      'GET /api/machines': [200, { machines: MACHINES }],
      'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, agents: [{ ...RUNNING_AGENTS[0]!, id: 'a1', name: 'Orchestrator' }] }] }],
      'GET /api/agents/orchestrator/events?after=0': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
      'POST /api/agents/orchestrator/start': [200, { started: false }],
      'GET /api/tasks?status=open': [200, { tasks: [] }],
    });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await openList(user, 'Subscriptions');
    await user.click(screen.getByRole('button', { name: 'Open Orchestrator' }));
    answer([200, ORG]);
    expect(await screen.findByRole('complementary', { name: 'Orchestrator' })).toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/agents/a1')).toBe(false);
  });

});
