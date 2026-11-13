import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { Improvement, Me } from '../src/types';
import { decisions, DEV_ORG, ME, mockApi, TASK_DETAIL, TASKS } from './api-mock';
import { fakeStream } from './fake-stream';

const base = { seen: 1, result: null, at: '2026-10-31T09:00:00.000Z', updatedAt: '2026-10-31T09:00:00.000Z', decidedBy: null };
const IMPROVEMENTS: Improvement[] = [
  {
    ...base,
    id: 'i1',
    title: 'Install jq on the nodes',
    text: 'Agents looked for **jq** on #4 and #9.',
    seen: 3,
    status: 'open',
    agent: { id: 'w1', name: 'Wendy' },
    department: { id: 'd9', name: 'Operations' },
  },
  { ...base, id: 'i2', title: 'Let reviewers run the tests without asking', text: 'Rita asked twice.', status: 'taken', agent: { id: 'a1', name: 'Dana' }, department: { id: 'd2', name: 'Development' }, decidedBy: 'Ivan' },
  {
    ...base,
    id: 'i3',
    title: 'Move security to Kimi',
    text: 'Codex refused the audit.',
    status: 'done',
    result: 'Moved Sam to the Kimi plan.',
    agent: { id: 'w1', name: 'Wendy' },
    department: { id: 'd9', name: 'Operations' },
  },
];
/* A case filed in parts, with the same case written out as its text. */
const CASE: Improvement = {
  ...IMPROVEMENTS[0]!,
  text: 'What is wrong: Agents install jq by hand.\n\nChange: Add jq to the node image.',
  parts: {
    problem: 'Agents install **jq** by hand before they can read the test reports.',
    facts: [
      { text: 'jq was missing 7 times this week.', source: 'failures, 25 to 31 October' },
      { text: 'Each install took about 2 minutes.', source: 'task #9, its log' },
    ],
    guesses: ['The reviewers may need yq as well.'],
    why: 'Every review waits for the install.',
    change: 'Add jq to the node image.',
    gain: 'Reviews start about 2 minutes sooner.',
  },
};
const listed = (id: string): Me => ({ ...ME, person: { ...ME.person, id, name: 'Lena', scopeKind: 'listed', isOwner: false } });

