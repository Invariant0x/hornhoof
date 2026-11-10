import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Machines } from '../src/screens/Machines';
import type { BuiltinView, Me } from '../src/types';
import { fixedAt, MACHINES, ME, mockApi, SUBS } from './api-mock';

const COMMAND = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join CODE123';
const GIB = 1024 ** 3;
/* An older built-in node, which says nothing of its processor or disk. */
const BUILTIN: BuiltinView = {
  online: true,
  load: { cpus: 4, load: 0.5, memFree: 2.5 * GIB, memTotal: 8 * GIB, tests: 0, jobs: 1 },
  running: { agents: [{ id: 'o1', canOpen: true, name: 'Orchestrator', busy: false, title: null, department: null, provider: 'anthropic_api', since: null, task: null, withCeo: false }], parts: [] },
};

const lists = (extra: Parameters<typeof mockApi>[0] = {}, builtin: BuiltinView | null = BUILTIN) =>
  mockApi({ 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: MACHINES, builtin }], ...extra });

const card = (name: string) => {
  const existing = screen.queryByRole('article', { name });
  if (existing) return existing;
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^(Open the card of |Открыть карточку )${name}$`) }));
  return screen.getByRole('article', { name });
};
const openCard = async (name: string) => {
  await screen.findByRole('table');
  return card(name);
};
const meter = (node: HTMLElement, label: string) => within(node).getByText(label, { selector: '.g-l' }).closest('.gauge')!;

/* The value next to a label in a machine's card or in the pool. */
const fact = (within_: HTMLElement, label: string) => within(within_).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

afterEach(() => localStorage.clear());

describe('Machines', () => {
  it.each([['en', 'Agent programs'], ['ru', 'Программы агентов']])('shows reported program versions on the machine card in %s', async (language, heading) => {
    localStorage.setItem('hh-lang', language);
    lists({ 'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, programs: [{ id: 'claude', version: '2.1.0', updating: false, failed: false }] }], builtin: null }] });
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    const mac = await openCard('ivan-mbp');
    expect(within(mac).getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(fact(mac, 'Claude Code')).toBe('2.1.0');
  });

  it('retains an active add-plan command after refreshing program versions', async () => {
    const command = { id: '3'.repeat(64), kind: 'add', plans: ['Kimi'], machineId: 'm1', machine: 'ivan-mbp', command: `${COMMAND}-ADD`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    const calls = lists({
      'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, programs: [{ id: 'claude', version: '2.1.0', updating: false, failed: false }] }], builtin: null }],
      'GET /api/nodes/commands': [200, { commands: [command] }],
      'POST /api/machines/m1/programs/update': [202, { updating: true }],
    });
    render(<Machines me={ME} />);
    const mac = await screen.findByRole('article', { name: 'ivan-mbp' });
    expect(await within(mac).findByText(command.command)).toBeInTheDocument();
    const update = within(mac).getByRole('button', { name: 'Update programs' });
    await userEvent.setup().click(update);
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'GET' && c.path === '/api/nodes/commands').length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(update).toBeEnabled());
    expect(within(mac).getByText(command.command)).toBeInTheDocument();
    expect(calls.some(c => c.path.endsWith('/hide'))).toBe(false);
  });

  it('updates programs on the virtual built-in card through its own action', async () => {
    const calls = lists({ 'POST /api/machines/builtin/programs/update': [202, { updating: true }] },
      { ...BUILTIN, programs: [{ id: 'codex', version: '3.0.0', updating: false, failed: false }] });
    render(<Machines me={ME} />);
    const builtin = await openCard('Built-in node');
    await userEvent.setup().click(within(builtin).getByRole('button', { name: 'Update programs' }));
    expect(calls).toContainEqual({ method: 'POST', path: '/api/machines/builtin/programs/update', body: undefined });
  });

  it.each([
    ['en', 'Priority', 'The company server runs here', 'Built-in node'],
    ['ru', 'Приоритет', 'Здесь работает сервер компании', 'Встроенная нода'],
  ])('shows read-only priority on the joined server machine only in %s', async (language, title, line, builtinName) => {
    localStorage.setItem('hh-lang', language);
    let joined = true;
    lists({ 'GET /api/machines': () => [200, { machines: MACHINES, builtin: { ...BUILTIN, machine: joined ? { id: 'm1', hostname: 'ivan-mbp' } : null } }] });
    const view = render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    const mac = await openCard('ivan-mbp');
    const priority = within(mac).getByRole('heading', { name: title }).closest('section')!;
    expect(priority.textContent).toBe(`${title}1${line}`);
    expect(priority.querySelector('button, input, select')).toBeNull();
    expect(within(card('build-box')).queryByRole('heading', { name: title })).not.toBeInTheDocument();
    view.unmount();
    joined = false;
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await openCard(builtinName);
    card('ivan-mbp');
    card('build-box');
    expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument();
  });

  it.each([
    ['en', 'Ivan, limit reached until ', 'Ivan, waiting for the login', 'No plans on this machine yet'],
    ['ru', 'Ivan, лимит исчерпан до ', 'Ivan, ждет входа', 'На этой машине пока нет подписок'],
  ])('lists plans with their local states and empty text in %s', async (language, limited, login, empty) => {
    localStorage.setItem('hh-lang', language);
    const limits = { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: new Date(Date.now() + 80 * 60_000).toISOString() }] };
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, tier: 'Max', limits }, ...SUBS.slice(1)] }] });
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    const mac = await openCard('ivan-mbp');
    const plans = mac.querySelector('.plist')!;
    expect(within(plans as HTMLElement).getAllByRole('listitem').map(item => item.querySelector('.nm')?.textContent)).toEqual([
      expect.stringMatching(new RegExp(`^Claude Max${limited}`)), `Codex${login}`,
    ]);
    expect(within(card('build-box')).getByText(empty)).toBeInTheDocument();
  });

  it('shows the whole pool: machines online of all, processor cores, free memory and how busy it is now', async () => {
    lists();
    render(<Machines me={ME} />);
    const pool = await screen.findByRole('region', { name: 'All machines together' });
    expect(fact(pool, 'Machines online')).toBe('2 of 3');
    expect(fact(pool, 'Processor cores')).toBe('12');
    expect(fact(pool, 'Free memory')).toBe('8.5 of 20 GB');
    expect(fact(pool, 'Busy now')).toBe('21%');
  });

  it('shows each machine with its owner, system, processor, memory, load and disk', async () => {
    lists();
    render(<Machines me={ME} />);
    const mac = await openCard('ivan-mbp');
    expect(within(mac).getByText('Online')).toBeInTheDocument();
    expect(fact(mac, 'Owner')).toBe('Ivan');
    expect(fact(mac, 'System')).toBe('macOS, arm64');
    expect(meter(mac, 'Processor').textContent).toBe('Processor8 coresApple M2 Pro, the machine has 10');
    expect(meter(mac, 'Processor').querySelector('b')).toHaveTextContent(/^8$/);
    expect(meter(mac, 'Memory').textContent).toBe('Memory6GB freeof 12 GB, the machine has 32 GB');
    expect(within(mac).getByText('Docker on this Mac is set smaller than the Mac, so Hornhoof uses only part of it.')).toBeInTheDocument();
    expect(meter(mac, 'Load').querySelector('b')?.textContent).toBe('25%');
    expect(meter(mac, 'Disk').textContent).toBe('Disk120GB freeof 460 GB');
    expect(within(mac).getByRole('heading', { name: 'Plans on this machine' })).toBeInTheDocument();
    expect(fact(mac, 'Test runs')).toContain('Lend to test runs');
  });

  it('does not draw an invalid resource bar when a node reports zero total memory or disk', async () => {
    lists({}, { ...BUILTIN, load: { ...BUILTIN.load!, memFree: 0, memTotal: 0, diskFree: 0, diskTotal: 0 } });
    render(<Machines me={ME} />);
    const own = await openCard('Built-in node');
    expect(meter(own, 'Memory').querySelector('.bar i')).not.toBeInTheDocument();
    expect(meter(own, 'Disk').querySelector('.bar i')).not.toBeInTheDocument();
  });

  it('says what runs on a machine now: its employees and the parts of test runs', async () => {
    fixedAt();
    lists();
    render(<Machines me={ME} />);
    const mac = await openCard('ivan-mbp');
    const now = within(mac).getByRole('region', { name: 'What runs on ivan-mbp now' });
    expect(within(now).getByRole('region', { name: 'Development' })).toHaveTextContent('Bruno');
    expect(within(now).getByTitle('Checkout API')).toHaveTextContent('#12');
    expect(within(now).getByText('12 min')).toBeInTheDocument();
    expect(within(now).getByText('Started by Bruno')).toBeInTheDocument();
    expect(now.querySelectorAll('.segs i')).toHaveLength(2);
    expect(now.querySelectorAll('.segs i.here')).toHaveLength(1);
    expect(within(now).getByRole('region', { name: 'Test runs' })).toHaveTextContent('Tests of task 12, part 1 of 2');
    expect(within(card('build-box')).getByText('Nothing, the machine is offline.')).toBeInTheDocument();
  });

  it('says unknown for what an offline or older machine has not told', async () => {
    fixedAt();
    lists();
    render(<Machines me={ME} />);
    const box = await openCard('build-box');
    expect(within(box).getByText('Last seen 5 minutes ago')).toBeInTheDocument();
    expect(fact(box, 'System')).toBe('Linux, x86_64');
    expect(within(box).getByText('Not known while the machine is offline.')).toBeInTheDocument();
    expect(within(box).queryByText('No plan')).not.toBeInTheDocument();
    const own = card('Built-in node');
    expect(meter(own, 'Processor').querySelector('.g-f')?.textContent).toBe('4 cores');
    expect(meter(own, 'Memory').textContent).toBe('Memory2.5GB freeof 8 GB');
    expect(meter(own, 'Disk').querySelector('b')?.textContent).toBe('unknown');
    expect(within(own).getAllByRole('button')).toEqual([
      within(own).getByRole('button', { name: 'Update programs' }),
      within(own).getByRole('button', { name: 'Open Orchestrator' }),
    ]);
    expect(within(own).getByRole('button', { name: 'Update programs' })).toBeDisabled();
    expect(within(own).getByTitle('The company server runs on this machine now')).toHaveTextContent('Company server here');
    expect(within(box).queryByText('Company server here')).not.toBeInTheDocument();
  });

  /* The server on a computer that joined as a machine too: one computer, one card. */
  it('shows the machine the built-in node runs on as one card, with what runs on either', async () => {
    lists({}, { ...BUILTIN, machine: { id: 'm1', hostname: 'ivan-mbp' } });
    render(<Machines me={ME} />);
    const pool = await screen.findByRole('region', { name: 'All machines together' });
    expect(fact(pool, 'Machines online')).toBe('1 of 2');
    expect(fact(pool, 'Processor cores')).toBe('8');
    expect(fact(pool, 'Free memory')).toBe('6 of 12 GB');
    expect(fact(pool, 'Busy now')).toBe('25%');
    const mac = card('ivan-mbp');
    expect(mac.querySelector('.machine')).toHaveClass('accent');
    expect(mac.querySelector('.corner')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'Open the card of ivan-mbp' })).getByTitle('The company server runs on this machine now')).toHaveTextContent('Company server here');
    expect(within(screen.getByRole('row', { name: 'build-box' })).queryByTitle('The company server runs on this machine now')).not.toBeInTheDocument();
    expect(within(mac).getByText("The server runs here too, with its built-in node for the company's keys and test runs.")).toBeInTheDocument();
    expect(within(within(mac).getByRole('region', { name: 'What runs on ivan-mbp now' })).getByText('Orchestrator')).toBeInTheDocument();
    expect(screen.getAllByRole('row').filter(r => r.classList.contains('rm'))).toHaveLength(2);
    expect(within(card('build-box')).queryByText(/built-in node/)).not.toBeInTheDocument();
    expect(within(mac).getByTitle('The company server runs on this machine now')).toHaveTextContent('Company server here');
    expect(within(card('build-box')).queryByText('Company server here')).not.toBeInTheDocument();
  });

  it('keeps machine notes ahead of built-in notes and uses built-in resources when its machine has none', async () => {
    const machine = { ...MACHINES[0]!, online: false, load: null, browserError: 'machine browser reason', drain: { state: 'restarting' as const, since: '2026-11-04T17:00:00.000Z' } };
    lists({ 'GET /api/machines': [200, { machines: [machine], builtin: { ...BUILTIN, machine: { id: machine.id, hostname: machine.hostname }, browserError: 'builtin browser reason', drain: { state: 'postponed', turnsLeft: 2, partsLeft: 0, retryAt: '2026-11-04T18:00:00.000Z' } } }] });
    render(<Machines me={ME} />);
    const mac = await openCard('ivan-mbp');
    expect(fact(await screen.findByRole('region', { name: 'All machines together' }), 'Machines online')).toBe('1 of 1');
    expect(meter(mac, 'Processor')).toHaveTextContent('4 cores');
    expect(within(mac).getByText('Online', { selector: '.status' })).toBeInTheDocument();
    expect(within(mac).getByText(/machine browser reason/, { selector: 'p' })).toBeInTheDocument();
    expect(within(mac).queryByText(/builtin browser reason/)).not.toBeInTheDocument();
    expect(within(mac).getByText('Updating now: the machine restarts and takes work again by itself')).toBeInTheDocument();
    expect(within(mac).queryByText(/update is postponed/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('row').filter(r => r.classList.contains('rm'))).toHaveLength(1);
  });

  it('counts server work once when the joined machine already includes it in map order', async () => {
    const merged = { ...MACHINES[0]!, running: { agents: [...BUILTIN.running.agents, ...MACHINES[0]!.running.agents], parts: MACHINES[0]!.running.parts } };
    lists({ 'GET /api/machines': [200, { machines: [merged], builtin: { ...BUILTIN, machine: { id: merged.id, hostname: merged.hostname } } }] });
    render(<Machines me={ME} />);
    const running = within(await openCard('ivan-mbp')).getByRole('region', { name: 'What runs on ivan-mbp now' });
    expect(within(running).getByText('3 agents, 1 working, 1 test run')).toBeInTheDocument();
    expect(within(running).getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['Company', 'Development', 'Test runs']);
    expect(within(running).getAllByText('Orchestrator')).toHaveLength(1);
  });

  it('shows no built-in node and no pool part of it to those who do not see the whole company', async () => {
    lists({}, null);
    const lead: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };
    render(<Machines me={lead} />);
    const pool = await screen.findByRole('region', { name: 'All machines together' });
    expect(fact(pool, 'Machines online')).toBe('1 of 2');
    expect(screen.queryByRole('article', { name: 'Built-in node' })).not.toBeInTheDocument();
  });

  it('shows one table row per machine and toggles cards independently from any cell', async () => {
    lists();
    render(<Machines me={ME} />);
    await screen.findByRole('table');
    expect(screen.getAllByRole('row').filter(r => r.classList.contains('rm'))).toHaveLength(3);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('row', { name: 'ivan-mbp' })).getByText('Ivan'));
    expect(screen.getByRole('button', { name: 'Open the card of ivan-mbp' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of build-box' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of ivan-mbp' }));
    expect(screen.queryByRole('article', { name: 'ivan-mbp' })).not.toBeInTheDocument();
  });

  it('keeps a card and its row order through the five second refresh and sorts unknown loads last both ways', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    let calls = 0;
    lists({ 'GET /api/machines': () => [200, { machines: ++calls === 1 ? MACHINES : MACHINES.map(m => ({ ...m, online: !m.online })), builtin: BUILTIN }] });
    render(<Machines me={ME} />);
    const mac = await openCard('ivan-mbp');
    const order = () => screen.getAllByRole('row').filter(r => r.classList.contains('rm')).map(r => r.getAttribute('aria-label'));
    const before = order();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(order()).toEqual(before);
    expect(screen.getByRole('article', { name: 'ivan-mbp' })).toBe(mac);
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of ivan-mbp' }));
    expect(order()[0]).toBe('build-box');
    const load = within(screen.getByRole('columnheader', { name: 'Load' })).getByRole('button');
    await userEvent.click(load);
    expect(load.closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(order().at(-1)).toBe('ivan-mbp');
    await userEvent.click(load);
    expect(load.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    expect(order().at(-1)).toBe('ivan-mbp');
  });

  it('connects a machine without a plan and shows its command', async () => {
    const id = 'm'.repeat(64);
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const calls = lists({
      'POST /api/machines/command': [201, { id, command: COMMAND, expiresAt }],
      [`POST /api/nodes/commands/${id}/hide`]: [204],
    });
    const user = userEvent.setup();
    render(<Machines me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Connect a machine' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/machines/command', body: undefined });
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();
    expect(screen.getByText(/joins without a plan/)).toBeInTheDocument();
    expect(screen.getByText("Hornhoof will run tests of the company's code on this machine. People with access to this Hornhoof can start them.")).toBeInTheDocument();
    expect(screen.getByText(/^Valid for (59 more minutes|1 more hour)\.$/)).toBeInTheDocument();
    expect(screen.getByText('The command works once. The nodes keep running in the background after the terminal is closed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls).toContainEqual({ method: 'POST', path: `/api/nodes/commands/${id}/hide`, body: undefined });
    expect(screen.queryByText(COMMAND)).not.toBeInTheDocument();
  });

  it("adds one of the person's plans to a machine of theirs and shows the command to run there", async () => {
    const id = 'a'.repeat(64);
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const calls = lists({
      'POST /api/machines/m1/plans': [201, { id, command: COMMAND, expiresAt }],
      [`POST /api/nodes/commands/${id}/hide`]: [204],
    });
    const user = userEvent.setup();
    render(<Machines me={ME} />);
    const mac = await openCard('ivan-mbp');
    expect(within(card('build-box')).queryByRole('button', { name: /^Add my plan/ })).not.toBeInTheDocument();
    await user.click(within(mac).getByRole('button', { name: 'Add my plan to ivan-mbp' }));
    expect(screen.getByText('Which of your plans should run on ivan-mbp too?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Claude to ivan-mbp' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add Kimi to ivan-mbp' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/machines/m1/plans', body: { subscription: 's-kimi' } });
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();
    expect(screen.getByText(/^Run this in a terminal on ivan-mbp\./)).toBeInTheDocument();
    expect(within(mac).getByText(/^Valid for (59 more minutes|1 more hour)\.$/)).toBeInTheDocument();
    expect(within(mac).getByText('The command works once. The nodes keep running in the background after the terminal is closed.')).toBeInTheDocument();
    expect(within(mac).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    await user.click(within(mac).getByRole('button', { name: 'Cancel' }));
    expect(calls).toContainEqual({ method: 'POST', path: `/api/nodes/commands/${id}/hide`, body: undefined });
    expect(screen.queryByText(COMMAND)).not.toBeInTheDocument();
  });

  it('keeps machine and add-plan commands visible across tab switches and reloads with expiry, Copy and Cancel, and removes them on join, expiry or Cancel', async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const machineCmd = { id: '1'.repeat(64), kind: 'machine' as const, plans: [], machineId: null, machine: null, command: `${COMMAND}-MACHINE`, expiresAt };
    const addCmd = { id: '2'.repeat(64), kind: 'add' as const, plans: ['Kimi'], machineId: 'm1', machine: 'ivan-mbp', command: `${COMMAND}-ADD`, expiresAt };
    let active = [machineCmd, addCmd];
    const calls = lists({
      'GET /api/nodes/commands': () => [200, { commands: active }],
      [`POST /api/nodes/commands/${machineCmd.id}/hide`]: () => {
        active = active.filter(c => c.id !== machineCmd.id);
        return [204];
      },
      [`POST /api/nodes/commands/${addCmd.id}/hide`]: () => {
        active = active.filter(c => c.id !== addCmd.id);
        return [204];
      },
    });
    const user = userEvent.setup();
    const first = render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    expect(await screen.findByText(machineCmd.command)).toBeInTheDocument();
    expect(await screen.findByText(addCmd.command)).toBeInTheDocument();

    /* Switching tabs and returning, or reloading the page, keeps both commands visible. */
    first.unmount();
    localStorage.setItem('hh-lang', 'ru');
    const inRu = render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    expect(await screen.findByText(machineCmd.command)).toBeInTheDocument();
    expect(await screen.findByText(addCmd.command)).toBeInTheDocument();
    expect(screen.getAllByText(/^Действует еще (59 мин|1 ч)\.$/)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Копировать' })).toHaveLength(2);
    const cancels = screen.getAllByRole('button', { name: 'Отменить' });
    expect(cancels).toHaveLength(2);
    await user.click(cancels[0]!);
    expect(calls).toContainEqual({ method: 'POST', path: `/api/nodes/commands/${machineCmd.id}/hide`, body: undefined });
    await vi.waitFor(() => expect(screen.queryByText(machineCmd.command)).not.toBeInTheDocument());
    expect(screen.getByText(addCmd.command)).toBeInTheDocument();

    /* After the machine joins by the add-plan command or it expires, reload hides it too. */
    active = [];
    inRu.unmount();
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await screen.findByRole('table');
    expect(screen.queryByText(addCmd.command)).not.toBeInTheDocument();
  });

  it('disconnects a machine after a confirm', async () => {
    const calls = lists({ 'POST /api/machines/m2/disconnect': [204] });
    const user = userEvent.setup();
    render(<Machines me={ME} />);
    await user.click(within(await openCard('build-box')).getByRole('button', { name: 'Disconnect build-box' }));
    expect(screen.getByText('Disconnect build-box? Everything on it stops, and a plan that runs nowhere else waits for a machine again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/machines/m2/disconnect', body: undefined });
  });

  it("lends a machine to the company's test runs, or takes it back, for its owner or someone who sees the whole company", async () => {
    const calls = lists({ 'PATCH /api/machines/m1': [200, { lendsTests: false }] });
    const user = userEvent.setup();
    render(<Machines me={ME} />);
    const lend = within(await openCard('ivan-mbp')).getByRole('checkbox', { name: "Lend ivan-mbp to the company's test runs" });
    expect(lend).toBeChecked();
    expect(within(card('build-box')).getByRole('checkbox')).not.toBeChecked();
    await user.click(lend);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/machines/m1', body: { lendsTests: false } }));
  });

  it("shows another person's machine as lent or not, without the switch", async () => {
    lists({}, null);
    const lead: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };
    render(<Machines me={lead} />);
    const maria = await openCard('build-box');
    expect(within(maria).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(maria).getByText('Not lent to test runs')).toBeInTheDocument();
    expect(within(card('ivan-mbp')).getByRole('checkbox')).toBeChecked();
  });

  it.each([
    ['en', 'Other build', "Its nodes are not the server's build (3fe094e here, 8de55ce on the server). To update them, run the install command on it again without --join.", "Its nodes are not the server's build (an older one here, 8de55ce on the server). To update them, run the install command on it again without --join."],
    ['ru', 'Другая сборка', 'Ее ноды не той сборки, что у сервера (здесь 3fe094e, у сервера 8de55ce). Чтобы обновить их, выполните на ней команду установки еще раз без --join.', 'Ее ноды не той сборки, что у сервера (здесь старая, у сервера 8de55ce). Чтобы обновить их, выполните на ней команду установки еще раз без --join.'],
  ])('marks a machine whose nodes are not the server build, in its row and its card, and no other, in %s', async (language, mark, note, older) => {
    localStorage.setItem('hh-lang', language);
    const server = '8de55ce'.padEnd(40, '0');
    let nodes: (string | null)[] = ['3fe094e'.padEnd(40, '1')];
    lists({ 'GET /api/machines': () => [200, { machines: [{ ...MACHINES[0]!, otherBuild: { server, nodes } }, { ...MACHINES[1]!, otherBuild: null }], builtin: BUILTIN }] });
    const view = render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await screen.findByRole('table');
    expect(within(screen.getByRole('row', { name: 'ivan-mbp' })).getByTitle(note)).toHaveTextContent(mark);
    expect(within(screen.getByRole('row', { name: 'build-box' })).queryByText(mark)).not.toBeInTheDocument();
    const mac = card('ivan-mbp');
    expect(within(mac).getByText(note, { selector: 'p' })).toBeInTheDocument();
    expect(within(card('build-box')).queryByText(mark)).not.toBeInTheDocument();
    /* A node from before builds says none. */
    view.unmount();
    nodes = [null];
    const again = render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await screen.findByRole('table');
    expect(within(screen.getByRole('row', { name: 'ivan-mbp' })).getByTitle(older)).toHaveTextContent(mark);
    /* Two nodes of two builds name both. */
    again.unmount();
    nodes = ['3fe094e'.padEnd(40, '1'), null];
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await screen.findByRole('table');
    expect(within(screen.getByRole('row', { name: 'ivan-mbp' })).getByTitle(note.replace('3fe094e', `3fe094e, ${language === 'en' ? 'an older one' : 'старая'}`))).toHaveTextContent(mark);
  });

  it.each([
    ['en', 'Browser failed', 'The browser for checks did not start (libnss3.so missing). Run the install command on this machine again without --join, or check the node logs.', 'Built-in node', 'Plans'],
    ['ru', 'Браузер не запустился', 'Браузер для проверок не запустился (libnss3.so missing). Выполните на этой машине команду установки еще раз без --join или посмотрите журнал ноды.', 'Встроенная нода', 'Подписки'],
  ])('marks a machine whose browser check failed with the named reason in its row and its card in %s', async (language, mark, note, builtinName, plansHeader) => {
    localStorage.setItem('hh-lang', language);
    const offlineWithPlan = { ...MACHINES[1]!, id: 'm3', hostname: 'spare-box', plans: [{ id: 's-kimi', provider: 'kimi' as const, status: 'ready' as const, online: true }] };
    const macPlans = [...MACHINES[0]!.plans, { id: 's-glm', provider: 'glm' as const, status: 'ready' as const, online: false }];
    lists({ 'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, plans: macPlans, browserError: 'libnss3.so missing' }, { ...MACHINES[1]!, browserError: null }, offlineWithPlan], builtin: { ...BUILTIN, browserError: 'libnss3.so missing' } }] });
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await screen.findByRole('table');
    const row = screen.getByRole('row', { name: 'ivan-mbp' });
    expect(within(row).getByTitle(note)).toHaveTextContent(mark);
    const marks = row.querySelectorAll('.marks > span');
    expect(marks[0]).not.toHaveClass('dim');
    expect(marks[1]).toHaveClass('dim');
    expect(marks[2]).toHaveClass('dim');
    expect(screen.getByRole('row', { name: 'spare-box' }).querySelector('.marks > span')).toHaveClass('dim');
    expect(screen.getByRole('row', { name: 'build-box' }).querySelector('.marks')).toHaveTextContent(/^0$/);
    expect(within(screen.getByRole('row', { name: 'build-box' })).queryByText(mark)).not.toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: builtinName })).getByTitle(note)).toHaveTextContent(mark);
    expect(within(card('ivan-mbp')).getByText(note, { selector: 'p' })).toBeInTheDocument();
    const plansSort = within(screen.getByRole('columnheader', { name: plansHeader })).getByRole('button');
    await userEvent.click(plansSort);
    expect(plansSort.closest('th')).toHaveAttribute('aria-sort', 'descending');
    const order = screen.getAllByRole('row').filter(r => r.classList.contains('rm')).map(r => r.getAttribute('aria-label'));
    expect(order[0]).toBe('ivan-mbp');
    expect(order.at(-1)).toBe('build-box');
  });

  it('marks no machine when the server does not tell builds apart', async () => {
    lists();
    render(<Machines me={ME} />);
    await screen.findByRole('table');
    expect(screen.queryByText('Other build')).not.toBeInTheDocument();
  });

  it('shows the machines in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    lists();
    render(
      <LanguageProvider>
        <Machines me={ME} />
      </LanguageProvider>,
    );
    const pool = await screen.findByRole('region', { name: 'Все машины вместе' });
    expect(fact(pool, 'Машин в сети')).toBe('2 из 3');
    expect(fact(pool, 'Свободно памяти')).toBe('8,5 из 20 ГБ');
    const mac = card('ivan-mbp');
    expect(meter(mac, 'Процессор').textContent).toBe('Процессор8 ядерApple M2 Pro, у машины 10');
    expect(meter(mac, 'Память').textContent).toBe('Память6ГБ свободноиз 12 ГБ, у машины 32 ГБ');
    expect(within(mac).getByText('Docker на этом Mac настроен меньше самого Mac, поэтому Hornhoof использует только часть.')).toBeInTheDocument();
    expect(meter(mac, 'Диск').textContent).toBe('Диск120ГБ свободноиз 460 ГБ');
    expect(within(mac).getByRole('region', { name: 'Что сейчас идет на ivan-mbp' })).toHaveTextContent('Тесты задачи 12, часть 1 из 2');
    expect(within(card('build-box')).getByText('Неизвестно, пока машина не в сети.')).toBeInTheDocument();
    expect(meter(card('Встроенная нода'), 'Процессор').querySelector('.g-f')).toHaveTextContent('4 ядра');
    expect(within(screen.getByRole('group', { name: 'Тесты' })).getByRole('button', { name: /^Отдана под тесты/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Подключить машину' })).toBeInTheDocument();
    expect(within(mac).getByRole('button', { name: 'Добавить мою подписку на ivan-mbp' })).toBeInTheDocument();
    expect(within(mac).getByRole('checkbox', { name: 'Отдавать ivan-mbp под прогоны тестов компании' })).toBeChecked();
  });

  it('says in Russian that the server runs on a machine that joined', async () => {
    localStorage.setItem('hh-lang', 'ru');
    lists({}, { ...BUILTIN, machine: { id: 'm1', hostname: 'ivan-mbp' } });
    render(
      <LanguageProvider>
        <Machines me={ME} />
      </LanguageProvider>,
    );
    expect(fact(await screen.findByRole('region', { name: 'Все машины вместе' }), 'Машин в сети')).toBe('1 из 2');
    expect(within(card('ivan-mbp')).getByText('Здесь же работает сервер и его встроенная нода: ключи компании и прогоны тестов.')).toBeInTheDocument();
    expect(within(card('ivan-mbp')).getByTitle('Сервер компании сейчас работает на этой машине')).toHaveTextContent('Здесь сервер компании');
    expect(within(card('build-box')).queryByText('Здесь сервер компании')).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Встроенная нода' })).not.toBeInTheDocument();
  });
  it('searches agents, roles, departments and machine names, with counts, clear and no matches', async () => {
    lists();
    render(<Machines me={ME} />);
    expect(await screen.findByText('3 machines')).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search' });
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of ivan-mbp' }));
    for (const query of ['BRUNO', 'Backend engineer', 'Development', 'ivan-mbp']) {
      await userEvent.clear(search);
      await userEvent.type(search, query);
      expect(screen.getByText('Showing 1 of 3')).toBeInTheDocument();
      expect(screen.getByRole('article', { name: 'ivan-mbp' })).toBeInTheDocument();
    }
    await userEvent.clear(search);
    await userEvent.type(search, 'missing machine');
    expect(screen.getByText('Nothing matches. Change the search or clear the filters.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(search).toHaveValue('');
    expect(screen.getByText('3 machines')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'ivan-mbp' })).toBeInTheDocument();
  });

  it('widens matches inside one filter group and narrows across groups, counting keys by their program', async () => {
    const extra = { ...MACHINES[1]!, plans: [{ id: 'hidden', provider: 'kimi' as const, status: 'ready' as const, online: false }] };
    lists({ 'GET /api/machines': [200, { machines: [MACHINES[0]!, extra], builtin: BUILTIN }] });
    render(<Machines me={ME} />);
    await screen.findByRole('table');
    const provider = screen.getByRole('group', { name: 'Provider' });
    const claude = within(provider).getByRole('button', { name: /Claude.*2/ });
    await userEvent.click(claude);
    expect(claude).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Showing 2 of 3')).toBeInTheDocument();
    await userEvent.click(within(provider).getByRole('button', { name: /Kimi.*1/ }));
    expect(screen.getByText('Showing 3 of 3')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: /^Offline/ }));
    expect(screen.getByText('Showing 1 of 3')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('group', { name: 'Tests' })).getByRole('button', { name: /^Lent to test runs/ }));
    expect(screen.getByText('Showing 0 of 3')).toBeInTheDocument();
  });

  it('keeps search and filters through refreshes and only offers groups with a choice', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    lists({ 'GET /api/machines': [200, { machines: [MACHINES[0]!], builtin: null }] });
    render(<Machines me={ME} />);
    await screen.findByRole('table');
    expect(screen.queryByRole('group', { name: 'Status' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox'), 'Bruno');
    await userEvent.click(within(screen.getByRole('group', { name: 'Tests' })).getByRole('button'));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole('searchbox')).toHaveValue('Bruno');
    expect(within(screen.getByRole('group', { name: 'Tests' })).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Showing 1 of 1')).toBeInTheDocument();
  });

  describe('waiting before an update', () => {
    const at = (hour: number, minute: number) => new Date(2026, 10, 4, hour, minute).toISOString();
    const waiting = (turnsLeft: number, partsLeft = 0) => ({ state: 'waiting' as const, turnsLeft, partsLeft, until: at(21, 30) });
    const postponed = { state: 'postponed' as const, turnsLeft: 2, partsLeft: 0, retryAt: at(22, 5) };
    const restarting = { state: 'restarting' as const, since: at(21, 0) };
    const onMachine = (drain: unknown, over: Partial<(typeof MACHINES)[number]> = {}): [number, unknown] => [200, { machines: [{ ...MACHINES[0]!, ...over, drain }], builtin: null }];
    /* The table's own row, not the row its open card sits in. */
    const macRow = () => screen.getAllByRole('row', { name: 'ivan-mbp' }).find(row => row.getAttribute('aria-label') === 'ivan-mbp')!;

    it.each([
      ['en', 'Waiting for agents to finish before the update: 3 turns left, until 21:30', 'Waiting to update'],
      ['ru', 'Ждет конца работы агентов перед обновлением: осталось 3 хода, до 21:30', 'Ждет обновления'],
    ])('says in the card and the row how many turns are left and until when in %s', async (language, line, mark) => {
      localStorage.setItem('hh-lang', language);
      lists({ 'GET /api/machines': onMachine(waiting(3)) });
      render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
      const mac = await openCard('ivan-mbp');
      expect(within(mac).getByText(line)).toBeInTheDocument();
      expect(within(macRow()).getByText(mark)).toBeInTheDocument();
    });

    it.each([
      ['en', 1, 0, 'Waiting for agents to finish before the update: 1 turn left, until 21:30'],
      ['en', 0, 0, 'Waiting for agents to finish before the update: 0 turns left, until 21:30'],
      ['en', 0, 1, 'Waiting for agents to finish before the update: 1 run part left, until 21:30'],
      ['en', 2, 3, 'Waiting for agents to finish before the update: 2 turns and 3 run parts left, until 21:30'],
      ['ru', 1, 0, 'Ждет конца работы агентов перед обновлением: остался 1 ход, до 21:30'],
      ['ru', 5, 0, 'Ждет конца работы агентов перед обновлением: осталось 5 ходов, до 21:30'],
      ['ru', 0, 1, 'Ждет конца работы агентов перед обновлением: осталась 1 часть прогона, до 21:30'],
      ['ru', 2, 5, 'Ждет конца работы агентов перед обновлением: осталось 2 хода и 5 частей прогона, до 21:30'],
    ])('words the count in %s for %i turns and %i run parts', async (language, turns, parts, line) => {
      localStorage.setItem('hh-lang', language);
      lists({ 'GET /api/machines': onMachine(waiting(turns, parts)) });
      render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
      expect(within(await openCard('ivan-mbp')).getByText(line)).toBeInTheDocument();
    });

    it('follows the count by itself and drops the line when the wait is over', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      onTestFinished(() => { vi.useRealTimers(); });
      let drain: unknown = waiting(3);
      lists({ 'GET /api/machines': () => onMachine(drain) });
      render(<Machines me={ME} />);
      const mac = await openCard('ivan-mbp');
      expect(within(mac).getByText(/3 turns left/)).toBeInTheDocument();
      drain = waiting(1);
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(within(mac).getByText(/1 turn left/)).toBeInTheDocument();
      drain = null;
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(within(mac).queryByText(/before the update/)).not.toBeInTheDocument();
      expect(within(macRow()).queryByText('Waiting to update')).not.toBeInTheDocument();
    });

    it.each([
      ['en', 'The update is postponed: agents did not finish in time. Next try at 22:05', 'Update postponed'],
      ['ru', 'Обновление отложено: агенты не успели закончить работу. Следующая попытка в 22:05', 'Обновление отложено'],
    ])('says an update was postponed and when it tries again in %s', async (language, line, mark) => {
      localStorage.setItem('hh-lang', language);
      lists({ 'GET /api/machines': onMachine(postponed) });
      render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
      const mac = await openCard('ivan-mbp');
      expect(within(mac).getByText(line)).toBeInTheDocument();
      expect(within(macRow()).getByText(mark)).toBeInTheDocument();
    });

    it.each([
      ['en', 'Updating now: the machine restarts and takes work again by itself', 'Updating'],
      ['ru', 'Идет обновление: машина перезапустится и сама снова возьмет работу', 'Обновляется'],
    ])('tells a restart for the update from a lost machine in %s', async (language, line, mark) => {
      localStorage.setItem('hh-lang', language);
      lists({ 'GET /api/machines': onMachine(restarting, { online: false, lastSeenAt: at(20, 59) }) });
      render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
      const mac = await openCard('ivan-mbp');
      expect(within(mac).getByText(line)).toBeInTheDocument();
      expect(within(mac).queryByText(/last seen|был на связи|минут/i)).not.toBeInTheDocument();
      expect(within(macRow()).getByText(mark)).toBeInTheDocument();
    });

    it.each([[null], [undefined]])('says nothing of an update while there is no wait (%s)', async drain => {
      lists({ 'GET /api/machines': onMachine(drain) });
      render(<Machines me={ME} />);
      const mac = await openCard('ivan-mbp');
      expect(within(mac).queryByText(/before the update|postponed|Updating now/)).not.toBeInTheDocument();
      expect(within(macRow()).queryByText('Waiting to update')).not.toBeInTheDocument();
    });

    it('shows the wait of the built-in node on its own card', async () => {
      lists({}, { ...BUILTIN, drain: waiting(2) } as BuiltinView);
      render(<Machines me={ME} />);
      expect(within(await openCard('Built-in node')).getByText(/2 turns left, until 21:30/)).toBeInTheDocument();
      expect(within(card('ivan-mbp')).queryByText(/before the update/)).not.toBeInTheDocument();
    });

    it('shows the wait of the built-in node on the machine it runs on', async () => {
      lists({}, { ...BUILTIN, machine: { id: 'm1', hostname: 'ivan-mbp' }, drain: waiting(2) } as BuiltinView);
      render(<Machines me={ME} />);
      expect(within(await openCard('ivan-mbp')).getByText(/2 turns left, until 21:30/)).toBeInTheDocument();
    });
  });
});
