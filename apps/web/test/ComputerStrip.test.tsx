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
    strip([open('a-host'), open('b-host')]);
    expect(line('Access to a-host')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Access to b-host' })).not.toBeInTheDocument();
    expect(others(1)).toHaveTextContent('1 more');
    expect(others(1)).toHaveAttribute('aria-expanded', 'false');
    await user.click(others(1));
    expect(others(1)).toHaveAttribute('aria-expanded', 'true');
    expect(within(line('Access to a-host')).getByRole('button', { name: 'Close access' })).toBeInTheDocument();
    expect(within(line('Access to b-host')).getByRole('button', { name: 'Close access' })).toBeInTheDocument();
    await user.click(others(1));
    expect(screen.queryByRole('region', { name: 'Access to b-host' })).not.toBeInTheDocument();
  });

  it('counts every machine past the first', () => {
    strip([open('a-host'), open('b-host'), open('c-host'), open('d-host')]);
    expect(others(3)).toHaveTextContent('3 more');
  });

  it('has no counter for one machine', () => {
    strip([open('a-host')]);
    expect(line('Access to a-host')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Other machines/ })).not.toBeInTheDocument();
  });

  it("sends each line's button to its own machine", async () => {
    const user = userEvent.setup();
    const answered = closed('b-host');
    const calls = mockApi({
      'POST /api/machines/m-b-host/access/close': [200, answered],
      'POST /api/machines/m-a-host/access/open': [200, open('a-host')],
      'POST /api/machines/m-a-host/access/decline': [200, closed('a-host')],
    });
    const { onChange } = strip([asks('a-host'), open('b-host')]);
    await user.click(others(1));
    await user.click(within(line('Access to b-host')).getByRole('button', { name: 'Close access' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(answered));
    await user.click(within(line('The orchestrator asks for access to a-host')).getByRole('button', { name: 'Open for a day' }));
    await user.click(within(line('The orchestrator asks for access to a-host')).getByRole('button', { name: 'Not now' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(3));
    /* A machine that holds no key opens on the server's word: nothing is signed, and nothing asked. */
    expect(calls).toEqual([
      { method: 'POST', path: '/api/machines/m-b-host/access/close', body: undefined },
      { method: 'POST', path: '/api/machines/m-a-host/access/open', body: {} },
      { method: 'POST', path: '/api/machines/m-a-host/access/decline', body: undefined },
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
    const calls = mockApi({ 'GET /api/me/key': [200, { key: stored }], 'POST /api/machines/m-a-host/access/open': [200, open('a-host')] });
    const { onChange } = strip([{ ...asks('a-host'), key: 'held' }]);
    const asked = line('The orchestrator asks for access to a-host');
    await user.click(within(asked).getByRole('button', { name: 'Open for a day' }));
    await user.type(await within(asked).findByLabelText('Password'), 'right{Enter}');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const sent = calls.find(call => call.method === 'POST')!.body as { grant: { payload: string; signature: string } };
    expect(JSON.parse(sent.grant.payload)).toMatchObject({ v: 1, machine: 'n-a-host' });
    expect(sent.grant.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    /* Whoever leaves the question opens nothing. */
    await keyDefaults.store.clear();
    await user.click(within(asked).getByRole('button', { name: 'Open for a day' }));
    await user.click(await within(asked).findByRole('button', { name: 'Cancel' }));
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('says why its owner cannot open a machine now, in place of that button', () => {
    strip([{ ...asks('a-host'), key: 'not_held' }]);
    const asked = line('The orchestrator asks for access to a-host');
    expect(within(asked).getByText('a-host does not hold your key yet. Run a new command from Connect a machine on it: it takes your key only from there.')).toBeInTheDocument();
    expect(within(asked).queryByRole('button', { name: 'Open for a day' })).not.toBeInTheDocument();
    expect(within(asked).getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('says so when Hornhoof cannot reach the machine', () => {
    strip([{ ...asks('a-host'), reachable: false }]);
    const asked = line('The orchestrator asks for access to a-host');
    expect(within(asked).getByText('Hornhoof cannot reach a-host now.')).toBeInTheDocument();
    expect(within(asked).queryByRole('button', { name: 'Open for a day' })).not.toBeInTheDocument();
  });

  it('tells of a failed answer', async () => {
    const user = userEvent.setup();
    mockApi({ 'POST /api/machines/m-a-host/access/close': [409, { error: { code: 'conflict', message: 'Not now.' } }] });
    const { onChange, onFailure } = strip([open('a-host')]);
    await user.click(screen.getByRole('button', { name: 'Close access' }));
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('puts first the machine that waits for an answer', () => {
    strip([open('b-host'), asks('a-host')]);
    expect(line('The orchestrator asks for access to a-host')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Access to b-host' })).not.toBeInTheDocument();
  });

  it('leaves out a machine with nothing open or asked, and does not count it', () => {
    const over = { ...open('c-host'), until: new Date(Date.now() - 60_000).toISOString() };
    strip([closed('b-host'), open('a-host'), over]);
    expect(line('Access to a-host')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Other machines/ })).not.toBeInTheDocument();
  });

  it('shows nothing when no machine has anything open or asked', () => {
    const { container } = strip([closed('a-host')]);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the explanation behind its button, for the keyboard too', async () => {
    const user = userEvent.setup();
    strip([asks('a-host', 'Restart the nodes.')]);
    const asked = line('The orchestrator asks for access to a-host');
    const more = within(asked).getByRole('button', { name: 'More about access to a-host' });
    expect(within(asked).getByText('Restart the nodes.')).toBeInTheDocument();
    expect(within(asked).queryByText(/as root on a-host/)).not.toBeInTheDocument();
    expect(more).toHaveAttribute('aria-expanded', 'false');
    more.focus();
    await user.keyboard('{Enter}');
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(within(asked).getByText(/as root on a-host/)).toBeInTheDocument();
    expect(within(asked).getAllByText('Restart the nodes.')).toHaveLength(2);
    await user.keyboard(' ');
    expect(within(asked).queryByText(/as root on a-host/)).not.toBeInTheDocument();
  });

  it('explains open access the same way, and says until when in the line', async () => {
    const user = userEvent.setup();
    strip([open('a-host')]);
    const access = line('Access to a-host');
    expect(within(access).getByText(/^access until .+$/)).toBeInTheDocument();
    expect(within(access).queryByText(/is open until/)).not.toBeInTheDocument();
    await user.click(within(access).getByRole('button', { name: 'More about access to a-host' }));
    expect(within(access).getByText(/^Access to a-host is open until .+\.$/)).toBeInTheDocument();
  });

  it('names the server when the machine has no name', () => {
    strip([accessView('the company server', { until: UNTIL, machine: { hostname: '', role: 'data', data: true } })]);
    expect(line("Access to the server's computer")).toBeInTheDocument();
    expect(screen.getByText("The server's computer")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "More about access to the server's computer" })).toBeInTheDocument();
  });

  it('shows who decides in place of the buttons to someone who may not', () => {
    strip([{ ...asks('a-host'), canOpen: false, canClose: false, key: 'held' }, { ...open('b-host'), canOpen: false, canClose: false }, { ...asks('c-host'), canOpen: false }]);
    const asked = line('The orchestrator asks for access to a-host');
    expect(within(asked).getByText("Decided by the machine's owner alone.")).toBeInTheDocument();
    expect(within(asked).queryByRole('button', { name: 'Open for a day' })).not.toBeInTheDocument();
    expect(within(asked).queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument();
  });

  it('gives an open machine no button for someone who may not close it', async () => {
    const user = userEvent.setup();
    strip([{ ...open('b-host'), canOpen: false, canClose: false }, { ...asks('c-host'), canOpen: false }]);
    await user.click(others(1));
    expect(within(line('Access to b-host')).queryByRole('button', { name: 'Close access' })).not.toBeInTheDocument();
    /* The server's own machine with no key is the CEO's and the delegate's. */
    expect(within(line('The orchestrator asks for access to c-host')).getByText('Decided by the CEO or the CEO delegate.')).toBeInTheDocument();
  });

  it('speaks Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      const user = userEvent.setup();
      strip([asks('a-host'), open('b-host')]);
      const asked = line('Оркестратор просит доступ к машине a-host');
      expect(within(asked).getByRole('button', { name: 'Открыть на сутки' })).toBeInTheDocument();
      expect(within(asked).getByRole('button', { name: 'Не сейчас' })).toBeInTheDocument();
      expect(within(asked).getByRole('button', { name: 'Подробнее о доступе к машине a-host' })).toBeInTheDocument();
      const counter = screen.getByRole('button', { name: 'Другие машины с доступом: 1' });
      expect(counter).toHaveTextContent('еще 1');
      await user.click(counter);
      const access = line('Доступ к машине b-host');
      expect(within(access).getByText(/^доступ до .+$/)).toBeInTheDocument();
      expect(within(access).getByRole('button', { name: 'Закрыть доступ' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });
});
