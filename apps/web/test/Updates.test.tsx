import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { ServiceStrip, ServiceWindow } from '../src/ui/ServiceRoad';
import { Versions } from '../src/screens/Versions';
import type { Build, UpdatesView, UpdaterStatus } from '../src/types';
import { page, type Updates } from '../src/updates';
import { ME, mockApi, ORG } from './api-mock';

const build = (version: string, commit: string, extra: Partial<Build> = {}): Build => ({ tag: version, version, commit, created: '2026-10-30T01:00:00Z', title: '', migrations: 5, ...extra });

/* An update that waits for the agents, as the server says it. */
const WAITS = { version: '0.4.1', commit: 'b'.repeat(40), since: '2026-11-16T01:00:00.000Z', until: '2026-11-16T01:30:00.000Z', turns: [{ agent: 'Zed', task: 1032 }], lost: [] };
const hourOf = (iso: string) => new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

function updates(over: Partial<UpdatesView> = {}, updater: Partial<UpdatesView['updater']> = {}): UpdatesView {
  return {
    current: { version: '0.4.0', commit: 'a'.repeat(40), migrations: 5 },
    available: true,
    checkedAt: '2026-10-30T02:00:00Z',
    latest: build('0.4.1', 'b'.repeat(40), { tag: 'latest', title: 'Hire from the staff card', migrations: 6 }),
    versions: [build('0.4.1', 'b'.repeat(40), { migrations: 6 }), build('0.4.0', 'a'.repeat(40)), build('0.3.0', 'c'.repeat(40), { migrations: 4, title: 'Build the company' })],
    error: null,
    ...over,
    updater: { present: true, status: null, waiting: null, calledOff: null, ...updater },
  };
}

const status = (state: UpdaterStatus['state'], step: UpdaterStatus['step'], log = ''): UpdaterStatus => ({ id: 'u1', version: '0.4.1', commit: 'b'.repeat(40), state, step, log, at: '2026-10-30T02:05:00Z' });

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

/* One turn of the event loop: an answer of the mock api comes in a chain of promises with no timer, so it has been taken in. */
const answersTakenIn = () => new Promise(resolve => setImmediate(resolve));

/* The screen asks the server again on its interval only as the test moves the clock; findBy* and userEvent keep real timeouts. */
function heldPolls() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

async function openVersions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Versions' }));
  return screen.findByRole('dialog', { name: 'Versions' });
}

