import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { keyDefaults } from '../src/owner-key';
import { Shell } from '../src/screens/Shell';
import { accessView, decisions, MACHINES, ME, mockApi, ORG, REQUESTS, SUBS } from './api-mock';
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
const tab = (name: string) => within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name });

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
    expect(screen.getAllByRole('button').filter(b => b.closest('nav')).map(b => b.textContent)).toEqual(['Map', 'Tasks', 'People', 'Subscriptions & API', 'Machines']);
    /* Tabs stand apart by a line at their start, on the right in a right-to-left language. */
    expect(decl('.tabs button + button', 'border-inline-start')).toBe('1px solid var(--line)');
    expect(decl('.tabs button.on', 'background')).toBe('linear-gradient(var(--glow), var(--glow)) var(--surface)');
    await user.click(screen.getByRole('button', { name: 'Subscriptions & API' }));
    expect(await screen.findByRole('heading', { name: 'Subscriptions & API' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscriptions & API' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps a page from showing under the floating top bar as it scrolls, while the map still runs under it', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: MACHINES }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    expect(screen.getByRole('main')).not.toHaveClass('page');
    for (const name of ['Tasks', 'People', 'Subscriptions & API', 'Machines']) {
      await user.click(tab(name));
      expect(screen.getByRole('main')).toHaveClass('page');
    }
    await user.click(tab('Map'));
    expect(screen.getByRole('main')).not.toHaveClass('page');
    /* The header's room heads what scrolls on every tab, as tall as the bar and the gap above it, said once on the shell;
       on a page it is a band in the page's own color that stays at the top, and on the map it lets touches through to
       the canvas. The bars of the shell and the page start under it, so it takes its room from the page. */
    const room = (property: string) => decl('.body::before', property);
    expect(room('position')).toBe('sticky');
    expect(room('top')).toBe('0');
    expect(room('pointer-events')).toBe('none');
    expect(room('block-size')).toBe('var(--header-room)');
    expect(room('margin-bottom')).toBeUndefined();
    expect(decl('.body.page::before', 'background')).toBe('var(--bg)');
    /* What scrolled under the band is out of sight, so a click there reaches the band, not what is under it. */
    expect(decl('.body.page::before', 'pointer-events')).toBe('auto');
    expect(decl('.shell', '--header-room')).toBe('calc(2 * var(--bar-top) + var(--bar-size))');
    expect(decl('.topbar', 'inset-block-start')).toBe('var(--bar-top)');
    expect(decl('.tabs', 'height')).toBe('var(--bar-size)');
    expect(px(decl('.shell', '--bar-top'))).toBeGreaterThan(0);
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

  it('speaks the saved language, and switches it in Settings, not in the top bar or the account menu', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const user = userEvent.setup();
    renderShell();
    expect(screen.getByRole('button', { name: 'Карта' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Люди' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('ru');
    expect(screen.queryByRole('button', { name: 'English' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Аккаунт' }));
    expect(screen.queryByRole('button', { name: 'English' })).not.toBeInTheDocument();
    expect(screen.queryByText('Язык')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Настройки' }));
    await user.click(await screen.findByRole('button', { name: 'Оформление и язык' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Язык' }), 'English');
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
    const own = accessView('dev-laptop', { machine: { id: 'm1' } });
    const show = (routes: Parameters<typeof mockApi>[0] = {}) => {
      const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: MACHINES }], ...routes });
      render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
      return { calls, user: userEvent.setup() };
    };
    const card = async (user: ReturnType<typeof userEvent.setup>, hostname: string) => {
      await user.click(screen.getByRole('button', { name: /^(Machines|Машины)$/ }));
      await user.click(await screen.findByRole('button', { name: new RegExp(`^(Open the card of |Открыть карточку )${hostname}$`) }));
      return within(screen.getByRole('article', { name: hostname }));
    };

    it('shows standing access and lets its owner close and reopen it from the machine card without a key', async () => {
      let access = own;
      const { calls, user } = show({
        'GET /api/me/key': [200, { key: null }],
        'GET /api/machines': () => [200, { machines: [{ ...MACHINES[0]!, access }] }],
        'POST /api/machines/m1/access/close': () => [200, (access = { ...own, open: false, scope: null })],
        'POST /api/machines/m1/access/open': () => [200, (access = own)],
      });
      const machine = await card(user, 'dev-laptop');
      const controls = within(machine.getByRole('region', { name: 'Computer access' }));
      expect(controls.getByText('For the orchestrator')).toBeInTheDocument();
      expect(controls.getAllByRole('button').map(button => button.textContent)).toEqual(['Close access']);
      await user.click(controls.getByRole('button', { name: 'Close access' }));
      expect(await controls.findByText('Access closed')).toBeInTheDocument();
      expect(controls.getAllByRole('button').map(button => button.textContent)).toEqual(['Reopen access']);
      await user.click(controls.getByRole('button', { name: 'Reopen access' }));
      expect(await controls.findByText('For the orchestrator')).toBeInTheDocument();
      expect(calls.filter(call => call.method === 'POST')).toEqual([
        { method: 'POST', path: '/api/machines/m1/access/close', body: undefined },
        { method: 'POST', path: '/api/machines/m1/access/open', body: undefined },
      ]);
    });

    it.each([
      { open: true, scope: 'orchestrator' as const, status: 'Access open' },
      { open: false, scope: null, status: 'Access closed' },
    ])('shows $status on someone else\'s machine without a switch', async ({ status, ...state }) => {
      const access = accessView('build-box', { ...state, machine: { id: 'm2', personId: 'p2' }, reachable: false, canOpen: false, canClose: false });
      const { user } = show({ 'GET /api/machines': [200, { machines: [{ ...MACHINES[1]!, access }] }] });
      const machine = await card(user, 'build-box');
      const controls = within(machine.getByRole('region', { name: 'Computer access' }));
      expect(controls.getByText(status)).toBeInTheDocument();
      expect(controls.queryAllByRole('button')).toEqual([]);
    });

    it('offers no access switch on a card without computer access', async () => {
      const { user } = show();
      const machine = await card(user, 'dev-laptop');
      expect(machine.queryByRole('region', { name: 'Computer access' })).not.toBeInTheDocument();
    });

    it('offers to reopen its owner\'s offline machine in Russian', async () => {
      localStorage.setItem('hh-lang', 'ru');
      const access = { ...own, open: false, scope: null, reachable: false };
      const { user } = show({ 'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, online: false, access }] }] });
      const machine = await card(user, 'dev-laptop');
      const controls = within(machine.getByRole('region', { name: 'Доступ к машинам' }));
      expect(controls.getByText('Машина не в сети.')).toBeInTheDocument();
      expect(controls.getByRole('button', { name: 'Снова открыть доступ' })).toBeInTheDocument();
    });
  });

  it('shows the version and build in the account menu', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/version': [200, { version: '0.4.0', commit: 'abc1234def', migrations: 5 }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await waitFor(() => expect(document.querySelector('.account-menu .menu-version')).toHaveTextContent('Version 0.4.0 (abc1234)'));
  });

  it.each([
    ['who sees the whole company', ME, ['Talk to the orchestrator', 'Settings', 'Improvements', 'Versions', 'About', 'Log out']],
    ['who sees only some departments', { ...ME, person: { ...ME.person, scopeKind: 'listed' as const, isOwner: false } }, ['Talk to the orchestrator', 'Settings', 'About', 'Log out']],
  ])('keeps the account menu short for a person %s: no themes, language or feedback', async (_who, me, items) => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const user = userEvent.setup();
    render(<LanguageProvider><Shell me={me} onSignOut={() => {}} /></LanguageProvider>);
    expect(screen.queryByRole('button', { name: /theme/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const menu = document.querySelector<HTMLElement>('.account-menu')!;
    expect(within(menu).getAllByRole('button').map(button => button.textContent)).toEqual(items);
    for (const gone of [/theme/i, /^English$/, /^Русский$/, /feedback/i, /^Company settings$/]) expect(within(menu).queryByRole('button', { name: gone })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('group')).not.toBeInTheDocument();
  });

  it('offers home work at once after setup and sends the option the person picks', async () => {
    const calls = mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/orchestrator/first-contact': [200, { offers: ['findDevices', 'checkDevices', 'householdBooks', 'telegram', 'assistant'] }],
      'POST /api/orchestrator/first-contact': [202, { jobId: 'j1' }],
      'GET /api/orchestrator/first-contact/j1': [200, { status: 'done', replies: ['Where do you keep your bills?'] }],
    });
    render(<Shell me={ME} welcome onSignOut={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Talk to the orchestrator' });
    expect(within(dialog).getByText('What would you like me to do?')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await within(dialog).findByRole('button', { name: 'Set up a way to manage household bills and records' }));
    expect(await within(dialog).findByText('Where do you keep your bills?')).toBeInTheDocument();
    expect(calls).toContainEqual({ method: 'POST', path: '/api/orchestrator/first-contact', body: { offer: 'householdBooks', language: 'en' } });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Talk to the orchestrator' })).not.toBeInTheDocument();
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

/* The account menu's heading and groups of rows, with a line between groups that have entries. */
describe('the section tabs', () => {
  const ICONS = '.tabs[data-fit="icons"]';
  const NAMES = ['Map', 'Tasks, 2 waiting for you', 'People', 'Subscriptions & API', 'Machines'];

  /* The top bar as wide as `width`, the logo shown or not, and what the tabs need in words. */
  function lay(width: number, brand: number, words: number) {
    Object.defineProperty(document.querySelector('.topbar')!, 'clientWidth', { configurable: true, value: width });
    Object.defineProperty(document.querySelector('.tb-brand')!, 'offsetWidth', { configurable: true, value: brand });
    Object.defineProperty(document.querySelector('.tb-right')!, 'offsetWidth', { configurable: true, value: 44 });
    Object.defineProperty(screen.getByRole('navigation', { name: 'Sections' }), 'scrollWidth', { configurable: true, value: words });
  }

  async function show(routes: Parameters<typeof mockApi>[0] = {}) {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/requests': [200, decisions(REQUESTS)], ...routes });
    render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    await within(nav).findByRole('button', { name: 'Tasks, 2 waiting for you' });
    return { nav, measure: () => act(() => callbacks.forEach(fn => fn())) };
  }

  it('turns into named icons in one row when their words do not fit one line, and back when they do', async () => {
    const { nav, measure } = await show();
    expect(nav).not.toHaveAttribute('data-fit');
    expect(within(nav).getAllByRole('button').map(b => b.textContent)).toEqual(['Map', 'Tasks2', 'People', 'Subscriptions & API', 'Machines']);
    /* A 375 px phone: no logo, 331 px beside the account for 520 px of words. */
    lay(375, 0, 520);
    measure();
    expect(nav).toHaveAttribute('data-fit', 'icons');
    const tabs = within(nav).getAllByRole('button');
    expect(tabs.map(b => [b.getAttribute('aria-label'), b.getAttribute('title'), b.querySelectorAll('svg').length])).toEqual(NAMES.map(name => [name, name, 1]));
    expect(tabs.map(b => b.textContent)).toEqual(['', '2', '', '', '']);
    expect(tabs[1]!.querySelector('.nav-count')).toHaveAttribute('aria-hidden', 'true');
    expect(within(nav).getByRole('button', { name: 'Map' })).toHaveAttribute('aria-current', 'page');
    /* A wide screen gives the centred tabs 1440 - 2 * 44 px. */
    lay(1440, 44, 520);
    measure();
    expect(nav).not.toHaveAttribute('data-fit');
    expect(within(nav).getByRole('button', { name: 'People' })).toHaveTextContent('People');
    expect(within(nav).getByRole('button', { name: 'People' })).not.toHaveAttribute('title');
  });

  it('opens each section from its icon', async () => {
    const { nav, measure } = await show({ 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: MACHINES }] });
    lay(320, 0, 520);
    measure();
    expect(nav).toHaveAttribute('data-fit', 'icons');
    const user = userEvent.setup();
    await user.click(within(nav).getByRole('button', { name: 'Machines' }));
    expect(await screen.findByRole('heading', { name: 'Machines' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Machines' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the words of every tab on one line, with no strip that scrolls sideways', () => {
    expect(decl('.tabs button', 'white-space')).toBe('nowrap');
    expect(decl('.topbar', 'grid-template-columns')).toBe('1fr minmax(0, auto) 1fr');
    for (const property of ['overflow-x', 'overflow']) expect(decl('.tabs', property, '(max-width: 420px)')).toBeUndefined();
    expect(decl('.tabs button', 'white-space', '(max-width: 420px)')).toBeUndefined();
    expect(decl('.tabs button', 'font-size', '(max-width: 420px)')).toBeUndefined();
  });

  it('draws the icons as cells of one height with the icon in the middle and the count on its corner', () => {
    expect(decl(`${ICONS} button`, 'display')).toBe('flex');
    expect(decl(`${ICONS} button`, 'align-items')).toBe('center');
    expect(decl(`${ICONS} button`, 'justify-content')).toBe('center');
    expect(decl(`${ICONS} button`, 'position')).toBe('relative');
    expect(decl(`${ICONS} button`, 'min-inline-size')).toBe('44px');
    expect(decl('.tabs svg', 'width')).toBe('20px');
    expect(decl('.tabs svg', 'height')).toBe('20px');
    expect(decl(`${ICONS} .nav-count`, 'position')).toBe('absolute');
    expect(decl(`${ICONS} .nav-count`, 'margin')).toBe('0');
    expect(decl(`${ICONS} .nav-count`, 'inset-inline-start')).toBe('calc(50% + 4px)');
    /* On a phone the cells share the whole row beside the account equally. */
    expect(decl(ICONS, 'justify-self', '(max-width: 420px)')).toBe('stretch');
    expect(decl(`${ICONS} button`, 'flex', '(max-width: 420px)')).toBe('1 1 0');
  });
});

describe('the account menu', () => {
  const OPEN = { id: 'i1', title: 'Install jq', text: 'jq', seen: 1, status: 'open', result: null, at: '2026-11-15T09:00:00.000Z', updatedAt: '2026-11-15T09:00:00.000Z', agent: { id: 'w1', name: 'Wendy' }, department: { id: 'd9', name: 'Operations' }, decidedBy: null, scope: 'company', code: null };
  const LISTED = { ...ME, person: { ...ME.person, scopeKind: 'listed' as const, isOwner: false } };

  /* What the menu holds from its top: its heading, a line, or a row by its words, its count apart. */
  const rows = (menu: HTMLElement) => [...menu.children].map(child => {
    if (child.matches('.am-head')) return 'head';
    if (child.matches('hr.am-sep')) return 'line';
    if (child.matches('button.mi')) return [...child.children].map(part => part.textContent).join(' + ');
    return `? ${child.tagName} ${child.className}`;
  });

  async function open(me: typeof ME, routes: Parameters<typeof mockApi>[0] = {}) {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/version': [200, { version: '0.4.0', commit: 'abc1234def', migrations: 5 }], ...routes });
    const user = userEvent.setup();
    render(<LanguageProvider><Shell me={me} onSignOut={() => {}} /></LanguageProvider>);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    return { calls, user, menu: document.querySelector<HTMLElement>('.account-menu')! };
  }

  it('groups Settings, company pages and sign-out without fetching machine access', async () => {
    const { calls, menu } = await open(ME, {
      'GET /api/feedback': [200, { inbox: true }],
      'GET /api/improvements': [200, { improvements: [OPEN, { ...OPEN, id: 'i2' }, { ...OPEN, id: 'i3', status: 'done' }] }],
    });
    await within(menu).findByRole('button', { name: 'Improvements, 2 to decide' });
    await within(menu).findByRole('button', { name: 'Feedback inbox' });
    expect(rows(menu)).toEqual([
      'head', 'line', 'Talk to the orchestrator', 'Settings',
      'line', 'Improvements + 2', 'Feedback inbox', 'Versions',
      'line', 'About', 'Log out',
    ]);
    expect(calls.some(call => call.path === '/api/machines/here')).toBe(false);
    expect(within(menu.querySelector('.am-head')!).getByText('ivan@acme.com').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(await within(menu).findByText('0.4.0 (abc1234)', { selector: 'bdi' })).toHaveAttribute('dir', 'ltr');
    expect(menu.querySelector('.am-head > .menu-version')).toHaveTextContent('Version 0.4.0 (abc1234)');
  });

  it('draws no empty group and no line of its own for a person who sees only some departments', async () => {
    const { menu } = await open(LISTED);
    expect(rows(menu)).toEqual(['head', 'line', 'Talk to the orchestrator', 'Settings', 'line', 'About', 'Log out']);
  });

  it('draws each row as a line of the panel 44 px high, its words at the start, with no frame', () => {
    expect(decl('.mi', 'display')).toBe('flex');
    expect(decl('.mi', 'align-items')).toBe('center');
    expect(decl('.mi', 'justify-content')).toBe('space-between');
    expect(decl('.mi', 'inline-size')).toBe('100%');
    expect(decl('.mi', 'min-block-size')).toBe('44px');
    expect(decl('.mi', 'padding')).toBe('8px 12px');
    expect(decl('.mi', 'text-align')).toBe('start');
    expect(decl('.mi', 'border')).toBe('0');
    expect(decl('.mi', 'background')).toBe('transparent');
    expect(decl('.mi', 'font')).toBe('500 14px/1.4 var(--f-body)');
    expect(decl('.mi:hover', 'background')).toBe('var(--surface2)');
    expect(decl('.mi:active', 'background')).toBe('var(--glow)');
    expect(decl('.mi:focus-visible', 'outline')).toBe('2px solid var(--cyan-ink)');
    expect(decl('.mi:focus-visible', 'outline-offset')).toBe('2px');
    expect(decl('.account-menu', 'inline-size')).toBe('min(280px, calc(100vw - 32px))');
    expect(decl('.account-menu', 'padding')).toBe('6px');
    expect(decl('.account-menu', 'width')).toBeUndefined();
    expect(decl('.am-sep', 'margin-block')).toBe('6px');
    expect(decl('.am-sep', 'border-block-start')).toBe('1px solid var(--line)');
    expect(decl('.am-head', 'padding')).toBe('8px 12px 10px');
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

  it('asks the CEO to save the recovery file while there is none, and opens Company & access in Settings', async () => {
    const calls = shown();
    const banner = await screen.findByRole('status', { name: 'Backups' });
    expect(banner).toHaveTextContent('Save the recovery file, so the company can be restored if this server is lost.');
    expect(calls.filter(call => call.path.startsWith('/api/backups')).map(call => call.path)).toEqual(['/api/backups/recovery']);
    const user = userEvent.setup();
    await user.click(within(banner).getByRole('button', { name: 'Open Company & access' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(location.pathname).toBe('/settings/company');
    expect(within(dialog).getByRole('button', { name: 'Company & access' })).toHaveAttribute('aria-current', 'page');
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

