import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentWindow } from '../src/screens/AgentWindow';
import type { EventView } from '../src/types';
import { en } from '../src/i18n/en';
import { STUCK_MS } from '../src/ui/Loading';
import { CARD, DEV_ORG, ME, mockApi, ORG } from './api-mock';

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
const WITH_TERMINAL = { ...READY, terminal: true, canType: true };
const BUSY = { ...READY, busy: true, runningJobId: 'j1' };
/* Fixed virtual day and clock so message lines and "now" never depend on the host clock or midnight UTC. */
const NOW = new Date(2026, 10, 3, 12, 0);
const AT = new Date(2026, 10, 3, 10, 5).toISOString();
const time = (at: string, language = 'en') => new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(at));
const dayAndTime = (at: string, language = 'en') => new Intl.DateTimeFormat(language, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(at));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const ev = (seq: number, kind: EventView['kind'], data: unknown, extra: Partial<EventView> = {}): EventView => ({ seq, kind, data, jobId: 'j1', person: null, at: AT, ...extra });
type Party = NonNullable<EventView['message']>['from'];
const LISA: Party = { kind: 'person', id: 'p2', name: 'Lisa', role: null, department: null };
const ORCH: Party = { kind: 'agent', id: 'a1', name: 'Orchestrator', role: null, department: null, agentKind: 'orchestrator' };

function open(routes: Record<string, unknown> = {}, org = ORG) {
  const calls = mockApi({
    'GET /api/agents/orchestrator': [200, { ...CARD, id: ORG.orchestrator!.id, kind: 'orchestrator', name: 'Orchestrator' }],
    [`GET ${EVENTS}?last=300`]: [200, { events: [], state: READY }],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
    ...(routes as Record<string, [number, unknown]>),
  });
  const view = render(
    <LanguageProvider>
      <AgentWindow me={ME} org={org} agentId="orchestrator" onClose={() => {}} />
    </LanguageProvider>,
  );
  return { calls, ...view };
}

