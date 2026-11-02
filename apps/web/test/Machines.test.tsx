import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Machines } from '../src/screens/Machines';
import type { BuiltinView, Me } from '../src/types';
import { MACHINES, ME, mockApi, SUBS } from './api-mock';

const COMMAND = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join CODE123';
const GIB = 1024 ** 3;
/* An older built-in node, which says nothing of its processor or disk. */
const BUILTIN: BuiltinView = {
  online: true,
  load: { cpus: 4, load: 0.5, memFree: 2.5 * GIB, memTotal: 8 * GIB, tests: 0, jobs: 1 },
  running: { agents: [{ id: 'o1', name: 'Orchestrator', busy: false }], parts: [] },
};

const lists = (extra: Parameters<typeof mockApi>[0] = {}, builtin: BuiltinView | null = BUILTIN) =>
  mockApi({ 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: MACHINES, builtin }], ...extra });

const card = (name: string) => screen.getByRole('article', { name });
/* The value next to a label in a machine's card or in the pool. */
const fact = (within_: HTMLElement, label: string) => within(within_).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

afterEach(() => localStorage.clear());

describe('Machines', () => {
  it('shows the whole pool: machines online of all, processor cores, free memory and how busy it is now', async () => {
    lists();
    render(<Machines me={ME} />);
    const pool = await screen.findByRole('region', { name: 'All machines together' });
    expect(fact(pool, 'Machines online')).toBe('2 of 3');
    expect(fact(pool, 'Processor cores')).toBe('12');
    expect(fact(pool, 'Free memory')).toBe('8.5 of 20 GB');
    expect(fact(pool, 'Busy now')).toBe('21%');
  });

  it('shows each machine with its owner, system, processor, memory, load, disk and plans', async () => {
    lists();
    render(<Machines me={ME} />);
    const mac = await screen.findByRole('article', { name: 'ivan-mbp' });
    expect(within(mac).getByText('Online')).toBeInTheDocument();
    expect(fact(mac, 'Owner')).toBe('Ivan');
    expect(fact(mac, 'System')).toBe('macOS, arm64');
    expect(fact(mac, 'Processor')).toBe('Apple M2 Pro, 8 of 10 cores');
    expect(fact(mac, 'Memory')).toBe('6 of 12 GB free, the machine has 32 GB');
    expect(within(mac).getByText('Docker on this Mac is set smaller than the Mac, so Hornhoof uses only part of it.')).toBeInTheDocument();
    expect(fact(mac, 'Load')).toBe('25%');
    expect(fact(mac, 'Disk')).toBe('120 of 460 GB free');
    const plans = within(within(mac).getByRole('list', { name: 'Plans on ivan-mbp' })).getAllByRole('listitem');
    expect(plans.map(p => p.textContent)).toEqual(['Claude', 'Codex, waiting for the login']);
  });

  it('says what runs on a machine now: its employees and the parts of test runs', async () => {
    lists();
    render(<Machines me={ME} />);
    const mac = await screen.findByRole('article', { name: 'ivan-mbp' });
    const now = within(within(mac).getByRole('list', { name: 'What runs on ivan-mbp now' })).getAllByRole('listitem');
    expect(now.map(p => p.textContent)).toEqual(['Bruno, working', 'Vera', 'Tests of task 12, part 1 of 2']);
    expect(fact(card('build-box'), 'Running now')).toBe('Nothing right now');
  });

  it('says unknown for what an offline or older machine has not told, and that it has no plan', async () => {
    lists();
    render(<Machines me={ME} />);
    const box = await screen.findByRole('article', { name: 'build-box' });
    expect(within(box).getByText('Last seen 5 minutes ago')).toBeInTheDocument();
    expect(fact(box, 'System')).toBe('Linux, x86_64');
    for (const label of ['Processor', 'Memory', 'Load', 'Disk']) expect(fact(box, label)).toBe('unknown');
    expect(fact(box, 'Plans')).toBe('No plan');
    const own = card('Built-in node');
    expect(fact(own, 'Processor')).toBe('4 cores');
    expect(fact(own, 'Memory')).toBe('2.5 of 8 GB free');
    expect(fact(own, 'Disk')).toBe('unknown');
    expect(within(own).queryByRole('button')).not.toBeInTheDocument();
    expect(within(own).getByTitle('The company server runs on this machine now')).toHaveTextContent('Leader');
    expect(within(box).queryByText('Leader')).not.toBeInTheDocument();
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
    expect(within(mac).getByText("The server runs here too, with its built-in node for the company's keys and test runs.")).toBeInTheDocument();
    expect(within(within(mac).getByRole('list', { name: 'What runs on ivan-mbp now' })).getByText('Orchestrator')).toBeInTheDocument();
    expect(screen.getAllByRole('article').map(a => a.getAttribute('aria-label'))).toEqual(['ivan-mbp', 'build-box']);
    expect(within(card('build-box')).queryByText(/built-in node/)).not.toBeInTheDocument();
    expect(within(mac).getByTitle('The company server runs on this machine now')).toHaveTextContent('Leader');
    expect(within(card('build-box')).queryByText('Leader')).not.toBeInTheDocument();
  });

  it('shows no built-in node and no pool part of it to those who do not see the whole company', async () => {
    lists({}, null);
    const lead: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };
    render(<Machines me={lead} />);
    const pool = await screen.findByRole('region', { name: 'All machines together' });
    expect(fact(pool, 'Machines online')).toBe('1 of 2');
    expect(screen.queryByRole('article', { name: 'Built-in node' })).not.toBeInTheDocument();
  });

  it('connects a machine without a plan and shows its command', async () => {
    const calls = lists({ 'POST /api/machines/command': [201, { command: COMMAND }] });
    const user = userEvent.setup();
    render(<Machines me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Connect a machine' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/machines/command', body: undefined });
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();
    expect(screen.getByText(/joins without a plan/)).toBeInTheDocument();
    expect(screen.getByText("Hornhoof will run tests of the company's code on this machine. People with access to this Hornhoof can start them.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(COMMAND)).not.toBeInTheDocument();
  });

  it("adds one of the person's plans to a machine of theirs and shows the command to run there", async () => {
    const calls = lists({ 'POST /api/machines/m1/plans': [201, { command: COMMAND }] });
    const user = userEvent.setup();
    render(<Machines me={ME} />);
    const mac = await screen.findByRole('article', { name: 'ivan-mbp' });
    expect(within(card('build-box')).queryByRole('button', { name: /^Add my plan/ })).not.toBeInTheDocument();
    await user.click(within(mac).getByRole('button', { name: 'Add my plan to ivan-mbp' }));
    expect(screen.getByText('Which of your plans should run on ivan-mbp too?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Claude to ivan-mbp' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add Kimi to ivan-mbp' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/machines/m1/plans', body: { subscription: 's-kimi' } });
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();
    expect(screen.getByText(/^Run this in a terminal on ivan-mbp\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(COMMAND)).not.toBeInTheDocument();
  });

  it('disconnects a machine after a confirm', async () => {
    const calls = lists({ 'POST /api/machines/m2/disconnect': [204] });
    const user = userEvent.setup();
    render(<Machines me={ME} />);
    await user.click(within(await screen.findByRole('article', { name: 'build-box' })).getByRole('button', { name: 'Disconnect build-box' }));
    expect(screen.getByText('Disconnect build-box? Everything on it stops, and a plan that runs nowhere else waits for a machine again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/machines/m2/disconnect', body: undefined });
  });

  it("lends a machine to the company's test runs, or takes it back, for its owner or someone who sees the whole company", async () => {
    const calls = lists({ 'PATCH /api/machines/m1': [200, { lendsTests: false }] });
    const user = userEvent.setup();
    render(<Machines me={ME} />);
    const lend = within(await screen.findByRole('article', { name: 'ivan-mbp' })).getByRole('checkbox', { name: "Lend ivan-mbp to the company's test runs" });
    expect(lend).toBeChecked();
    expect(within(card('build-box')).getByRole('checkbox')).not.toBeChecked();
    await user.click(lend);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/machines/m1', body: { lendsTests: false } }));
  });

  it("shows another person's machine as lent or not, without the switch", async () => {
    lists({}, null);
    const lead: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };
    render(<Machines me={lead} />);
    const maria = await screen.findByRole('article', { name: 'build-box' });
    expect(within(maria).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(maria).getByText('Not lent to test runs')).toBeInTheDocument();
    expect(within(card('ivan-mbp')).getByRole('checkbox')).toBeChecked();
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
    expect(fact(mac, 'Процессор')).toBe('Apple M2 Pro, 8 из 10 ядер');
    expect(fact(mac, 'Память')).toBe('Свободно 6 из 12 ГБ, у машины 32 ГБ');
    expect(within(mac).getByText('Docker на этом Mac настроен меньше самого Mac, поэтому Hornhoof использует только часть.')).toBeInTheDocument();
    expect(fact(mac, 'Диск')).toBe('Свободно 120 из 460 ГБ');
    const now = within(within(mac).getByRole('list', { name: 'Что сейчас идет на ivan-mbp' })).getAllByRole('listitem');
    expect(now.map(p => p.textContent)).toEqual(['Bruno, работает', 'Vera', 'Тесты задачи 12, часть 1 из 2']);
    const box = card('build-box');
    expect(fact(box, 'Подписки')).toBe('Без подписки');
    expect(fact(box, 'Процессор')).toBe('неизвестно');
    expect(fact(card('Встроенная нода'), 'Процессор')).toBe('4 ядра');
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
    expect(within(card('ivan-mbp')).getByTitle('Сервер компании сейчас работает на этой машине')).toHaveTextContent('Ведущая');
    expect(within(card('build-box')).queryByText('Ведущая')).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Встроенная нода' })).not.toBeInTheDocument();
  });
});
