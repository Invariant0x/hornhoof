import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { Me } from '../src/types';
import { MACHINES, ME, mockApi, SUBS } from './api-mock';

const COMMAND = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join CODE123';
const TRUST = 'Agents will run on this machine with your subscription. People with access to this Hornhoof can give them work.';

const lists = (extra: Parameters<typeof mockApi>[0] = {}) =>
  mockApi({ 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: MACHINES }], ...extra });

const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name}\\b`) });

afterEach(() => localStorage.clear());

describe('Subscriptions', () => {
  it('lists each subscription with its place, machine, state and limits', async () => {
    lists();
    render(<Subscriptions me={ME} />);
    await screen.findByRole('row', { name: /^Claude\b/ });
    expect(within(rowOf('Claude')).getByText('Ready')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByText('ivan-mbp')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByText(/^42% of the limit used, resets at /)).toBeInTheDocument();
    expect(within(rowOf('Codex')).getByText('Waiting for the login')).toBeInTheDocument();
    expect(within(rowOf('Kimi')).getByText('Waiting for the machine')).toBeInTheDocument();
    expect(within(rowOf('Kimi')).getByText('No machine yet')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByText('Whole company')).toBeInTheDocument();
    expect(within(rowOf('Anthropic key ending 9f3a')).getByText('Orchestrator')).toBeInTheDocument();
  });

  it('says Built-in node offline for an API key whose node is down', async () => {
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[3]!, online: false }] }], 'GET /api/machines': [200, { machines: [] }] });
    render(<Subscriptions me={ME} />);
    expect(await screen.findByText('Built-in node offline')).toBeInTheDocument();
  });

  it('says Machine offline when the node is not connected', async () => {
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, online: false }] }], 'GET /api/machines': [200, { machines: [] }] });
    render(<Subscriptions me={ME} />);
    expect(await screen.findByText('Machine offline')).toBeInTheDocument();
    expect(within(rowOf('Claude')).queryByRole('button', { name: /Run a test/ })).not.toBeInTheDocument();
  });

  it('refreshes on its own, so a node that signs in turns Ready without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let calls = 0;
    mockApi({
      'GET /api/subscriptions': () => {
        calls += 1;
        return [200, { subscriptions: [calls < 2 ? SUBS[1]! : { ...SUBS[1]!, status: 'ready' }] }];
      },
      'GET /api/machines': [200, { machines: MACHINES }],
    });
    render(<Subscriptions me={ME} />);
    expect(await screen.findByText('Waiting for the login')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
  });

  it('connects Claude and Codex and shows the command with Copy and the trust line', async () => {
    const calls = lists({ 'POST /api/subscriptions/connect': [201, { subscriptions: [], command: COMMAND }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Connect a subscription' }));
    expect(screen.getByRole('button', { name: 'Get the command' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Claude' }));
    await user.click(screen.getByRole('checkbox', { name: 'Codex' }));
    expect(screen.getByRole('checkbox', { name: 'GLM' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Get the command' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/subscriptions/connect', body: { providers: ['claude', 'codex'] } });
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByText(TRUST)).toBeInTheDocument();
  });

  it('runs a test and shows the answer', async () => {
    const job = { id: 'j1', status: 'queued', result: null, tail: '', error: null, machine: 'ivan-mbp', createdAt: '2026-10-29T10:00:00.000Z', startedAt: null, finishedAt: null };
    let polls = 0;
    const calls = lists({
      'POST /api/subscriptions/s-claude/test': [201, { job }],
      'GET /api/jobs/j1': () => {
        polls += 1;
        return polls < 2
          ? [200, { job: { ...job, status: 'running', startedAt: '2026-10-29T10:00:00.500Z' } }]
          : [200, { job: { ...job, status: 'done', result: 'ready', startedAt: '2026-10-29T10:00:00.500Z', finishedAt: '2026-10-29T10:00:03.700Z' } }];
      },
    });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Run a test on Claude' }));
    expect(await screen.findByText('Answered "ready" in 3.2 s on ivan-mbp.', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(calls.filter(c => c.path === '/api/jobs/j1')).toHaveLength(2);
  });

  it('explains a failed test and keeps the output folded', async () => {
    const job = { id: 'j2', status: 'failed', result: '', tail: 'Error: something broke', error: 'agent_failed', machine: 'ivan-mbp', createdAt: '2026-10-29T10:00:00.000Z', startedAt: null, finishedAt: '2026-10-29T10:00:01.000Z' };
    lists({ 'POST /api/subscriptions/s-claude/test': [201, { job: { ...job, status: 'queued' } }], 'GET /api/jobs/j2': [200, { job }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Run a test on Claude' }));
    expect(await screen.findByText('The agent stopped with an error.', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('Show the output')).toBeInTheDocument();
    expect(screen.getByText('Error: something broke')).not.toBeVisible();
  });

  it('asks before removing, then sends DELETE', async () => {
    const calls = lists({ 'DELETE /api/subscriptions/s-kimi': [204] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Remove Kimi' }));
    expect(screen.getByText('Remove Kimi? Its login will be deleted from the machine.')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(calls.find(c => c.method === 'DELETE')).toEqual({ method: 'DELETE', path: '/api/subscriptions/s-kimi', body: undefined });
  });

  it('moves the orchestrator to a company subscription and shows the badge', async () => {
    const calls = lists({ 'POST /api/subscriptions/s-claude/orchestrator': [200, { subscription: { ...SUBS[0]!, isOrchestrator: true } }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Use Claude for the orchestrator' }));
    expect(calls.find(c => c.method === 'POST')!.path).toBe('/api/subscriptions/s-claude/orchestrator');
    expect(await within(rowOf('Claude')).findByText('Orchestrator')).toBeInTheDocument();
    expect(within(rowOf('Anthropic key ending 9f3a')).queryByText('Orchestrator')).not.toBeInTheDocument();
  });

  it('offers no orchestrator choice to a department-scope viewer', async () => {
    lists();
    const lead: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };
    render(<Subscriptions me={lead} />);
    await screen.findByRole('row', { name: /^Claude\b/ });
    expect(screen.queryByRole('button', { name: /for the orchestrator/ })).not.toBeInTheDocument();
  });

  it('gets a new command for a subscription still waiting for its machine', async () => {
    const calls = lists({ 'POST /api/subscriptions/s-kimi/command': [201, { command: COMMAND }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'New command for Kimi' }));
    expect(calls.find(c => c.method === 'POST')!.path).toBe('/api/subscriptions/s-kimi/command');
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();
    expect(within(rowOf('Claude')).queryByRole('button', { name: /New command/ })).not.toBeInTheDocument();
  });

  it('lists machines and disconnects one after a confirm', async () => {
    const calls = lists({ 'POST /api/machines/m2/disconnect': [204] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    const machine = await screen.findByRole('row', { name: /^build-box\b/ });
    expect(within(machine).getByText('Last seen 5 minutes ago')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^ivan-mbp\b/ })).getByText('Online')).toBeInTheDocument();
    await user.click(within(machine).getByRole('button', { name: 'Disconnect build-box' }));
    await user.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/machines/m2/disconnect', body: undefined });
  });

  it('shows the states in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    lists();
    render(
      <LanguageProvider>
        <Subscriptions me={ME} />
      </LanguageProvider>,
    );
    expect(await screen.findAllByText('Готова')).toHaveLength(2);
    expect(screen.getByText('Ждет входа')).toBeInTheDocument();
    expect(screen.getByText('Ждет машину')).toBeInTheDocument();
    expect(screen.getByText(/^Использовано 42% лимита, сброс в /)).toBeInTheDocument();
  });
});