describe("an agent's window opens as a chat", () => {
  it('opens as a chat even when its node shows the terminal, which is one click away and back', async () => {
    const user = userEvent.setup();
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: WITH_TERMINAL }] });
    expect(await screen.findByRole('log', { name: 'Conversation' })).toBeInTheDocument();
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Write to the orchestrator' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByTestId('live-terminal')).toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeInTheDocument();
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it("opens the person's last choice in the next window", async () => {
    const user = userEvent.setup();
    const first = open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: WITH_TERMINAL }] });
    await user.click(await screen.findByRole('button', { name: 'Terminal' }));
    first.unmount();
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: WITH_TERMINAL }] });
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
  });

  it('opens as a chat and still switches when the browser keeps nothing', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: WITH_TERMINAL }] });
    expect(await screen.findByRole('log', { name: 'Conversation' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByTestId('live-terminal')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('names the terminal in a word beside its icon for an agent with no live terminal, and says there that its program sleeps until someone writes', async () => {
    const user = userEvent.setup();
    open();
    expect(await screen.findByRole('log', { name: 'Conversation' })).toBeInTheDocument();
    const toTerminal = screen.getByRole('button', { name: 'Terminal' });
    expect(toTerminal).toHaveTextContent('Terminal');
    expect(toTerminal.querySelector('svg')).toBeInTheDocument();
    await user.click(toTerminal);
    expect(screen.getByRole('status', { name: 'Terminal' })).toHaveTextContent(/^The \w+ program of this agent is asleep now\. It wakes up when someone writes to the agent, and its terminal shows here then\.$/);
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    const toChat = screen.getByRole('button', { name: 'Chat' });
    expect(toChat).toHaveTextContent('Chat');
    await user.click(toChat);
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeInTheDocument();
  });

  it('names the program an API runs in by its protocol: Codex for an API in the OpenAI protocol', async () => {
    const user = userEvent.setup();
    const sub = { ...ORG.orchestrator!.subscription!, provider: 'custom_api' as const, label: 'Acme LLM', api: { baseUrl: 'https://llm.acme.example/v1', protocol: 'openai' as const } };
    open({}, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: sub } });
    await user.click(await screen.findByRole('button', { name: 'Terminal' }));
    expect(screen.getByRole('status', { name: 'Terminal' })).toHaveTextContent(/^The Codex program of this agent is asleep now\./);
  });

  it('opens the terminal the person chose last even when the agent has none live, and says why in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    localStorage.setItem('hh-agent-view', 'terminal');
    open();
    const asleep = /^Программа \w+ этого агента сейчас спит\. Она проснется, когда агенту напишут, и тогда здесь появится ее терминал\.$/;
    expect(await screen.findByText(asleep)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Терминал' })).toHaveTextContent(asleep);
    expect(screen.getByRole('button', { name: 'Чат' })).toHaveTextContent('Чат');
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
  });

  it('shows the switch and the terminal opening at once, and opens the terminal as its state comes, without waiting for the card', async () => {
    localStorage.setItem('hh-agent-view', 'terminal');
    const org = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: d.employees.map(e => (e.id === 'b1' ? { ...e, provider: 'codex' as const } : e)) })) };
    let comes: (answer: [number, unknown]) => void = () => {};
    const state = new Promise<[number, unknown]>(resolve => (comes = resolve));
    mockApi({ 'GET /api/agents/b1': () => new Promise(() => {}), 'GET /api/agents/b1/events?last=300': () => state });
    const { container } = render(<LanguageProvider><AgentWindow me={ME} org={org} agentId="b1" onClose={() => {}} /></LanguageProvider>);
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveTextContent('Chat');
    expect(within(container.querySelector<HTMLElement>('.t-term')!).getByRole('status')).toHaveTextContent('Opening the Codex terminal…');
    await act(async () => comes([200, { events: [], state: WITH_TERMINAL }]));
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
  });

  /* 20.11: the terminal's place drew a big ring of its own; now it names the program beside the shared ring (#1611 A), and
     when its state does not come it says why, or that it takes longer than usual, with Retry. */
  it('opens the terminal beside the shared ring, with no ring of its own', () => {
    localStorage.setItem('hh-agent-view', 'terminal');
    const { container } = open({ [`GET ${EVENTS}?last=300`]: () => new Promise(() => {}) });
    const place = container.querySelector<HTMLElement>('.t-term')!;
    expect(within(place).getByRole('status')).toHaveTextContent(/^Opening the \w+ terminal…$/);
    expect(place.querySelectorAll('.load-busy > .spinner')).toHaveLength(1);
    expect(place.querySelectorAll('.spinner')).toHaveLength(1);
  });

  it('says why the terminal could not open, with Retry, which asks for its state again and opens it', async () => {
    localStorage.setItem('hh-agent-view', 'terminal');
    let asked = 0;
    const failed = [500, { error: { code: 'internal', message: 'The server could not answer.' } }];
    const { container } = open({ [`GET ${EVENTS}?last=300`]: () => (++asked === 1 ? failed : [200, { events: [], state: WITH_TERMINAL }]) });
    const place = within(container.querySelector<HTMLElement>('.t-term')!);
    expect(await place.findByRole('alert')).not.toBeEmptyDOMElement();
    fireEvent.click(place.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('live-terminal', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(asked).toBe(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says nothing of a terminal that takes long to open, and asks for its state again by itself at 30 s', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    localStorage.setItem('hh-agent-view', 'terminal');
    let asked = 0;
    const { container } = open({ [`GET ${EVENTS}?last=300`]: () => { asked++; return new Promise(() => {}); } });
    await act(async () => { vi.advanceTimersByTime(STUCK_MS - 1); });
    const term = container.querySelector<HTMLElement>('.t-term')!, place = within(term);
    expect(term.querySelector('.load-fail')).toBeNull();
    expect(place.queryByRole('alert')).not.toBeInTheDocument();
    expect(place.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(place.getByRole('status')).toHaveTextContent(/^Opening the \w+ terminal…$/);
    const before = asked;
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(asked).toBeGreaterThan(before);
    expect(term.querySelector('.load-fail')).toBeNull();
    expect(place.getByRole('status')).toHaveTextContent(/^Opening the \w+ terminal…$/);
  });

  it('says the terminal cannot be shown here when the agent works on a machine that does not show it', async () => {
    const user = userEvent.setup();
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: BUSY }] });
    await user.click(await screen.findByRole('button', { name: 'Terminal' }));
    expect(screen.getByRole('status', { name: 'Terminal' })).toHaveTextContent("This agent's terminal cannot be shown here now. What it says is in the chat.");
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });
});

