import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { InboxCard } from '../src/types';
import { decisions, DEV_ORG, ME, mockApi } from './api-mock';

/* On Hornhoof's own installation, people who see the whole company read what every installation sent, repeats counted as
   one card, by priority, and turn a card into a GitHub issue with one press. */

const card = (over: Partial<InboxCard>): InboxCard => ({
  id: 'f1',
  number: 1,
  kind: 'bug',
  title: 'Terminal froze after an update',
  text: 'The agent terminal stayed black.',
  errorCode: null,
  versions: ['0.18.11'],
  platforms: ['linux x64'],
  signals: 1,
  installations: 1,
  priority: 'normal',
  firstAt: '2026-11-12T10:00:00.000Z',
  lastAt: '2026-11-12T11:00:00.000Z',
  issue: null,
  ...over,
});
const CARDS: InboxCard[] = [
  card({ id: 'f1', title: 'Terminal froze after an update', priority: 'high', signals: 5, installations: 3, errorCode: 'terminal_lost', versions: ['0.18.11', '0.18.9'], platforms: ['darwin arm64', 'linux x64'] }),
  card({ id: 'f2', number: 2, kind: 'idea', title: 'Click [here](javascript:alert(1))', text: '<b>bold</b> and https://evil.example and **stars**', priority: 'low' }),
  card({ id: 'f3', number: 3, kind: 'improvement', title: 'Show the queue', priority: 'normal', issue: { number: 12, url: 'https://github.com/invariant0x/hornhoof/issues/12' } }),
];

function page(routes: Record<string, unknown> = {}, language = 'en') {
  localStorage.setItem('hh-lang', language);
  const calls = mockApi({
    'GET /api/org': [200, DEV_ORG],
    'GET /api/requests': [200, decisions([])],
    'GET /api/improvements': [200, { improvements: [] }],
    'GET /api/turns': [200, { turns: [] }],
    'GET /api/feedback': [200, { inbox: true }],
    'GET /api/feedback/inbox': [200, { cards: CARDS }],
    'POST /api/feedback/inbox/f1/issue': [200, { issue: { number: 1347, url: 'https://github.com/invariant0x/hornhoof/issues/1347' } }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
  return { user: userEvent.setup(), calls };
}

async function openInbox(user: ReturnType<typeof userEvent.setup>, account = 'Account', item = 'Feedback inbox', title = 'Feedback inbox') {
  await user.click(screen.getByRole('button', { name: account }));
  await user.click(await screen.findByRole('button', { name: item }));
  return screen.findByRole('heading', { level: 1, name: title });
}

afterEach(() => localStorage.clear());

describe('the feedback inbox', () => {
  it('lists cards by priority, with kind, signals, installations, versions, machines and error code', async () => {
    const { user } = page();
    await openInbox(user);
    const items = screen.getAllByRole('article');
    expect(items.map(i => within(i).getByRole('heading', { level: 3 }).textContent)).toEqual(['Terminal froze after an update', 'Click [here](javascript:alert(1))', 'Show the queue']);
    const first = items[0]!;
    expect(within(first).getByText('Bug')).toBeInTheDocument();
    expect(within(first).getByText('High priority')).toBeInTheDocument();
    expect(first).toHaveTextContent('5 signals from 3 installations');
    expect(first).toHaveTextContent('Versions: 0.18.11, 0.18.9');
    expect(first).toHaveTextContent('Machines: darwin arm64, linux x64');
    expect(first).toHaveTextContent('Error code: terminal_lost');
    /* The number an installation knows its report by. */
    expect(within(first).getByText('Report 1')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Report 2')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Idea')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Low priority')).toBeInTheDocument();
  });

  it('shows what installations sent as plain text: nothing in it becomes a link, a tag or bold', async () => {
    const { user } = page();
    await openInbox(user);
    const odd = screen.getByRole('article', { name: 'Click [here](javascript:alert(1))' });
    expect(within(odd).getByText('<b>bold</b> and https://evil.example and **stars**')).toBeInTheDocument();
    expect(within(odd).queryByRole('link')).not.toBeInTheDocument();
    expect(odd.querySelector('b, strong, script')).toBeNull();
  });

  it('turns a card into a GitHub issue with one press and shows its number as a link', async () => {
    const { user, calls } = page();
    await openInbox(user);
    const first = screen.getByRole('article', { name: 'Terminal froze after an update' });
    await user.click(within(first).getByRole('button', { name: 'Create GitHub issue' }));
    const link = await within(first).findByRole('link', { name: 'Issue #1347' });
    expect(link).toHaveAttribute('href', 'https://github.com/invariant0x/hornhoof/issues/1347');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual(['/api/feedback/inbox/f1/issue']);
    expect(within(first).queryByRole('button', { name: 'Create GitHub issue' })).not.toBeInTheDocument();
    const issued = screen.getByRole('article', { name: 'Show the queue' });
    expect(within(issued).getByRole('link', { name: 'Issue #12' })).toHaveAttribute('href', 'https://github.com/invariant0x/hornhoof/issues/12');
    expect(within(issued).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says why an issue was not created', async () => {
    const { user } = page({ 'POST /api/feedback/inbox/f1/issue': [409, { error: { code: 'conflict', reason: 'feedback_no_github_key', message: 'No key.' } }] });
    await openInbox(user);
    const first = screen.getByRole('article', { name: 'Terminal froze after an update' });
    await user.click(within(first).getByRole('button', { name: 'Create GitHub issue' }));
    expect(await within(first).findByRole('alert')).toHaveTextContent('No GitHub key for invariant0x is saved. Save one in Settings, under Integrations, with the right to create issues.');
  });

  it('is not in the menu of an installation that is not the inbox', async () => {
    const { user } = page({ 'GET /api/feedback': [200, { inbox: false }] });
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await screen.findByRole('button', { name: 'About' });
    expect(screen.queryByRole('button', { name: 'Feedback inbox' })).not.toBeInTheDocument();
  });

  it('speaks Russian', async () => {
    const { user } = page({}, 'ru');
    await openInbox(user, 'Аккаунт', 'Входящие отзывы', 'Входящие отзывы');
    const first = screen.getByRole('article', { name: 'Terminal froze after an update' });
    expect(within(first).getByText('Ошибка')).toBeInTheDocument();
    expect(within(first).getByText('Высокий приоритет')).toBeInTheDocument();
    expect(first).toHaveTextContent('5 сигналов с 3 установок');
    expect(within(first).getByText('Обращение № 1')).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: 'Создать Issue на GitHub' })).toBeInTheDocument();
    expect(document.body.textContent!).not.toMatch(/[ё—]/);
  });
});
