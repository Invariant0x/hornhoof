import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { WindowTaskContext } from '../src/screens/AgentWindowContext';
import type { InboxLetter, InboxView } from '../src/types';
import { Inbox, letterTime } from '../src/ui/Inbox';
import { mockApi } from './api-mock';
import { fakeStream } from './fake-stream';

const DEV = { id: 'd1', name: { en: 'Development', ru: 'Разработка' } };
const HANA = { kind: 'agent' as const, id: 'a1', name: 'Hana', role: { en: 'Head of development', ru: 'Руководитель разработки' }, department: DEV, agentKind: 'head' as const };
const RITA = { kind: 'agent' as const, id: 'a3', name: 'Rita Sousa-Ferreira', role: { en: 'Backend developer', ru: 'Бэкенд-разработчик' }, department: DEV, agentKind: 'worker' as const };
const HORNHOOF = { kind: 'hornhoof' as const, id: null, name: 'Hornhoof', role: null, department: null };

/* Newest first, as the server gives them. */
const LETTERS: InboxLetter[] = [
  { id: 'l3', sender: HORNHOOF, kind: 'notification', source: 'tests', task: null, receivedAt: '2030-01-01T08:06:00Z', text: 'The test run ended.', unread: true },
  { id: 'l2', sender: RITA, kind: 'message', source: null, task: { id: null, number: 7, title: null }, receivedAt: '2030-01-01T08:05:00Z', text: 'I pushed the fixtures.\nSee the branch.\nThe old ones are gone.\nAsk me if one fails.', unread: true },
  { id: 'l1', sender: HANA, kind: 'assignment', source: 'assigned', task: { id: 't7', number: 7, title: 'Checkout API' }, receivedAt: '2030-01-01T08:00:00Z', text: 'Take #7.', unread: false },
];
const VIEW: InboxView = { unreadCount: 2, total: 3, letters: LETTERS, more: false, mode: null, inheritedMode: 'inbox', effectiveMode: 'inbox', canChangeMode: true, canMarkRead: true };
const FIRST = 'GET /api/agents/b1/inbox?limit=50';

function show(view: InboxView = VIEW, routes: Record<string, unknown> = {}, extra: { onUnread?(n: number): void; openTask?(id: string, opener: HTMLElement): void } = {}) {
  const calls = mockApi({ [FIRST]: [200, view], ...(routes as Record<string, [number, unknown]>) });
  render(
    <LanguageProvider>
      <WindowTaskContext.Provider value={extra.openTask ?? null}>
        <Inbox agentId="b1" liveId="b1" hasDepartment onClose={() => {}} onUnread={extra.onUnread} />
      </WindowTaskContext.Provider>
    </LanguageProvider>,
  );
  return calls;
}

/* A letter by who sent it, and what its sender line and its status say. */
const letterOf = (name: string) => screen.getAllByRole('listitem').find(li => li.querySelector('.inbox-from')?.textContent?.startsWith(name))!;
const fromOf = (li: HTMLElement | undefined) => li?.querySelector('.inbox-from')?.textContent;
const statusOf = (li: HTMLElement | undefined) => li?.querySelector('.inbox-state')?.textContent;
const changes = (calls: { method: string }[]) => calls.filter(c => c.method !== 'GET');

afterEach(() => localStorage.clear());

