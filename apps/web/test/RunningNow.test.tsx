import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { RunningNow } from '../src/ui/RunningNow';
import { LanguageProvider } from '../src/i18n';
import { fixedAt, ME, RUNNING_AGENTS } from './api-mock';

it.each([
  ['en', 'Test runs', '1 agent', '1 test run'],
  ['ru', 'Прогоны тестов', '1 агент', '1 прогон тестов'],
])('omits zero block counters and names test runs in %s', (language, tests, agentCount, testCount) => {
  localStorage.setItem('hh-lang', language);
  const view = render(<LanguageProvider><RunningNow title="Running now" label="Work" agents={[]} me={ME} /></LanguageProvider>);
  expect(view.container.querySelector('.run-count')).toBeNull();
  view.rerender(<LanguageProvider><RunningNow title="Running now" label="Work" agents={[RUNNING_AGENTS[1]!]} me={ME} /></LanguageProvider>);
  expect(view.container.querySelector('.run-count')?.textContent).toBe(agentCount);
  view.rerender(<LanguageProvider><RunningNow title="Running now" label="Work" agents={[]} parts={[{ kind: 'tests', run: 1, task: null, part: 1, parts: 1, agent: null, startedAt: null }]} me={ME} /></LanguageProvider>);
  expect(view.container.querySelector('.run-count')?.textContent).toBe(testCount);
  expect(screen.getByRole('region', { name: tests })).toBeInTheDocument();
  localStorage.clear();
});

it('groups in department order, puts the company first and working agents first, and folds large groups', async () => {
  fixedAt();
  const dev = Array.from({ length: 8 }, (_, i) => ({ ...RUNNING_AGENTS[1]!, id: `d${i}`, name: `Dev ${i}`, busy: i === 7, since: new Date(Date.now() - 12 * 60_000).toISOString() }));
  const sales = Array.from({ length: 5 }, (_, i) => ({ ...dev[0]!, id: `s${i}`, name: `Sales ${i}`, department: { id: 'sales', name: 'Sales' } }));
  const ceo = { ...dev[0]!, id: 'o', name: 'Orchestrator', department: null, busy: true, withCeo: true };
  render(<RunningNow title="Running now" label="Work" agents={[...dev, ...sales, ceo]} me={ME} />);
  const regions = within(screen.getByRole('region', { name: 'Work' })).getAllByRole('region');
  expect(regions.map(r => r.getAttribute('aria-label'))).toEqual(['Company', 'Development', 'Sales']);
  expect(screen.getByText('14 agents, 2 working')).toBeInTheDocument();
  expect(within(regions[1]!).getByText('8 agents, 1 working')).toBeInTheDocument();
  expect(within(regions[1]!).getAllByRole('listitem')[0]).toHaveTextContent('Dev 7');
  expect(screen.getByText('with you')).toBeInTheDocument();
  expect(screen.getAllByText('12 min')).toHaveLength(2);
  const more = screen.getByRole('button', { name: 'Show 3 more in Development' });
  expect(more).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(more);
  expect(within(regions[1]!).getAllByRole('listitem')).toHaveLength(9);
  const less = screen.getByRole('button', { name: 'Show less' });
  expect(less).toHaveAttribute('aria-expanded', 'true');
  await userEvent.click(less);
  expect(screen.getByRole('button', { name: 'Show 3 more in Development' })).toBeInTheDocument();
});

it('hides with you from other people, shows task tooltips and role titles, and leaves untasked turns with just minutes', () => {
  fixedAt();
  const agents = [RUNNING_AGENTS[0]!, { ...RUNNING_AGENTS[0]!, id: 'other', name: 'Other', task: null, withCeo: true }];
  render(<RunningNow title="Agents on it" label="Agents on it" agents={agents} me={{ ...ME, person: { ...ME.person, isOwner: false } }} />);
  expect(screen.getByTitle('Checkout API')).toHaveTextContent('#12');
  expect(screen.getAllByText('Backend engineer')).toHaveLength(2);
  expect(screen.queryByText('with you')).not.toBeInTheDocument();
  expect(screen.getAllByText('12 min')).toHaveLength(2);
});
