import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { Connecting, SubView } from '../src/types';
import { PlanConnection, passedWords } from '../src/ui/PlanConnection';
import { Stalled, Waiting } from '../src/ui/Waiting';
import { ME, mockApi, SUBS } from './api-mock';
import { fakeStream } from './fake-stream';
import { openAll, rowOf, waitFor } from './subscriptions-helpers';

vi.mock('../src/ui/AgentTerminal', () => ({
  AgentTerminal: ({ path }: { path: string }) => <div data-testid="live-terminal" data-path={path} />,
}));

afterEach(() => localStorage.clear());

const NODE = '7d1c6a52-2f4e-4c4b-9f55-0d7a3c1e9b10';
const CODEX = SUBS[1]!;
const AGY: SubView = { ...CODEX, id: 's-agy', provider: 'antigravity', label: 'Antigravity' };
const SINCE = '2026-11-19T22:00:00.000Z';
/* 1 min 5 s after the code. */
const NOW = Date.parse('2026-11-19T22:01:05.000Z');
const at = (state: Connecting['state'], step: Connecting['step'], more: Partial<Connecting> = {}): Connecting => (
  { nodeId: NODE, hostname: 'dev-laptop', state, step, since: SINCE, until: '2026-11-19T22:10:00.000Z', error: null, code: null, line: null, ...more });

describe('the time since the sign-in code', () => {
  it.each([
    [0, '0 s', '0 с'],
    [59_999, '59 s', '59 с'],
    [60_000, '1 min 0 s', '1 мин 0 с'],
    [65_400, '1 min 5 s', '1 мин 5 с'],
    [61 * 60_000, '61 min 0 s', '61 мин 0 с'],
  ])('reads %i ms as whole seconds, then minutes and seconds', (ms, inEnglish, inRussian) => {
    expect(passedWords(en, ms)).toBe(inEnglish);
    expect(passedWords(ru, ms)).toBe(inRussian);
  });

  it('reads a clock a little behind the server as no time at all', () => {
    expect(passedWords(en, -1500)).toBe('0 s');
  });

  it('says every connection step and the overlong state in plain words in each language', () => {
    for (const t of [en, ru]) {
      for (const words of Object.values(t.subs.connection.steps)) expect(words).toMatch(/^\S.*\S$/);
      expect(t.common.tooLong.length).toBeGreaterThan(0);
      expect(JSON.stringify(t.subs.connection)).not.toMatch(/[—–]/);
    }
    expect(en.common.tooLong).toBe('Taking longer than usual');
    expect(ru.common.tooLong).toBe('Дольше обычного');
    expect(en.subs.signInErrors.signedOut).toBe(SIGNIN_ERRORS.signedOut);
  });
});

describe('something under way, and something stalled', () => {
  it('shows a turning mark only while something is under way, with what it is at as a status', () => {
    const { container } = render(<Waiting what="Getting the models" detail="1 min 5 s since the code" />);
    expect(screen.getByRole('status').textContent).toBe('Getting the models1 min 5 s since the code');
    expect(container.querySelectorAll('.waiting-mark')).toHaveLength(1);
  });

  it('says why it stalled as an alert, then what to do, with Try again first and no mark', () => {
    const { container } = render(<Stalled tone="late" reason="Taking longer than usual" next="Try again, or stop." retry={{ text: 'Try again', label: 'Try connecting Codex again', run: () => {} }} cancel={{ text: 'Stop', run: () => {} }} />);
    expect(screen.getByRole('alert').textContent).toBe('Taking longer than usual');
    expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Try connecting Codex again', 'Stop']);
    expect(container.querySelectorAll('.waiting-mark')).toHaveLength(0);
  });
});

