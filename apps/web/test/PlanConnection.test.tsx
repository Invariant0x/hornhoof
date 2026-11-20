import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { Connecting, SubView } from '../src/types';
import { PlanConnection, READY_SAID_MS, ReadySaid, passedWords } from '../src/ui/PlanConnection';
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

describe('a plan connecting after its sign-in code, on its card', () => {
  const shown = (sub: SubView, c: Connecting) => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    render(<LanguageProvider><PlanConnection sub={sub} connecting={c} now={NOW} onRetry={onRetry} onCancel={onCancel} /></LanguageProvider>);
    return { part: screen.getByRole('group', { name: en.subs.connection.label('Codex') }), onRetry, onCancel };
  };
  const words = en.subs.connection;
  const passed = words.passed(words.minutes(1, 5));

  it('says the step its node reports as the status, then the time since the code outside it, with the ring in the marker of its sign-in, the third of four steps', () => {
    const { part } = shown(CODEX, at('connecting', 'models'));
    expect(within(part).getByRole('status').textContent).toBe(`${words.steps.models}.`);
    expect(part.querySelector('.conn-at')?.textContent).toBe(`${words.steps.models}. ${passed}`);
    expect(part.querySelector('.conn-at > .conn-time')?.textContent).toBe(passed);
    expect(part.querySelector('.conn-time')?.closest('[role="status"], [aria-live]')).toBeNull();
    expect(part.textContent).toContain(words.keepOn);
    expect(within(part).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
    expect(part.querySelector('.conn-prog')?.textContent).toBe(words.progress(3, 4));
    const steps = within(part).getAllByRole('listitem');
    expect(steps.map(s => s.className)).toEqual(['done', 'done', 'now', 'next']);
    expect(steps[2]!.getAttribute('aria-current')).toBe('step');
    expect(steps[2]!.textContent).toBe(`${en.subs.steps.signIn('Codex')} ${en.subs.steps.current}`);
    expect(part.querySelectorAll('.spinner')).toHaveLength(1);
    expect(steps[2]!.querySelector('.conn-mk .spinner')).not.toBeNull();
    expect(within(part).queryAllByRole('button')).toEqual([]);
  });

  /* Design #1656: the time is not said every second. The status changes, and a screen reader speaks, with the step alone. */
  it('counts the time each second outside the status, which changes with the step alone', () => {
    const view = (now: number, step: Connecting['step']) => <LanguageProvider><PlanConnection sub={CODEX} connecting={at('connecting', step)} now={now} onRetry={() => {}} onCancel={() => {}} /></LanguageProvider>;
    const { rerender } = render(view(NOW, 'models'));
    const status = screen.getByRole('status');
    rerender(view(NOW + 1000, 'models'));
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe(`${words.steps.models}.`);
    expect(document.querySelector('.conn-time')?.textContent).toBe(words.passed(words.minutes(1, 6)));
    rerender(view(NOW + 2000, 'limits'));
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe(`${words.steps.limits}.`);
  });

  it('says why it failed, to sign in again from Hornhoof, with Retry and Stop, and the step that did not work in pink', () => {
    const { part, onRetry, onCancel } = shown(CODEX, at('failed', 'checking', { error: 'The program did not take the new sign-in, so nothing changed.' }));
    const failed = within(part).getByRole('alert');
    expect(failed.querySelector('.lf-t')?.textContent).toBe(en.subs.signInErrors.notTaken);
    expect(failed.querySelector('.lf-h')?.textContent).toBe(words.next.signInAgain);
    expect(within(part).getAllByRole('listitem')[2]!.className).toBe('bad');
    expect(part.querySelectorAll('.spinner')).toHaveLength(0);
    expect(within(failed).getAllByRole('button').map(b => b.textContent)).toEqual([en.common.retry, words.cancel]);
    fireEvent.click(within(part).getByRole('button', { name: words.retryLabel('Codex') }));
    fireEvent.click(within(part).getByRole('button', { name: words.cancelLabel('Codex') }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('sends a program that signs in on its machine back to the install window there', () => {
    render(<LanguageProvider><PlanConnection sub={AGY} connecting={at('failed', 'checking', { error: null, code: 1, line: 'Antigravity CLI did not finish signing in.' })} now={NOW} onRetry={() => {}} onCancel={() => {}} /></LanguageProvider>);
    const part = screen.getByRole('group', { name: words.label('Antigravity') });
    expect(within(part).getByRole('alert').querySelector('.lf-t')?.textContent).toBe(en.subs.signInEnded(1, 'Antigravity CLI did not finish signing in.'));
    expect(part.textContent).toContain(words.next.installWindow('dev-laptop'));
  });

  it('says a connection past its deadline failed as its computer stopped answering, and to check the computer', () => {
    const { part } = shown(CODEX, at('failed', 'models', { error: SIGNIN_ERRORS.noAnswer }));
    const failed = within(part).getByRole('alert');
    expect(failed.querySelector('.lf-t')?.textContent).toBe(en.subs.signInErrors.noAnswer);
    expect(failed.querySelector('.lf-h')?.textContent).toBe(words.next.noAnswer);
    expect(ru.subs.signInErrors.noAnswer).toBe('Не удалось подключить: машина перестала отвечать.');
  });

  it('a minute with no new step says it takes longer than usual, where it got to, with Retry and Stop, the ring staying in its marker alone', () => {
    const { part } = shown(CODEX, at('too_long', 'models'));
    const slow = part.querySelector('.load-fail.slow')!;
    expect(slow.getAttribute('role')).toBe('status');
    expect(slow.querySelector('.lf-t')?.textContent).toBe(en.common.tooLong);
    expect(slow.querySelector('.lf-h')?.textContent).toBe(words.slowHint);
    expect(part.textContent).toContain(`${words.steps.models}. ${passed}`);
    expect(slow.querySelector('.spinner')).toBeNull();
    expect(part.querySelectorAll('.conn-mk .spinner')).toHaveLength(1);
    expect(within(part).getAllByRole('button').map(b => b.textContent)).toEqual([en.common.retry, words.cancel]);
  });

  it('counts the key as the third step of a plan that takes one', () => {
    const KIMI: SubView = { ...CODEX, id: 's-kimi', provider: 'kimi', label: 'Kimi' };
    render(<LanguageProvider><PlanConnection sub={KIMI} connecting={at('connecting', 'checking')} now={NOW} onRetry={() => {}} onCancel={() => {}} /></LanguageProvider>);
    const part = screen.getByRole('group', { name: words.label('Kimi') });
    expect(within(part).getAllByRole('listitem')[2]!.textContent).toContain(en.subs.steps.key('Kimi'));
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

  it('keeps the new connection its node reports while Try again is still being answered', async () => {
    const stream = fakeStream();
    let answer: () => void = () => {};
    const answered = new Promise<void>(go => { answer = go; });
    const calls = mockApi({ ...routes(AGY), 'POST /api/subscriptions/s-agy/connecting/retry': async () => { await answered; return [204, undefined]; } });
    render(<Subscriptions me={ME} />);
    await openAll();
    tell(stream, AGY, at('too_long', 'models'));
    fireEvent.click(within(part('Antigravity')!).getByRole('button', { name: en.subs.connection.retryLabel('Antigravity') }));
    await waitFor(() => expect(calls.some(c => c.path === '/api/subscriptions/s-agy/connecting/retry')).toBe(true));
    tell(stream, AGY, at('connecting', 'checking'));
    await act(async () => { answer(); await answered; });
    /* The answer is read and Try again ends, a few turns of the event loop later. */
    for (let turn = 0; turn < 5; turn++) await act(async () => { await new Promise<void>(go => setImmediate(go)); });
    expect(within(part('Antigravity')!).getByRole('status').textContent).toContain(en.subs.connection.steps.checking);
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

/* Design #1656: a plan's ready card has no "Done" line; its status says once that it is ready. The status is there, empty,
   while the plan connects, so the words come as a change a screen reader says; a little later they go with it. */
describe('a plan that turns ready after connecting', () => {
  afterEach(() => vi.useRealTimers());
  const said = (sub: SubView) => <LanguageProvider><ReadySaid sub={sub} /></LanguageProvider>;
  const connecting: SubView = { ...CODEX, status: 'needs_login', connecting: at('connecting', 'models') };
  const ready: SubView = { ...CODEX, status: 'ready', connecting: null };

  it('keeps its status empty while it connects, says once that it is ready, then leaves no status', () => {
    vi.useFakeTimers();
    const { rerender } = render(said(connecting));
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    /* The machine said the connection ended; the plans are not read again yet. */
    rerender(said({ ...connecting, connecting: null }));
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('');
    rerender(said(ready));
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe(en.subs.connection.ready('Codex'));
    act(() => { vi.advanceTimersByTime(READY_SAID_MS - 1); });
    expect(status.textContent).toBe(en.subs.connection.ready('Codex'));
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole('status')).toBeNull();
    rerender(said({ ...ready }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing for a plan that was ready without connecting here', () => {
    render(said(ready));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says it with the plan name, in each language', () => {
    expect(en.subs.connection.ready('Codex')).toBe('Codex: done. Agents on this plan can work now.');
    expect(ru.subs.connection.ready('Codex')).toBe('Codex: готово. Агенты на этом тарифе уже могут работать.');
  });
});
