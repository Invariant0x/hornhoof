import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { heardAgain } from '../src/live';
import { AgentWindow } from '../src/screens/AgentWindow';
import type { EventView, Me, Org, ShownCommand } from '../src/types';
import { accessView, CARD, DEV_ORG, ME, mockApi, ORG, ROSTER, SUBS, withKey } from './api-mock';
import { fakeStream } from './fake-stream';
import { commandCode } from './command-code';

/* xterm needs a real canvas; the window only has to know the terminal is there. */
vi.mock('../src/ui/AgentTerminal', () => ({
  AgentTerminal: () => (
    <div data-testid="live-terminal">
      <textarea className="xterm-helper-textarea" aria-label="Terminal input" />
    </div>
  ),
}));

const EVENTS = '/api/agents/orchestrator/events';

const READY = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };
const BUSY = { ...READY, busy: true, runningJobId: 'j1' };
/* A person who last chose the terminal in this browser: the window opens with it. */
const chooseTerminal = () => localStorage.setItem('hh-agent-view', 'terminal');

const ev = (seq: number, kind: EventView['kind'], data: unknown, extra: Partial<EventView> = {}): EventView => ({ seq, kind, data, jobId: 'j1', person: null, at: '2026-10-29T10:00:00Z', ...extra });
const line = (seq: number) => ev(seq, 'text', { kind: 'text', text: `Line ${seq}` });
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
const IVAN = { id: 'p1', name: 'Ivan' };

const LOG: EventView[] = [
  ev(1, 'message', { text: 'We make characters for schools' }, { person: IVAN }),
  ev(2, 'text', { kind: 'text', text: 'What matters most right now?' }),
  ev(3, 'tool', { kind: 'tool', name: 'hornhoof.company', input: '{}' }),
  ev(4, 'tool_result', { kind: 'tool_result', ok: true, summary: 'Acme, 1 person' }),
  ev(5, 'todo', { kind: 'todo', items: [{ text: 'Ask about products', state: 'done' }, { text: 'Propose departments', state: 'doing' }] }),
  ev(6, 'proposal', { proposalId: 'pr1', brief: 'Acme.', items: [{ template: 'operations', checked: true, note: 'Tools' }] }),
  ev(7, 'applied', { proposalId: 'pr1', created: [{ id: 'd1', template: 'operations', name: null, products: [] }, { id: 'd2', template: 'development', name: null, products: ['Mascot', 'Characters'] }], removed: [{ id: 'd3', template: 'finance', name: null }] }, { person: IVAN }),
  ev(8, 'failed', { error: 'timeout' }),
  ev(9, 'stopped', {}),
];

function open(routes: Record<string, unknown> = {}, org: Org = ORG, agentId = 'orchestrator') {
  const calls = mockApi({
    'GET /api/agents/b1': [200, CARD],
    'GET /api/agents/orchestrator': [200, { ...CARD, id: ORG.orchestrator!.id, kind: 'orchestrator', name: 'Orchestrator' }],
    [`GET /api/agents/${agentId}/events?last=300`]: [200, { events: [], state: READY }],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
    ...(routes as Record<string, [number, unknown]>),
  });
  const onClose = vi.fn();
  const view = render(
    <LanguageProvider>
      <AgentWindow me={ME} org={org} agentId={agentId} onClose={onClose} />
    </LanguageProvider>,
  );
  return { calls, onClose, ...view };
}

