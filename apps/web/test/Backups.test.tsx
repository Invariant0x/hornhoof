import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Backups } from '../src/screens/Backups';
import type { BackupBundle, BackupsView, RestoreStatus } from '../src/types';
import { mockApi } from './api-mock';

const ID = '0f0f0f0f-0000-4000-8000-00000000000a';
const OTHER = '0f0f0f0f-0000-4000-8000-00000000000b';
const DUMPED = '2026-11-10T08:00:00.000Z';
const bundle = (over: Partial<BackupBundle> = {}): BackupBundle => ({
  id: ID, dumpedAt: DUMPED, reason: 'timer', size: 5 * 1024 * 1024, recovery: 'current',
  where: [{ machine: null, name: 'this server', online: true }, { machine: 'm1', name: 'office-pc', online: true }, { machine: 'm2', name: 'office-mini', online: false }], restorable: true, why: null, ...over,
});
const viewOf = (over: Partial<BackupsView> = {}): BackupsView => ({ last: DUMPED, recovery: { madeAt: '2026-11-09T10:00:00.000Z', madeBy: 'Ivan' }, recoveryNeeded: false, linkChanged: false, restore: null, kept: [], bundles: [bundle()], ...over });
const status = (over: Partial<RestoreStatus>): RestoreStatus => ({ attempt: 'a1', id: ID, state: 'running', step: 'fetch', line: 'Getting the backup.', at: DUMPED, kept: null, ...over });
const shown = () => render(<LanguageProvider><Backups /></LanguageProvider>);

afterEach(() => vi.unstubAllGlobals());

