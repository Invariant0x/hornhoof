import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, onTestFinished } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { CommandBox } from '../src/ui/CommandBox';
import { keyDefaults } from '../src/owner-key-store';
import { mockApi, TEST_KEY } from './api-mock';
import { commandCode } from './command-code';

const JOIN = 'curl -fsSL https://corp.hornhoof.test/install.sh | bash -s -- --join abc';
const NO_KEY = { 'GET /api/me/key': [200, { key: null }] as [number, unknown] };
const WRONG = [401, { error: { code: 'unauthorized', message: 'Wrong email or password.', reason: 'wrong_password' } }] as [number, unknown];
const show = (command = JOIN, password?: string) => render(<LanguageProvider><CommandBox command={command} password={password} /></LanguageProvider>);
const commandShown = () => document.querySelector('code')?.textContent ?? null;

describe('a join command and the key of who looks at it', () => {
  it("shows the command with the viewer's key, and asks nothing when they have one", async () => {
    mockApi({});
    show();
    expect(await screen.findByText(commandCode(`${JOIN} --owner-key ${TEST_KEY.publicKey}`))).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByText(/Connecting this machine lets the orchestrator run commands with full permissions/)).toBeInTheDocument();
  });

  it('shows any other command as it is, and asks the server nothing', () => {
    const calls = mockApi({});
    const update = 'curl -fsSL https://corp.hornhoof.test/install.sh | bash';
    show(update);
    expect(commandShown()).toBe(update);
    expect(calls).toEqual([]);
  });

  it('asks for the password to make the key, and never shows the command without it', async () => {
    let puts = 0;
    const calls = mockApi({ ...NO_KEY, 'PUT /api/me/key': body => (++puts, (body as { password: string }).password === 'right' ? [204] : WRONG) });
    show();
    expect(await screen.findByText(/Hornhoof makes your own key now, once\./)).toBeInTheDocument();
    expect(commandShown()).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Wrong password.')).toBeInTheDocument();
    expect(commandShown()).toBeNull();
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'right{Enter}');
    await expect.poll(() => commandShown()).toMatch(/ --owner-key [A-Za-z0-9_-]{122}$/);
    expect(puts).toBe(2);
    const sent = calls.filter(call => call.method === 'PUT').at(-1)!.body as { publicKey: string };
    expect(commandShown()).toBe(`${JOIN} --owner-key ${sent.publicKey}`);
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('says why the command is not there after Cancel, and asks again on request', async () => {
    mockApi(NO_KEY);
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('This command carries your key, so it shows once you enter your password.')).toBeInTheDocument();
    expect(commandShown()).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Enter password' }));
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(commandShown()).toBeNull();
  });

  /* A browser makes keys only on https and on localhost. A company opened by its address on the local network still
     connects its machines. */
  it('shows the command without a key, and says so, where the browser can make none', async () => {
    const { subtle } = keyDefaults;
    onTestFinished(() => void (keyDefaults.subtle = subtle));
    keyDefaults.subtle = undefined as unknown as SubtleCrypto;
    const calls = mockApi(NO_KEY);
    show(JOIN, 'typed at setup');
    expect(await screen.findByText(/This page opened without HTTPS/)).toBeInTheDocument();
    expect(commandShown()).toBe(JOIN);
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(calls.some(call => call.method === 'PUT')).toBe(false);
  });

  it('carries the key the person has already, also where the browser can make none', async () => {
    const { subtle } = keyDefaults;
    onTestFinished(() => void (keyDefaults.subtle = subtle));
    keyDefaults.subtle = undefined as unknown as SubtleCrypto;
    mockApi({});
    show();
    expect(await screen.findByText(commandCode(`${JOIN} --owner-key ${TEST_KEY.publicKey}`))).toBeInTheDocument();
    expect(screen.queryByText(/This page opened without HTTPS/)).not.toBeInTheDocument();
  });

  it('makes the key with the password the screen holds, and asks nothing', async () => {
    const calls = mockApi(NO_KEY);
    show(JOIN, 'typed at setup');
    await expect.poll(() => commandShown()).toMatch(/ --owner-key [A-Za-z0-9_-]{122}$/);
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect((calls.find(call => call.method === 'PUT')!.body as { password: string }).password).toBe('typed at setup');
  });

  it('asks once for two commands on one page', async () => {
    mockApi({ ...NO_KEY, 'PUT /api/me/key': [204] });
    render(<LanguageProvider><CommandBox command={JOIN} /><CommandBox command={`${JOIN}2`} /></LanguageProvider>);
    expect(await screen.findAllByLabelText('Password')).toHaveLength(1);
    expect(screen.getByText('Making your key')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Password'), 'right{Enter}');
    /* Each command shows for a Mac or Linux and for Windows, all four with the one key. */
    await expect.poll(() => document.querySelectorAll('code').length).toBe(4);
    const keys = [...document.querySelectorAll('code')].map(code => code.textContent!.split(' --owner-key ')[1]!.replace(/"$/, ''));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{80,200}$/);
  });

  it('says the same in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi(NO_KEY);
    show();
    expect(await screen.findByText(/Hornhoof сейчас один раз создаст ваш личный ключ\./)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(await screen.findByText('Эта команда содержит ваш ключ, поэтому она появится, когда вы введете пароль.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ввести пароль' })).toBeInTheDocument();
  });
});
