import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { JobView, Me, SubView } from '../src/types';
import { armor, Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { ME, MACHINE, mockApi, SUBS, withKey } from './api-mock';
import { decl } from './css';
import { fakeStream } from './fake-stream';
import { commandCode } from './command-code';

vi.mock('../src/ui/AgentTerminal', () => ({
  AgentTerminal: ({ path }: { path: string }) => <div data-testid="live-terminal" data-path={path} />,
}));

const COMMAND = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join CODE123';
const TRUST = 'Agents will run on this machine with your subscription. People with access to this Hornhoof can give them work.';
const RUNNING_JOB: JobView = { id: 'j1', status: 'running', result: null, tail: '', error: null, machine: 'dev-laptop', createdAt: '2026-10-29T10:00:00.000Z', startedAt: '2026-10-29T10:00:00.500Z', finishedAt: null };

const lists = (extra: Parameters<typeof mockApi>[0] = {}) => mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: SUBS }], ...extra });

const rowOf = (name: string) => screen.queryByRole('article', { name: new RegExp(`^${name}, `) }) ?? screen.getByRole('row', { name: new RegExp(`^${name}\\b`) });
const openCards = () => {
  for (const button of screen.getAllByRole('button', { name: /^(Open the card of |Открыть карточку )/ })) fireEvent.click(button);
};
const openAll = async () => {
  await screen.findByRole('table');
  openCards();
};
const meterRows = (card: HTMLElement) => [...card.querySelectorAll('.gauge')];

afterEach(() => localStorage.clear());

