import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentWindow } from '../src/screens/AgentWindow';
import type { EventView, Org } from '../src/types';
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

  it('shows that he works and stops him on Esc', async () => {
    const { calls } = open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...BUSY, queued: 2 } }], 'POST /api/agents/orchestrator/stop': [202] });
    expect(await screen.findByText(/esc to stop/)).toBeInTheDocument();
    expect(screen.getByText('2 waiting')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await vi.waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/api/agents/orchestrator/stop')).toBe(true));
  });

  it('says why he cannot answer and offers the card by hand', async () => {
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, ready: false, reason: 'needs_login' } }] });
    expect(await screen.findByText('Waiting for the Anthropic login')).toBeInTheDocument();
    expect(screen.getByLabelText('Write to the orchestrator')).toBeDisabled();
    expect(screen.getByText('Company structure')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
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
      await new Promise(r => setTimeout(r, 50));
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
