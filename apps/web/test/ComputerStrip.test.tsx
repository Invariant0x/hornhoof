import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { makeKey } from '../src/owner-key';
import { keyDefaults } from '../src/owner-key-store';
import type { ComputerAccessView } from '../src/types';
import { ComputerStrip } from '../src/ui/ComputerStrip';
import { accessView, mockApi } from './api-mock';

const NOW = new Date(2026, 10, 4, 12, 0);
const UNTIL = new Date(NOW.getTime() + 86_400_000).toISOString();
const open = (machine: string): ComputerAccessView => accessView(machine, { until: UNTIL });
const asks = (machine: string, reason = 'Clean Docker images.'): ComputerAccessView => accessView(machine, { asked: { reason, at: '2026-11-04T10:00:00Z' } });
const closed = (machine: string): ComputerAccessView => accessView(machine);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function strip(machines: ComputerAccessView[]) {
  const onChange = vi.fn();
  const onFailure = vi.fn();
  const view = render(
    <LanguageProvider>
      <ComputerStrip machines={machines} onChange={onChange} onFailure={onFailure} />
    </LanguageProvider>,
  );
  return { onChange, onFailure, ...view };
}

const line = (name: string) => screen.getByRole('region', { name });
const others = (count: number) => screen.getByRole('button', { name: `Other machines with access: ${count}` });

