import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { SubView } from '../src/types';
import { ME, MACHINE, mockApi, SUBS, withKey } from './api-mock';
import { decl } from './css';
import { fakeStream } from './fake-stream';
import { commandCode } from './command-code';

vi.mock('../src/ui/AgentTerminal', () => ({
  AgentTerminal: ({ path }: { path: string }) => <div data-testid="live-terminal" data-path={path} />,
}));

const COMMAND = 'curl -fsSL https://hq.acme.test/install.sh | bash -s -- --join DEMO_ONLY';
const NODE = '7d1c6a52-2f4e-4c4b-9f55-0d7a3c1e9b10';
const OFFLINE = { ...MACHINE, status: 'needs_login' as const, online: false };
const WAITS = { ...MACHINE, status: 'needs_login' as const };

const plan = (provider: SubView['provider'], status: SubView['status'], machines: SubView['machines'] = []): SubView =>
  ({ ...SUBS[2]!, id: `s-${provider}`, provider, label: provider, status, online: machines.some(m => m.online), machines });
const shown = (sub: SubView) => ({ id: 'a'.repeat(64), kind: 'plans' as const, subscriptionIds: [sub.id], dismissedSubscriptionIds: [] as string[], plans: [sub.label], machine: null, command: COMMAND, expiresAt: '2099-01-01T00:00:00.000Z' });

function view(subs: SubView[], { commands = [] as unknown[], language = 'en', extra = {} } = {}) {
  localStorage.setItem('hh-lang', language);
  mockApi({ 'GET /api/subscriptions': [200, { subscriptions: subs }], 'GET /api/nodes/commands': [200, { commands }], ...extra });
  render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
}

