import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider, LANGUAGES } from '../src/i18n';
import { Settings } from '../src/screens/Settings';
import { Shell } from '../src/screens/Shell';
import { ME, mockApi, ORG } from './api-mock';
import { decl } from './css';

vi.mock('@hornhoof/protocol/link', async importOriginal => ({ ...(await importOriginal<typeof import('@hornhoof/protocol/link')>()), randomLinkName: () => 'r4nd0mr4nd0mr4nd0m' }));

const ACME = { name: 'acme', url: 'https://acme.hornhoof.org' };
const RANDOM = 'r4nd0mr4nd0mr4nd0m';
const AGREEMENT = 'Let\'s Encrypt Subscriber Agreement';
const LISTED = { ...ME, person: { ...ME.person, scopeKind: 'listed' as const, isOwner: false } };
const FORBIDDEN = [403, { error: { code: 'forbidden', message: 'Forbidden.' } }] as [number, unknown];
const tls = (mode: 'http' | 'https') => ({ mode, certificate: mode === 'https', expiresAt: null, failedAt: null });

describe('the public link under Company & access', () => {
  it('shows the public link with a copy button', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }] });
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(await within(dialog).findByText('Hornhoof opens from anywhere at this link:')).toBeInTheDocument();
    expect(await within(dialog).findByRole('link', { name: 'https://acme.hornhoof.org' })).toHaveAttribute('href', 'https://acme.hornhoof.org');
    expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('moves the link to another name once the name is free', async () => {
    const calls = mockApi({
      'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }],
      'GET /api/link/names/acme-corp': [200, { name: 'acme-corp', free: true }],
      'PUT /api/link': [200, { link: { name: 'acme-corp', url: 'https://acme-corp.hornhoof.org' } }],
    });
    const user = userEvent.setup();
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Change name' }));
    expect(screen.getByLabelText('Link')).toHaveValue('acme');
    expect(screen.getByLabelText('Link').closest('.link-input')).toHaveTextContent('.hornhoof.org');
    expect(screen.getByText('Machines connected through the old link lose the connection. Connect them again under Subscriptions or Machines.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Link'));
    await user.type(screen.getByLabelText('Link'), 'acme-corp');
    expect(await screen.findByText('acme-corp.hornhoof.org is free.')).toBeInTheDocument();
    await user.click(within(screen.getByLabelText('Link').closest('form')!).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('link', { name: 'https://acme-corp.hornhoof.org' })).toBeInTheDocument();
    expect(calls.find(c => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/link', body: { name: 'acme-corp' } });
  });

  it('breaks the note under the field inside the longest address, so the window does not get wider', async () => {
    const longest = 'a'.repeat(63);
    mockApi({
      'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }],
      [`GET /api/link/names/${longest}`]: [200, { name: longest, free: true }],
    });
    const user = userEvent.setup();
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Change name' }));
    await user.clear(screen.getByLabelText('Link'));
    await user.type(screen.getByLabelText('Link'), longest);
    const note = await screen.findByText(`${longest}.hornhoof.org is free.`);
    expect(note.matches('.link-name > span')).toBe(true);
    expect(decl('.link-name > span', 'overflow-wrap')).toBe('anywhere');
  });

  it('says the link is encrypted to this machine in https mode, and to hornhoof.org otherwise', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org', tls: tls('https') }] });
    const first = render(<Settings me={ME} group="company" onClose={() => {}} />);
    expect(await screen.findByText('Encrypted to this machine')).toBeInTheDocument();
    expect(screen.queryByText(/Encrypted to hornhoof.org for now/)).not.toBeInTheDocument();
    first.unmount();
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org', tls: tls('http') }] });
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    expect(await screen.findByText('Encrypted to hornhoof.org for now. Hornhoof moves the encryption to this machine on its own.')).toBeInTheDocument();
    expect(screen.queryByText('Encrypted to this machine')).not.toBeInTheDocument();
  });

  it('names the Let\'s Encrypt Subscriber Agreement with a link to it', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org', tls: tls('https') }] });
    const first = render(<Settings me={ME} group="company" onClose={() => {}} />);
    const agreement = await screen.findByRole('link', { name: AGREEMENT });
    expect(agreement).toHaveAttribute('href', 'https://letsencrypt.org/repository/');
    expect(agreement).toHaveAttribute('target', '_blank');
    expect(agreement).toHaveAttribute('rel', 'noreferrer');
    expect(agreement.parentElement).toHaveTextContent(`The link's certificate comes from Let's Encrypt. Getting it accepts the ${AGREEMENT} for your company.`);
    first.unmount();
    mockApi({ 'GET /api/link': [200, { link: null, domain: 'hornhoof.org', tls: null }] });
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    await screen.findByText('Hornhoof opens only at its own address, on this computer and your network.');
    expect(screen.queryByRole('link', { name: AGREEMENT })).not.toBeInTheDocument();
  });

  it('makes Remove link the pink secondary button, last of its row', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }] });
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    const remove = await screen.findByRole('button', { name: 'Remove link' });
    expect(remove).toHaveClass('btn', 'ghost', 'danger');
    expect(remove.parentElement!.lastElementChild).toBe(remove);
    expect(screen.getByRole('button', { name: 'Change name' })).not.toHaveClass('danger');
    /* The pink of a danger button is the shared rule of Oracle and Trinity: pink words, a pink frame on hover. */
    expect(decl(':is(.btn.ghost, .act).danger', 'color')).toBe('var(--pink-ink)');
    expect(decl('.btn.ghost.danger:hover', 'box-shadow')).toBe('inset 0 0 0 1px var(--pink)');
  });

  it('removes the link after asking', async () => {
    const calls = mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'DELETE /api/link': [204] });
    const user = userEvent.setup();
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Remove link' }));
    expect(screen.getByText('Hornhoof stops opening at https://acme.hornhoof.org. Machines connected through this link lose the connection.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Hornhoof opens only at its own address, on this computer and your network.')).toBeInTheDocument();
    expect(calls.map(c => `${c.method} ${c.path}`)).toContain('DELETE /api/link');
  });

  it('breaks the question about removing inside the longest address, so the window does not get wider', async () => {
    const longest = { name: 'a'.repeat(63), url: `https://${'a'.repeat(63)}.hornhoof.org` };
    mockApi({ 'GET /api/link': [200, { link: longest, domain: 'hornhoof.org' }] });
    const user = userEvent.setup();
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Remove link' }));
    const question = screen.getByText(`Hornhoof stops opening at ${longest.url}. Machines connected through this link lose the connection.`);
    expect(question.matches('.settings-actions > span')).toBe(true);
    expect(decl('.settings-actions > span', 'overflow-wrap')).toBe('anywhere');
  });

  it('starts a company with no link on a long random name', async () => {
    const calls = mockApi({
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      [`GET /api/link/names/${RANDOM}`]: [200, { name: RANDOM, free: true }],
      'PUT /api/link': [200, { link: { name: RANDOM, url: `https://${RANDOM}.hornhoof.org` } }],
    });
    const user = userEvent.setup();
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    expect(await screen.findByText('Hornhoof opens only at its own address, on this computer and your network.')).toBeInTheDocument();
    /* The field takes its random name as it mounts, which is one render after the words above. */
    expect(await screen.findByDisplayValue(RANDOM)).toBe(screen.getByLabelText('Link'));
    expect(screen.getByText(/A random name does not say whose company it is/)).toBeInTheDocument();
    await screen.findByText(`${RANDOM}.hornhoof.org is free.`);
    await user.click(screen.getByRole('button', { name: 'Open on the internet' }));
    expect(await screen.findByRole('link', { name: `https://${RANDOM}.hornhoof.org` })).toBeInTheDocument();
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ name: RANDOM });
  });

  it('starts a new random name after the link is removed', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'DELETE /api/link': [204] });
    const user = userEvent.setup();
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Remove link' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByLabelText('Link')).toHaveValue(RANDOM);
  });

  it('says why a name was refused', async () => {
    mockApi({
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'PUT /api/link': [409, { error: { code: 'conflict', message: 'This link is taken already. Pick another name.', reason: 'link_taken' } }],
    });
    const user = userEvent.setup();
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    /* The button is there before the field has its random name: only then may a person go on. */
    const open = await screen.findByRole('button', { name: 'Open on the internet' });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    expect(await screen.findByText('This link is taken already. Pick another name.')).toBeInTheDocument();
  });
});

