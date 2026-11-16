import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Versions } from '../src/screens/Versions';
import type { NodeWait, UpdatesView } from '../src/types';
import { NodeWaits } from '../src/ui/MachineDrain';
import { updatesPollMs, type Updates } from '../src/updates';

const WAITING: NodeWait = { node: 'n1', provider: 'antigravity', hostname: 'node-a', drain: { state: 'waiting', turnsLeft: 2, partsLeft: 0, until: '2026-11-05T12:47:00.000Z' }, work: [{ agent: 'Dev', task: 251 }, { agent: 'Bob', task: null }] };
const FREE: NodeWait = { node: 'builtin', provider: null, hostname: null, drain: { state: 'restarting', since: '2026-11-05T11:17:00.000Z' }, work: [] };
const LATER: NodeWait = { node: 'n2', provider: 'claude', hostname: 'node-a', drain: { state: 'postponed', turnsLeft: 1, partsLeft: 0, retryAt: '2026-11-05T13:05:00.000Z' }, work: [{ agent: 'Dev', task: 7 }] };

afterEach(() => localStorage.clear());

const shown = (waits: NodeWait[] | undefined, language: 'en' | 'ru' = 'en') => {
  localStorage.setItem('hh-lang', language);
  return render(<LanguageProvider><NodeWaits waits={waits} /></LanguageProvider>);
};
const row = (name: string) => within(screen.getByText(name).closest('li')!);

describe('what each node waits for on the update screen', () => {
  it.each([[undefined], [[]]])('shows nothing while no node waits', waits => {
    const { container } = shown(waits);
    expect(container).toBeEmptyDOMElement();
  });

  it('names each node, what it waits for and until when', () => {
    shown([FREE, WAITING, LATER]);
    expect(screen.getByRole('heading', { name: 'Updating the nodes' })).toBeInTheDocument();
    const waiting = row('Antigravity on node-a');
    expect(waiting.getByRole('status')).toHaveTextContent('Waiting for agents to finish before the update: 2 turns left, until 12:47');
    expect(waiting.getByText('Waits for: Dev (#251), Bob')).toBeInTheDocument();
    expect(waiting.getByText('Waiting to update')).toBeInTheDocument();
    const free = row('Built-in node');
    expect(free.getByRole('status')).toHaveTextContent('Free: being replaced now, then takes work again by itself');
    expect(free.queryByText(/Waits for/)).toBeNull();
    const later = row('Claude on node-a');
    expect(later.getByRole('status')).toHaveTextContent('The update is postponed: agents did not finish in time. Next try at 13:05');
    expect(later.getByText('Waits for: Dev (#7)')).toBeInTheDocument();
  });

  it('says it in Russian too', () => {
    shown([FREE, WAITING], 'ru');
    expect(screen.getByRole('heading', { name: 'Обновление нод' })).toBeInTheDocument();
    const waiting = row('Antigravity на node-a');
    expect(waiting.getByRole('status')).toHaveTextContent('Ждет конца работы агентов перед обновлением: осталось 2 хода, до 12:47');
    expect(waiting.getByText('Ждет: Dev (#251), Bob')).toBeInTheDocument();
    expect(row('Встроенная нода').getByRole('status')).toHaveTextContent('Свободна: заменяется сейчас и сама снова возьмет работу');
  });

  it('says what the rules are: nothing that runs stops', () => {
    shown([FREE]);
    expect(screen.getByText('Each node restarts as soon as its own work ends. Nothing that runs is stopped.')).toBeInTheDocument();
  });

  it('names a node of a plan the screen does not know by what the server said', () => {
    shown([{ ...WAITING, provider: 'newplan' }]);
    expect(screen.getByText('newplan on node-a')).toBeInTheDocument();
  });

  it('names a node on a machine with no plan by its machine', () => {
    shown([{ ...WAITING, provider: null }]);
    expect(screen.getByText('node-a')).toBeInTheDocument();
  });
});

describe('the Versions screen', () => {
  const view: UpdatesView = {
    current: { version: '0.7.0', commit: 'a'.repeat(40), migrations: 5 },
    available: false,
    checkedAt: null,
    latest: null,
    versions: [],
    error: null,
    updater: { present: true, status: null, waiting: null, calledOff: null },
  };
  const updates = (next: UpdatesView): Updates => ({
    view: next, busy: false, starting: false, target: null, offline: false, maintenance: false, asking: false, cut: null,
    check: async () => {}, update: async () => {}, callOff: async () => {}, confirmCut: async () => {}, dropCut: () => {},
  });
  const dialog = (next: UpdatesView) => render(<LanguageProvider><Versions updates={updates(next)} onClose={() => {}} /></LanguageProvider>);

  it('shows the nodes that wait', () => {
    dialog({ ...view, nodeWaits: [WAITING] });
    expect(within(screen.getByRole('dialog')).getByText('Antigravity on node-a')).toBeInTheDocument();
  });

  it('shows no such part for a server from before it says so', () => {
    dialog(view);
    expect(screen.queryByRole('heading', { name: 'Updating the nodes' })).toBeNull();
  });
});

describe('how often the screen asks', () => {
  it('asks every 2 seconds during an update, every 15 while a node waits, every 5 minutes otherwise', () => {
    expect(updatesPollMs(true, [WAITING])).toBe(2_000);
    expect(updatesPollMs(true, undefined)).toBe(2_000);
    expect(updatesPollMs(false, [WAITING])).toBe(15_000);
    expect(updatesPollMs(false, [])).toBe(300_000);
    expect(updatesPollMs(false, undefined)).toBe(300_000);
  });
});
