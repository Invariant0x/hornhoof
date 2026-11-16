import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { GoalView, Me, Org, Pipeline, TaskDetail, TaskLine } from '../src/types';
import { decisions, DEV_ORG, ME, mockApi, TASK_DETAIL } from './api-mock';
import { taskRoute } from './task-route';

/* Development's work on card payments for the company's goal of 500 subscribers: Maria answers for the department goal
   and its first task, Ivan for the company goal, the refund button and a fix that waits for him. */
const DEV = { id: 'd2', name: 'Development' };
const IVAN = { id: 'p1', name: 'Ivan' };
const MARIA = { id: 'p2', name: 'Maria' };
const BRUNO = { id: 'b1', name: 'Bruno', kind: 'worker' as const, role: null };
const COMPANY_GOAL: GoalView = { id: 'g1', number: 1, title: '500 subscribers', why: 'People pay for the shop.', department: null, parentId: null, responsible: IVAN, target: 500, current: 212, unit: 'subscribers', dueAt: null, status: 'active', progress: 0.424, done: 0, total: 0, version: 2 };
const DEPT_GOAL: GoalView = { ...COMPANY_GOAL, id: 'g2', number: 2, title: 'Card payments', why: 'Shops take cards.', department: DEV, parentId: 'g1', responsible: MARIA, target: null, current: null, unit: '', progress: 0.5, done: 1, total: 2, version: 0 };
const SERVES = { id: 'g2', number: 2, title: 'Card payments' };
const line = (over: Partial<TaskLine> & { id: string; number: number; title: string }): TaskLine => ({
  echelons: taskRoute(), brief: '', status: 'working', department: DEV, product: null, assignee: BRUNO, turn: null, parentId: null, waitsFor: [],
  createdAt: '2026-11-16T08:00:00.000Z', updatedAt: '2026-11-16T09:00:00.000Z', goal: null, responsible: IVAN, why: '', dueAt: null, pipelineId: null, pipelineStageId: null,
  time: { inStatusSince: '2026-11-16T08:00:00.000Z', workSeconds: 0, waitsOn: [] }, ...over,
});
const PAY = line({ id: 't21', number: 21, title: 'Take card payments', goal: SERVES, responsible: MARIA, why: 'Shops sell online.', pipelineId: 'pl1', pipelineStageId: 's1' });
const FORM = line({ id: 't22', number: 22, title: 'Card form', status: 'open', parentId: 't21', goal: SERVES, responsible: MARIA });
const REFUND = line({ id: 't23', number: 23, title: 'Refund button', status: 'review', goal: SERVES, waitsFor: [21] });
const LOGIN = line({ id: 't24', number: 24, title: 'Fix the login page', status: 'waiting', time: { inStatusSince: '2026-11-13T08:00:00.000Z', workSeconds: 0, waitsOn: [{ who: { kind: 'person', ...IVAN }, since: '2026-11-13T08:00:00.000Z' }] } });
const TASKS = [LOGIN, REFUND, FORM, PAY];
const PIPELINE: Pipeline = { id: 'pl1', department: DEV, name: 'Payments way', why: '', archived: false, version: 3, stages: [{ id: 's1', parentId: null, name: 'Build', ownerRole: 'DEV-BE', owner: null, position: 0 }, { id: 's2', parentId: 's1', name: 'Check', ownerRole: 'DEV-HEAD', owner: null, position: 0 }] };
const detail = (task: TaskLine, over: Partial<TaskDetail> = {}): TaskDetail => ({
  ...TASK_DETAIL, ...task, body: '', parent: null, after: [], neededFor: [], executor: BRUNO, createdBy: null, subtasks: [], log: [], requests: [], files: [], mayEdit: true, version: 4, ...over,
});
const ORG: Org = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: d.employees.map(e => (e.id === 'b1' ? { ...e, status: 'working' as const, task: { id: 't21', number: 21, title: 'Take card payments', echelons: taskRoute() } } : e)) })) };