describe('your own name under Profile', () => {
  it('saves a trimmed name and reports the new name to the shell', async () => {
    const calls = mockApi({ 'PATCH /api/people/p1': [200, { person: { ...ME.person, name: 'Lisa' } }] });
    const renamed: string[] = [];
    const user = userEvent.setup();
    render(<Settings me={LISTED} group="profile" onClose={() => {}} onRenamed={name => renamed.push(name)} />);
    const field = await screen.findByLabelText('Name');
    await user.clear(field);
    await user.type(field, '  Lisa  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/people/p1', body: { name: 'Lisa' } });
    expect(renamed).toEqual(['Lisa']);
  });

  it('gives the name field and every field, list and button of the window 44 px, its buttons on the end edge', () => {
    const mine = '.settings-window :is(.settings-group, .integrations)';
    expect(decl(`${mine} :is(.field input, .field select, .link-input input)`, 'height')).toBe('44px');
    expect(decl(`${mine} .btn`, 'min-height')).toBe('44px');
    expect(decl(`${mine} .btn`, 'padding')).toBe('8px 12px');
    expect(decl(`${mine} .btn`, 'font-size')).toBe('14px');
    expect(decl(`${mine} :is(.settings-actions, .repo-actions)`, 'justify-content')).toBe('flex-end');
    expect(decl('.settings-window > header .btn', 'min-height')).toBe('44px');
  });

  it('keeps its heading and Done fixed and scrolls only its body, with the same 18 px of room for a scrollbar in every browser', async () => {
    expect(decl('.dialog.settings-window', 'height')).toBe('calc(100vh - 32px)');
    expect(decl('.dialog.settings-window', 'padding')).toBe('0');
    expect(decl('.dialog.settings-window', 'overflow')).toBe('hidden');
    /* The window itself keeps no room for a scrollbar: only its body scrolls. */
    expect(decl('.dialog.settings-window', 'scrollbar-gutter')).toBe('auto');
    expect(decl('.settings-window > header', 'padding-block')).toBe('12px');
    expect(decl('.settings-window > header', 'padding-inline')).toBe('18px 36px');
    expect(decl('.settings-window > header', 'border-block-end')).toBe('1px solid var(--line)');
    expect(decl('.settings-scroll', 'overflow')).toBe('auto');
    expect(decl('.settings-scroll', 'scrollbar-gutter')).toBe('stable');
    expect(decl('.settings-scroll', 'padding')).toBe('18px');
    expect(decl('.settings-scroll', 'padding-inline-end')).toBe('calc(18px + max(0px, 18px - var(--sb, 0px)))');
    mockApi({});
    render(<Settings me={LISTED} group="profile" onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    /* What this browser's scrollbar takes is measured on the body itself; jsdom draws none. */
    expect(dialog.querySelector<HTMLElement>('.settings-scroll')!.style.getPropertyValue('--sb')).toBe('0px');
    expect(dialog.querySelector('.settings-scroll > .settings-body')).not.toBeNull();
  });

  it('shows empty and server name errors by the field', async () => {
    mockApi({ 'PATCH /api/people/p1': [403, { error: { code: 'forbidden', message: 'You cannot change this name.', reason: 'rename_failed' } }] });
    const user = userEvent.setup();
    render(<Settings me={LISTED} group="profile" onClose={() => {}} />);
    const field = await screen.findByLabelText('Name');
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const form = field.closest('form')!;
    expect(await within(form).findByText('Enter your name.')).toBeInTheDocument();
    await user.type(field, 'Lisa');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('You cannot change this name.')).toBeInTheDocument();
  });
});