describe('updates', () => {
  it('shows the banner when a newer build is out', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates()] });
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const banner = await screen.findByRole('status', { name: 'Hornhoof update' });
    expect(banner).toHaveTextContent('Hornhoof 0.4.1 (bbbbbbb) is out: Hire from the staff card');
    expect(within(banner).getAllByRole('button').map(b => b.textContent)).toEqual(['Update', 'Update when agents finish', 'Later']);
  });

  it('hides the banner for people who do not see the whole company', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates()] });
    render(<><Shell me={{ ...ME, person: { ...ME.person, scopeKind: 'listed' } }} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    /* The screen would ask for updates as it mounts, before the map shows. */
    await screen.findByRole('button', { name: 'Map' });
    expect(calls.map(c => c.path)).not.toContain('/api/updates');
    expect(screen.queryByRole('status', { name: 'Hornhoof update' })).not.toBeInTheDocument();
  });

  it('keeps a build hidden after Later', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates()] });
    const user = userEvent.setup();
    const { unmount } = render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    await user.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status', { name: 'Hornhoof update' })).not.toBeInTheDocument();
    unmount();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    await screen.findByRole('button', { name: 'Map' });
    expect(calls.filter(c => c.path === '/api/updates')).toHaveLength(2);
    await act(answersTakenIn);
    expect(screen.queryByRole('status', { name: 'Hornhoof update' })).not.toBeInTheDocument();
  });

  it('updates from the banner, now or when the agents finish', async () => {
    let view = updates();
    const calls = mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/updates': () => [200, view],
      'POST /api/updates': body => {
        view = (body as { whenIdle?: boolean }).whenIdle ? updates({}, { waiting: WAITS }) : updates({}, { status: status('running', 'pull') });
        return [202, { id: 'u1' }];
      },
      'DELETE /api/updates': () => ((view = updates()), [204]),
    });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    await user.click(await screen.findByRole('button', { name: 'Update when agents finish' }));
    expect(calls.find(c => c.method === 'POST' && c.path === '/api/updates')!.body).toEqual({ version: 'latest', whenIdle: true });
    expect(await screen.findByText(`Hornhoof will update to 0.4.1 (bbbbbbb) when the agents finish. If they have not finished by ${hourOf(WAITS.until)}, the update is called off and nothing stops.`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Call off' }));
    expect(calls.some(c => c.method === 'DELETE' && c.path === '/api/updates')).toBe(true);
    await user.click(await screen.findByRole('button', { name: 'Update' }));
    expect(calls.filter(c => c.method === 'POST' && c.path === '/api/updates').pop()!.body).toEqual({ version: 'latest', whenIdle: false });
    /* The service road says it at once, in its window, with no bar until the updater says how far it is. */
    expect(await screen.findByRole('dialog', { name: 'Updating' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Hornhoof update' })).not.toBeInTheDocument();
  });

  it('says until when an update waits for the agents, and why it was called off at that time', async () => {
    let view = updates({}, { waiting: WAITS });
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': () => [200, view] });
    const user = userEvent.setup();
    const { unmount } = render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const until = hourOf(WAITS.until);
    expect(await screen.findByText(`Hornhoof will update to 0.4.1 (bbbbbbb) when the agents finish. If they have not finished by ${until}, the update is called off and nothing stops.`)).toBeInTheDocument();
    unmount();

    view = updates({}, { waiting: null, calledOff: { version: '0.4.1', commit: 'b'.repeat(40), at: WAITS.until, until: WAITS.until, reason: 'deadline', turns: [{ agent: 'Zed', task: 1032 }] } });
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    expect(await screen.findByText(`The update to 0.4.1 (bbbbbbb) was called off at ${until}: the agents had not finished. Nothing was stopped.`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    /* Seen once, it is not said again; the banner goes back to the build on offer. */
    expect(screen.queryByText(/was called off/)).not.toBeInTheDocument();
    expect(screen.getByText('Hornhoof 0.4.1 (bbbbbbb) is out: Hire from the staff card')).toBeInTheDocument();
  });

  it('says an update was called off by a person, or because Hornhoof could not pass it to the updater, never that the agents had not finished', async () => {
    const at = '2026-11-16T01:12:00.000Z';
    const calledOff = { version: '0.4.1', commit: 'b'.repeat(40), at, until: WAITS.until, turns: [{ agent: 'Zed', task: 1032 }] };
    let view = updates({}, { calledOff: { ...calledOff, reason: 'cancelled' } });
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': () => [200, view] });
    const { unmount } = render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    expect(await screen.findByText(`The update to 0.4.1 (bbbbbbb) was called off at ${hourOf(at)}. Nothing was stopped.`)).toBeInTheDocument();
    unmount();

    view = updates({}, { calledOff: { ...calledOff, reason: 'failed', error: 'the updater cannot take it, as another update runs.' } });
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    expect(await screen.findByText(`The update to 0.4.1 (bbbbbbb) was called off at ${hourOf(at)}: Hornhoof could not pass it to the updater. Nothing was stopped.`)).toBeInTheDocument();
    expect(screen.queryByText(/the agents had not finished/)).not.toBeInTheDocument();
  });

  it('asks for one update however fast Update is clicked again', async () => {
    let answer = () => {};
    const calls = mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/updates': [200, updates()],
      'POST /api/updates': () => new Promise(resolve => (answer = () => resolve([202, { id: 'u1' }]))),
    });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const update = await screen.findByRole('button', { name: 'Update' });
    await user.dblClick(update);
    expect(calls.filter(c => c.method === 'POST' && c.path === '/api/updates')).toHaveLength(1);
    expect(update).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Update when agents finish' })).toBeDisabled();
    await act(async () => {
      answer();
      await answersTakenIn();
    });
    expect(calls.filter(c => c.method === 'POST' && c.path === '/api/updates')).toHaveLength(1);
  });

  it('shows the update starting at once, then the server restarting', async () => {
    heldPolls();
    let view = updates();
    let down = false;
    mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/updates': () => (down ? [502, { error: 'unavailable', message: 'Bad gateway' }] : [200, view]),
      'POST /api/updates': () => [202, { id: 'u2' }],
    });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    await user.click(await screen.findByRole('button', { name: 'Update' }));
    /* The updater has not picked it up yet, and the road already says it, with no bar. */
    expect(await screen.findByRole('dialog', { name: 'Updating' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    view = updates({}, { status: { ...status('running', 'install'), id: 'u2' } });
    /* While it updates, the screen asks every two seconds. */
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole('progressbar', { name: 'Updating' })).toHaveAttribute('aria-valuenow', '60');
    down = true;
    await act(() => vi.advanceTimersByTimeAsync(2000));
    /* The server restarts: the road goes on saying the update, as far as it knew. */
    expect(screen.getByRole('progressbar', { name: 'Updating' })).toHaveAttribute('aria-valuenow', '60');
  });

  it('shows maintenance while the server answers with it', async () => {
    let view = updates({}, { status: { ...status('running', 'install'), id: 'u2' } });
    let maintenance = false;
    mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/updates': () =>
        maintenance ? [503, { error: { code: 'unavailable', message: '', reason: 'maintenance' } }] : [200, view],
    });
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const bar = () => screen.getByRole('progressbar', { name: 'Updating' });
    await vi.waitFor(() => expect(bar()).toHaveAttribute('aria-valuenow', '60'));
    maintenance = true;
    /* The server answers that it is in maintenance: still the update, with the bar as far as it knew. */
    await vi.waitFor(() => expect(bar()).toHaveAttribute('aria-valuenow', '60'));
    maintenance = false;
    view = updates({}, { status: { ...status('running', 'health'), id: 'u2' } });
    await vi.waitFor(() => expect(bar()).toHaveAttribute('aria-valuenow', '80'));
  });

  it('lists versions and marks the running one', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates()] });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const dialog = await openVersions(user);
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows.map(r => r.querySelector('b')!.textContent)).toEqual(['0.4.1 (bbbbbbb)', '0.4.0 (aaaaaaa)', '0.3.0 (ccccccc)']);
    expect(rows[1]).toHaveTextContent('Running now');
    expect(within(rows[1]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Install' })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('Build the company');
    expect(within(dialog).getByText('Running now: 0.4.0 (aaaaaaa)')).toBeInTheDocument();
  });

  it('shows the release version for latest and falls back to the tag for an unversioned build', async () => {
    const view = updates({ latest: build('0.5.0', 'd'.repeat(40), { tag: 'latest' }), versions: [build('', 'e'.repeat(40), { tag: 'snapshot' })] });
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, view] });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const dialog = await openVersions(user);
    expect(within(dialog).getAllByRole('listitem').map(r => r.querySelector('b')!.textContent)).toEqual(['0.5.0 (ddddddd)', 'snapshot (eeeeeee)']);
  });

  it('keeps the selected rollback build while the request starts and latest moves', async () => {
    let view = updates();
    const calls = mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/updates': () => [200, view],
      'POST /api/updates': () => {
        view = updates({ latest: build('0.4.2', 'd'.repeat(40)) });
        return [202, { id: 'selected-rollback' }];
      },
    });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const dialog = await openVersions(user);
    await user.click(within(within(dialog).getAllByRole('listitem')[2]!).getByRole('button', { name: 'Install' }));
    await user.click(within(dialog).getByRole('button', { name: 'Go back to 0.3.0 (ccccccc)' }));
    expect(await within(dialog).findByText('Updating Hornhoof to 0.3.0 (ccccccc)')).toBeInTheDocument();
    expect(within(screen.getByRole('status', { name: 'Hornhoof update' })).getByText('Updating Hornhoof to 0.3.0 (ccccccc)')).toBeInTheDocument();
    expect(calls.find(c => c.method === 'POST' && c.path === '/api/updates')!.body).toEqual({ version: '0.3.0', whenIdle: false });
  });

  it('marks a legacy status commit as unknown instead of borrowing the latest build', async () => {
    const legacy: UpdaterStatus = { id: 'legacy', version: '0.4.1', state: 'failed', step: 'finished', log: '', at: '2026-10-30T02:05:00Z' };
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates({}, { status: legacy })] });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const dialog = await openVersions(user);
    expect(within(dialog).getByText('The update to 0.4.1 (?) failed. What the updater wrote is in Versions.')).toBeInTheDocument();
  });

  it('warns before going back past a database change', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates()], 'POST /api/updates': [202, { id: 'u2' }] });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const dialog = await openVersions(user);
    const old = within(dialog).getAllByRole('listitem')[2]!;
    await user.click(within(old).getByRole('button', { name: 'Install' }));
    expect(within(dialog).getByText('Going back past a database change may not start. If it does not, update to the newest version again.')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/updates')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Go back to 0.3.0 (ccccccc)' }));
    expect(calls.find(c => c.method === 'POST' && c.path === '/api/updates')!.body).toEqual({ version: '0.3.0', whenIdle: false });
  });

  it('shows the step and the output while updating, and reloads on the new build', async () => {
    heldPolls();
    let view = updates({}, { status: status('running', 'backup', 'Downloading 0.4.1.\nSaving the database.\n') });
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': () => [200, view] });
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const dialog = await openVersions(user);
    expect(within(dialog).getByText('Updating Hornhoof to 0.4.1 (bbbbbbb)')).toBeInTheDocument();
    expect(within(dialog).getByRole('progressbar', { name: 'Update progress' })).toHaveAttribute('aria-valuetext', 'Step 3 of 5: saving the database');
    expect(within(dialog).getByText(/Saving the database\./)).toBeInTheDocument();
    view = updates({ current: { version: '0.4.1', commit: 'b'.repeat(40), migrations: 6 }, available: false }, { status: status('done', 'finished') });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(reload).toHaveBeenCalled();
  });

  it('says how the last update ended', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates({}, { status: status('rolled_back', 'finished', '0.4.1 did not answer within 120 seconds.\n') })] });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const dialog = await openVersions(user);
    expect(within(dialog).getByText('The update to 0.4.1 (bbbbbbb) did not start. Hornhoof went back to 0.4.0 (aaaaaaa).')).toBeInTheDocument();
    expect(within(dialog).getByText(/did not answer within 120 seconds/)).toBeInTheDocument();
  });

  it('says when the updater is missing', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates({}, { present: false })] });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const dialog = await openVersions(user);
    expect(within(dialog).getByText('The updater is not running. Run the install command for this server again to add it.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });

  it('gives the time of the last check as the chosen language writes it', () => {
    localStorage.setItem('hh-lang', 'ru');
    const view = updates();
    const idle: Updates = { view, busy: false, starting: false, target: null, offline: false, maintenance: false, asking: false, cut: null, check: async () => {}, update: async () => {}, callOff: async () => {}, confirmCut: async () => {}, dropCut: () => {} };
    render(
      <LanguageProvider>
        <Versions updates={idle} onClose={() => {}} />
      </LanguageProvider>,
    );
    const time = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date(view.checkedAt!));
    expect(screen.getByText(`Проверено в ${time}`)).toBeInTheDocument();
  });

  it('checks for updates when asked and says when it could not', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/updates': [200, updates({ available: false })], 'POST /api/updates/check': [200, updates({ available: false, error: 'The registry answered 429.' })] });
    const user = userEvent.setup();
    render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
    const dialog = await openVersions(user);
    await user.click(within(dialog).getByRole('button', { name: 'Check now' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/updates/check')).toBe(true);
    expect(await within(dialog).findByText('Could not check for updates.')).toBeInTheDocument();
  });

  describe('updating now while turns run', () => {
    const wouldStop = (turns: number): [number, unknown] => [409, { error: { code: 'conflict', reason: 'turns_would_stop', message: 'Running turns would stop.', details: { turns } } }];
    const posts = (calls: ReturnType<typeof mockApi>) => calls.filter(c => c.method === 'POST' && c.path === '/api/updates');

    /* The server answers with the next reply each time an update is asked for; a started one shows as running. */
    function server(...answers: [number, unknown?][]) {
      let view = updates();
      return mockApi({
        'GET /api/org': [200, ORG],
        'GET /api/updates': () => [200, view],
        'POST /api/updates': () => {
          const answer = answers.shift()!;
          if (answer[0] === 202) view = updates({}, { status: status('running', 'pull') });
          return answer;
        },
      });
    }

    it('says how many turns would stop and starts nothing until the person agrees', async () => {
      const calls = server(wouldStop(3), [202, { id: 'u1' }]);
      const user = userEvent.setup();
      render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
      await user.click(await screen.findByRole('button', { name: 'Update' }));
      const ask = await screen.findByRole('alertdialog', { name: 'Update now?' });
      expect(ask).toHaveTextContent('3 agent turns are running. If you update now, they stop midway, and Hornhoof starts them again after the update.');
      expect(posts(calls)).toHaveLength(1);
      expect(screen.queryByRole('dialog', { name: 'Updating' })).not.toBeInTheDocument();
      await user.click(within(ask).getByRole('button', { name: 'Update now' }));
      expect(posts(calls).at(-1)!.body).toEqual({ version: 'latest', whenIdle: false, confirmTurns: 3 });
      expect(await screen.findByRole('dialog', { name: 'Updating' })).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('words one turn as one', async () => {
      server(wouldStop(1));
      const user = userEvent.setup();
      render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
      await user.click(await screen.findByRole('button', { name: 'Update' }));
      expect(await screen.findByRole('alertdialog')).toHaveTextContent('1 agent turn is running. If you update now, it stops midway, and Hornhoof starts it again after the update.');
    });

    it.each([
      [2, 'Идут 2 хода агентов. Если обновить сейчас, они оборвутся на середине, а после обновления Hornhoof запустит их заново.'],
      [5, 'Идут 5 ходов агентов. Если обновить сейчас, они оборвутся на середине, а после обновления Hornhoof запустит их заново.'],
      [1, 'Идет 1 ход агента. Если обновить сейчас, он оборвется на середине, а после обновления Hornhoof запустит его заново.'],
    ])('asks in Russian about %i turns', async (turns, text) => {
      localStorage.setItem('hh-lang', 'ru');
      server(wouldStop(turns));
      const user = userEvent.setup();
      render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
      await user.click(await screen.findByRole('button', { name: 'Обновить' }));
      const ask = await screen.findByRole('alertdialog', { name: 'Обновить сейчас?' });
      expect(ask).toHaveTextContent(text);
      expect(within(ask).getByRole('button', { name: 'Обновить сейчас' })).toBeInTheDocument();
    });

    it('goes nowhere when the person cancels', async () => {
      const calls = server(wouldStop(3));
      const user = userEvent.setup();
      render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
      await user.click(await screen.findByRole('button', { name: 'Update' }));
      const ask = await screen.findByRole('alertdialog');
      expect(ask).toHaveFocus();
      await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(posts(calls)).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Update' })).toHaveFocus();
    });

    it('asks again with the new number when more turns started meanwhile', async () => {
      const calls = server(wouldStop(3), wouldStop(5), [202, { id: 'u1' }]);
      const user = userEvent.setup();
      render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
      await user.click(await screen.findByRole('button', { name: 'Update' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Update now' }));
      expect(await screen.findByText(/^5 agent turns are running/)).toBeInTheDocument();
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Update now' }));
      expect(posts(calls).at(-1)!.body).toEqual({ version: 'latest', whenIdle: false, confirmTurns: 5 });
      expect(posts(calls)).toHaveLength(3);
    });

    it('asks nothing when no turn would stop', async () => {
      const calls = server([202, { id: 'u1' }]);
      const user = userEvent.setup();
      render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
      await user.click(await screen.findByRole('button', { name: 'Update' }));
      expect(await screen.findByRole('dialog', { name: 'Updating' })).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(posts(calls)[0]!.body).toEqual({ version: 'latest', whenIdle: false });
    });

    it('asks before installing from Versions too, and Escape leaves Versions open', async () => {
      const calls = server(wouldStop(2));
      const user = userEvent.setup();
      render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
      const versions = await openVersions(user);
      await user.click(within(versions).getAllByRole('button', { name: 'Install' })[0]!);
      expect(await screen.findByRole('alertdialog')).toHaveTextContent(/^Update now\?2 agent turns are running/);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Versions' })).toBeInTheDocument();
      expect(posts(calls)).toHaveLength(1);
    });

    it('keeps the question open and says what went wrong when the update cannot start', async () => {
      server(wouldStop(3), [503, { error: { code: 'unavailable', message: 'The updater is not running. Run install.sh server again to update.', reason: 'updater_missing' } }]);
      const user = userEvent.setup();
      render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
      await user.click(await screen.findByRole('button', { name: 'Update' }));
      const ask = await screen.findByRole('alertdialog');
      await user.click(within(ask).getByRole('button', { name: 'Update now' }));
      expect(await within(ask).findByRole('alert')).toHaveTextContent(/updater is not running/i);
      expect(screen.queryByRole('dialog', { name: 'Updating' })).not.toBeInTheDocument();
    });

    it('starts nothing and asks nothing when the refusal does not say how many', async () => {
      const calls = server([409, { error: { code: 'conflict', message: 'Running turns would stop.', reason: 'turns_would_stop' } }]);
      const user = userEvent.setup();
      render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
      await user.click(await screen.findByRole('button', { name: 'Update' }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(posts(calls)).toHaveLength(1);
    });

    it('still shows any other refusal in the banner', async () => {
      server([409, { error: { code: 'conflict', message: 'An update is running already.', reason: 'update_running', details: { turns: 2 } } }]);
      const user = userEvent.setup();
      render(<><Shell me={ME} onSignOut={() => {}} /><ServiceWindow /><ServiceStrip /></>);
      await user.click(await screen.findByRole('button', { name: 'Update' }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });
});
