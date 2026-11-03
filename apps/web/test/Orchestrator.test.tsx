import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentWindow } from '../src/screens/AgentWindow';
import type { ComputerView, EventView, Me, Org, ShownCommand } from '../src/types';
import { CARD, DEV_ORG, ME, mockApi, ORG, ROSTER, SUBS } from './api-mock';
import { fakeStream } from './fake-stream';

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

const ev = (seq: number, kind: EventView['kind'], data: unknown, extra: Partial<EventView> = {}): EventView => ({ seq, kind, data, jobId: 'j1', person: null, at: '2026-10-29T10:00:00Z', ...extra });
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

function open(routes: Record<string, unknown> = {}, org: Org = ORG) {
  const calls = mockApi({
    [`GET ${EVENTS}?after=0`]: [200, { events: [], state: READY }],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
    ...(routes as Record<string, [number, unknown]>),
  });
  const onClose = vi.fn();
  const view = render(
    <LanguageProvider>
      <AgentWindow me={ME} org={org} agentId="orchestrator" onClose={onClose} />
    </LanguageProvider>,
  );
  return { calls, onClose, ...view };
}

describe('AgentWindow', () => {
  it("sends a correction of the orchestrator's card to the live terminal's own line", async () => {
    const user = userEvent.setup();
    const card = ev(1, 'proposal', { proposalId: 'pr1', brief: 'Acme.', items: [{ template: 'operations', checked: true, note: '' }] });
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [card], state: { ...READY, terminal: true } }] });
    await user.click(await screen.findByRole('button', { name: 'Correct in words' }));
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveFocus();
  });

  it('leaves typing to the live terminal, which has its own line, and keeps the line in the log', async () => {
    const user = userEvent.setup();
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, terminal: true } }] });
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Write to the orchestrator' })).not.toBeInTheDocument();
    expect(screen.queryByText('Enter to send, Shift+Enter for a new line')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log' }));
    expect(screen.getByRole('textbox', { name: 'Write to the orchestrator' })).toBeInTheDocument();
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it('shows each kind of line the way a terminal would', async () => {
    const { container } = open({ [`GET ${EVENTS}?after=0`]: [200, { events: LOG, state: READY }] });
    expect(await screen.findByText('What matters most right now?')).toBeInTheDocument();
    expect(container.querySelector('.t-u')).toHaveTextContent('> Ivan: We make characters for schools');
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
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [ev(1, 'failed', { error: 'instructions_too_long' }), ev(2, 'failed', { error: 'node_too_old' })], state: READY }] });
    expect(await screen.findByText('The instructions are longer than one turn can carry. Shorten the role or a skill on the card.')).toBeInTheDocument();
    expect(screen.getByText("This machine's node is too old for these instructions; update it.")).toBeInTheDocument();
  });

  it("names Hornhoof for the turns it starts on a task", async () => {
    const { container } = open({ [`GET ${EVENTS}?after=0`]: [200, { events: [ev(1, 'message', { text: '#4 "Payments" is yours.', task: { id: 't4', number: 4 } })], state: READY }] });
    await screen.findByText(/Payments/);
    expect(container.querySelector('.t-u')).toHaveTextContent('> Hornhoof: #4 "Payments" is yours.');
  });

  it('names the orchestrator for what it wrote to an employee', async () => {
    const { container } = open({ [`GET ${EVENTS}?after=0`]: [200, { events: [ev(1, 'message', { text: 'Look at checkout first.', from: 'orchestrator' })], state: READY }] });
    await screen.findByText(/Look at checkout first/);
    expect(container.querySelector('.t-u')).toHaveTextContent('> Orchestrator: Look at checkout first.');
  });

  it('names the employee who wrote, as one does on a timer round', async () => {
    const { container } = open({ [`GET ${EVENTS}?after=0`]: [200, { events: [ev(1, 'message', { text: 'Report on #4, please.', from: 'agent', name: 'Wendy' })], state: READY }] });
    await screen.findByText(/Report on #4/);
    expect(container.querySelector('.t-u')).toHaveTextContent('> Wendy: Report on #4, please.');
  });

  it('shows his answers with bold and lists, and hides how Claude loads its tools', async () => {
    const { container } = open({
      [`GET ${EVENTS}?after=0`]: [
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
    expect(container.querySelectorAll('.t-l ul > li')).toHaveLength(2);
    expect(screen.queryByText('ToolSearch')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.t-r')).toHaveLength(1);
    expect(container.querySelector('.t-r')).not.toHaveClass('alone');
  });

  it('speaks Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      open({ [`GET ${EVENTS}?after=0`]: [200, { events: LOG, state: READY }] });
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
    expect(calls[0]).toMatchObject({ method: 'GET', path: `${EVENTS}?after=0` });
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
    const { calls } = await act(async () => open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...BUSY, queued: 2 } }], 'POST /api/agents/orchestrator/stop': [202] }));
    expect(screen.getByText(/esc to stop/)).toBeInTheDocument();
    expect(screen.getByText('2 waiting')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/agents/orchestrator/stop')).toBe(true);
  });

  it('says why he cannot answer and offers the card by hand', async () => {
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, ready: false, reason: 'needs_login' } }] });
    expect(await screen.findByText('Waiting for the Anthropic login')).toBeInTheDocument();
    expect(screen.getByLabelText('Write to the orchestrator')).toBeDisabled();
    expect(screen.getByText('Company structure')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(10);
  });

  it('says that his plan is at its limit and that his turns wait until it starts over', async () => {
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, limitUntil: '2026-10-31T19:20:00Z' } }] });
    expect(await screen.findByText(/^The plan is at its limit\. Turns wait until .+ and go on by themselves then\.$/)).toBeInTheDocument();
    expect(screen.getByLabelText('Write to the orchestrator')).not.toBeDisabled();
  });

  it("says that the plan used its share for tasks, and that only task turns wait", async () => {
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, budgetUntil: '2026-10-31T19:20:00Z' } }] });
    expect(await screen.findByText(/^The plan used the share set for tasks\. Task turns wait until .+; messages from people still go\.$/)).toBeInTheDocument();
  });

  it('tells to update Hornhoof on a machine too old to run his turns', async () => {
    const mac = { ...SUBS[1]!, kind: 'personal' as const, owner: { id: 'p1', name: 'Ivan' } };
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, ready: false, reason: 'node_outdated' } }] }, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: mac } });
    expect(await screen.findByText("Hornhoof on Ivan's machine is out of date. Run the install command there again.")).toBeInTheDocument();
  });

  it('names the machine he runs on', async () => {
    const plan = { ...SUBS[0]!, owner: { id: 'p1', name: 'Ivan' } };
    open({}, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: plan, machine: { id: 'm3', hostname: 'ivan-laptop' } } });
    expect((await screen.findAllByText(/, ivan-laptop$/)).length).toBeGreaterThan(0);
  });

  it('shows the CEO alone the machine command he asked Hornhoof for, next to his terminal, until the CEO closes it', async () => {
    const user = userEvent.setup();
    const command = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join CODE123';
    const shown: ShownCommand = { id: 'a'.repeat(64), kind: 'add', plans: ['Claude'], machine: 'ivan-laptop', command, expiresAt: '2026-11-02T10:00:00Z' };
    const { calls } = open({
      [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, terminal: true } }],
      'GET /api/nodes/commands': [200, { commands: [shown] }],
      [`POST /api/nodes/commands/${shown.id}/hide`]: [204],
    });
    const card = await screen.findByRole('region', { name: 'Command to add Claude to ivan-laptop' });
    expect(within(card).getByText(command)).toBeInTheDocument();
    expect(within(card).getByText(/^Run this in a terminal on ivan-laptop\./)).toBeInTheDocument();
    expect(within(card).getByText('The orchestrator asked Hornhoof for this command, and only you see it. It works once, for 24 hours.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Done' }));
    expect(calls).toContainEqual({ method: 'POST', path: `/api/nodes/commands/${shown.id}/hide`, body: undefined });
    await vi.waitFor(() => expect(screen.queryByText(command)).not.toBeInTheDocument());
  });

  it('names each kind of machine command in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      const made = (id: string, kind: ShownCommand['kind'], plans: string[], machine: string | null): ShownCommand => ({ id: id.repeat(64), kind, plans, machine, command: `curl ${id}`, expiresAt: '2026-11-02T10:00:00Z' });
      open({ 'GET /api/nodes/commands': [200, { commands: [made('a', 'machine', [], null), made('b', 'plans', ['Claude', 'Codex'], null), made('c', 'add', ['Kimi'], 'ivan-laptop')] }] });
      expect(await screen.findByRole('region', { name: 'Команда для подключения машины' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Команда для подключения: Claude, Codex' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Команда, чтобы добавить Kimi на ivan-laptop' })).toBeInTheDocument();
      expect(screen.getAllByText('Оркестратор попросил эту команду у Hornhoof, и видите ее только вы. Она работает один раз, 24 часа.')).toHaveLength(3);
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('asks for no machine commands and no computer access for someone who is not the CEO', async () => {
    const calls = mockApi({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: READY }], 'POST /api/agents/orchestrator/start': [200, { started: false }] });
    const deputy: Me = { ...ME, person: { ...ME.person, id: 'p2', isOwner: false } };
    render(<AgentWindow me={deputy} org={ORG} agentId="orchestrator" onClose={vi.fn()} />);
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/nodes/commands')).toBe(false);
    expect(calls.some(c => c.path === '/api/computer')).toBe(false);
  });

  describe('access to the computer', () => {
    const ASKED: ComputerView = { available: true, until: null, asked: { reason: 'Restart the nodes outside AppArmor.', at: '2026-11-02T10:00:00Z' } };
    const OPEN: ComputerView = { available: true, until: '2026-11-03T10:00:00.000Z', asked: null };
    const CLOSED: ComputerView = { available: true, until: null, asked: null };

    it("shows the CEO the orchestrator's request next to his terminal and opens access for a day with one click", async () => {
      const user = userEvent.setup();
      const { calls } = open({
        [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, terminal: true } }],
        'GET /api/computer': [200, ASKED],
        'POST /api/computer/open': [200, OPEN],
      });
      const card = await screen.findByRole('region', { name: "The orchestrator asks for access to the server's computer" });
      expect(within(card).getByText('Restart the nodes outside AppArmor.')).toBeInTheDocument();
      expect(within(card).getByText(/as root on the server's computer/)).toBeInTheDocument();
      await user.click(within(card).getByRole('button', { name: 'Open access for a day' }));
      expect(calls).toContainEqual({ method: 'POST', path: '/api/computer/open', body: undefined });
      const opened = await screen.findByRole('region', { name: "Access to the server's computer" });
      expect(within(opened).getByText(/^The orchestrator can run commands on the server's computer until .+\. The company server runs there, so this shows wherever you open Hornhoof\.$/)).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: "The orchestrator asks for access to the server's computer" })).not.toBeInTheDocument();
    });

    it('closes access when the CEO takes it back', async () => {
      const user = userEvent.setup();
      const { calls } = open({ 'GET /api/computer': [200, OPEN], 'POST /api/computer/close': [200, CLOSED] });
      await user.click(within(await screen.findByRole('region', { name: "Access to the server's computer" })).getByRole('button', { name: 'Close access' }));
      expect(calls).toContainEqual({ method: 'POST', path: '/api/computer/close', body: undefined });
      await vi.waitFor(() => expect(screen.queryByRole('region', { name: "Access to the server's computer" })).not.toBeInTheDocument());
    });

    it('shows no open access once its day is over', async () => {
      open({ 'GET /api/computer': [200, { ...OPEN, until: new Date(Date.now() - 60_000).toISOString() }], 'GET /api/nodes/commands': [200, { commands: [] }] });
      expect(await screen.findByRole('textbox')).toBeInTheDocument();
      await vi.waitFor(() => expect(screen.queryByRole('region', { name: "Access to the server's computer" })).not.toBeInTheDocument());
    });

    it('says no to a request', async () => {
      const user = userEvent.setup();
      const { calls } = open({ 'GET /api/computer': [200, ASKED], 'POST /api/computer/decline': [200, CLOSED] });
      await user.click(within(await screen.findByRole('region', { name: "The orchestrator asks for access to the server's computer" })).getByRole('button', { name: 'Not now' }));
      expect(calls).toContainEqual({ method: 'POST', path: '/api/computer/decline', body: undefined });
      await vi.waitFor(() => expect(screen.queryByRole('region', { name: "The orchestrator asks for access to the server's computer" })).not.toBeInTheDocument());
    });

    it('follows a request the CEO answered on another screen, or a new one, without waiting for the log', async () => {
      const stream = fakeStream();
      let view: ComputerView = ASKED;
      open({ 'GET /api/computer': () => [200, view], 'GET /api/nodes/commands': [200, { commands: [] }] });
      expect(await screen.findByRole('region', { name: "The orchestrator asks for access to the server's computer" })).toBeInTheDocument();
      view = CLOSED;
      stream.send({ type: 'computer' });
      await vi.waitFor(() => expect(screen.queryByRole('region', { name: "The orchestrator asks for access to the server's computer" })).not.toBeInTheDocument());
      view = ASKED;
      stream.send({ type: 'computer' });
      expect(await screen.findByRole('region', { name: "The orchestrator asks for access to the server's computer" })).toBeInTheDocument();
    });

    it('writes each step in the log', async () => {
      open({
        [`GET ${EVENTS}?after=0`]: [
          200,
          {
            events: [
              ev(1, 'computer', { state: 'asked', reason: 'Clean Docker images.' }),
              ev(2, 'computer', { state: 'opened', until: OPEN.until }, { person: IVAN }),
              ev(3, 'computer', { state: 'closed' }, { person: IVAN }),
              ev(4, 'computer', { state: 'declined' }, { person: IVAN }),
            ],
            state: READY,
          },
        ],
      });
      expect(await screen.findByText("Asked for access to the server's computer: Clean Docker images.")).toBeInTheDocument();
      expect(screen.getByText(/^Ivan opened access to the server's computer until .+$/)).toBeInTheDocument();
      expect(screen.getByText("Ivan closed access to the server's computer")).toBeInTheDocument();
      expect(screen.getByText("Ivan did not open access to the server's computer")).toBeInTheDocument();
    });

    /* Access is to the machine the server runs on, whichever screen the CEO opens Hornhoof from, so the card names it. */
    it('names the machine the access is to, on the card and in the log', async () => {
      const user = userEvent.setup();
      open({
        [`GET ${EVENTS}?after=0`]: [200, { events: [ev(1, 'computer', { state: 'opened', until: OPEN.until, machine: 'debian-box' }, { person: IVAN })], state: READY }],
        'GET /api/computer': [200, { ...ASKED, machine: 'debian-box' }],
        'POST /api/computer/open': [200, { ...OPEN, machine: 'debian-box' }],
      });
      const card = await screen.findByRole('region', { name: 'The orchestrator asks for access to debian-box' });
      expect(within(card).getByText(/as root on debian-box/)).toBeInTheDocument();
      expect(screen.getByText(/^Ivan opened access to debian-box until .+$/)).toBeInTheDocument();
      await user.click(within(card).getByRole('button', { name: 'Open access for a day' }));
      const opened = await screen.findByRole('region', { name: 'Access to debian-box' });
      expect(within(opened).getByText(/^The orchestrator can run commands on debian-box until .+\. The company server runs there, so this shows wherever you open Hornhoof\.$/)).toBeInTheDocument();
    });

    it('asks and answers in Russian', async () => {
      localStorage.setItem('hh-lang', 'ru');
      try {
        open({
          [`GET ${EVENTS}?after=0`]: [200, { events: [ev(1, 'computer', { state: 'opened', until: OPEN.until }, { person: IVAN })], state: READY }],
          'GET /api/computer': [200, ASKED],
        });
        const card = await screen.findByRole('region', { name: 'Оркестратор просит доступ к машине сервера' });
        expect(within(card).getByRole('button', { name: 'Открыть доступ на сутки' })).toBeInTheDocument();
        expect(within(card).getByRole('button', { name: 'Не сейчас' })).toBeInTheDocument();
        expect(screen.getByText(/^Ivan: доступ к машине сервера открыт до .+$/)).toBeInTheDocument();
      } finally {
        localStorage.removeItem('hh-lang');
      }
    });
  });

  it('shows a line once when the stream and a catch-up both bring it', async () => {
    const stream = fakeStream();
    open({
      [`GET ${EVENTS}?after=0`]: [200, { events: [ev(1, 'text', { kind: 'text', text: 'First' })], state: READY }],
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

  it('loads a long conversation page by page up to the newest line', async () => {
    const page = Array.from({ length: 500 }, (_, i) => ev(i + 1, 'text', { kind: 'text', text: `Line ${i + 1}` }));
    open({
      [`GET ${EVENTS}?after=0`]: [200, { events: page, state: READY }],
      [`GET ${EVENTS}?after=500`]: [200, { events: [ev(501, 'text', { kind: 'text', text: 'Newest' })], state: READY }],
    });
    expect(await screen.findByText('Newest')).toBeInTheDocument();
  });

  it('greets once he can answer, when the window was open before that', async () => {
    const stream = fakeStream();
    let ready = false;
    const { calls } = open({
      [`GET ${EVENTS}?after=0`]: () => [200, { events: [], state: ready ? READY : { ...READY, ready: false, reason: 'waiting_machine' } }],
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
      [`GET ${EVENTS}?after=0`]: () => {
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
      [`GET ${EVENTS}?after=0`]: [
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
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, ready: false, reason: 'machine_offline' } }] });
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

  it('offers no structure card on a company that already has departments, only a line to connect a subscription', async () => {
    const withDepts = { ...ORG, departments: [{ id: 'd1', name: null, templateKey: 'home_devices' as const, roleCode: 'HOM', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] }] };
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, ready: false, reason: 'needs_login' } }] }, withDepts);
    expect(await screen.findByText('Connect a subscription, and the orchestrator offers employees for these departments.')).toBeInTheDocument();
    expect(screen.queryByText('Company structure')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick departments by hand' })).not.toBeInTheDocument();
  });

  it('talks to an employee by its id', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const calls = mockApi({
      'GET /api/agents/b1': [200, CARD],
      'GET /api/agents/b1/events?after=0': [200, { events: [ev(1, 'text', { kind: 'text', text: 'I build the API.' })], state: READY }],
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
    mockApi({
      'GET /api/agents/b1': [200, CARD],
      'GET /api/agents/b1/events?after=0': [200, { events: [], state: { ...READY, terminal: true } }],
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
      'GET /api/agents/b1/events?after=0': [200, { events: [ev(1, 'text', { kind: 'text', text: 'I build the API.' })], state: READY }],
    });
    const tall = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(480);
    render(
      <LanguageProvider>
        <AgentWindow me={ME} org={DEV_ORG} agentId="b1" onClose={() => {}} />
      </LanguageProvider>,
    );
    await vi.waitFor(() => expect(calls.some(c => c.path === '/api/agents/b1/events?after=0')).toBe(true));
    await act(async () => {});
    await act(async () => giveCard([200, CARD]));
    expect((await screen.findByRole('log')).scrollTop).toBe(480);
    tall.mockRestore();
  });

  it('titles an employee by its name alone when it is called after its role', async () => {
    mockApi({
      'GET /api/agents/b1': [200, { ...CARD, name: 'Backend engineer' }],
      'GET /api/agents/b1/events?after=0': [200, { events: [], state: READY }],
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
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [staff], state: READY }], 'GET /api/departments/d2/roster': [200, ROSTER] }, DEV_ORG);
    expect(await screen.findByText('Hiring for Development')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Hire (1)' })).toBeInTheDocument();
    expect(screen.queryByText('Company structure')).not.toBeInTheDocument();
  });

  it('says who was hired once the card is applied', async () => {
    const events = [
      ev(1, 'proposal', { proposalId: 'pr5', kind: 'staff', department: 'd2', brief: '', people: [{ role: 'DEV-BE', name: 'Bruno', checked: true }] }),
      ev(2, 'applied', { proposalId: 'pr5', kind: 'staff', department: 'd2', hired: [{ id: 'b1', name: 'Bruno', role: 'DEV-BE' }] }, { person: IVAN }),
    ];
    open({ [`GET ${EVENTS}?after=0`]: [200, { events, state: READY }] }, DEV_ORG);
    expect(await screen.findByText('Hired: Bruno')).toBeInTheDocument();
    expect(screen.queryByText('Hiring for Development')).not.toBeInTheDocument();
  });

  it('opens the company notebook from his window, and back to his conversation', async () => {
    const user = userEvent.setup();
    open({ 'GET /api/notebook': [200, { notes: [{ number: 1, text: 'Turns stay small.', by: { kind: 'orchestrator' }, updatedAt: '2026-10-31T02:00:00Z' }] }] });
    await user.click(await screen.findByRole('button', { name: 'Notebook' }));
    expect(await screen.findByText('Turns stay small.')).toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Notebook' }));
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
  const DAVID: Party = { kind: 'person', id: 'p2', name: 'David AI', role: { en: 'CEO assistant', ru: 'Помощник CEO' }, department: null };
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
      [`GET /api/agents/${agentId}/events?after=0`]: [200, { events, state }],
    });
    render(
      <LanguageProvider>
        <AgentWindow me={ME} org={DEV_ORG} agentId={agentId} onClose={() => {}} />
      </LanguageProvider>,
    );
  }

  const ORCHESTRATOR_LOG = [
    msg(1, 'in', DAVID, ORCH, 'Take #78 into work.\nService: answer in Russian.'),
    msg(2, 'in', HORNHOOF, ORCH, 'David AI took an improvement into work.'),
    msg(3, 'in', DANA, ORCH, '#49 is blocked.'),
    msg(4, 'out', ORCH, DANA, 'Give #78 to a developer.'),
    ev(5, 'text', { kind: 'text', text: 'Handed #78 to development.' }),
  ];

  it("shows the orchestrator's messages each as one line naming who wrote to whom, the text folded and opened by a click", async () => {
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: ORCHESTRATOR_LOG, state: READY }] });
    const david = await screen.findByRole('button', { name: 'Message from David AI (CEO assistant) to the orchestrator' });
    expect(screen.getByRole('button', { name: 'Hornhoof notice to the orchestrator' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message from Dana (Head of development) to the orchestrator' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message to Dana (Head of development) from the orchestrator' })).toBeInTheDocument();
    /* Folded: the text is not on the screen, and the agent's own words to the person are. */
    expect(david).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Take #78 into work/)).not.toBeInTheDocument();
    expect(screen.getByText('Handed #78 to development.')).toBeInTheDocument();
    fireEvent.click(david);
    expect(david).toHaveAttribute('aria-expanded', 'true');
    /* Nothing is hidden: the service lines are in the opened text too. */
    expect(screen.getByText(/Take #78 into work\.\s+Service: answer in Russian\./)).toBeInTheDocument();
    expect(screen.queryByText('#49 is blocked.')).not.toBeInTheDocument();
    fireEvent.click(david);
    expect(screen.queryByText(/Take #78 into work/)).not.toBeInTheDocument();
  });

  it('opens every folded message with Ctrl+O and folds them again with it', async () => {
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: ORCHESTRATOR_LOG, state: READY }] });
    await screen.findByRole('button', { name: 'Hornhoof notice to the orchestrator' });
    ctrlO();
    for (const text of [/Take #78 into work/, /David AI took an improvement into work/, /#49 is blocked/, /Give #78 to a developer/]) expect(screen.getByText(text)).toBeInTheDocument();
    ctrlO(screen.getByRole('textbox', { name: 'Write to the orchestrator' }));
    expect(screen.queryByText(/#49 is blocked/)).not.toBeInTheDocument();
    expect(screen.getByText('Handed #78 to development.')).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Уведомление Hornhoof для Bruno (Бэкенд-разработчик)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сообщение для оркестратора от Bruno (Бэкенд-разработчик)' })).toBeInTheDocument();
    expect(screen.queryByText('Возьми #83.')).not.toBeInTheDocument();
    fireEvent.click(first);
    expect(screen.getByText('Возьми #83.')).toBeInTheDocument();
  });

  it('shows the same lines in the frame around the live terminal, and leaves Ctrl+O typed in the terminal to the program', async () => {
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: ORCHESTRATOR_LOG, state: { ...READY, terminal: true } }] });
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    const frame = screen.getByRole('region', { name: 'Messages' });
    const david = within(frame).getByRole('button', { name: 'Message from David AI (CEO assistant) to the orchestrator' });
    expect(within(frame).getByRole('button', { name: 'Message to Dana (Head of development) from the orchestrator' })).toBeInTheDocument();
    ctrlO(screen.getByRole('textbox', { name: 'Terminal input' }));
    expect(david).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(david);
    expect(within(frame).getByText(/Take #78 into work/)).toBeInTheDocument();
  });
});
