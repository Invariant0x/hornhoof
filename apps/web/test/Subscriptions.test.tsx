import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { Me } from '../src/types';
import { armor, Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { ME, MACHINE, mockApi, SUBS } from './api-mock';
import { decl } from './css';
import { fakeStream } from './fake-stream';

vi.mock('../src/ui/AgentTerminal', () => ({
  AgentTerminal: ({ path }: { path: string }) => <div data-testid="live-terminal" data-path={path} />,
}));

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

describe('signing in to plans', () => {
  const NODE = '7d1c6a52-2f4e-4c4b-9f55-0d7a3c1e9b10';
  const LAPTOP = { id: 'm3', hostname: 'ivan-laptop', status: 'ready' as const, online: true };
  const claude = SUBS[0]!;
  const codex = SUBS[1]!;
  const only = (...subs: typeof SUBS) => ({ 'GET /api/subscriptions': [200, { subscriptions: subs }] as [number, unknown] });

  it("says a plan signed in once runs on any of its owner's machines, and how many are online", async () => {
    mockApi(only({ ...claude, signedInOnce: true, machines: [MACHINE, LAPTOP, { ...LAPTOP, id: 'm4', hostname: 'ivan-tower', online: false }] }));
    render(<Subscriptions me={ME} />);
    expect(within(await screen.findByRole('row', { name: /^Claude\b/ })).getByText("Signed in once, runs on any of Ivan's machines (2 online)")).toBeInTheDocument();
  });

  it('says a plan signed in on its machine by hand runs only there', async () => {
    mockApi(only(claude));
    render(<Subscriptions me={ME} />);
    const row = await screen.findByRole('row', { name: /^Claude\b/ });
    expect(within(row).getByText('Signed in on ivan-mbp only')).toBeInTheDocument();
    expect(within(row).queryByText(/^Signed in once/)).not.toBeInTheDocument();
  });

  it('says a Codex plan signed in once runs on one machine at a time, and on which', async () => {
    mockApi(only({ ...codex, status: 'ready', signedInOnce: true, leaseMachine: 'ivan-laptop', machines: [MACHINE, LAPTOP] }));
    render(<Subscriptions me={ME} />);
    const row = await screen.findByRole('row', { name: /^Codex\b/ });
    expect(within(row).getByText('Codex runs on one machine at a time; now on ivan-laptop')).toBeInTheDocument();
    expect(within(row).queryByText(/^Signed in once/)).not.toBeInTheDocument();
  });

  it('names the tier each plan runs on, and what a free Codex plan cannot do', async () => {
    const free = { ...codex, status: 'ready' as const, tier: 'free', accounts: [{ nodeId: NODE, hostname: 'ivan-mbp', tier: 'free' }] };
    mockApi(only({ ...claude, signedInOnce: true }, free));
    render(<Subscriptions me={ME} />);
    expect(within(await screen.findByRole('row', { name: /^Claude\b/ })).getByText('Claude, one-year sign-in')).toBeInTheDocument();
    expect(within(rowOf('Codex')).getByText('Codex, Free: newer models need Plus or Pro')).toBeInTheDocument();
  });

  it('names a paid tier, and says when machines of one plan are signed in to different accounts', async () => {
    const pro = { ...codex, status: 'ready' as const, tier: 'pro', accounts: [{ nodeId: NODE, hostname: 'ivan-mbp', tier: 'pro', email: 'ivan@acme.com' }] };
    const accounts = [
      { nodeId: NODE, hostname: 'ivan-mbp', tier: 'max', email: 'ivan@acme.com' },
      { nodeId: 'n2', hostname: 'ivan-laptop', tier: 'pro', email: 'ivan@home.org' },
    ];
    mockApi(only({ ...claude, machines: [MACHINE, LAPTOP], accounts, accountsDiffer: true }, pro));
    render(<Subscriptions me={ME} />);
    expect(within(await screen.findByRole('row', { name: /^Codex\b/ })).getByText('Codex, Pro')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByText('ivan-mbp and ivan-laptop are signed in to different accounts')).toBeInTheDocument();
  });

  it("signs a plan in again with another account in a terminal on the owner's machine, and closes it once signed in", async () => {
    const stream = fakeStream();
    const calls = mockApi({ ...only({ ...claude, signedInOnce: true }), 'POST /api/subscriptions/s-claude/signin': [200, { nodeId: NODE, hostname: 'ivan-mbp' }] });
    render(<Subscriptions me={ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Claude with another account' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/subscriptions/s-claude/signin', body: { fresh: true } });
    expect(await screen.findByRole('heading', { name: 'Signing in on ivan-mbp' })).toBeInTheDocument();
    expect(screen.getByTestId('live-terminal')).toHaveAttribute('data-path', `/api/subscriptions/s-claude/signin/terminal?nodeId=${NODE}`);
    /* Another plan's or machine's sign-in leaves this one open. */
    stream.send({ type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: true, error: null, owner: 'p1' });
    expect(screen.getByRole('heading', { name: 'Signing in on ivan-mbp' })).toBeInTheDocument();
    stream.send({ type: 'subscription.signin', subscriptionId: 's-claude', nodeId: NODE, ok: true, error: null, owner: 'p1' });
    await vi.waitFor(() => expect(screen.queryByRole('heading', { name: 'Signing in on ivan-mbp' })).not.toBeInTheDocument());
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it('signs in a plan that waits for its login, and says in plain words when the sign-in fails', async () => {
    const stream = fakeStream();
    const calls = mockApi({ ...only(codex), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'ivan-mbp' }] });
    render(<Subscriptions me={ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ fresh: false });
    await screen.findByRole('heading', { name: 'Signing in on ivan-mbp' });
    stream.send({ type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: false, error: 'tmux: lost server', owner: 'p1' });
    /* Under the plan's row, as a test's result is. */
    expect(await screen.findByText('The sign-in did not finish, so nothing changed. Try again.')).toBeInTheDocument();
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it('stops a sign-in half way', async () => {
    fakeStream();
    const calls = mockApi({ ...only(codex), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'ivan-mbp' }], 'POST /api/subscriptions/s-codex/signin/stop': [204] });
    render(<Subscriptions me={ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop the sign-in' }));
    expect(calls.find(c => c.path.endsWith('/signin/stop'))).toEqual({ method: 'POST', path: '/api/subscriptions/s-codex/signin/stop', body: { nodeId: NODE } });
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it('offers no sign-in for a plan of another person, or one with no machine online', async () => {
    mockApi(only({ ...codex, owner: { id: 'p4', name: 'Oleg' } }, { ...claude, online: false, machines: [{ ...MACHINE, online: false }] }));
    render(<Subscriptions me={ME} />);
    await screen.findByRole('row', { name: /^Codex\b/ });
    expect(screen.queryByRole('button', { name: /^Sign in to / })).not.toBeInTheDocument();
  });

  it('seals a pasted Kimi key in the browser for each machine of the plan, so Hornhoof never sees it', async () => {
    const identity = await generateX25519Identity();
    const KEY = 'sk-kimi-7Hq2xP9wLm4Zr8Tv';
    const kimi = { ...SUBS[2]!, status: 'needs_login' as const, online: true, machines: [{ ...MACHINE, status: 'needs_login' as const }] };
    const calls = mockApi({
      ...only(kimi),
      'GET /api/subscriptions/s-kimi/recipients': [200, { version: 2, recipients: [{ nodeId: NODE, publicKey: await identityToRecipient(identity), hostname: 'ivan-mbp' }] }],
      'POST /api/subscriptions/s-kimi/credential': [200, { stored: 1 }],
    });
    render(<Subscriptions me={ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Paste the key for Kimi' }));
    expect(screen.getByRole('link', { name: /Kimi/ })).toHaveAttribute('href', 'https://www.kimi.com/code/console');
    await userEvent.type(screen.getByLabelText('Kimi key'), KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Save the key' }));
    await vi.waitFor(() => expect(calls.find(c => c.path === '/api/subscriptions/s-kimi/credential')).toBeTruthy());
    const sent = calls.find(c => c.path === '/api/subscriptions/s-kimi/credential')!.body as { kind: string; version: number; envelopes: { nodeId: string; sealed: string }[] };
    expect(sent.kind).toBe('kimi_key');
    expect(sent.version).toBe(3);
    expect(sent.envelopes.map(e => e.nodeId)).toEqual([NODE]);
    const d = new Decrypter();
    d.addIdentity(identity);
    expect(await d.decrypt(armor.decode(sent.envelopes[0]!.sealed), 'text')).toBe(KEY);
    expect(JSON.stringify(calls)).not.toContain(KEY);
    await vi.waitFor(() => expect(screen.queryByLabelText('Kimi key')).not.toBeInTheDocument());
  });

  it('says the sign-in lines in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const free = { ...codex, status: 'ready' as const, tier: 'free', signedInOnce: true, leaseMachine: 'ivan-mbp', accounts: [{ nodeId: NODE, hostname: 'ivan-mbp', tier: 'free' }] };
    mockApi(only({ ...claude, signedInOnce: true, machines: [MACHINE, LAPTOP] }, free));
    render(
      <LanguageProvider>
        <Subscriptions me={ME} />
      </LanguageProvider>,
    );
    const row = await screen.findByRole('row', { name: /^Claude\b/ });
    expect(within(row).getByText('Вход выполнен один раз, работает на любой машине Ivan (на связи: 2)')).toBeInTheDocument();
    expect(within(row).getByText('Claude, вход на год')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Войти в Claude с другим аккаунтом' })).toHaveTextContent('Войти в другой аккаунт');
    expect(within(rowOf('Codex')).getByText('Codex работает на одной машине за раз; сейчас на ivan-mbp')).toBeInTheDocument();
    expect(within(rowOf('Codex')).getByText('Codex, Free: новым моделям нужен Plus или Pro')).toBeInTheDocument();
  });
});