const card = async (name: string) => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^(Open the card of|Открыть карточку) ${name}$`) }));
  return screen.getByRole('article', { name: `${name}, Ivan` });
};

/* What each step says, the passed ones with their hidden mark, and which one is current. */
const read = (list: HTMLElement) => {
  const items = within(list).getAllByRole('listitem');
  return { texts: items.map(li => [...li.children].filter(child => child.matches('span, p')).map(child => child.textContent).join('')), current: items.findIndex(li => li.getAttribute('aria-current') === 'step') };
};

afterEach(() => localStorage.clear());

const EN = {
  label: 'Steps to connect Claude',
  steps: ['Run the command on your computer', 'Your computer connects (10 to 20 minutes the first time)', 'Sign in to Claude', 'Ready: agents on this plan can work'],
  run: 'Copy the command below, paste it into Terminal on a Mac or Linux or into PowerShell on Windows, and press Enter. This page moves on by itself once your computer connects.',
  done: ' (done)',
};
const RU = {
  label: 'Как подключить Claude',
  steps: ['Запустите команду на своей машине', 'Машина подключается (в первый раз от 10 до 20 минут)', 'Войдите в Claude', 'Готово: агенты на этом тарифе могут работать'],
  run: 'Скопируйте команду ниже, вставьте ее в Терминал на Mac или Linux или в PowerShell на Windows и нажмите Enter. Страница сама перейдет дальше, когда машина подключится.',
  done: ' (сделано)',
};

describe('the steps to connect a personal plan', () => {
  it.each([['en', EN], ['ru', RU]])('shows the owner of a plan waiting for its machine all four steps, the first one current with what to do, in %s', async (language, words) => {
    const waiting = plan('claude', 'waiting_machine');
    view([waiting], { commands: [shown(waiting)], language });
    const list = within(await card('Claude')).getByRole('list', { name: words.label });
    await within(list).findByText(words.run);
    expect(read(list)).toEqual({ texts: [words.steps[0] + words.run, ...words.steps.slice(1)], current: 0 });
  });

  it.each(['claude', 'codex', 'antigravity'] as const)('asks for the password in step 1 before showing the %s command', async provider => {
    const waiting = plan(provider, 'waiting_machine');
    view([waiting], { commands: [shown(waiting)], extra: { 'GET /api/me/key': [200, { key: null }] } });
    const block = await screen.findByRole('region', { name: /^Install / });
    const step = within(block).getAllByRole('listitem')[0]!;
    const password = await within(block).findByLabelText('Password');
    expect(within(block).queryByText(EN.run)).not.toBeInTheDocument();
    expect(within(step).getByText('Enter your Hornhoof password to get the command.')).toBeVisible();
    expect(step).toContainElement(password);
    expect(block.querySelector('code')).toBeNull();
    expect(password.compareDocumentPosition(within(block).getByText(/^Run this in a terminal/))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const user = userEvent.setup();
    await user.type(password, 'test password');
    await user.click(within(block).getByRole('button', { name: 'Next' }));
    await within(step).findByText(EN.run);
    expect(within(step).queryByLabelText('Password')).not.toBeInTheDocument();
    expect(step.querySelector('code')).toHaveTextContent('--owner-key');
  });

  it('offers a password in each card sharing a command and unlocks every card from either prompt', async () => {
    const claude = plan('claude', 'waiting_machine');
    const codex = plan('codex', 'waiting_machine');
    const command = { ...shown(claude), subscriptionIds: [claude.id, codex.id], plans: [claude.label, codex.label] };
    view([claude, codex], { commands: [command], extra: { 'GET /api/me/key': [200, { key: null }] } });
    const first = within(await screen.findByRole('region', { name: 'Install Claude' }));
    const second = within(await screen.findByRole('region', { name: 'Install Codex' }));
    await screen.findAllByLabelText('Password');
    for (const block of [first, second]) {
      const step = within(block.getAllByRole('listitem')[0]!);
      expect(step.getByLabelText('Password')).toBeVisible();
      expect(step.getByText('Enter your Hornhoof password to get the command.')).toBeVisible();
    }

    const user = userEvent.setup();
    await user.click(first.getByRole('button', { name: 'Cancel' }));
    expect(first.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(second.getByLabelText('Password')).toBeVisible();
    await user.click(first.getByRole('button', { name: 'Enter password' }));
    await first.findByLabelText('Password');
    await user.type(second.getByLabelText('Password'), 'test password');
    await user.click(second.getByRole('button', { name: 'Next' }));
    for (const block of [first, second]) {
      await block.findByText(EN.run);
      expect(block.queryByLabelText('Password')).not.toBeInTheDocument();
      expect(block.getAllByRole('code')[0]).toHaveTextContent(`${COMMAND} --owner-key`);
    }
    expect(first.getAllByRole('code')[0]?.textContent).toBe(second.getAllByRole('code')[0]?.textContent);
  });

  it('shows the same steps in the install block shown right after a plan is added', async () => {
    const waiting = plan('claude', 'waiting_machine');
    view([waiting], { commands: [shown(waiting)] });
    const block = await screen.findByRole('region', { name: 'Install Claude' });
    expect(read(within(block).getByRole('list', { name: EN.label })).current).toBe(0);
    /* The command comes with the key this browser made for its owner, a moment after the block. */
    expect(await within(block).findByText(commandCode(withKey(COMMAND)))).toBeVisible();
  });

  it('asks for a new command when the plan has none that still works', async () => {
    view([plan('claude', 'waiting_machine')]);
    const box = await card('Claude');
    expect(within(box).getByRole('button', { name: 'New command for Claude' })).toBeInTheDocument();
    expect(read(within(box).getByRole('list', { name: EN.label })).texts[0]).toBe(`${EN.steps[0]}Press "Make a new command" below, then run the new command on your computer.`);
  });

  it.each([['en', EN, 'Hornhoof is starting on your computer. Keep it on and connected to the internet; this page moves on by itself.'], ['ru', RU, 'На машине запускается Hornhoof. Не выключайте ее и не отключайте интернет, страница сама перейдет дальше.']])(
    'ticks the command and waits for the computer once it joined but is not online yet, in %s', async (language, words, connect) => {
      view([plan('claude', 'needs_login', [OFFLINE])], { language });
      const list = within(await card('Claude')).getByRole('list', { name: words.label });
      expect(read(list)).toEqual({ texts: [words.steps[0] + words.done, words.steps[1] + connect, words.steps[2], words.steps[3]], current: 1 });
    });

  it.each([
    ['en', EN, 'Press "Sign in" below, open the link, sign in to Claude, copy the code, paste it into the terminal with Ctrl+V or Cmd+V and press Enter. Do it here or in the install window, not in both.',
      'In the terminal below, open the link, sign in to Claude, copy the code, paste it into the terminal with Ctrl+V or Cmd+V and press Enter. Do it here or in the install window, not in both.', 'Sign in to Claude'],
    ['ru', RU, 'Нажмите «Войти» ниже, откройте ссылку, войдите в Claude, скопируйте код, вставьте его в терминал через Ctrl+V или Cmd+V и нажмите Enter. Делайте это здесь или в окне установки, но не в обоих местах.',
      'В терминале ниже откройте ссылку, войдите в Claude, скопируйте код, вставьте его в терминал через Ctrl+V или Cmd+V и нажмите Enter. Делайте это здесь или в окне установки, но не в обоих местах.', 'Войти в Claude'],
  ])('leads the owner through the sign-in on an online computer, and into the terminal once it opens, in %s', async (language, words, press, terminal, button) => {
    fakeStream();
    view([plan('claude', 'needs_login', [WAITS])], { language, extra: { 'POST /api/subscriptions/s-claude/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }] } });
    const box = await card('Claude');
    const list = within(box).getByRole('list', { name: words.label });
    expect(read(list)).toEqual({ texts: [words.steps[0] + words.done, words.steps[1] + words.done, words.steps[2] + press, words.steps[3]], current: 2 });
    await userEvent.click(within(box).getByRole('button', { name: button }));
    await screen.findByTestId('live-terminal');
    expect(read(within(box).getByRole('list', { name: words.label })).texts[2]).toBe(words.steps[2] + terminal);
  });

  it.each([
    ['a key', plan('kimi', 'needs_login', [WAITS]), 'Kimi', 'Paste your Kimi key', 'Press "Paste the key" below and paste your Kimi key there.'],
    ['the install window', plan('antigravity', 'needs_login', [WAITS]), 'Antigravity', 'Sign in to Antigravity', 'Sign in to Antigravity in the install window on dev-laptop.'],
    ["its program's terms", plan('codex', 'needs_setup', [{ ...MACHINE, status: 'needs_setup' }]), 'Codex', 'Sign in to Codex', 'Codex on dev-laptop asks you to accept its terms: run the install command on that computer again and accept them.'],
  ])('says how a plan signs in with %s', async (_, sub, name, step, now) => {
    view([sub]);
    const list = within(await card(name)).getByRole('list', { name: `Steps to connect ${name}` });
    expect(read(list)).toEqual({ texts: [EN.steps[0] + EN.done, EN.steps[1] + EN.done, step + now, EN.steps[3]], current: 2 });
  });

  it("shows no steps on a ready plan, a key that needs no computer, or another person's plan", async () => {
    const olegs = { ...plan('codex', 'waiting_machine'), owner: { id: 'p4', name: 'Oleg' } };
    view([SUBS[0]!, SUBS[3]!, olegs]);
    await screen.findByRole('table');
    for (const button of screen.getAllByRole('button', { name: /^Open the card of / })) fireEvent.click(button);
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByRole('list', { name: /^Steps to connect / })).not.toBeInTheDocument();
  });

  it('draws the steps as a list that wraps on a phone, with the current one filled in the theme colours', () => {
    expect(decl('.plan-steps', 'list-style')).toBe('none');
    expect(decl('.plan-steps li', 'overflow-wrap')).toBe('anywhere');
    expect(decl('.plan-steps li', 'padding-inline-start')).toBeDefined();
    expect(decl('.plan-steps li.now::before', 'background')).toBe('var(--btn)');
    expect(decl('.plan-steps li.now::before', 'color')).toBe('var(--on-btn)');
    expect(decl('.plan-steps li.done::before', 'color')).toBe('var(--ok)');
    expect(decl('.plan-steps li', 'color')).toBe('var(--muted)');
  });
});
