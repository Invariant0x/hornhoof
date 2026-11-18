import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { AcceptInvite } from '../src/screens/AcceptInvite';
import { Login } from '../src/screens/Login';
import { People } from '../src/screens/People';
import { NewAssistant } from '../src/screens/PeopleAssistant';
import { RestoreFromFile } from '../src/screens/RestoreFromFile';
import { Settings } from '../src/screens/Settings';
import { Setup } from '../src/screens/Setup';
import { ApiForm } from '../src/ui/ApiForm';
import { HideSecret } from '../src/ui/HideSecret';
import { KeyForm } from '../src/ui/KeyForm';
import { PasswordPrompt } from '../src/ui/PasswordPrompt';
import { Phones } from '../src/ui/Phones';
import { Repositories, RepoSettings } from '../src/ui/RepoSettings';
import { TelegramBot } from '../src/ui/TelegramBot';
import { ME, mockApi, ORG, PEOPLE, SUBS } from './api-mock';

/* Hornhoof's own sign-in is filled only where a person signs in or sets their Hornhoof password: Login, AcceptInvite, Setup
   and PasswordPrompt (#1320). Every other form with a secret has no password field and no field open to a saved login, and
   carries the marks by which password managers leave a field alone. A secret stays masked on screen. */

const INVITE = { companyName: 'Acme', name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', access: { whole: true, departments: [], teams: [] } };
const MARKS = { 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' };
const FIELDS = 'input:not([type=checkbox], [type=radio], [type=file], [type=hidden])';

const marksOf = (input: Element) => Object.fromEntries(Object.keys(MARKS).map(mark => [mark, input.getAttribute(mark)]));
const describe_ = (input: Element) => input.getAttribute('aria-label') ?? (input as HTMLInputElement).labels?.[0]?.textContent ?? input.outerHTML;

/* A key, token or password for somewhere else: a text field nothing fills, masked on screen. */
function masked(input: HTMLElement) {
  expect(input).toHaveAttribute('type', 'text');
  expect(input).toHaveAttribute('autocomplete', 'off');
  expect(input).toHaveAttribute('spellcheck', 'false');
  expect(input).toHaveClass('secret-masked');
  expect(marksOf(input)).toEqual(MARKS);
}

/* A form with secrets: no password field, every field closed to a saved login and marked, and only its secrets masked. */
function noLogin(form: HTMLElement, secrets: HTMLElement[]) {
  expect(form.querySelector('input[type=password]')).toBeNull();
  const fields = [...form.querySelectorAll<HTMLInputElement>(FIELDS)];
  expect(fields).toEqual(expect.arrayContaining(secrets));
  for (const field of fields) {
    expect(['off', 'one-time-code'], `${describe_(field)} takes no saved login`).toContain(field.getAttribute('autocomplete'));
    expect(marksOf(field), `${describe_(field)} carries the ignore marks`).toEqual(MARKS);
    if (secrets.includes(field)) masked(field);
    else expect(field, `${describe_(field)} is no secret`).not.toHaveClass('secret-masked');
  }
}

/* A code typed where no login belongs, shown as typed. */
function quiet(input: HTMLElement) {
  expect((input as HTMLInputElement).type).toBe('text');
  expect(input).toHaveAttribute('autocomplete', 'off');
  expect(input).not.toHaveClass('secret-masked');
  expect(marksOf(input)).toEqual(MARKS);
}

/* A form with no secret of its own that still asks for no login. */
function offersNoLogin(form: HTMLElement) {
  expect(form.querySelector('input[type=password]')).toBeNull();
  for (const field of form.querySelectorAll(FIELDS)) {
    expect(['username', 'email', 'current-password', 'new-password'], describe_(field)).not.toContain(field.getAttribute('autocomplete'));
  }
}

const formOf = (element: HTMLElement) => element.closest('form')!;

describe('the four places a person signs in or sets their Hornhoof password', () => {
  it('Login offers the email as the username with the current password', () => {
    render(<Login onDone={() => {}} />);
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('an invite sets the new password for the email it was sent to', async () => {
    mockApi({ 'GET /api/invites/tok1': [200, INVITE] });
    render(<AcceptInvite token="tok1" onDone={() => {}} />);
    const password = await screen.findByLabelText('Choose a password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'new-password');
    const username = formOf(password).querySelector('input[autocomplete=username]');
    expect(username).toHaveAttribute('type', 'email');
    expect(username).toHaveValue(INVITE.email);
    expect(username).toHaveAttribute('hidden');
  });

  it('Setup makes the first account with the email as the username and a new password', async () => {
    window.history.replaceState(null, '', '/setup?code=LINK-CODE-123');
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('the password prompt asks for the current Hornhoof password', () => {
    render(<PasswordPrompt purpose="unlock" onPassword={async () => true} onCancel={() => {}} />);
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });
});

describe('forms with a secret for somewhere else', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'));

  it('Add phone takes the pairing code as six digits a phone gives once, and its address as no login', async () => {
    mockApi({ 'GET /api/phones': [200, { phones: [] }] });
    const user = userEvent.setup();
    render(<Phones me={ME} machines={[{ id: 'm1', hostname: 'Work computer', online: true }]} />);
    await user.click(screen.getByRole('button', { name: en.phones.add }));
    const code = screen.getByLabelText(en.phones.pairingCode);
    expect(code).toHaveAttribute('type', 'text');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByLabelText(en.phones.pairingAddress)).toHaveAttribute('autocomplete', 'off');
    noLogin(screen.getByRole('form', { name: en.phones.add }), []);
  });

  it("a vault entry masks the site's password and code key, and its login is no Hornhoof login", async () => {
    mockApi({ 'GET /api/vault': [200, { entries: [] }] });
    const user = userEvent.setup();
    render(<Settings me={ME} group="passwords" onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: en.vault.add }));
    noLogin(screen.getByRole('form', { name: en.vault.addTitle }), [screen.getByLabelText(en.vault.password), screen.getByLabelText(en.vault.code)]);
  });

  it("a plan's key is masked text", () => {
    const kimi = SUBS.find(sub => sub.provider === 'kimi')! as (typeof SUBS)[number] & { provider: 'kimi' };
    render(<KeyForm sub={kimi} onDone={() => {}} onCancel={() => {}} />);
    const key = screen.getByLabelText('Kimi key');
    noLogin(formOf(key), [key]);
  });

  it('an API key is masked text, also while it is shown', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const user = userEvent.setup();
    render(<ApiForm onSaved={() => {}} onCancel={() => {}} />);
    await user.selectOptions(screen.getByLabelText(en.subs.apiService), 'custom_api');
    const key = screen.getByLabelText(en.subs.apiKey);
    noLogin(screen.getByRole('form', { name: en.subs.connectApi }), [key]);
    await user.click(screen.getByRole('button', { name: en.subs.showTypedKey.label }));
    expect(key).toHaveAttribute('type', 'text');
    expect(key).not.toHaveClass('secret-masked');
  });

  it("the company's GitHub key is masked text beside an owner that is no login", async () => {
    mockApi({ 'GET /api/repo-host': [200, { host: null }], 'GET /api/google-sheets': [200, { google: null }] });
    const user = userEvent.setup();
    render(<Settings me={ME} group="integrations" onClose={() => {}} />);
    const part = await screen.findByRole('article', { name: en.repoHost.title });
    await user.click(within(part).getByRole('button', { name: en.repoHost.save }));
    noLogin(formOf(within(part).getByLabelText(en.repoHost.key)), [within(part).getByLabelText(en.repoHost.key)]);
  });

  it('the Google key and the email it shares with ask for no login', async () => {
    mockApi({ 'GET /api/repo-host': [200, { host: null }], 'GET /api/google-sheets': [200, { google: null }] });
    const user = userEvent.setup();
    render(<Settings me={ME} group="integrations" onClose={() => {}} />);
    const part = await screen.findByRole('article', { name: en.googleSheets.title });
    await user.click(within(part).getByRole('button', { name: en.googleSheets.connect }));
    const form = formOf(within(part).getByLabelText(en.googleSheets.keyLabel));
    expect(within(part).getByLabelText(en.googleSheets.keyLabel).tagName).toBe('TEXTAREA');
    noLogin(form, []);
  });

  it("a repository's token is masked text, when it changes and when it is added", async () => {
    mockApi({});
    const user = userEvent.setup();
    const view = render(<RepoSettings placeId="d2" repository={{ url: 'https://github.com/acme/app.git', branch: 'main', tokenLast4: '1234', fullTestCommand: null }} />);
    await user.click(screen.getByRole('button', { name: en.dept.change }));
    noLogin(formOf(screen.getByLabelText(en.dept.token)), [screen.getByLabelText(en.dept.token)]);
    view.unmount();
    render(<Repositories department={{ id: 'd2', repository: { url: 'https://github.com/acme/app.git', branch: 'main', tokenLast4: '1234' }, products: [], repoHost: null }} />);
    await user.click(screen.getByRole('button', { name: en.dept.addRepository }));
    const form = screen.getByRole('form', { name: en.dept.addRepository });
    noLogin(form, [within(form).getByLabelText(en.dept.token)]);
  });

  it("a Telegram bot's token is masked text", () => {
    render(<TelegramBot agentId="a1" telegram={null} editable onChange={() => {}} />);
    const token = screen.getByLabelText(en.agent.telegramToken);
    noLogin(formOf(token), [token]);
  });

  it('a secret hidden in a task is masked text', async () => {
    const user = userEvent.setup();
    render(<HideSecret taskId="t1" onChanged={() => {}} />);
    await user.click(screen.getByRole('button', { name: en.tasks.hideSecret.action }));
    noLogin(screen.getByRole('form', { name: en.tasks.hideSecret.action }), [screen.getByLabelText(en.tasks.hideSecret.value)]);
  });

  it("an invite asks for someone else's email, never the person's own login", async () => {
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG] });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: en.people.invitePerson }));
    noLogin(formOf(screen.getByLabelText(en.common.email)), []);
  });

  it("an assistant's form asks for no login", () => {
    render(<NewAssistant me={ME} people={PEOPLE} own heading="New assistant" initial={{ name: '', title: '' }} onMade={() => {}} onClose={() => {}} />);
    offersNoLogin(formOf(screen.getByLabelText(en.people.assistantName)));
  });

  it("the restore's code and the setup code are no login, and the orchestrator's key is masked text", async () => {
    const restore = render(<RestoreFromFile code="" onBack={() => {}} />);
    quiet(screen.getByLabelText(en.setup.code));
    restore.unmount();
    window.history.replaceState(null, '', '/setup');
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    quiet(screen.getByLabelText(en.setup.code));
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    await user.type(screen.getByLabelText(en.setup.code), 'LINK-CODE-123');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Your name'), 'Ivan');
    await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('radio', { name: 'API key' }));
    const key = screen.getByLabelText('Key');
    noLogin(formOf(key), [key]);
  });
});