describe('AgentWindow', () => {
  it("sends a correction of the orchestrator's card to the live terminal, where its owner writes", async () => {
    const user = userEvent.setup();
    chooseTerminal();
    const card = ev(1, 'proposal', { proposalId: 'pr1', brief: 'Acme.', items: [{ template: 'operations', checked: true, note: '' }] });
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [card], state: { ...READY, terminal: true, canType: true } }] });
    await user.click(await screen.findByRole('button', { name: 'Correct in words' }));
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveFocus();
  });

  it('leaves typing to the live terminal the person chose, and keeps the line in the chat', async () => {
    const user = userEvent.setup();
    chooseTerminal();
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, terminal: true, canType: true } }] });
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Write to the orchestrator' })).not.toBeInTheDocument();
    expect(screen.queryByText('Enter to send, Shift+Enter for a new line')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByRole('textbox', { name: 'Write to the orchestrator' })).toBeInTheDocument();
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it('keeps program state history out of the conversation without blank lines', async () => {
    const { container } = open({ [`GET ${EVENTS}?last=300`]: [200, { events: [
      ev(1, 'text', { text: 'Starting checkout.' }),
      ev(2, 'program', { program: { state: 'thinking', since: Date.parse('2026-11-03T10:00:00Z'), tool: null }, alarm: null }),
      ev(3, 'text', { text: 'Checkout is ready.' }),
    ], state: READY }] });
    expect(await screen.findByText('Checkout is ready.')).toBeInTheDocument();
    expect(screen.getByText('Starting checkout.')).toBeInTheDocument();
    expect(container.querySelectorAll('.t-line')).toHaveLength(2);
  });

  it('shows each kind of line in the chat, the steps of work folded into one', async () => {
    const { container } = open({ [`GET ${EVENTS}?last=300`]: [200, { events: LOG, state: READY }] });
    expect(await screen.findByText('What matters most right now?')).toBeInTheDocument();
    expect(within(screen.getByText('We make characters for schools').closest('article')!).getByText('You')).toBeInTheDocument();
    expect(screen.queryByText('hornhoof.company')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2 steps of work' }));
    expect(container.querySelector('.t-t')).toHaveTextContent('hornhoof.company({})');
    expect(container.querySelector('.t-r')).toHaveTextContent('⎿Acme, 1 person');
    expect(screen.getByText('Ask about products').parentElement).toHaveTextContent('☒ Ask about products');
    expect(screen.getByText('Propose departments').tagName).toBe('B');
    expect(screen.queryByText('Company structure')).not.toBeInTheDocument();
    expect(screen.getByText('Created: Operations')).toBeInTheDocument();
    expect(screen.getByText('Created: Development, 2 products')).toBeInTheDocument();
    expect(screen.getByText('Removed: Finance')).toBeInTheDocument();
    expect(screen.getByText('The orchestrator did not finish within 15 minutes.')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it('says plainly when a turn did not go out because the instructions are too long', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [ev(1, 'failed', { error: 'instructions_too_long' }), ev(2, 'failed', { error: 'node_too_old' })], state: READY }] });
    expect(await screen.findByText('The instructions are longer than one turn can carry. Shorten the role or a skill on the card.')).toBeInTheDocument();
    expect(screen.getByText("This machine's node is too old for these instructions; update it.")).toBeInTheDocument();
  });

  it("names Hornhoof for the turns it starts on a task", async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [ev(1, 'message', { text: '#4 "Payments" is yours.', task: { id: 't4', number: 4 } })], state: READY }] });
    const line = (await screen.findByText('#4 "Payments" is yours.')).closest('article')!;
    expect(within(line).getByText('Hornhoof')).toBeInTheDocument();
  });

  it('names the orchestrator for what it wrote to an employee', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [ev(1, 'message', { text: 'Look at checkout first.', from: 'orchestrator' })], state: READY }] });
    const line = (await screen.findByText('Look at checkout first.')).closest('article')!;
    expect(within(line).getByText('Orchestrator')).toBeInTheDocument();
  });

  it('names the employee who wrote, as one does on a timer round', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [ev(1, 'message', { text: 'Report on #4, please.', from: 'agent', name: 'Wendy' })], state: READY }] });
    const line = (await screen.findByText('Report on #4, please.')).closest('article')!;
    expect(within(line).getByText('Wendy')).toBeInTheDocument();
  });

  it('shows his answers with bold and lists, and hides how Claude loads its tools', async () => {
    const { container } = open({
      [`GET ${EVENTS}?last=300`]: [
        200,
        {
          events: [
            ev(1, 'tool', { kind: 'tool', name: 'ToolSearch', input: '{"query":"select:mcp__hornhoof__company"}' }),
            ev(2, 'tool_result', { kind: 'tool_result', ok: true, summary: '' }),
            ev(3, 'tool', { kind: 'tool', name: 'hornhoof.company', input: '{}' }),
            ev(4, 'tool_result', { kind: 'tool_result', ok: true, summary: 'Acme, 1 person' }),
            ev(5, 'text', { kind: 'text', text: 'Five departments:\n- **Operations**: tools\n- Sales' }),
          ],
          state: READY,
        },
      ],
    });
    expect(await screen.findByText('Operations')).toHaveProperty('tagName', 'STRONG');
    expect(container.querySelectorAll('.chat-body ul > li')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '1 step of work' }));
    expect(screen.queryByText('ToolSearch')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.t-r')).toHaveLength(1);
    expect(container.querySelector('.t-r')).not.toHaveClass('alone');
  });

  it('speaks Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      open({ [`GET ${EVENTS}?last=300`]: [200, { events: LOG, state: READY }] });
      expect(await screen.findByText('Создан отдел: Разработка, 2 продукта')).toBeInTheDocument();
      expect(screen.getByText('Убран отдел: Финансы')).toBeInTheDocument();
      expect(screen.getByText('Остановлен')).toBeInTheDocument();
      expect(screen.getByText('Оркестратор не закончил за 15 минут.')).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('greets on the first open by asking the server to start', async () => {
    const { calls } = open();
    await vi.waitFor(() => expect(calls.map(c => `${c.method} ${c.path}`)).toContain('POST /api/agents/orchestrator/start'));
    expect(calls[0]).toMatchObject({ method: 'GET', path: `${EVENTS}?last=300` });
  });

  it('sends on Enter and keeps Shift+Enter for a new line', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'POST /api/agents/orchestrator/messages': [202, { jobId: 'j2' }] });
    const input = await screen.findByLabelText('Write to the orchestrator');
    await vi.waitFor(() => expect(input).toBeEnabled());
    await user.type(input, 'Schools first{Shift>}{Enter}{/Shift}');
    expect(calls.some(c => c.path === '/api/agents/orchestrator/messages')).toBe(false);
    await user.type(input, 'then parents{Enter}');
    await vi.waitFor(() => expect(calls.find(c => c.path === '/api/agents/orchestrator/messages')?.body).toEqual({ text: 'Schools first\nthen parents' }));
    expect(input).toHaveValue('');
  });

  it('puts a message that could not be sent back in the line, unless the person already started the next one', async () => {
    const user = userEvent.setup();
    let fail = () => {};
    open({ 'POST /api/agents/orchestrator/messages': () => new Promise(resolve => (fail = () => resolve([503, { error: { code: 'unavailable', message: 'Not now.' } }]))) });
    const input = await screen.findByLabelText('Write to the orchestrator');
    await vi.waitFor(() => expect(input).toBeEnabled());
    await user.type(input, 'Schools first{Enter}');
    expect(input).toHaveValue('');
    await act(async () => {
      fail();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Not now.');
    expect(input).toHaveValue('Schools first');
    await user.type(input, '{Enter}');
    expect(input).toHaveValue('');
    await user.type(input, 'then parents');
    await act(async () => {
      fail();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Not now.');
    expect(input).toHaveValue('then parents');
  });

  it('shows that he works and stops him on Esc', async () => {
    const { calls } = await act(async () => open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...BUSY, queued: 2 } }], 'POST /api/agents/orchestrator/stop': [202] }));
    expect(screen.getByRole('status', { name: 'Agent state' })).toHaveTextContent('Working on it');
    expect(screen.getByText('2 more messages wait their turn')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/agents/orchestrator/stop')).toBe(true);
  });

  it('says why he cannot answer and offers the card by hand', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, ready: false, reason: 'needs_login' } }] });
    expect(await screen.findByText('Waiting for the Anthropic login')).toBeInTheDocument();
    expect(screen.getByLabelText('Write to the orchestrator')).toBeDisabled();
    expect(screen.getByText('Company structure')).toBeInTheDocument();
    /* Eleven departments to tick, and the tick that brings their people. */
    expect(screen.getAllByRole('checkbox')).toHaveLength(12);
  });

  it.each([
    [{ state: 'waiting', turnsLeft: 2, partsLeft: 0, until: '2026-11-04T21:30:00.000Z' }],
    [{ state: 'restarting', since: '2026-11-04T21:00:00.000Z' }],
  ])('says that turns wait while the machine gets ready for an update, and he can still be written to (%j)', async machineDrain => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, machineDrain } }] });
    expect(await screen.findByText('The machine is finishing its work before an update. New turns wait and go on by themselves after it.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('says that turns wait while the machine reports a shortage of memory, and he can still be written to', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, memoryWait: true } }] });
    expect(await screen.findByText('The machine reported a shortage of memory. Turns wait and go on by themselves once it reports none, and what already runs there goes on.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('says nothing of the memory while the machine reports no shortage', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, memoryWait: false } }] });
    await screen.findByRole('textbox');
    expect(screen.queryByText(/shortage of memory/)).not.toBeInTheDocument();
  });

  it('says that his plan is at its limit and that his turns wait until it starts over', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, limitUntil: '2026-10-31T19:20:00Z' } }] });
    expect(await screen.findByText(/^The plan is at its limit\. Turns wait until .+ and go on by themselves then\.$/)).toBeInTheDocument();
    expect(screen.getByLabelText('Write to the orchestrator')).not.toBeDisabled();
  });

  it("says that the plan used its share for tasks, and that only task turns wait", async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, budgetUntil: '2026-10-31T19:20:00Z' } }] });
    expect(await screen.findByText(/^The plan used the share set for tasks\. Task turns wait until .+; messages from people still go\.$/)).toBeInTheDocument();
  });

  it('says he waits for the first setup of the program on his plan', async () => {
    const plan = { ...SUBS[0]!, provider: 'antigravity' as const, owner: { id: 'p1', name: 'Ivan' } };
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, ready: false, reason: 'needs_setup' } }] }, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: plan } });
    expect(await screen.findByText('Waiting for the first setup of Antigravity')).toBeInTheDocument();
  });

  it('says he needs a plan when his plan is gone while his state still names its wait', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, ready: false, reason: 'needs_setup' } }] }, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: null } });
    expect(await screen.findByText('Needs a subscription to start')).toBeInTheDocument();
  });

  it('tells to update Hornhoof on a machine too old to run his turns', async () => {
    const mac = { ...SUBS[1]!, kind: 'personal' as const, owner: { id: 'p1', name: 'Ivan' } };
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, ready: false, reason: 'node_outdated' } }] }, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: mac } });
    expect(await screen.findByText("Hornhoof on Ivan's machine is out of date. Run the install command there again.")).toBeInTheDocument();
  });

  it('warns that browser checks cannot run on a personal or built-in machine while keeping the message input open', async () => {
    const mac = { ...SUBS[1]!, kind: 'personal' as const, owner: { id: 'p1', name: 'Ivan' } };
    const view = open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, browserError: 'libnss3.so missing' } }] }, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: mac } });
    expect(await screen.findByText("Browser checks cannot run on Ivan's machine right now (libnss3.so missing).")).toBeInTheDocument();
    expect(screen.getByLabelText('Write to the orchestrator')).not.toBeDisabled();
    view.unmount();
    const key = { ...SUBS[0]!, kind: 'api_key' as const };
    const builtin = open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, browserError: 'libnss3.so missing' } }] }, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: key } });
    expect(await screen.findByText('Browser checks cannot run on the built-in machine right now (libnss3.so missing).')).toBeInTheDocument();
    expect(screen.getByLabelText('Write to the orchestrator')).not.toBeDisabled();
    builtin.unmount();
    localStorage.setItem('hh-lang', 'ru');
    try {
      const ruPersonal = open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, browserError: 'libnss3.so missing' } }] }, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: mac } });
      expect(await screen.findByText('Браузерные проверки на машине (владелец Ivan) сейчас не пойдут (libnss3.so missing).')).toBeInTheDocument();
      ruPersonal.unmount();
      open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, browserError: 'libnss3.so missing' } }] }, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: null } });
      expect(await screen.findByText('Браузерные проверки на встроенной машине сейчас не пойдут (libnss3.so missing).')).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('names the machine he runs on', async () => {
    const plan = { ...SUBS[0]!, owner: { id: 'p1', name: 'Ivan' } };
    open({}, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: plan, machine: { id: 'm3', hostname: 'work-laptop' } } });
    expect((await screen.findAllByText(/, work-laptop$/)).length).toBeGreaterThan(0);
  });

  it('shows the CEO alone the machine command he asked Hornhoof for, next to his terminal, until the CEO closes it', async () => {
    const user = userEvent.setup();
    const command = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join CODE123';
    const shown: ShownCommand = { id: 'a'.repeat(64), kind: 'add', plans: ['Claude'], machine: 'work-laptop', command, expiresAt: '2026-11-02T10:00:00Z' };
    const { calls } = open({
      [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, terminal: true, canType: true } }],
      'GET /api/nodes/commands': [200, { commands: [shown] }],
      [`POST /api/nodes/commands/${shown.id}/hide`]: [204],
    });
    const card = await screen.findByRole('region', { name: 'Command to add Claude to work-laptop' });
    expect(await within(card).findByText(commandCode(withKey(command)))).toBeInTheDocument();
    expect(within(card).queryByText(en.machines.computerConsent)).not.toBeInTheDocument();
    expect(within(card).getByText(/^Run this in a terminal on work-laptop\./)).toBeInTheDocument();
    expect(within(card).getByText('The orchestrator asked Hornhoof for this command, and only you see it. It works once, for 24 hours.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Done' }));
    expect(calls).toContainEqual({ method: 'POST', path: `/api/nodes/commands/${shown.id}/hide`, body: undefined });
    await vi.waitFor(() => expect(screen.queryByText(commandCode(command))).not.toBeInTheDocument());
  });

  it.each(['pending', 'refused'] as const)('dismisses the agent command while the hide request is %s and keeps it closed on refresh', async state => {
    const user = userEvent.setup();
    fakeStream();
    const command: ShownCommand = {
      id: 'd'.repeat(64), kind: 'add', plans: ['Codex'], machine: 'work-laptop',
      command: 'fixture command', expiresAt: '2099-01-01T00:00:00Z',
    };
    const other: ShownCommand = { ...command, id: 'e'.repeat(64), plans: ['Claude'] };
    let commands = [command];
    const { calls } = open({
      'GET /api/nodes/commands': () => [200, { commands }],
      [`POST /api/nodes/commands/${command.id}/hide`]: state === 'pending'
        ? () => new Promise(() => {})
        : [409, { error: { code: 'conflict', reason: 'other_machine', message: 'Command for another machine.' } }],
    });
    const title = 'Command to add Codex to work-laptop';
    await user.click(within(await screen.findByRole('region', { name: title })).getByRole('button', { name: 'Done', exact: true }));
    expect(screen.queryByRole('region', { name: title })).not.toBeInTheDocument();
    expect(calls).toContainEqual({ method: 'POST', path: `/api/nodes/commands/${command.id}/hide`, body: undefined });

    commands = [command, other];
    act(heardAgain);
    expect(await screen.findByRole('region', { name: 'Command to add Claude to work-laptop' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: title })).not.toBeInTheDocument();
  });

  it('names each kind of machine command in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      const made = (id: string, kind: ShownCommand['kind'], plans: string[], machine: string | null): ShownCommand => ({ id: id.repeat(64), kind, plans, machine, command: `curl ${id}`, expiresAt: '2026-11-02T10:00:00Z' });
      open({ 'GET /api/nodes/commands': [200, { commands: [made('a', 'machine', [], null), made('b', 'plans', ['Claude', 'Codex'], null), made('c', 'add', ['Kimi'], 'work-laptop')] }] });
      expect(await screen.findByRole('region', { name: 'Команда для подключения машины' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Команда для подключения: Claude, Codex' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Команда, чтобы добавить Kimi на work-laptop' })).toBeInTheDocument();
      expect(screen.getAllByText('Оркестратор попросил эту команду у Hornhoof, и видите ее только вы. Она работает один раз, 24 часа.')).toHaveLength(3);
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it.each(['company', 'listed'] as const)('asks for no CEO machine commands for a %s viewer who is not the owner', async scopeKind => {
    const calls = mockApi({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: READY }], 'POST /api/agents/orchestrator/start': [200, { started: false }] });
    const viewer: Me = { ...ME, person: { ...ME.person, id: 'p2', isOwner: false, scopeKind }, canDecideCompany: false };
    render(<AgentWindow me={viewer} org={ORG} agentId="orchestrator" onClose={vi.fn()} />);
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/nodes/commands' || c.path === '/api/computer' || c.path === '/api/machines/access')).toBe(false);
  });

  describe.each(['orchestrator', 'b1'])('computer access in the %s window', agentId => {
    const accessStates = [
      { state: 'one open machine', views: [accessView('node-a')] },
      { state: 'two open machines', views: [accessView('node-a'), accessView('node-b')] },
      { state: 'one closed machine', views: [accessView('node-a', { open: false, scope: null })] },
      { state: 'two closed machines', views: [accessView('node-a', { open: false, scope: null }), accessView('node-b', { open: false, scope: null })] },
    ];

    it.each(accessStates)('keeps the memory note without an access note or link in terminal and chat with $state', async ({ views }) => {
      chooseTerminal();
      await act(async () => {
        open({
          [`GET /api/agents/${agentId}/events?last=300`]: [200, { events: [], state: { ...READY, terminal: true, canType: true, memoryWait: true } }],
          'GET /api/machines/access': [200, { views }],
        }, DEV_ORG, agentId);
      });
      const foot = () => within(screen.getByRole('group', { name: en.window.notes.label }));
      expect(screen.getByTestId('live-terminal')).toBeInTheDocument();
      expect(foot().getByText(en.window.memoryWait)).toBeInTheDocument();
      expect(foot().queryByText('Access', { exact: true })).not.toBeInTheDocument();
      expect(foot().queryByRole('link')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
      expect(screen.getByRole('log')).toBeInTheDocument();
      expect(foot().getByText(en.window.memoryWait)).toBeInTheDocument();
      expect(foot().queryByText('Access', { exact: true })).not.toBeInTheDocument();
      expect(foot().queryByRole('link')).not.toBeInTheDocument();
    });

    it.each(accessStates)('makes no computer access request on opening or when access changes with $state', async ({ views }) => {
      const stream = fakeStream();
      const { calls } = open({ 'GET /api/machines/access': [200, { views }] }, DEV_ORG, agentId);
      await screen.findByRole('log');
      await act(async () => {
        stream.send({ type: 'computer' });
      });
      expect(calls.filter(c => /^\/api\/(?:machines\/(?:[^/]+\/)?access|computer)(?:$|[/?])/.test(c.path))).toEqual([]);
    });

    it('keeps the conversation without displaying historical or live computer access events', async () => {
      const stream = fakeStream();
      open({
        [`GET /api/agents/${agentId}/events?last=300`]: [200, {
          events: [line(1), ev(2, 'computer', { state: 'reopened', machine: 'node-a' }, { person: IVAN }), ev(3, 'computer', { state: 'closed', machine: 'node-b' }, { person: IVAN }), line(4)],
          state: READY,
        }],
      }, DEV_ORG, agentId);
      const log = await screen.findByRole('log');
      expect(within(log).getByText('Line 1')).toBeInTheDocument();
      expect(within(log).getByText('Line 4')).toBeInTheDocument();
      stream.send({ type: 'agent_event', agentId: agentId === 'orchestrator' ? ORG.orchestrator!.id : agentId, event: ev(5, 'computer', { state: 'reopened', machine: 'live-node' }) });
      expect(within(log).queryAllByText(/access to /i)).toHaveLength(0);
    });
  });

  it('shows a line once when the stream and a catch-up both bring it', async () => {
    const stream = fakeStream();
    open({
      [`GET ${EVENTS}?last=300`]: [200, { events: [ev(1, 'text', { kind: 'text', text: 'First' })], state: READY }],
      /* The live line does not move where history is fetched from, so nothing between is skipped. */
      [`GET ${EVENTS}?after=1`]: [200, { events: [ev(2, 'text', { kind: 'text', text: 'Second' }), ev(3, 'text', { kind: 'text', text: 'Third' })], state: READY }],
    });
    await screen.findByText('First');
    stream.send({ type: 'agent_event', agentId: 'a1', event: ev(2, 'text', { kind: 'text', text: 'Second' }) });
    stream.send({ type: 'agent_event', agentId: 'someone-else', event: ev(50, 'text', { kind: 'text', text: 'Not his' }) });
    stream.send({ type: 'reconnected' });
    expect(await screen.findByText('Third')).toBeInTheDocument();
    expect(screen.getAllByText('Second')).toHaveLength(1);
    expect(screen.queryByText('Not his')).not.toBeInTheDocument();
  });

  it('loads what came while it was away page by page up to the newest line, and keeps the newest 300', async () => {
    const stream = fakeStream();
    const page = Array.from({ length: 500 }, (_, i) => line(i + 2));
    open({
      [`GET ${EVENTS}?last=300`]: [200, { events: [line(1)], state: READY }],
      [`GET ${EVENTS}?after=1`]: [200, { events: page, state: READY }],
      [`GET ${EVENTS}?after=501`]: [200, { events: [ev(502, 'text', { kind: 'text', text: 'Newest' })], state: READY }],
    });
    expect(await screen.findByText('Line 1')).toBeInTheDocument();
    stream.send({ type: 'reconnected' });
    expect(await screen.findByText('Newest')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Line 202')).toBeNull());
    expect(screen.getByText('Line 203')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show earlier' })).toBeInTheDocument();
  });

  it('opens on the newest 300 lines of a long conversation, and shows earlier ones when asked', async () => {
    const user = userEvent.setup();
    const { calls } = open({
      [`GET ${EVENTS}?last=300`]: [200, { events: lines(101, 400), state: READY }],
      [`GET ${EVENTS}?last=200&before=101`]: [200, { events: lines(1, 100), state: READY }],
    });
    expect(await screen.findByText('Line 400')).toBeInTheDocument();
    expect(screen.getByText('Line 101')).toBeInTheDocument();
    expect(screen.queryByText('Line 100')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show earlier' }));
    expect(await screen.findByText('Line 1')).toBeInTheDocument();
    expect(screen.getByText('Line 400')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show earlier' })).toBeNull();
    expect(calls.filter(c => c.path.startsWith(EVENTS)).map(c => c.path)).toEqual([`${EVENTS}?last=300`, `${EVENTS}?last=200&before=101`]);
  });

  it('lets the oldest line go once more than 300 came while it is open, and shows it again when asked', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    open({
      [`GET ${EVENTS}?last=300`]: [200, { events: lines(1, 299), state: READY }],
      [`GET ${EVENTS}?last=200&before=2`]: [200, { events: [line(1)], state: READY }],
    });
    expect(await screen.findByText('Line 1')).toBeInTheDocument();
    stream.send({ type: 'agent_event', agentId: ORG.orchestrator!.id, event: line(300) });
    expect(await screen.findByText('Line 300')).toBeInTheDocument();
    expect(screen.getByText('Line 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show earlier' })).toBeNull();
    stream.send({ type: 'agent_event', agentId: ORG.orchestrator!.id, event: line(301) });
    expect(await screen.findByText('Line 301')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Line 1')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Show earlier' }));
    expect(await screen.findByText('Line 1')).toBeInTheDocument();
    expect(screen.getByText('Line 301')).toBeInTheDocument();
  });

  it('greets once he can answer, when the window was open before that', async () => {
    const stream = fakeStream();
    let ready = false;
    const { calls } = open({
      [`GET ${EVENTS}?last=300`]: () => [200, { events: [], state: ready ? READY : { ...READY, ready: false, reason: 'waiting_machine' } }],
    });
    const starts = () => calls.filter(c => c.path === '/api/agents/orchestrator/start').length;
    await vi.waitFor(() => expect(starts()).toBe(1));
    ready = true;
    stream.send({ type: 'reconnected' });
    await vi.waitFor(() => expect(starts()).toBe(2));
  });

  it('keeps the line on when an older catch-up that found him unable to answer comes after a newer one', async () => {
    const stream = fakeStream();
    let ready = false;
    let hold = false;
    let late = () => {};
    open({
      [`GET ${EVENTS}?last=300`]: () => {
        const reply: [number, unknown] = [200, { events: [], state: ready ? READY : { ...READY, ready: false, reason: 'waiting_machine' } }];
        if (!hold) return reply;
        hold = false;
        return new Promise(resolve => (late = () => resolve(reply)));
      },
    });
    const input = await screen.findByLabelText('Write to the orchestrator');
    expect(input).toBeDisabled();
    hold = true;
    stream.send({ type: 'reconnected' });
    ready = true;
    stream.send({ type: 'reconnected' });
    await vi.waitFor(() => expect(input).toBeEnabled());
    await act(async () => {
      late();
    });
    expect(input).toBeEnabled();
  });

  it('keeps one card that changes with the newest proposal, under his latest line', async () => {
    const { container } = open({
      [`GET ${EVENTS}?last=300`]: [
        200,
        {
          events: [
            ev(1, 'proposal', { proposalId: 'pr1', brief: 'Acme.', items: [{ template: 'operations', checked: true, note: '' }, { template: 'development', checked: true, note: '' }] }),
            ev(2, 'message', { text: 'One design for all three' }, { person: IVAN }),
            ev(3, 'proposal', { proposalId: 'pr2', brief: 'Acme.', items: [{ template: 'operations', checked: true, note: '' }, { template: 'design', checked: true, note: 'Shared style' }] }),
            ev(4, 'text', { kind: 'text', text: 'The new card is on the screen.' }),
          ],
          state: READY,
        },
      ],
    });
    expect(await screen.findByText('The new card is on the screen.')).toBeInTheDocument();
    expect(screen.getAllByText('Company structure')).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: /Design/ })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /Development/ })).not.toBeInTheDocument();
    const card = container.querySelector('.t-card')!;
    expect(screen.getByText('The new card is on the screen.').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the hand-made card and offers it again', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, ready: false, reason: 'machine_offline' } }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('Company structure')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pick departments by hand' }));
    expect(screen.getByText('Company structure')).toBeInTheDocument();
  });

  it('closes the hand-made card once its departments are created', async () => {
    open({ 'POST /api/departments/build': [201, { created: ['d1'], removed: [] }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Pick departments by hand' }));
    fireEvent.click(screen.getByRole('button', { name: /Create departments/ }));
    await vi.waitFor(() => expect(screen.queryByText('Company structure')).not.toBeInTheDocument());
  });

  it('lets the CEO pick departments by hand on an empty company', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Pick departments by hand' }));
    expect(screen.getByText('Company structure')).toBeInTheDocument();
  });

  it('still offers the card by hand when the company has only the Operations it starts with, and leaves Operations off it', async () => {
    const onlyOps = { ...ORG, departments: [{ id: 'd1', name: null, templateKey: 'operations' as const, roleCode: 'OPS', about: '', agents: { total: 4, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] }] };
    open(undefined, onlyOps);
    fireEvent.click(await screen.findByRole('button', { name: 'Pick departments by hand' }));
    expect(screen.getByText('Company structure')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Development/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Operations/ })).not.toBeInTheDocument();
  });

  it('offers no structure card on a company that already has departments, only a line to connect a subscription', async () => {
    const withDepts = { ...ORG, departments: [{ id: 'd1', name: null, templateKey: 'home_devices' as const, roleCode: 'HOM', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] }] };
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, ready: false, reason: 'needs_login' } }] }, withDepts);
    expect(await screen.findByText('Connect a subscription, and the orchestrator offers employees for these departments.')).toBeInTheDocument();
    expect(screen.queryByText('Company structure')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick departments by hand' })).not.toBeInTheDocument();
  });

  it('talks to an employee by its id', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const calls = mockApi({
      'GET /api/agents/b1': [200, CARD],
      'GET /api/agents/b1/events?last=300': [200, { events: [ev(1, 'text', { kind: 'text', text: 'I build the API.' })], state: READY }],
      'POST /api/agents/b1/messages': [202, { jobId: 'j3' }],
    });
    render(
      <LanguageProvider>
        <AgentWindow me={ME} org={DEV_ORG} agentId="b1" onClose={() => {}} />
      </LanguageProvider>,
    );
    expect(await screen.findByText('I build the API.')).toBeInTheDocument();
    expect(await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeInTheDocument();
    stream.send({ type: 'agent_event', agentId: 'b1', event: ev(2, 'text', { kind: 'text', text: 'Live from Bruno' }) });
    stream.send({ type: 'agent_event', agentId: 'a1', event: ev(3, 'text', { kind: 'text', text: 'From the orchestrator' }) });
    expect(await screen.findByText('Live from Bruno')).toBeInTheDocument();
    expect(screen.queryByText('From the orchestrator')).not.toBeInTheDocument();
    const input = screen.getByLabelText('Write to Bruno');
    await vi.waitFor(() => expect(input).toBeEnabled());
    await user.type(input, 'What do you do?{Enter}');
    await vi.waitFor(() => expect(calls.find(c => c.path === '/api/agents/b1/messages')?.body).toEqual({ text: 'What do you do?' }));
    expect(calls.some(c => c.path.startsWith('/api/agents/orchestrator') || c.path === '/api/agents/b1/start')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Pick departments by hand' })).not.toBeInTheDocument();
  });

  it('shows nothing of an employee before it knows whether to open a terminal or a conversation', async () => {
    chooseTerminal();
    mockApi({
      'GET /api/agents/b1': [200, CARD],
      'GET /api/agents/b1/events?last=300': [200, { events: [], state: { ...READY, terminal: true, canType: true } }],
    });
    render(
      <LanguageProvider>
        <AgentWindow me={ME} org={DEV_ORG} agentId="b1" onClose={() => {}} />
      </LanguageProvider>,
    );
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Needs a subscription/)).not.toBeInTheDocument();
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
  });

  it("opens an employee's conversation at its newest line when its card comes after the conversation", async () => {
    let giveCard!: (reply: [number, unknown]) => void;
    const calls = mockApi({
      'GET /api/agents/b1': () => new Promise(resolve => (giveCard = resolve)),
      'GET /api/agents/b1/events?last=300': [200, { events: [ev(1, 'text', { kind: 'text', text: 'I build the API.' })], state: READY }],
    });
    const tall = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(480);
    render(
      <LanguageProvider>
        <AgentWindow me={ME} org={DEV_ORG} agentId="b1" onClose={() => {}} />
      </LanguageProvider>,
    );
    await vi.waitFor(() => expect(calls.some(c => c.path === '/api/agents/b1/events?last=300')).toBe(true));
    await act(async () => {});
    await act(async () => giveCard([200, CARD]));
    expect((await screen.findByRole('log')).scrollTop).toBe(480);
    tall.mockRestore();
  });

  it('titles an employee by its name alone when it is called after its role', async () => {
    mockApi({
      'GET /api/agents/b1': [200, { ...CARD, name: 'Backend engineer' }],
      'GET /api/agents/b1/events?last=300': [200, { events: [], state: READY }],
    });
    render(
      <LanguageProvider>
        <AgentWindow me={ME} org={DEV_ORG} agentId="b1" onClose={() => {}} />
      </LanguageProvider>,
    );
    expect(await screen.findByRole('complementary', { name: 'Backend engineer' })).toBeInTheDocument();
  });

  it('shows his staff proposal as a hiring card and the hired line after it', async () => {
    const staff = ev(1, 'proposal', { proposalId: 'pr5', kind: 'staff', department: 'd2', brief: 'The API first.', people: [{ role: 'DEV-BE', name: 'Bruno', checked: true }] });
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [staff], state: READY }], 'GET /api/departments/d2/roster': [200, ROSTER] }, DEV_ORG);
    expect(await screen.findByText('Hiring for Development')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Hire (1)' })).toBeInTheDocument();
    expect(screen.queryByText('Company structure')).not.toBeInTheDocument();
  });

  it('says who was hired once the card is applied', async () => {
    const events = [
      ev(1, 'proposal', { proposalId: 'pr5', kind: 'staff', department: 'd2', brief: '', people: [{ role: 'DEV-BE', name: 'Bruno', checked: true }] }),
      ev(2, 'applied', { proposalId: 'pr5', kind: 'staff', department: 'd2', hired: [{ id: 'b1', name: 'Bruno', role: 'DEV-BE' }] }, { person: IVAN }),
    ];
    open({ [`GET ${EVENTS}?last=300`]: [200, { events, state: READY }] }, DEV_ORG);
    expect(await screen.findByText('Hired: Bruno')).toBeInTheDocument();
    expect(screen.queryByText('Hiring for Development')).not.toBeInTheDocument();
  });

  it('opens the company notebook beside his conversation, which stays, and closes it again', async () => {
    const user = userEvent.setup();
    open({ 'GET /api/notebook': [200, { notes: [{ number: 1, text: 'Turns stay small.', by: { kind: 'orchestrator' }, updatedAt: '2026-10-31T02:00:00Z' }] }] });
    await user.click(await screen.findByRole('button', { name: 'Notebook' }));
    expect(await screen.findByText('Turns stay small.')).toBeInTheDocument();
    expect(screen.getByRole('log')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Notebook' }));
    expect(screen.queryByText('Turns stay small.')).not.toBeInTheDocument();
    expect(screen.getByRole('log')).toBeInTheDocument();
  });

  it('closes', async () => {
    const { onClose } = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('messages between agents and people', () => {
  type Party = NonNullable<EventView['message']>['from'];
  const ASSISTANT: Party = { kind: 'person', id: 'p2', name: 'Nora', role: { en: 'CEO assistant', ru: 'Помощник CEO' }, department: null };
  const PEOPLE: Party = { kind: 'person', id: null, name: '', role: null, department: null };
  const HORNHOOF: Party = { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null };
  const ORCH: Party = { kind: 'agent', id: 'a1', name: 'Orchestrator', role: null, department: null, agentKind: 'orchestrator' };
  const DEV = { id: 'd2', name: { en: 'Development', ru: 'Разработка' } };
  const DANA: Party = { kind: 'agent', id: 'b0', name: 'Dana', role: { en: 'Head of development', ru: 'Руководитель разработки' }, department: DEV, agentKind: 'head' };
  const BRUNO: Party = { kind: 'agent', id: 'b1', name: 'Bruno', role: { en: 'Backend engineer', ru: 'Бэкенд-разработчик' }, department: DEV, agentKind: 'worker' };
  const msg = (seq: number, direction: 'in' | 'out', from: Party, to: Party, text: string) => ev(seq, 'message', { text }, { message: { direction, from, to } });
  const ctrlO = (target: Element = document.body) => fireEvent.keyDown(target, { key: 'o', ctrlKey: true });

  function employee(agentId: string, events: EventView[], state: object = READY) {
    mockApi({
      [`GET /api/agents/${agentId}`]: [200, agentId === 'b0' ? { ...CARD, id: 'b0', kind: 'head', name: 'Dana', role: { ...CARD.role!, id: 'DEV-HEAD', title: { en: 'Head of development', ru: 'Руководитель разработки' } } } : CARD],
      [`GET /api/agents/${agentId}/events?last=300`]: [200, { events, state }],
    });
    render(
      <LanguageProvider>
        <AgentWindow me={ME} org={DEV_ORG} agentId={agentId} onClose={() => {}} />
      </LanguageProvider>,
    );
  }

  const ORCHESTRATOR_LOG = [
    msg(1, 'in', ASSISTANT, ORCH, 'Take #78 into work.\nService: answer in Russian.'),
    msg(2, 'in', HORNHOOF, ORCH, 'Nora took an improvement into work.'),
    msg(3, 'in', DANA, ORCH, '#49 is blocked.'),
    msg(4, 'out', ORCH, DANA, 'Give #78 to a developer.'),
    ev(5, 'text', { kind: 'text', text: 'Handed #78 to development.' }),
  ];

  it("shows a person's words to the orchestrator whole, and every other message as one line naming who wrote to whom, the text folded and opened by a click", async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: ORCHESTRATOR_LOG, state: READY }] });
    /* Nothing is hidden: the service lines are in the person's words too. */
    const nora = (await screen.findByText(/Take #78 into work\.\s+Service: answer in Russian\./)).closest('article')!;
    expect(within(nora).getByText('Nora (CEO assistant)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Message from Nora (CEO assistant) to the orchestrator' })).not.toBeInTheDocument();
    const dana = screen.getByRole('button', { name: 'Message from Dana (Head of development) to the orchestrator' });
    expect(screen.getByRole('button', { name: 'Hornhoof, recorded service message to the orchestrator' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message to Dana (Head of development) from the orchestrator' })).toBeInTheDocument();
    /* Folded: the text is not on the screen, and the agent's own words to the person are. */
    expect(dana).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('#49 is blocked.')).not.toBeInTheDocument();
    expect(screen.getByText('Handed #78 to development.')).toBeInTheDocument();
    fireEvent.click(dana);
    expect(dana).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('#49 is blocked.')).toBeInTheDocument();
    expect(screen.queryByText(/Give #78 to a developer/)).not.toBeInTheDocument();
    fireEvent.click(dana);
    expect(screen.queryByText('#49 is blocked.')).not.toBeInTheDocument();
  });

  it('opens every folded message with Ctrl+O and folds them again with it', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: ORCHESTRATOR_LOG, state: READY }] });
    await screen.findByRole('button', { name: 'Hornhoof, recorded service message to the orchestrator' });
    ctrlO();
    for (const text of [/Take #78 into work/, /Nora took an improvement into work/, /#49 is blocked/, /Give #78 to a developer/]) expect(screen.getByText(text)).toBeInTheDocument();
    ctrlO(screen.getByRole('textbox', { name: 'Write to the orchestrator' }));
    expect(screen.queryByText(/#49 is blocked/)).not.toBeInTheDocument();
    expect(screen.getByText('Handed #78 to development.')).toBeInTheDocument();
  });

  it('takes Ctrl+O while the focus is still on the map that opened the window, but not while one types elsewhere', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: ORCHESTRATOR_LOG, state: READY }] });
    await screen.findByRole('button', { name: 'Hornhoof, recorded service message to the orchestrator' });
    const chip = document.body.appendChild(document.createElement('button'));
    const field = document.body.appendChild(document.createElement('input'));
    onTestFinished(() => { chip.remove(); field.remove(); });
    ctrlO(field);
    expect(screen.queryByText(/#49 is blocked/)).not.toBeInTheDocument();
    ctrlO(chip);
    expect(screen.getByText(/#49 is blocked/)).toBeInTheDocument();
  });

  it("shows a head's messages the same way", async () => {
    employee('b0', [msg(1, 'in', ORCH, DANA, 'Plan #78.'), msg(2, 'out', DANA, BRUNO, 'Take #83.')]);
    expect(await screen.findByRole('button', { name: 'Message from the orchestrator to Dana (Head of development)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message to Bruno (Backend engineer) from Dana (Head of development)' })).toBeInTheDocument();
  });

  it("shows an employee's messages, sent and received, in Russian", async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.clear());
    employee('b1', [
      msg(1, 'in', DANA, BRUNO, 'Возьми #83.'),
      msg(2, 'out', BRUNO, PEOPLE, 'Нужен доступ к репозиторию.'),
      msg(3, 'in', HORNHOOF, BRUNO, '#83 ждет сдачи.'),
      msg(4, 'out', BRUNO, ORCH, 'Готово.'),
    ]);
    const first = await screen.findByRole('button', { name: 'Сообщение от Dana (Руководитель разработки) для Bruno (Бэкенд-разработчик)' });
    expect(screen.getByRole('button', { name: 'Сообщение для людей от Bruno (Бэкенд-разработчик)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hornhoof, сохраненное служебное сообщение для Bruno (Бэкенд-разработчик)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сообщение для оркестратора от Bruno (Бэкенд-разработчик)' })).toBeInTheDocument();
    expect(screen.queryByText('Возьми #83.')).not.toBeInTheDocument();
    fireEvent.click(first);
    expect(screen.getByText('Возьми #83.')).toBeInTheDocument();
  });

  it('leaves the whole window and Ctrl+O to the live terminal, even with messages that name who wrote to whom', async () => {
    chooseTerminal();
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: ORCHESTRATOR_LOG, state: { ...READY, terminal: true, canType: true } }] });
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Messages' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Message from Nora (CEO assistant) to the orchestrator' })).not.toBeInTheDocument();
    /* Nothing over the terminal folds, so the window takes no Ctrl+O for itself. */
    expect(ctrlO()).toBe(true);
    expect(ctrlO(screen.getByRole('textbox', { name: 'Terminal input' }))).toBe(true);
  });
});

