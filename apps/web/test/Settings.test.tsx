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
const OUTBOUND = { channels: [], messages: [], escalations: [], approvals: [] };
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

describe('your own name', () => {
  it('saves a trimmed name and reports the new name to the shell', async () => {
    const calls = mockApi({ 'PATCH /api/people/p1': [200, { person: { ...ME.person, name: 'Lisa' } }] });
    const renamed: string[] = [];
    const user = userEvent.setup();
    render(<Settings me={LISTED} group="company" onClose={() => {}} onRenamed={name => renamed.push(name)} />);
    const field = await screen.findByLabelText('Name');
    await user.clear(field);
    await user.type(field, '  Lisa  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/people/p1', body: { name: 'Lisa' } });
    expect(renamed).toEqual(['Lisa']);
  });

  it('shows empty and server name errors by the field', async () => {
    mockApi({ 'PATCH /api/people/p1': [403, { error: { code: 'forbidden', message: 'You cannot change this name.', reason: 'rename_failed' } }] });
    const user = userEvent.setup();
    render(<Settings me={LISTED} group="company" onClose={() => {}} />);
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
    await waitFor(() => expect(calls.map(call => call.path).sort()).toEqual(['/api/google-sheets', '/api/link', '/api/outbound', '/api/repo-host']));
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

  it('opens one window in four groups, in order, for a person who sees the whole company', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'GET /api/google-sheets': [200, { google: null }], 'GET /api/outbound': [200, OUTBOUND] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('button', { name: 'Company settings' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(async () => expect(await groups(dialog)).toEqual(['Appearance & language', 'Integrations', 'External messaging', 'Company & access']));
    for (const [name, path, text] of [
      ['Integrations', '/settings/integrations', 'Google Sheets is not connected yet. Until a key is saved here, employees attach a ready .xlsx file to the task and chat instead.'],
      ['External messaging', '/settings/messaging', 'Nothing has been sent or queued outside yet.'],
      ['Company & access', '/settings/company', 'Hornhoof opens from anywhere at this link:'],
      ['Appearance & language', '/settings', 'Your choice stays in this browser.'],
    ] as const) {
      await user.click(within(dialog).getByRole('button', { name }));
      expect(location.pathname).toBe(path);
      expect(within(dialog).getByRole('button', { name })).toHaveAttribute('aria-current', 'page');
      expect((await within(dialog).findAllByText(text))[0]).toBeInTheDocument();
    }
  });

  it('shows a person who sees only some departments the groups the server gives them, with only their name under Company & access', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG], 'GET /api/google-sheets': FORBIDDEN, 'GET /api/outbound': [200, OUTBOUND] });
    const user = userEvent.setup();
    render(<Shell me={LISTED} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(async () => expect(await groups(dialog)).toEqual(['Appearance & language', 'External messaging', 'Company & access']));
    await user.click(within(dialog).getByRole('button', { name: 'Company & access' }));
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(['Your profile']);
    expect(calls.some(call => ['/api/link', '/api/repo-host', '/api/backups'].includes(call.path))).toBe(false);
  });

  it('leaves out a group whose data the server does not give, and says so at its address', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/google-sheets': FORBIDDEN, 'GET /api/outbound': FORBIDDEN });
    history.replaceState(null, '', '/settings/integrations');
    render(<Shell me={LISTED} onSignOut={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(await within(dialog).findByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
    expect(await groups(dialog)).toEqual(['Appearance & language', 'Company & access']);
  });

  it('names the groups in Russian, in the menu and on the window', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/google-sheets': [200, { google: null }], 'GET /api/outbound': [200, OUTBOUND] });
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <Shell me={ME} onSignOut={() => {}} />
      </LanguageProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Аккаунт' }));
    await user.click(screen.getByRole('button', { name: 'Настройки' }));
    const dialog = await screen.findByRole('dialog', { name: 'Настройки' });
    await waitFor(async () => expect(await groups(dialog)).toEqual(['Оформление и язык', 'Интеграции', 'Внешние рассылки', 'Компания и доступ']));
  });
});

describe('the language under Appearance & language', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.lang = '';
  });

  it('offers every shipped language, each named in itself, and switches the whole page at once', async () => {
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
    expect(within(dialog).getByRole('heading', { name: 'Language', level: 3 })).toHaveFocus();
    const choices = within(within(dialog).getByRole('radiogroup', { name: 'Language' })).getAllByRole('radio');
    expect(choices.map(choice => [choice.closest('label')!.textContent, (choice as HTMLInputElement).checked])).toEqual(LANGUAGES.map(l => [l.name, l.id === 'en']));
    expect(LANGUAGES.map(l => within(dialog).getByText(l.name).getAttribute('lang'))).toEqual(LANGUAGES.map(l => l.id));
    await user.click(within(dialog).getByRole('radio', { name: 'Русский' }));
    expect(screen.getByRole('dialog', { name: 'Настройки' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Русский' })).toBeChecked();
    expect(within(dialog).getByRole('heading', { name: 'Язык', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Карта' })).toBeInTheDocument();
    expect(localStorage.getItem('hh-lang')).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
    await user.click(within(dialog).getByRole('radio', { name: 'English' }));
    expect(screen.getByRole('button', { name: 'Map' })).toBeInTheDocument();
    expect(localStorage.getItem('hh-lang')).toBe('en');
  });

  it('lays each language out as a 44 px choice from the theme tokens that wraps by whole names', () => {
    expect(decl('.lang-choices', 'flex-wrap')).toBe('wrap');
    expect(decl('.lang-choice', 'min-height')).toBe('44px');
    expect(decl('.lang-choice', 'border')).toBe('1px solid var(--line2)');
    expect(decl('.lang-choice', 'background')).toBe('var(--surface2)');
    expect(decl(".lang-choice[data-on='true']", 'border-color')).toBe('var(--cyan)');
    expect(decl(".lang-choice[data-on='true']", 'color')).toBe('var(--cyan-ink)');
  });
});