function shell(routes: Record<string, unknown> = {}, me: Me = ME, onSignOut: () => void = () => {}) {
  const calls = mockApi({
    'GET /api/org': [200, DEV_ORG],
    'GET /api/requests': [200, decisions([])],
    'GET /api/improvements': [200, { improvements: IMPROVEMENTS }],
    'GET /api/tasks?status=all&department=d2': [200, { tasks: TASKS }],
    'GET /api/turns': [200, { turns: [] }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(
    <LanguageProvider>
      <Shell me={me} onSignOut={onSignOut} />
    </LanguageProvider>,
  );
  return calls;
}

async function openImprovements(user: ReturnType<typeof userEvent.setup>, name = 'Improvements, 1 to decide') {
  await user.click(await screen.findByRole('button', { name: 'Account' }));
  await user.click(await screen.findByRole('button', { name }));
  expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
  return screen.findByRole('heading', { level: 1, name: 'Improvements' });
}

describe('improvements', () => {
  it('lists what employees found to improve, what waits for the CEO first, then what is in work and what was done', async () => {
    const user = userEvent.setup();
    shell();
    await openImprovements(user);
    const open = within(screen.getByRole('region', { name: 'To decide' })).getByRole('article', { name: 'Install jq on the nodes' });
    expect(open).toHaveTextContent('Wendy, Operations');
    expect(open).toHaveTextContent('Found 3 times');
    expect(within(open).getByText('jq').tagName).toBe('STRONG');
    expect(within(screen.getByRole('region', { name: 'In work' })).getByRole('article', { name: 'Let reviewers run the tests without asking' })).toHaveTextContent('Taken by Ivan');
    const done = within(screen.getByRole('region', { name: 'Done' })).getByRole('article', { name: 'Move security to Kimi' });
    expect(done).toHaveTextContent('Moved Sam to the Kimi plan.');
  });

  it('shows a case in short sections, with the facts and their sources apart from the guesses', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/improvements': [200, { improvements: [CASE] }] });
    await openImprovements(user);
    const item = screen.getByRole('article', { name: 'Install jq on the nodes' });
    expect(within(item).getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual(['What is wrong', 'Facts', 'Guesses, not checked yet', 'Why it matters', 'What to change', 'What it gives']);
    expect(within(item).getByRole('region', { name: 'What is wrong' })).toHaveTextContent('Agents install jq by hand before they can read the test reports.');
    expect(within(item).getByText('jq').tagName).toBe('STRONG');
    const facts = within(item).getByRole('list', { name: 'Facts' });
    expect(within(facts).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      'jq was missing 7 times this week.Source: failures, 25 to 31 October',
      'Each install took about 2 minutes.Source: task #9, its log',
    ]);
    const guesses = within(item).getByRole('list', { name: 'Guesses, not checked yet' });
    expect(within(guesses).getAllByRole('listitem').map(li => li.textContent)).toEqual(['The reviewers may need yq as well.']);
    expect(facts).not.toHaveTextContent('yq');
    expect(within(item).getByRole('region', { name: 'Why it matters' })).toHaveTextContent('Every review waits for the install.');
    expect(within(item).getByRole('region', { name: 'What to change' })).toHaveTextContent('Add jq to the node image.');
    expect(within(item).getByRole('region', { name: 'What it gives' })).toHaveTextContent('Reviews start about 2 minutes sooner.');
    /* The written-out text is the same case, so it does not show twice. */
    expect(item).not.toHaveTextContent('What is wrong: Agents install jq by hand.');
  });

  it('shows only the parts a case has', async () => {
    const user = userEvent.setup();
    const bare = { ...CASE, parts: { problem: null, facts: [], guesses: [], why: null, change: 'Add jq to the node image.', gain: null } };
    shell({ 'GET /api/improvements': [200, { improvements: [bare] }] });
    await openImprovements(user);
    const item = screen.getByRole('article', { name: 'Install jq on the nodes' });
    expect(within(item).getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual(['What to change']);
    expect(within(item).queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows a case with its headings in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      const user = userEvent.setup();
      shell({ 'GET /api/improvements': [200, { improvements: [CASE] }] });
      await user.click(await screen.findByRole('button', { name: 'Аккаунт' }));
      await user.click(await screen.findByRole('button', { name: 'Улучшения, ждут решения: 1' }));
      const item = await screen.findByRole('article', { name: 'Install jq on the nodes' });
      expect(within(item).getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual(['Что не так', 'Факты', 'Догадки, еще не проверены', 'Почему это важно', 'Что изменить', 'Что это даст']);
      expect(within(within(item).getByRole('list', { name: 'Факты' })).getAllByRole('listitem')[0]).toHaveTextContent('Источник: failures, 25 to 31 October');
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('gives one to the orchestrator, or sets it aside', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/improvements/i1/take': [200, { improvement: { id: 'i1', status: 'taken' } }], 'POST /api/improvements/i1/dismiss': [200, { improvement: { id: 'i1', status: 'dismissed' } }] });
    await openImprovements(user);
    const open = within(screen.getByRole('region', { name: 'To decide' })).getByRole('article', { name: 'Install jq on the nodes' });
    await user.click(within(open).getByRole('button', { name: 'Take into work' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/api/improvements/i1/take')).toBe(true));
    await user.click(within(open).getByRole('button', { name: 'Set aside' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/api/improvements/i1/dismiss')).toBe(true));
  });

  it("name the department in the person's language", async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      const user = userEvent.setup();
      shell();
      await user.click(await screen.findByRole('button', { name: 'Аккаунт' }));
      await user.click(await screen.findByRole('button', { name: 'Улучшения, ждут решения: 1' }));
      const taken = await screen.findByRole('article', { name: 'Let reviewers run the tests without asking' });
      expect(taken).toHaveTextContent('Dana, Разработка');
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('shows related task numbers and opens them in the existing task panel', async () => {
    const user = userEvent.setup();
    const first = { id: 't12', number: 12, title: 'Checkout API' };
    const second = { id: 't13', number: 13, title: 'Refunds' };
    shell({
      'GET /api/improvements': [200, { improvements: [
        { ...IMPROVEMENTS[0]!, tasks: [] },
        { ...IMPROVEMENTS[1]!, tasks: [first, second] },
        { ...IMPROVEMENTS[2]!, tasks: [first] },
      ] }],
      'GET /api/tasks/t12': [200, { task: TASK_DETAIL }],
      'GET /api/tasks/t13': [200, { task: { ...TASK_DETAIL, id: 't13', number: 13, title: 'Refunds' } }],
    });
    await openImprovements(user);
    const open = within(screen.getByRole('region', { name: 'To decide' })).getByRole('article', { name: 'Install jq on the nodes' });
    expect(within(open).queryByText('Related tasks')).not.toBeInTheDocument();
    const taken = within(screen.getByRole('region', { name: 'In work' })).getByRole('article', { name: 'Let reviewers run the tests without asking' });
    expect(within(taken).getByText('Related tasks')).toBeInTheDocument();
    const firstLink = within(taken).getByRole('button', { name: '#12 Checkout API' });
    expect(within(taken).getByRole('button', { name: '#13 Refunds' })).toBeInTheDocument();
    const done = within(screen.getByRole('region', { name: 'Done' })).getByRole('article', { name: 'Move security to Kimi' });
    expect(within(done).getAllByRole('button', { name: /^#/ })).toHaveLength(1);
    await user.click(firstLink);
    expect(await screen.findByRole('complementary', { name: '#12 Checkout API' })).toBeInTheDocument();
    expect(location.pathname).toBe('/tasks/t12');
    expect(taken).toBeVisible();
    await user.click(within(screen.getByRole('complementary', { name: '#12 Checkout API' })).getByRole('button', { name: 'Close' }));
    expect(location.pathname).toBe('/improvements');
    expect(taken).toBeVisible();
    await user.click(screen.getByRole('button', { name: '#13 Refunds' }));
    expect(await screen.findByRole('complementary', { name: '#13 Refunds' })).toBeInTheDocument();
    expect(location.pathname).toBe('/tasks/t13');
    expect(taken).toBeVisible();
  });

  it('keeps taken out of the open count and shows Take only for open improvements', async () => {
    const user = userEvent.setup();
    shell();
    await openImprovements(user);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('button', { name: 'Improvements, 1 to decide' })).toBeInTheDocument();
    const open = within(screen.getByRole('region', { name: 'To decide' })).getByRole('article', { name: 'Install jq on the nodes' });
    expect(within(open).getByRole('button', { name: 'Take into work' })).toBeInTheDocument();
    const taken = within(screen.getByRole('region', { name: 'In work' })).getByRole('article', { name: 'Let reviewers run the tests without asking' });
    expect(taken).toHaveTextContent('Taken by Ivan');
    expect(within(taken).queryByRole('button', { name: 'Take into work' })).not.toBeInTheDocument();
    const done = within(screen.getByRole('region', { name: 'Done' })).getByRole('article', { name: 'Move security to Kimi' });
    expect(within(done).queryByRole('button', { name: 'Take into work' })).not.toBeInTheDocument();
  });

  it('updates the open badge, Take button and task links on an improvements event', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    let moved = false;
    const linked = { id: 't12', number: 12, title: 'Checkout API' };
    shell({
      'GET /api/improvements': () => [200, { improvements: [
        moved ? { ...IMPROVEMENTS[0]!, status: 'taken', decidedBy: 'Ivan', tasks: [linked] } : IMPROVEMENTS[0]!,
      ] }],
    });
    await openImprovements(user);
    expect(screen.getByRole('button', { name: 'Take into work' })).toBeInTheDocument();
    moved = true;
    stream.send({ type: 'improvements' });
    expect(await screen.findByText('Taken by Ivan')).toBeInTheDocument();
    const taken = await screen.findByRole('article', { name: 'Install jq on the nodes' });
    expect(within(taken).queryByRole('button', { name: 'Take into work' })).not.toBeInTheDocument();
    expect(within(taken).getByRole('button', { name: '#12 Checkout API' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('button', { name: 'Improvements' })).toBeInTheDocument();
  });

  it('shows related tasks in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      const user = userEvent.setup();
      const linked = { id: 't12', number: 12, title: 'Checkout API' };
      shell({ 'GET /api/improvements': [200, { improvements: [IMPROVEMENTS[0]!, { ...IMPROVEMENTS[1]!, tasks: [linked] }, IMPROVEMENTS[2]!] }] });
      await user.click(await screen.findByRole('button', { name: 'Аккаунт' }));
      await user.click(await screen.findByRole('button', { name: 'Улучшения, ждут решения: 1' }));
      const taken = await screen.findByRole('article', { name: 'Let reviewers run the tests without asking' });
      expect(within(taken).getByText('Связанные задачи')).toBeInTheDocument();
      expect(within(taken).getByRole('button', { name: '#12 Checkout API' })).toBeInTheDocument();
      expect(within(taken).queryByRole('button', { name: 'Взять в работу' })).not.toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('leaves related tasks out when an older server has no tasks field', async () => {
    const user = userEvent.setup();
    shell();
    await openImprovements(user);
    for (const article of screen.getAllByRole('article')) {
      expect(within(article).queryByText('Related tasks')).not.toBeInTheDocument();
    }
  });

  it('shows the empty state without inventing an open improvement', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/improvements': [200, { improvements: [] }] });
    await openImprovements(user, 'Improvements');
    expect(await screen.findByText('Nothing yet. Operations puts here what it finds on its rounds.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'To decide' })).not.toBeInTheDocument();
  });

  it('shows a fetch failure without inventing improvement data', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/improvements': [500, { error: { code: 'internal', message: 'Something went wrong.' } }] });
    await openImprovements(user, 'Improvements');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(screen.queryByText('Nothing yet. Operations puts here what it finds on its rounds.')).not.toBeInTheDocument();
  });

  it('keeps dismissed improvements folded with their original text and no Take button', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/improvements': [200, { improvements: [{ ...IMPROVEMENTS[0]!, status: 'dismissed' }] }] });
    await openImprovements(user, 'Improvements');
    await user.click(screen.getByText('Set aside: 1'));
    const dismissed = await screen.findByRole('article', { name: 'Install jq on the nodes' });
    expect(dismissed).toHaveTextContent('Agents looked for jq on #4 and #9.');
    expect(dismissed).toHaveTextContent('Wendy, Operations');
    expect(within(dismissed).queryByRole('button', { name: 'Take into work' })).not.toBeInTheDocument();
  });

  it('are not there for people who see only some departments', async () => {
    const user = userEvent.setup();
    const calls = shell({}, listed('p6'));
    expect(await screen.findByRole('button', { name: /^Tasks/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Improvements/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('button', { name: /^Improvements/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/improvements')).toBe(false);
  });

  it('puts Improvements before Versions and Log out in the account menu and signs out', async () => {
    const user = userEvent.setup();
    let signedOut = false;
    shell({ 'POST /api/auth/logout': [200, {}] }, ME, () => {
      signedOut = true;
    });
    const navigation = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(navigation).queryByRole('button', { name: /^Improvements/ })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Account' }));
    const improvements = await screen.findByRole('button', { name: 'Improvements, 1 to decide' });
    const versions = screen.getByRole('button', { name: 'Versions' });
    const logout = screen.getByRole('button', { name: 'Log out' });
    expect(improvements.compareDocumentPosition(versions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(versions.compareDocumentPosition(logout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    await user.click(logout);
    await waitFor(() => expect(signedOut).toBe(true));
    expect(screen.queryByRole('button', { name: 'Improvements, 1 to decide' })).toBeNull();
  });

  it('reaches account actions with keyboard, returns focus on Escape, and opens Improvements', async () => {
    const user = userEvent.setup();
    shell();
    const account = await screen.findByRole('button', { name: 'Account' });
    account.focus();
    await user.keyboard('{Enter}');
    const improvements = await screen.findByRole('button', { name: 'Improvements, 1 to decide' });
    const versions = screen.getByRole('button', { name: 'Versions' });
    const profile = screen.getByRole('button', { name: 'Settings' });
    const companySettings = screen.getByRole('button', { name: 'Company settings' });
    const about = screen.getByRole('button', { name: 'About' });
    const logout = screen.getByRole('button', { name: 'Log out' });
    /* Before Improvements: the four themes, the custom template window, the two languages and Outbound. */
    for (let i = 0; i < 9; i += 1) await user.tab();
    expect(improvements).toHaveFocus();
    await user.tab();
    expect(versions).toHaveFocus();
    await user.tab();
    expect(profile).toHaveFocus();
    await user.tab();
    expect(companySettings).toHaveFocus();
    await user.tab();
    expect(about).toHaveFocus();
    await user.tab();
    expect(logout).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
    expect(account).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Improvements, 1 to decide' });
    for (let i = 0; i < 9; i += 1) await user.tab();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Improvements' })).toBeInTheDocument();
  });
});
