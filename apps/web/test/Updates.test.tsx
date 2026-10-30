import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shell } from '../src/screens/Shell';
import type { Build, UpdatesView, UpdaterStatus } from '../src/types';
import { page } from '../src/updates';
import { ME, mockApi, ORG } from './api-mock';

const build = (version: string, commit: string, extra: Partial<Build> = {}): Build => ({ tag: version, version, commit, created: '2026-10-30T01:00:00Z', title: '', migrations: 5, ...extra });

function updates(over: Partial<UpdatesView> = {}, updater: Partial<UpdatesView['updater']> = {}): UpdatesView {
  return {
    current: { version: '0.4.0', commit: 'a'.repeat(40), migrations: 5 },
    available: true,
    checkedAt: '2026-10-30T02:00:00Z',
    latest: build('0.4.1', 'b'.repeat(40), { tag: 'latest', title: 'Hire from the staff card', migrations: 6 }),
    versions: [build('0.4.1', 'b'.repeat(40), { migrations: 6 }), build('0.4.0', 'a'.repeat(40)), build('0.3.0', 'c'.repeat(40), { migrations: 4, title: 'Build the company' })],
    error: null,
    ...over,
    updater: { present: true, status: null, waiting: null, ...updater },
  };
}

const status = (state: UpdaterStatus['state'], step: UpdaterStatus['step'], log = ''): UpdaterStatus => ({ id: 'u1', version: '0.4.1', state, step, log, at: '2026-10-30T02:05:00Z' });

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

async function openVersions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Versions' }));
  return screen.findByRole('dialog', { name: 'Versions' });
}

