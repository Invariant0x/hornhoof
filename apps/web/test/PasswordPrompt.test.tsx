import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, onTestFinished } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { makeKey, type Grant } from '../src/owner-key';
import { CommandBox } from '../src/ui/CommandBox';
import { useOwnerKey } from '../src/ui/PasswordPrompt';
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
    expect(await screen.findByText(/This page is open at an address without https/)).toBeInTheDocument();
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
    expect(screen.queryByText(/This page is open at an address without https/)).not.toBeInTheDocument();
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

/* A screen that opens a machine: it asks for a grant and shows the prompt where the button was. */
function Signer({ onGrant }: { onGrant(grant: Grant | null): void }) {
  const { sign, prompt } = useOwnerKey();
  return prompt ?? <button type="button" onClick={() => void sign('a'.repeat(64)).then(onGrant)}>Open</button>;
}

describe("signing with the person's key on a device", () => {
  /* The key as the server keeps it, made by another device of theirs with this password. */
  async function serverHolds(password: string) {
    const calls = mockApi({ 'GET /api/me/key': [200, { key: null }] });
    await makeKey(password);
    const sent = calls.find(call => call.method === 'PUT')!.body as { publicKey: string; wrapped: string; salt: string; iv: string; iterations: number };
    await keyDefaults.store.clear();
    mockApi({ 'GET /api/me/key': [200, { key: { publicKey: sent.publicKey, wrapped: sent.wrapped, salt: sent.salt, iv: sent.iv, iterations: sent.iterations } }] });
  }
  const show = (language?: 'ru') => {
    const grants: (Grant | null)[] = [];
    if (language) localStorage.setItem('hh-lang', language);
    render(<LanguageProvider><Signer onGrant={grant => grants.push(grant)} /></LanguageProvider>);
    return grants;
  };

  it('asks for the password once per device', async () => {
    await serverHolds('right');
    const grants = show();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('Enter your password once on this device to sign with your key.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'wrong{Enter}');
    expect(await screen.findByText('Wrong password.')).toBeInTheDocument();
    expect(grants).toEqual([]);
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'right{Enter}');
    await expect.poll(() => grants.length).toBe(1);
    expect(JSON.parse(grants[0]!.payload)).toMatchObject({ v: 1, machine: 'a'.repeat(64) });
    const { until, at } = JSON.parse(grants[0]!.payload) as { until: number; at: number };
    expect(until - at).toBe(24 * 3600);
    /* The second opening on this device is one click. */
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    await expect.poll(() => grants.length).toBe(2);
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('gives no grant when the person leaves the question, or has no key', async () => {
    await serverHolds('right');
    const grants = show();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect.poll(() => grants).toEqual([null]);
    mockApi({ 'GET /api/me/key': [200, { key: null }] });
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    await expect.poll(() => grants).toEqual([null, null]);
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('asks the same in Russian', async () => {
    await serverHolds('right');
    show('ru');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('Введите пароль один раз на этом устройстве, чтобы подписывать своим ключом.')).toBeInTheDocument();
  });
});
