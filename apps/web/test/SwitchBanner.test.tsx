import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { Switched, SwitchWord } from '../src/types';
import { clock } from '../src/ui/subscription';
import { SwitchBanner } from '../src/ui/SwitchBanner';
import { mockApi } from './api-mock';

const STILL: SwitchWord = { self: 'm2', moving: false, from: null, to: null, since: null, cut: false, question: false };
const MACHINES = { machines: [{ id: 'm1', hostname: 'deb' }, { id: 'm2', hostname: 'mac' }] };
const HEARD = '2026-11-12T14:02:00.000Z';
const TAKEOVER: Switched = { id: 'h1', kind: 'takeover', reason: null, from: 'deb', to: 'mac', heard: HEARD, reach: '2026-11-12T14:01:40.000Z', at: '2026-11-12T14:03:00.000Z' };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Routes = Parameters<typeof mockApi>[0];
function shown(word: SwitchWord | (() => SwitchWord), more: { switched?: Switched | null; language?: string; routes?: Routes } = {}) {
  localStorage.setItem('hh-lang', more.language ?? 'en');
  const calls = mockApi({
    'GET /api/network/switch': () => [200, typeof word === 'function' ? word() : word],
    'GET /api/network/switched': [200, { switched: more.switched ?? null }],
    'GET /api/machines': [200, MACHINES],
    'GET /api/network/question': [200, { question: null, canAnswer: false }],
    ...more.routes,
  });
  const view = render(<LanguageProvider><SwitchBanner><p>the other banners</p></SwitchBanner></LanguageProvider>);
  return { calls, view };
}
const asked = (calls: { path: string }[], path: string) => calls.filter(call => call.path === path).length;

