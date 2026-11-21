import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Settings } from '../src/screens/Settings';
import type { VaultEntry } from '../src/ui/Vault';
import { ME, mockApi } from './api-mock';

const ENTRY: VaultEntry = { id: 'v1', name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', hasCode: true, createdBy: { id: 'p2', name: 'Maria' }, createdAt: '2030-01-01T09:00:00.000Z' };
const NOT_CEO = { ...ME, person: { ...ME.person, id: 'p3', isOwner: false, scopeKind: 'listed' as const } };
const LOG = [
  { id: 'l1', kind: 'taken', person: null, agent: { id: 'a2', name: 'Nora' }, task: { id: 't', number: 42 }, at: '2030-01-01T10:00:00.000Z' },
  { id: 'l2', kind: 'taken', person: null, agent: { id: 'a2', name: 'Nora' }, task: null, at: '2030-01-01T09:40:00.000Z' },
  { id: 'l3', kind: 'changed', person: null, agent: { id: 'a1', name: 'Ferris AI' }, task: null, at: '2030-01-01T09:30:00.000Z' },
  { id: 'l4', kind: 'created', person: { id: 'p2', name: 'Maria' }, agent: null, task: null, at: '2030-01-01T09:00:00.000Z' },
];

const open = (me = ME) => render(<Settings me={me} group="passwords" onClose={() => {}} />);

describe('the Passwords group of the settings', () => {
  it('lists each sign-in with its site, login and who added it, and never a password', async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [ENTRY, { ...ENTRY, id: 'v2', name: 'CRM', hasCode: false, createdBy: { id: 'a1', name: 'Ferris AI' } }, { ...ENTRY, id: 'v3', name: 'Shop', createdBy: null }] }] });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('heading', { name: 'Passwords' })).toBeInTheDocument();
    expect(await within(dialog).findByText('Partner site')).toBeInTheDocument();
    expect(within(dialog).getAllByText('https://partner.example/login')).toHaveLength(3);
    expect(within(dialog).getAllByText('Login: team@acme.test. With a one-time code.')).toHaveLength(2);
    expect(within(dialog).getByText('Login: team@acme.test.')).toBeInTheDocument();
    expect(within(dialog).getByText(/^Added by Maria, /)).toBeInTheDocument();
    expect(within(dialog).getByText(/^Added by Ferris AI, /)).toBeInTheDocument();
    expect(within(dialog).getByText(/^Added 01\/01\/2030/)).toBeInTheDocument();
    expect(dialog.querySelector('input[type=password]')).toBeNull();
  });

  it('lets every person change and remove any sign-in', async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [ENTRY] }] });
    open(NOT_CEO);
    expect(await screen.findByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument();
  });

  it('puts the focus on the first field with a problem and says what is wrong', async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [] }] });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Add a sign-in' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const name = screen.getByLabelText('Name');
    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Give the sign-in a name.');
    await user.type(name, 'Partner site');
    await user.type(screen.getByLabelText('Site'), 'https://partner.example/login');
    await user.type(screen.getByLabelText('Login'), 'team@acme.test');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const password = screen.getByLabelText('Password');
    await waitFor(() => expect(password).toHaveFocus());
    expect(password).toHaveAccessibleDescription('Enter the password.');
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
  });

  it('sends a new sign-in with its password and code key once, then lists it', async () => {
    const calls = mockApi({ 'GET /api/vault': [200, { entries: [] }], 'POST /api/vault': [201, ENTRY] });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Add a sign-in' }));
    /* A site's password, masked, in a field no browser fills with or saves as the Hornhoof sign-in (#1320). */
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByLabelText('Password')).toHaveClass('secret-masked');
    await user.type(screen.getByLabelText('Name'), 'Partner site');
    await user.type(screen.getByLabelText('Site'), 'https://partner.example/login');
    await user.type(screen.getByLabelText('Login'), 'team@acme.test');
    await user.type(screen.getByLabelText('Password'), 'pw1');
    await user.type(screen.getByLabelText('One-time code key (optional)'), 'jbsw y3dp ehpk 3pxp');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    /* The list is read again after the sign-in went in. */
    await waitFor(() => {
      const posted = calls.findIndex(c => c.method === 'POST');
      expect(posted).toBeGreaterThanOrEqual(0);
      expect(calls.findLastIndex(c => c.method === 'GET' && c.path === '/api/vault')).toBeGreaterThan(posted);
    });
    expect(calls.find(c => c.method === 'POST')).toEqual({
      method: 'POST', path: '/api/vault',
      body: { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: 'pw1', code: 'jbsw y3dp ehpk 3pxp' },
    });
  });

  it('keeps the saved password when a change leaves it empty, and can drop the code', async () => {
    const calls = mockApi({ 'GET /api/vault': [200, { entries: [ENTRY] }], 'PATCH /api/vault/v1': [200, ENTRY] });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Leave it empty to keep the saved password.');
    await user.clear(screen.getByLabelText('Login'));
    await user.type(screen.getByLabelText('Login'), 'new@acme.test');
    await user.click(screen.getByLabelText('Remove the one-time code key'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to update this sign-in?' });
    expect(dialog).toHaveAccessibleDescription('The saved sign-in Partner site will be updated.');
    expect(within(dialog).getByText('Partner site').tagName).toBe('BDI');
    expect(dialog).toHaveTextContent('The saved one-time code key will be removed.');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toBeDefined());
    expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({ name: 'Partner site', site: 'https://partner.example/login', login: 'new@acme.test', removeCode: true });
  });

  it('never shows password or 2FA code in the confirmation dialog, uses ordinary focus for metadata edits, and shows vault_name_taken inside the dialog', async () => {
    const calls = mockApi({
      'GET /api/vault': [200, { entries: [ENTRY] }],
      'PATCH /api/vault/v1': [409, { error: { code: 'conflict', message: 'The vault already has an entry of this name.', reason: 'vault_name_taken' } }],
    });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Change' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'CRM');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const ordinary = screen.getByRole('alertdialog', { name: 'Do you really want to update this sign-in?' });
    expect(within(ordinary).getByRole('button', { name: 'Save' })).toHaveFocus();
    await user.click(within(ordinary).getByRole('button', { name: 'Save' }));
    expect(await within(ordinary).findByRole('alert')).toHaveTextContent('A sign-in with this name is already saved.');
    await user.click(within(ordinary).getByRole('button', { name: 'Cancel' }));

    await user.type(screen.getByLabelText('Password'), 'super-secret-pw-999');
    await user.type(screen.getByLabelText('One-time code key (optional)'), 'JBSWY3DPEHPK3PXP');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const danger = screen.getByRole('alertdialog', { name: 'Do you really want to update this sign-in?' });
    expect(within(danger).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(danger.textContent).not.toContain('super-secret-pw-999');
    expect(danger.textContent).not.toContain('JBSWY3DPEHPK3PXP');
    expect(danger).toHaveTextContent('The saved password will be replaced.');
    expect(danger).toHaveTextContent('The saved one-time code key will be replaced.');
    await user.click(within(danger).getByRole('button', { name: 'Cancel' }));
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });

  it('says a taken name at the name field', async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [] }], 'POST /api/vault': [409, { error: { code: 'conflict', message: 'The vault already has an entry of this name.', reason: 'vault_name_taken' } }] });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Add a sign-in' }));
    await user.type(screen.getByLabelText('Name'), 'Partner site');
    await user.type(screen.getByLabelText('Site'), 'https://partner.example');
    await user.type(screen.getByLabelText('Login'), 'team');
    await user.type(screen.getByLabelText('Password'), 'pw-1234');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const name = screen.getByLabelText('Name');
    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toHaveAccessibleDescription('A sign-in with this name is already saved.');
  });

  it('asks before removing a sign-in, then removes it', async () => {
    const calls = mockApi({ 'GET /api/vault': [200, { entries: [ENTRY] }], 'DELETE /api/vault/v1': [204, undefined] });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to remove this sign-in?' });
    expect(dialog).toHaveAccessibleDescription('Partner site will be removed. Employees can no longer sign in with it.');
    expect(dialog).toHaveTextContent('This cannot be undone.');
    expect(within(dialog).getByText('Partner site').tagName).toBe('BDI');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/api/vault/v1')).toBe(true));
  });

  it('shows the history of a sign-in in words: who added, changed or took it, and for which task', async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [ENTRY] }], 'GET /api/vault/v1/log': [200, { log: LOG }] });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'History' }));
    expect(await screen.findByText('Nora took it for task #42.')).toBeInTheDocument();
    expect(screen.getByText('Nora took it.')).toBeInTheDocument();
    expect(screen.getByText('Ferris AI changed it.')).toBeInTheDocument();
    expect(screen.getByText('Maria added it.')).toBeInTheDocument();
    expect(screen.queryByText(/taken|created|changed\b(?! it)/)).toBeNull();
  });

  it('says the same in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi({ 'GET /api/vault': [200, { entries: [ENTRY] }], 'GET /api/vault/v1/log': [200, { log: LOG }] });
    const user = userEvent.setup();
    render(<LanguageProvider><Settings me={ME} group="passwords" onClose={() => {}} /></LanguageProvider>);
    expect(await screen.findByText(/^Добавил\(а\) Maria, /)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'История' }));
    expect(await screen.findByText('Nora: взято для задачи #42.')).toBeInTheDocument();
    expect(screen.getByText('Nora: взято.')).toBeInTheDocument();
    expect(screen.getByText('Ferris AI: изменено.')).toBeInTheDocument();
    expect(screen.getByText('Maria: добавлено.')).toBeInTheDocument();
  });
});
