import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { CARD, DEV_ORG, MACHINES, ME, RUNNING_AGENTS, decisions, mockApi } from './api-mock';

const IDLE = { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } };
const VERA = { ...CARD, id: 'b2', name: 'Vera', state: 'sleeping' as const, role: { ...CARD.role!, title: { en: 'Reviewer', ru: 'Рецензент' } } };
const BRUNO = { ...CARD, state: 'working' as const };

function company(agents = RUNNING_AGENTS) {
  return mockApi({
    'GET /api/org': [200, DEV_ORG],
    'GET /api/requests': [200, decisions([])],
    'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, running: { agents, parts: [] } }] }],
    'GET /api/subscriptions': [200, { subscriptions: [] }],
    'GET /api/agents/b1': [200, BRUNO],
    'GET /api/agents/b1/events?last=300': [200, IDLE],
    'GET /api/agents/b2': [200, VERA],
    'GET /api/agents/b2/events?last=300': [200, IDLE],
    'GET /api/agents/orchestrator': [200, { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null }],
    'GET /api/agents/orchestrator/events?last=300': [200, IDLE],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
  });
}

const tab = (name: string) => within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name });

/* The list of a machine's agents opens any of them, whatever window is on the screen. */
async function openMachines(user: ReturnType<typeof userEvent.setup>) {
  render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
  await user.click(tab('Machines'));
  await user.click(await screen.findByRole('button', { name: 'Open the card of dev-laptop' }));
}

describe('agent windows', () => {
  it('names the agent and its state on the strip of a window another one pushed aside, and leaves the focus alone', async () => {
    company();
    const user = userEvent.setup();
    await openMachines(user);
    await user.click(screen.getByRole('button', { name: 'Open Bruno' }));
    const bruno = await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
    await user.click(screen.getByRole('button', { name: 'Open Vera' }));
    const vera = await screen.findByRole('complementary', { name: 'Vera, Reviewer' });
    expect(bruno).not.toBeVisible();
    expect(vera).toBeVisible();
    const strip = screen.getByRole('button', { name: 'Restore Bruno, Backend engineer' });
    expect(strip).toHaveTextContent('Bruno, Backend engineer');
    expect(strip).toHaveTextContent('Working');
    expect(strip).toHaveAttribute('title', 'Bruno, Backend engineer: Working');
    expect(strip).not.toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Restore Vera, Reviewer' })).not.toBeInTheDocument();
  });

  it('gives the focus to the strip when the person minimizes the window, and to the window when it comes back', async () => {
    company();
    const user = userEvent.setup();
    await openMachines(user);
    await user.click(screen.getByRole('button', { name: 'Open Vera' }));
    const vera = await screen.findByRole('complementary', { name: 'Vera, Reviewer' });
    await user.click(within(vera).getByRole('button', { name: 'Minimize' }));
    const strip = screen.getByRole('button', { name: 'Restore Vera, Reviewer' });
    expect(strip).toHaveFocus();
    await user.click(strip);
    expect(vera).toBeVisible();
    expect(vera).toHaveFocus();
    expect(strip).not.toBeInTheDocument();
  });

  it('closes a window with the cross on its strip, and opens it anew after that', async () => {
    const calls = company();
    const user = userEvent.setup();
    await openMachines(user);
    await user.click(screen.getByRole('button', { name: 'Open Vera' }));
    const vera = await screen.findByRole('complementary', { name: 'Vera, Reviewer' });
    await user.click(screen.getByRole('button', { name: 'Open Bruno' }));
    await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
    await user.click(screen.getByRole('button', { name: 'Close Vera, Reviewer' }));
    expect(vera).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore Vera, Reviewer' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeVisible();
    const before = calls.filter(c => c.path === '/api/agents/b2').length;
    await user.click(screen.getByRole('button', { name: 'Open Vera' }));
    await screen.findByRole('complementary', { name: 'Vera, Reviewer' });
    await waitFor(() => expect(calls.filter(c => c.path === '/api/agents/b2').length).toBeGreaterThan(before));
  });

  it('opens the same window for the orchestrator by its id, even before the company has said which agent that is', async () => {
    const calls = company([{ ...RUNNING_AGENTS[0]!, id: DEV_ORG.orchestrator!.id, name: 'Orchestrator' }]);
    const user = userEvent.setup();
    await openMachines(user);
    await user.click(screen.getByRole('button', { name: 'Open Orchestrator' }));
    const window = await screen.findByRole('complementary', { name: 'Orchestrator' });
    await user.click(within(window).getByRole('button', { name: 'Minimize' }));
    await user.click(screen.getByRole('button', { name: 'Open Orchestrator' }));
    expect(window).toBeVisible();
    expect(screen.getAllByRole('complementary', { name: 'Orchestrator' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Restore/ })).not.toBeInTheDocument();
    expect(calls.some(c => c.path === `/api/agents/${DEV_ORG.orchestrator!.id}`)).toBe(false);
  });
});
