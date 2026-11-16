import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { ProgramVersions } from '../src/ui/ProgramVersions';
import { mockApi } from './api-mock';

const claude = { id: 'claude' as const, version: '2.0.0', updating: false, failed: false };
const defaults = { id: 'machine-1', online: true, programs: [claude], canUpdate: true, onUpdated: async () => {} };
afterEach(() => localStorage.clear());

describe('program versions on a machine', () => {
  it.each([
    ['en', 'Agent programs', 'Version unknown', 'Updating programs...', 'Update failed. Try again.'],
    ['ru', 'Программы агентов', 'Версия неизвестна', 'Обновляем программы...', 'Не удалось обновить. Попробуйте еще раз.'],
  ])('shows versions, partial failures and update progress in %s', (language, heading, unknown, updating, failed) => {
    localStorage.setItem('hh-lang', language);
    render(<LanguageProvider><ProgramVersions {...defaults} programs={[
      claude, { id: 'codex', version: '3.0.0', updating: false, failed: true },
      { id: 'codex', version: '4.0.0', updating: false, failed: false }, { id: 'kimi', version: null, updating: true, failed: false },
    ]} /></LanguageProvider>);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    for (const text of ['Claude Code', 'Codex', 'Kimi Code', '2.0.0', '3.0.0', '4.0.0', unknown, failed]) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(updating);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  const REASON = 'Error: claude native binary not installed. Either postinstall did not run ... or the platform-native optional dependency was not downloaded (--omit=optional)';
  it.each([
    ['en', 'Installed only in part, installing it again.', 'It does not start, even installed again:', 'It does not start, even installed again.'],
    ['ru', 'Установлена не полностью, ставим заново.', 'Не запускается, даже установленная заново:', 'Не запускается, даже установленная заново.'],
  ])('says a program is installed again, or why it still does not start, in %s, and never that it needs a sign-in', (language, reinstalling, broken, brokenBare) => {
    localStorage.setItem('hh-lang', language);
    render(<LanguageProvider><ProgramVersions {...defaults} programs={[
      { ...claude, repair: 'reinstalling' }, { id: 'codex', version: '3.0.0', updating: false, failed: true, repair: 'broken', reason: REASON },
      { id: 'kimi', version: null, updating: false, failed: false, repair: 'broken' },
    ]} /></LanguageProvider>);
    expect(screen.getByText(reinstalling)).toBeInTheDocument();
    expect(screen.getByText(`${broken} ${REASON}`)).toBeInTheDocument();
    expect(screen.getByText(brokenBare)).toBeInTheDocument();
    expect(screen.queryByText(/sign in|войти|вход/i)).toBeNull();
  });

  it.each(['machine-1', 'builtin'])('requests %s once while waiting and refreshes the card after the response', async id => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const calls = mockApi({ [`POST /api/machines/${id}/programs/update`]: async () => { await pending; return [202, { updating: true }]; } });
    const onUpdated = vi.fn(async () => {});
    render(<ProgramVersions {...defaults} id={id} onUpdated={onUpdated} />);
    const user = userEvent.setup();
    const update = screen.getByRole('button', { name: 'Update programs' });
    await user.click(update);
    expect(update).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Updating programs...');
    await user.click(update);
    expect(calls).toEqual([{ method: 'POST', path: `/api/machines/${id}/programs/update`, body: undefined }]);
    release();
    await screen.findByRole('button', { name: 'Update programs' });
    await vi.waitFor(() => expect(update).toBeEnabled());
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it('stays disabled for reported progress and uses the new version after the next report', () => {
    const { rerender } = render(<ProgramVersions {...defaults} programs={[{ ...claude, updating: true }]} />);
    expect(screen.getByRole('button')).toBeDisabled();
    rerender(<ProgramVersions {...defaults} programs={[{ ...claude, version: '3.0.0' }]} />);
    expect(screen.getByRole('button')).toBeEnabled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('3.0.0')).toBeInTheDocument();
  });

  it('shows a request failure, permits retry and clears the error on success', async () => {
    let attempts = 0;
    mockApi({ 'POST /api/machines/machine-1/programs/update': () => ++attempts === 1
      ? [409, { error: { code: 'conflict', reason: 'programs_unavailable' } }] : [202, { updating: true }] });
    render(<ProgramVersions {...defaults} />);
    const user = userEvent.setup();
    const update = screen.getByRole('button', { name: 'Update programs' });
    await user.click(update);
    expect(await screen.findByRole('alert')).toHaveTextContent('Programs cannot be updated on this machine right now.');
    expect(update).toBeEnabled();
    await user.click(update);
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(attempts).toBe(2);
  });

  it.each([
    [false, [claude], 'Reconnect this machine to see its program versions.'],
    [true, null, 'This machine has not reported its program versions yet.'],
    [true, [], 'There are no programs to update here.'],
  ] as const)('shows an unavailable state when online=%s and programs=%j', (online, programs, text) => {
    render(<ProgramVersions {...defaults} online={online} programs={programs === null ? null : [...programs]} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('2.0.0')).toBeNull();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('shows versions without an update action to a person who cannot change this machine', () => {
    render(<ProgramVersions {...defaults} canUpdate={false} />);
    expect(screen.getByText('2.0.0')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
