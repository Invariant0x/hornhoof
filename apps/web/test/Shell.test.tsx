import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { keyDefaults } from '../src/owner-key';
import { Shell } from '../src/screens/Shell';
import { accessView, MACHINES, ME, mockApi, ORG, SUBS } from './api-mock';
import { decl, px } from './css';

function renderShell() {
  mockApi({ 'GET /api/org': [200, ORG] });
  return render(
    <LanguageProvider>
      <Shell me={ME} onSignOut={() => {}} />
    </LanguageProvider>,
  );
}

/* A tab of the main navigation, apart from the buttons of the same name inside a page. */
const tab = (name: string) => within(screen.getByRole('navigation')).getByRole('button', { name });

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('Shell', () => {
  it('shows only the logo in the top left, with the company name for screen readers', () => {
    const { container } = renderShell();
    expect(container.querySelector('.tb-brand svg')).toBeInTheDocument();
    expect(screen.getByText(ME.company.name)).toHaveClass('sr');
  });

  it('opens Subscriptions from its tab and keeps Improvements out of the main navigation', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: MACHINES }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    expect(screen.getAllByRole('button').filter(b => b.closest('nav')).map(b => b.textContent)).toEqual(['Map', 'Tasks', 'People', 'Subscriptions', 'Machines']);
    expect(decl('.tabs button + button', 'border-left')).toBe('1px solid var(--line)');
    expect(decl('.tabs button.on', 'background')).toBe('var(--glow)');
    await user.click(screen.getByRole('button', { name: 'Subscriptions' }));
    expect(await screen.findByRole('heading', { name: 'Subscriptions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscriptions' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps a page from showing under the floating top bar as it scrolls, while the map still runs under it', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: MACHINES }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    expect(screen.getByRole('main')).not.toHaveClass('page');
    for (const name of ['Tasks', 'People', 'Subscriptions', 'Machines']) {
      await user.click(tab(name));
      expect(screen.getByRole('main')).toHaveClass('page');
    }
    await user.click(tab('Map'));
    expect(screen.getByRole('main')).not.toHaveClass('page');
    /* A band in the page's own color stays at the top of what scrolls, as tall as the bar and the gap above it, and
       takes no room from the page. */
    const band = (property: string) => decl('.body.page::before', property);
    expect(band('position')).toBe('sticky');
    expect(band('top')).toBe('0');
    expect(band('background')).toBe('var(--bg)');
    expect(px(band('height'))).toBeGreaterThanOrEqual(px(decl('.topbar', 'top')) + px(decl('.tabs', 'height')));
    expect(px(band('margin-bottom'))).toBe(-px(band('height')));
  });

  it('opens the machines of the company from their own tab', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: MACHINES }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(tab('Machines'));
    expect(await screen.findByRole('heading', { name: 'Machines' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open the card of dev-laptop' })).toBeInTheDocument();
    expect(tab('Machines')).toHaveAttribute('aria-current', 'page');
  });

  it('speaks the saved language and switches it from the account menu', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const user = userEvent.setup();
    renderShell();
    expect(screen.getByRole('button', { name: 'Карта' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Люди' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('ru');
    await user.click(screen.getByRole('button', { name: 'Аккаунт' }));
    await user.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByRole('button', { name: 'Map' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'People' })).toBeInTheDocument();
    expect(localStorage.getItem('hh-lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it("lets the person's key go from this device at sign-out, before the screen changes", async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'POST /api/auth/logout': [204] });
    const key = { publicKey: 'k', privateKey: {} as CryptoKey };
    await keyDefaults.store.put(key);
    let keptAtSignOut: unknown = 'not asked';
    const onSignOut = () => void keyDefaults.store.get().then(found => (keptAtSignOut = found));
    render(<LanguageProvider><Shell me={ME} onSignOut={onSignOut} /></LanguageProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(keptAtSignOut).toBeNull());
    expect(await keyDefaults.store.get()).toBeNull();
  });

  describe('at a machine of the company', () => {
    const closed = accessView('dev-laptop', { machine: { id: 'm1' } });
    const menu = async (here: object | null, extra: Parameters<typeof mockApi>[0] = {}) => {
      const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/machines/here': [200, here ?? { machine: null, view: null }], ...extra });
      const user = userEvent.setup();
      render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
      await user.click(screen.getByRole('button', { name: /^(Account|Аккаунт)$/ }));
      await waitFor(() => expect(calls.some(call => call.path === '/api/machines/here')).toBe(true));
      return { calls, user };
    };

    it('offers its owner to give the orchestrator access to it, and closes the menu once it is open', async () => {
      const { calls, user } = await menu({ machine: closed.machine, view: closed }, { 'POST /api/machines/m1/access/open': [200, { ...closed, until: '2099-01-01T00:00:00.000Z' }] });
      await user.click(await screen.findByRole('button', { name: 'Give the orchestrator access to this machine (dev-laptop)' }));
      await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/machines/m1/access/open', body: {} }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument());
    });

    it.each([
      ['a machine that is not theirs to open', { ...closed, canOpen: false }],
      ['a machine that is open already', { ...closed, until: '2099-01-01T00:00:00.000Z' }],
      ['a machine that does not hold their key', { ...closed, key: 'not_held' }],
      ['a machine Hornhoof cannot reach', { ...closed, reachable: false }],
    ])('offers nothing at %s', async (_name, view) => {
      await menu({ machine: view.machine, view });
      expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Give the orchestrator access/ })).not.toBeInTheDocument();
    });

    it('offers nothing elsewhere, or on a server that knows no such thing', async () => {
      await menu(null);
      expect(screen.queryByRole('button', { name: /Give the orchestrator access/ })).not.toBeInTheDocument();
    });

    it('offers it in Russian', async () => {
      localStorage.setItem('hh-lang', 'ru');
      await menu({ machine: closed.machine, view: closed });
      expect(await screen.findByRole('button', { name: 'Дать оркестратору доступ к этой машине (dev-laptop)' })).toBeInTheDocument();
    });
  });

  it('shows the version and build in the account menu', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/version': [200, { version: '0.4.0', commit: 'abc1234def', migrations: 5 }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(await screen.findByText('Version 0.4.0 (abc1234)')).toBeInTheDocument();
  });

  it('keeps the themes in the account menu, not in the top bar', async () => {
    const user = userEvent.setup();
    renderShell();
    expect(screen.queryByRole('button', { name: /theme/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Go to themes. Current: Cyberpunk' }));
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(location.pathname).toBe('/themes');
  });

  /* The window checks its agent's card as it opens; one the server refuses would close it again. */
  it('opens the orchestrator\'s window at once after setup, and closes it', async () => {
    const calls = mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/agents/orchestrator': [200, { id: 'orchestrator' }],
      'GET /api/agents/orchestrator/events?last=300': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
      'POST /api/agents/orchestrator/start': [200, { started: false }],
    });
    render(<Shell me={ME} welcome onSignOut={() => {}} />);
    await screen.findByRole('complementary', { name: 'Orchestrator' });
    await waitFor(() => expect(calls.some(call => call.method === 'GET' && call.path === '/api/agents/orchestrator')).toBe(true));
    /* One turn of the event loop: the card's answer comes in a chain of promises with no timer, so it has been taken in. */
    await act(async () => { await new Promise(resolve => { setImmediate(resolve); }); });
    expect(screen.getByRole('complementary', { name: 'Orchestrator' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Orchestrator' })).not.toBeInTheDocument();
  });

  it('closes the account menu on Escape and on a click outside it', async () => {
    const user = userEvent.setup();
    renderShell();
    const account = screen.getByRole('button', { name: 'Account' });
    await user.click(account);
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
    await user.click(account);
    await act(async () => {
      await user.click(document.body);
    });
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
  });
});

describe('the recovery file banner', () => {
  const BACKUPS = { last: null, recovery: null, recoveryNeeded: true, linkChanged: false, restore: null, kept: [], bundles: [] };
  /* The banner asks only what it shows, not the whole list. */
  const asked = (backups: { recoveryNeeded?: boolean; linkChanged?: boolean }) => ({ recoveryNeeded: backups.recoveryNeeded, linkChanged: backups.linkChanged });
  const LINK = { link: { name: 'acme', url: 'https://acme.hornhoof.org' }, domain: 'hornhoof.org' };
  const shown = (me = ME, backups: typeof BACKUPS | object = BACKUPS) => {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/backups/recovery': [200, asked(backups)], 'GET /api/backups': [200, backups], 'GET /api/link': [200, LINK] });
    render(<LanguageProvider><Shell me={me} onSignOut={() => {}} /></LanguageProvider>);
    return calls;
  };

  it('asks the CEO to save the recovery file while there is none, and opens the company settings', async () => {
    const calls = shown();
    const banner = await screen.findByRole('status', { name: 'Backups' });
    expect(banner).toHaveTextContent('Save the recovery file, so the company can be restored if this server is lost.');
    expect(calls.filter(call => call.path.startsWith('/api/backups')).map(call => call.path)).toEqual(['/api/backups/recovery']);
    const user = userEvent.setup();
    await user.click(within(banner).getByRole('button', { name: 'Open company settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Company settings' });
    expect(await within(dialog).findByRole('button', { name: 'Save the recovery file' })).toBeInTheDocument();
  });

  it('says so when the public link changed since the file was saved', async () => {
    shown(ME, { ...BACKUPS, linkChanged: true });
    expect(await screen.findByRole('status', { name: 'Backups' })).toHaveTextContent('The public link changed, so the recovery file is out of date. Save a new one.');
  });

  it('shows nothing once the file is saved, and nothing to anyone but the CEO', async () => {
    const saved = shown(ME, { ...BACKUPS, recovery: { madeAt: '2026-11-10T08:00:00.000Z', madeBy: 'Ivan' }, recoveryNeeded: false });
    await waitFor(() => expect(saved.some(call => call.path === '/api/backups/recovery')).toBe(true));
    expect(screen.queryByRole('status', { name: 'Backups' })).not.toBeInTheDocument();
    const calls = shown({ ...ME, person: { ...ME.person, id: 'p2', isOwner: false } });
    await screen.findAllByRole('navigation');
    await act(async () => { await Promise.resolve(); });
    expect(calls.some(call => call.path.startsWith('/api/backups'))).toBe(false);
    expect(screen.queryByRole('status', { name: 'Backups' })).not.toBeInTheDocument();
  });
});

