import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Shell } from '../src/screens/Shell';
import type { UpdatesView } from '../src/types';
import { page } from '../src/updates';
import { MACHINES, ME, mockApi, ORG, ORG_WITH_TEAMS, PEOPLE, SUBS, TASKS } from './api-mock';
import { userEvent, waitFor } from './subscriptions-helpers';

/* While the update panel shows an update in progress, a load the server refused for maintenance draws no bar of its own:
   the panel already says Hornhoof takes no changes. Once the updates poll gets an answer again, every such load asks
   again, with no page reload. The clock is the test's: the poll runs only as the test moves it. */

const MAINTENANCE = 'Hornhoof is installing an update and takes no changes until it ends. Try again in a few minutes.';
const REFUSED = [503, { error: { code: 'unavailable', message: 'Hornhoof is installing an update and takes no changes until it ends.', reason: 'maintenance' } }] as const;
const BROKEN = [500, { error: { code: 'internal', message: 'Something went wrong.' } }] as const;
/* How often the updates screen asks while an update runs. */
const BUSY_POLL_MS = 2_000;

const view = (step: 'install' | 'health'): UpdatesView => ({
  current: { version: '0.4.0', commit: 'a'.repeat(40), migrations: 5 },
  available: true, checkedAt: '2026-10-30T02:00:00Z', latest: null, versions: [], error: null,
  updater: { present: true, status: { id: 'u1', version: '0.4.1', commit: 'b'.repeat(40), state: 'running', step, log: '', at: '2026-10-30T02:05:00Z' }, waiting: null, calledOff: null },
});

type Answer = readonly [number, unknown?];

/* The server as an update holds it. The updates poll first answers with the update running, so the panel has it to show;
   while held, it and every load of the test's routes get the maintenance refusal; once the update ends they answer again. */
function server(routes: Record<string, Answer>, updates: 'running' | 'none' = 'running') {
  const state = { held: true, polls: 0 };
  const calls = mockApi({
    'GET /api/updates': () => {
      state.polls++;
      if (updates === 'none' || (state.held && state.polls > 1)) return [...REFUSED];
      return [200, view(state.held ? 'install' : 'health')];
    },
    ...Object.fromEntries(Object.entries(routes).map(([key, answer]) => [key, () => (state.held && key.startsWith('GET ') ? [...REFUSED] : [...answer])])),
  });
  return { end: () => { state.held = false; }, asked: (path: string) => calls.filter(c => c.method === 'GET' && c.path === path).length };
}

const bars = () => screen.queryAllByRole('alert').map(alert => alert.textContent);
/* Answers already given are taken in: a number of turns of the event loop, with no timer. */
const takenIn = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); });
const tab = (name: string) => within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name });
const progress = () => screen.getByRole('progressbar', { name: 'Update progress' });

/* The Shell under a held server, with the panel saying maintenance after the next poll on the test's clock. */
async function held(routes: Record<string, Answer>) {
  const s = server(routes);
  render(<Shell me={ME} onSignOut={() => {}} />);
  await waitFor(progress);
  await act(() => vi.advanceTimersByTimeAsync(BUSY_POLL_MS));
  await waitFor(() => expect(progress()).toHaveAttribute('aria-valuetext', 'Maintenance: Hornhoof is installing the update and takes no changes until it ends.'));
  return s;
}

/* The next poll of the updates screen, on the test's clock, gets an answer: the update ended. */
async function updateEnds(end: () => void) {
  end();
  await act(() => vi.advanceTimersByTimeAsync(BUSY_POLL_MS));
}

