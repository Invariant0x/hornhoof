import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Settings } from '../src/screens/Settings';
import { Profile } from '../src/screens/Profile';
import { Shell } from '../src/screens/Shell';
import { ME, mockApi, ORG } from './api-mock';
import { decl } from './css';

vi.mock('@hornhoof/protocol/link', async importOriginal => ({ ...(await importOriginal<typeof import('@hornhoof/protocol/link')>()), randomLinkName: () => 'r4nd0mr4nd0mr4nd0m' }));

const ACME = { name: 'acme', url: 'https://acme.hornhoof.org' };
const RANDOM = 'r4nd0mr4nd0mr4nd0m';
const AGREEMENT = 'Let\'s Encrypt Subscriber Agreement';
const tls = (mode: 'http' | 'https') => ({ mode, certificate: mode === 'https', expiresAt: null, failedAt: null });

describe('Company settings', () => {
  it('shows the public link with a copy button', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }] });
    render(<Settings me={ME} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Company settings' });
    expect(within(dialog).getByText('Hornhoof opens from anywhere at this link:')).toBeInTheDocument();
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
    render(<Settings me={ME} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Change name' }));
    expect(screen.getByLabelText('Link')).toHaveValue('acme');
    expect(screen.getByLabelText('Link').closest('.link-input')).toHaveTextContent('.hornhoof.org');
    expect(screen.getByText('Machines connected through the old link lose the connection. Connect them again under Subscriptions or Machines.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Link'));
    await user.type(screen.getByLabelText('Link'), 'acme-corp');
    expect(await screen.findByText('acme-corp.hornhoof.org is free.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
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
    render(<Settings me={ME} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Change name' }));
    await user.clear(screen.getByLabelText('Link'));
    await user.type(screen.getByLabelText('Link'), longest);
    const note = await screen.findByText(`${longest}.hornhoof.org is free.`);
    expect(note.matches('.link-name > span')).toBe(true);
    expect(decl('.link-name > span', 'overflow-wrap')).toBe('anywhere');
  });

  it('says the link is encrypted to this machine in https mode, and to hornhoof.org otherwise', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org', tls: tls('https') }] });
    const first = render(<Settings me={ME} onClose={() => {}} />);
    expect(await screen.findByText('Encrypted to this machine')).toBeInTheDocument();
    expect(screen.queryByText(/Encrypted to hornhoof.org for now/)).not.toBeInTheDocument();
    first.unmount();
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org', tls: tls('http') }] });
    render(<Settings me={ME} onClose={() => {}} />);
    expect(await screen.findByText('Encrypted to hornhoof.org for now. Hornhoof moves the encryption to this machine on its own.')).toBeInTheDocument();
    expect(screen.queryByText('Encrypted to this machine')).not.toBeInTheDocument();
  });

  it('names the Let\'s Encrypt Subscriber Agreement with a link to it', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org', tls: tls('https') }] });
    const first = render(<Settings me={ME} onClose={() => {}} />);
    const agreement = await screen.findByRole('link', { name: AGREEMENT });
    expect(agreement).toHaveAttribute('href', 'https://letsencrypt.org/repository/');
    expect(agreement).toHaveAttribute('target', '_blank');
    expect(agreement).toHaveAttribute('rel', 'noreferrer');
    expect(agreement.parentElement).toHaveTextContent(`The link's certificate comes from Let's Encrypt. Getting it accepts the ${AGREEMENT} for your company.`);
    first.unmount();
    mockApi({ 'GET /api/link': [200, { link: null, domain: 'hornhoof.org', tls: null }] });
    render(<Settings me={ME} onClose={() => {}} />);
    await screen.findByText('Hornhoof opens only at its own address, on this computer and your network.');
    expect(screen.queryByRole('link', { name: AGREEMENT })).not.toBeInTheDocument();
  });

  it('removes the link after asking', async () => {
    const calls = mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'DELETE /api/link': [204] });
    const user = userEvent.setup();
    render(<Settings me={ME} onClose={() => {}} />);
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
    render(<Settings me={ME} onClose={() => {}} />);
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
    render(<Settings me={ME} onClose={() => {}} />);
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
    render(<Settings me={ME} onClose={() => {}} />);
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
    render(<Settings me={ME} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Open on the internet' }));
    expect(await screen.findByText('This link is taken already. Pick another name.')).toBeInTheDocument();
  });
});

describe('your own name', () => {
  it('saves a trimmed name and reports the new name to the shell', async () => {
    const calls = mockApi({ 'PATCH /api/people/p1': [200, { person: { ...ME.person, name: 'Lisa' } }] });
    const renamed: string[] = [];
    const user = userEvent.setup();
    render(<Profile me={ME} onClose={() => {}} onRenamed={name => renamed.push(name)} />);
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
    render(<Profile me={ME} onClose={() => {}} />);
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
    render(<Settings me={ME} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Company settings' });
    expect(await within(dialog).findByRole('heading', { name: 'Backups' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save the recovery file' })).toBeInTheDocument();
    const headings = within(dialog).getAllByRole('heading').map(heading => heading.textContent);
    expect(headings.indexOf('Link on the internet')).toBeLessThan(headings.indexOf('Backups'));
  });

  it('shows no backups to anyone else, and asks the server for none', async () => {
    const calls = mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'GET /api/backups': [200, BACKUPS] });
    render(<Settings me={{ ...ME, person: { ...ME.person, isOwner: false } }} onClose={() => {}} />);
    expect(await screen.findByRole('link', { name: 'https://acme.hornhoof.org' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Backups' })).not.toBeInTheDocument();
    /* The link and the key of the git host are asked for, the backups never. */
    expect(calls.map(call => call.path).sort()).toEqual(['/api/link', '/api/repo-host']);
  });

  it('shows nothing of them on a server that knows none yet', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'GET /api/repo-host': [200, { host: null }] });
    render(<Settings me={ME} onClose={() => {}} />);
    expect(await screen.findByRole('link', { name: 'https://acme.hornhoof.org' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Backups' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Company settings in the account menu', () => {
  afterEach(() => localStorage.clear());

  it('opens for people who see the whole company', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Company settings' }));
    expect(await screen.findByRole('dialog', { name: 'Company settings' })).toBeInTheDocument();
  });

  it('has its Russian name in the menu and on the window', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }] });
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <Shell me={ME} onSignOut={() => {}} />
      </LanguageProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Аккаунт' }));
    await user.click(screen.getByRole('button', { name: 'Настройки компании' }));
    expect(await screen.findByRole('dialog', { name: 'Настройки компании' })).toBeInTheDocument();
  });

  it('is not there for people who see only some departments', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const user = userEvent.setup();
    render(<Shell me={{ ...ME, person: { ...ME.person, scopeKind: 'listed' } }} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('button', { name: 'Company settings' })).not.toBeInTheDocument();
  });
});