describe('updates', () => {
  it('shows the banner when a newer build is out', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates()] });
    render(<Shell me={ME} onSignOut={() => {}} />);
    const banner = await screen.findByRole('status', { name: 'Hornhoof update' });
    expect(banner).toHaveTextContent('Hornhoof 0.4.1 is out: Hire from the staff card');
    expect(within(banner).getAllByRole('button').map(b => b.textContent)).toEqual(['Update', 'Update when agents finish', 'Later']);
  });

  it('hides the banner for people who do not see the whole company', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates()] });
    render(<Shell me={{ ...ME, person: { ...ME.person, scopeKind: 'listed' } }} onSignOut={() => {}} />);
    await screen.findByRole('button', { name: 'Map' });
    await new Promise(r => setTimeout(r, 50));
    expect(calls.map(c => c.path)).not.toContain('/api/updates');
    expect(screen.queryByRole('status', { name: 'Hornhoof update' })).not.toBeInTheDocument();
  });

  it('keeps a build hidden after Later', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates()] });
    const user = userEvent.setup();
    const { unmount } = render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status', { name: 'Hornhoof update' })).not.toBeInTheDocument();
    unmount();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await screen.findByRole('button', { name: 'Map' });
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByRole('status', { name: 'Hornhoof update' })).not.toBeInTheDocument();
  });

  it('updates from the banner, now or when the agents finish', async () => {
    let view = updates();
    const calls = mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/updates': () => [200, view],
      'POST /api/updates': body => {
        view = (body as { whenIdle?: boolean }).whenIdle ? updates({}, { waiting: { version: '0.4.1' } }) : updates({}, { status: status('running', 'backup') });
        return [202, { id: 'u1' }];
      },
      'DELETE /api/updates': () => ((view = updates()), [204]),
    });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Update when agents finish' }));
    expect(calls.find(c => c.method === 'POST' && c.path === '/api/updates')!.body).toEqual({ version: 'latest', whenIdle: true });
    expect(await screen.findByText('Hornhoof will update to 0.4.1 when the agents finish.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Call off' }));
    expect(calls.some(c => c.method === 'DELETE' && c.path === '/api/updates')).toBe(true);
    await user.click(await screen.findByRole('button', { name: 'Update' }));
    expect(calls.filter(c => c.method === 'POST' && c.path === '/api/updates').pop()!.body).toEqual({ version: 'latest', whenIdle: false });
    expect(await screen.findByText('Updating Hornhoof to 0.4.1')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Update progress' });
    expect(bar).toHaveAttribute('aria-valuetext', 'Step 1 of 4: saving the database');
    expect(bar).toHaveAttribute('aria-valuenow', '0');
  });

  it('shows the update starting at once, then the server restarting', async () => {
    let view = updates();
    let down = false;
    mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/updates': () => (down ? [502, { error: 'unavailable', message: 'Bad gateway' }] : [200, view]),
      'POST /api/updates': () => [202, { id: 'u2' }],
    });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Update' }));
    /* The updater has not picked it up yet, and the banner already moves. */
    expect(await screen.findByRole('progressbar', { name: 'Update progress' })).toHaveAttribute('aria-valuetext', 'Getting the update ready');
    view = updates({}, { status: { ...status('running', 'install'), id: 'u2' } });
    await waitFor(() => expect(screen.getByRole('progressbar', { name: 'Update progress' })).toHaveAttribute('aria-valuetext', 'Step 3 of 4: installing'), { timeout: 4000 });
    expect(screen.getByRole('progressbar', { name: 'Update progress' })).toHaveAttribute('aria-valuenow', '2');
    down = true;
    await waitFor(() => expect(screen.getByRole('progressbar', { name: 'Update progress' })).toHaveAttribute('aria-valuetext', 'Hornhoof is restarting. The page reloads by itself.'), { timeout: 4000 });
  });

  it('lists versions and marks the running one', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates()] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    const dialog = await openVersions(user);
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows.map(r => r.querySelector('b')!.textContent)).toEqual(['0.4.1', '0.4.0', '0.3.0']);
    expect(rows[1]).toHaveTextContent('Running now');
    expect(within(rows[1]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Install' })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('Build the company');
    expect(within(dialog).getByText(/Running now: 0\.4\.0 · aaaaaaa/)).toBeInTheDocument();
  });

  it('warns before going back past a database change', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates()], 'POST /api/updates': [202, { id: 'u2' }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    const dialog = await openVersions(user);
    const old = within(dialog).getAllByRole('listitem')[2]!;
    await user.click(within(old).getByRole('button', { name: 'Install' }));
    expect(within(dialog).getByText('Going back past a database change may not start. If it does not, update to the newest version again.')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/updates')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Go back to 0.3.0' }));
    expect(calls.find(c => c.method === 'POST' && c.path === '/api/updates')!.body).toEqual({ version: '0.3.0', whenIdle: false });
  });

  it('shows the step and the output while updating, and reloads on the new build', async () => {
    let view = updates({}, { status: status('running', 'pull', 'Saving the database.\nDownloading 0.4.1.\n') });
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': () => [200, view] });
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    const dialog = await openVersions(user);
    expect(within(dialog).getByText('Updating Hornhoof to 0.4.1')).toBeInTheDocument();
    expect(within(dialog).getByRole('progressbar', { name: 'Update progress' })).toHaveAttribute('aria-valuetext', 'Step 2 of 4: downloading');
    expect(within(dialog).getByText(/Downloading 0\.4\.1\./)).toBeInTheDocument();
    view = updates({ current: { version: '0.4.1', commit: 'b'.repeat(40), migrations: 6 }, available: false }, { status: status('done', 'finished') });
    await waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 4000 });
  });

  it('says how the last update ended', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates({}, { status: status('rolled_back', 'finished', '0.4.1 did not answer within 120 seconds.\n') })] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    const dialog = await openVersions(user);
    expect(within(dialog).getByText('The update to 0.4.1 did not start. Hornhoof went back to 0.4.0.')).toBeInTheDocument();
    expect(within(dialog).getByText(/did not answer within 120 seconds/)).toBeInTheDocument();
  });

  it('says when the updater is missing', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates({}, { present: false })] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    const dialog = await openVersions(user);
    expect(within(dialog).getByText('The updater is not running. Run the install command for this server again to add it.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });

  it('checks for updates when asked and says when it could not', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates({ available: false })], 'POST /api/updates/check': [200, updates({ available: false, error: 'The registry answered 429.' })] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    const dialog = await openVersions(user);
    await user.click(within(dialog).getByRole('button', { name: 'Check now' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/updates/check')).toBe(true);
    expect(await within(dialog).findByText('Could not check for updates.')).toBeInTheDocument();
  });
});