describe('the chat', () => {
  it("shows the person's words and the agent's words, each with who wrote and when", async () => {
    const later = new Date(new Date(AT).getTime() + 60_000).toISOString();
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [
      ev(1, 'message', { text: 'We make characters for schools.' }, { person: { id: ME.person.id, name: ME.person.name } }),
      ev(2, 'text', { text: 'What matters most right now?' }, { at: later }),
      ev(3, 'message', { text: 'Parents matter too.' }, { person: { id: 'p2', name: 'Lisa' }, message: { direction: 'in', from: LISA, to: ORCH, channel: 'telegram' } }),
    ], state: READY }] });
    const mine = (await screen.findByText('We make characters for schools.')).closest('article')!;
    expect(within(mine).getByText('You')).toBeInTheDocument();
    expect(within(mine).getByText(time(AT))).toBeInTheDocument();
    const answer = screen.getByText('What matters most right now?').closest('article')!;
    expect(within(answer).getByText('Orchestrator')).toBeInTheDocument();
    expect(within(answer).getByText(time(later))).toBeInTheDocument();
    const lisa = screen.getByText('Parents matter too.').closest('article')!;
    expect(within(lisa).getByText('Lisa, via Telegram')).toBeInTheDocument();
  });

  it("keeps today's clock time at 23:59:59 UTC and adds the weekday once the clock crosses midnight UTC", async () => {
    vi.setSystemTime(new Date(2026, 10, 3, 23, 59, 59));
    const events = [ev(1, 'message', { text: 'Before midnight.' }, { person: { id: ME.person.id, name: ME.person.name } })];
    const beforeMidnight = open({ [`GET ${EVENTS}?last=300`]: [200, { events, state: READY }] });
    const sameDay = (await screen.findByText('Before midnight.')).closest('article')!;
    expect(within(sameDay).getByText(time(AT))).toBeInTheDocument();
    beforeMidnight.unmount();

    vi.setSystemTime(new Date(2026, 10, 4, 0, 0, 1));
    open({ [`GET ${EVENTS}?last=300`]: [200, { events, state: READY }] });
    const nextDay = (await screen.findByText('Before midnight.')).closest('article')!;
    expect(within(nextDay).getByText(dayAndTime(AT))).toBeInTheDocument();
  });

  it("names the assistant a person wrote through", async () => {
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [
      ev(1, 'message', { text: 'Plan the launch.' }, { person: { id: 'p2', name: 'Lisa' }, message: { direction: 'in', from: LISA, to: ORCH, channel: 'assistant', assistant: { id: 'h1', name: 'Ava' } } }),
    ], state: READY }] });
    const lisa = (await screen.findByText('Plan the launch.')).closest('article')!;
    expect(within(lisa).getByText('Lisa, through the assistant Ava')).toBeInTheDocument();
  });

  it('folds the steps of work into one quiet line that opens on a click', async () => {
    const user = userEvent.setup();
    open({ [`GET ${EVENTS}?last=300`]: [200, { events: [
      ev(1, 'text', { text: 'Looking at the company.' }),
      ev(2, 'tool', { name: 'hornhoof.company', input: '{}' }),
      ev(3, 'tool_result', { ok: true, summary: 'Acme, 1 person' }),
      ev(4, 'todo', { items: [{ text: 'Ask about products', state: 'doing' }] }),
      ev(5, 'tool', { name: 'hornhoof.departments', input: '{}' }),
      ev(6, 'tool_result', { ok: true, summary: 'No departments' }),
      ev(7, 'text', { text: 'Five departments fit.' }),
    ], state: READY }] });
    const steps = await screen.findByRole('button', { name: '3 steps of work' });
    expect(steps).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('hornhoof.company')).not.toBeInTheDocument();
    expect(screen.queryByText('Ask about products')).not.toBeInTheDocument();
    expect(screen.getByText('Looking at the company.')).toBeInTheDocument();
    expect(screen.getByText('Five departments fit.')).toBeInTheDocument();
    await user.click(steps);
    expect(steps).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('hornhoof.company')).toBeInTheDocument();
    expect(screen.getByText('Ask about products')).toBeInTheDocument();
    expect(screen.getByText('No departments')).toBeInTheDocument();
  });

  it('says plainly that the agent works, and stops it', async () => {
    const user = userEvent.setup();
    const { calls } = await act(async () => open({ [`GET ${EVENTS}?last=300`]: [200, { events: [], state: { ...BUSY, queued: 2 } }], 'POST /api/agents/orchestrator/stop': [202] }));
    const state = await screen.findByRole('status', { name: 'Agent state' });
    expect(state).toHaveTextContent('Working on it');
    expect(state).toHaveTextContent('2 more messages wait their turn');
    await user.click(within(state).getByRole('button', { name: 'Stop' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/agents/orchestrator/stop')).toBe(true);
  });

  it('says that an agent with nothing to do sleeps until its next task', async () => {
    open();
    expect(await screen.findByRole('status', { name: 'Agent state' })).toHaveTextContent('Asleep until the next task. A new message wakes it up.');
  });

  it('says what to do in a chat that has no messages yet', async () => {
    open();
    expect(await screen.findByText('No messages yet. Write below, and the answer comes here.')).toBeInTheDocument();
  });

  it('sends with its button', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'POST /api/agents/orchestrator/messages': [202, { jobId: 'j2' }] });
    const input = await screen.findByRole('textbox', { name: 'Write to the orchestrator' });
    await vi.waitFor(() => expect(input).toBeEnabled());
    await user.type(input, 'Schools first');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(calls.find(c => c.path === '/api/agents/orchestrator/messages')?.body).toEqual({ text: 'Schools first' }));
    expect(input).toHaveValue('');
  });

  it("names an employee for its words, and speaks Russian", async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi({
      'GET /api/agents/b1': [200, CARD],
      'GET /api/agents/b1/events?last=300': [200, { events: [ev(1, 'text', { text: 'Проверяю оплату.' }), ev(2, 'tool', { name: 'Bash', input: 'ls' })], state: { ...WITH_TERMINAL, busy: true, runningJobId: 'j1' } }],
    });
    render(<LanguageProvider><AgentWindow me={ME} org={DEV_ORG} agentId="b1" onClose={() => {}} /></LanguageProvider>);
    expect(await screen.findByRole('log', { name: 'Переписка' })).toBeInTheDocument();
    const answer = screen.getByText('Проверяю оплату.').closest('article')!;
    expect(within(answer).getByText(CARD.name)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 шаг работы' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Состояние агента' })).toHaveTextContent('Работает');
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Терминал' })).toBeInTheDocument();
  });
});