describe("who takes the orchestrator's card", () => {
  const card = (seq: number, id: string) => ev(seq, 'proposal', { proposalId: id, brief: 'Acme.', items: [{ template: 'operations', checked: true, note: '' }] });
  const listed = (proposals: { id: string; canAnswer: boolean }[]) => [200, { requests: [], proposals, machineAccess: [], counts: { byPerson: {}, byAgent: {}, total: 0 } }];
  const DANA: Me = { ...ME, person: { ...ME.person, id: 'p3', isOwner: false }, canDecideCompany: false };
  const LOCKED = 'Decided by the CEO or the CEO delegate.';

  function show(me: Me, requests: unknown, events: EventView[] = [card(1, 'pr1')]) {
    const calls = mockApi({
      [`GET ${EVENTS}?last=300`]: [200, { events, state: READY }],
      'POST /api/agents/orchestrator/start': [200, { started: false }],
      'GET /api/requests': requests as [number, unknown],
    });
    render(
      <LanguageProvider>
        <AgentWindow me={me} org={ORG} agentId="orchestrator" onClose={vi.fn()} />
      </LanguageProvider>,
    );
    return calls;
  }

  it('goes by what /api/requests says of the card over what /api/me says of the CEO decisions', async () => {
    show(ME, listed([{ id: 'pr1', canAnswer: false }]));
    expect(await screen.findByText(LOCKED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Correct in words' })).not.toBeInTheDocument();
  });

  it('lets someone the CEO decisions are not for take a card /api/requests gives them', async () => {
    show(DANA, listed([{ id: 'pr1', canAnswer: true }]));
    expect(await screen.findByRole('button', { name: 'Correct in words' })).toBeInTheDocument();
    expect(screen.queryByText(LOCKED)).not.toBeInTheDocument();
  });

  it.each([
    ['a card it does not list', listed([{ id: 'other', canAnswer: true }])],
    ['an answer that did not come', [500, { error: { code: 'internal', message: 'Something went wrong.' } }]],
  ])('goes by the CEO decisions for %s', async (_, requests) => {
    const calls = show(DANA, requests);
    await vi.waitFor(() => expect(calls).toContainEqual({ method: 'GET', path: '/api/requests', body: undefined }));
    expect(await screen.findByText(LOCKED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Correct in words' })).not.toBeInTheDocument();
  });

  it("does not carry the answer for one card over to the next while the next one's answer is on its way", async () => {
    const stream = fakeStream();
    let asked = 0;
    show(ME, async () => (++asked === 1 ? listed([{ id: 'pr1', canAnswer: false }]) : new Promise(() => {})));
    expect(await screen.findByText(LOCKED)).toBeInTheDocument();
    stream.send({ type: 'agent_event', agentId: 'a1', event: card(2, 'pr2') });
    expect(await screen.findByRole('button', { name: 'Correct in words' })).toBeInTheDocument();
    expect(screen.queryByText(LOCKED)).not.toBeInTheDocument();
    expect(asked).toBe(2);
  });
});

describe('writing to an agent whose live terminal runs on the plan of someone else', () => {
  const WATCHING = { ...READY, terminal: true, canType: false };
  const LISA: Me = { ...ME, person: { ...ME.person, id: 'p2', name: 'Lisa', isOwner: false, isCeoDelegate: true }, canDecideCompany: true };
  const MARIA: Me = { ...ME, person: { ...ME.person, id: 'p3', name: 'Maria', isOwner: false, scopeKind: 'listed' }, canDecideCompany: false };
  const employee = (me: Me, routes: Record<string, unknown>) => {
    const calls = mockApi({ 'GET /api/agents/b1': [200, CARD], ...(routes as Record<string, [number, unknown]>) });
    render(<LanguageProvider><AgentWindow me={me} org={DEV_ORG} agentId="b1" onClose={() => {}} /></LanguageProvider>);
    return calls;
  };
  beforeEach(chooseTerminal);
  const noSecondLine = (name: string) => {
    expect(screen.queryByRole('textbox', { name })).not.toBeInTheDocument();
    expect(screen.queryByText('Enter to send, Shift+Enter for a new line')).not.toBeInTheDocument();
  };

  it('has the CEO delegate write in the terminal, with no second line under it', async () => {
    mockApi({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: WATCHING }], 'POST /api/agents/orchestrator/start': [200, { started: false }] });
    render(<LanguageProvider><AgentWindow me={LISA} org={ORG} agentId="orchestrator" onClose={() => {}} /></LanguageProvider>);
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    noSecondLine('Write to the orchestrator');
  });

  it('has a person with the department write in the terminal of an employee, with no second line under it', async () => {
    employee(MARIA, { 'GET /api/agents/b1/events?last=300': [200, { events: [], state: WATCHING }] });
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    noSecondLine('Write to Bruno');
  });

  it('shows why while the agent cannot answer, and the terminal with it', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...WATCHING, ready: false, reason: 'machine_offline' } }] });
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    expect(screen.getByText('The built-in machine is offline')).toBeInTheDocument();
    noSecondLine('Write to the orchestrator');
  });

  it('writes from the line of the chat, which keeps the words and says why when the server turns the message down', async () => {
    const user = userEvent.setup();
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: WATCHING }], 'POST /api/agents/orchestrator/messages': [403, { error: { code: 'forbidden', message: 'No.', reason: 'company_scope_only' } }] });
    await screen.findByTestId('live-terminal');
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    const line = screen.getByRole('textbox', { name: 'Write to the orchestrator' });
    await user.type(line, 'Please check{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Only people with access to the whole company can do this.');
    expect(line).toHaveValue('Please check');
  });

  it("sends a correction of the orchestrator's card to the terminal, where they write", async () => {
    const user = userEvent.setup();
    const card = ev(1, 'proposal', { proposalId: 'pr1', brief: 'Acme.', items: [{ template: 'operations', checked: true, note: '' }] });
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [card], state: WATCHING }] });
    await user.click(await screen.findByRole('button', { name: 'Correct in words' }));
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveFocus();
  });

  it('leaves the owner of the plan with the terminal alone, and focus stays in it', async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...READY, terminal: true, canType: true } }] });
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    noSecondLine('Write to the orchestrator');
  });

  it('takes the terminal away from someone who loses access while the window is open', async () => {
    const stream = fakeStream();
    let allowed = true;
    mockApi({
      [`GET ${EVENTS}?last=300`]: () => (allowed ? [200, { events: [], state: WATCHING }] : [403, { error: { code: 'forbidden', message: 'No.', reason: 'company_scope_only' } }]),
      'POST /api/agents/orchestrator/start': [200, { started: false }],
    });
    render(<LanguageProvider><AgentWindow me={LISA} org={ORG} agentId="orchestrator" onClose={() => {}} /></LanguageProvider>);
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    allowed = false;
    await act(async () => stream.send({ type: 'reconnected' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only people with access to the whole company can do this.');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it('keeps the terminal through a failure that says nothing of access', async () => {
    const stream = fakeStream();
    let down = false;
    mockApi({
      [`GET ${EVENTS}?last=300`]: () => (down ? [503, { error: { code: 'internal', message: 'Down.' } }] : [200, { events: [], state: WATCHING }]),
      'POST /api/agents/orchestrator/start': [200, { started: false }],
    });
    render(<LanguageProvider><AgentWindow me={LISA} org={ORG} agentId="orchestrator" onClose={() => {}} /></LanguageProvider>);
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    down = true;
    await act(async () => stream.send({ type: 'reconnected' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('live-terminal')).toBeInTheDocument();
  });

  it.each([
    ['orchestrator', 'company_scope_only', 'Only people with access to the whole company can do this.'],
    ['b1', 'not_your_department', 'This employee works in a department you do not have access to.'],
  ])('shows no line and no terminal to someone the server turns away from %s', async (agentId, reason, words) => {
    const refused: [number, unknown] = [403, { error: { code: 'forbidden', message: 'No.', reason } }];
    mockApi({ [`GET /api/agents/${agentId}/events?last=300`]: refused, [`GET /api/agents/${agentId}`]: refused, 'POST /api/agents/orchestrator/start': refused });
    render(<LanguageProvider><AgentWindow me={MARIA} org={agentId === 'b1' ? DEV_ORG : ORG} agentId={agentId} onClose={() => {}} /></LanguageProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });
});
