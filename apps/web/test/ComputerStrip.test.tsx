import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { ComputerView } from '../src/types';
import { ComputerStrip } from '../src/ui/ComputerStrip';
import { mockApi } from './api-mock';

const NOW = new Date(2026, 10, 4, 12, 0);
const UNTIL = new Date(NOW.getTime() + 86_400_000).toISOString();
const open = (machine: string): ComputerView => ({ available: true, until: UNTIL, asked: null, machine, canAnswer: true });
const asks = (machine: string, reason = 'Clean Docker images.'): ComputerView => ({ available: true, until: null, asked: { reason, at: '2026-11-04T10:00:00Z' }, machine, canAnswer: true });
const closed = (machine: string): ComputerView => ({ available: true, until: null, asked: null, machine, canAnswer: true });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

type Answer = (action: 'open' | 'close' | 'decline', machine: string | null | undefined) => Promise<ComputerView>;

function strip(machines: ComputerView[], answer?: Answer) {
  const onChange = vi.fn();
  const onFailure = vi.fn();
  const view = render(
    <LanguageProvider>
      <ComputerStrip machines={machines} onChange={onChange} onFailure={onFailure} answer={answer} />
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

  it("gives each line's button its own machine", async () => {
    const user = userEvent.setup();
    const answer = vi.fn<Answer>(() => Promise.resolve(closed('x')));
    const { onChange } = strip([asks('a-host'), open('b-host')], answer);
    await user.click(others(1));
    await user.click(within(line('Access to b-host')).getByRole('button', { name: 'Close access' }));
    expect(answer).toHaveBeenLastCalledWith('close', 'b-host');
    await user.click(within(line('The orchestrator asks for access to a-host')).getByRole('button', { name: 'Open for a day' }));
    expect(answer).toHaveBeenLastCalledWith('open', 'a-host');
    await user.click(within(line('The orchestrator asks for access to a-host')).getByRole('button', { name: 'Not now' }));
    expect(answer).toHaveBeenLastCalledWith('decline', 'a-host');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('answers the old way, without the machine, while the server keeps one', async () => {
    const user = userEvent.setup();
    const answered = closed('b-host');
    const calls = mockApi({ 'POST /api/computer/close': [200, answered], 'POST /api/computer/open': [200, answered], 'POST /api/computer/decline': [200, answered] });
    const { onChange } = strip([asks('a-host'), open('b-host')]);
    await user.click(others(1));
    await user.click(within(line('Access to b-host')).getByRole('button', { name: 'Close access' }));
    await user.click(within(line('The orchestrator asks for access to a-host')).getByRole('button', { name: 'Open for a day' }));
    await user.click(within(line('The orchestrator asks for access to a-host')).getByRole('button', { name: 'Not now' }));
    expect(calls).toEqual([
      { method: 'POST', path: '/api/computer/close', body: undefined },
      { method: 'POST', path: '/api/computer/open', body: undefined },
      { method: 'POST', path: '/api/computer/decline', body: undefined },
    ]);
    expect(onChange).toHaveBeenLastCalledWith(answered);
  });

  it('tells of a failed answer', async () => {
    const user = userEvent.setup();
    const failure = new Error('Not now.');
    const { onChange, onFailure } = strip([open('a-host')], () => Promise.reject(failure));
    await user.click(screen.getByRole('button', { name: 'Close access' }));
    expect(onFailure).toHaveBeenCalledWith(failure);
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
    expect(within(access).queryByText(/can run commands on a-host/)).not.toBeInTheDocument();
    await user.click(within(access).getByRole('button', { name: 'More about access to a-host' }));
    expect(within(access).getByText(/^The orchestrator can run commands on a-host until .+\. The company server runs there, so this shows wherever you open Hornhoof\.$/)).toBeInTheDocument();
  });

  it('names the server when the machine has no name', () => {
    strip([{ available: true, until: UNTIL, asked: null, canAnswer: true }]);
    expect(line("Access to the server's computer")).toBeInTheDocument();
    expect(screen.getByText("The server's computer")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "More about access to the server's computer" })).toBeInTheDocument();
  });

  it('shows who decides in place of the buttons to someone who may not', () => {
    strip([{ ...asks('a-host'), canAnswer: false }, { ...open('b-host'), canAnswer: false }]);
    const asked = line('The orchestrator asks for access to a-host');
    expect(within(asked).getByText('Decided by the CEO or the CEO delegate.')).toBeInTheDocument();
    expect(within(asked).queryByRole('button', { name: 'Open for a day' })).not.toBeInTheDocument();
    expect(within(asked).queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument();
  });

  it('keeps the buttons for an older server that does not say who may answer', () => {
    strip([{ available: true, until: UNTIL, asked: null, machine: 'a-host' }]);
    expect(screen.getByRole('button', { name: 'Close access' })).toBeInTheDocument();
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
