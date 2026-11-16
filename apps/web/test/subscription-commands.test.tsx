import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import { ME, mockApi, SUBS, withKey } from './api-mock';
import { commandCode } from './command-code';

const COMMAND = 'curl -fsSL https://hq.acme.test/install.sh | bash -s -- --join DEMO_ONLY';
const NOW = Date.parse('2026-11-03T10:00:00Z');
const pending = { ...SUBS[2]!, id: 's-new', provider: 'claude' as const, label: 'Claude' };
const shown = () => ({ id: 'a'.repeat(64), kind: 'plans' as const, subscriptionIds: [pending.id], dismissedSubscriptionIds: [] as string[], plans: ['Claude'], machine: null, command: COMMAND, expiresAt: new Date(Date.now() + 21 * 3600_000).toISOString() });
const view = () => render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
const open = async (name = 'Claude') => {
  fireEvent.click(await screen.findByRole('button', { name: `Open the card of ${name}` }));
  return screen.getByRole('article', { name: `${name}, Ivan` });
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers();localStorage.clear(); });

describe('subscription install commands', () => {
  it('keeps the returned plan and command after Done and reload', async () => {
    let commands: ReturnType<typeof shown>[] = [];
    const rows = [pending];
    let sent = false;
    const active = shown();
    mockApi({
      'GET /api/subscriptions': () => sent ? new Promise(() => {}) : [200, { subscriptions: [] }],
      'GET /api/nodes/commands': () => [200, { commands }],
      'POST /api/subscriptions/connect': () => {
        commands = [active]; sent = true;
        return [201, { ...active, subscriptions: rows }];
      },
      [`POST /api/nodes/commands/${active.id}/hide`]: body => {
        expect(body).toEqual({ subscriptionId: pending.id });
        active.dismissedSubscriptionIds = [pending.id];
        return [204];
      },
    });
    const user = userEvent.setup();
    const first = view();
    await user.click(await screen.findByRole('button', { name: 'Connect a subscription' }));
    await user.click(screen.getByRole('checkbox', { name: 'Claude' }));
    await user.click(screen.getByRole('button', { name: 'Show command' }));
    const row = await screen.findByRole('row', { name: 'Claude' });
    expect(within(row).getByText('Waiting for the machine')).toBeInTheDocument();
    const block = screen.getByRole('region', { name: 'Install Claude' });
    expect(await within(block).findByText(commandCode(withKey(COMMAND)))).toBeVisible();
    expect(within(block).getByText('Valid for 21 more hours.')).toBeInTheDocument();
    await user.click(within(block).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region', { name: 'Install Claude' })).not.toBeInTheDocument();
    expect(within(row).getByText('Waiting for the machine')).toBeInTheDocument();
    const card = await open();
    expect(await within(card).findByText(commandCode(withKey(COMMAND)))).toBeVisible();
    for (const copy of within(card).getAllByRole('button', { name: 'Copy' })) expect(copy).toBeVisible();
    expect(within(card).queryByRole('button', { name: /New command|Cancel/ })).not.toBeInTheDocument();
    first.unmount();
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: rows }], 'GET /api/nodes/commands': [200, { commands }] });
    view();
    expect(await within(await open()).findByText(commandCode(withKey(COMMAND)))).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Install Claude' })).not.toBeInTheDocument();
  });

  it('keeps all three row commands while Done hides each top block independently', async () => {
    const rows = ['claude', 'codex', 'kimi'].map((provider, n) => ({ ...pending, id: `s-${n}`, provider: provider as 'claude', label: ['Claude', 'Codex', 'Kimi'][n]! }));
    const commands = rows.map((row, n) => ({ ...shown(), id: String(n).repeat(64), subscriptionIds: [row.id], plans: [row.label], command: `${COMMAND}${n}` }));
    mockApi({
      'GET /api/subscriptions': [200, { subscriptions: rows }],
      'GET /api/nodes/commands': [200, { commands }],
      ...Object.fromEntries(commands.map(cmd => [`POST /api/nodes/commands/${cmd.id}/hide`, () => { cmd.dismissedSubscriptionIds = cmd.subscriptionIds; return [204]; }])),
    });
    const user = userEvent.setup();
    view();
    await screen.findByRole('region', { name: 'Install Kimi' });
    for (const name of ['Claude', 'Codex']) await user.click(within(screen.getByRole('region', { name: `Install ${name}` })).getByRole('button', { name: 'Done' }));
    expect(screen.getAllByRole('region', { name: /^Install / })).toHaveLength(1);
    for (const [i, row] of rows.entries()) expect(await within(await open(row.label)).findByText(commandCode(withKey(`${COMMAND}${i}`)))).toBeVisible();
  });

  it.each([['en', 'Valid for 35 more minutes.'], ['ru', 'Действует еще 35 мин.']])('updates remaining lifetime and allows a new command after expiry in %s', async (language, duration) => {
    localStorage.setItem('hh-lang', language);
    const active = { ...shown(), expiresAt: new Date(Date.now() + 35 * 60_000).toISOString() };
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: [pending] }], 'GET /api/nodes/commands': [200, { commands: [active] }] });
    view();
    fireEvent.click(await screen.findByRole('button', { name: language === 'en' ? 'Open the card of Claude' : 'Открыть карточку Claude' }));
    const card = screen.getByRole('article');
    expect(within(card).getByText(duration)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(36 * 60_000));
    expect(within(card).queryByText(commandCode(withKey(COMMAND)))).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: language === 'en' ? 'New command for Claude' : 'Новая команда для Claude' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Install |^Подключить / })).not.toBeInTheDocument();
  });
});

it('does not let a list request started before Get the command erase its returned plan and block', async () => {
  let release!: (value: [number, unknown]) => void;
  const old = new Promise<[number, unknown]>(resolve => { release = resolve; });
  const command = shown();
  mockApi({
    'GET /api/subscriptions': () => old,
    'GET /api/nodes/commands': [200, { commands: [] }],
    'POST /api/subscriptions/connect': [201, { ...command, subscriptions: [pending] }],
  });
  const user = userEvent.setup();
  view();
  await user.click(screen.getByRole('button', { name: 'Connect a subscription' }));
  await user.click(screen.getByRole('checkbox', { name: 'Claude' }));
  await user.click(screen.getByRole('button', { name: 'Show command' }));
  expect(await screen.findByRole('row', { name: 'Claude' })).toBeInTheDocument();
  await act(async () => { release([200, { subscriptions: [] }]); });
  expect(screen.getByRole('row', { name: 'Claude' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Install Claude' })).toBeVisible();
});

it('keeps the subscription list usable and reports a failed command lookup without offering a duplicate', async () => {
  mockApi({ 'GET /api/subscriptions': [200, { subscriptions: [pending] }], 'GET /api/nodes/commands': [500, { error: { code: 'internal', message: 'Command lookup failed.' } }] });
  view();
  expect(await screen.findByRole('alert')).toHaveTextContent('Command lookup failed.');
  const card = await open();
  expect(within(card).queryByRole('button', { name: /New command/ })).not.toBeInTheDocument();
});
