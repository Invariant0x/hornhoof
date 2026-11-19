import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { JobView, Me, SubView } from '../src/types';
import { ME, MACHINE, mockApi, SUBS, withKey } from './api-mock';
import { decl } from './css';
import { commandCode } from './command-code';
import { waitFor, userEvent, COMMAND, lists, rowOf, openCards, openAll } from './subscriptions-helpers';

vi.mock('../src/ui/AgentTerminal', () => ({
  AgentTerminal: ({ path }: { path: string }) => <div data-testid="live-terminal" data-path={path} />,
}));

const TRUST = 'Agents will run on this machine with your subscription. People with access to this Hornhoof can give them work.';
const RUNNING_JOB: JobView = { id: 'j1', status: 'running', result: null, tail: '', error: null, machine: 'dev-laptop', createdAt: '2026-10-29T10:00:00.000Z', startedAt: '2026-10-29T10:00:00.500Z', finishedAt: null };
const meterRows = (card: HTMLElement) => [...card.querySelectorAll('.gauge')];

afterEach(() => localStorage.clear());

describe('Subscriptions', () => {
  it.each([
    ['en', 'Until ', ', in 2 h 10 min. Its agents wait until then.', 'resets in 2 h 10 min', 'Ivan, limit reached until ', 'Built-in node', 'comes with the server'],
    ['ru', 'До ', ', еще 2 ч 10 мин. До тех пор ее агенты ждут.', 'до сброса 2 ч 10 мин', 'Ivan, лимит исчерпан до ', 'Встроенная нода', 'идет вместе с сервером'],
  ])('uses the quoted state, meter and machine-list wording in %s', async (language, until, sentence, reset, localState, builtin, comesWith) => {
    localStorage.setItem('hh-lang', language);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
    onTestFinished(() => { vi.useRealTimers(); });
    const limits = { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: new Date(Date.now() + 130 * 60_000).toISOString() }] };
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits, machines: [MACHINE, { ...MACHINE, id: 'login', hostname: 'laptop', status: 'needs_login' }, { ...MACHINE, id: 'off', hostname: 'tower', online: false }] }, ...SUBS.slice(1)] }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    const plan = rowOf('Claude');
    const line = plan.querySelector('.stline > span:last-child')!;
    expect.soft(line.textContent).toMatch(new RegExp(`^${until}.+${sentence.replaceAll('.', '\\.')}$`));
    expect.soft(plan.querySelector('.g-s')?.textContent).toBe(reset);
    const machines = plan.querySelector('.plist')!;
    expect.soft(machines.textContent).toContain(localState);
    expect(machines.textContent).toContain(language === 'en' ? 'laptopIvan, waiting for the login' : 'laptopIvan, ждет входа');
    expect(machines.textContent).toContain(language === 'en' ? 'towerIvan, offline' : 'towerIvan, не в сети');
    const login = rowOf('Codex');
    expect(login.querySelector('.blk-fix')?.textContent).toContain(language === 'en' ? 'On dev-laptop. Only Ivan can sign in.' : 'На dev-laptop. Войти может только владелец: Ivan.');
    const waiting = rowOf('Kimi');
    expect(waiting.querySelector('.blk-fix')?.textContent).toContain(language === 'en' ? 'Ivan has not run the install command yet.' : 'Владелец (Ivan) еще не выполнил команду установки.');
    expect(within(screen.getByRole('row', { name: 'Kimi' })).getByText(language === 'en' ? 'No machine yet' : 'Машины пока нет')).toBeInTheDocument();
    const key = screen.getAllByRole('article').find(article => article.querySelector('.plist')?.textContent === `${builtin}${comesWith}`);
    expect.soft(key).toBeDefined();
    expect(plan).toHaveAccessibleName('Claude, Ivan');
  });

  it.each([
    ['en', 'Waiting for the first setup', 'node-a, waiting for the first setup', 'On node-a, Antigravity asks its owner to accept its terms. Only Ivan can do it, by running the install command on that machine again.'],
    ['ru', 'Ждет первой настройки', 'node-a, ждет первой настройки', 'На node-a Antigravity просит владельца принять его условия. Это может сделать только Ivan: снова запустить на этой машине команду установки.'],
  ])("says in %s that a plan waits for its owner to accept its program's terms on the machine", async (language, state, there, fix) => {
    localStorage.setItem('hh-lang', language);
    const machines = [{ ...MACHINE, hostname: 'node-a', status: 'needs_setup' as const }, { ...MACHINE, id: 'm2', hostname: 'node-b', status: 'ready' as const, online: false }];
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[1]!, id: 's-agy', provider: 'antigravity', label: 'Antigravity', status: 'needs_setup', machines }] }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    const row = await waitFor(() => screen.getByRole('row', { name: /^Antigravity\b/ }));
    expect(within(row).getByText(state)).toBeInTheDocument();
    expect(row.textContent).toContain(there);
    await openAll();
    expect(rowOf('Antigravity').querySelector('.blk-fix')?.textContent).toContain(fix);
  });

  it('names the machine that waits for the first setup when that machine is offline', async () => {
    const machines = [{ ...MACHINE, id: 'm2', hostname: 'node-b', status: 'needs_login' as const }, { ...MACHINE, hostname: 'node-a', status: 'needs_setup' as const, online: false }];
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[1]!, id: 's-agy', provider: 'antigravity', label: 'Antigravity', status: 'needs_setup', machines }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(rowOf('Antigravity').querySelector('.blk-fix')?.textContent).toContain('It needs its first setup on node-a, and the machine is offline.');
  });

  it('names the machine online that waits for the first setup before one offline', async () => {
    const machines = [{ ...MACHINE, hostname: 'node-a', status: 'needs_setup' as const, online: false }, { ...MACHINE, id: 'm2', hostname: 'node-b', status: 'needs_setup' as const }];
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[1]!, id: 's-agy', provider: 'antigravity', label: 'Antigravity', status: 'needs_setup', machines }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(rowOf('Antigravity').querySelector('.blk-fix')?.textContent).toContain('On node-b, Antigravity asks its owner to accept its terms.');
  });

  it('marks a plan that waits for its first setup in the warning color of one that waits for its login', () => {
    expect(decl('.status.needs_setup', 'color')).toBe(decl('.status.needs_login', 'color'));
    expect(decl('.status.needs_setup', 'border-color')).toBe('currentColor');
  });

  it('omits the sign-in line while waiting for the login', async () => {
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[1]!, signedInOnce: true, machines: [MACHINE, { ...SUBS[1]!.machines[0]!, id: 'login', hostname: 'laptop' }] }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Codex')).queryByText(/^Signed in once/)).not.toBeInTheDocument();
  });

  it('uses the refined Russian plan words in unavailable meters', async () => {
    localStorage.setItem('hh-lang', 'ru');
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits: { status: 'allowed', complete: true, windows: [] } }, SUBS[3]!] }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    expect.soft(meterRows(rowOf('Claude')).map(meter => meter.textContent)).toEqual(['5 часовНет у этого тарифа', '7 днейНет у этого тарифа']);
    expect.soft(meterRows(rowOf('Claude')).every(meter => !meter.querySelector('.bar'))).toBe(true);
    expect(within(rowOf('Ключ Anthropic, заканчивается на 9f3a')).getByText('Оплата по факту, без лимитов тарифа')).toBeInTheDocument();
  });

  it('uses full page width, card blocks at 700 and 1180, single meters under 300, and mobile sort buttons', () => {
    expect(decl('.people.machines', 'max-width')).toBe('none');
    expect(decl('.people.subs', 'max-width')).toBe('none');
    expect(decl('.facts dd small', 'display')).toBe('block');
    expect(decl('.blocks', 'grid-template-areas', 'card (min-width: 700px)')).toBe('"facts side" "run run"');
    expect(decl('.blocks', 'grid-template-areas', 'card (min-width: 1180px)')).toBe('"facts run side"');
    expect(decl('.gauges', 'grid-template-columns', 'card (max-width: 300px)')).toBe('minmax(0, 1fr)');
    expect(decl('.sortbar', 'display', 'tbl (max-width: 780px)')).toBe('flex');
  });

  it('lists each subscription with its place, machine, state and limits', async () => {
    lists();
    render(<Subscriptions me={ME} />);
    await waitFor(() => screen.getByRole('row', { name: /^Claude\b/ }));
    expect(within(rowOf('Claude')).getByText('Ready')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByText('dev-laptop')).toBeInTheDocument();
    expect(within(rowOf('Codex')).getByText('Waiting for the login')).toBeInTheDocument();
    expect(within(rowOf('Kimi')).getByText('Waiting for the machine')).toBeInTheDocument();
    expect(within(rowOf('Kimi')).getByText('No machine yet')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByText('Whole company')).toBeInTheDocument();
    expect(within(rowOf('Anthropic key ending 9f3a')).getByText('Orchestrator')).toBeInTheDocument();
    /* Machines have a tab of their own. */
    expect(screen.queryByRole('button', { name: 'Connect a machine' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Machines' })).not.toBeInTheDocument();
  });

  it('opens independent cards from cells, keeps controls inside them open, and accents the orchestrator card', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit agents from the PATCH response shape
    const { agents: _, ...updated } = SUBS[0]!;
    const calls = lists({ 'PATCH /api/subscriptions/s-claude': [200, { subscription: { ...updated, budget: 80 } }] });
    render(<Subscriptions me={ME} />);
    const claude = await waitFor(() => screen.getByRole('row', { name: 'Claude' }));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(within(claude).getAllByRole('button')).toHaveLength(1);
    await userEvent.click(within(claude).getByText('Ivan'));
    const button = screen.getByRole('button', { name: 'Open the card of Claude' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const card = screen.getByRole('article', { name: 'Claude, Ivan' });
    expect(card.closest('tr')?.previousElementSibling).toBe(claude);
    expect(within(card).getByRole('region', { name: 'Agents on it' })).toHaveTextContent('2 agents, 1 working');
    expect(within(card).getByRole('region', { name: 'Development' })).toHaveTextContent('Bruno');
    expect(within(card).getByTitle('Checkout API')).toHaveTextContent('#12');
    await userEvent.selectOptions(within(card).getByRole('combobox', { name: 'Share of Claude for tasks' }), '80');
    expect(calls.some(c => c.method === 'PATCH')).toBe(true);
    expect(within(card).getByRole('region', { name: 'Agents on it' })).toHaveTextContent('2 agents, 1 working');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of Anthropic key ending 9f3a' }));
    const key = screen.getByRole('article', { name: 'Anthropic key ending 9f3a, Ivan' });
    expect(key.querySelector('.machine')).toHaveClass('accent');
    expect(key.querySelector('.corner')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('sorts statuses with problems first, and uses the same limit and state sentences in the card', async () => {
    const limits = { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: new Date(Date.now() + 80 * 60_000).toISOString() }] };
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [
      { ...SUBS[0]!, limits }, SUBS[1]!, SUBS[2]!, { ...SUBS[3]!, online: false },
      { ...SUBS[0]!, id: 'off', provider: 'glm', online: false },
      { ...SUBS[1]!, id: 's-agy', provider: 'antigravity', label: 'Antigravity', status: 'needs_setup', machines: [{ ...MACHINE, status: 'needs_setup' }] },
    ] }] });
    render(<Subscriptions me={ME} />);
    await waitFor(() => screen.getByRole('table'));
    const order = () => screen.getAllByRole('row').filter(r => r.classList.contains('rm')).map(r => r.getAttribute('aria-label'));
    expect(order()).toEqual(['Anthropic key ending 9f3a', 'GLM', 'Codex', 'Antigravity', 'Claude', 'Kimi']);
    expect(within(screen.getByRole('row', { name: 'Claude' })).getByText(/^until /)).toBeInTheDocument();
    const header = within(screen.getByRole('columnheader', { name: 'Status' })).getByRole('button');
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(header);
    expect(order()).toEqual(['Kimi', 'Claude', 'Antigravity', 'Codex', 'GLM', 'Anthropic key ending 9f3a']);
    await openAll();
    expect(within(rowOf('Claude')).getByText(/^Until .+Its agents wait until then\.$/)).toBeInTheDocument();
    expect(rowOf('Claude').querySelector('.card-h .until')).not.toBeInTheDocument();
    expect(within(rowOf('Claude')).getByRole('group', { name: /^Limit reached, resets in / })).toBeInTheDocument();
    expect(within(rowOf('Codex')).getByText('On dev-laptop. Only Ivan can sign in.')).toBeInTheDocument();
    expect(within(rowOf('Kimi')).getByText('Ivan has not run the install command yet.')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByRole('heading', { name: 'Owner and account' })).toBeInTheDocument();
  });

  it('keeps refreshed subscription values in place while a card is open, then sorts after the last closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    let count = 0;
    lists({ 'GET /api/subscriptions': () => [200, { subscriptions: [SUBS[0]!, { ...SUBS[1]!, status: ++count > 1 ? 'ready' : 'needs_login' }] }] });
    render(<Subscriptions me={ME} />);
    await waitFor(() => screen.getByRole('table'));
    const order = () => screen.getAllByRole('row').filter(r => r.classList.contains('rm')).map(r => r.getAttribute('aria-label'));
    expect(order()).toEqual(['Codex', 'Claude']);
    const button = screen.getByRole('button', { name: 'Open the card of Claude' });
    await userEvent.click(button);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(order()).toEqual(['Codex', 'Claude']);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(button);
    expect(order()).toEqual(['Claude', 'Codex']);
  });

  it('lists every machine a plan runs on, saying on which it waits', async () => {
    const laptop = { id: 'm3', hostname: 'dev-notebook', status: 'needs_login' as const, online: true };
    const tower = { id: 'm4', hostname: 'work-tower', status: 'ready' as const, online: false };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, machines: [SUBS[0]!.machines[0]!, laptop, tower] }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const machines = within(within(rowOf('Claude')).getByRole('list', { name: 'Machines of Claude' })).getAllByRole('listitem');
    expect(machines.map(m => m.textContent)).toEqual(['dev-laptopIvan, ready', 'dev-notebookIvan, waiting for the login', 'work-towerIvan, offline']);
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
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const [five, seven, two, month, ...rest] = meterRows(rowOf('Claude'));
    expect(five).toHaveTextContent(/^5 hours42%usedresets in /);
    expect(five!.querySelector('.bar')).not.toHaveClass('hi');
    expect(seven).toHaveTextContent(/^7 days93%usedReset time unknown$/);
    expect(seven!.querySelector('.bar')).toHaveClass('max');
    expect(two).toHaveTextContent(/^2 hours5%usedReset time unknown$/);
    expect(month).toHaveTextContent(/^Month6%usedReset time unknown$/);
    expect(rest).toEqual([]);
  });

  it('shows five hours and seven days for every plan, saying which the plan does not have and which are not known yet', async () => {
    /* A turn tells only some windows; only a complete list says the plan has no other. */
    const claude = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.3, resetsAt: null }, { name: 'seven_day_opus', utilization: 1, resetsAt: null }] };
    const codex = { status: 'allowed' as const, windows: [{ name: 'seven_day', utilization: 0.73, resetsAt: null }], complete: true };
    const kimi = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.88, resetsAt: null }, { name: 'month', utilization: 0.06, resetsAt: null }], complete: true };
    /* Working plans: a plan that does not work shows no limits. */
    const subs = [{ ...SUBS[0]!, limits: claude }, { ...SUBS[1]!, status: 'ready' as const, machines: [MACHINE], limits: codex }, { ...SUBS[2]!, status: 'ready' as const, online: true, machines: [MACHINE], limits: kimi }, SUBS[3]!];
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: subs }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const rows = async (name: string) => meterRows(rowOf(name));
    const [claudeFive, claudeSeven, ...claudeMore] = await rows('Claude');
    expect(claudeFive).toHaveTextContent(/^5 hours30%usedReset time unknown$/);
    expect(claudeSeven).toHaveTextContent(/^7 daysUnknown, no limit data received yet$/);
    expect(claudeSeven!.querySelector('.bar')).not.toBeInTheDocument();
    expect(claudeMore.map(r => r.textContent)).toEqual(['7 days, Opus100%usedReset time unknown']);
    const [codexFive, codexSeven] = await rows('Codex');
    expect(codexFive).toHaveTextContent(/^5 hoursNot on this plan$/);
    expect(codexSeven).toHaveTextContent(/^7 days73%usedReset time unknown$/);
    expect((await rows('Kimi')).map(r => r.textContent)).toEqual(['5 hours88%usedReset time unknown', '7 daysNot on this plan', 'Month6%usedReset time unknown']);
    const key = rowOf('Anthropic key ending 9f3a');
    expect(within(key).getByText('Pay as you go, no plan limits')).toBeInTheDocument();
    expect(within(key).queryByRole('list', { name: 'Limits' })).not.toBeInTheDocument();
  });

  it('says when a plan reached its limit', async () => {
    const limits = { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2099-10-29T18:00:00.000Z' }] };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Claude')).getByText('Limit reached')).toBeInTheDocument();
  });

  it.each([['claude', 'Claude'], ['codex', 'Codex'], ['kimi', 'Kimi'], ['antigravity', 'Antigravity']])('shows an expired rejection as unknown with its last data time for %s', async (provider, label) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-04T22:00:00.000Z'));
    onTestFinished(() => { vi.useRealTimers(); });
    const limits = { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-11-03T00:53:03.947Z' }], complete: true };
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, provider, label, limits, limitsUpdatedAt: '2026-11-04T21:55:00.000Z' }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();

    const row = rowOf(label);
    expect(within(row).queryByText('Limit reached')).not.toBeInTheDocument();
    expect(meterRows(row)[0]).toHaveTextContent('5 hoursUnknown, last data from 09:55 PM');
  });

  it('shows a stale rejection as unknown instead of exhausted, in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-04T22:00:00.000Z'));
    onTestFinished(() => { vi.useRealTimers(); });
    const limits = { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-11-05T02:19:23.000Z' }] };
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, provider: 'antigravity', label: 'Antigravity', limits, limitsUpdatedAt: '2026-11-04T21:44:00.000Z' }] }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();

    const row = rowOf('Antigravity');
    expect(within(row).queryByText('Лимит исчерпан')).not.toBeInTheDocument();
    expect(meterRows(row)[0]).toHaveTextContent('5 часовНеизвестно, последние данные от 21:44');
  });

  it('says a working plan has no limit data without calling its limits unset', async () => {
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits: null, limitsUpdatedAt: null }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(meterRows(rowOf('Claude'))[0]).toHaveTextContent('5 hoursUnknown, no limit data received yet');
  });

  it('shows a window that started over since the plan last spoke as not known yet, and no reached limit for it', async () => {
    const limits = {
      status: 'rejected' as const,
      windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-10-29T18:00:00.000Z' }, { name: 'seven_day', utilization: 0.4, resetsAt: '2099-11-04T00:00:00.000Z' }],
      complete: true,
    };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const row = rowOf('Claude');
    const [five, seven] = meterRows(row);
    expect(five).toHaveTextContent(/^5 hoursUnknown, no limit data received yet$/);
    expect(seven).toHaveTextContent(/^7 days40%usedresets in /);
    expect(within(row).queryByText(/^Limit reached/)).not.toBeInTheDocument();
  });

  it("sets apart only the percent sign of a plan's used share in its meter, with its unit beside the figure", async () => {
    const limits = {
      status: 'allowed' as const,
      windows: [{ name: 'five_hour', utilization: null, resetsAt: null }, { name: 'seven_day', utilization: 0.4, resetsAt: '2099-11-04T00:00:00.000Z' }],
      complete: true,
    };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const [five, seven] = meterRows(rowOf('Claude'));
    expect(seven!.querySelector('.g-f > b')?.textContent).toBe('40%');
    expect([...seven!.querySelectorAll('.g-f > b .pct')].map(n => n.textContent)).toEqual(['%']);
    expect([...seven!.querySelectorAll('.g-f > span')].map(n => n.textContent)).toEqual(['used']);
    expect(five!.querySelector('.pct')).toBeNull();
  });

  /* Trinity, #1048: a page laid out right to left read «часов 5», «дней 7» and «до сброса 3 дня ,70%». Each number with its
     unit is one piece that reads left to right. Design, #1058: each phrase around such pieces stays whole, in one piece of
     its own direction, as its dictionary writes it, so on a page laid out right to left it still reads «до сброса 3 дня»
     and «70%, до сброса 3 дня», and a model's week «7 дней, Opus». A column's name is text an attribute also holds for a
     narrow table, so its piece stands between the marks that isolate it left to right, as a bdi dir="ltr" does on a page. */
  it.each([
    ['en', ['5 hours', '7 days', '7 days, Opus'], ['40%', '70%', '20%'], ['2 h 59 min', '3 days', '3 days'], 'resets in '],
    ['ru', ['5 часов', '7 дней', '7 дней, Opus'], ['40%', '70%', '20%'], ['2 ч 59 мин', '3 дня', '3 дня'], 'до сброса '],
  ])('in %s holds each number of a plan\'s limits with its unit in one piece and each phrase whole in its own direction', async (language, windows, shares, durations, resets) => {
    localStorage.setItem('hh-lang', language);
    const now = Date.now();
    const week = new Date(now + 3 * 24 * 3600_000 + 30_000).toISOString();
    const limits = {
      status: 'allowed' as const,
      windows: [
        { name: 'five_hour', utilization: 0.4, resetsAt: new Date(now + (2 * 60 + 59) * 60_000 + 30_000).toISOString() },
        { name: 'seven_day', utilization: 0.7, resetsAt: week },
        { name: 'seven_day_opus', utilization: 0.2, resetsAt: week },
      ],
      complete: true,
    };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits }] }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    const table = await waitFor(() => screen.getByRole('table'));
    /* Each isolated piece in document order, with its direction: null is a phrase's own, found from its words. */
    const pieces = (el: Element) => [...el.querySelectorAll('bdi')].map(b => `${b.getAttribute('dir')} ${b.textContent}`);
    const isolated = (text: string) => `⁦${text}⁩`;
    const columns = windows.slice(0, 2);
    const limitHeads = [...table.querySelectorAll('th .sorth')].map(b => b.textContent ?? '').filter(text => columns.includes(text.replace(/[\u2066\u2069]/g, '')));
    expect(limitHeads).toEqual(columns.map(isolated));
    const row = table.querySelector('tr.rm')!;
    expect([...row.querySelectorAll('td')].filter(td => td.querySelector('.cell-lim')).map(td => td.getAttribute('data-label'))).toEqual(columns.map(isolated));
    const cells = [...row.querySelectorAll('.cell-lim')];
    expect(cells.map(pieces)).toEqual(columns.map((_, i) => [`null ${shares[i]}, ${resets}${durations[i]}`, `ltr ${shares[i]}`, `ltr ${durations[i]}`]));
    expect(cells.map(cell => cell.textContent)).toEqual(columns.map((_, i) => `${shares[i]}, ${resets}${durations[i]}`));
    openCards();
    const meters = meterRows(rowOf('Claude')).slice(0, 3);
    const number = (name: string) => name.split(',')[0];
    expect(meters.map(m => pieces(m.querySelector('.g-l')!))).toEqual(windows.map(w => [`null ${w}`, `ltr ${number(w)}`]));
    expect(meters.map(m => pieces(m.querySelector('.g-f > b')!))).toEqual(shares.map(s => [`ltr ${s}`]));
    expect(meters.map(m => [...m.querySelectorAll('.g-f > b .pct')].map(n => n.textContent))).toEqual([['%'], ['%'], ['%']]);
    expect(meters.map(m => pieces(m.querySelector('.g-s')!))).toEqual(durations.map(d => [`null ${resets}${d}`, `ltr ${d}`]));
    expect(meters.map(m => m.querySelector('.g-s')!.textContent)).toEqual(durations.map(d => `${resets}${d}`));
  });

  it('still says a plan reached its limit when a window without a share stops it, though another full one started over', async () => {
    const limits = {
      status: 'rejected' as const,
      windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-10-29T18:00:00.000Z' }, { name: 'seven_day', utilization: null, resetsAt: '2099-11-04T00:00:00.000Z' }],
    };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, limits }] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Claude')).getByText('Limit reached')).toBeInTheDocument();
  });

  it('says Built-in node offline for an API key whose node is down', async () => {
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[3]!, online: false }] }], 'GET /api/machines': [200, { machines: [] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Anthropic key ending 9f3a')).getByText('Built-in node offline')).toBeInTheDocument();
  });

  it('says Machine offline when the node is not connected', async () => {
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, online: false }] }], 'GET /api/machines': [200, { machines: [] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Claude')).getByText('Machine offline')).toBeInTheDocument();
    expect(within(rowOf('Claude')).queryByRole('button', { name: /Run a test/ })).not.toBeInTheDocument();
  });

  it.each([
    [
      'en',
      'Not on this plan',
      'Machine offline',
      'On workstation-eu. Its agents wait until the machine is back online.',
      'Machine offline, last data from 05:22 PM',
      'Machine offline, no limit data yet',
    ],
    [
      'ru',
      'Нет у этого тарифа',
      'Машина не в сети',
      'На workstation-eu. Ее агенты ждут, пока машина снова подключится.',
      'Машина не в сети, последние данные от 17:22',
      'Машина не в сети, данных о лимитах еще не было',
    ],
  ] as const)('says in %s when a machine is offline instead of Unknown, and Not on this plan for a complete single-window Claude plan', async (language, notOnPlan, offlineState, offlineLine, offlineWithData, offlineNoData) => {
    localStorage.setItem('hh-lang', language);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-13T21:06:00.000Z'));
    onTestFinished(() => { vi.useRealTimers(); });
    const ownerClaude: SubView = {
      ...SUBS[0]!,
      id: 's-1',
      machines: [{ id: 'm-1', hostname: 'work-laptop', status: 'ready', online: true }],
      limits: { status: 'allowed', windows: [{ name: 'seven_day', utilization: 0.96, resetsAt: '2026-11-16T21:00:00.000Z' }], complete: true },
      limitsUpdatedAt: '2026-11-13T21:02:00.000Z',
    };
    const claraClaude: SubView = {
      ...SUBS[0]!,
      id: 's-clara',
      owner: { id: 'p-clara', name: 'Clara' },
      online: false,
      machines: [{ id: 'm-clara', hostname: 'workstation-eu', status: 'ready', online: false }],
      limits: { status: 'allowed', windows: [{ name: 'seven_day', utilization: 0.45, resetsAt: '2026-11-16T21:00:00.000Z' }], complete: true },
      limitsUpdatedAt: '2026-11-13T17:22:00.000Z',
    };
    const maxCodex: SubView = {
      ...SUBS[0]!,
      id: 's-max',
      provider: 'codex',
      label: 'Codex',
      owner: { id: 'p-max', name: 'Max' },
      online: false,
      machines: [{ id: 'm-max', hostname: 'win-desktop-01', status: 'ready', online: false }],
      limits: null,
      limitsUpdatedAt: null,
    };
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [ownerClaude, claraClaude, maxCodex] }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    const rows = await waitFor(() => screen.getAllByRole('row'));
    const claraRow = rows.find(r => r.textContent?.includes('Clara'))!;
    expect(within(claraRow).getByText(offlineState)).toBeInTheDocument();
    expect(within(claraRow).getAllByText(offlineWithData)).toHaveLength(2);
    expect(claraRow.textContent).not.toMatch(/Unknown,|Неизвестно,/);
    const maxRow = rows.find(r => r.textContent?.includes('Max'))!;
    expect(within(maxRow).getAllByText(offlineNoData)).toHaveLength(2);
    const ivanRow = rows.find(r => r.textContent?.includes('Ivan'))!;
    expect(within(ivanRow).getByText(notOnPlan)).toBeInTheDocument();

    openCards();
    const claraCard = screen.getByRole('article', { name: 'Claude, Clara' });
    expect(claraCard.querySelector('.stline')).toHaveTextContent(`${offlineState}${offlineLine}`);
    expect(meterRows(claraCard).map(m => m.textContent)).toEqual([
      `${language === 'en' ? '5 hours' : '5 часов'}${offlineWithData}`,
      `${language === 'en' ? '7 days' : '7 дней'}${offlineWithData}`,
    ]);
    const ivanCard = screen.getByRole('article', { name: 'Claude, Ivan' });
    expect(meterRows(ivanCard)[0]).toHaveTextContent(notOnPlan);
    expect(meterRows(ivanCard)[1]).toHaveTextContent('96%');
  });

  it('refreshes on its own, so a node that signs in turns Ready without a reload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let calls = 0;
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],
      'GET /api/subscriptions': () => {
        calls += 1;
        return [200, { subscriptions: [calls < 2 ? SUBS[1]! : { ...SUBS[1]!, status: 'ready' }] }];
      },
    });
    render(<Subscriptions me={ME} />);
    expect(await waitFor(() => screen.getByText('Waiting for the login'))).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await waitFor(() => screen.getByText('Ready'))).toBeInTheDocument();
  });

  it('connects Claude and Codex and shows the command with Copy and the trust line', async () => {
    const calls = lists({ 'POST /api/subscriptions/connect': [201, { subscriptions: [SUBS[0]], command: COMMAND }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Connect a subscription' })));
    expect(screen.getByRole('button', { name: 'Show command' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Claude' }));
    await user.click(screen.getByRole('checkbox', { name: 'Codex' }));
    expect(screen.getByRole('checkbox', { name: 'GLM' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Show command' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/subscriptions/connect', body: { providers: ['claude', 'codex'] } });
    expect(await waitFor(() => screen.getByText(commandCode(withKey(COMMAND))))).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    expect(screen.getByText(TRUST)).toBeInTheDocument();
  });

  it('connects a Google AI plan, which Antigravity runs', async () => {
    const calls = lists({ 'POST /api/subscriptions/connect': [201, { subscriptions: [SUBS[0]], command: COMMAND }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Connect a subscription' })));
    const google = screen.getByRole('checkbox', { name: 'Antigravity' });
    expect(google).toHaveAccessibleDescription('Google AI Pro or Ultra plan');
    await user.click(google);
    await user.click(screen.getByRole('button', { name: 'Show command' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/subscriptions/connect', body: { providers: ['antigravity'] } });
  });

  it('runs a test and shows the answer', async () => {
    const job = { id: 'j1', status: 'queued', result: null, tail: '', error: null, machine: 'dev-laptop', createdAt: '2026-10-29T10:00:00.000Z', startedAt: null, finishedAt: null };
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
    render(<Subscriptions me={ME} />);
    await openAll();
    const run = await waitFor(() => screen.getByRole('button', { name: 'Run a test on Claude' }));
    /* The screen asks about the test once a second, on a clock the test moves; userEvent would wait on a timer of it. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    await act(async () => { fireEvent.click(run); });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('Answered "ready" in 3.2 s on dev-laptop.')).toBeInTheDocument();
    expect(calls.filter(c => c.path === '/api/jobs/j1')).toHaveLength(2);
  });

  it.each([1, 2])('cancels %i pending test polls when the subscriptions screen closes', async count => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const job = RUNNING_JOB;
    const calls = lists({
      'POST /api/subscriptions/s-claude/test': [201, { job }],
      'POST /api/subscriptions/s-key/test': [201, { job: { ...job, id: 'j2' } }],
    });
    const { unmount } = render(<Subscriptions me={ME} />);
    await act(async () => {});
    openCards();
    for (const name of ['Claude', 'Anthropic key ending 9f3a'].slice(0, count)) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Run a test on ${name}` })); });
    }
    expect(screen.getAllByText('Checking. This can take up to two minutes.')).toHaveLength(count);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.runAllTimersAsync());
    expect(calls.filter(c => c.path.startsWith('/api/jobs/'))).toHaveLength(0);
  });

  it.each(['start', 'poll'])('does not schedule a test poll when a late %s response arrives after closing', async phase => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const job = RUNNING_JOB;
    let finish!: (reply: [number, unknown]) => void;
    const pending = () => new Promise<[number, unknown]>(resolve => { finish = resolve; });
    const calls = lists({
      'POST /api/subscriptions/s-claude/test': phase === 'start' ? pending : [201, { job }],
      'GET /api/jobs/j1': pending,
    });
    const { unmount } = render(<Subscriptions me={ME} />);
    await act(async () => {});
    openCards();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run a test on Claude' })); });
    if (phase === 'poll') await act(async () => vi.advanceTimersByTimeAsync(1000));
    unmount();
    await act(async () => { finish([200, { job }]); });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.runAllTimersAsync());
    expect(calls.filter(c => c.path === '/api/jobs/j1')).toHaveLength(phase === 'poll' ? 1 : 0);
  });

  it('explains a failed test and keeps the output folded', async () => {
    const job = { id: 'j2', status: 'failed', result: '', tail: 'Error: something broke', error: 'agent_failed', machine: 'dev-laptop', createdAt: '2026-10-29T10:00:00.000Z', startedAt: null, finishedAt: '2026-10-29T10:00:01.000Z' };
    lists({ 'POST /api/subscriptions/s-claude/test': [201, { job: { ...job, status: 'queued' } }], 'GET /api/jobs/j2': [200, { job }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const run = await waitFor(() => screen.getByRole('button', { name: 'Run a test on Claude' }));
    /* The screen asks about the test a second on, on a clock the test moves. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    await act(async () => { fireEvent.click(run); });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText('The agent stopped with an error.')).toBeInTheDocument();
    expect(screen.getByText('Show the output')).toBeInTheDocument();
    expect(screen.getByText('Error: something broke')).not.toBeVisible();
  });

  it('asks before removing, then sends DELETE', async () => {
    const calls = lists({ 'DELETE /api/subscriptions/s-kimi': [204] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Remove Kimi' })));
    expect(screen.getByText('Remove Kimi? Its login will be deleted from the machine.')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(calls.find(c => c.method === 'DELETE')).toEqual({ method: 'DELETE', path: '/api/subscriptions/s-kimi', body: undefined });
  });

  it('moves the orchestrator to a company subscription and shows the badge', async () => {
    const calls = lists({ 'POST /api/subscriptions/s-claude/orchestrator': [200, { subscription: { ...SUBS[0]!, isOrchestrator: true } }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Use Claude for the orchestrator' })));
    expect(calls.find(c => c.method === 'POST')!.path).toBe('/api/subscriptions/s-claude/orchestrator');
    expect(await waitFor(() => within(rowOf('Claude')).getByText('Orchestrator'))).toBeInTheDocument();
    expect(within(rowOf('Anthropic key ending 9f3a')).queryByText('Orchestrator')).not.toBeInTheDocument();
  });

  it("sets the share of a plan's limits that tasks may use", async () => {
    const calls = lists({ 'PATCH /api/subscriptions/s-claude': [200, { subscription: { ...SUBS[0]!, budget: 80 } }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    const share = await waitFor(() => within(rowOf('Claude')).getByRole('combobox', { name: 'Share of Claude for tasks' }));
    expect(share).toHaveValue('');
    await user.selectOptions(share, '80');
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ path: '/api/subscriptions/s-claude', body: { budget: 80 } }));
    expect(within(rowOf('Claude')).getByRole('combobox', { name: 'Share of Claude for tasks' })).toHaveValue('80');
    expect(within(rowOf('Anthropic key ending 9f3a')).queryByRole('combobox', { name: /^Share of / })).not.toBeInTheDocument();
  });

  it('names no fallback plan at first, and adds one a person picks', async () => {
    const calls = lists({ 'PATCH /api/subscriptions/s-claude': [200, { subscription: { ...SUBS[0]!, fallbacks: [{ subscription: 's-codex', model: null }] } }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    expect(await waitFor(() => within(card).getByText('Any plan of the company with room for the employee'))).toBeInTheDocument();
    /* Add opens the other plans of the company by their whole names (#1444). */
    await user.click(within(card).getByRole('button', { name: 'Add a fallback plan for Claude, Ivan' }));
    const choices = within(card).getByRole('list', { name: 'Add a fallback plan for Claude, Ivan' });
    expect(within(choices).getAllByRole('button').map(b => b.textContent)).toEqual(['Codex, Ivan', 'Kimi, Ivan', 'Orchestrator (Anthropic)']);
    await user.click(within(choices).getByRole('button', { name: 'Codex, Ivan' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ path: '/api/subscriptions/s-claude', body: { fallbacks: [{ subscription: 's-codex', model: null }] } }));
    expect(await waitFor(() => within(rowOf('Claude')).getByText('Codex, Ivan'))).toBeInTheDocument();
  });

  it('orders the fallback plans, picks the model on one, and removes one', async () => {
    const named = [{ subscription: 's-codex', model: null }, { subscription: 's-key', model: null }];
    const subs = [{ ...SUBS[0]!, fallbacks: named }, ...SUBS.slice(1, 3), { ...SUBS[3]!, models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] }];
    const calls = lists({ 'GET /api/subscriptions': [200, { subscriptions: subs }], 'PATCH /api/subscriptions/s-claude': [200, { subscription: subs[0] }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    expect([...card.querySelectorAll('.fallback-name')].map(name => name.textContent)).toEqual(['Codex, Ivan', 'Orchestrator (Anthropic)']);
    expect(within(card).getByRole('button', { name: 'Move Codex, Ivan higher' })).toBeDisabled();
    await user.click(within(card).getByRole('button', { name: 'Move Codex, Ivan lower' }));
    await user.selectOptions(within(card).getByRole('combobox', { name: 'Model on Orchestrator (Anthropic)' }), 'claude-sonnet-5-5');
    await user.click(within(card).getByRole('button', { name: 'Remove Codex, Ivan from the fallback plans' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'PATCH').map(c => c.body)).toEqual([
      { fallbacks: [named[1], named[0]] },
      { fallbacks: [named[0], { subscription: 's-key', model: 'claude-sonnet-5-5' }] },
      { fallbacks: [named[1]] },
    ]));
  });

  it('shows the fallback plans without changing them to someone who may not change the plan', async () => {
    const fallbacks = [{ subscription: 's-codex', model: null }, { subscription: 's-key', model: 'claude-sonnet-5-5' }];
    const subs = [{ ...SUBS[0]!, owner: { id: 'p9', name: 'Olga' }, fallbacks }, ...SUBS.slice(1, 3), { ...SUBS[3]!, models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] }];
    lists({ 'GET /api/subscriptions': [200, { subscriptions: subs }] });
    render(<Subscriptions me={{ ...ME, person: { ...ME.person, scopeKind: 'listed' } }} />);
    await openAll();
    const card = rowOf('Claude');
    expect(await waitFor(() => within(card).getByText('Codex, Ivan'))).toBeInTheDocument();
    /* The model named for a fallback shows by its name; the role's own shows nothing. */
    expect([...card.querySelectorAll('.fallback-list li')].map(item => [...item.querySelectorAll('.fallback-name, .fallback-model')].map(part => part.textContent))).toEqual([['Codex, Ivan'], ['Orchestrator (Anthropic)', 'Claude Sonnet 5.5']]);
    expect(within(card).queryByRole('combobox', { name: /fallback|Model on/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^(Move|Remove) Codex/ })).not.toBeInTheDocument();
  });

  it('names the fallback plans in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, fallbacks: [{ subscription: 's-codex', model: null }] }, ...SUBS.slice(1)] }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    const card = rowOf('Claude');
    expect(await waitFor(() => within(card).getByText('Запасные тарифы'))).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Опустить Codex, Ivan ниже' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: 'Добавить запасной тариф для Claude, Ivan' })).toBeInTheDocument();
  });

  it('offers no orchestrator choice to a department-scope viewer', async () => {
    lists();
    const lead: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };
    render(<Subscriptions me={lead} />);
    await openAll();
    rowOf('Claude');
    expect(screen.queryByRole('button', { name: /for the orchestrator/ })).not.toBeInTheDocument();
  });

  it('gets a new command for a subscription still waiting for its machine', async () => {
    const calls = lists({ 'POST /api/subscriptions/s-kimi/command': [201, { command: COMMAND }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'New command for Kimi' })));
    expect(calls.find(c => c.method === 'POST')!.path).toBe('/api/subscriptions/s-kimi/command');
    expect(await waitFor(() => within(rowOf('Kimi')).getByText(commandCode(withKey(COMMAND))))).toBeInTheDocument();
    expect(within(rowOf('Claude')).queryByRole('button', { name: /New command/ })).not.toBeInTheDocument();
  });

  it('shows the states in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    /* A working plan that has sent no limits yet: a plan that does not work shows no meters. */
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [...SUBS, { ...SUBS[0]!, id: 's-glm', provider: 'glm', label: 'GLM', limits: null, agents: [] }] }] });
    render(
      <LanguageProvider>
        <Subscriptions me={ME} />
      </LanguageProvider>,
    );
    await openAll();
    expect(within(screen.getByRole('table')).getAllByText('Готова')).toHaveLength(6);
    expect(within(rowOf('Codex')).getByText('Ждет входа')).toBeInTheDocument();
    expect(within(rowOf('Kimi')).getByText('Ждет машину')).toBeInTheDocument();
    const [five, seven] = meterRows(rowOf('Claude'));
    expect(five).toHaveTextContent(/^5 часов42%использованодо сброса /);
    expect(seven).toHaveTextContent(/^7 дней10%использованоВремя сброса неизвестно$/);
    const [glmFive] = meterRows(rowOf('GLM'));
    expect(glmFive).toHaveTextContent(/^5 часовНеизвестно, данных о лимитах еще не было$/);
    expect(within(rowOf('Ключ Anthropic, заканчивается на 9f3a')).getByText('Оплата по факту, без лимитов тарифа')).toBeInTheDocument();
  });
});
