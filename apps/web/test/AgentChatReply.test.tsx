import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentWindow } from '../src/screens/AgentWindow';
import type { EventView } from '../src/types';
import { CARD, ME, mockApi, ORG } from './api-mock';

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
const NOW = new Date(2026, 10, 3, 12, 0);
const AT = new Date(2026, 10, 3, 10, 5).toISOString();

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const ev = (seq: number, kind: EventView['kind'], data: unknown, extra: Record<string, unknown> = {}): EventView =>
  ({ seq, kind, data, jobId: 'j1', person: null, at: AT, ...extra }) as unknown as EventView;

function open(routes: Record<string, unknown> = {}) {
  const calls = mockApi({
    'GET /api/agents/orchestrator': [200, { ...CARD, id: ORG.orchestrator!.id, kind: 'orchestrator', name: 'Orchestrator' }],
    [`GET ${EVENTS}?last=300`]: [200, { events: [], state: READY }],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
    ...(routes as Record<string, [number, unknown]>),
  });
  const view = render(
    <LanguageProvider>
      <AgentWindow me={ME} org={ORG} agentId="orchestrator" onClose={() => {}} />
    </LanguageProvider>,
  );
  return { calls, ...view };
}

describe('chat message numbers, reply composer, Esc cancel, and jump to original', () => {
  it('shows stable #numbers and #task markers across reloads', async () => {
    const events = [
      ev(10, 'message', { text: 'Prepare the release plan.' }, { number: 1, person: { id: ME.person.id, name: ME.person.name } }),
      ev(14, 'text', { text: 'Drafting #42 now.' }, { number: 2, task: { id: 't-42', number: 42 } }),
    ];
    const first = open({ [`GET ${EVENTS}?last=300`]: [200, { events, state: READY }] });
    const msg1 = (await screen.findByText('Prepare the release plan.')).closest('article')!;
    expect(within(msg1).getByText('#1')).toBeInTheDocument();
    const msg2 = screen.getByText('Drafting #42 now.').closest('article')!;
    expect(within(msg2).getByText('#2')).toBeInTheDocument();
    expect(within(msg2).getByText('Task #42')).toBeInTheDocument();

    first.unmount();
    open({ [`GET ${EVENTS}?last=300`]: [200, { events, state: READY }] });
    const reloaded2 = (await screen.findByText('Drafting #42 now.')).closest('article')!;
    expect(within(reloaded2).getByText('#2')).toBeInTheDocument();
    expect(within(reloaded2).getByText('Task #42')).toBeInTheDocument();
  });

  it('starts a reply via button, right-click, long-press or touch swipe, cancels on Esc without stopping a busy agent, and sends replyTo', async () => {
    const user = userEvent.setup();
    const events = [
      ev(10, 'message', { text: 'Check the margins.' }, { number: 1, person: { id: ME.person.id, name: ME.person.name } }),
      ev(12, 'text', { text: 'Gross margin is 64%.' }, { number: 2 }),
    ];
    const { calls } = open({
      [`GET ${EVENTS}?last=300`]: [200, { events, state: BUSY }],
      [`GET ${EVENTS}?after=12`]: [200, { events: [], state: BUSY }],
      'POST /api/agents/orchestrator/messages': [202, { jobId: 'j2' }],
      'POST /api/agents/orchestrator/stop': [202, {}],
    });

    const msg2 = (await screen.findByText('Gross margin is 64%.')).closest('article')!;
    /* 1. Hover action button opens composer quote. */
    await user.click(within(msg2).getByRole('button', { name: 'Reply to #2' }));
    const preview = screen.getByTestId('chat-reply-preview');
    expect(within(preview).getByText('Orchestrator')).toBeInTheDocument();
    expect(within(preview).getByText('#2')).toBeInTheDocument();
    expect(within(preview).getByText('Gross margin is 64%.')).toBeInTheDocument();

    /* Pressing Escape cancels the reply first and MUST NOT stop the running agent turn! */
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('chat-reply-preview')).not.toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/agents/orchestrator/stop')).toBe(false);

    /* 2. Right-click opens composer quote, and cancel button clears it. */
    fireEvent.contextMenu(msg2);
    expect(screen.getByTestId('chat-reply-preview')).toBeInTheDocument();
    await user.click(within(screen.getByTestId('chat-reply-preview')).getByRole('button', { name: 'Cancel reply' }));
    expect(screen.queryByTestId('chat-reply-preview')).not.toBeInTheDocument();

    /* 3. Touch long-press opens composer quote. */
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    fireEvent.pointerDown(msg2, { pointerType: 'touch', clientX: 120, clientY: 80 });
    await act(async () => {
      vi.advanceTimersByTime(520);
    });
    expect(screen.getByTestId('chat-reply-preview')).toBeInTheDocument();
    fireEvent.pointerUp(msg2, { pointerType: 'touch', clientX: 120, clientY: 80 });
    fireEvent.click(within(screen.getByTestId('chat-reply-preview')).getByRole('button', { name: 'Cancel reply' }));
    expect(screen.queryByTestId('chat-reply-preview')).not.toBeInTheDocument();

    /* 4. Touch swipe opens composer quote, and sending includes replyTo: 1. */
    const msg1 = screen.getByText('Check the margins.').closest('article')!;
    fireEvent.pointerDown(msg1, { pointerType: 'touch', clientX: 200, clientY: 80 });
    fireEvent.pointerMove(msg1, { pointerType: 'touch', clientX: 140, clientY: 82 });
    fireEvent.pointerUp(msg1, { pointerType: 'touch', clientX: 140, clientY: 82 });
    expect(within(screen.getByTestId('chat-reply-preview')).getByText('#1')).toBeInTheDocument();

    const input = screen.getByRole('textbox', { name: 'Write to the orchestrator' });
    fireEvent.change(input, { target: { value: 'Include Q3 as well.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await act(async () => {});

    const sent = calls.find(c => c.method === 'POST' && c.path === '/api/agents/orchestrator/messages');
    expect(sent?.body).toEqual({ text: 'Include Q3 as well.', replyTo: 1 });
    expect(screen.queryByTestId('chat-reply-preview')).not.toBeInTheDocument();
  });

  it('jumps to and highlights the quoted original message, loading older history pages when outside the loaded window', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const olderPage = [
      ev(1, 'text', { text: 'Original architecture decision from last week.' }, { number: 1 }),
      ev(2, 'message', { text: 'Looks solid.' }, { number: 2, person: { id: ME.person.id, name: ME.person.name } }),
    ];
    const recentPage = Array.from({ length: 300 }, (_, idx) => {
      const n = idx + 3;
      const seq = idx + 10;
      if (idx === 299) {
        return ev(seq, 'message', { text: 'Revisiting that architecture choice.' }, {
          number: n,
          person: { id: ME.person.id, name: ME.person.name },
          replyTo: {
            number: 1,
            seq: 1,
            sender: { kind: 'agent', id: 'a1', name: 'Orchestrator', role: null, department: null, agentKind: 'orchestrator' },
            excerpt: 'Original architecture decision from last week.',
          },
        });
      }
      return ev(seq, 'text', { text: `Intermediate note ${n}.` }, { number: n });
    });

    open({
      [`GET ${EVENTS}?last=300`]: [200, { events: recentPage, state: READY }],
      [`GET ${EVENTS}?last=200&before=10`]: [200, { events: olderPage }],
    });

    const latest = (await screen.findByText('Revisiting that architecture choice.')).closest('article')!;
    const quoteButton = within(latest).getByRole('button', { name: /#1/ });
    await user.click(quoteButton);

    const original = (await screen.findByText('Original architecture decision from last week.')).closest('article')!;
    expect(original).toHaveClass('highlighted');
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