describe('a maintenance refusal while the update panel shows', () => {
  it('draws no bar on the map, and the map comes back by itself once the update ends, with no reload', async () => {
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    const { end, asked } = await held({ 'GET /api/org': [200, ORG] });
    await waitFor(() => expect(asked('/api/org')).toBeGreaterThan(0));
    await takenIn();
    expect(bars()).toEqual([]);
    expect(screen.queryByText(MAINTENANCE)).not.toBeInTheDocument();
    const before = asked('/api/org');
    await updateEnds(end);
    await waitFor(() => screen.getByText('Ivan'));
    expect(asked('/api/org')).toBeGreaterThan(before);
    expect(bars()).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('draws no bar in a department, whose view comes back once the update ends', async () => {
    window.history.replaceState(null, '', '/departments/d2');
    const { end, asked } = await held({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    await waitFor(() => expect(asked('/api/org')).toBeGreaterThan(0));
    await takenIn();
    expect(bars()).toEqual([]);
    await updateEnds(end);
    await waitFor(() => screen.getByRole('heading', { name: 'Development' }));
    expect(bars()).toEqual([]);
  });

  const TAB_ROUTES: Record<string, Answer> = {
    'GET /api/org': [200, ORG],
    'GET /api/people': [200, { people: PEOPLE }],
    'GET /api/subscriptions': [200, { subscriptions: SUBS }],
    'GET /api/machines': [200, { machines: MACHINES }],
    'GET /api/nodes/commands': [200, { commands: [] }],
    'GET /api/requests': [200, { requests: [], proposals: [], machineAccess: [], counts: { byPerson: {}, byAgent: {}, total: 0 } }],
    'GET /api/wait-cards': [200, { cards: [], next: null }],
    'GET /api/turns': [200, { turns: [] }],
    'GET /api/tasks?status=all': [200, { tasks: TASKS }],
    'GET /api/goals': [200, { goals: [] }],
    'GET /api/pipelines': [200, { pipelines: [] }],
  };
  it.each([
    /* The tracker opens on the person's own tasks, which the list it read again shows as none. */
    ['Tasks', '/api/tasks?status=all', () => screen.getByText('No open tasks to answer for.')],
    ['People', '/api/people', () => screen.getByRole('cell', { name: 'Maria' })],
    ['Machines', '/api/machines', () => screen.getAllByText(MACHINES[0]!.hostname)[0]!],
    ['Subscriptions & API', '/api/subscriptions', () => screen.getAllByText(SUBS[0]!.label)[0]!],
  ] as const)('draws no bar on %s, which loads again once the update ends', async (name, path, shown) => {
    const { end, asked } = await held(TAB_ROUTES);
    await userEvent.click(tab(name));
    await waitFor(() => expect(asked(path)).toBeGreaterThan(0));
    await takenIn();
    expect(bars()).toEqual([]);
    const before = asked(path);
    await updateEnds(end);
    await waitFor(shown);
    expect(asked(path)).toBeGreaterThan(before);
    expect(bars()).toEqual([]);
  });

  it('draws no bar on Improvements, which loads again once the update ends', async () => {
    window.history.replaceState(null, '', '/improvements');
    const { end, asked } = await held({ 'GET /api/org': [200, ORG], 'GET /api/improvements': [200, { improvements: [] }] });
    await waitFor(() => expect(asked('/api/improvements')).toBeGreaterThan(0));
    await takenIn();
    expect(bars()).toEqual([]);
    await updateEnds(end);
    await waitFor(() => screen.getByText('Nothing yet. Operations puts here what it finds on its rounds.'));
    expect(bars()).toEqual([]);
  });
});

describe('what still draws its bar', () => {
  it('a maintenance refusal while no update panel shows, as for a person who does not see the whole company', async () => {
    server({ 'GET /api/org': [200, ORG] });
    render(<Shell me={{ ...ME, person: { ...ME.person, scopeKind: 'listed' } }} onSignOut={() => {}} />);
    await waitFor(() => screen.getByText(MAINTENANCE));
    expect(screen.getByText(MAINTENANCE)).toHaveAttribute('role', 'alert');
  });

  it('a maintenance refusal while the updates screen has nothing to show yet', async () => {
    server({ 'GET /api/org': [200, ORG] }, 'none');
    render(<Shell me={ME} onSignOut={() => {}} />);
    await waitFor(() => screen.getByText(MAINTENANCE));
    expect(screen.queryByRole('progressbar', { name: 'Update progress' })).not.toBeInTheDocument();
  });

  it('a failure other than maintenance while the update runs', async () => {
    mockApi({ 'GET /api/updates': [200, view('install')], 'GET /api/org': [...BROKEN] });
    render(<Shell me={ME} onSignOut={() => {}} />);
    await waitFor(() => screen.getByRole('progressbar', { name: 'Update progress' }));
    await waitFor(() => expect(bars()).toEqual(['Something went wrong.']));
  });
});