describe('a plan connecting after its sign-in code, on its card', () => {
  const shown = (sub: SubView, c: Connecting) => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    render(<LanguageProvider><PlanConnection sub={sub} connecting={c} now={NOW} onRetry={onRetry} onCancel={onCancel} /></LanguageProvider>);
    return { part: screen.getByRole('group', { name: en.subs.connection.label('Codex') }), onRetry, onCancel };
  };
  const words = en.subs.connection;
  const passed = words.passed(words.minutes(1, 5));

  it('says the step its node reports and the time since the code, with nothing to press', () => {
    const { part } = shown(CODEX, at('connecting', 'models'));
    expect(within(part).getByRole('status').textContent).toBe(`${words.steps.models}${passed}`);
    expect(within(part).queryAllByRole('button')).toEqual([]);
  });

  it('says why it failed, to sign in again from Hornhoof, with Try again and Stop', () => {
    const { part, onRetry, onCancel } = shown(CODEX, at('failed', 'checking', { error: 'The program did not take the new sign-in, so nothing changed.' }));
    expect(within(part).getByRole('alert').textContent).toBe(en.subs.signInErrors.notTaken);
    expect(part.textContent).toContain(words.next.signInAgain);
    fireEvent.click(within(part).getByRole('button', { name: words.retryLabel('Codex') }));
    fireEvent.click(within(part).getByRole('button', { name: words.cancelLabel('Codex') }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('sends a program that signs in on its machine back to the install window there', () => {
    render(<LanguageProvider><PlanConnection sub={AGY} connecting={at('failed', 'checking', { error: null, code: 1, line: 'Antigravity CLI did not finish signing in.' })} now={NOW} onRetry={() => {}} onCancel={() => {}} /></LanguageProvider>);
    const part = screen.getByRole('group', { name: words.label('Antigravity') });
    expect(within(part).getByRole('alert').textContent).toBe(en.subs.signInEnded(1, 'Antigravity CLI did not finish signing in.'));
    expect(part.textContent).toContain(words.next.installWindow('dev-laptop'));
  });

  it('past its one limit says it takes longer than usual, how long the limit is, and where it got to', () => {
    const { part } = shown(CODEX, at('too_long', 'models'));
    expect(within(part).getByRole('alert').textContent).toBe(en.common.tooLong);
    expect(part.textContent).toContain(words.tooLongNext(10));
    expect(part.textContent).toContain(`${words.steps.models}. ${passed}`);
    expect(part.querySelectorAll('.waiting-mark')).toHaveLength(0);
  });
});

describe('the plans screen while a plan connects', () => {
  const routes = (plan: SubView) => ({
    'GET /api/nodes/commands': [200, { commands: [] }] as [number, unknown],
    'GET /api/subscriptions': [200, { subscriptions: [plan] }] as [number, unknown],
    [`POST /api/subscriptions/${plan.id}/signin`]: [200, { nodeId: NODE, hostname: 'dev-laptop' }] as [number, unknown],
    [`POST /api/subscriptions/${plan.id}/connecting/retry`]: [204, undefined] as [number, unknown],
    [`POST /api/subscriptions/${plan.id}/connecting/cancel`]: [204, undefined] as [number, unknown],
  });
  const tell = (stream: ReturnType<typeof fakeStream>, plan: SubView, connecting: Connecting | null) =>
    stream.send({ type: 'subscription.connecting', subscriptionId: plan.id, connecting, owner: 'p1' });
  const part = (name: string) => within(rowOf(name)).queryByRole('group', { name: en.subs.connection.label(name) });

  it('shows the connection its node reports on the card, and reads the plans again once it ended', async () => {
    const stream = fakeStream();
    const calls = mockApi(routes(CODEX));
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(part('Codex')).toBeNull();
    tell(stream, CODEX, at('connecting', 'saving'));
    expect(within(part('Codex')!).getByRole('status').textContent).toContain(en.subs.connection.steps.saving);
    const reads = calls.filter(c => c.path === '/api/subscriptions').length;
    tell(stream, CODEX, null);
    expect(part('Codex')).toBeNull();
    await waitFor(() => expect(calls.filter(c => c.path === '/api/subscriptions').length).toBe(reads + 1));
  });

  it('tries a plan that signs in from Hornhoof again with a new sign-in', async () => {
    const stream = fakeStream();
    const calls = mockApi(routes(CODEX));
    render(<Subscriptions me={ME} />);
    await openAll();
    tell(stream, CODEX, at('failed', 'checking', { error: 'The program did not take the new sign-in, so nothing changed.' }));
    fireEvent.click(within(part('Codex')!).getByRole('button', { name: en.subs.connection.retryLabel('Codex') }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/subscriptions/s-codex/signin', body: { fresh: false } }));
    await waitFor(() => expect(part('Codex')).toBeNull());
  });

  it('has the node check a plan that signs in on its machine again, or stops it', async () => {
    const stream = fakeStream();
    const calls = mockApi(routes(AGY));
    render(<Subscriptions me={ME} />);
    await openAll();
    tell(stream, AGY, at('too_long', 'models'));
    fireEvent.click(within(part('Antigravity')!).getByRole('button', { name: en.subs.connection.retryLabel('Antigravity') }));
    await waitFor(() => expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual(['/api/subscriptions/s-agy/connecting/retry']));
    await waitFor(() => expect(part('Antigravity')).toBeNull());
    tell(stream, AGY, at('failed', 'checking', { error: 'The program on this machine is not signed in, so nothing changed.' }));
    fireEvent.click(within(part('Antigravity')!).getByRole('button', { name: en.subs.connection.cancelLabel('Antigravity') }));
    await waitFor(() => expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual(['/api/subscriptions/s-agy/connecting/retry', '/api/subscriptions/s-agy/connecting/cancel']));
    await waitFor(() => expect(part('Antigravity')).toBeNull());
  });
});