function shell(path = '/tasks', routes: Record<string, unknown> = {}, me: Me = ME) {
  window.history.replaceState(null, '', path);
  const calls = mockApi({
    'GET /api/org': [200, ORG],
    'GET /api/requests': [200, decisions([])],
    'GET /api/turns': [200, { turns: [] }],
    'GET /api/tasks?status=all': [200, { tasks: TASKS }],
    'GET /api/goals': [200, { goals: [COMPANY_GOAL, DEPT_GOAL] }],
    'GET /api/pipelines': [200, { pipelines: [PIPELINE] }],
    'GET /api/task-departments': [200, { whole: true, departments: [{ id: 'd2', name: null, templateKey: 'development', mine: true, responsible: MARIA }] }],
    'GET /api/tasks/t21': [200, { task: detail(PAY, { subtasks: [FORM], neededFor: [{ id: 't23', number: 23, title: 'Refund button', status: 'review' }] }) }],
    'GET /api/tasks/t22': [200, { task: detail(FORM, { parent: { id: 't21', number: 21, title: 'Take card payments' } }) }],
    'GET /api/tasks/t23': [200, { task: detail(REFUND, { after: [{ id: 't21', number: 21, title: 'Take card payments', status: 'working' }] }) }],
    'GET /api/goals/g1': [200, { goal: COMPANY_GOAL, log: [] }],
    'GET /api/goals/g2': [200, { goal: DEPT_GOAL, log: [] }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(
    <LanguageProvider>
      <Shell me={me} onSignOut={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

const main = () => screen.findByRole('region', { name: /^(List|Board|Graph)$/ });
const rowOf = (list: HTMLElement, name: string) => within(list).getByRole('listitem', { name });
const card = (name: string) => screen.findByRole('complementary', { name });

describe('My tasks and View as', () => {
  it("lands on the person's own open tasks and goals, and shows another person's with View as", async () => {
    const user = userEvent.setup();
    shell();
    const list = await main();
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#24 Fix the login page', '#23 Refund button']));
    expect(screen.getByRole('region', { name: 'Your goals' })).toHaveTextContent('500 subscribers');
    expect(screen.getByRole('region', { name: 'Your goals' })).not.toHaveTextContent('Card payments');
    expect(screen.getByRole('region', { name: 'Waiting for you' })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'View as' }), 'p2');
    expect(location.search).toBe('?person=p2');
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#21 Take card payments']));
    expect(screen.getByRole('region', { name: 'Goals of Maria' })).toHaveTextContent('Card payments');
    /* Her subtasks wait folded under their task. */
    await user.click(within(rowOf(list, '#21 Take card payments')).getByRole('button', { name: 'Subtasks: 0 of 1 done' }));
    expect(rowOf(list, '#22 Card form')).toBeInTheDocument();
  });

  it('offers View as only to the CEO and the CEO delegate', async () => {
    shell('/tasks', {}, { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } });
    await main();
    expect(screen.queryByRole('combobox', { name: 'View as' })).not.toBeInTheDocument();
  });

  it('counts the work going on now and lists it, and what waits for the person', async () => {
    const user = userEvent.setup();
    shell();
    const side = await screen.findByRole('navigation', { name: 'Task lists' });
    await user.click(within(side).getByRole('button', { name: /^Working now/ }));
    const list = await main();
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#21 Take card payments']));
    await user.click(within(side).getByRole('button', { name: /^Waits for me/ }));
    expect(await screen.findByRole('region', { name: 'Waiting for you' })).toHaveTextContent('Fix the login page');
  });
});

describe('the views and the card', () => {
  it('opens the same card from the list, the board and the graph', async () => {
    const user = userEvent.setup();
    shell('/tasks?department=d2');
    const list = await main();
    await user.click(within(await waitFor(() => rowOf(list, '#21 Take card payments'))).getByRole('button', { name: 'Take card payments' }));
    expect(await card('#21 Take card payments')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('radio', { name: 'Board' }));
    const board = await main();
    const column = within(board).getByRole('region', { name: 'In work' });
    await user.click(within(within(column).getByRole('article', { name: '#21 Take card payments' })).getByRole('button', { name: 'Take card payments' }));
    expect(await card('#21 Take card payments')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('radio', { name: 'Graph' }));
    const graph = await main();
    await user.click(within(graph).getByRole('button', { name: /#21 Take card payments/ }));
    expect(await card('#21 Take card payments')).toBeInTheDocument();
  });

  it('puts the board into the stages of a chosen pipeline', async () => {
    shell('/tasks?department=d2&pipeline=pl1&view=board');
    const board = await main();
    await waitFor(() => expect(within(board).getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['Not started', 'Build', 'Check', 'Done']));
    expect(within(within(board).getByRole('region', { name: 'Build' })).getByRole('article', { name: '#21 Take card payments' })).toBeInTheDocument();
  });

  it('opens a subtask in its own card, and says what the task is for, who answers for it and what waits for it', async () => {
    const user = userEvent.setup();
    shell('/tasks/t21');
    const panel = await card('#21 Take card payments');
    const path = await within(panel).findByRole('navigation', { name: 'Where it belongs' });
    expect(path).toHaveTextContent('500 subscribers');
    expect(path).toHaveTextContent('Card payments');
    expect(panel).toHaveTextContent('Shops sell online.');
    const facts = within(panel).getByRole('definition', { name: 'Responsible' });
    expect(facts).toHaveTextContent('Maria');
    expect(within(panel).getByRole('definition', { name: 'Pipeline' })).toHaveTextContent('Payments way: Build');
    expect(within(panel).getByRole('region', { name: 'Needed for' })).toHaveTextContent('#23 Refund button');
    await user.click(within(within(panel).getByRole('region', { name: 'Subtasks' })).getByRole('button', { name: '#22 Card form' }));
    const sub = await card('#22 Card form');
    expect(within(sub).getByText('Subtask')).toBeInTheDocument();
    expect(within(sub).getByRole('navigation', { name: 'Where it belongs' })).toHaveTextContent('#21 Take card payments');
  });

  it('re-roots the graph from a card, with a breadcrumb back up to every goal', async () => {
    const user = userEvent.setup();
    shell('/tasks/t21');
    const panel = await card('#21 Take card payments');
    await user.click(within(panel).getByRole('button', { name: 'Graph from here' }));
    expect(location.search).toBe('?root=t21&view=graph');
    const graph = await main();
    const crumbs = within(graph).getByRole('navigation', { name: 'Graph from' });
    await waitFor(() => expect(within(graph).getAllByRole('button', { name: /^#2\d / }).map(b => b.textContent)).toEqual([expect.stringContaining('Take card payments'), expect.stringContaining('Card form')]));
    expect(within(crumbs).getByText('#21 Take card payments')).toHaveAttribute('aria-current', 'page');
    await user.click(within(crumbs).getByRole('button', { name: 'Card payments' }));
    expect(location.search).toBe('?goal=g2&view=graph');
    await waitFor(() => expect(within(graph).getByRole('button', { name: /#23 Refund button/ })).toBeInTheDocument());
    await user.click(within(crumbs).getByRole('button', { name: 'All goals' }));
    expect(location.search).toBe('?view=graph');
  });

  it('sends an edit with the version it read, and says in words why it was refused', async () => {
    const user = userEvent.setup();
    let refuse = false;
    const calls = shell('/tasks/t21', {
      'PATCH /api/tasks/t21': () => (refuse ? [409, { error: { code: 'conflict', message: 'changed', reason: 'task_changed' } }] : [200, { task: detail(PAY, { title: 'Take cards and wallets' }) }]),
    });
    const panel = await card('#21 Take card payments');
    await user.click(within(panel).getByRole('button', { name: 'Edit' }));
    const form = within(panel).getByRole('form', { name: 'Edit the task' });
    await user.clear(within(form).getByLabelText('Title'));
    await user.type(within(form).getByLabelText('Title'), 'Take cards and wallets');
    await user.selectOptions(within(form).getByLabelText('Responsible'), 'p1');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ version: 4, title: 'Take cards and wallets', responsible: 'p1' }));
    refuse = true;
    await user.click(await within(panel).findByRole('button', { name: 'Edit' }));
    const again = within(panel).getByRole('form', { name: 'Edit the task' });
    await user.type(within(again).getByLabelText('Why'), ' Fast.');
    await user.click(within(again).getByRole('button', { name: 'Save' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Someone changed this task meanwhile. Look at it again and retry.');
  });

  it('offers no edit to a person who does not act on the task', async () => {
    shell('/tasks/t21', { 'GET /api/tasks/t21': [200, { task: detail(PAY, { mayEdit: false }) }] });
    const panel = await card('#21 Take card payments');
    expect(within(panel).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('tells its history in plain words: status changes, edits and responsibility passed on', async () => {
    const log = [
      { kind: 'status', text: '', data: { fromStatus: 'open', toStatus: 'working' }, by: { kind: 'agent', id: 'b1', name: 'Bruno' }, at: '2026-11-16T08:10:00.000Z' },
      { kind: 'edited', text: '', data: { fields: ['title', 'why'] }, by: { kind: 'person', id: 'p2', name: 'Maria' }, at: '2026-11-16T08:20:00.000Z' },
      { kind: 'edited', text: 'Maria no longer reaches this place, so Ivan answers for it now.', data: { fields: ['responsible'], from: 'p2', to: 'p1' }, by: null, at: '2026-11-16T08:30:00.000Z' },
    ];
    shell('/tasks/t21', { 'GET /api/tasks/t21': [200, { task: detail(PAY, { log }) }] });
    const history = within(await card('#21 Take card payments')).getByRole('list', { name: 'Log' });
    expect(history).toHaveTextContent('Bruno moved it from Not started to In progress');
    expect(history).toHaveTextContent('Maria changed the title and the why');
    expect(history).toHaveTextContent('Maria no longer reaches this place, so Ivan answers for it now.');
  });
});

describe('a goal', () => {
  it('opens in the same panel with its progress, smaller goals and tasks, and is edited with its version', async () => {
    const user = userEvent.setup();
    const calls = shell('/tasks', { 'PATCH /api/goals/g1': [200, { goal: { ...COMPANY_GOAL, current: 230 } }] });
    const goals = await screen.findByRole('region', { name: 'Your goals' });
    await user.click(within(goals).getByRole('button', { name: '500 subscribers' }));
    expect(location.pathname + location.search).toBe('/tasks/g1?card=goal');
    const panel = await card('500 subscribers');
    expect(within(panel).getByText('Company goal')).toBeInTheDocument();
    expect(within(panel).getByRole('progressbar', { name: '212 of 500 subscribers' })).toBeInTheDocument();
    await user.click(within(within(panel).getByRole('region', { name: 'Smaller goals' })).getByRole('button', { name: 'Card payments' }));
    const smaller = await card('Card payments');
    expect(within(within(smaller).getByRole('region', { name: 'Tasks' })).getAllByRole('button').map(b => b.textContent)).toEqual(['#21 Take card payments', '#23 Refund button']);
    await user.click(within(within(smaller).getByRole('navigation', { name: 'Where it belongs' })).getByRole('button', { name: '500 subscribers' }));
    const big = await card('500 subscribers');
    await user.click(within(big).getByRole('button', { name: 'Edit' }));
    await user.clear(within(big).getByLabelText('Now'));
    await user.type(within(big).getByLabelText('Now'), '230');
    await user.click(within(big).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ path: '/api/goals/g1', body: { version: 2, current: 230 } }));
  });
});
