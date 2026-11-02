import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Settings } from '../src/screens/Settings';
import { Shell } from '../src/screens/Shell';
import { ME, mockApi, ORG } from './api-mock';
import { decl } from './css';

const ACME = { name: 'acme', url: 'https://acme.hornhoof.org' };

describe('Share access', () => {
  it('shows the public link with a copy button', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }] });
    render(<Settings me={ME} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Share access' });
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

  it('opens Hornhoof on the internet at a name made from the company name', async () => {
    const calls = mockApi({
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'GET /api/link/names/acme': [200, { name: 'acme', free: true }],
      'PUT /api/link': [200, { link: ACME }],
    });
    const user = userEvent.setup();
    render(<Settings me={ME} onClose={() => {}} />);
    expect(await screen.findByText('Hornhoof opens only at its own address, on this computer and your network.')).toBeInTheDocument();
    expect(screen.getByLabelText('Link')).toHaveValue('acme');
    expect(screen.getByText(/A name like this is easy to guess/)).toBeInTheDocument();
    await screen.findByText('acme.hornhoof.org is free.');
    await user.click(screen.getByRole('button', { name: 'Open on the internet' }));
    expect(await screen.findByRole('link', { name: 'https://acme.hornhoof.org' })).toBeInTheDocument();
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ name: 'acme' });
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

describe('Share access in the account menu', () => {
  afterEach(() => localStorage.clear());

  it('opens for people who see the whole company', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Share access' }));
    expect(await screen.findByRole('dialog', { name: 'Share access' })).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Общий доступ' }));
    expect(await screen.findByRole('dialog', { name: 'Общий доступ' })).toBeInTheDocument();
  });

  it('is not there for people who see only some departments', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const user = userEvent.setup();
    render(<Shell me={{ ...ME, person: { ...ME.person, scopeKind: 'listed' } }} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('button', { name: 'Share access' })).not.toBeInTheDocument();
  });
});
