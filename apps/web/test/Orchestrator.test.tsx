import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { OrchestratorWindow } from '../src/screens/Orchestrator';
import type { EventView, Org } from '../src/types';
import { ME, mockApi, ORG } from './api-mock';
import { fakeStream } from './fake-stream';

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
      <OrchestratorWindow me={ME} org={org} onClose={onClose} />
    </LanguageProvider>,
  );
  return { calls, onClose, ...view };
}

describe('OrchestratorWindow', () => {
  it('shows each kind of line the way a terminal would', async () => {
    const { container } = open({ [`GET ${EVENTS}?after=0`]: [200, { events: LOG, state: READY }] });
    expect(await screen.findByText('What matters most right now?')).toBeInTheDocument();
    expect(container.querySelector('.t-u')).toHaveTextContent('> Ivan: We make characters for schools');
    expect(container.querySelector('.t-t')).toHaveTextContent('hornhoof.company({})');
    expect(container.querySelector('.t-r')).toHaveTextContent('⎿Acme, 1 person');
    expect(screen.getByText('Ask about products').parentElement).toHaveTextContent('☒ Ask about products');
    expect(screen.getByText('Propose departments').tagName).toBe('B');
    expect(screen.getByText('Company structure')).toBeInTheDocument();
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByText('Created: Operations')).toBeInTheDocument();
    expect(screen.getByText('Created: Development, 2 products')).toBeInTheDocument();
    expect(screen.getByText('Removed: Finance')).toBeInTheDocument();
    expect(screen.getByText('The orchestrator did not finish within 15 minutes.')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
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
    const { calls } = open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...BUSY, queued: 2 } }], 'POST /api/jobs/j1/cancel': [202] });
    expect(await screen.findByText(/esc to stop/)).toBeInTheDocument();
    expect(screen.getByText('2 waiting')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await vi.waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/api/jobs/j1/cancel')).toBe(true));
  });

  it('says why he cannot answer and offers the card by hand', async () => {
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: [], state: { ...READY, ready: false, reason: 'needs_login' } }] });
    expect(await screen.findByText('Waiting for the Anthropic login')).toBeInTheDocument();
    expect(screen.getByLabelText('Write to the orchestrator')).toBeDisabled();
    expect(screen.getByText('Company structure')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
  });

  it('shows a line once when the stream and a catch-up both bring it', async () => {
    const stream = fakeStream();
    open({
      [`GET ${EVENTS}?after=0`]: [200, { events: [ev(1, 'text', { kind: 'text', text: 'First' })], state: READY }],
      [`GET ${EVENTS}?after=2`]: [200, { events: [ev(2, 'text', { kind: 'text', text: 'Second' }), ev(3, 'text', { kind: 'text', text: 'Third' })], state: READY }],
    });
    await screen.findByText('First');
    stream.send({ type: 'agent_event', agentId: 'a1', event: ev(2, 'text', { kind: 'text', text: 'Second' }) });
    stream.send({ type: 'agent_event', agentId: 'someone-else', event: ev(50, 'text', { kind: 'text', text: 'Not his' }) });
    stream.send({ type: 'reconnected' });
    expect(await screen.findByText('Third')).toBeInTheDocument();
    expect(screen.getAllByText('Second')).toHaveLength(1);
    expect(screen.queryByText('Not his')).not.toBeInTheDocument();
  });

  it('lets the CEO pick departments by hand on an empty company', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Pick departments by hand' }));
    expect(screen.getByText('Company structure')).toBeInTheDocument();
  });

  it('closes', async () => {
    const { onClose } = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
