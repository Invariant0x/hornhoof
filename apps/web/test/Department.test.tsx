import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { CARD, DEV_ORG, ME, mockApi, ROSTER } from './api-mock';

const EVENTS = '/api/agents/orchestrator/events?after=0';
const READY = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };

function shell(routes: Record<string, unknown> = {}) {
  const calls = mockApi({
    'GET /api/org': [200, DEV_ORG],
    [`GET ${EVENTS}`]: [200, { events: [], state: READY }],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(
    <LanguageProvider>
      <Shell me={ME} onSignOut={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

async function flyIn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Development/ }));
  return screen.findByRole('heading', { level: 2, name: 'Development' });
}

describe('Department view', () => {
  it('flies into a department and shows its head and members', async () => {
    const user = userEvent.setup();
    shell();
    await flyIn(user);
    const head = screen.getByRole('region', { name: 'Head' });
    expect(within(head).getByRole('button', { name: /Dana/ })).toHaveTextContent('Head of development');
    expect(within(head).getByText('Working')).toBeInTheDocument();
    const members = screen.getByRole('region', { name: 'Members' });
    const bruno = within(members).getByRole('button', { name: /Bruno/ });
    expect(bruno).toHaveTextContent('Backend engineer');
    expect(bruno).toHaveTextContent('claude-sonnet-5-5');
    expect(bruno).toHaveTextContent('Anthropic');
    expect(within(members).getByText('Sleeping')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Products' })).getByText('Mascot')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'People with access' })).getByText('Sasha')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the map' }));
    expect(screen.queryByRole('heading', { level: 2, name: 'Development' })).not.toBeInTheDocument();
  });

  it('hires through the orchestrator', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/agents/orchestrator/messages': [202, { jobId: 'j9' }] });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: '+ Hire' }));
    expect(await screen.findByRole('complementary', { name: 'Orchestrator' })).toBeInTheDocument();
    await vi.waitFor(() => expect(calls.find(c => c.path === '/api/agents/orchestrator/messages')?.body).toEqual({ text: 'Staff the Development department.' }));
    expect(calls.filter(c => c.path === '/api/agents/orchestrator/messages')).toHaveLength(1);
  });

  it('shows the hand-made roster when he cannot answer', async () => {
    const user = userEvent.setup();
    const calls = shell({
      [`GET ${EVENTS}`]: [200, { events: [], state: { ...READY, ready: false, reason: 'no_subscription' } }],
      'GET /api/departments/d2/roster': [200, ROSTER],
    });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: '+ Hire' }));
    expect(await screen.findByText('Hiring for Development')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Head of development/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Hire (2)' })).toBeEnabled();
    expect(screen.queryByText('Company structure')).not.toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/agents/orchestrator/messages')).toBe(false);
  });

  it('opens an employee card from the department', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/agents/b1': [200, CARD] });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: /Bruno/ }));
    expect(await screen.findByRole('button', { name: 'Open terminal' })).toBeInTheDocument();
  });
});
