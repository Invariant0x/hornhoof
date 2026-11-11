import { render, screen, waitFor, within } from '@testing-library/react';
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
  where: [{ machine: null, name: 'this server', online: true }, { machine: 'm1', name: 'marat-mac', online: true }, { machine: 'm2', name: 'office-mini', online: false }], restorable: true, why: null, ...over,
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
    expect(screen.getByText('Held by: this server, marat-mac, office-mini (offline)')).toBeInTheDocument();
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
      [`GET /api/backups/${ID}/warning`]: [200, { machines: [{ name: 'new-mac', owner: 'Maria' }, { name: 'lab', owner: 'Ivan' }], people: ['Sasha'] }],
      [`POST /api/backups/${ID}/restore`]: () => {
        restore = status({ step: 'open', line: 'Opening the backup.' });
        return [202, { attempt: 'a1' }];
      },
    });
    const user = userEvent.setup();
    shown();
    await user.click(await screen.findByRole('button', { name: /^Restore the backup of / }));
    const ask = await screen.findByRole('group', { name: /^Restore the company as it was at .+\?$/ });
    expect(screen.getByText(/^Everything after .+ stays in the current database, which is kept on this server\. A later update of Hornhoof merges it back\.$/)).toBeInTheDocument();
    expect(screen.getByText('These machines joined later and must be connected again: new-mac, lab.')).toBeInTheDocument();
    expect(screen.getByText('These people were added later and must be invited again: Sasha.')).toBeInTheDocument();
    expect(screen.getByText('Everyone signs in again afterwards.')).toBeInTheDocument();
    expect(screen.getByText('Access to machines is closed on every machine; their owners open it again.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Recovery file')).not.toBeInTheDocument();
    /* Cancel asks nothing of the server. */
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
    await user.click(screen.getByRole('button', { name: /^Restore the backup of / }));
    await user.click(within(await screen.findByRole('group', { name: /^Restore the company/ })).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `/api/backups/${ID}/restore`, body: {} }]));
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
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `/api/backups/${ID}/restore`, body: { recoveryFile: '# Hornhoof recovery file for Acme.\n{"v":1}\n' } }]));
  });

  it('says why a restore could not start', async () => {
    mockApi({
      'GET /api/backups': [200, viewOf()],
      [`GET /api/backups/${ID}/warning`]: [200, { machines: [], people: [] }],
      [`POST /api/backups/${ID}/restore`]: [409, { error: { code: 'conflict', message: 'A restore or an update is running.', reason: 'restore_busy' } }],
    });
    const user = userEvent.setup();
    shown();
    await user.click(await screen.findByRole('button', { name: /^Restore the backup of / }));
    await user.click(within(await screen.findByRole('group', { name: /^Restore the company/ })).getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A restore or an update is running already. Wait for it to finish.');
  });
});
