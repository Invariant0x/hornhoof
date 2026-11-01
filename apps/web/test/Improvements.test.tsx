import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { Improvement, Me } from '../src/types';
import { DEV_ORG, ME, mockApi, TASK_DETAIL } from './api-mock';
import { fakeStream } from './fake-stream';
import { PRESENTATION } from './improvement-presentation-fixture';

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
const listed = (id: string): Me => ({ ...ME, person: { ...ME.person, id, name: 'Lena', scopeKind: 'listed', isOwner: false } });

function shell(routes: Record<string, unknown> = {}, me: Me = ME) {
  const calls = mockApi({
    'GET /api/org': [200, DEV_ORG],
    'GET /api/requests': [200, { requests: [] }],
    'GET /api/improvements': [200, { improvements: IMPROVEMENTS }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(
    <LanguageProvider>
      <Shell me={me} onSignOut={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

async function openImprovements(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Improvements, 1 to decide' }));
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
      await user.click(await screen.findByRole('button', { name: /^Улучшения/ }));
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
    const secondLink = within(taken).getByRole('button', { name: '#13 Refunds' });
    const done = within(screen.getByRole('region', { name: 'Done' })).getByRole('article', { name: 'Move security to Kimi' });
    expect(within(done).getAllByRole('button', { name: /^#/ })).toHaveLength(1);
    await user.click(firstLink);
    expect(await screen.findByRole('complementary', { name: '#12 Checkout API' })).toBeInTheDocument();
    await user.click(secondLink);
    expect(await screen.findByRole('complementary', { name: '#13 Refunds' })).toBeInTheDocument();
  });

  it('keeps taken out of the open count and shows Take only for open improvements', async () => {
    const user = userEvent.setup();
    shell();
    await openImprovements(user);
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
    expect(screen.getByRole('button', { name: 'Improvements' })).toBeInTheDocument();
  });

  it('shows related tasks in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      const user = userEvent.setup();
      const linked = { id: 't12', number: 12, title: 'Checkout API' };
      shell({ 'GET /api/improvements': [200, { improvements: [IMPROVEMENTS[0]!, { ...IMPROVEMENTS[1]!, tasks: [linked] }, IMPROVEMENTS[2]!] }] });
      await user.click(await screen.findByRole('button', { name: /^Улучшения/ }));
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
    await user.click(await screen.findByRole('button', { name: 'Improvements' }));
    expect(await screen.findByText('Nothing yet. Operations puts here what it finds on its rounds.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'To decide' })).not.toBeInTheDocument();
  });

  it('shows a fetch failure without inventing improvement data', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/improvements': [500, { error: { code: 'internal', message: 'Something went wrong.' } }] });
    await user.click(await screen.findByRole('button', { name: 'Improvements' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(screen.queryByText('Nothing yet. Operations puts here what it finds on its rounds.')).not.toBeInTheDocument();
  });

  it('keeps dismissed improvements folded with their original text and no Take button', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/improvements': [200, { improvements: [{ ...IMPROVEMENTS[0]!, status: 'dismissed' }] }] });
    await user.click(await screen.findByRole('button', { name: 'Improvements' }));
    await user.click(screen.getByText('Set aside: 1'));
    const dismissed = await screen.findByRole('article', { name: 'Install jq on the nodes' });
    expect(dismissed).toHaveTextContent('Agents looked for jq on #4 and #9.');
    expect(dismissed).toHaveTextContent('Wendy, Operations');
    expect(within(dismissed).queryByRole('button', { name: 'Take into work' })).not.toBeInTheDocument();
  });

  it('shows a ready explanation and keeps the original, metadata, task links and actions intact', async () => {
    const user = userEvent.setup();
    const linked = { id: 't12', number: 12, title: 'Checkout API' };
    const calls = shell({
      'GET /api/improvements': [200, { improvements: [{ ...IMPROVEMENTS[0]!, presentation: PRESENTATION, tasks: [linked] }] }],
      'POST /api/improvements/i1/take': [200, { improvement: { id: 'i1', status: 'taken' } }],
    });
    await openImprovements(user);
    const card = await screen.findByRole('article', { name: PRESENTATION.locales.en.title });
    expect(within(card).queryByRole('heading', { name: IMPROVEMENTS[0]!.title })).not.toBeInTheDocument();
    expect(card).toHaveTextContent('What happened');
    expect(card).toHaveTextContent(PRESENTATION.locales.en.observation);
    expect(card).toHaveTextContent('Who it affects and how');
    expect(card).toHaveTextContent('Proposed change');
    expect(card).toHaveTextContent('Expected result');
    expect(card).toHaveTextContent('Confirmed facts');
    expect(card).toHaveTextContent(PRESENTATION.locales.en.facts[0]!.text);
    expect(card).toHaveTextContent('ev-1');
    expect(card).toHaveTextContent('Hypotheses');
    expect(card).toHaveTextContent('Still unknown');
    expect(card).toHaveTextContent('Wendy, Operations');
    expect(card).toHaveTextContent('Found 3 times');
    expect(within(card).getByRole('button', { name: '#12 Checkout API' })).toBeInTheDocument();
    const details = within(card).getByText('Evidence and technical details').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('Original proposal');
    expect(details).toHaveTextContent(IMPROVEMENTS[0]!.title);
    expect(details).toHaveTextContent('Agents looked for jq on #4 and #9.');
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    await user.click(within(card).getByRole('button', { name: 'Take into work' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/api/improvements/i1/take')).toBe(true));
  });

  it('uses the complete Russian explanation instead of translating it in the browser', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      const user = userEvent.setup();
      shell({ 'GET /api/improvements': [200, { improvements: [{ ...IMPROVEMENTS[0]!, presentation: PRESENTATION }] }] });
      await user.click(await screen.findByRole('button', { name: /^Улучшения/ }));
      const card = await screen.findByRole('article', { name: PRESENTATION.locales.ru.title });
      expect(card).toHaveTextContent('Что произошло');
      expect(card).toHaveTextContent(PRESENTATION.locales.ru.observation);
      expect(card).toHaveTextContent('Кого это затрагивает и как');
      expect(card).toHaveTextContent('Что предлагается изменить');
      expect(card).toHaveTextContent('Ожидаемый результат');
      expect(card).toHaveTextContent('Подтверждено');
      expect(card).toHaveTextContent(PRESENTATION.locales.ru.facts[0]!.text);
      expect(card).toHaveTextContent('Гипотезы');
      expect(card).toHaveTextContent('Пока неизвестно');
      expect(within(card).getByText('Доказательства и технические подробности')).toBeInTheDocument();
      expect(card).not.toHaveTextContent(PRESENTATION.locales.en.observation);
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('marks a draft and keeps the original instead of presenting it as ready', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/improvements': [200, { improvements: [{ ...IMPROVEMENTS[0]!, presentation: { ...PRESENTATION, state: 'draft' } }] }] });
    await openImprovements(user);
    const card = await screen.findByRole('article', { name: IMPROVEMENTS[0]!.title });
    expect(card).toHaveTextContent('Draft: source details are missing.');
    expect(card).toHaveTextContent('Agents looked for jq on #4 and #9.');
    expect(card).not.toHaveTextContent(PRESENTATION.locales.en.observation);
  });

  it('keeps a legacy improvement unchanged without inventing an explanation', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/improvements': [200, { improvements: [{ ...IMPROVEMENTS[0]!, presentation: null }] }] });
    await openImprovements(user);
    const card = await screen.findByRole('article', { name: IMPROVEMENTS[0]!.title });
    expect(card).toHaveTextContent('Agents looked for jq on #4 and #9.');
    expect(within(card).queryByText('What happened')).not.toBeInTheDocument();
    expect(within(card).queryByText('Evidence and technical details')).not.toBeInTheDocument();
  });

  it('does not substitute English for a missing Russian locale', async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      const user = userEvent.setup();
      shell({ 'GET /api/improvements': [200, { improvements: [{ ...IMPROVEMENTS[0]!, presentation: { ...PRESENTATION, locales: { en: PRESENTATION.locales.en } } }] }] });
      await user.click(await screen.findByRole('button', { name: /^Улучшения/ }));
      const card = await screen.findByRole('article', { name: IMPROVEMENTS[0]!.title });
      expect(card).toHaveTextContent('Это объяснение еще не готово на вашем языке.');
      expect(card).not.toHaveTextContent(PRESENTATION.locales.en.observation);
      expect(card).toHaveTextContent('Agents looked for jq on #4 and #9.');
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('are not there for people who see only some departments', async () => {
    const calls = shell({}, listed('p6'));
    expect(await screen.findByRole('button', { name: /^Tasks/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Improvements/ })).toBeNull();
    expect(calls.some(c => c.path === '/api/improvements')).toBe(false);
  });
});
