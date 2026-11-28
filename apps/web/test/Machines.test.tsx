import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LANGUAGES, LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { Machines } from '../src/screens/Machines';
import type { BuiltinView, ComputerAccessView, Me } from '../src/types';
import { accessView, fixedAt, MACHINES, ME, mockApi, SUBS, withKey } from './api-mock';
import { decl } from './css';
import { clock } from '../src/ui/subscription';
import { commandCode } from './command-code';
import { shownTable } from './shown-table';

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
  await shownTable();
  return card(name);
};
const meter = (node: HTMLElement, label: string) => within(node).getByText(label, { selector: '.g-l' }).closest('.gauge')!;

/* The value next to a label in a machine's card or in the pool. */
const fact = (within_: HTMLElement, label: string) => within(within_).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

afterEach(() => localStorage.clear());

it.each(LANGUAGES)('shows phone settings that need attention in $name', async ({ id }) => {
  localStorage.setItem('hh-lang', id);
  const words = { en, ru }[id].phones;
  lists({ 'GET /api/phones': [200, { phones: [{ id: 'p1', name: 'Phone', owner: { id: ME.person.id, name: ME.person.name }, machineId: MACHINES[0]!.id, lending: true, online: true, state: 'available', queued: 0, stopping: false, readiness: ['lock'] }] }] });
  render(<LanguageProvider><Machines me={ME} onHome={() => {}} /></LanguageProvider>);
  const phones = await screen.findByRole('region', { name: words.heading });
  const phone = await within(phones).findByRole('article', { name: 'Phone' });
  expect(within(phone).getByText(words.readiness.lock)).toBeInTheDocument();
  expect(within(phone).queryByText(words.readiness.brightness)).not.toBeInTheDocument();
});

const DAY = 24 * 3600_000;
const endsIn = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const linkWithCertificate = (expiresAt: string) => ({ link: { name: 'acme', url: 'https://acme.hornhoof.org' }, domain: 'hornhoof.org', tls: { mode: 'https', certificate: true, expiresAt, failedAt: null } });

