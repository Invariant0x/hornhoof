import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { Improvement, Me } from '../src/types';
import { DEV_ORG, ME, mockApi } from './api-mock';

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

  it('are not there for people who see only some departments', async () => {
    const calls = shell({}, listed('p6'));
    expect(await screen.findByRole('button', { name: /^Tasks/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Improvements/ })).toBeNull();
    expect(calls.some(c => c.path === '/api/improvements')).toBe(false);
  });
});
