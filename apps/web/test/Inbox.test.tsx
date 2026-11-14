import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { InboxLetter, InboxView } from '../src/types';
import { Inbox } from '../src/ui/Inbox';
import { mockApi } from './api-mock';
import { fakeStream } from './fake-stream';

const DEV = { id: 'd1', name: { en: 'Development', ru: 'Разработка' } };
const HANA = { kind: 'agent' as const, id: 'a1', name: 'Hana', role: { en: 'Head of development', ru: 'Руководитель разработки' }, department: DEV, agentKind: 'head' as const };
const RITA = { kind: 'agent' as const, id: 'a3', name: 'Rita', role: { en: 'Backend developer', ru: 'Бэкенд-разработчик' }, department: DEV, agentKind: 'worker' as const };
const HORNHOOF = { kind: 'hornhoof' as const, id: null, name: 'Hornhoof', role: null, department: null };

const LETTERS: InboxLetter[] = [
  { id: 'l1', sender: HANA, kind: 'assignment', source: 'assigned', task: { number: 7, title: 'Checkout API' }, at: '2030-01-01T08:00:00Z', text: 'Take #7.', status: 'read' },
  { id: 'l2', sender: RITA, kind: 'message', source: null, task: { number: 7, title: null }, at: '2030-01-01T08:05:00Z', text: 'I pushed the fixtures.\nSee the branch.', status: 'unread' },
  { id: 'l3', sender: HORNHOOF, kind: 'notification', source: 'tests', task: null, at: '2030-01-01T08:06:00Z', text: 'The test run ended.', status: 'unread' },
];
const VIEW: InboxView = { unread: 2, letters: LETTERS, mode: { own: null, inherited: 'inbox', effective: 'inbox' }, canChange: true };

function show(view: InboxView = VIEW, routes: Record<string, unknown> = {}) {
  const calls = mockApi({ 'GET /api/agents/b1/inbox': [200, view], ...(routes as Record<string, [number, unknown]>) });
  render(
    <LanguageProvider>
      <Inbox agentId="b1" liveId="b1" hasDepartment />
    </LanguageProvider>,
  );
  return calls;
}

afterEach(() => localStorage.clear());

