import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { Question } from '../src/types';
import { RecoveryQuestion } from '../src/ui/RecoveryQuestion';
import { clock } from '../src/ui/subscription';
import { mockApi } from './api-mock';

const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(64)) as [string, string, string, string];
const HEARD = '2026-11-12T14:02:00.000Z';
const REACH = '2026-11-12T14:01:40.000Z';
const ONE: Question = { since: '2026-11-12T14:02:30.000Z', leader: { networkId: A, host: 'deb', heard: HEARD }, copies: [{ networkId: B, host: 'mac', number: 2, reach: REACH, self: true }], waiting: null };
const THREE: Question = {
  ...ONE,
  copies: [...ONE.copies, { networkId: C, host: 'nuc', number: 3, reach: '2026-11-12T14:01:00.000Z', self: false }, { networkId: D, host: 'air', number: null, reach: null, self: false }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function shown(question: Question | null, canAnswer = true, language = 'en', routes: Parameters<typeof mockApi>[0] = {}) {
  localStorage.setItem('hh-lang', language);
  const calls = mockApi({ 'GET /api/network/question': [200, { question, canAnswer }], ...routes });
  const view = render(<LanguageProvider><RecoveryQuestion><p>the other banners</p></RecoveryQuestion></LanguageProvider>);
  return { calls, view };
}
const time = (language: string, iso: string) => clock(language as 'en', iso)!;

describe('the question of which copy to go on from', () => {
  it('asks about one copy, in both languages', async () => {
    const { view } = shown(ONE);
    const box = await screen.findByRole('group', { name: 'The server stopped answering' });
    expect(within(box).getByText(`deb stopped answering at ${time('en', HEARD)}. This mac may not have what deb did after ${time('en', REACH)}. That comes back when deb does.`)).toBeInTheDocument();
    expect(within(box).getAllByRole('button').map(button => button.textContent)).toEqual([`Go on from ${time('en', REACH)}`, 'Wait for deb']);
    expect(within(box).getByText('Only if deb is off. If deb works too, both sides get changes; Hornhoof merges them later and the orchestrator asks you about real conflicts.')).toBeInTheDocument();
    /* While the question stands, nothing else is said in its place. */
    expect(screen.queryByText('the other banners')).not.toBeInTheDocument();
    view.unmount();
    shown(ONE, true, 'ru');
    const ru = await screen.findByRole('group', { name: 'Сервер перестал отвечать' });
    expect(within(ru).getByText(`Машина deb перестала отвечать в ${time('ru', HEARD)}. У mac может не быть того, что машина deb сделала после ${time('ru', REACH)}. Это вернется вместе с deb.`)).toBeInTheDocument();
    expect(within(ru).getAllByRole('button').map(button => button.textContent)).toEqual([`Продолжить с ${time('ru', REACH)}`, 'Ждать deb']);
  });

  it('gives a button for each copy that is up, and the wait', async () => {
    shown(THREE);
    const box = await screen.findByRole('group', { name: 'The server stopped answering' });
    expect(within(box).getByText(`deb stopped answering at ${time('en', HEARD)}. The copies that are up may not have all deb did. That comes back when deb does.`)).toBeInTheDocument();
    expect(within(box).getAllByRole('button').map(button => button.textContent)).toEqual([
      `Go on from ${time('en', REACH)} on mac`, `Go on from ${time('en', '2026-11-12T14:01:00.000Z')} on nuc`, 'Go on from the copy on air', 'Wait for deb',
    ]);
  });

  it('shows the question without buttons to anyone but the CEO', async () => {
    shown(THREE, false);
    const box = await screen.findByRole('group', { name: 'The server stopped answering' });
    expect(within(box).queryAllByRole('button')).toEqual([]);
    expect(within(box).getByText('Only the CEO answers this, from their own session.')).toBeInTheDocument();
  });

  it("sends the CEO's answer after confirming a copy, and sends wait directly", async () => {
    /* Until a time that has not come whenever this runs: the line shows only while he still waits. */
    const waiting = { ...THREE, waiting: '2099-01-01T00:00:00.000Z' };
    let asked = 0;
    const { calls } = shown(null, true, 'en', {
      'GET /api/network/question': () => [200, { question: (asked += 1) > 2 ? waiting : THREE, canAnswer: true }],
      'POST /api/network/question/go-on': [202, { ok: true }],
      'POST /api/network/question/wait': [202, { ok: true }],
    });
    const user = userEvent.setup();
    const box = await screen.findByRole('group', { name: 'The server stopped answering' });
    await user.click(within(box).getByRole('button', { name: 'Wait for deb' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/network/question/wait', body: {} }]));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    /* The next look says he waits; he may still choose a copy. */
    expect(await within(box).findByText('Waiting for deb. You can still choose a copy to go on from.')).toBeInTheDocument();
    expect(within(box).getAllByRole('button')).toHaveLength(4);
    /* Choosing a copy with a reach time names both machine and time in <bdi>; Cancel sends nothing. */
    await user.click(within(box).getByRole('button', { name: `Go on from ${time('en', REACH)} on mac` }));
    const timed = screen.getByRole('alertdialog', { name: 'Do you really want to continue from this copy?' });
    expect(timed).toHaveAccessibleDescription(`Hornhoof will continue from the copy on mac as of ${time('en', REACH)}.`);
    expect([...timed.querySelectorAll('p bdi')].map(el => el.textContent)).toEqual(['mac', time('en', REACH)]);
    expect(timed).toHaveTextContent('Only if deb is off.');
    expect(timed).toHaveTextContent('This cannot be undone.');
    expect(within(timed).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(timed).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.filter(call => call.path === '/api/network/question/go-on')).toEqual([]);
    /* Choosing a copy without a reach time names the machine in <bdi>, and confirming sends go-on. */
    await user.click(within(box).getByRole('button', { name: 'Go on from the copy on air' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to continue from this copy?' });
    expect(dialog).toHaveAccessibleDescription('Hornhoof will continue from the copy on air.');
    expect(dialog.querySelector('p bdi')).toHaveTextContent('air');
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toHaveClass('danger');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST').at(-1)).toEqual({ method: 'POST', path: '/api/network/question/go-on', body: { networkId: D, reach: null } }));
    /* The copy he chose takes the server and is away from the page meanwhile: the buttons give way to what happens. */
    expect(await within(box).findByText('Hornhoof goes on from the copy you chose. About a minute.')).toBeInTheDocument();
    expect(within(box).queryAllByRole('button')).toEqual([]);
  });

  it('says why an answer was refused, in the dialog for go-on and on the banner for wait', async () => {
    const { view } = shown(ONE, true, 'en', {
      'POST /api/network/question/wait': [409, { error: { code: 'conflict', reason: 'question_changed', message: 'The question changed. Look again.' } }],
      'POST /api/network/question/go-on': [409, { error: { code: 'conflict', reason: 'question_changed', message: 'The question changed. Look again.' } }],
    });
    const user = userEvent.setup();
    const box = await screen.findByRole('group', { name: 'The server stopped answering' });
    await user.click(within(box).getByRole('button', { name: 'Wait for deb' }));
    expect(await within(box).findByRole('alert')).toHaveTextContent('The question changed. Look again.');
    await user.click(within(box).getByRole('button', { name: `Go on from ${time('en', REACH)}` }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The question changed. Look again.');
    view.unmount();
  });

  it('keeps the question while a look fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = false;
    shown(ONE, true, 'en', { 'GET /api/network/question': () => (down ? [502, { error: { code: 'unavailable', message: 'down' } }] : [200, { question: ONE, canAnswer: true }]) });
    const box = await screen.findByRole('group', { name: 'The server stopped answering' });
    down = true;
    await act(() => vi.advanceTimersByTimeAsync(11_000));
    expect(box).toBeInTheDocument();
    expect(within(box).getAllByRole('button')).toHaveLength(2);
    vi.useRealTimers();
  });

  it('shows what else there is to say while nothing is asked, also on a server that knows no question', async () => {
    const { view } = shown(null);
    expect(await screen.findByText('the other banners')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'The server stopped answering' })).not.toBeInTheDocument();
    view.unmount();
    mockApi({});
    render(<LanguageProvider><RecoveryQuestion><p>the other banners</p></RecoveryQuestion></LanguageProvider>);
    expect(await screen.findByText('the other banners')).toBeInTheDocument();
  });
});