describe('Subscriptions', () => {
  it.each([
    ['en', 'Until ', ', in 2 h 10 min. Its agents wait until then.', 'resets in 2 h 10 min', 'Ivan, limit reached until ', 'Built-in node', 'comes with the server'],
    ['ru', 'До ', ', еще 2 ч 10 мин. До тех пор ее агенты ждут.', 'до сброса 2 ч 10 мин', 'Ivan, лимит исчерпан до ', 'Встроенная нода', 'идет вместе с сервером'],
  ])('uses the quoted state, meter and machine-list wording in %s', async (language, until, sentence, reset, localState, builtin, comesWith) => {
    localStorage.setItem('hh-lang', language);
    vi.useFakeTimers({ toFake: ['Date'] });
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
    const row = await screen.findByRole('row', { name: /^Antigravity\b/ });
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
    await screen.findByRole('row', { name: /^Claude\b/ });
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
    const claude = await screen.findByRole('row', { name: 'Claude' });
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
    await userEvent.selectOptions(within(card).getByRole('combobox'), '80');
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
    await screen.findByRole('table');
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    let count = 0;
    lists({ 'GET /api/subscriptions': () => [200, { subscriptions: [SUBS[0]!, { ...SUBS[1]!, status: ++count > 1 ? 'ready' : 'needs_login' }] }] });
    render(<Subscriptions me={ME} />);
    await screen.findByRole('table');
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
    vi.useFakeTimers({ toFake: ['Date'] });
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
    vi.useFakeTimers({ toFake: ['Date'] });
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
    const table = await screen.findByRole('table');
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
    vi.useFakeTimers({ toFake: ['Date'] });
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
    const rows = await screen.findAllByRole('row');
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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
    expect(await screen.findByText('Waiting for the login')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
  });

  it('connects Claude and Codex and shows the command with Copy and the trust line', async () => {
    const calls = lists({ 'POST /api/subscriptions/connect': [201, { subscriptions: [SUBS[0]], command: COMMAND }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await screen.findByRole('button', { name: 'Connect a subscription' }));
    expect(screen.getByRole('button', { name: 'Show command' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Claude' }));
    await user.click(screen.getByRole('checkbox', { name: 'Codex' }));
    expect(screen.getByRole('checkbox', { name: 'GLM' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Show command' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/subscriptions/connect', body: { providers: ['claude', 'codex'] } });
    expect(await screen.findByText(commandCode(withKey(COMMAND)))).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    expect(screen.getByText(TRUST)).toBeInTheDocument();
  });

  it('connects a Google AI plan, which Antigravity runs', async () => {
    const calls = lists({ 'POST /api/subscriptions/connect': [201, { subscriptions: [SUBS[0]], command: COMMAND }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await screen.findByRole('button', { name: 'Connect a subscription' }));
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
    const run = await screen.findByRole('button', { name: 'Run a test on Claude' });
    /* The screen asks about the test once a second, on a clock the test moves; userEvent would wait on a timer of it. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    const run = await screen.findByRole('button', { name: 'Run a test on Claude' });
    /* The screen asks about the test a second on, on a clock the test moves. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    await openAll();
    await user.click(await screen.findByRole('button', { name: 'Use Claude for the orchestrator' }));
    expect(calls.find(c => c.method === 'POST')!.path).toBe('/api/subscriptions/s-claude/orchestrator');
    expect(await within(rowOf('Claude')).findByText('Orchestrator')).toBeInTheDocument();
    expect(within(rowOf('Anthropic key ending 9f3a')).queryByText('Orchestrator')).not.toBeInTheDocument();
  });

  it("sets the share of a plan's limits that tasks may use", async () => {
    const calls = lists({ 'PATCH /api/subscriptions/s-claude': [200, { subscription: { ...SUBS[0]!, budget: 80 } }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    const share = await within(rowOf('Claude')).findByRole('combobox', { name: 'Share of Claude for tasks' });
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
    await openAll();
    rowOf('Claude');
    expect(screen.queryByRole('button', { name: /for the orchestrator/ })).not.toBeInTheDocument();
  });

  it('gets a new command for a subscription still waiting for its machine', async () => {
    const calls = lists({ 'POST /api/subscriptions/s-kimi/command': [201, { command: COMMAND }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await screen.findByRole('button', { name: 'New command for Kimi' }));
    expect(calls.find(c => c.method === 'POST')!.path).toBe('/api/subscriptions/s-kimi/command');
    expect(await within(rowOf('Kimi')).findByText(commandCode(withKey(COMMAND)))).toBeInTheDocument();
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

describe('subscription search and filters', () => {
  it('searches agents and machines without closing matching cards, then clears the query', async () => {
    lists();
    render(<Subscriptions me={ME} />);
    expect(await screen.findByText('4 subscriptions')).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search' });
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of Claude' }));
    await userEvent.type(search, 'bRuNo');
    expect(screen.getByText('Showing 1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Claude, Ivan' })).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'dev-laptop');
    expect(screen.getByText('Showing 2 of 4')).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'missing');
    expect(screen.getByText('Nothing matches. Change the search or clear the filters.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('4 subscriptions')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Claude, Ivan' })).toBeInTheDocument();
  });

  it('widens providers in one group and combines provider, owner and status filters', async () => {
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [SUBS[0]!, SUBS[1]!, { ...SUBS[2]!, owner: { id: 'p2', name: 'Maria' } }, SUBS[3]!] }] });
    render(<Subscriptions me={ME} />);
    await screen.findByRole('table');
    const provider = screen.getByRole('group', { name: 'Provider' });
    await userEvent.click(within(provider).getByRole('button', { name: /Claude.*2/ }));
    expect(screen.getByText('Showing 2 of 4')).toBeInTheDocument();
    await userEvent.click(within(provider).getByRole('button', { name: /Codex.*1/ }));
    expect(screen.getByText('Showing 3 of 4')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('group', { name: 'Owner' })).getByRole('button', { name: /^Ivan/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: /^Waiting for the login/ }));
    expect(screen.getByText('Showing 1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'Codex' })).toBeInTheDocument();
  });

  it('searches key endings, tiers, account addresses and where the plan serves', async () => {
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, tier: 'max', accounts: [{ nodeId: 'n1', hostname: 'dev-laptop', tier: 'max', email: 'private@acme.com' }], place: { kind: 'department', id: 'd1', name: 'Marketing' } }, SUBS[3]!] }] });
    render(<Subscriptions me={ME} />);
    await screen.findByRole('table');
    const search = screen.getByRole('searchbox');
    for (const query of ['9f3a', 'max', 'private@acme.com', 'Marketing']) {
      await userEvent.clear(search);
      await userEvent.type(search, query);
      expect(screen.getByText('Showing 1 of 2')).toBeInTheDocument();
    }
    expect(screen.queryByRole('group', { name: 'Provider' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Owner' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Status' })).not.toBeInTheDocument();
  });
});

describe('signing in to plans', () => {
  const NODE = '7d1c6a52-2f4e-4c4b-9f55-0d7a3c1e9b10';
  const LAPTOP = { id: 'm3', hostname: 'dev-notebook', status: 'ready' as const, online: true };
  const claude = SUBS[0]!;
  const codex = SUBS[1]!;
  const only = (...subs: typeof SUBS) => ({ 'GET /api/subscriptions': [200, { subscriptions: subs }] as [number, unknown] });

  it("says a plan signed in once runs on any of its owner's machines, and how many are online", async () => {
    mockApi(only({ ...claude, signedInOnce: true, machines: [MACHINE, LAPTOP, { ...LAPTOP, id: 'm4', hostname: 'work-tower', online: false }] }));
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Claude')).getByText("Signed in once, runs on any of Ivan's machines (2 online)")).toBeInTheDocument();
  });

  it('says a plan signed in on its machine by hand runs only there', async () => {
    mockApi(only(claude));
    render(<Subscriptions me={ME} />);
    await openAll();
    const row = rowOf('Claude');
    expect(within(row).getByText('Signed in on dev-laptop only')).toBeInTheDocument();
    expect(within(row).queryByText(/^Signed in once/)).not.toBeInTheDocument();
  });

  it('says a Codex plan signed in once runs on one machine at a time, and on which', async () => {
    mockApi(only({ ...codex, status: 'ready', signedInOnce: true, leaseMachine: 'dev-notebook', machines: [MACHINE, LAPTOP] }));
    render(<Subscriptions me={ME} />);
    await openAll();
    const row = rowOf('Codex');
    expect(within(row).getByText('Codex runs on one machine at a time; now on dev-notebook')).toBeInTheDocument();
    expect(within(row).queryByText(/^Signed in once/)).not.toBeInTheDocument();
  });

  it('names the tier each plan runs on, and what a free Codex plan cannot do', async () => {
    const free = { ...codex, status: 'ready' as const, tier: 'free', accounts: [{ nodeId: NODE, hostname: 'dev-laptop', tier: 'free' }] };
    mockApi(only({ ...claude, signedInOnce: true }, free));
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Claude')).getByText('Claude, one-year sign-in')).toBeInTheDocument();
    expect(within(rowOf('Codex')).getByText('Codex, Free: newer models need Plus or Pro')).toBeInTheDocument();
  });

  it('names a paid tier, and says when machines of one plan are signed in to different accounts', async () => {
    const pro = { ...codex, status: 'ready' as const, tier: 'pro', accounts: [{ nodeId: NODE, hostname: 'dev-laptop', tier: 'pro', email: 'ivan@acme.com' }] };
    const accounts = [
      { nodeId: NODE, hostname: 'dev-laptop', tier: 'max', email: 'ivan@acme.com' },
      { nodeId: 'n2', hostname: 'dev-notebook', tier: 'pro', email: 'ivan@acme.example' },
    ];
    mockApi(only({ ...claude, machines: [MACHINE, LAPTOP], accounts, accountsDiffer: true }, pro));
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Codex')).getByText('Codex, Pro')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByText('dev-laptop and dev-notebook are signed in to different accounts')).toBeInTheDocument();
  });

  it("signs a plan in again with another account in a terminal on the owner's machine, and closes it once signed in", async () => {
    const stream = fakeStream();
    const calls = mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only({ ...claude, signedInOnce: true }), 'POST /api/subscriptions/s-claude/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Claude with another account' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/subscriptions/s-claude/signin', body: { fresh: true } });
    expect(await screen.findByRole('heading', { name: 'Signing in on dev-laptop' })).toBeInTheDocument();
    expect(screen.getByTestId('live-terminal')).toHaveAttribute('data-path', `/api/subscriptions/s-claude/signin/terminal?nodeId=${NODE}`);
    /* Another plan's or machine's sign-in leaves this one open. */
    stream.send({ type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: true, error: null, owner: 'p1' });
    expect(screen.getByRole('heading', { name: 'Signing in on dev-laptop' })).toBeInTheDocument();
    stream.send({ type: 'subscription.signin', subscriptionId: 's-claude', nodeId: NODE, ok: true, error: null, owner: 'p1' });
    await vi.waitFor(() => expect(screen.queryByRole('heading', { name: 'Signing in on dev-laptop' })).not.toBeInTheDocument());
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it('signs in a plan that waits for its login, and says in plain words when the sign-in fails', async () => {
    const stream = fakeStream();
    const calls = mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only(codex), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ fresh: false });
    await screen.findByRole('heading', { name: 'Signing in on dev-laptop' });
    stream.send({ type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: false, error: 'tmux: lost server', owner: 'p1' });
    /* Under the plan's row, as a test's result is. */
    expect(await screen.findByText('The sign-in did not finish, so nothing changed. Try again.')).toBeInTheDocument();
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it('brings the sign-in window into view when it opens, below a long card', async () => {
    const shown: Element[] = [];
    const before = Element.prototype.scrollIntoView;
    /* As Chromium's does, it gives back a promise. */
    Element.prototype.scrollIntoView = function (this: Element) { shown.push(this); return Promise.resolve() as unknown as void; };
    onTestFinished(() => void (Element.prototype.scrollIntoView = before));
    fakeStream();
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only({ ...codex, status: 'ready', machines: [MACHINE] }), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }], 'POST /api/subscriptions/s-codex/signin/stop': [204] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    const heading = await screen.findByRole('heading', { name: 'Signing in on dev-laptop' });
    await vi.waitFor(() => expect(shown.some(node => node.contains(heading))).toBe(true));
    /* Closing it must not trip over what scrolling gave back. */
    await userEvent.click(screen.getByRole('button', { name: 'Stop the sign-in' }));
    await vi.waitFor(() => expect(screen.queryByRole('heading', { name: 'Signing in on dev-laptop' })).not.toBeInTheDocument());
  });

  it('says what to do when the machine could not install the program to sign in with', async () => {
    const stream = fakeStream();
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only(codex), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    await screen.findByRole('heading', { name: 'Signing in on dev-laptop' });
    stream.send({ type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: false, error: 'The program could not be installed on this machine, so nothing changed.', owner: 'p1' });
    expect(await screen.findByText("The program could not be installed on this machine, so nothing changed. Check the machine's internet connection and free disk space, then try again.")).toBeInTheDocument();
  });

  it('stops a sign-in half way', async () => {
    fakeStream();
    const calls = mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only(codex), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }], 'POST /api/subscriptions/s-codex/signin/stop': [204] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop the sign-in' }));
    expect(calls.find(c => c.path.endsWith('/signin/stop'))).toEqual({ method: 'POST', path: '/api/subscriptions/s-codex/signin/stop', body: { nodeId: NODE } });
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  /* A server that names no machine or gives no command, or gives them in another shape, gets the plain words, and no
     command box. */
  it.each([
    ['no details', undefined],
    ['no machines', { command: 'curl -fsSL https://hq.acme.com/install.sh | bash' }],
    ['no command', { machines: ['dev-laptop'] }],
    ['machines that are not a list', { machines: 'dev-laptop', command: 'curl -fsSL https://hq.acme.com/install.sh | bash' }],
    ['a command that is not text', { machines: ['dev-laptop'], command: { text: 'curl -fsSL https://hq.acme.com/install.sh | bash' } }],
  ])('says under the plan, in plain words, why a sign-in cannot start, instead of at the top of the page, with %s', async (_, details) => {
    const ready = { ...codex, status: 'ready' as const, machines: [MACHINE] };
    const unsupported = { error: { code: 'conflict', message: 'The machine of this plan is online, but its node cannot run the sign-in.', reason: 'signin_unsupported', ...(details ? { details } : {}) } };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }], ...only(ready, SUBS[0]!), 'POST /api/subscriptions/s-codex/signin': [409, unsupported] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    const words = 'The machine is online, but its node cannot sign in from Hornhoof yet. Update the nodes on that machine, then try again.';
    expect(await within(card).findByText(words)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Sign in to Codex' })).toBeInTheDocument();
    /* Under the plan whose button was pressed alone. */
    expect(within(screen.getByRole('article', { name: 'Claude, Ivan' })).queryByText(words)).not.toBeInTheDocument();
  });

  it.each([
    ['en', 'Sign in to Codex', 'The nodes on dev-laptop are older than the sign-in from Hornhoof needs. To update them, run this command in a terminal on dev-laptop, then sign in again.', 'Copy', 'It moves the Hornhoof nodes on that machine to the new build and keeps their sign-ins and files.'],
    ['ru', 'Войти в Codex', 'Ноды на dev-laptop старше, чем нужно для входа из Hornhoof. Чтобы обновить их, выполните эту команду в терминале на dev-laptop, затем войдите снова.', 'Копировать', 'Она переводит ноды Hornhoof на этой машине на новую сборку, а их вход и файлы сохраняет.'],
  ])('names the machine whose nodes are too old for the sign-in, with the command that updates them to copy, in %s', async (language, signIn, text, copy, trust) => {
    localStorage.setItem('hh-lang', language);
    const update = 'curl -fsSL https://hq.acme.com/install.sh | bash';
    const old = { error: { code: 'conflict', message: 'The nodes on dev-laptop are older than the sign-in from Hornhoof needs.', reason: 'signin_unsupported', details: { machines: ['dev-laptop'], command: update } } };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }], ...only({ ...codex, status: 'ready' as const, machines: [MACHINE] }), 'POST /api/subscriptions/s-codex/signin': [409, old] });
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn((t: string) => { copied.push(t); return Promise.resolve(); }) } });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: signIn }));
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(await within(card).findByText(text)).toBeInTheDocument();
    expect(within(card).getByText(commandCode(update))).toBeInTheDocument();
    expect(within(card).getByText(trust)).toBeInTheDocument();
    await userEvent.click(within(card).getAllByRole('button', { name: copy })[0]!);
    expect(copied).toEqual([update]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    /* The next try starts clean: the note and its command go once the sign-in starts. */
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }], ...only({ ...codex, status: 'ready' as const, machines: [MACHINE] }), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }] });
    await userEvent.click(within(card).getByRole('button', { name: signIn }));
    await vi.waitFor(() => expect(within(card).queryByText(commandCode(update))).not.toBeInTheDocument());
  });

  it('says in Russian that no machine of the plan is online to sign in on', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const ready = { ...codex, status: 'ready' as const, machines: [MACHINE] };
    const offline = { error: { code: 'conflict', message: 'No machine of this plan is online.', reason: 'no_node_online' } };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only(ready), 'POST /api/subscriptions/s-codex/signin': [409, offline] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Войти в Codex' }));
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(await within(card).findByText('Ни одна машина этой подписки не в сети. Включите одну из них и попробуйте еще раз.')).toBeInTheDocument();
  });

  it('offers no sign-in for a plan of another person, or one with no machine online', async () => {
    mockApi(only({ ...codex, owner: { id: 'p4', name: 'Oleg' } }, { ...claude, online: false, machines: [{ ...MACHINE, online: false }] }));
    render(<Subscriptions me={ME} />);
    await openAll();
    rowOf('Codex');
    expect(screen.queryByRole('button', { name: /^Sign in to / })).not.toBeInTheDocument();
  });

  it('seals a pasted Kimi key in the browser for each machine of the plan, so Hornhoof never sees it', async () => {
    const identity = await generateX25519Identity();
    const KEY = 'sk-kimi-7Hq2xP9wLm4Zr8Tv';
    const kimi = { ...SUBS[2]!, status: 'needs_login' as const, online: true, machines: [{ ...MACHINE, status: 'needs_login' as const }] };
    const calls = mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],
      ...only(kimi),
      'GET /api/subscriptions/s-kimi/recipients': [200, { version: 2, recipients: [{ nodeId: NODE, publicKey: await identityToRecipient(identity), hostname: 'dev-laptop' }] }],
      'POST /api/subscriptions/s-kimi/credential': [200, { stored: 1 }],
    });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Paste the key for Kimi' }));
    expect(screen.getByRole('link', { name: /Kimi/ })).toHaveAttribute('href', 'https://www.kimi.com/code/console');
    await userEvent.type(screen.getByLabelText('Kimi key'), KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Connect key' }));
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
    const free = { ...codex, status: 'ready' as const, tier: 'free', signedInOnce: true, leaseMachine: 'dev-laptop', accounts: [{ nodeId: NODE, hostname: 'dev-laptop', tier: 'free' }] };
    mockApi(only({ ...claude, signedInOnce: true, machines: [MACHINE, LAPTOP] }, free));
    render(
      <LanguageProvider>
        <Subscriptions me={ME} />
      </LanguageProvider>,
    );
    await openAll();
    const row = rowOf('Claude');
    expect(within(row).getByText('Вход выполнен один раз, работает на любой машине Ivan (на связи: 2)')).toBeInTheDocument();
    expect(within(row).getByText('Claude, вход на год')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Войти в Claude с другим аккаунтом' })).toHaveTextContent('Войти в другой аккаунт');
    expect(within(rowOf('Codex')).getByText('Codex работает на одной машине за раз; сейчас на dev-laptop')).toBeInTheDocument();
    expect(within(rowOf('Codex')).getByText('Codex, Free: новым моделям нужен Plus или Pro')).toBeInTheDocument();
  });
});