describe('the link certificate warning', () => {
  it('warns 14 days before the link\'s certificate ends', async () => {
    const soon = endsIn(13);
    lists({ 'GET /api/link': [200, linkWithCertificate(soon)] });
    render(<Machines me={ME} />);
    const warning = (await screen.findByText(/The link's certificate ends/)).closest('p')!;
    expect(warning).toHaveClass('alert');
    expect(warning).toHaveAttribute('role', 'status');
    expect(warning).toHaveTextContent(`The link's certificate ends on ${new Date(soon).toLocaleDateString('en')} and has not renewed yet. Hornhoof tries again every hour.`);
    expect(warning).toHaveTextContent('If it ends, the link keeps working, encrypted to hornhoof.org.');
  });

  it('says nothing while the certificate has 15 days left', async () => {
    const calls = lists({ 'GET /api/link': [200, linkWithCertificate(endsIn(15))] });
    render(<Machines me={ME} />);
    await shownTable();
    await vi.waitFor(() => expect(calls.some(c => c.path === '/api/link')).toBe(true));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(screen.queryByText(/The link's certificate ends/)).not.toBeInTheDocument();
  });

  it('warns in Russian with the date in that language', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const soon = endsIn(3);
    lists({ 'GET /api/link': [200, linkWithCertificate(soon)] });
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    expect(await screen.findByText(/Сертификат ссылки заканчивается/)).toHaveTextContent(`Сертификат ссылки заканчивается ${new Date(soon).toLocaleDateString('ru')} и еще не обновился.`);
  });

  it('asks nothing about the link for people who do not see the whole company', async () => {
    const calls = lists();
    render(<Machines me={{ ...ME, person: { ...ME.person, scopeKind: 'listed' } }} />);
    await shownTable();
    expect(calls.some(c => c.path === '/api/link')).toBe(false);
  });
});

describe('Machines', () => {
  it('shows why new checks wait for a previous process to stop', async () => {
    const reason = 'Check group 4242 has not stopped. New checks wait until its processes are gone.';
    lists({ 'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, checkError: reason }], builtin: null }] });
    render(<Machines me={ME} />);
    const mac = await openCard('dev-laptop');
    expect(within(mac).getByText('Checks paused')).toHaveAttribute('title', reason);
    expect(within(mac).getByText(reason)).toBeInTheDocument();
  });

  it.each([['en', 'Agent programs'], ['ru', 'Программы агентов']])('shows reported program versions on the machine card in %s', async (language, heading) => {
    localStorage.setItem('hh-lang', language);
    lists({ 'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, programs: [{ id: 'claude', version: '2.1.0', updating: false, failed: false }] }], builtin: null }] });
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    const mac = await openCard('dev-laptop');
    expect(within(mac).getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(fact(mac, 'Claude Code')).toBe('2.1.0');
  });

  it('retains an active add-plan command after refreshing program versions', async () => {
    const command = { id: '3'.repeat(64), kind: 'add', plans: ['Kimi'], machineId: 'm1', machine: 'dev-laptop', command: `${COMMAND}-ADD`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    const calls = lists({
      'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, programs: [{ id: 'claude', version: '2.1.0', updating: false, failed: false }] }], builtin: null }],
      'GET /api/nodes/commands': [200, { commands: [command] }],
      'POST /api/machines/m1/programs/update': [202, { updating: true }],
    });
    render(<Machines me={ME} />);
    const mac = await screen.findByRole('article', { name: 'dev-laptop' });
    expect(await within(mac).findByText(commandCode(withKey(command.command)))).toBeInTheDocument();
    const update = within(mac).getByRole('button', { name: 'Update programs' });
    await userEvent.setup().click(update);
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'GET' && c.path === '/api/nodes/commands').length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(update).toBeEnabled());
    expect(within(mac).getByText(commandCode(withKey(command.command)))).toBeInTheDocument();
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
    lists({ 'GET /api/machines': () => [200, { machines: MACHINES, builtin: { ...BUILTIN, machine: joined ? { id: 'm1', hostname: 'dev-laptop' } : null } }] });
    const view = render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    const mac = await openCard('dev-laptop');
    const priority = within(mac).getByRole('heading', { name: title }).closest('section')!;
    expect(priority.textContent).toBe(`${title}1${line}`);
    expect(priority.querySelector('button, input, select')).toBeNull();
    expect(within(card('build-box')).queryByRole('heading', { name: title })).not.toBeInTheDocument();
    view.unmount();
    joined = false;
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await openCard(builtinName);
    card('dev-laptop');
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
    const mac = await openCard('dev-laptop');
    const plans = mac.querySelector('.plist')!;
    expect(within(plans as HTMLElement).getAllByRole('listitem').map(item => item.querySelector('.nm')?.textContent)).toEqual([
      expect.stringMatching(new RegExp(`^Claude Max${limited}`)), `Codex${login}`,
    ]);
    expect(within(card('build-box')).getByText(empty)).toBeInTheDocument();
  });

  it('holds the pool and the table head while the machines come, both busy, and fills them once they came', async () => {
    let finish!: (reply: [number, unknown]) => void;
    lists({ 'GET /api/machines': () => new Promise(resolve => { finish = resolve; }) });
    render(<Machines me={ME} />);
    expect(screen.getByRole('region', { name: 'All machines together', busy: true })).toBeInTheDocument();
    expect(screen.getByRole('table').closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    await act(async () => { finish([200, { machines: MACHINES, builtin: BUILTIN }]); });
    expect(within(await shownTable()).getByRole('button', { name: /^Open the card of dev-laptop$/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'All machines together', busy: false })).toBeInTheDocument();
  });

  it('shows the whole pool: machines online of all, processor cores, free memory and how busy it is now', async () => {
    lists();
    render(<Machines me={ME} />);
    const pool = await screen.findByRole('region', { name: 'All machines together', busy: false });
    expect(fact(pool, 'Machines online')).toBe('2 of 3');
    expect(fact(pool, 'Processor cores')).toBe('12');
    expect(fact(pool, 'Free memory')).toBe('8.5 of 20 GB');
    expect(fact(pool, 'Busy now')).toBe('21%');
  });

  it('shows each machine with its owner, system, processor, memory, load and disk', async () => {
    lists();
    render(<Machines me={ME} />);
    const mac = await openCard('dev-laptop');
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

  it("sets apart only the percent sign of the pool's and the card's shares, to take the text font", async () => {
    lists();
    render(<Machines me={ME} />);
    const pool = await screen.findByRole('region', { name: 'All machines together', busy: false });
    const mac = await openCard('dev-laptop');
    const signs = (node: Element | null | undefined) => [...(node?.querySelectorAll('.pct') ?? [])].map(n => n.textContent);
    const busy = within(pool).getByText('Busy now', { selector: 'dt' }).nextElementSibling;
    const load = meter(mac, 'Load').querySelector('.g-f b');
    expect([busy?.textContent, signs(busy)]).toEqual(['21%', ['%']]);
    expect([load?.textContent, signs(load)]).toEqual(['25%', ['%']]);
    expect(signs(within(pool).getByText('Processor cores', { selector: 'dt' }).nextElementSibling)).toEqual([]);
    expect(signs(meter(mac, 'Memory'))).toEqual([]);
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
    const mac = await openCard('dev-laptop');
    const now = within(mac).getByRole('region', { name: 'What runs on dev-laptop now' });
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
    expect(within(box).getByText('No recent resource readings.')).toBeInTheDocument();
    expect(within(box).queryByText('No plan')).not.toBeInTheDocument();
    const own = card('Built-in node');
    expect(meter(own, 'Processor').querySelector('.g-f')?.textContent).toBe('4 cores');
    expect(meter(own, 'Memory').textContent).toBe('Memory2.5GB freeof 8 GB');
    expect(meter(own, 'Disk').querySelector('b')?.textContent).toBe('unknown');
    /* The programs stand in the block at the bottom of the card (#1027), under what runs on it. */
    expect(within(own).getAllByRole('button')).toEqual([
      within(own).getByRole('button', { name: 'Open Orchestrator' }),
      within(own).getByRole('button', { name: 'Update programs' }),
    ]);
    expect(within(own).getByRole('button', { name: 'Update programs' })).toBeDisabled();
    expect(within(own).getByTitle('The company server runs on this machine now')).toHaveTextContent('Company server here');
    expect(within(box).queryByText('Company server here')).not.toBeInTheDocument();
  });

  /* The server on a computer that joined as a machine too: one computer, one card. */
  it('shows the machine the built-in node runs on as one card, with what runs on either', async () => {
    lists({}, { ...BUILTIN, machine: { id: 'm1', hostname: 'dev-laptop' } });
    render(<Machines me={ME} />);
    const pool = await screen.findByRole('region', { name: 'All machines together', busy: false });
    expect(fact(pool, 'Machines online')).toBe('1 of 2');
    expect(fact(pool, 'Processor cores')).toBe('8');
    expect(fact(pool, 'Free memory')).toBe('6 of 12 GB');
    expect(fact(pool, 'Busy now')).toBe('25%');
    const mac = card('dev-laptop');
    expect(mac.querySelector('.machine')).toHaveClass('accent');
    expect(mac.querySelector('.corner')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'Open the card of dev-laptop' })).getByTitle('The company server runs on this machine now')).toHaveTextContent('Company server here');
    expect(within(screen.getByRole('row', { name: 'build-box' })).queryByTitle('The company server runs on this machine now')).not.toBeInTheDocument();
    expect(within(mac).getByText("The server runs here too, with its built-in node for the company's keys and test runs.")).toBeInTheDocument();
    expect(within(within(mac).getByRole('region', { name: 'What runs on dev-laptop now' })).getByText('Orchestrator')).toBeInTheDocument();
    expect(screen.getAllByRole('row').filter(r => r.classList.contains('rm'))).toHaveLength(2);
    expect(within(card('build-box')).queryByText(/built-in node/)).not.toBeInTheDocument();
    expect(within(mac).getByTitle('The company server runs on this machine now')).toHaveTextContent('Company server here');
    expect(within(card('build-box')).queryByText('Company server here')).not.toBeInTheDocument();
  });

  it('keeps machine notes ahead of built-in notes and uses built-in resources when its machine has none', async () => {
    const machine = { ...MACHINES[0]!, online: false, load: null, browserError: 'machine browser reason', drain: { state: 'restarting' as const, since: '2026-11-04T17:00:00.000Z' } };
    lists({ 'GET /api/machines': [200, { machines: [machine], builtin: { ...BUILTIN, machine: { id: machine.id, hostname: machine.hostname }, browserError: 'builtin browser reason', drain: { state: 'waiting', turnsLeft: 2, partsLeft: 0, since: '2026-11-04T18:00:00.000Z' } } }] });
    render(<Machines me={ME} />);
    const mac = await openCard('dev-laptop');
    expect(fact(await screen.findByRole('region', { name: 'All machines together', busy: false }), 'Machines online')).toBe('1 of 1');
    expect(meter(mac, 'Processor')).toHaveTextContent('4 cores');
    expect(within(mac).getByText('Online', { selector: '.status' })).toBeInTheDocument();
    expect(within(mac).getByText(/machine browser reason/, { selector: 'p' })).toBeInTheDocument();
    expect(within(mac).queryByText(/builtin browser reason/)).not.toBeInTheDocument();
    expect(within(mac).getByText('Updating now: the machine restarts and takes work again by itself')).toBeInTheDocument();
    expect(within(mac).queryByText(/before the update/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('row').filter(r => r.classList.contains('rm'))).toHaveLength(1);
  });

  it('counts server work once when the joined machine already includes it in map order', async () => {
    const merged = { ...MACHINES[0]!, running: { agents: [...BUILTIN.running.agents, ...MACHINES[0]!.running.agents], parts: MACHINES[0]!.running.parts } };
    lists({ 'GET /api/machines': [200, { machines: [merged], builtin: { ...BUILTIN, machine: { id: merged.id, hostname: merged.hostname } } }] });
    render(<Machines me={ME} />);
    const running = within(await openCard('dev-laptop')).getByRole('region', { name: 'What runs on dev-laptop now' });
    expect(within(running).getByText('3 agents, 1 working, 1 test run')).toBeInTheDocument();
    expect(within(running).getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['Company', 'Development', 'Test runs']);
    expect(within(running).getAllByText('Orchestrator')).toHaveLength(1);
  });

  it('shows no built-in node and no pool part of it to those who do not see the whole company', async () => {
    lists({}, null);
    const lead: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };
    render(<Machines me={lead} />);
    const pool = await screen.findByRole('region', { name: 'All machines together', busy: false });
    expect(fact(pool, 'Machines online')).toBe('1 of 2');
    expect(screen.queryByRole('article', { name: 'Built-in node' })).not.toBeInTheDocument();
  });

  it('shows one table row per machine and toggles cards independently from any cell', async () => {
    lists();
    render(<Machines me={ME} />);
    await shownTable();
    expect(screen.getAllByRole('row').filter(r => r.classList.contains('rm'))).toHaveLength(3);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('row', { name: 'dev-laptop' })).getByText('Ivan'));
    expect(screen.getByRole('button', { name: 'Open the card of dev-laptop' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of build-box' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of dev-laptop' }));
    expect(screen.queryByRole('article', { name: 'dev-laptop' })).not.toBeInTheDocument();
  });

  it('keeps a card and its row order through the five second refresh and sorts unknown loads last both ways', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    let calls = 0;
    lists({ 'GET /api/machines': () => [200, { machines: ++calls === 1 ? MACHINES : MACHINES.map(m => ({ ...m, online: !m.online })), builtin: BUILTIN }] });
    render(<Machines me={ME} />);
    const mac = await openCard('dev-laptop');
    const order = () => screen.getAllByRole('row').filter(r => r.classList.contains('rm')).map(r => r.getAttribute('aria-label'));
    const before = order();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(order()).toEqual(before);
    expect(screen.getByRole('article', { name: 'dev-laptop' })).toBe(mac);
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of dev-laptop' }));
    expect(order()[0]).toBe('build-box');
    const load = within(screen.getByRole('columnheader', { name: 'Load' })).getByRole('button');
    await userEvent.click(load);
    expect(load.closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(order().at(-1)).toBe('dev-laptop');
    await userEvent.click(load);
    expect(load.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    expect(order().at(-1)).toBe('dev-laptop');
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
    expect(await screen.findByText(commandCode(withKey(COMMAND)))).toBeInTheDocument();
    expect(screen.getByText(/joins without a plan/)).toBeInTheDocument();
    expect(screen.getByText("Hornhoof will run tests of the company's code on this machine. People with access to this Hornhoof can start them.")).toBeInTheDocument();
    expect(screen.getByText(/^Valid for (59 more minutes|1 more hour)\.$/)).toBeInTheDocument();
    expect(screen.getByText('The command works once. The nodes keep running in the background after the terminal is closed.')).toBeInTheDocument();
    /* Copy for the command on a Mac or Linux, and for the one on Windows. */
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls).toContainEqual({ method: 'POST', path: `/api/nodes/commands/${id}/hide`, body: undefined });
    expect(screen.queryByText(commandCode(withKey(COMMAND)))).not.toBeInTheDocument();
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
    const mac = await openCard('dev-laptop');
    expect(within(card('build-box')).queryByRole('button', { name: /^Add my plan/ })).not.toBeInTheDocument();
    await user.click(within(mac).getByRole('button', { name: 'Add my plan to dev-laptop' }));
    expect(screen.getByText('Which of your plans should run on dev-laptop too?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Claude to dev-laptop' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add Kimi to dev-laptop' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/machines/m1/plans', body: { subscription: 's-kimi' } });
    expect(await screen.findByText(commandCode(withKey(COMMAND)))).toBeInTheDocument();
    expect(screen.getByText(/^Run this in a terminal on dev-laptop\./)).toBeInTheDocument();
    expect(within(mac).getByText(/^Valid for (59 more minutes|1 more hour)\.$/)).toBeInTheDocument();
    expect(within(mac).getByText('The command works once. The nodes keep running in the background after the terminal is closed.')).toBeInTheDocument();
    expect(within(mac).getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    await user.click(within(mac).getByRole('button', { name: 'Cancel' }));
    expect(calls).toContainEqual({ method: 'POST', path: `/api/nodes/commands/${id}/hide`, body: undefined });
    expect(screen.queryByText(commandCode(withKey(COMMAND)))).not.toBeInTheDocument();
  });

  it('keeps machine and add-plan commands visible across tab switches and reloads with expiry, Copy and Cancel, and removes them on join, expiry or Cancel', async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const machineCmd = { id: '1'.repeat(64), kind: 'machine' as const, plans: [], machineId: null, machine: null, command: `${COMMAND}-MACHINE`, expiresAt };
    const addCmd = { id: '2'.repeat(64), kind: 'add' as const, plans: ['Kimi'], machineId: 'm1', machine: 'dev-laptop', command: `${COMMAND}-ADD`, expiresAt };
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
    expect(await screen.findByText(commandCode(withKey(machineCmd.command)))).toBeInTheDocument();
    expect(await screen.findByText(commandCode(withKey(addCmd.command)))).toBeInTheDocument();

    /* Switching tabs and returning, or reloading the page, keeps both commands visible. */
    first.unmount();
    localStorage.setItem('hh-lang', 'ru');
    const inRu = render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    expect(await screen.findByText(commandCode(withKey(machineCmd.command)))).toBeInTheDocument();
    expect(await screen.findByText(commandCode(withKey(addCmd.command)))).toBeInTheDocument();
    expect(screen.getAllByText(/^Действует еще (59 мин|1 ч)\.$/)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Копировать' })).toHaveLength(4);
    const cancels = screen.getAllByRole('button', { name: 'Отменить' });
    expect(cancels).toHaveLength(2);
    await user.click(cancels[0]!);
    expect(calls).toContainEqual({ method: 'POST', path: `/api/nodes/commands/${machineCmd.id}/hide`, body: undefined });
    await vi.waitFor(() => expect(screen.queryByText(commandCode(withKey(machineCmd.command)))).not.toBeInTheDocument());
    expect(screen.getByText(commandCode(withKey(addCmd.command)))).toBeInTheDocument();

    /* After the machine joins by the add-plan command or it expires, reload hides it too. */
    active = [];
    inRu.unmount();
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await shownTable();
    expect(screen.queryByText(commandCode(withKey(addCmd.command)))).not.toBeInTheDocument();
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
    const lend = within(await openCard('dev-laptop')).getByRole('checkbox', { name: "Lend dev-laptop to the company's test runs" });
    expect(lend).toBeChecked();
    expect(within(card('build-box')).getByRole('checkbox')).not.toBeChecked();
    await user.click(lend);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/machines/m1', body: { lendsTests: false } }));
  });

  it('ticks backups like test runs, on a machine with a core', async () => {
    const withCore = MACHINES.map(machine => (machine.id === 'm1' ? { ...machine, keepsBackups: true, heldBackups: 2 } : { ...machine, keepsBackups: null, heldBackups: null }));
    const calls = mockApi({ 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: withCore, builtin: BUILTIN }], 'PATCH /api/machines/m1': [200, { lendsTests: true, keepsBackups: false }] });
    const user = userEvent.setup();
    render(<Machines me={ME} />);
    const mine = await openCard('dev-laptop');
    const keep = within(mine).getByRole('checkbox', { name: "Keep the company's backups on dev-laptop" });
    expect(keep).toBeChecked();
    expect(fact(mine, 'Backups')).toContain('Keep company backups');
    expect(within(mine).getByText('Backups held: 2')).toBeInTheDocument();
    await user.click(keep);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/machines/m1', body: { keepsBackups: false } }));
    await vi.waitFor(() => expect(keep).not.toBeChecked());
    /* A machine without the company's core keeps none, and says nothing of them. */
    const other = card('build-box');
    expect(within(other).queryByRole('checkbox', { name: /backups/ })).not.toBeInTheDocument();
    expect(within(other).queryByText(/company backups/)).not.toBeInTheDocument();
  });

  it("sets the room a machine gives the company's files, and shows what they take there and what its disk has free", async () => {
    const store = { id: 'm1', limitBytes: null, areaBytes: 10 * GIB, usedBytes: 2 * GIB, diskFree: 40 * GIB };
    const withStore = MACHINES.map(machine => ({ ...machine, fileStore: machine.id === 'm1' ? store : null }));
    const calls = mockApi({ 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: withStore, builtin: BUILTIN }], 'PATCH /api/machines/m1': [200, { lendsTests: true, keepsBackups: false, fileStoreLimitBytes: 20 * GIB }] });
    const user = userEvent.setup();
    render(<Machines me={ME} />);
    const mine = await openCard('dev-laptop');
    const room = within(mine).getByRole('combobox', { name: "Room for the company's files on dev-laptop" });
    expect(room).toHaveValue('default');
    expect(within(room).getAllByRole('option').map(option => option.textContent).slice(0, 3)).toEqual(['Default, 10 GB', 'None', '5 GB']);
    expect(fact(mine, 'They take')).toBe('2 of 10 GB');
    expect(fact(mine, 'Free on its disk')).toBe('40 GB');
    await user.selectOptions(room, String(20 * GIB));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/machines/m1', body: { fileStoreLimitBytes: 20 * GIB } }));
    /* The list is read again, for what the setting gives. */
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'GET' && c.path === '/api/machines').length).toBe(2));
    /* A machine without a keeper keeps none of them, and says nothing of them. */
    expect(within(card('build-box')).queryByText('Company files')).not.toBeInTheDocument();
  });

  it("shows the server's own room for the company's files on the built-in card, for the CEO alone to set", async () => {
    const own = { id: 'own-row', limitBytes: 0, areaBytes: 0, usedBytes: 0, diskFree: null };
    const calls = lists({ 'PATCH /api/machines/own-row': [200, {}] }, { ...BUILTIN, fileStore: own });
    const user = userEvent.setup();
    const { unmount } = render(<Machines me={ME} />);
    const server = await openCard('Built-in node');
    const room = within(server).getByRole('combobox', { name: "Room for the company's files on Built-in node" });
    expect(room).toHaveValue('0');
    expect(within(server).queryByText('Free on its disk')).not.toBeInTheDocument();
    await user.selectOptions(room, 'default');
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/machines/own-row', body: { fileStoreLimitBytes: null } }));
    unmount();
    /* Someone who sees the whole company but is not the CEO reads it. */
    lists({}, { ...BUILTIN, fileStore: own });
    render(<Machines me={{ ...ME, person: { ...ME.person, id: 'p9', isOwner: false } }} />);
    const read = await openCard('Built-in node');
    expect(within(read).queryByRole('combobox', { name: /company's files/ })).not.toBeInTheDocument();
    expect(fact(read, 'Room for them')).toBe('None');
  });

  it("shows whether another person's machine keeps backups, without the switch", async () => {
    const withCore = MACHINES.map(machine => ({ ...machine, keepsBackups: machine.id === 'm2', heldBackups: machine.id === 'm2' ? 1 : 0 }));
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: withCore, builtin: null }] });
    const lead: Me = { ...ME, person: { ...ME.person, id: 'p9', scopeKind: 'listed', isOwner: false } };
    render(<Machines me={lead} />);
    const maria = await openCard('build-box');
    expect(within(maria).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(maria).getByText('Keeps company backups')).toBeInTheDocument();
    expect(within(card('dev-laptop')).getByText('Keeps no company backups')).toBeInTheDocument();
  });

  it("shows another person's machine as lent or not, without the switch", async () => {
    lists({}, null);
    const lead: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };
    render(<Machines me={lead} />);
    const maria = await openCard('build-box');
    expect(within(maria).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(maria).getByText('Not lent to test runs')).toBeInTheDocument();
    expect(within(card('dev-laptop')).getByRole('checkbox')).toBeChecked();
  });

  it.each([
    ['en', 'Off checks', 'Taken off checks: none of its nodes, the built-in one too, takes parts of test runs or work runs.'],
    ['ru', 'Снята с проверок', 'Снята с проверок: ни одна ее нода, и встроенная тоже, не берет части прогонов тестов и работ.'],
  ])('marks a machine taken off checks, in its row and its card, and no lent one, in %s', async (language, mark, note) => {
    localStorage.setItem('hh-lang', language);
    lists();
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await shownTable();
    expect(within(screen.getByRole('row', { name: 'build-box' })).getByTitle(note)).toHaveTextContent(mark);
    expect(within(screen.getByRole('row', { name: 'dev-laptop' })).queryByText(mark)).not.toBeInTheDocument();
    const box = card('build-box');
    expect(within(box).getByTitle(note)).toHaveTextContent(mark);
    expect(within(box).getByTitle(note)).toHaveClass('badge', 'off');
    expect(within(box).getByText(note, { selector: 'p' })).toBeInTheDocument();
    const laptop = card('dev-laptop');
    expect(within(laptop).queryByText(mark)).not.toBeInTheDocument();
    expect(within(laptop).queryByText(note)).not.toBeInTheDocument();
    /* The server's own card, on no machine of the company, lends always and says nothing of it. */
    const server = screen.getAllByRole('row').find(r => r.classList.contains('rm') && !['build-box', 'dev-laptop'].includes(r.getAttribute('aria-label') ?? ''))!;
    expect(within(server).queryByText(mark)).not.toBeInTheDocument();
  });

  it.each([
    ['en', 'Other build',"Its nodes are not the server's build (3fe094e here, 8de55ce on the server). To update them, run the install command on it again without --join.", "Its nodes are not the server's build (an older one here, 8de55ce on the server). To update them, run the install command on it again without --join."],
    ['ru', 'Другая сборка', 'Ее ноды не той сборки, что у сервера (здесь 3fe094e, у сервера 8de55ce). Чтобы обновить их, выполните на ней команду установки еще раз без --join.', 'Ее ноды не той сборки, что у сервера (здесь старая, у сервера 8de55ce). Чтобы обновить их, выполните на ней команду установки еще раз без --join.'],
  ])('marks a machine whose nodes are not the server build, in its row and its card, and no other, in %s', async (language, mark, note, older) => {
    localStorage.setItem('hh-lang', language);
    const server = '8de55ce'.padEnd(40, '0');
    let nodes: (string | null)[] = ['3fe094e'.padEnd(40, '1')];
    lists({ 'GET /api/machines': () => [200, { machines: [{ ...MACHINES[0]!, otherBuild: { server, nodes } }, { ...MACHINES[1]!, otherBuild: null }], builtin: BUILTIN }] });
    const view = render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await shownTable();
    expect(within(screen.getByRole('row', { name: 'dev-laptop' })).getByTitle(note)).toHaveTextContent(mark);
    expect(within(screen.getByRole('row', { name: 'build-box' })).queryByText(mark)).not.toBeInTheDocument();
    const mac = card('dev-laptop');
    expect(within(mac).getByText(note, { selector: 'p' })).toBeInTheDocument();
    expect(within(card('build-box')).queryByText(mark)).not.toBeInTheDocument();
    /* A node from before builds says none. */
    view.unmount();
    nodes = [null];
    const again = render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await shownTable();
    expect(within(screen.getByRole('row', { name: 'dev-laptop' })).getByTitle(older)).toHaveTextContent(mark);
    /* Two nodes of two builds name both. */
    again.unmount();
    nodes = ['3fe094e'.padEnd(40, '1'), null];
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await shownTable();
    expect(within(screen.getByRole('row', { name: 'dev-laptop' })).getByTitle(note.replace('3fe094e', `3fe094e, ${language === 'en' ? 'an older one' : 'старая'}`))).toHaveTextContent(mark);
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
    await shownTable();
    const row = screen.getByRole('row', { name: 'dev-laptop' });
    expect(within(row).getByTitle(note)).toHaveTextContent(mark);
    const marks = row.querySelectorAll('.marks > span');
    expect(marks[0]).not.toHaveClass('dim');
    expect(marks[1]).toHaveClass('dim');
    expect(marks[2]).toHaveClass('dim');
    expect(screen.getByRole('row', { name: 'spare-box' }).querySelector('.marks > span')).toHaveClass('dim');
    expect(screen.getByRole('row', { name: 'build-box' }).querySelector('.marks')).toHaveTextContent(/^0$/);
    expect(within(screen.getByRole('row', { name: 'build-box' })).queryByText(mark)).not.toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: builtinName })).getByTitle(note)).toHaveTextContent(mark);
    expect(within(card('dev-laptop')).getByText(note, { selector: 'p' })).toBeInTheDocument();
    const plansSort = within(screen.getByRole('columnheader', { name: plansHeader })).getByRole('button');
    await userEvent.click(plansSort);
    expect(plansSort.closest('th')).toHaveAttribute('aria-sort', 'descending');
    const order = screen.getAllByRole('row').filter(r => r.classList.contains('rm')).map(r => r.getAttribute('aria-label'));
    expect(order[0]).toBe('dev-laptop');
    expect(order.at(-1)).toBe('build-box');
  });

  it('marks no machine when the server does not tell builds apart', async () => {
    lists();
    render(<Machines me={ME} />);
    await shownTable();
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
    const pool = await screen.findByRole('region', { name: 'Все машины вместе', busy: false });
    expect(fact(pool, 'Машин в сети')).toBe('2 из 3');
    expect(fact(pool, 'Свободно памяти')).toBe('8,5 из 20 ГБ');
    const mac = card('dev-laptop');
    expect(meter(mac, 'Процессор').textContent).toBe('Процессор8 ядерApple M2 Pro, у машины 10');
    expect(meter(mac, 'Память').textContent).toBe('Память6ГБ свободноиз 12 ГБ, у машины 32 ГБ');
    expect(within(mac).getByText('Docker на этом Mac настроен меньше самого Mac, поэтому Hornhoof использует только часть.')).toBeInTheDocument();
    expect(meter(mac, 'Диск').textContent).toBe('Диск120ГБ свободноиз 460 ГБ');
    expect(within(mac).getByRole('region', { name: 'Что сейчас идет на dev-laptop' })).toHaveTextContent('Тесты задачи 12, часть 1 из 2');
    expect(within(card('build-box')).getByText('Свежих данных о ресурсах нет.')).toBeInTheDocument();
    expect(meter(card('Встроенная нода'), 'Процессор').querySelector('.g-f')).toHaveTextContent('4 ядра');
    expect(within(screen.getByRole('group', { name: 'Тесты' })).getByRole('button', { name: /^Отдана под тесты/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Подключить машину' })).toBeInTheDocument();
    expect(within(mac).getByRole('button', { name: 'Добавить мою подписку на dev-laptop' })).toBeInTheDocument();
    expect(within(mac).getByRole('checkbox', { name: 'Отдавать dev-laptop под прогоны тестов компании' })).toBeChecked();
  });

  const shown = (language: string, machines: unknown[], routes: Parameters<typeof mockApi>[0] = {}) => {
    localStorage.setItem('hh-lang', language);
    const calls = lists({ 'GET /api/machines': [200, { machines, builtin: null, priority: true }], ...routes });
    return { calls, view: render(<LanguageProvider><Machines me={ME} /></LanguageProvider>) };
  };
  const held = (over: object) => ({ number: null, why: null, pin: null, unfit: null, copy: null, leftAt: null, ...over });

  it.each([['en', 'Copy: being made, 40%'], ['ru', 'Копия: создается, 40%']])("writes a copy's line in %s", async (language, line) => {
    shown(language, [{ ...MACHINES[0]!, data: held({ number: 2, copy: { line: 'making', progress: 40 } }) }]);
    const mac = await openCard('dev-laptop');
    expect(within(mac).getByText(line)).toBeInTheDocument();
    /* Its place stands in the same block, above the line, which has a part of its own (#1027). */
    const role = within(mac).getByRole('region', { name: language === 'en' ? 'Server and data copy' : 'Сервер и копия данных' });
    expect(within(role).getByText('2')).toBeInTheDocument();
    expect(within(role).getByText(line).closest('section')?.querySelector('h5')?.textContent).toBe(language === 'en' ? 'Data copy' : 'Копия данных');
  });

  it("writes every state of a copy, and a machine's place without one", async () => {
    const lines: [object, string][] = [
      [{ number: 2, copy: { line: 'remaking', progress: 10 } }, 'Copy: being made again, 10%'],
      [{ number: 2, copy: { line: 'ready' } }, 'Copy: up to date'],
      [{ number: 2, copy: { line: 'saving' } }, 'Copy: saving what it did while it led'],
      [{ number: 3, copy: { line: 'behind', minutes: 4 } }, 'Copy: 4 min behind'],
      [{ number: 2, copy: { line: 'catching_up' } }, 'Copy: catching up'],
      [{ number: 2, copy: { line: 'asleep', since: null } }, 'Copy: asleep'],
      [{ number: 3, copy: { line: 'asleep', since: '2026-11-10T09:30:00.000Z' } }, `Copy: asleep since ${clock('en', '2026-11-10T09:30:00.000Z')}`],
      [{ number: 2, copy: { line: 'stopped', why: null } }, 'Copy: stopped'],
      [{ number: 2, copy: { line: 'stopped', why: 'disk_full' } }, 'Copy: stopped: disk full'],
      [{ number: 2, copy: { line: 'stopped', why: 'setup' } }, "Copy: stopped: the company's settings cannot be written here"],
      [{ number: 4, why: 'next' }, 'Gets a copy if one of the first three leaves'],
      [{ number: 1, why: 'server' }, 'The company server runs here'],
    ];
    shown('en', lines.map(([data], n) => ({ ...MACHINES[0]!, id: `c${n}`, hostname: `host-${n}`, data: held(data) })));
    await shownTable();
    for (const [n, [, line]] of lines.entries()) expect(within(card(`host-${n}`)).getByText(line), line).toBeInTheDocument();
  });

  it.each([
    [
      'en',
      [
        ['dump', (since: string) => `Copy: saving what it did while it led (reading the database, since ${since})`],
        ['seal', (since: string) => `Copy: saving what it did while it led (encrypting the backup, since ${since})`],
        ['server', (since: string) => `Copy: saving what it did while it led (waiting for the company server, since ${since})`],
        ['send', (since: string) => `Copy: saving what it did while it led (sending the backup to the company server, since ${since})`],
        ['retry', (since: string) => `Copy: saving what it did while it led (retrying after an error, since ${since})`],
      ] as const,
    ],
    [
      'ru',
      [
        ['dump', (since: string) => `Копия: сохраняет то, что сделано, пока она держала сервер (выгружает базу данных, с ${since})`],
        ['seal', (since: string) => `Копия: сохраняет то, что сделано, пока она держала сервер (шифрует резервную копию, с ${since})`],
        ['server', (since: string) => `Копия: сохраняет то, что сделано, пока она держала сервер (ждет ответа сервера компании, с ${since})`],
        ['send', (since: string) => `Копия: сохраняет то, что сделано, пока она держала сервер (отправляет резервную копию на сервер компании, с ${since})`],
        ['retry', (since: string) => `Копия: сохраняет то, что сделано, пока она держала сервер (повторяет попытку после сбоя, с ${since})`],
      ] as const,
    ],
  ] as const)('shows what a stuck saving machine waits on and since when in %s', async (language, cases) => {
    const iso = '2026-11-24T01:09:00.000Z';
    const since = clock(language, iso)!;
    shown(
      language,
      cases.map(([waiting], n) => ({
        ...MACHINES[0]!,
        id: `s${n}`,
        hostname: `save-${n}`,
        data: held({ number: 2, copy: { line: 'saving', waiting, since: iso } }),
      })),
    );
    await shownTable();
    for (const [n, [, expected]] of cases.entries()) {
      expect(within(card(`save-${n}`)).getByText(expected(since))).toBeInTheDocument();
    }
  });

  it.each([
    ['en', (attempts: number, since: string) => `Copy: given up after ${attempts} failed attempts in a row (${since}). Nothing more is copied to this machine until it is asked for.`],
    ['ru', (attempts: number, since: string) => `Копия: оставлена после ${attempts} неудачных попыток подряд (${since}). На эту машину больше ничего не копируется, пока об этом не попросят.`],
  ] as const)('says a copy was given up, after how many attempts and since when, in %s', async (language, words) => {
    const iso = '2026-11-24T19:30:00.000Z';
    shown(language, [{ ...MACHINES[0]!, id: 'g0', hostname: 'given-up', data: held({ number: 2, copy: { line: 'stopped', why: 'gave_up', attempts: 4, since: iso } }) }]);
    await shownTable();
    expect(within(card('given-up')).getByText(words(4, clock(language, iso)!))).toBeInTheDocument();
  });

  it('lets the CEO ask for a copy again once it was given up, and offers that for no other stop', async () => {
    const iso = '2026-11-24T19:30:00.000Z';
    const rows = [
      { ...MACHINES[0]!, id: 'g1', hostname: 'given-up', data: held({ number: 2, copy: { line: 'stopped', why: 'gave_up', attempts: 4, since: iso } }) },
      { ...MACHINES[0]!, id: 'g2', hostname: 'weak-link', data: held({ number: 3, copy: { line: 'stopped', why: 'path_slow', attempts: 0, since: iso } }) },
      { ...MACHINES[0]!, id: 'g3', hostname: 'late-link', data: held({ number: 4, copy: { line: 'stopped', why: 'path_late', attempts: 0, since: iso } }) },
      { ...MACHINES[0]!, id: 'g4', hostname: 'full-disk', data: held({ number: 5, copy: { line: 'stopped', why: 'disk_full' } }) },
    ];
    const { calls } = shown('en', rows, { 'POST /api/machines/g1/copy/retry': [204] });
    const user = userEvent.setup();
    const gone = await openCard('given-up');
    await user.click(within(gone).getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'POST' && c.path.endsWith('/copy/retry')).map(c => c.path)).toEqual(['/api/machines/g1/copy/retry']));
    const slow = await openCard('weak-link');
    expect(within(slow).getByText('Copy: not made: the connection between this machine and the company server is too slow for it')).toBeInTheDocument();
    const late = await openCard('late-link');
    expect(within(late).getByText('Copy: not made: the connection between this machine and the company server answers too late for it')).toBeInTheDocument();
    const full = await openCard('full-disk');
    for (const card of [slow, late, full]) expect(within(card).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('writes in Russian that a copy is not made over a path too weak for it', async () => {
    shown('ru', [
      { ...MACHINES[0]!, id: 'g2', hostname: 'weak-link', data: held({ number: 3, copy: { line: 'stopped', why: 'path_slow', attempts: 0, since: '2026-11-24T19:30:00.000Z' } }) },
      { ...MACHINES[0]!, id: 'g3', hostname: 'late-link', data: held({ number: 4, copy: { line: 'stopped', why: 'path_late', attempts: 0, since: '2026-11-24T19:30:00.000Z' } }) },
    ]);
    const slow = await openCard('weak-link');
    expect(within(slow).getByText('Копия: не делается: связь этой машины с сервером компании слишком медленная для нее')).toBeInTheDocument();
    const late = await openCard('late-link');
    expect(within(late).getByText('Копия: не делается: связь этой машины с сервером компании отвечает слишком поздно для нее')).toBeInTheDocument();
  });

  const names = () => screen.getAllByRole('button', { name: /^Open the card of / }).map(button => button.getAttribute('aria-label')!.replace('Open the card of ', ''));
  const four = (over: object[] = []) => [
    { number: 1, why: 'server' }, { number: 2, why: 'always.best_link' }, { number: 3, why: 'mostly.good_link' }, { number: 4, why: 'next' },
  ].map((data, n) => ({ ...MACHINES[0]!, id: `p${n}`, hostname: `host-${n + 1}`, data: held({ ...data, ...over[n] }) }));
  const radios = (node: HTMLElement) => within(node).queryAllByRole('radio').map(radio => [radio.closest('label')!.textContent, (radio as HTMLInputElement).checked]);

  it('sorts by priority', async () => {
    const rows = [[3, 'c'], [1, 'a'], [null, 'd'], [2, 'b']] as const;
    const { view } = shown('en', rows.map(([number, hostname]) => ({ ...MACHINES[0]!, id: hostname, hostname, data: held({ number, why: number === 1 ? 'server' : null }) })));
    await shownTable();
    expect(names()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.getByRole('columnheader', { name: /Priority/ })).toHaveAttribute('aria-sort', 'ascending');
    /* The number in its cell; a machine with none has a dash that says why. */
    const cell = (hostname: string) => screen.getByRole('button', { name: `Open the card of ${hostname}` }).closest('tr')!.querySelector('.k-prio')!;
    expect([cell('a').textContent, cell('c').textContent, cell('d').textContent]).toEqual(['1', '3', 'Cannot take the server']);
    view.unmount();
    /* Someone who does not see the whole company is told nothing of the order. */
    lists({ 'GET /api/machines': [200, { machines: [MACHINES[0]!], builtin: null, priority: false }] });
    render(<Machines me={{ ...ME, person: { ...ME.person, isOwner: false, scopeKind: 'listed' } }} />);
    await shownTable();
    expect(screen.queryByRole('columnheader', { name: /Priority/ })).not.toBeInTheDocument();
    expect(within(card('dev-laptop')).queryByRole('heading', { name: 'Priority' })).not.toBeInTheDocument();
  });

  it.each([
    ['en', ['Always online, best connection to machine 1', 'Always online, but has the least memory', 'Gets a copy if one of the first three leaves', 'Keeps its copy until the new one is up to date', 'New: connected less than 3 days ago', 'Often offline, but a slow disk'], 'If machine 1 goes away, machine 2 takes the server, then 3.'],
    ['ru', ['Всегда в сети, лучшая связь с машиной 1', 'Всегда в сети, но памяти у нее меньше всех', 'Получит копию, если одна из первых трех уйдет', 'Хранит копию, пока новая не станет актуальной', 'Новая: подключена меньше 3 дней назад', 'Часто не в сети, но диск медленный'], 'Если машина 1 пропадет, сервер возьмет машина 2, за ней 3.'],
  ])('says why in %s', async (language, lines, under) => {
    const whys = ['always.best_link', 'always.small', 'next', 'handing', 'new', 'often_off.slow_disk'];
    shown(language, whys.map((why, n) => ({ ...MACHINES[0]!, id: `w${n}`, hostname: `host-${n}`, data: held({ number: n + 2, why }) })));
    await shownTable();
    for (const [n, line] of lines.entries()) {
      expect(within(card(`host-${n}`)).getByText(line), line).toBeInTheDocument();
      expect(within(card(`host-${n}`)).getByText(under)).toBeInTheDocument();
    }
  });

  it('lets the CEO choose', async () => {
    const { calls } = shown('en', four(), { 'PUT /api/machines/p1/priority': [204] });
    const user = userEvent.setup();
    const second = await openCard('host-2');
    expect(within(second).getByRole('radiogroup', { name: 'Priority' })).toBeInTheDocument();
    expect(radios(second)).toEqual([['Automatically', true], ['By hand', false], ['Does not take the server', false]]);
    expect(within(second).queryByRole('combobox', { name: 'Priority of host-2' })).not.toBeInTheDocument();
    /* By hand keeps the machine at its number. */
    await user.click(within(second).getByRole('radio', { name: 'By hand' }));
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/machines/p1/priority', body: { pin: 2 } }]));
    await user.click(within(second).getByRole('radio', { name: 'Does not take the server' }));
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'PUT').at(-1)).toEqual({ method: 'PUT', path: '/api/machines/p1/priority', body: { pin: 'none' } }));
    /* The server's machine and a machine set by hand elsewhere offer nothing to press here. */
    expect(within(card('host-1')).queryByRole('radio')).not.toBeInTheDocument();
  });

  it('offers the places there are to a machine set by hand', async () => {
    const calls = lists({ 'GET /api/machines': [200, { machines: four([{}, { why: 'pinned', pin: 2 }]), builtin: null, priority: true }], 'PUT /api/machines/p1/priority': [204] });
    render(<Machines me={ME} />);
    const user = userEvent.setup();
    const second = await openCard('host-2');
    expect(within(second).getByText('Number set by hand')).toBeInTheDocument();
    expect(radios(second)).toEqual([['Automatically', false], ['By hand', true], ['Does not take the server', false]]);
    const select = within(second).getByRole('combobox', { name: 'Priority of host-2' }) as HTMLSelectElement;
    expect([[...select.options].map(option => option.value), select.value]).toEqual([['2', '3', '4'], '2']);
    await user.selectOptions(select, '3');
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/machines/p1/priority', body: { pin: 3 } }]));
    /* The cell of a number set by hand says so. */
    expect(screen.getByRole('button', { name: 'Open the card of host-2' }).closest('tr')!.querySelector('.k-prio [title]')).toHaveAttribute('title', 'Number set by hand');
  });

  it('shows the choice to the CEO alone', async () => {
    lists({ 'GET /api/machines': [200, { machines: four(), builtin: null, priority: true }] });
    render(<Machines me={{ ...ME, person: { ...ME.person, isOwner: false } }} />);
    const second = await openCard('host-2');
    expect(within(second).getByText('Always online, best connection to machine 1')).toBeInTheDocument();
    expect(within(within(second).getByRole('heading', { name: 'Priority' }).closest('section')!).getByText('2')).toBeInTheDocument();
    expect(within(second).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(second).queryByRole('combobox', { name: 'Priority of host-2' })).not.toBeInTheDocument();
  });

  it('keeps a machine set out changeable', async () => {
    const { calls } = shown('en', four([{}, {}, {}, { number: null, why: 'out', pin: 'none' }]), { 'PUT /api/machines/p3/priority': [204] });
    const user = userEvent.setup();
    const out = await openCard('host-4');
    expect(within(out).getByText('Never takes the server: set by hand')).toBeInTheDocument();
    expect(radios(out)).toEqual([['Automatically', false], ['By hand', false], ['Does not take the server', true]]);
    expect(screen.getByRole('button', { name: 'Open the card of host-4' }).closest('tr')!.querySelector('.k-prio')).toHaveTextContent('Does not take the server');
    await user.click(within(out).getByRole('radio', { name: 'Automatically' }));
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/machines/p3/priority', body: { pin: null } }]));
    /* By hand, from out: the place after the last one there is. */
    await user.click(within(out).getByRole('radio', { name: 'By hand' }));
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'PUT').at(-1)).toEqual({ method: 'PUT', path: '/api/machines/p3/priority', body: { pin: 4 } }));
  });

  /* The tab as the CEO sees it, with what the server says of a move. */
  const moving = (move: object | null, more: { canMove?: boolean; me?: Me; over?: object[]; routes?: Parameters<typeof mockApi>[0]; language?: string } = {}) => {
    localStorage.setItem('hh-lang', more.language ?? 'en');
    const calls = lists({ 'GET /api/machines': [200, { machines: four(more.over), builtin: null, priority: true, move, canMove: more.canMove ?? true }], ...more.routes });
    return { calls, view: render(<LanguageProvider><Machines me={more.me ?? ME} /></LanguageProvider>) };
  };
  const PAT: Me = { ...ME, person: { ...ME.person, isOwner: false } };

  it.each([
    ['en', (time: string) => `host-2 ran the server until ${time} and is up to date again.`, 'Move the server here'],
    ['ru', (time: string) => `Машина host-2 держала сервер до ${time}, ее копия снова актуальна.`, 'Перенести сервер сюда'],
  ] as const)('notes the machine the server moved from, beside the move, in %s', async (language, note, here) => {
    const until = '2026-11-12T14:02:00.000Z';
    const { view } = moving(null, { language, over: [{}, { copy: { line: 'ready' }, led: { until } }] });
    const second = await openCard('host-2');
    const line = within(second).getByText(note(clock(language, until)!));
    /* The note and the button stand in the same part of the card. */
    expect(within(line.closest('section')!).getByRole('button', { name: here })).toBeInTheDocument();
    expect(within(card('host-3')).queryByText(/ran the server|держала сервер/)).not.toBeInTheDocument();
    view.unmount();
    /* Someone who may not move the server reads the note all the same. */
    moving(null, { language, me: PAT, canMove: false, over: [{}, { copy: { line: 'ready' }, led: { until } }] });
    const again = await openCard('host-2');
    expect(within(again).getByText(note(clock(language, until)!))).toBeInTheDocument();
    expect(within(again).queryByRole('button', { name: here })).not.toBeInTheDocument();
  });

  it('asks before it moves the server', async () => {
    const { calls } = moving(null, { routes: { 'POST /api/machines/p3/move': [202, { state: 'preparing' }] } });
    const user = userEvent.setup();
    const fourth = await openCard('host-4');
    const here = within(fourth).getByRole('button', { name: 'Move the server here' });
    await user.click(here);
    /* The question stands in the button's place, with the focus on its first answer. */
    expect(within(fourth).getByText('Move the company server to host-4? Hornhoof stops for a short while as it moves; your work is kept.')).toBeInTheDocument();
    expect(within(fourth).queryByRole('button', { name: 'Move the server here' })).not.toBeInTheDocument();
    expect(within(fourth).getByRole('button', { name: 'Move the server' })).toHaveFocus();
    /* Cancel asks nothing of the server, and the focus is back on the button. */
    await user.click(within(fourth).getByRole('button', { name: 'Cancel' }));
    expect(within(fourth).getByRole('button', { name: 'Move the server here' })).toHaveFocus();
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);
    await user.click(within(fourth).getByRole('button', { name: 'Move the server here' }));
    const loads = calls.filter(c => c.path === '/api/machines' && c.method === 'GET').length;
    await user.click(within(fourth).getByRole('button', { name: 'Move the server' }));
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'POST')).toEqual([{ method: 'POST', path: '/api/machines/p3/move', body: undefined }]));
    /* Then the tab is read again. */
    await vi.waitFor(() => expect(calls.filter(c => c.path === '/api/machines' && c.method === 'GET').length).toBeGreaterThan(loads));
  });

  it('shows no move where it cannot be', async () => {
    const here = (node: HTMLElement) => within(node).queryByRole('button', { name: 'Move the server here' });
    /* Not on the server's own card, nor on a machine kept from the server or one that cannot take it. */
    const first = moving(null, { over: [{}, {}, { number: null, why: 'out', pin: 'none' }, { number: null, why: null, unfit: { why: 'phone' } }] });
    await shownTable();
    expect([here(card('host-1')), here(card('host-3')), here(card('host-4'))]).toEqual([null, null, null]);
    expect(here(card('host-2'))).toBeInTheDocument();
    first.view.unmount();
    /* Not for someone who is not the CEO, nor where the server says the CEO cannot ask now. */
    for (const more of [{ me: PAT, canMove: false }, { canMove: false }]) {
      const view = moving(null, more);
      expect(here(await openCard('host-2'))).toBeNull();
      view.view.unmount();
    }
    /* Not while the server is moving. */
    moving({ machine: 'p3', state: 'switching', reason: null, leader: 'host-1', progress: null });
    expect(here(await openCard('host-2'))).toBeNull();
  });

  it('shows the move to everyone', async () => {
    const view = moving({ machine: 'p3', state: 'switching', reason: null, leader: 'host-1', progress: null }, { me: PAT, canMove: false });
    const fourth = await openCard('host-4');
    expect(within(fourth).getByText('Moving the server to host-4.')).toBeInTheDocument();
    expect(within(card('host-2')).queryByText('Moving the server to host-4.')).not.toBeInTheDocument();
    view.view.unmount();
    moving({ machine: 'p3', state: 'preparing', reason: null, leader: 'host-1', progress: 40 }, { me: PAT, canMove: false });
    const waiting = await openCard('host-4');
    expect(within(waiting).getByText('host-4 takes the server once its copy is up to date (40%)')).toBeInTheDocument();
    expect(within(waiting).queryByRole('button', { name: 'Cancel the move' })).not.toBeInTheDocument();
  });

  it('says how the move goes', async () => {
    const preparing = { machine: 'p3', state: 'preparing', reason: null, leader: 'host-1', progress: 40 };
    const first = moving(preparing, { routes: { 'DELETE /api/machines/p3/move': [204] } });
    const user = userEvent.setup();
    const fourth = await openCard('host-4');
    expect(within(fourth).getByText('host-4 takes the server once its copy is up to date (40%)')).toBeInTheDocument();
    expect(within(fourth).queryByRole('button', { name: 'Move the server here' })).not.toBeInTheDocument();
    /* While one machine waits to take the server, another may still be asked in its place. */
    expect(within(card('host-2')).getByRole('button', { name: 'Move the server here' })).toBeInTheDocument();
    await user.click(within(card('host-4')).getByRole('button', { name: 'Cancel the move' }));
    await vi.waitFor(() => expect(first.calls.filter(c => c.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/api/machines/p3/move', body: undefined }]));
    first.view.unmount();
    const lines: [object, string][] = [
      [{ ...preparing, progress: null }, 'host-4 takes the server once its copy is up to date.'],
      [{ ...preparing, state: 'switching' }, 'Moving the server to host-4.'],
      [{ ...preparing, state: 'failed', reason: 'behind' }, 'The server stayed on host-1: host-4 did not get the last changes within a minute.'],
      [{ ...preparing, state: 'failed', reason: 'no_link' }, "The server stayed on host-1: host-4 could not take the company's link at hornhoof.org."],
    ];
    for (const [move, line] of lines) {
      const view = moving(move);
      expect(within(await openCard('host-4')).getByText(line), line).toBeInTheDocument();
      view.view.unmount();
    }
    /* After a failure the CEO may ask again. */
    moving(lines[2]![0]);
    expect(within(await openCard('host-4')).getByRole('button', { name: 'Move the server here' })).toBeInTheDocument();
  });

  it.each([
    ['en', 'Move the server here', 'Move the server', 'Hornhoof is updating. Move the server once the update ended.', 'The server is moving to host-3 now.'],
    ['ru', 'Перенести сервер сюда', 'Перенести сервер', 'Hornhoof обновляется. Перенесите сервер, когда обновление закончится.', 'Сервер как раз переезжает на host-3.'],
  ])("shows a move's refusal in %s", async (language, here, yes, updating, switching) => {
    const refused = (reason: string, details?: object) => [409, { error: { code: 'conflict', reason, message: 'Refused.', ...(details ? { details } : {}) } }] as [number, unknown];
    const first = moving(null, { language, routes: { 'POST /api/machines/p3/move': refused('updating') } });
    const user = userEvent.setup();
    const fourth = await openCard('host-4');
    await user.click(within(fourth).getByRole('button', { name: here }));
    await user.click(within(fourth).getByRole('button', { name: yes }));
    /* Said in the part itself, as an alert. */
    await vi.waitFor(() => expect(within(fourth).getByText(updating)).toHaveAttribute('role', 'alert'));
    expect(within(fourth).getByText(updating).closest('.prio')).not.toBeNull();
    /* The question stays, to be asked again or called off. */
    expect(within(fourth).getByRole('button', { name: yes })).toBeEnabled();
    first.view.unmount();
    moving(null, { language, routes: { 'POST /api/machines/p3/move': refused('switching', { host: 'host-3' }) } });
    const again = await openCard('host-4');
    await user.click(within(again).getByRole('button', { name: here }));
    await user.click(within(again).getByRole('button', { name: yes }));
    await vi.waitFor(() => expect(within(again).getByText(switching)).toHaveAttribute('role', 'alert'));
  });

  it("keeps the company's install connected", async () => {
    lists({ 'GET /api/machines': [200, { machines: [{ ...MACHINES[1]!, serverInstall: true }, MACHINES[0]!], builtin: null }] });
    render(<Machines me={ME} />);
    expect(within(await openCard('build-box')).queryByRole('button', { name: 'Disconnect build-box' })).not.toBeInTheDocument();
    expect(within(card('dev-laptop')).getByRole('button', { name: 'Disconnect dev-laptop' })).toBeInTheDocument();
  });

  it.each([
    ['en', [
      'Cannot take the server: it is a phone.',
      'Cannot take the server: Hornhoof runs here without Docker; make host-1 a full machine.',
      "Cannot take the server: the company's data stays only on machines of people who see the whole company, and Anna sees one department.",
      "Cannot take the server: the company's data stays only on machines of people who see the whole company, and Anna sees 2 departments.",
      "Cannot take the server: the company's data stays only on machines of people who see the whole company, and Anna sees no department.",
      "Cannot take the server: the company's hidden name at hornhoof.org is not made yet; Hornhoof makes it once hornhoof.org answers.",
    ]],
    ['ru', [
      'Не может взять сервер: это телефон.',
      'Не может взять сервер: здесь Hornhoof работает без Docker; сделайте host-1 полной машиной.',
      'Не может взять сервер: данные компании хранятся только на машинах тех, кто видит всю компанию, а Anna видит один отдел.',
      'Не может взять сервер: данные компании хранятся только на машинах тех, кто видит всю компанию, а Anna видит 2 отдела.',
      'Не может взять сервер: данные компании хранятся только на машинах тех, кто видит всю компанию, а Anna не видит ни одного отдела.',
      'Не может взять сервер: скрытое имя компании на hornhoof.org еще не создано; Hornhoof создаст его, как только hornhoof.org ответит.',
    ]],
  ])('says why a machine cannot take the server in %s', async (language, lines) => {
    const reasons: object[] = [
      { why: 'phone' }, { why: 'no_core' },
      { why: 'scope', person: 'Anna', departments: 1 }, { why: 'scope', person: 'Anna', departments: 2 }, { why: 'scope', person: 'Anna', departments: 0 },
      { why: 'no_link' },
    ];
    shown(language, reasons.map((unfit, n) => ({ ...MACHINES[0]!, id: `u${n}`, hostname: `host-${n}`, data: held({ unfit }) })));
    await shownTable();
    for (const [n, line] of lines.entries()) {
      const one = card(`host-${n}`);
      expect(within(one).getByText(line), line).toBeInTheDocument();
      expect(within(one).queryByRole('radio')).not.toBeInTheDocument();
    }
  });

  it.each([
    ['en', "Cannot take the server: the company's data stays only on machines of people who see the whole company, and Anna sees no department.", 'Copy: up to date', 'Cannot take the server'],
    ['ru', 'Не может взять сервер: данные компании хранятся только на машинах тех, кто видит всю компанию, а Anna не видит ни одного отдела.', 'Копия: актуальна', 'Не может взять сервер'],
  ])('says in %s why a machine that holds an up-to-date copy has no place, in its card and beside its dash', async (language, reason, copy, cannot) => {
    const anna = { ...MACHINES[0]!, id: 'u0', hostname: 'anna-mac', data: held({ unfit: { why: 'scope', person: 'Anna', departments: 0 }, copy: { line: 'ready' } }) };
    const waits = { ...MACHINES[0]!, id: 'u1', hostname: 'next-mac', data: held({}) };
    shown(language, [anna, waits]);
    await shownTable();
    const cell = (hostname: string) => screen.getByRole('button', { name: new RegExp(`${hostname}$`) }).closest('tr')!.querySelector('.k-prio')!;
    /* The dash in the list says the same reason, for whoever points at it or hears it. */
    expect(cell('anna-mac').textContent).toBe(reason);
    expect(cell('anna-mac').querySelector('.pdash')).toHaveAttribute('title', reason);
    /* A machine with no reason against it, which waits for the ranking, keeps the short words. */
    expect(cell('next-mac').textContent).toBe(cannot);
    const part = within(card('anna-mac')).getByRole('heading', { name: language === 'en' ? 'Priority' : 'Приоритет' }).closest('section')!;
    expect(within(part).getByText(reason)).toBeInTheDocument();
    /* The copy's line stands in the same block, in a part of its own beside Priority (#1027). */
    const block = within(card('anna-mac')).getByRole('region', { name: language === 'en' ? 'Server and data copy' : 'Сервер и копия данных' });
    expect(within(block).getByText(copy).closest('section')?.querySelector('h5')?.textContent).toBe(language === 'en' ? 'Data copy' : 'Копия данных');
  });

  it("shows the server's machine as 1", async () => {
    /* The card of the computer the server runs on says 1, whatever its own row says. */
    lists({ 'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, data: held({ number: null }) }], builtin: { ...BUILTIN, machine: { id: 'm1', hostname: 'dev-laptop' } }, priority: true }] });
    const view = render(<Machines me={ME} />);
    const mac = await openCard('dev-laptop');
    const part = within(mac).getByRole('heading', { name: 'Priority' }).closest('section')!;
    expect(part.textContent).toBe('Priority1The company server runs hereIf machine 1 goes away, machine 2 takes the server, then 3.');
    expect(within(mac).queryByRole('radio')).not.toBeInTheDocument();
    view.unmount();
    /* A company whose only machine is the server's. */
    lists({ 'GET /api/machines': [200, { machines: [], builtin: BUILTIN, priority: true }] });
    render(<Machines me={ME} />);
    await shownTable();
    expect(screen.getByRole('columnheader', { name: /Priority/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the card of Built-in node' }).closest('tr')!.querySelector('.k-prio')).toHaveTextContent('1');
  });

  it.each([
    ['en', ['Move the server to another machine first.', 'host-2 holds the only up-to-date copy; give another machine a place first.', 'This machine cannot take the server.']],
    ['ru', ['Сначала перенесите сервер на другую машину.', 'host-2 хранит единственную актуальную копию; сначала дайте место другой машине.', 'Эта машина не может взять сервер.']],
  ])('words the refusals in %s', async (language, lines) => {
    const refusals: [number, string, string][] = [[409, 'leader_pin', 'conflict'], [409, 'only_copy', 'conflict'], [400, 'unfit', 'validation']];
    let at = 0;
    shown(language, four(), { 'PUT /api/machines/p1/priority': () => [refusals[at]![0], { error: { code: refusals[at]![2], reason: refusals[at]![1], message: 'The words of the server.' } }] });
    const user = userEvent.setup();
    const second = await openCard('host-2');
    for (const line of lines) {
      await user.click(within(second).getAllByRole('radio')[2]!);
      expect(await within(second).findByText(line)).toHaveAttribute('role', 'alert');
      at += 1;
    }
  });

  it.each([
    ['en', (date: string) => `Stopped holding the company's data on ${date}. If it may be in other hands, change the company secret and the API keys.`],
    ['ru', (date: string) => `Перестала хранить данные компании ${date}. Если она может быть в чужих руках, смените секрет компании и API-ключи.`],
  ])('tells the CEO a machine left in %s', async (language, line) => {
    const leftAt = '2026-11-10T09:30:00.000Z';
    shown(language, [{ ...MACHINES[0]!, data: held({ leftAt }) }]);
    expect(within(await openCard('dev-laptop')).getByText(line(new Date(leftAt).toLocaleDateString(language)))).toBeInTheDocument();
  });

  it.each([
    ['en', 'rack-01 leads. mac keeps a copy and takes over if rack-01 stops.', 'rack-01 leads. mac and deb keep copies; deb takes over if rack-01 stops.', (time: string) => `Only rack-01 holds changes since ${time}.`],
    ['ru', 'rack-01 ведет компанию. mac хранит копию и возьмет сервер, если rack-01 остановится.', 'rack-01 ведет компанию. mac и deb хранят копии; deb возьмет сервер, если rack-01 остановится.', (time: string) => `Только rack-01 хранит изменения с ${time}.`],
  ])('says who holds the company in %s', async (language, one, two, only) => {
    const since = '2026-11-10T09:30:00.000Z';
    localStorage.setItem('hh-lang', language);
    lists({ 'GET /api/machines': [200, { machines: MACHINES, builtin: null, copies: { leader: 'rack-01', copies: [{ hostname: 'mac', sync: false }], onlySince: null } }] });
    const view = render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    expect(await screen.findByText(one)).toBeInTheDocument();
    view.unmount();
    /* Two copies: both are named, and the one commits wait for takes over; with none up to date, since when. */
    lists({ 'GET /api/machines': [200, { machines: MACHINES, builtin: null, copies: { leader: 'rack-01', copies: [{ hostname: 'mac', sync: false }, { hostname: 'deb', sync: true }], onlySince: since } }] });
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    expect(await screen.findByText(two)).toBeInTheDocument();
    expect(screen.getByText(only(clock(language as 'en' | 'ru', since)!))).toBeInTheDocument();
  });

  it('says nothing of copies where the server tells none', async () => {
    shown('en', [MACHINES[0]!]);
    const mac = await openCard('dev-laptop');
    expect(within(mac).queryByText(/^Copy: /)).not.toBeInTheDocument();
    expect(within(mac).queryByText(/^Holds no copy: /)).not.toBeInTheDocument();
    expect(screen.queryByText(/ leads\. /)).not.toBeInTheDocument();
  });

  it('says in Russian that the server runs on a machine that joined', async () => {
    localStorage.setItem('hh-lang', 'ru');
    lists({}, { ...BUILTIN, machine: { id: 'm1', hostname: 'dev-laptop' } });
    render(
      <LanguageProvider>
        <Machines me={ME} />
      </LanguageProvider>,
    );
    expect(fact(await screen.findByRole('region', { name: 'Все машины вместе', busy: false }), 'Машин в сети')).toBe('1 из 2');
    expect(within(card('dev-laptop')).getByText('Здесь же работает сервер и его встроенная нода: ключи компании и прогоны тестов.')).toBeInTheDocument();
    expect(within(card('dev-laptop')).getByTitle('Сервер компании сейчас работает на этой машине')).toHaveTextContent('Здесь сервер компании');
    expect(within(card('build-box')).queryByText('Здесь сервер компании')).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Встроенная нода' })).not.toBeInTheDocument();
  });
  it('searches agents, roles, departments and machine names, with counts, clear and no matches', async () => {
    lists();
    render(<Machines me={ME} />);
    expect(await screen.findByText('3 machines')).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search' });
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of dev-laptop' }));
    for (const query of ['BRUNO', 'Backend engineer', 'Development', 'dev-laptop']) {
      await userEvent.clear(search);
      await userEvent.type(search, query);
      expect(screen.getByText('Showing 1 of 3')).toBeInTheDocument();
      expect(screen.getByRole('article', { name: 'dev-laptop' })).toBeInTheDocument();
    }
    await userEvent.clear(search);
    await userEvent.type(search, 'missing machine');
    expect(screen.getByText('Nothing matches. Change the search or clear the filters.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(search).toHaveValue('');
    expect(screen.getByText('3 machines')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'dev-laptop' })).toBeInTheDocument();
  });

  it('widens matches inside one filter group and narrows across groups, counting keys by their program', async () => {
    const extra = { ...MACHINES[1]!, plans: [{ id: 'hidden', provider: 'kimi' as const, status: 'ready' as const, online: false }] };
    lists({ 'GET /api/machines': [200, { machines: [MACHINES[0]!, extra], builtin: BUILTIN }] });
    render(<Machines me={ME} />);
    await shownTable();
    const provider = screen.getByRole('group', { name: 'Provider' });
    const claude = within(provider).getByRole('button', { name: /Claude.*2/ });
    await userEvent.click(claude);
    expect(claude).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Showing 2 of 3')).toBeInTheDocument();
    await userEvent.click(within(provider).getByRole('button', { name: /Kimi.*1/ }));
    expect(screen.getByText('Showing 3 of 3')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: /^No current connection/ }));
    expect(screen.getByText('Showing 1 of 3')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('group', { name: 'Tests' })).getByRole('button', { name: /^Lent to test runs/ }));
    expect(screen.getByText('Showing 0 of 3')).toBeInTheDocument();
  });

  it('keeps search and filters through refreshes and only offers groups with a choice', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    lists({ 'GET /api/machines': [200, { machines: [MACHINES[0]!], builtin: null }] });
    render(<Machines me={ME} />);
    await shownTable();
    expect(screen.queryByRole('group', { name: 'Status' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox'), 'Bruno');
    await userEvent.click(within(screen.getByRole('group', { name: 'Tests' })).getByRole('button', { name: /^Lent to test runs/ }));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole('searchbox')).toHaveValue('Bruno');
    expect(within(screen.getByRole('group', { name: 'Tests' })).getByRole('button', { name: /^Lent to test runs/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Showing 1 of 1')).toBeInTheDocument();
  });

  describe('waiting before an update', () => {
    const at = (hour: number, minute: number) => new Date(2026, 10, 4, hour, minute).toISOString();
    const waiting = (turnsLeft: number, partsLeft = 0) => ({ state: 'waiting' as const, turnsLeft, partsLeft, since: at(21, 30) });
    const restarting = { state: 'restarting' as const, since: at(21, 0) };
    const onMachine = (drain: unknown, over: Partial<(typeof MACHINES)[number]> = {}): [number, unknown] => [200, { machines: [{ ...MACHINES[0]!, ...over, drain }], builtin: null }];
    /* The table's own row, not the row its open card sits in. */
    const macRow = () => screen.getAllByRole('row', { name: 'dev-laptop' }).find(row => row.getAttribute('aria-label') === 'dev-laptop')!;

    it.each([
      ['en', 'Waiting since 21:30 for agents to finish before the update: 3 turns left. It takes no new work until then', 'Waiting to update'],
      ['ru', 'С 21:30 ждет конца работы агентов перед обновлением: осталось 3 хода. До тех пор новой работы не берет', 'Ждет обновления'],
    ])('says in the card and the row how many turns are left and since when in %s', async (language, line, mark) => {
      localStorage.setItem('hh-lang', language);
      lists({ 'GET /api/machines': onMachine(waiting(3)) });
      render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
      const mac = await openCard('dev-laptop');
      expect(within(mac).getByText(line)).toBeInTheDocument();
      expect(within(macRow()).getByText(mark)).toBeInTheDocument();
    });

    it.each([
      ['en', 1, 0, 'Waiting since 21:30 for agents to finish before the update: 1 turn left. It takes no new work until then'],
      ['en', 0, 0, 'Waiting since 21:30 for agents to finish before the update: 0 turns left. It takes no new work until then'],
      ['en', 0, 1, 'Waiting since 21:30 for agents to finish before the update: 1 run part left. It takes no new work until then'],
      ['en', 2, 3, 'Waiting since 21:30 for agents to finish before the update: 2 turns and 3 run parts left. It takes no new work until then'],
      ['ru', 1, 0, 'С 21:30 ждет конца работы агентов перед обновлением: остался 1 ход. До тех пор новой работы не берет'],
      ['ru', 5, 0, 'С 21:30 ждет конца работы агентов перед обновлением: осталось 5 ходов. До тех пор новой работы не берет'],
      ['ru', 0, 1, 'С 21:30 ждет конца работы агентов перед обновлением: осталась 1 часть прогона. До тех пор новой работы не берет'],
      ['ru', 2, 5, 'С 21:30 ждет конца работы агентов перед обновлением: осталось 2 хода и 5 частей прогона. До тех пор новой работы не берет'],
    ])('words the count in %s for %i turns and %i run parts', async (language, turns, parts, line) => {
      localStorage.setItem('hh-lang', language);
      lists({ 'GET /api/machines': onMachine(waiting(turns, parts)) });
      render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
      expect(within(await openCard('dev-laptop')).getByText(line)).toBeInTheDocument();
    });

    it('follows the count by itself and drops the line when the wait is over', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      onTestFinished(() => { vi.useRealTimers(); });
      let drain: unknown = waiting(3);
      lists({ 'GET /api/machines': () => onMachine(drain) });
      render(<Machines me={ME} />);
      const mac = await openCard('dev-laptop');
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
      ['en', 'Updating now: the machine restarts and takes work again by itself', 'Updating'],
      ['ru', 'Идет обновление: машина перезапустится и сама снова возьмет работу', 'Обновляется'],
    ])('tells a restart for the update from a lost machine in %s', async (language, line, mark) => {
      localStorage.setItem('hh-lang', language);
      lists({ 'GET /api/machines': onMachine(restarting, { online: false, lastSeenAt: at(20, 59) }) });
      render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
      const mac = await openCard('dev-laptop');
      expect(within(mac).getByText(line)).toBeInTheDocument();
      expect(within(mac).queryByText(/last seen|был на связи|минут/i)).not.toBeInTheDocument();
      expect(within(macRow()).getByText(mark)).toBeInTheDocument();
    });

    it.each([[null], [undefined]])('says nothing of an update while there is no wait (%s)', async drain => {
      lists({ 'GET /api/machines': onMachine(drain) });
      render(<Machines me={ME} />);
      const mac = await openCard('dev-laptop');
      expect(within(mac).queryByText(/before the update|Updating now/)).not.toBeInTheDocument();
      expect(within(macRow()).queryByText('Waiting to update')).not.toBeInTheDocument();
    });

    it('shows the wait of the built-in node on its own card', async () => {
      lists({}, { ...BUILTIN, drain: waiting(2) } as BuiltinView);
      render(<Machines me={ME} />);
      expect(within(await openCard('Built-in node')).getByText(/Waiting since 21:30 for agents to finish before the update: 2 turns left\./)).toBeInTheDocument();
      expect(within(card('dev-laptop')).queryByText(/before the update/)).not.toBeInTheDocument();
    });

    it('shows the wait of the built-in node on the machine it runs on', async () => {
      lists({}, { ...BUILTIN, machine: { id: 'm1', hostname: 'dev-laptop' }, drain: waiting(2) } as BuiltinView);
      render(<Machines me={ME} />);
      expect(within(await openCard('dev-laptop')).getByText(/Waiting since 21:30 for agents to finish before the update: 2 turns left\./)).toBeInTheDocument();
    });
  });
});

describe("each machine's place in the company's network", () => {
  const SERVER_BOX = { ...MACHINES[1]!, id: 'm3', hostname: 'debian', owner: { id: 'p1', name: 'Ivan' }, online: true };
  const WORKER = { ...MACHINES[0]!, core: { webPort: 8081, path: 'relay' as const }, needsCore: false };
  const OLD = { ...MACHINES[1]!, owner: { id: 'p1', name: 'Ivan' }, core: null, needsCore: true };
  const server: BuiltinView = { ...BUILTIN, machine: { id: 'm3', hostname: 'debian' }, webPort: 8080, refusedBy: ['dev-laptop'] };
  const show = (extra: Parameters<typeof mockApi>[0] = {}, machines = [WORKER, OLD, SERVER_BOX]) => {
    const calls = lists({ 'GET /api/machines': [200, { machines, builtin: server }], ...extra });
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    return calls;
  };

  it.each([
    ['en', 'Company server here', 'Open here', 'debian does not take connections from dev-laptop. If debian is a Mac with its firewall on, allow incoming connections there for Docker (com.docker.backend), or for ssh when it runs Colima.'],
    ['ru', 'Здесь сервер компании', 'Открыть здесь', 'debian не принимает подключения от dev-laptop. Если на машине debian стоит macOS с включенным файрволом, разрешите на ней входящие подключения для Docker (com.docker.backend) или, если там Colima, для ssh.'],
  ])('shows in %s where the company opens on each machine, and whom the server could not take', async (language, badge, openHere, refusal) => {
    localStorage.setItem('hh-lang', language);
    show();
    const debian = await openCard('debian');
    expect(within(debian).getByText(badge)).toBeInTheDocument();
    expect(fact(debian, openHere)).toBe('localhost:8080');
    expect(within(debian).getByText(refusal)).toBeInTheDocument();
    const mac = card('dev-laptop');
    expect(fact(mac, openHere)).toBe('localhost:8081');
    expect(within(mac).queryByText(refusal)).not.toBeInTheDocument();
    /* A machine with no core has no address of its own for the company. */
    expect(within(card('build-box')).queryByText(openHere)).not.toBeInTheDocument();
  });

  it.each([
    ['en', 'Make build-box a full machine of the company', "Run this in a terminal on build-box. It adds the company's core there: the company opens on its localhost, and updates come by themselves."],
    ['ru', 'Сделать build-box полной машиной компании', 'Выполните это в терминале на build-box. Команда добавит туда ядро компании: компания откроется на localhost этой машины, а обновления будут приходить сами.'],
  ])('offers the core in %s to a machine joined before machines had one, and shows its command', async (language, action, run) => {
    localStorage.setItem('hh-lang', language);
    const id = '7'.repeat(64);
    const calls = show({ 'POST /api/machines/m2/core': [201, { id, command: `${COMMAND}-CORE`, expiresAt: new Date(Date.now() + 3600_000).toISOString() }] });
    const box = await openCard('build-box');
    /* Only a machine that needs it is offered it. */
    expect(within(card('dev-laptop')).queryByRole('button', { name: /full machine|полной машиной/ })).not.toBeInTheDocument();
    await userEvent.setup().click(within(box).getByRole('button', { name: action }));
    expect(calls).toContainEqual({ method: 'POST', path: '/api/machines/m2/core', body: undefined });
    expect(await within(box).findByText(commandCode(withKey(`${COMMAND}-CORE`)))).toBeInTheDocument();
    expect(within(box).getByText(run)).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: action })).not.toBeInTheDocument();
  });

  it('keeps a command for the core across a reload, as what it is', async () => {
    const shown = { id: '8'.repeat(64), kind: 'core' as const, plans: [], machineId: 'm2', machine: 'build-box', command: `${COMMAND}-CORE`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    show({ 'GET /api/nodes/commands': [200, { commands: [shown] }] });
    const box = await screen.findByRole('article', { name: 'build-box' });
    expect(await within(box).findByText(commandCode(withKey(shown.command)))).toBeInTheDocument();
    expect(within(box).getByText(/^Run this in a terminal on build-box\. It adds the company's core there/)).toBeInTheDocument();
  });

  it.each([
    ['en', 'Disconnect', 'If it was stolen, its owner should also revoke its Claude sign-in at claude.ai, which stays valid for a year.'],
    ['ru', 'Отключить', 'Если ее украли, владельцу нужно еще отозвать вход Claude на claude.ai: он действует год.'],
  ])('says in %s what a Disconnect cannot end, for a machine that ran Claude alone', async (language, disconnect, claude) => {
    localStorage.setItem('hh-lang', language);
    show();
    const user = userEvent.setup();
    const mac = await openCard('dev-laptop');
    await user.click(within(mac).getByRole('button', { name: new RegExp(`^${disconnect}`) }));
    expect(within(mac).getByText(new RegExp(claude.replaceAll('.', '\\.')))).toBeInTheDocument();
    const box = card('build-box');
    await user.click(within(box).getByRole('button', { name: new RegExp(`^${disconnect}`) }));
    expect(within(box).queryByText(new RegExp(claude.replaceAll('.', '\\.')))).not.toBeInTheDocument();
  });

  it('says before a machine joins what a Mac that runs the server may ask', async () => {
    lists({ 'POST /api/machines/command': [201, { id: '9'.repeat(64), command: COMMAND, expiresAt: new Date(Date.now() + 3600_000).toISOString() }] });
    render(<Machines me={ME} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Connect a machine' }));
    expect(await screen.findByText(/^If the company server runs on a Mac with its firewall on, the Mac may ask once whether Docker/)).toBeInTheDocument();
  });
});

describe("computer access on a machine's card", () => {
  /* Primary laptop with the company's core, which holds the owner's key, and the server on a machine that told its name. */
  const mac = (over: Parameters<typeof accessView>[1] = {}) => ({ ...MACHINES[0]!, core: { webPort: 8081, path: 'direct' as const }, access: accessView('dev-laptop', { ...over, machine: { id: 'm1', os: 'darwin', ...over.machine } }) });
  const box = () => ({ ...MACHINES[1]!, id: 'm3', hostname: 'debian', owner: { id: 'p1', name: 'Ivan' }, online: true });
  const server = (over: Parameters<typeof accessView>[1] = {}): BuiltinView => ({ ...BUILTIN, machine: { id: 'm3', hostname: 'debian' }, access: accessView('debian', { ...over, machine: { id: 'm-server', role: 'data', data: true, ...over.machine } }) });
  const show = (machines: ReturnType<typeof mac>[], builtin: BuiltinView, extra: Parameters<typeof mockApi>[0] = {}) => {
    const calls = lists({ 'GET /api/machines': [200, { machines: [...machines, box()], builtin }], ...extra });
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    return calls;
  };

  /* The server's machine as the server answers a change of its access, and its list that follows each change. */
  const ofServer = (over: Parameters<typeof accessView>[1] = {}) => server(over).access!;
  type Answer = () => [number, unknown];
  const showLive = (machines: ReturnType<typeof mac>[], builtin: BuiltinView, answers: Partial<Record<'open' | 'close', Answer>>) => {
    let now = builtin;
    const routes: Parameters<typeof mockApi>[0] = { 'GET /api/machines': () => [200, { machines: [...machines, box()], builtin: now }] };
    for (const [action, answer] of Object.entries(answers) as [string, Answer][]) {
      routes[`POST /api/machines/m-server/access/${action}`] = () => {
        const [status, data] = answer();
        if (status === 200) now = { ...now, access: data as ComputerAccessView };
        return [status, data];
      };
    }
    return show(machines, builtin, routes);
  };
  /* The access part of a card (#1115): its owner can close or reopen it. */
  const part = (card_: HTMLElement) => within(card_).getByRole('region', { name: /^(Computer access|Доступ к машинам)$/ });

  it('closes standing access and reopens it from the card without signing or choosing a duration', async () => {
    const calls = showLive([mac()], server(), {
      close: () => [200, ofServer({ open: false, scope: null })],
      open: () => [200, ofServer()],
    });
    const access = part(await openCard('debian'));
    expect(within(access).getByText('Access open')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(access).getByRole('button', { name: 'Close access' }));
    expect(await within(access).findByText('The owner closed access to this machine.')).toBeInTheDocument();
    await user.click(within(access).getByRole('button', { name: 'Reopen access' }));
    expect(await within(access).findByText('Access open')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(calls.filter(call => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/machines/m-server/access/close', body: undefined },
      { method: 'POST', path: '/api/machines/m-server/access/open', body: undefined },
    ]);
  });

  it('shows all-company access and lets only the owner change it, even while offline', async () => {
    show([mac({ scope: 'all_agents', canOpen: false, canClose: false })], server({ reachable: false }));
    const others = part(await openCard('dev-laptop'));
    expect(within(others).getByText('Full access for the team')).toBeInTheDocument();
    expect(within(others).getByText('Every company employee')).toBeInTheDocument();
    expect(within(others).getByText("On a Mac this reaches Docker's Linux system, not macOS itself.")).toBeInTheDocument();
    expect(within(others).queryByRole('button', { name: 'Close access' })).not.toBeInTheDocument();
    const own = part(await openCard('debian'));
    expect(within(own).getByText('The machine is offline.')).toBeInTheDocument();
    expect(within(own).getByRole('button', { name: 'Close access' })).toBeInTheDocument();
  });

  it('keeps a failed change beside its machine and retries it', async () => {
    let answers = 0;
    const calls = showLive([mac()], server({ open: false, scope: null }), {
      open: () => (++answers === 1 ? [503, { error: { code: 'unavailable', message: 'Offline.' } }] : [200, ofServer()]),
    });
    const access = part(await openCard('debian'));
    const user = userEvent.setup();
    await user.click(within(access).getByRole('button', { name: 'Reopen access' }));
    expect(await within(access).findByRole('alert')).toHaveTextContent('Access could not be changed. Check your connection and try again.');
    await user.click(within(access).getByRole('button', { name: 'Retry' }));
    expect(await within(access).findByText('Access open')).toBeInTheDocument();
    expect(calls.filter(call => call.path === '/api/machines/m-server/access/open').map(call => call.body)).toEqual([undefined, undefined]);
    expect(within(access).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows task access and the owner switch in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    show([mac({ employees: [{ employeeId: 'a1', taskId: 't1' }] })], server({ open: false, scope: null }));
    const mine = part(await openCard('dev-laptop'));
    expect(within(mine).getByText('У некоторых сотрудников также есть доступ для их задач.')).toBeInTheDocument();
    const own = part(await openCard('debian'));
    expect(within(own).getByText('Владелец закрыл доступ к этой машине.')).toBeInTheDocument();
    expect(within(own).getByRole('button', { name: 'Снова открыть доступ' })).toBeInTheDocument();
  });
});

describe('the filter groups and search of Machines (#1020)', () => {
  const showIn = (language: 'en' | 'ru') => {
    localStorage.setItem('hh-lang', language);
    lists();
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
  };

  it.each(['en', 'ru'] as const)('in %s starts Provider, Status and Tests with All N (44px, pressed by default) and resets only its own group', async language => {
    showIn(language);
    await shownTable();
    const t = { en, ru }[language];
    const cases = [
      [t.tables.provider, /^Codex/, 1],
      [t.tables.status, new RegExp(`^${t.machines.noConnection}`), 1],
      [t.tables.testFilters, new RegExp(`^${t.tables.lentFilter}`), 1],
    ] as const;

    for (const [label, option, shown] of cases) {
      const group = screen.getByRole('group', { name: label });
      const buttons = within(group).getAllByRole('button');
      expect(group).toHaveClass('whole');
      expect(buttons[0]).toHaveTextContent(`${t.tables.all}3`);
      expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(within(group).getByRole('button', { name: option }));
      expect(buttons[0]).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getAllByRole('row').slice(1)).toHaveLength(shown);
      fireEvent.click(buttons[0]!);
      expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getAllByRole('row').slice(1)).toHaveLength(3);
    }

    fireEvent.click(within(screen.getByRole('group', { name: t.tables.provider })).getByRole('button', { name: /^Claude/ }));
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(2);
    const testsGroup = screen.getByRole('group', { name: t.tables.testFilters });
    fireEvent.click(within(testsGroup).getByRole('button', { name: new RegExp(`^${t.tables.lentFilter}`) }));
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(1);
    fireEvent.click(within(testsGroup).getAllByRole('button')[0]!);
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(2);
  });

  it('sizes whole filter chips from 44x44px, frames chosen and focused ones by tokens, and uses logical RTL properties', () => {
    expect(decl('.fgroup.whole .chipf', 'min-block-size')).toBe('44px');
    expect(decl('.fgroup.whole .chipf', 'min-inline-size')).toBe('44px');
    expect(decl('.fgroup.whole .chipf', 'max-inline-size')).toBe('100%');
    expect(decl('.fgroup.whole .chipf', 'padding-block')).toBe('8px');
    expect(decl('.fgroup.whole .chipf', 'padding-inline')).toBe('12px');
    expect(decl('.fgroup.whole .chipf', 'text-align')).toBe('start');
    expect(decl('.fgroup.whole .chipf', 'overflow-wrap')).toBe('break-word');
    expect(decl('.fgroup.whole .chipf[aria-pressed="true"]', 'border-color')).toBe('var(--cyan-ink)');
    expect(decl('.chipf[aria-pressed="true"]', 'background')).toBe('var(--glow)');
    expect(decl('.chipf[aria-pressed="true"]', 'color')).toBe('var(--cyan-ink)');
    expect(decl('.chipf:focus-visible', 'outline')).toBe('2px solid var(--cyan-ink)');
    expect(decl('.chipf:focus-visible', 'outline-offset')).toBe('2px');
    expect(decl('.fgroup > .lbl', 'margin-inline-end')).toBe('4px');
    expect(decl('.fgroup > .lbl', 'margin-right')).toBeUndefined();
    expect(decl('.chipf', 'padding-inline')).toBe('9px');
    expect(decl('.chipf', 'padding')).toBeUndefined();
    expect(decl('.people.machines', 'padding-inline', '(min-width: 1200px)')).toBe('32px');
  });

  it.each([
    ['en', true, 'Search machines'],
    ['ru', true, 'Поиск машин'],
    ['en', false, 'Search by machine, owner, agent or role'],
  ] as const)('in %s (narrow=%s) uses the phone or wide search hint', async (language, narrow, placeholder) => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: narrow, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    onTestFinished(() => { vi.unstubAllGlobals(); });
    showIn(language);
    expect(await screen.findByRole('searchbox')).toHaveAttribute('placeholder', placeholder);
  });

  it('builds pool figures and row counts from whole parameterized dictionary phrases without piece-by-piece concatenation', () => {
    const enSource = readFileSync(resolve(process.cwd(), 'src/i18n/en.ts'), 'utf8');
    const ruSource = readFileSync(resolve(process.cwd(), 'src/i18n/ru.ts'), 'utf8');
    const machinesSource = readFileSync(resolve(process.cwd(), 'src/screens/Machines.tsx'), 'utf8');

    expect(enSource).not.toMatch(/(machineCount|subscriptionCount)[^\n]*\$\{n\}\s+\$\{plural\(/);
    expect(ruSource).not.toMatch(/(machineCount|subscriptionCount)[^\n]*\$\{n\}\s+\$\{plural\(/);
    expect(machinesSource).not.toContain('t.machines.of(String(');
    expect(machinesSource).not.toMatch(/\$\{busyShare\([^)]*\)\}%\`/);

    expect([1, 3].map(n => en.tables.machineCount(n))).toEqual(['1 machine', '3 machines']);
    expect([1, 2, 5, 21].map(n => ru.tables.machineCount(n))).toEqual(['1 машина', '2 машины', '5 машин', '21 машина']);
    expect([1, 3].map(n => en.tables.subscriptionCount(n))).toEqual(['1 subscription', '3 subscriptions']);
    expect([1, 2, 5, 21].map(n => ru.tables.subscriptionCount(n))).toEqual(['1 подписка', '2 подписки', '5 подписок', '21 подписка']);

    expect(en.machines.of(2, 3)).toBe('2 of 3');
    expect(ru.machines.of(2, 3)).toBe('2 из 3');
    expect(en.machines.percent(21)).toBe('21%');
    expect(ru.machines.percent(21)).toBe('21%');
  });

  it.each([
    ['en', ['2 of 3', '12', '8.5 of 20 GB', '21%'], '3 machines', 'Showing 1 of 3', '6 of 12 GB'],
    ['ru', ['2 из 3', '12', '8,5 из 20 ГБ', '21%'], '3 машины', 'Показано 1 из 3', '6 из 12 ГБ'],
  ] as const)('isolates whole summary figures and counts in <bdi> in %s under RTL', async (language, poolFigures, totalCount, shownCount, laptopMemory) => {
    document.documentElement.dir = 'rtl';
    onTestFinished(() => { document.documentElement.removeAttribute('dir'); });
    showIn(language);
    await shownTable();
    const t = { en, ru }[language];
    /* The phones under the machines have loaded, so the machines' count is the one status line. */
    await screen.findByText(t.phones.empty);

    const pool = screen.getByRole('region', { name: t.machines.pool });
    const figures = [...pool.querySelectorAll('.pool-facts dd')];
    expect(figures.map(dd => [dd.children.length, dd.firstElementChild?.tagName, dd.firstElementChild?.textContent])).toEqual(
      poolFigures.map(text => [1, 'BDI', text]),
    );

    const statusLine = screen.getByRole('status');
    expect([statusLine.children.length, statusLine.firstElementChild?.tagName, statusLine.firstElementChild?.textContent]).toEqual([1, 'BDI', totalCount]);

    const laptopRow = screen.getByRole('row', { name: 'dev-laptop' });
    expect(within(laptopRow).getByText(laptopMemory).tagName).toBe('BDI');
    expect(within(laptopRow).getByText('25%').tagName).toBe('BDI');

    fireEvent.click(within(screen.getByRole('group', { name: t.tables.provider })).getByRole('button', { name: /^Codex/ }));
    expect([statusLine.firstElementChild?.tagName, statusLine.firstElementChild?.textContent]).toEqual(['BDI', shownCount]);
    expect(within(statusLine).getByRole('button', { name: t.tables.clear })).toBeInTheDocument();
  });

  it('marks the held pool as a direct .held-pool child beside .held-table when the initial load fails', async () => {
    lists({ 'GET /api/machines': [500, { error: { code: 'internal', message: 'Something went wrong.' } }] });
    const { container } = render(<Machines me={ME} />);
    await screen.findByRole('alert');
    const page = container.querySelector('section.machines')!;
    const children = [...page.children];
    expect(children.some(el => el.classList.contains('held-pool'))).toBe(true);
    const heldTable = children.find(el => el.classList.contains('held-table'));
    expect(heldTable?.querySelector('.load-fail[role="alert"]')).not.toBeNull();
  });
});