describe('Backups in Settings', () => {
  const BACKUPS = { last: null, recovery: null, recoveryNeeded: true, linkChanged: false, restore: null, kept: [], bundles: [] };

  it('shows the backups to the CEO, under the link', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'GET /api/backups': [200, BACKUPS] });
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(await within(dialog).findByRole('heading', { name: 'Backups' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save the recovery file' })).toBeInTheDocument();
    const headings = within(dialog).getAllByRole('heading').map(heading => heading.textContent);
    expect(headings.indexOf('Link on the internet')).toBeLessThan(headings.indexOf('Backups'));
  });

  it('shows no backups to anyone else, and asks the server for none', async () => {
    const calls = mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'GET /api/backups': [200, BACKUPS] });
    render(<Settings me={{ ...ME, person: { ...ME.person, isOwner: false } }} group="company" onClose={() => {}} />);
    expect(await screen.findByRole('link', { name: 'https://acme.hornhoof.org' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Backups' })).not.toBeInTheDocument();
    /* The groups the window may show, the link and the key of the git host are asked for, the backups never. */
    await waitFor(() => expect(calls.map(call => call.path).sort()).toEqual(['/api/google-sheets', '/api/link', '/api/repo-host', '/api/vault']));
  });

  it('shows nothing of them on a server that knows none yet', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'GET /api/repo-host': [200, { host: null }], 'GET /api/google-sheets': [200, { google: null }] });
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    expect(await screen.findByRole('link', { name: 'https://acme.hornhoof.org' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Backups' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/* The nav of the window, as a person reads it. */
const groups = async (dialog: HTMLElement) => {
  const nav = within(dialog).getByRole('navigation', { name: /^(Settings groups|Группы настроек)$/ });
  return within(nav).getAllByRole('button').map(button => button.textContent);
};

describe('Settings in the account menu', () => {
  afterEach(() => {
    localStorage.clear();
    history.replaceState(null, '', '/');
  });

  it('opens one window on Profile, then four groups in order, for a person who sees the whole company', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'GET /api/google-sheets': [200, { google: null }], 'GET /api/vault': [200, { entries: [] }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('button', { name: 'Company settings' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(location.pathname).toBe('/settings/profile');
    expect(within(dialog).getByRole('heading', { name: 'Profile', level: 3 })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Profile' })).toHaveAttribute('aria-current', 'page');
    await waitFor(async () => expect(await groups(dialog)).toEqual(['Profile', 'Appearance & language', 'Integrations', 'Passwords', 'Company & access']));
    for (const [name, path, text] of [
      ['Integrations', '/settings/integrations', 'Google Sheets is not connected yet. Until a key is saved here, employees attach a ready .xlsx file to the task and chat instead.'],
      ['Passwords', '/settings/passwords', 'No sign-ins are saved yet.'],
      ['Company & access', '/settings/company', 'Hornhoof opens from anywhere at this link:'],
      ['Appearance & language', '/settings', 'Only for you and only in this browser. Other members keep their language and theme.'],
      ['Profile', '/settings/profile', 'Name'],
    ] as const) {
      await user.click(within(dialog).getByRole('button', { name }));
      expect(location.pathname).toBe(path);
      expect(within(dialog).getByRole('button', { name })).toHaveAttribute('aria-current', 'page');
      expect(within(dialog).getByRole('heading', { name, level: 3 })).toBeInTheDocument();
      expect((await within(dialog).findAllByText(text))[0]).toBeInTheDocument();
    }
  });

  it('shows a person who sees only some departments their Profile and the groups the server gives them, and no empty Company & access', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/google-sheets': FORBIDDEN, 'GET /api/vault': [200, { entries: [] }] });
    const user = userEvent.setup();
    render(<Shell me={LISTED} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(async () => expect(await groups(dialog)).toEqual(['Profile', 'Appearance & language', 'Passwords']));
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue(LISTED.person.name);
    expect(calls.some(call => ['/api/link', '/api/backups'].includes(call.path))).toBe(false);
    history.pushState(null, '', '/settings/company');
    dispatchEvent(new PopStateEvent('popstate'));
    expect(await within(screen.getByRole('dialog', { name: 'Settings' })).findByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
  });

  it('leaves out a group whose data the server does not give, and says so at its address', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/google-sheets': FORBIDDEN });
    history.replaceState(null, '', '/settings/integrations');
    render(<Shell me={LISTED} onSignOut={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(await within(dialog).findByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
    expect(await groups(dialog)).toEqual(['Profile', 'Appearance & language']);
  });

  /* Design took one group at a time on three conditions (#970, finding 3): the open item stands out and is the current
     page, the open group's heading stands at its top, and at a phone's width the items wrap in rows, whole words. */
  it('marks the open group in the list and stands its heading first, the items in rows at a phone width', async () => {
    mockApi({ 'GET /api/google-sheets': [200, { google: null }], 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }] });
    render(<Settings me={ME} group="integrations" onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const nav = within(dialog).getByRole('navigation', { name: 'Settings groups' });
    await waitFor(() => expect(within(nav).getAllByRole('button')).toHaveLength(4));
    expect(within(nav).getAllByRole('button').filter(button => button.hasAttribute('aria-current')).map(button => [button.textContent, button.getAttribute('aria-current')])).toEqual([['Integrations', 'page']]);
    const group = dialog.querySelector('.sgroup')!;
    expect(group.firstElementChild).toHaveClass('g-head');
    expect(group.firstElementChild!.firstElementChild).toBe(within(dialog).getByRole('heading', { level: 3, name: 'Integrations' }));
    const current = ".settings-nav .btn[aria-current='page']";
    expect(decl(current, 'background')).toBe('var(--surface2)');
    expect(decl(current, 'color')).toBe('var(--cyan-ink)');
    expect(decl(current, 'border-inline-start-color')).toBe('var(--cyan-ink)');
    expect(decl(current, 'box-shadow', '(max-width: 760px)')).toBe('inset 0 0 0 1px var(--cyan-ink), inset 0 -4px 0 var(--cyan-ink)');
    expect(decl('.settings-nav', 'flex-direction', '(max-width: 760px)')).toBe('row');
    expect(decl('.settings-nav', 'flex-wrap', '(max-width: 760px)')).toBe('wrap');
    expect(decl('.settings-nav .btn', 'white-space')).toBe('normal');
    expect(decl('.settings-nav .btn', 'overflow-wrap')).toBe('break-word');
  });

  it('names the groups in Russian, in the menu and on the window', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/google-sheets': [200, { google: null }], 'GET /api/vault': [200, { entries: [] }] });
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <Shell me={ME} onSignOut={() => {}} />
      </LanguageProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Аккаунт' }));
    await user.click(screen.getByRole('button', { name: 'Настройки' }));
    const dialog = await screen.findByRole('dialog', { name: 'Настройки' });
    await waitFor(async () => expect(await groups(dialog)).toEqual(['Профиль', 'Оформление и язык', 'Интеграции', 'Пароли', 'Компания и доступ']));
  });
});

describe('the language under Appearance & language', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.lang = '';
  });

  it('offers every shipped language in one list, each named in itself, and switches the whole page at once', async () => {
    localStorage.setItem('hh-lang', 'en');
    mockApi({ 'GET /api/org': [200, ORG] });
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <Shell me={LISTED} onSignOut={() => {}} />
      </LanguageProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('group', { name: 'Language' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Русский' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(dialog).getByRole('button', { name: 'Appearance & language' }));
    expect(within(dialog).getByRole('heading', { name: 'Language', level: 4 })).toBeInTheDocument();
    expect(within(dialog).queryByRole('radiogroup')).not.toBeInTheDocument();
    const list = within(dialog).getByRole('combobox', { name: 'Language' });
    expect(list).toHaveAccessibleDescription('The language of Hornhoof. It changes at once.');
    expect(list).toHaveValue('en');
    const options = within(list).getAllByRole('option');
    expect(options.map(option => [option.textContent, option.getAttribute('value'), option.getAttribute('lang')])).toEqual(LANGUAGES.map(l => [l.name, l.id, l.id]));
    await user.selectOptions(list, 'Русский');
    expect(screen.getByRole('dialog', { name: 'Настройки' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Язык' })).toHaveValue('ru');
    expect(within(dialog).getByRole('button', { name: 'Оформление и язык' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Карта' })).toBeInTheDocument();
    expect(localStorage.getItem('hh-lang')).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Язык' }), 'English');
    expect(screen.getByRole('button', { name: 'Map' })).toBeInTheDocument();
    expect(localStorage.getItem('hh-lang')).toBe('en');
  });

  it('puts its hint 4 px under its heading and the list 8 px under the hint, with no margin of the browser', () => {
    expect(decl('.settings-window .lang-part', 'gap')).toBe('4px');
    expect(decl('.lang-part > p', 'margin')).toBe('0');
    expect(decl('.lang-part > .select-wrap', 'margin-block-start')).toBe('4px');
  });

  it('draws text and buttons with the same widths in every engine', () => {
    expect(decl('body', 'text-rendering')).toBe('geometricPrecision');
    /* Chromium's own styles give its controls text-rendering: auto; they take the page's instead. */
    expect(decl('button', 'text-rendering')).toBe('inherit');
  });

  it('draws the list 44 px high from the theme tokens, at most 360 px wide, with its own arrow at the end of either direction', () => {
    expect(decl('.select-wrap', 'max-inline-size')).toBe('360px');
    expect(decl('.select-wrap', 'position')).toBe('relative');
    expect(decl('.lang-select', 'block-size')).toBe('44px');
    expect(decl('.lang-select', 'inline-size')).toBe('100%');
    expect(decl('.lang-select', 'padding-inline')).toBe('12px 36px');
    expect(decl('.lang-select', 'background')).toBe('var(--surface2)');
    expect(decl('.lang-select', 'border')).toBe('1px solid var(--line2)');
    expect(decl('.lang-select', 'white-space')).toBe('nowrap');
    expect(decl('.lang-select:focus-visible', 'outline')).toBe('2px solid var(--cyan-ink)');
    expect(decl('.lang-select:focus-visible', 'outline-offset')).toBe('2px');
    expect(decl('.select-wrap::after', 'inset-inline-end')).toBe('14px');
    expect(decl('.select-wrap::after', 'border-bottom')).toBe('2px solid var(--muted)');
  });
});