/* A plan that does not work yet, as it waits for its machine or its sign-in, or whose sign-in found nodes too old for it,
   has nothing else to show: its card is one block across, saying what is wrong and where, with what to do and Remove. */
describe('the card of a plan that does not work', () => {
  const [claude, codex, kimi, key] = SUBS as [SubView, SubView, SubView, SubView];
  const UPDATE = 'curl -fsSL https://hq.acme.com/install.sh | bash';
  const OLD = { error: { code: 'conflict', message: 'The nodes on dev-laptop are older than the sign-in from Hornhoof needs.', reason: 'signin_unsupported', details: { machines: ['dev-laptop'], command: UPDATE } } };
  const OLD_TEXT = 'The nodes on dev-laptop are older than the sign-in from Hornhoof needs. To update them, run this command in a terminal on dev-laptop, then sign in again.';
  const only = (...subs: SubView[]) => ({ 'GET /api/nodes/commands': [200, { commands: [] }] as [number, unknown], 'GET /api/subscriptions': [200, { subscriptions: subs }] as [number, unknown] });
  const THREE = ['blk blk-facts', 'blk blk-run', 'blk blk-side'];
  const blocks = (card: HTMLElement) => [...card.querySelectorAll('.blocks > .blk')].map(b => b.className);
  const buttons = (part: HTMLElement) => within(part).getAllByRole('button').map(b => b.textContent);
  /* The install command of a plan waiting for its machine, live for 21 more hours, its block at the top closed with Done. */
  const installFor = (sub: SubView) => ({ id: 'c'.repeat(64), kind: 'plans', subscriptionIds: [sub.id], dismissedSubscriptionIds: [sub.id], plans: [sub.label], machine: null, command: COMMAND, expiresAt: new Date(Date.now() + 21 * 3600_000 + 60_000).toISOString() });
  /* What a working plan's card has, and the card of one that does not work leaves out. */
  const workingParts = (card: HTMLElement) => [
    ...['Limits', 'Owner and account', 'Settings', 'Machines of this plan'].filter(name => within(card).queryByRole('heading', { name })),
    ...(within(card).queryByRole('region', { name: 'Agents on it' }) ? ['Agents on it'] : []),
    ...within(card).queryAllByRole('button', { name: /^(Run a test on |Use .+ for the orchestrator$)/ }).map(b => b.textContent),
  ];

  it('shows a plan waiting for its sign-in as one block across the card: why and where, Sign in and Remove', async () => {
    mockApi(only(codex));
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(workingParts(card)).toEqual([]);
    const block = card.querySelector<HTMLElement>('.blk-fix')!;
    expect(block.firstElementChild).toHaveTextContent('On dev-laptop. Only Ivan can sign in.');
    expect(buttons(block)).toEqual(['Sign in', 'Remove']);
    /* Said once, in the block, and not in the card's head as well. */
    expect(within(card).getAllByText('On dev-laptop. Only Ivan can sign in.')).toHaveLength(1);
    expect(decl('.blk-fix', 'grid-column')).toBe('1 / -1');
    expect(decl('.blk-fix', 'grid-row')).toBe('1 / -1');
  });

  it.each([
    ['en', 'It needs a sign-in on dev-laptop, and the machine is offline.', 'Remove'],
    ['ru', 'Нужен вход на dev-laptop, а машина не в сети.', 'Удалить'],
  ])('says in %s that a plan waiting for its sign-in has its machine offline, with Remove alone', async (language, words, remove) => {
    localStorage.setItem('hh-lang', language);
    mockApi(only({ ...codex, online: false, machines: [{ ...codex.machines[0]!, online: false }] }));
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(card.querySelector('.blk-fix')!.firstElementChild).toHaveTextContent(words);
    expect(buttons(card)).toEqual([remove]);
  });

  it('shows a plan waiting for its machine as one block: who has not run the command, Make a new command and Remove', async () => {
    mockApi(only(kimi));
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Kimi, Ivan' });
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(workingParts(card)).toEqual([]);
    expect(card.querySelector('.blk-fix')!.firstElementChild).toHaveTextContent('Ivan has not run the install command yet.');
    expect(buttons(card)).toEqual(['Make a new command', 'Remove']);
    /* The button stands where the command will, as wide as its words, not across the card. */
    expect(decl('.blk-fix > .act', 'justify-self')).toBe('start');
  });

  it.each([
    ['en', 'Ivan has not run the install command yet.', 'Valid for 21 more hours.', ['Copy', 'Remove']],
    ['ru', 'Владелец (Ivan) еще не выполнил команду установки.', 'Действует еще 21 ч.', ['Копировать', 'Удалить']],
  ])('puts the install command of a plan waiting for its machine in its block, in %s', async (language, words, lifetime, actions) => {
    localStorage.setItem('hh-lang', language);
    mockApi({ ...only(kimi), 'GET /api/nodes/commands': [200, { commands: [installFor(kimi)] }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    const card = screen.getByRole('article', { name: 'Kimi, Ivan' });
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(workingParts(card)).toEqual([]);
    /* Why, the steps to its work, the command and the one for Windows, each with Copy, and how long they work, then Remove:
       one block, nothing beside it. */
    const [why, steps, install, last, ...rest] = [...card.querySelector<HTMLElement>('.blk-fix')!.children] as HTMLElement[];
    expect(why!.textContent).toBe(words);
    expect(steps).toHaveRole('list');
    await vi.waitFor(() => expect(install).toHaveTextContent(withKey(COMMAND)));
    expect(install).toHaveTextContent(lifetime);
    expect(buttons(install!)).toEqual([actions[0], actions[0]]);
    expect(buttons(last!)).toEqual([actions[1]]);
    expect(rest).toEqual([]);
  });

  it("shows the plan of another person waiting for their machine without its install command: who, and Remove", async () => {
    const maria = { ...kimi, owner: { id: 'p2', name: 'Maria' } };
    mockApi({ ...only(maria), 'GET /api/nodes/commands': [200, { commands: [installFor(maria)] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Kimi, Maria' });
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(card.querySelector('.blk-fix')!.firstElementChild).toHaveTextContent('Maria has not run the install command yet.');
    expect(within(card).queryByText(commandCode(withKey(COMMAND)))).not.toBeInTheDocument();
    expect(buttons(card)).toEqual(['Remove']);
  });

  it("turns a working plan's card into the block when its sign-in finds old nodes, and back into the card after a reload", async () => {
    const ready = { ...codex, status: 'ready' as const, machines: [MACHINE] };
    mockApi({ ...only(ready), 'POST /api/subscriptions/s-codex/signin': [409, OLD] });
    const { unmount } = render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(blocks(card)).toEqual(THREE);
    expect(workingParts(card)).toEqual(['Limits', 'Owner and account', 'Settings', 'Machines of this plan', 'Agents on it', 'Run a test', 'Use for the orchestrator']);
    await userEvent.click(within(card).getByRole('button', { name: 'Sign in to Codex' }));
    await vi.waitFor(() => expect(blocks(card)).toEqual(['blk blk-fix']));
    expect(workingParts(card)).toEqual([]);
    /* The machine and why, the command and the one for Windows with Copy, and Sign in and Remove under them. */
    const block = card.querySelector<HTMLElement>('.blk-fix')!;
    expect(block.firstElementChild).toHaveTextContent(OLD_TEXT);
    expect(within(block).getByText(commandCode(UPDATE))).toBeInTheDocument();
    expect(buttons(block)).toEqual(['Copy', 'Copy', 'Sign in', 'Remove']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    /* The screen alone keeps it: opened again, the card is the working plan's. */
    unmount();
    render(<Subscriptions me={ME} />);
    await openAll();
    const again = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(blocks(again)).toEqual(THREE);
    expect(within(again).queryByText(commandCode(UPDATE))).not.toBeInTheDocument();
  });

  it('keeps the block while Sign in is asked again, and changes it only for the answer', async () => {
    const ready = { ...codex, status: 'ready' as const, machines: [MACHINE] };
    let answer: (reply: [number, unknown]) => void = () => {};
    let asked = 0;
    mockApi({ ...only(ready), 'POST /api/subscriptions/s-codex/signin': () => (++asked === 1 ? [409, OLD] : new Promise(done => { answer = done; })) });
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    await userEvent.click(within(card).getByRole('button', { name: 'Sign in to Codex' }));
    await vi.waitFor(() => expect(blocks(card)).toEqual(['blk blk-fix']));
    await userEvent.click(within(card).getByRole('button', { name: 'Sign in to Codex' }));
    await vi.waitFor(() => expect(asked).toBe(2));
    /* While the server has not answered, the card stays as it was. */
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(within(card).getByText(commandCode(UPDATE))).toBeInTheDocument();
    act(() => answer([409, OLD]));
    await vi.waitFor(() => expect(within(card).getByText(commandCode(UPDATE))).toBeInTheDocument());
    expect(blocks(card)).toEqual(['blk blk-fix']);
  });

  it('puts the old nodes and their command in place of the why, in the block of a plan waiting for its sign-in', async () => {
    mockApi({ ...only(codex), 'POST /api/subscriptions/s-codex/signin': [409, OLD] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    await userEvent.click(within(card).getByRole('button', { name: 'Sign in to Codex' }));
    const block = card.querySelector<HTMLElement>('.blk-fix')!;
    await vi.waitFor(() => expect(block.firstElementChild).toHaveTextContent(OLD_TEXT));
    expect(within(card).queryByText('On dev-laptop. Only Ivan can sign in.')).not.toBeInTheDocument();
    expect(buttons(block)).toEqual(['Copy', 'Copy', 'Sign in', 'Remove']);
    expect(blocks(card)).toEqual(['blk blk-fix']);
  });

  it.each([
    ['ready', claude],
    ['at its limit', { ...claude, limits: { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2099-10-29T18:00:00.000Z' }] } }],
    ['with its machine offline', { ...claude, online: false, machines: [{ ...MACHINE, online: false }] }],
    ['of a key whose built-in node is offline', { ...key, online: false }],
  ])('keeps the three blocks of the card for a plan %s', async (_, sub) => {
    mockApi(only(sub));
    render(<Subscriptions me={ME} />);
    await openAll();
    const [card] = screen.getAllByRole('article');
    expect(blocks(card!)).toEqual(THREE);
  });

  it('says nothing under the state of a working plan that is not at its limit', async () => {
    mockApi(only(claude));
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(screen.getByRole('article', { name: 'Claude, Ivan' }).querySelector('.stline')).toHaveTextContent(/^Ready$/);
  });

  it("asks before removing a working plan's key from its card, then sends DELETE", async () => {
    const calls = mockApi({ ...only(key), 'DELETE /api/subscriptions/s-key': [204] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const side = screen.getByRole('article', { name: 'Anthropic key ending 9f3a, Ivan' }).querySelector<HTMLElement>('.blk-side')!;
    await userEvent.click(within(side).getByRole('button', { name: 'Remove Anthropic key ending 9f3a' }));
    expect(within(side).getByText('Remove Anthropic key ending 9f3a? The key is deleted from Hornhoof.')).toBeInTheDocument();
    await userEvent.click(within(side).getByRole('button', { name: 'Yes, remove' }));
    expect(calls.find(c => c.method === 'DELETE')).toEqual({ method: 'DELETE', path: '/api/subscriptions/s-key', body: undefined });
  });
});

describe('the forms that connect plans and keys', () => {
  const groupOf = (button: HTMLElement) => {
    const foot = button.parentElement!;
    expect(foot).toHaveClass('form-foot');
    return within(foot).getAllByRole('button');
  };

  it('offers each plan as a card with its mark, and says Preparing… on Show command, which comes before Cancel', async () => {
    let finish!: (reply: [number, unknown]) => void;
    lists({ 'POST /api/subscriptions/connect': () => new Promise(resolve => { finish = resolve; }) });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await screen.findByRole('button', { name: 'Connect a subscription' }));
    expect(screen.getByRole('heading', { name: 'Connect subscriptions' })).toBeInTheDocument();
    const claude = screen.getByRole('checkbox', { name: 'Claude' });
    expect(claude.closest('label')!.querySelector('svg.pm')).not.toBeNull();
    await user.click(claude);
    const show = screen.getByRole('button', { name: 'Show command' });
    expect(groupOf(show)).toEqual([show, screen.getByRole('button', { name: 'Cancel' })]);
    await user.click(show);
    expect(show).toHaveAccessibleName('Preparing…');
    expect(show).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish([201, { subscriptions: [SUBS[0]], command: 'curl x' }]); });
  });

  it('asks for a key in the form grid, says Connecting… on Connect key, which comes before Cancel', async () => {
    let finish!: (reply: [number, unknown]) => void;
    const kimi = { ...SUBS[2]!, status: 'needs_login' as const, online: true, machines: [{ ...MACHINE, status: 'needs_login' as const }] };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }], 'GET /api/subscriptions': [200, { subscriptions: [kimi] }], 'GET /api/subscriptions/s-kimi/recipients': () => new Promise(resolve => { finish = resolve; }) });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await screen.findByRole('button', { name: 'Paste the key for Kimi' }));
    const field = screen.getByLabelText('Kimi key');
    expect(field.closest('form')).toHaveClass('form-grid');
    expect(field).toHaveAccessibleDescription(/Stored encrypted and never shown again after saving\./);
    await user.type(field, 'sk-kimi-1');
    const connect = screen.getByRole('button', { name: 'Connect key' });
    expect(groupOf(connect)).toEqual([connect, screen.getByRole('button', { name: 'Cancel' })]);
    await user.click(connect);
    expect(connect).toHaveAccessibleName('Connecting…');
    expect(connect).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish([200, { version: 1, recipients: [] }]); });
    expect(await screen.findByRole('alert')).toHaveTextContent('No machine of this plan can take the key yet.');
    expect(connect).toHaveAccessibleName('Connect key');
  });
});