describe("an employee's inbox", () => {
  it('shows each letter, newest first, with who sent it, what it is, when, whether it is read, its task and its first two lines', async () => {
    show();
    const list = await screen.findByRole('list', { name: 'Letters' });
    const [ended, pushed, given] = within(list).getAllByRole('listitem');
    expect(fromOf(ended)).toBe('HornhoofSystem message');
    expect(ended).toHaveTextContent('Notice');
    expect(statusOf(ended)).toBe('Unread');
    expect(fromOf(pushed)).toBe('Rita Sousa-FerreiraBackend developer · Development');
    expect(pushed).toHaveTextContent('Message');
    expect(pushed).toHaveTextContent('#7');
    expect(within(pushed!).getByText(/I pushed the fixtures\.\s+See the branch\./)).toBeInTheDocument();
    expect(pushed).not.toHaveTextContent('The old ones are gone.');
    expect(pushed).toHaveTextContent('2 more lines');
    expect(fromOf(given)).toBe('HanaHead of development · Development');
    expect(given).toHaveTextContent('Task assigned');
    expect(statusOf(given)).toBe('Read');
    expect(given).toHaveTextContent('#7 Checkout API');
    expect(within(given!).getByText(/^Jan 1, /).closest('time')).toHaveAttribute('datetime', '2030-01-01T08:00:00Z');
    expect(within(given!).queryByRole('button', { name: /Mark/ })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 unread');
  });

  it('opens a long letter in place and folds it again, and opening marks nothing', async () => {
    const user = userEvent.setup();
    const calls = show();
    await screen.findByRole('list', { name: 'Letters' });
    const pushed = letterOf('Rita Sousa-Ferreira');
    await user.click(within(pushed).getByRole('button', { name: 'Open the letter from Rita Sousa-Ferreira' }));
    expect(pushed).toHaveTextContent('The old ones are gone.');
    expect(pushed).not.toHaveTextContent('more lines');
    const fold = within(pushed).getByRole('button', { name: 'Fold the letter from Rita Sousa-Ferreira' });
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(fold).toHaveTextContent('Fold letter');
    await user.click(fold);
    expect(pushed).not.toHaveTextContent('The old ones are gone.');
    expect(statusOf(pushed)).toBe('Unread');
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 unread');
    expect(changes(calls)).toEqual([]);
  });

  it('marks a letter read by its button, then all of them, as the answers say, and gives the focus to the list', async () => {
    const user = userEvent.setup();
    const heard = vi.fn();
    const answers = [{ unreadCount: 1 }, { unreadCount: 0 }];
    const calls = show(VIEW, { 'POST /api/agents/b1/inbox/read': () => [200, answers.shift()] }, { onUnread: heard });
    await screen.findByRole('list', { name: 'Letters' });
    /* The list can appear before its effect reports the unread count. Wait for each report before checking its state. */
    await waitFor(() => expect(heard).toHaveBeenLastCalledWith(2));
    await user.click(screen.getByRole('button', { name: 'Mark the letter from Rita Sousa-Ferreira as read' }));
    await waitFor(() => expect(heard).toHaveBeenLastCalledWith(1));
    expect(statusOf(letterOf('Rita Sousa-Ferreira'))).toBe('Read');
    expect(screen.getByRole('status')).toHaveTextContent('1 of 3 unread');
    expect(screen.getByRole('heading', { name: 'Letters' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(heard).toHaveBeenLastCalledWith(0));
    expect(screen.getByRole('status')).toHaveTextContent('All read. 3 in total');
    expect(screen.queryByRole('button', { name: /Mark/ })).toBeNull();
    expect(changes(calls)).toEqual([
      { method: 'POST', path: '/api/agents/b1/inbox/read', body: { ids: ['l2'] } },
      { method: 'POST', path: '/api/agents/b1/inbox/read', body: { all: true } },
    ]);
  });

  it('keeps a letter unread and says so when marking it fails', async () => {
    const user = userEvent.setup();
    show(VIEW, { 'POST /api/agents/b1/inbox/read': [500, { error: { code: 'internal', message: 'No.' } }] });
    await screen.findByRole('list', { name: 'Letters' });
    await user.click(screen.getByRole('button', { name: 'Mark the letter from Rita Sousa-Ferreira as read' }));
    const pushed = letterOf('Rita Sousa-Ferreira');
    expect(await within(pushed).findByRole('alert')).toHaveTextContent('Could not mark the letter. Try again.');
    expect(statusOf(pushed)).toBe('Unread');
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(await screen.findByText('Could not mark the letters. Try again.')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 unread');
  });

  it('opens the task of a letter in the task panel of its window', async () => {
    const user = userEvent.setup();
    const openTask = vi.fn();
    show(VIEW, {}, { openTask });
    await user.click(await screen.findByRole('button', { name: '#7 Checkout API' }));
    expect(openTask).toHaveBeenCalledWith('t7', screen.getByRole('button', { name: '#7 Checkout API' }));
  });

  it("switches how letters come: by the department's rule, through the inbox or each at once, and says what holds now", async () => {
    const user = userEvent.setup();
    let own: 'inbox' | 'direct' | null = null;
    const calls = show(VIEW, {
      [FIRST]: () => [200, { ...VIEW, mode: own, effectiveMode: own ?? 'inbox' }],
      'PUT /api/agents/b1/inbox-mode': (body: { mode: typeof own }) => {
        own = body.mode;
        return [200, { mode: { own, inherited: 'inbox', effective: own ?? 'inbox' } }];
      },
    });
    const rule = await screen.findByRole('radio', { name: 'Department rule' });
    expect(rule).toBeChecked();
    expect(screen.getByText('Now: through Inbox, by department rule')).toBeInTheDocument();
    expect(screen.getByText('New letters wait here. Hornhoof wakes the free employee once for all unread letters.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Direct' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Direct' })).toBeChecked());
    expect(screen.getByText('Now: direct')).toBeInTheDocument();
    expect(screen.getByText("Each letter goes straight to the employee's window as its own turn.")).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Department rule' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Department rule' })).toBeChecked());
    expect(changes(calls)).toEqual([
      { method: 'PUT', path: '/api/agents/b1/inbox-mode', body: { mode: 'direct' } },
      { method: 'PUT', path: '/api/agents/b1/inbox-mode', body: { mode: null } },
    ]);
  });

  it('keeps the way just picked while the inbox is read again, with no flash of the old one', async () => {
    const user = userEvent.setup();
    let reads = 0;
    let release!: () => void;
    const later = new Promise<void>(resolve => {
      release = resolve;
    });
    show(VIEW, {
      [FIRST]: async () => {
        if (++reads === 1) return [200, VIEW];
        await later;
        return [200, { ...VIEW, mode: 'direct', effectiveMode: 'direct' }];
      },
      'PUT /api/agents/b1/inbox-mode': [200, { mode: { own: 'direct', inherited: 'inbox', effective: 'direct' } }],
    });
    await user.click(await screen.findByRole('radio', { name: 'Direct' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByRole('radio', { name: 'Direct' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Department rule' })).not.toBeChecked();
    release();
    await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
    expect(screen.getByRole('radio', { name: 'Direct' })).toBeChecked();
  });

  it('keeps the old way and says so when it could not change it', async () => {
    const user = userEvent.setup();
    show(VIEW, { 'PUT /api/agents/b1/inbox-mode': [500, { error: { code: 'internal', message: 'No.' } }] });
    await user.click(await screen.findByRole('radio', { name: 'Direct' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the mode. The old one stays.');
    expect(screen.getByRole('radio', { name: 'Department rule' })).toBeChecked();
  });

  it('shows a person who may not change them how letters come, with no choices and no marking', async () => {
    show({ ...VIEW, canChangeMode: false, canMarkRead: false, mode: 'direct', effectiveMode: 'direct' });
    expect(await screen.findByText('Now: direct')).toBeInTheDocument();
    expect(screen.getByText('The CEO or the head of the department can change it.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'How this employee gets letters' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark/ })).toBeNull();
  });

  it('says when it is empty', async () => {
    show({ ...VIEW, unreadCount: 0, total: 0, letters: [] });
    expect(await screen.findByText('No letters yet.')).toBeInTheDocument();
    expect(screen.getByText('Letters to this employee from people, other employees and the orchestrator come here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull();
  });

  it('says while it reads them, and when it could not, with a way to try again', async () => {
    const user = userEvent.setup();
    let fail = true;
    let release!: () => void;
    const later = new Promise<void>(resolve => {
      release = resolve;
    });
    mockApi({ [FIRST]: async () => (await later, fail ? [500, { error: { code: 'internal', message: 'No.' } }] : [200, VIEW]) });
    render(
      <LanguageProvider>
        <Inbox agentId="b1" liveId="b1" hasDepartment onClose={() => {}} />
      </LanguageProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading letters…');
    expect(screen.getByRole('complementary', { name: 'Inbox' })).toHaveAttribute('aria-busy', 'true');
    release();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the letters. Check the connection to the server and try again.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Letters' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows 50 letters, and 50 more each time the person asks', async () => {
    const user = userEvent.setup();
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ ...LETTERS[2]!, id: `m${from + i}`, text: `Letter ${from + i}.` }));
    const calls = show({ ...VIEW, total: 120, letters: many(0, 50), more: true }, {
      'GET /api/agents/b1/inbox?limit=100': [200, { ...VIEW, total: 120, letters: many(0, 100), more: true }],
    });
    await screen.findByRole('list', { name: 'Letters' });
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(100));
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
    expect(calls.map(c => c.path)).toEqual(['/api/agents/b1/inbox?limit=50', '/api/agents/b1/inbox?limit=100']);
  });

  it("reads the inbox again when the stream says this employee's inbox changed", async () => {
    const stream = fakeStream();
    const calls = show();
    await screen.findByRole('list', { name: 'Letters' });
    const reads = () => calls.filter(c => c.path.startsWith('/api/agents/b1/inbox')).length;
    stream.send({ type: 'inbox', agentId: 'other' });
    stream.send({ type: 'inbox', agentId: 'b1' });
    await expect.poll(reads).toBe(2);
  });

  it('shows in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    show();
    expect(await screen.findByRole('list', { name: 'Письма' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'По правилу отдела' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Через входящие' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Прямая подача' })).toBeInTheDocument();
    expect(screen.getByText('Сейчас: через входящие, по правилу отдела')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отметить все прочитанными' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отметить прочитанным письмо от Rita Sousa-Ferreira' })).toHaveTextContent('Отметить прочитанным');
    expect(screen.getByRole('button', { name: 'Открыть письмо от Rita Sousa-Ferreira' })).toHaveTextContent('Открыть письмо');
    expect(screen.getAllByText('Не прочитано')).toHaveLength(2);
    expect(screen.getByText('Еще 2 строки')).toBeInTheDocument();
    expect(screen.getByText('Назначение задачи')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Не прочитано 2 из 3');
  });
});

describe('when a letter came', () => {
  const at = (iso: string) => new Date(iso).getTime();
  it('says the time alone today, yesterday and the time, else the day and the time', () => {
    const now = at('2030-03-10T15:00:00');
    expect(letterTime('en', '2030-03-10T09:41:00', now).shown).toBe('9:41 AM');
    expect(letterTime('en', '2030-03-09T16:05:00', now).shown).toBe('yesterday, 4:05 PM');
    expect(letterTime('ru', '2030-03-09T16:05:00', now).shown).toBe('вчера, 16:05');
    expect(letterTime('en', '2030-03-07T09:41:00', now).shown).toBe('Mar 7, 9:41 AM');
    expect(letterTime('ru', '2030-03-07T09:41:00', now).shown).toBe('7 мар., 9:41');
    expect(letterTime('en', '2030-03-07T09:41:00', now).full).toBe('March 7, 2030 at 9:41 AM');
  });
});