describe('Backups in Settings', () => {
  it('says when the last backup was made, and when there is none or it is old', async () => {
    mockApi({ 'GET /api/backups': [200, viewOf({ last: new Date().toISOString() })] });
    shown();
    expect(await screen.findByText(/^The last backup: /)).toBeInTheDocument();
    expect(screen.queryByText('The last backup is older than 12 hours. Check that this server has free disk.')).not.toBeInTheDocument();
    /* Each backup: when and why it was made, how big it is, and who holds it. */
    expect(screen.getByText(/every 6 hours/)).toHaveTextContent('5 MB');
    expect(screen.getByText('Held by: this server, office-pc, office-mini (offline)')).toBeInTheDocument();
  });

  it('warns about an old backup, and says so when there is none', async () => {
    mockApi({ 'GET /api/backups': [200, viewOf({ last: new Date(Date.now() - 13 * 3_600_000).toISOString(), bundles: [bundle({ reason: 'update', recovery: 'older' })] })] });
    const first = shown();
    expect(await screen.findByText('The last backup is older than 12 hours. Check that this server has free disk.')).toBeInTheDocument();
    expect(screen.getByText(/before an update/)).toBeInTheDocument();
    expect(screen.getByText('Not for the current recovery file')).toBeInTheDocument();
    first.unmount();
    mockApi({ 'GET /api/backups': [200, viewOf({ last: null, recovery: null, recoveryNeeded: true, bundles: [] })] });
    shown();
    expect(await screen.findByText('No backup yet.')).toBeInTheDocument();
    expect(screen.getByText('Not saved yet. Without it the company cannot be restored if this server is lost.')).toBeInTheDocument();
    expect(screen.queryByText('Restore from a backup')).not.toBeInTheDocument();
  });

  it('names a database set aside before a merge among the backups', async () => {
    mockApi({ 'GET /api/backups': [200, viewOf({ bundles: [bundle(), bundle({ id: OTHER, dumpedAt: '2026-11-09T08:00:00.000Z', reason: 'fork' })] })] });
    shown();
    expect(await screen.findByText(/, Set aside before a merge, 5 MB$/)).toBeInTheDocument();
    expect(screen.getByText(/, every 6 hours, 5 MB$/)).toBeInTheDocument();
  });

  it('saves the recovery file', async () => {
    const calls = mockApi({
      'GET /api/backups': [200, viewOf({ recovery: null, recoveryNeeded: true })],
      'POST /api/backups/recovery': [200, { name: 'hornhoof-recovery-acme-2026-11-10.txt', text: '# Hornhoof recovery file for Acme.\n{"v":1}\n' }],
    });
    /* The browser keeps the file: one download, under the name the server gave it. */
    const made: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((blob: Blob) => (made.push(blob), 'blob:recovery')), revokeObjectURL: vi.fn() }));
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(`${this.download} ${this.href}`); });
    const user = userEvent.setup();
    shown();
    await user.click(await screen.findByRole('button', { name: 'Save the recovery file' }));
    expect(await screen.findByText(/^Saved\. Keep it like a password: it opens every backup made for it\. Older recovery files open only backups made before /)).toBeInTheDocument();
    expect(downloads).toEqual(['hornhoof-recovery-acme-2026-11-10.txt blob:recovery']);
    expect(await made[0]!.text()).toBe('# Hornhoof recovery file for Acme.\n{"v":1}\n');
    expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/backups/recovery', body: undefined }]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recovery');
    click.mockRestore();
  });

  it('says who saved the recovery file', async () => {
    mockApi({ 'GET /api/backups': [200, viewOf()] });
    shown();
    expect(await screen.findByText(/^Saved on .+ by Ivan\.$/)).toBeInTheDocument();
  });

  it('restores after the warning', async () => {
    let restore: RestoreStatus | null = null;
    const calls = mockApi({
      'GET /api/backups': () => [200, viewOf({ restore })],
      [`GET /api/backups/${ID}/warning`]: [200, { machines: [{ name: 'new-pc', owner: 'Maria' }, { name: 'lab', owner: 'Ivan' }], people: ['Sasha'] }],
      [`POST /api/backups/${ID}/restore`]: () => {
        restore = status({ step: 'open', line: 'Opening the backup.' });
        return [202, { attempt: 'a1' }];
      },
    });
    const user = userEvent.setup();
    shown();
    await user.click(await screen.findByRole('button', { name: /^Restore the backup of / }));
    const ask = await screen.findByRole('group', { name: /^Restore the company as it was at .+\?$/ });
    /* What came after comes back unless the CEO says otherwise. */
    const bring = within(ask).getByRole('checkbox', { name: /^Bring back what came after / });
    expect(bring).toBeChecked();
    expect(within(ask).getByText(/^What the company did after .+ comes back as additions\. Anything that differs goes to the orchestrator as a task, with both values; the restored values stay until he picks\.$/)).toBeInTheDocument();
    await user.click(bring);
    expect(within(ask).getByText(/^The database from before is saved as an encrypted backup for 30 days, then removed from this machine\. What came after .+ does not come back\.$/)).toBeInTheDocument();
    expect(within(ask).queryByText(/comes back as additions/)).not.toBeInTheDocument();
    await user.click(bring);
    expect(screen.getByText('These machines joined later and must be connected again: new-pc, lab.')).toBeInTheDocument();
    expect(screen.getByText('These people were added later and must be invited again: Sasha.')).toBeInTheDocument();
    expect(screen.getByText('Everyone signs in again afterwards.')).toBeInTheDocument();
    expect(screen.getByText('The machines keep their access settings. The orchestrator gives employees access again as needed.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Recovery file')).not.toBeInTheDocument();
    /* Cancel asks nothing of the server. */
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
    await user.click(screen.getByRole('button', { name: /^Restore the backup of / }));
    const askAgain = await screen.findByRole('group', { name: /^Restore the company/ });
    await user.click(within(askAgain).getByRole('button', { name: 'Restore' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Do you really want to restore this backup?' });
    expect(confirm.querySelector('p bdi')).not.toBeNull();
    expect(confirm).toHaveTextContent(/comes back as additions/);
    expect(confirm).toHaveTextContent('Everyone signs in again afterwards.');
    expect(confirm).toHaveTextContent('This cannot be undone.');
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(confirm).getByRole('button', { name: 'Restore' })).toHaveClass('danger');
    /* Cancelling the confirmation dialog leaves RestoreAsk open and sends nothing. */
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: /^Restore the company/ })).toBeInTheDocument();
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
    await user.click(within(screen.getByRole('group', { name: /^Restore the company/ })).getByRole('button', { name: 'Restore' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `/api/backups/${ID}/restore`, body: { bringBack: true } }]));
    /* The steps it went through so far, and no button to start another meanwhile. */
    expect(await screen.findByText('Opening it')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Getting the backup')).toBeInTheDocument();
    expect(screen.getByText('Checking it')).toBeInTheDocument();
    expect(screen.queryByText('Switching databases')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Restore the backup of / })).not.toBeInTheDocument();
  });

  it('shows how a restore ended, in the words the server wrote, and the databases that were kept', async () => {
    mockApi({ 'GET /api/backups': [200, viewOf({ restore: status({ state: 'failed', step: 'check', line: 'This backup does not match what the company recorded.' }), kept: [{ name: 'hornhoof_before_20261110_090000', at: '2026-11-10T09:00:00.000Z' }] })] });
    shown();
    expect(await screen.findByText('This backup does not match what the company recorded.')).toBeInTheDocument();
    expect(screen.getByText(/^The database from before the restore of .+ is kept on this server\.$/)).toBeInTheDocument();
    /* Ended, another can be started. */
    expect(screen.getByRole('button', { name: /^Restore the backup of / })).toBeInTheDocument();
  });

  it('says how a restore ended in the language of the person, whose server writes in English', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      mockApi({ 'GET /api/backups': [200, viewOf({ restore: status({ state: 'failed', step: 'check', line: 'This backup does not match what the company recorded.' }) })] });
      const failed = shown();
      expect(await screen.findByText('Восстановление остановилось на шаге «Проверяем ее». Компания осталась такой, как была.')).toBeInTheDocument();
      expect(screen.queryByText('This backup does not match what the company recorded.')).not.toBeInTheDocument();
      failed.unmount();
      mockApi({ 'GET /api/backups': [200, viewOf({ restore: status({ state: 'done', step: 'start', line: 'Restored the backup of 2026-11-10T08:00:00.000Z.' }) })] });
      shown();
      expect(await screen.findByText('Компания восстановлена из копии.')).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('says that the session ended once the restore finished', async () => {
    let over = false;
    mockApi({ 'GET /api/backups': () => (over ? [401, { error: { code: 'unauthorized', message: 'Sign in to continue.', reason: 'signed_out' } }] : [200, viewOf({ restore: status({ step: 'start' }) })]) });
    shown();
    expect(await screen.findByText('Starting the company')).toHaveAttribute('aria-current', 'step');
    /* The restored company ends every session: the next look is refused, which is how the page learns of it. */
    over = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(await screen.findByText('Your session has ended, as it does when a restore finishes. Sign in again.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/');
      expect(screen.queryByText('Starting the company')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores without bringing back what came after when the CEO unticks it', async () => {
    const calls = mockApi({
      'GET /api/backups': [200, viewOf()],
      [`GET /api/backups/${ID}/warning`]: [200, { machines: [], people: [] }],
      [`POST /api/backups/${ID}/restore`]: [202, { attempt: 'a1' }],
    });
    const user = userEvent.setup();
    shown();
    await user.click(await screen.findByRole('button', { name: /^Restore the backup of / }));
    const ask = await screen.findByRole('group', { name: /^Restore the company/ });
    await user.click(within(ask).getByRole('checkbox', { name: /^Bring back what came after / }));
    await user.click(within(ask).getByRole('button', { name: 'Restore' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Do you really want to restore this backup?' });
    expect(confirm).toHaveTextContent(/does not come back\./);
    expect(confirm).toHaveTextContent('Everyone signs in again afterwards.');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    /* Cancelling leaves the unticked checkbox intact. */
    expect(within(ask).getByRole('checkbox', { name: /^Bring back what came after / })).not.toBeChecked();
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
    await user.click(within(ask).getByRole('button', { name: 'Restore' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `/api/backups/${ID}/restore`, body: { bringBack: false } }]));
  });

  it("shows each kept database's state, and leaves one out after asking", async () => {
    const kept = (name: string, at: string, merge: object | null) => ({ name, at, merge });
    const merge = (status: string, over: object = {}) => ({ id: `m-${status}`, status, added: 4, conflicts: 2, error: null, ...over });
    let left = false;
    const calls = mockApi({
      'GET /api/backups': () => [200, viewOf({ kept: [
        kept('hornhoof_before_20261110_090000', '2026-11-10T09:00:00.000Z', merge(left ? 'removing' : 'pending')),
        kept('hornhoof_before_20261109_090000', '2026-11-09T09:00:00.000Z', merge('applied', { error: 'Not complete yet: tasks {"id":"x"}' })),
        kept('hornhoof_before_20261108_090000', '2026-11-08T09:00:00.000Z', merge('merged')),
        kept('hornhoof_before_20261107_090000', '2026-11-07T09:00:00.000Z', merge('removing')),
        kept('hornhoof_before_20261106_090000', '2026-11-06T09:00:00.000Z', null),
      ] as never })],
      'POST /api/backups/kept/hornhoof_before_20261110_090000/leave': () => {
        left = true;
        return [204, undefined];
      },
    });
    const user = userEvent.setup();
    shown();
    expect(await screen.findAllByText(/^The database from before the restore of .+ is kept on this server\.$/)).toHaveLength(5);
    expect(screen.getByText('Bringing back what came after it.')).toBeInTheDocument();
    expect(screen.getByText('Could not bring it back yet: Not complete yet: tasks {"id":"x"}')).toBeInTheDocument();
    expect(screen.getByText('Brought back: 4 added, 2 to decide. Removed once its backup is made.')).toBeInTheDocument();
    expect(screen.getByText('Left out. Removed once its backup is made.')).toBeInTheDocument();
    /* Only one whose bringing back still waits or runs can be left out. */
    const buttons = screen.getAllByRole('button', { name: /^Leave out the database from before the restore of / });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]!);
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to leave this database out?' });
    expect(dialog.querySelector('p bdi')).not.toBeNull();
    expect(dialog).toHaveTextContent('What it held after the backup will not come back. It stays as an encrypted backup for 30 days.');
    expect(dialog).toHaveTextContent('This cannot be undone.');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Leave out' })).toHaveClass('danger');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
    await user.click(screen.getAllByRole('button', { name: /^Leave out the database from before the restore of / })[0]!);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Leave out' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/backups/kept/hornhoof_before_20261110_090000/leave', body: undefined }]));
    await waitFor(() => expect(screen.getAllByText('Left out. Removed once its backup is made.')).toHaveLength(2));
  });

  it("says in the person's language that a kept database could not be brought back yet, without the server's words", async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      mockApi({ 'GET /api/backups': [200, viewOf({ kept: [{ name: 'hornhoof_before_20261110_090000', at: '2026-11-10T09:00:00.000Z', merge: { id: 'm1', status: 'applied', added: 0, conflicts: 0, error: 'Not complete yet: tasks {"id":"x"}' } }] })] });
      shown();
      expect(await screen.findByText('Пока не удалось вернуть то, что было после нее. Hornhoof попробует еще раз.')).toBeInTheDocument();
      expect(screen.queryByText(/Not complete yet/)).not.toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('asks for the recovery file when it must', async () => {
    const calls = mockApi({
      'GET /api/backups': [200, viewOf({ bundles: [bundle({ why: 'needs_recovery_file' }), bundle({ id: OTHER, dumpedAt: '2026-11-09T08:00:00.000Z', restorable: false, why: 'newer_build' }), bundle({ id: '0f0f0f0f-0000-4000-8000-00000000000c', dumpedAt: '2026-11-08T08:00:00.000Z', restorable: false, why: 'not_held' })] })],
      [`GET /api/backups/${ID}/warning`]: [200, { machines: [], people: [] }],
      [`POST /api/backups/${ID}/restore`]: [202, { attempt: 'a1' }],
    });
    const user = userEvent.setup();
    shown();
    expect(await screen.findByText('Add the recovery file it was made for to restore it.')).toBeInTheDocument();
    /* What cannot be restored here says why, and has no button. */
    expect(screen.getByText('Made by a newer Hornhoof. Update first.')).toBeInTheDocument();
    expect(screen.getByText('No machine that holds it is online.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Restore the backup of / })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /^Restore the backup of / }));
    const ask = await screen.findByRole('group', { name: /^Restore the company/ });
    expect(screen.queryByText(/joined later/)).not.toBeInTheDocument();
    expect(within(ask).getByRole('button', { name: 'Restore' })).toBeDisabled();
    await user.upload(screen.getByLabelText('Recovery file'), new File(['# Hornhoof recovery file for Acme.\n{"v":1}\n'], 'hornhoof-recovery.txt', { type: 'text/plain' }));
    await waitFor(() => expect(within(ask).getByRole('button', { name: 'Restore' })).toBeEnabled());
    await user.click(within(ask).getByRole('button', { name: 'Restore' }));
    /* Cancelling leaves the uploaded recovery file intact so Restore stays enabled. */
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(within(ask).getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
    await user.click(within(ask).getByRole('button', { name: 'Restore' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `/api/backups/${ID}/restore`, body: { recoveryFile: '# Hornhoof recovery file for Acme.\n{"v":1}\n', bringBack: true } }]));
  });

  it('says why a restore could not start inside the confirmation dialog', async () => {
    mockApi({
      'GET /api/backups': [200, viewOf()],
      [`GET /api/backups/${ID}/warning`]: [200, { machines: [], people: [] }],
      [`POST /api/backups/${ID}/restore`]: [409, { error: { code: 'conflict', message: 'A restore or an update is running.', reason: 'restore_busy' } }],
    });
    const user = userEvent.setup();
    shown();
    await user.click(await screen.findByRole('button', { name: /^Restore the backup of / }));
    await user.click(within(await screen.findByRole('group', { name: /^Restore the company/ })).getByRole('button', { name: 'Restore' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A restore or an update is running already. Wait for it to finish.');
  });
});