describe('the line that says where the company runs', () => {
  it.each([
    ['en', 'Moving the company to mac. Your work is kept. About a minute.'],
    ['ru', 'Компания переезжает на mac. Ваша работа сохранена. Около минуты.'],
  ])('says where the company moves, in %s', async (language, line) => {
    shown({ ...STILL, moving: true, from: 'm1', to: 'm2' }, { language });
    expect(await screen.findByText(line)).toBeInTheDocument();
    expect(screen.queryByText('the other banners')).not.toBeInTheDocument();
  });

  it('looks each second while the company moves, and every five otherwise', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let moving = true;
    const { calls } = shown(() => ({ ...STILL, moving, from: 'm1', to: 'm2' }));
    await screen.findByText('Moving the company to mac. Your work is kept. About a minute.');
    const before = asked(calls, '/api/network/switch');
    /* The clock also runs by itself, so a slow machine sees a look more: one each second is three or four, where one
       every five would be one at most. */
    await act(() => vi.advanceTimersByTimeAsync(3000));
    const moved = asked(calls, '/api/network/switch') - before;
    expect([moved >= 3, moved <= 4]).toEqual([true, true]);
    moving = false;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(await screen.findByText('the other banners')).toBeInTheDocument();
    const after = asked(calls, '/api/network/switch');
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    const still = asked(calls, '/api/network/switch') - after;
    expect([still >= 2, still <= 3]).toEqual([true, true]);
  });

  it('names no machine it does not know', async () => {
    const { view } = shown({ ...STILL, moving: true, from: 'm1', to: 'm9' });
    expect(await screen.findByText('Moving the company to another machine. Your work is kept. About a minute.')).toBeInTheDocument();
    view.unmount();
    const lost = shown({ ...STILL, moving: true, from: 'm1', to: null });
    expect(await screen.findByText('Lost deb. Hornhoof is finding where to go on; your work is kept.')).toBeInTheDocument();
    lost.view.unmount();
    shown({ ...STILL, moving: true, from: null, to: null });
    expect(await screen.findByText('Lost the machine that ran the server. Hornhoof is finding where to go on; your work is kept.')).toBeInTheDocument();
  });

  it('says that the copy of this machine is cut off', async () => {
    const { view } = shown({ ...STILL, cut: true, from: 'm1' });
    expect(await screen.findByText('mac cannot reach deb; copy stopped.')).toBeInTheDocument();
    view.unmount();
    shown({ ...STILL, self: null, cut: true, from: null }, { language: 'ru' });
    expect(await screen.findByText('Эта машина не может связаться с машиной, которая держит сервер; копия остановлена.')).toBeInTheDocument();
  });

  it('says where Hornhoof runs after a move, until the reader closes it', async () => {
    const user = userEvent.setup();
    const { view } = shown(STILL, { switched: TAKEOVER });
    expect(await screen.findByText(`Hornhoof runs on mac now. deb stopped answering at ${clock('en', HEARD)}.`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/Hornhoof runs on mac now/)).not.toBeInTheDocument();
    expect(screen.getByText('the other banners')).toBeInTheDocument();
    view.unmount();
    /* Not again for that move, and at once for the next one. */
    const again = shown(STILL, { switched: TAKEOVER });
    expect(await screen.findByText('the other banners')).toBeInTheDocument();
    await waitFor(() => expect(asked(again.calls, '/api/network/switched')).toBeGreaterThan(0));
    expect(screen.queryByText(/Hornhoof runs on mac now/)).not.toBeInTheDocument();
    again.view.unmount();
    shown(STILL, { switched: { ...TAKEOVER, id: 'h2', kind: 'planned', heard: null, reach: null } });
    expect(await screen.findByText('Hornhoof runs on mac now.')).toBeInTheDocument();
  });

  it('words each kind of move', async () => {
    const { view } = shown(STILL, { switched: { ...TAKEOVER, reason: 'disk_full' } });
    expect(await screen.findByText("deb's disk is full; mac leads.")).toBeInTheDocument();
    view.unmount();
    const chosen = shown(STILL, { switched: { ...TAKEOVER, kind: 'ceo' } });
    expect(await screen.findByText(`Hornhoof runs on mac now, from what it had at ${clock('en', TAKEOVER.reach)}, as you chose.`)).toBeInTheDocument();
    chosen.view.unmount();
    shown(STILL, { switched: { ...TAKEOVER, kind: 'takeover' }, language: 'ru' });
    expect(await screen.findByText(`Hornhoof теперь работает на mac. Машина deb перестала отвечать в ${clock('ru', HEARD)}.`)).toBeInTheDocument();
  });

  it('keeps the last line when a look fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = false;
    shown(STILL, { routes: { 'GET /api/network/switch': () => (down ? [502, { error: { code: 'unavailable', message: 'down' } }] : [200, { ...STILL, moving: true, from: 'm1', to: 'm2' }]) } });
    const line = 'Moving the company to mac. Your work is kept. About a minute.';
    expect(await screen.findByText(line)).toBeInTheDocument();
    down = true;
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it('shows the question as soon as the keeper says one stands', async () => {
    const question = { since: HEARD, leader: { networkId: 'a'.repeat(64), host: 'deb', heard: HEARD }, copies: [{ networkId: 'b'.repeat(64), host: 'mac', number: 2, reach: null, self: true }], waiting: null };
    const { view } = shown({ ...STILL, question: true }, { routes: { 'GET /api/network/question': [200, { question, canAnswer: false }] } });
    expect(await screen.findByRole('group', { name: 'The server stopped answering' })).toBeInTheDocument();
    view.unmount();
    /* Also while the machine says the company moves: the question is the CEO's to answer. */
    shown({ ...STILL, moving: true, from: 'm1', to: null, question: true }, { routes: { 'GET /api/network/question': [200, { question, canAnswer: false }] } });
    expect(await screen.findByRole('group', { name: 'The server stopped answering' })).toBeInTheDocument();
    expect(screen.queryByText(/Lost deb/)).not.toBeInTheDocument();
  });
});
