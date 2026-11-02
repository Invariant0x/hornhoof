import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { Me } from '../src/types';
import { ME, mockApi, SUBS } from './api-mock';
import { decl } from './css';

const COMMAND = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join CODE123';
const TRUST = 'Agents will run on this machine with your subscription. People with access to this Hornhoof can give them work.';

const lists = (extra: Parameters<typeof mockApi>[0] = {}) => mockApi({ 'GET /api/subscriptions': [200, { subscriptions: SUBS }], ...extra });

const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name}\\b`) });

afterEach(() => localStorage.clear());

describe('Subscriptions', () => {
  it("keeps the table to the page on a laptop: a plan's buttons take more lines, and the reset time goes under its bar", () => {
    /* In one line, a plan's three buttons made the table wider than the page from a phone up to a wide screen. */
    expect(decl('.subs .row-actions', 'white-space')).toBe('normal');
    expect(decl('.subs .row-actions .act', 'white-space')).toBe('nowrap');
    /* Below a wide screen, when a window resets goes under its bar instead of beside it. */
    expect(decl('.limit-bars li > span:last-child', 'grid-column', '(max-width: 1000px)')).toBe('1 / -1');
  });

  it('lists each subscription with its place, machine, state and limits', async () => {
    lists();
    render(<Subscriptions me={ME} />);
    await screen.findByRole('row', { name: /^Claude\b/ });
    expect(within(rowOf('Claude')).getByText('Ready')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByText('ivan-mbp')).toBeInTheDocument();
    expect(within(rowOf('Codex')).getByText('Waiting for the login')).toBeInTheDocument();
    expect(within(rowOf('Kimi')).getByText('Waiting for the machine')).toBeInTheDocument();
    expect(within(rowOf('Kimi')).getByText('No machine yet')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByText('Whole company')).toBeInTheDocument();
    expect(within(rowOf('Anthropic key ending 9f3a')).getByText('Orchestrator')).toBeInTheDocument();
    /* Machines have a tab of their own. */
    expect(screen.queryByRole('button', { name: 'Connect a machine' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Machines' })).not.toBeInTheDocument();
  });

  it('lists every machine a plan runs on, saying on which it waits', async () => {
    const laptop = { id: 'm3', hostname: 'ivan-laptop', status: 'needs_login' as const, online: true };
    const tower = { id: 'm4', hostname: 'ivan-tower', status: 'ready' as const, online: false };
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, machines: [SUBS[0]!.machines[0]!, laptop, tower] }] }] });
    render(<Subscriptions me={ME} />);
    const machines = within(within(await screen.findByRole('row', { name: /^Claude\b/ })).getByRole('list', { name: 'Machines of Claude' })).getAllByRole('listitem');
    expect(machines.map(m => m.textContent)).toEqual(['ivan-mbp', 'ivan-laptop, waiting for the login', 'ivan-tower, offline']);
  });

  it("shows each window of a plan's limits as a bar with its share and when it resets", async () => {
    const limits = {
      status: 'allowed' as const,
      windows: [
        { name: 'five_hour', utilization: 0.42, resetsAt: '2099-10-29T18:00:00.000Z' },
        { name: 'seven_day', utilization: 0.93, resetsAt: null },
        { name: '120_minutes', utilization: 0.05, resetsAt: null },
        { name: 'month', utilization: 0.06, resetsAt: null },
        { name: 'one_day', utilization: null, resetsAt: null },
      ],
    };
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits }] }] });
    render(<Subscriptions me={ME} />);
    const list = within(await screen.findByRole('row', { name: /^Claude\b/ })).getByRole('list', { name: 'Limits' });
    const [five, seven, two, month, ...rest] = within(list).getAllByRole('listitem');
    expect(five).toHaveTextContent(/^5 hours42%resets in /);
    expect(five!.querySelector('.bar')).not.toHaveClass('hi');
    expect(seven).toHaveTextContent(/^7 days93%Reset time unknown$/);
    expect(seven!.querySelector('.bar')).toHaveClass('max');
    expect(two).toHaveTextContent(/^2 hours5%Reset time unknown$/);
    expect(month).toHaveTextContent(/^Month6%Reset time unknown$/);
    expect(rest).toEqual([]);
  });

  it('shows five hours and seven days for every plan, saying which the plan does not have and which are not known yet', async () => {
    /* A turn tells only some windows; only a complete list says the plan has no other. */
    const claude = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.3, resetsAt: null }, { name: 'seven_day_opus', utilization: 1, resetsAt: null }] };
    const codex = { status: 'allowed' as const, windows: [{ name: 'seven_day', utilization: 0.73, resetsAt: null }], complete: true };
    const kimi = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.88, resetsAt: null }, { name: 'month', utilization: 0.06, resetsAt: null }], complete: true };
    const subs = [{ ...SUBS[0]!, limits: claude }, { ...SUBS[1]!, limits: codex }, { ...SUBS[2]!, limits: kimi }, SUBS[3]!];
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: subs }] });
    render(<Subscriptions me={ME} />);
    const rows = async (name: string) => within(within(await screen.findByRole('row', { name: new RegExp(`^${name}\\b`) })).getByRole('list', { name: 'Limits' })).getAllByRole('listitem');
    const [claudeFive, claudeSeven, ...claudeMore] = await rows('Claude');
    expect(claudeFive).toHaveTextContent(/^5 hours30%Reset time unknown$/);
    expect(claudeSeven).toHaveTextContent(/^7 daysNo data yet$/);
    expect(claudeSeven!.querySelector('.bar')).toHaveClass('none');
    expect(claudeMore.map(r => r.textContent)).toEqual(['7 days, Opus100%Reset time unknown']);
    const [codexFive, codexSeven] = await rows('Codex');
    expect(codexFive).toHaveTextContent(/^5 hoursNot on this plan$/);
    expect(codexSeven).toHaveTextContent(/^7 days73%Reset time unknown$/);
    expect((await rows('Kimi')).map(r => r.textContent)).toEqual(['5 hours88%Reset time unknown', '7 daysNot on this plan', 'Month6%Reset time unknown']);
    const key = rowOf('Anthropic key ending 9f3a');
    expect(within(key).getByText('Pay as you go, no plan limits')).toBeInTheDocument();
    expect(within(key).queryByRole('list', { name: 'Limits' })).not.toBeInTheDocument();
  });

  it('says when a plan reached its limit', async () => {
    const limits = { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2099-10-29T18:00:00.000Z' }] };
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits }] }] });
    render(<Subscriptions me={ME} />);
    expect(within(await screen.findByRole('row', { name: /^Claude\b/ })).getByText(/^Limit reached, resets in /)).toBeInTheDocument();
  });

  it('shows a window that started over since the plan last spoke as not known yet, and no reached limit for it', async () => {
    const limits = {
      status: 'rejected' as const,
      windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-10-29T18:00:00.000Z' }, { name: 'seven_day', utilization: 0.4, resetsAt: '2099-11-04T00:00:00.000Z' }],
      complete: true,
    };
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits }] }] });
    render(<Subscriptions me={ME} />);
    const row = await screen.findByRole('row', { name: /^Claude\b/ });
    const [five, seven] = within(within(row).getByRole('list', { name: 'Limits' })).getAllByRole('listitem');
    expect(five).toHaveTextContent(/^5 hoursNo data yetReset time unknown$/);
    expect(seven).toHaveTextContent(/^7 days40%resets in /);
    expect(within(row).queryByText(/^Limit reached/)).not.toBeInTheDocument();
  });

  it('still says a plan reached its limit when a window without a share stops it, though another full one started over', async () => {
    const limits = {
      status: 'rejected' as const,
      windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-10-29T18:00:00.000Z' }, { name: 'seven_day', utilization: null, resetsAt: '2099-11-04T00:00:00.000Z' }],
    };
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits }] }] });
    render(<Subscriptions me={ME} />);
    expect(within(await screen.findByRole('row', { name: /^Claude\b/ })).getByText(/^Limit reached, resets in /)).toBeInTheDocument();
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

  it('connects a Google AI plan, which Antigravity runs', async () => {
    const calls = lists({ 'POST /api/subscriptions/connect': [201, { subscriptions: [], command: COMMAND }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Connect a subscription' }));
    const google = screen.getByRole('checkbox', { name: 'Antigravity' });
    expect(google).toHaveAccessibleDescription('Google AI Pro or Ultra plan');
    await user.click(google);
    await user.click(screen.getByRole('button', { name: 'Get the command' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/subscriptions/connect', body: { providers: ['antigravity'] } });
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

  it("sets the share of a plan's limits that tasks may use", async () => {
    const calls = lists({ 'PATCH /api/subscriptions/s-claude': [200, { subscription: { ...SUBS[0]!, budget: 80 } }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    const share = await within(await screen.findByRole('row', { name: /^Claude\b/ })).findByRole('combobox', { name: 'Share of Claude for tasks' });
    expect(share).toHaveValue('');
    await user.selectOptions(share, '80');
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ path: '/api/subscriptions/s-claude', body: { budget: 80 } }));
    expect(within(rowOf('Claude')).getByRole('combobox', { name: 'Share of Claude for tasks' })).toHaveValue('80');
    expect(within(rowOf('Anthropic key ending 9f3a')).queryByRole('combobox')).not.toBeInTheDocument();
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
    const [five, seven] = within(within(rowOf('Claude')).getByRole('list', { name: 'Лимиты' })).getAllByRole('listitem');
    expect(five).toHaveTextContent(/^5 часов42%До сброса /);
    expect(seven).toHaveTextContent(/^7 дней10%Время сброса неизвестно$/);
    const [codexFive] = within(within(rowOf('Codex')).getByRole('list', { name: 'Лимиты' })).getAllByRole('listitem');
    expect(codexFive).toHaveTextContent(/^5 часовПока нет данных$/);
    expect(within(rowOf('Ключ Anthropic')).getByText('Оплата по факту, без лимитов плана')).toBeInTheDocument();
  });
});