describe('ComputerStrip', () => {
  it('gives two machines one line with a counter, and a line each once it is opened', async () => {
    const user = userEvent.setup();
    strip([open('node-a'), open('node-b')]);
    expect(line('Access to node-a')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Access to node-b' })).not.toBeInTheDocument();
    expect(others(1)).toHaveTextContent('1 more');
    expect(others(1)).toHaveAttribute('aria-expanded', 'false');
    await user.click(others(1));
    expect(others(1)).toHaveAttribute('aria-expanded', 'true');
    expect(within(line('Access to node-a')).getByRole('button', { name: 'Close access' })).toBeInTheDocument();
    expect(within(line('Access to node-b')).getByRole('button', { name: 'Close access' })).toBeInTheDocument();
    await user.click(others(1));
    expect(screen.queryByRole('region', { name: 'Access to node-b' })).not.toBeInTheDocument();
  });

  it('counts every machine past the first', () => {
    strip([open('node-a'), open('node-b'), open('node-c'), open('node-d')]);
    expect(others(3)).toHaveTextContent('3 more');
  });

  it('has no counter for one machine', () => {
    strip([open('node-a')]);
    expect(line('Access to node-a')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Other machines/ })).not.toBeInTheDocument();
  });

  it("sends each line's button to its own machine", async () => {
    const user = userEvent.setup();
    const answered = closed('node-b');
    const calls = mockApi({
      'POST /api/machines/m-node-b/access/close': [200, answered],
      'POST /api/machines/m-node-a/access/open': [200, open('node-a')],
      'POST /api/machines/m-node-a/access/decline': [200, closed('node-a')],
    });
    const { onChange } = strip([asks('node-a'), open('node-b')]);
    await user.click(others(1));
    await user.click(within(line('Access to node-b')).getByRole('button', { name: 'Close access' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(answered));
    await user.click(within(line('The orchestrator asks for access to node-a')).getByRole('button', { name: 'Open for a day' }));
    await user.click(within(line('The orchestrator asks for access to node-a')).getByRole('button', { name: 'Not now' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(3));
    /* A machine that holds no key opens on the server's word: nothing is signed, and nothing asked. */
    expect(calls).toEqual([
      { method: 'POST', path: '/api/machines/m-node-b/access/close', body: undefined },
      { method: 'POST', path: '/api/machines/m-node-a/access/open', body: {} },
      { method: 'POST', path: '/api/machines/m-node-a/access/decline', body: undefined },
    ]);
  });

  it("opens a machine that holds its owner's key with what the owner signs, asking the password once", async () => {
    const user = userEvent.setup();
    /* Their key as the server keeps it, made on another device. */
    const made = mockApi({ 'GET /api/me/key': [200, { key: null }] });
    await makeKey('right');
    const { password: _typed, ...stored } = made.find(call => call.method === 'PUT')!.body as { password: string; publicKey: string };
    void _typed;
    await keyDefaults.store.clear();
    const calls = mockApi({ 'GET /api/me/key': [200, { key: stored }], 'POST /api/machines/m-node-a/access/open': [200, open('node-a')] });
    const { onChange } = strip([{ ...asks('node-a'), key: 'held' }]);
    const asked = line('The orchestrator asks for access to node-a');
    await user.click(within(asked).getByRole('button', { name: 'Open for a day' }));
    await user.type(await within(asked).findByLabelText('Password'), 'right{Enter}');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const sent = calls.find(call => call.method === 'POST')!.body as { grant: { payload: string; signature: string } };
    expect(JSON.parse(sent.grant.payload)).toMatchObject({ v: 1, machine: 'n-node-a' });
    expect(sent.grant.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    /* Whoever leaves the question opens nothing. */
    await keyDefaults.store.clear();
    await user.click(within(asked).getByRole('button', { name: 'Open for a day' }));
    await user.click(await within(asked).findByRole('button', { name: 'Cancel' }));
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('says why its owner cannot open a machine now, in place of that button', () => {
    strip([{ ...asks('node-a'), key: 'not_held' }]);
    const asked = line('The orchestrator asks for access to node-a');
    expect(within(asked).getByText('node-a does not hold your key yet. Run a new command from Connect a machine on it: it takes your key only from there.')).toBeInTheDocument();
    expect(within(asked).queryByRole('button', { name: 'Open for a day' })).not.toBeInTheDocument();
    expect(within(asked).getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('says so when Hornhoof cannot reach the machine', () => {
    strip([{ ...asks('node-a'), reachable: false }]);
    const asked = line('The orchestrator asks for access to node-a');
    expect(within(asked).getByText('Hornhoof cannot reach node-a now.')).toBeInTheDocument();
    expect(within(asked).queryByRole('button', { name: 'Open for a day' })).not.toBeInTheDocument();
  });

  it('tells of a failed answer', async () => {
    const user = userEvent.setup();
    mockApi({ 'POST /api/machines/m-node-a/access/close': [409, { error: { code: 'conflict', message: 'Not now.' } }] });
    const { onChange, onFailure } = strip([open('node-a')]);
    await user.click(screen.getByRole('button', { name: 'Close access' }));
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('puts first the machine that waits for an answer', () => {
    strip([open('node-b'), asks('node-a')]);
    expect(line('The orchestrator asks for access to node-a')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Access to node-b' })).not.toBeInTheDocument();
  });

  it('leaves out a machine with nothing open or asked, and does not count it', () => {
    const over = { ...open('node-c'), until: new Date(Date.now() - 60_000).toISOString() };
    strip([closed('node-b'), open('node-a'), over]);
    expect(line('Access to node-a')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Other machines/ })).not.toBeInTheDocument();
  });

  it('shows nothing when no machine has anything open or asked', () => {
    const { container } = strip([closed('node-a')]);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the explanation behind its button, for the keyboard too', async () => {
    const user = userEvent.setup();
    strip([asks('node-a', 'Restart the nodes.')]);
    const asked = line('The orchestrator asks for access to node-a');
    const more = within(asked).getByRole('button', { name: 'More about access to node-a' });
    expect(within(asked).getByText('Restart the nodes.')).toBeInTheDocument();
    expect(within(asked).queryByText(/as root on node-a/)).not.toBeInTheDocument();
    expect(more).toHaveAttribute('aria-expanded', 'false');
    more.focus();
    await user.keyboard('{Enter}');
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(within(asked).getByText(/as root on node-a/)).toBeInTheDocument();
    expect(within(asked).getAllByText('Restart the nodes.')).toHaveLength(2);
    await user.keyboard(' ');
    expect(within(asked).queryByText(/as root on node-a/)).not.toBeInTheDocument();
  });

  it('explains open access the same way, and says until when in the line', async () => {
    const user = userEvent.setup();
    strip([open('node-a')]);
    const access = line('Access to node-a');
    expect(within(access).getByText(/^access until .+$/)).toBeInTheDocument();
    expect(within(access).queryByText(/is open until/)).not.toBeInTheDocument();
    await user.click(within(access).getByRole('button', { name: 'More about access to node-a' }));
    expect(within(access).getByText(/^Access to node-a is open until .+\.$/)).toBeInTheDocument();
  });

  it('names the server when the machine has no name', () => {
    strip([accessView('the company server', { until: UNTIL, machine: { hostname: '', role: 'data', data: true } })]);
    expect(line("Access to the server's computer")).toBeInTheDocument();
    expect(screen.getByText("The server's computer")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "More about access to the server's computer" })).toBeInTheDocument();
  });

  it('shows who decides in place of the buttons to someone who may not', () => {
    strip([{ ...asks('node-a'), canOpen: false, canClose: false, key: 'held' }, { ...open('node-b'), canOpen: false, canClose: false }, { ...asks('node-c'), canOpen: false }]);
    const asked = line('The orchestrator asks for access to node-a');
    expect(within(asked).getByText("Decided by the machine's owner alone.")).toBeInTheDocument();
    expect(within(asked).queryByRole('button', { name: 'Open for a day' })).not.toBeInTheDocument();
    expect(within(asked).queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument();
  });

  it('gives an open machine no button for someone who may not close it', async () => {
    const user = userEvent.setup();
    strip([{ ...open('node-b'), canOpen: false, canClose: false }, { ...asks('node-c'), canOpen: false }]);
    await user.click(others(1));
    expect(within(line('Access to node-b')).queryByRole('button', { name: 'Close access' })).not.toBeInTheDocument();
    /* The server's own machine with no key is the CEO's and the delegate's. */
    expect(within(line('The orchestrator asks for access to node-c')).getByText('Decided by the CEO or the CEO delegate.')).toBeInTheDocument();
  });

  it('speaks Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      const user = userEvent.setup();
      strip([asks('node-a'), open('node-b')]);
      const asked = line('Оркестратор просит доступ к машине node-a');
      expect(within(asked).getByRole('button', { name: 'Открыть на сутки' })).toBeInTheDocument();
      expect(within(asked).getByRole('button', { name: 'Не сейчас' })).toBeInTheDocument();
      expect(within(asked).getByRole('button', { name: 'Подробнее о доступе к машине node-a' })).toBeInTheDocument();
      const counter = screen.getByRole('button', { name: 'Другие машины с доступом: 1' });
      expect(counter).toHaveTextContent('еще 1');
      await user.click(counter);
      const access = line('Доступ к машине node-b');
      expect(within(access).getByText(/^доступ до .+$/)).toBeInTheDocument();
      expect(within(access).getByRole('button', { name: 'Закрыть доступ' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });
});
