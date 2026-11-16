import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Settings } from '../src/screens/Settings';
import type { VaultEntry } from '../src/ui/Vault';
import { ME, mockApi, ORG_WITH_TEAMS } from './api-mock';

const ENTRY: VaultEntry = {
  id: 'v1', name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', hasCode: true, scope: { kind: 'company' },
  createdBy: { id: 'p2', name: 'Maria' }, createdAt: '2030-01-01T09:00:00.000Z', updatedBy: { id: 'p2', name: 'Maria' }, updatedAt: '2030-01-01T09:00:00.000Z',
};
const NOT_CEO = { ...ME, person: { ...ME.person, id: 'p3', isOwner: false, scopeKind: 'listed' as const } };

const open = (me = ME) => render(<Settings me={me} group="passwords" onClose={() => {}} />);

describe('the Passwords group of the settings', () => {
  it('lists each sign-in with its site, login, who may use it and who added it, and never a password', async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [ENTRY, { ...ENTRY, id: 'v2', name: 'CRM', hasCode: false, scope: { kind: 'department', departmentId: 'd1', departmentName: 'Marketing' } }] }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('heading', { name: 'Passwords' })).toBeInTheDocument();
    expect(await within(dialog).findByText('Partner site')).toBeInTheDocument();
    expect(within(dialog).getAllByText('https://partner.example/login')).toHaveLength(2);
    expect(within(dialog).getAllByText('Login: team@acme.test. With a one-time code.')).toHaveLength(1);
    expect(within(dialog).getByText('For everyone in the company.')).toBeInTheDocument();
    expect(within(dialog).getByText('Only for the department Marketing.')).toBeInTheDocument();
    expect(within(dialog).getAllByText(/^Added by Maria, /)).toHaveLength(2);
    expect(dialog.querySelector('input[type=password]')).toBeNull();
  });

  it('shows Change and Remove only to the person who added a sign-in and to the CEO', async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [ENTRY] }] });
    const ceo = open();
    expect(await screen.findByRole('button', { name: 'Change' })).toBeInTheDocument();
    ceo.unmount();
    mockApi({ 'GET /api/vault': [200, { entries: [ENTRY] }] });
    open(NOT_CEO);
    expect(await screen.findByRole('button', { name: 'History' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('puts the focus on the first field with a problem and says what is wrong', async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [] }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
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
    const calls = mockApi({ 'GET /api/vault': [200, { entries: [] }], 'POST /api/vault': [201, ENTRY], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Add a sign-in' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
    await user.type(screen.getByLabelText('Name'), 'Partner site');
    await user.type(screen.getByLabelText('Site'), 'https://partner.example/login');
    await user.type(screen.getByLabelText('Login'), 'team@acme.test');
    await user.type(screen.getByLabelText('Password'), 'pw-1234');
    await user.type(screen.getByLabelText('One-time code key (optional)'), 'jbsw y3dp ehpk 3pxp');
    await user.selectOptions(screen.getByLabelText('Who may use it'), 'department');
    await user.selectOptions(screen.getByLabelText('Department'), 'd1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    /* The list is read again after the sign-in went in. */
    await waitFor(() => {
      const posted = calls.findIndex(c => c.method === 'POST');
      expect(posted).toBeGreaterThanOrEqual(0);
      expect(calls.findLastIndex(c => c.method === 'GET' && c.path === '/api/vault')).toBeGreaterThan(posted);
    });
    expect(calls.find(c => c.method === 'POST')).toEqual({
      method: 'POST', path: '/api/vault',
      body: { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: 'pw-1234', code: 'jbsw y3dp ehpk 3pxp', scope: { kind: 'department', departmentId: 'd1' } },
    });
  });

  it('keeps the saved password when a change leaves it empty, and can drop the code', async () => {
    const calls = mockApi({ 'GET /api/vault': [200, { entries: [ENTRY] }], 'PATCH /api/vault/v1': [200, ENTRY], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Leave it empty to keep the saved password.');
    await user.clear(screen.getByLabelText('Login'));
    await user.type(screen.getByLabelText('Login'), 'new@acme.test');
    await user.click(screen.getByLabelText('Remove the one-time code key'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toBeDefined());
    expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({ name: 'Partner site', site: 'https://partner.example/login', login: 'new@acme.test', scope: { kind: 'company' }, removeCode: true });
  });

  it('says a taken name at the name field', async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [] }], 'POST /api/vault': [409, { error: { code: 'conflict', message: 'The vault already has an entry of this name.', reason: 'vault_name_taken' } }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
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
    expect(screen.getByText('Remove Partner site? Employees can no longer sign in with it.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/api/vault/v1')).toBe(true));
  });

  /* Who took a sign-in for which task, and who added or changed it, in words of each language, never a raw kind. */
  const HISTORY = { log: [
    { id: 'l1', kind: 'taken', person: null, agent: { id: 'a2', name: 'Nora' }, task: { id: 't', number: 42 }, at: '2030-01-01T10:00:00.000Z' },
    { id: 'l2', kind: 'taken', person: null, agent: { id: 'a3', name: 'Aide' }, task: null, at: '2030-01-01T09:45:00.000Z' },
    { id: 'l3', kind: 'changed', person: { id: 'p2', name: 'Maria' }, agent: null, task: null, at: '2030-01-01T09:30:00.000Z' },
    { id: 'l4', kind: 'created', person: { id: 'p2', name: 'Maria' }, agent: { id: 'o1', name: 'Orchestrator' }, task: null, at: '2030-01-01T09:00:00.000Z' },
  ] };

  it('shows the history of a sign-in with who took it for which task', async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [ENTRY] }], 'GET /api/vault/v1/log': [200, HISTORY] });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'History' }));
    expect(await screen.findByText('Nora took it to sign in for task #42.')).toBeInTheDocument();
    expect(screen.getByText('Aide took it to sign in.')).toBeInTheDocument();
    expect(screen.getByText('Maria changed it.')).toBeInTheDocument();
    expect(screen.getByText('Maria added it.')).toBeInTheDocument();
    expect(screen.queryByText(/\b(taken|created)\b/)).toBeNull();
  });

  it('shows the history in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi({ 'GET /api/vault': [200, { entries: [ENTRY] }], 'GET /api/vault/v1/log': [200, HISTORY] });
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <Settings me={ME} group="passwords" onClose={() => {}} />
      </LanguageProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'История' }));
    expect(await screen.findByText('Nora: взято для задачи #42.')).toBeInTheDocument();
    expect(screen.getByText('Aide: взято.')).toBeInTheDocument();
    expect(screen.getByText('Maria: изменено.')).toBeInTheDocument();
    expect(screen.getByText('Maria: добавлено.')).toBeInTheDocument();
  });
});