describe("an employee's inbox", () => {
  it('shows each letter with what it is, who sent it from which department, its task, time and whole text, and which are unread', async () => {
    show();
    const list = await screen.findByRole('list', { name: 'Inbox' });
    const [given, pushed, ended] = within(list).getAllByRole('listitem');
    expect(given).toHaveTextContent('Assignment from Hana (Head of development)');
    expect(given).toHaveTextContent('Development');
    expect(given).toHaveTextContent('#7 Checkout API');
    expect(given).not.toHaveTextContent('Unread');
    expect(within(given!).queryByRole('button')).toBeNull();
    expect(pushed).toHaveTextContent('Message from Rita (Backend developer)');
    expect(pushed).toHaveTextContent('Unread');
    expect(within(pushed!).getByText(/I pushed the fixtures\.\s+See the branch\./)).toBeInTheDocument();
    expect(ended).toHaveTextContent('Notification from Hornhoof');
    expect(ended).toHaveTextContent('test run ended');
    expect(screen.getByRole('status')).toHaveTextContent('2 unread');
  });

  it('marks nothing when it opens, and marks letters read by the buttons only', async () => {
    const user = userEvent.setup();
    const calls = show(VIEW, { 'POST /api/agents/b1/inbox/read': [200, { unread: 1 }] });
    await screen.findByRole('list', { name: 'Inbox' });
    expect(calls.filter(c => c.method !== 'GET')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Mark the letter from Rita (Backend developer) as read' }));
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(calls.filter(c => c.method !== 'GET')).toEqual([
      { method: 'POST', path: '/api/agents/b1/inbox/read', body: { ids: ['l2'] } },
      { method: 'POST', path: '/api/agents/b1/inbox/read', body: { all: true } },
    ]);
  });

  it("switches how letters come: by the department's rule, through the inbox or each at once", async () => {
    const user = userEvent.setup();
    let own: 'inbox' | 'direct' | null = null;
    const calls = show(VIEW, {
      'GET /api/agents/b1/inbox': () => [200, { ...VIEW, mode: { own, inherited: 'inbox', effective: own ?? 'inbox' } }],
      'PUT /api/agents/b1/inbox-mode': (body: { mode: typeof own }) => {
        own = body.mode;
        return [200, { mode: { own, inherited: 'inbox', effective: own ?? 'inbox' } }];
      },
    });
    const rule = await screen.findByRole('radio', { name: "By the department's rule" });
    expect(rule).toBeChecked();
    expect(rule).toHaveAccessibleDescription('Now: through the inbox.');
    await user.click(screen.getByRole('radio', { name: 'Direct delivery' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Direct delivery' })).toBeChecked());
    await user.click(screen.getByRole('radio', { name: "By the department's rule" }));
    await waitFor(() => expect(screen.getByRole('radio', { name: "By the department's rule" })).toBeChecked());
    expect(calls.filter(c => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/agents/b1/inbox-mode', body: { mode: 'direct' } },
      { method: 'PUT', path: '/api/agents/b1/inbox-mode', body: { mode: null } },
    ]);
  });

  it('keeps the way just picked while the inbox is read again, with no flash of the old one', async () => {
    const user = userEvent.setup();
    let reads = 0;
    let release!: () => void;
    const later = new Promise<void>(resolve => { release = resolve; });
    show(VIEW, {
      'GET /api/agents/b1/inbox': async () => {
        if (++reads === 1) return [200, VIEW];
        await later;
        return [200, { ...VIEW, mode: { own: 'direct', inherited: 'inbox', effective: 'direct' } }];
      },
      'PUT /api/agents/b1/inbox-mode': [200, { mode: { own: 'direct', inherited: 'inbox', effective: 'direct' } }],
    });
    await user.click(await screen.findByRole('radio', { name: 'Direct delivery' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByRole('radio', { name: 'Direct delivery' })).toBeChecked();
    expect(screen.getByRole('radio', { name: "By the department's rule" })).not.toBeChecked();
    release();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Direct delivery' })).toBeEnabled());
    expect(screen.getByRole('radio', { name: 'Direct delivery' })).toBeChecked();
  });

  it('shows a person who may not change them how letters come, with no buttons', async () => {
    show({ ...VIEW, canChange: false, mode: { own: 'direct', inherited: 'inbox', effective: 'direct' } });
    expect(await screen.findByText('Letters come: direct delivery.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark/ })).toBeNull();
  });

  it('says when it is empty, and when it could not be read', async () => {
    show({ unread: 0, letters: [], mode: { own: null, inherited: 'inbox', effective: 'inbox' }, canChange: true });
    expect(await screen.findByText('No letters yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull();
  });

  it('says why the inbox could not be read', async () => {
    mockApi({ 'GET /api/agents/b1/inbox': [403, { error: { code: 'forbidden', message: 'No.', reason: 'agent_hidden' } }] });
    render(
      <LanguageProvider>
        <Inbox agentId="b1" liveId="b1" hasDepartment />
      </LanguageProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the inbox.');
  });

  it('reads the inbox again when the stream says this employee\'s inbox changed', async () => {
    const stream = fakeStream();
    const calls = show();
    await screen.findByRole('list', { name: 'Inbox' });
    const reads = () => calls.filter(c => c.path === '/api/agents/b1/inbox').length;
    stream.send({ type: 'inbox', agentId: 'other' });
    stream.send({ type: 'inbox', agentId: 'b1' });
    await expect.poll(reads).toBe(2);
  });

  it('shows in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    show();
    expect(await screen.findByRole('list', { name: 'Входящие' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'По правилу отдела' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Через входящие' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Прямая подача' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отметить все прочитанными' })).toBeInTheDocument();
    expect(screen.getAllByText('Не прочитано')).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('2 непрочитанных');
  });
});
