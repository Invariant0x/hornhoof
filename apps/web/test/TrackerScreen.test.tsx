import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { GoalView, Me, Org, Pipeline, TaskDetail, TaskLine, TaskLogLine } from '../src/types';
import { decisions, DEV_ORG, ME, mockApi, TASK_DETAIL, TURN } from './api-mock';
import { taskRoute } from './task-route';

const listed = (id: string, name: string): Me => ({ ...ME, person: { ...ME.person, id, name, scopeKind: 'listed', isOwner: false } });

/* Development's work on card payments for the company's goal of 500 subscribers: Maria answers for the department goal
   and its first task, Ivan for the company goal, the refund button and a fix that waits for him. */
const DEV = { id: 'd2', name: 'Development' };
const IVAN = { id: 'p1', name: 'Ivan' };
const MARIA = { id: 'p2', name: 'Maria' };
const BRUNO = { id: 'b1', name: 'Bruno', kind: 'worker' as const, role: null };
const COMPANY_GOAL: GoalView = { id: 'g1', number: 1, title: '500 subscribers', why: 'People pay for the shop.', department: null, parentId: null, responsible: IVAN, target: 500, current: 212, unit: 'subscribers', dueAt: null, status: 'active', progress: 0.424, done: 0, total: 0, version: 2, mayEdit: true };
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
const LOGIN = line({ id: 't24', number: 24, title: 'Fix the login page', status: 'waiting', time: { inStatusSince: '2026-11-13T08:00:00.000Z', workSeconds: 0, waitsOn: [{ kind: 'person', who: { kind: 'person', ...IVAN }, reason: null, since: '2026-11-13T08:00:00.000Z' }] } });
const TASKS = [LOGIN, REFUND, FORM, PAY];
const PIPELINE: Pipeline = { id: 'pl1', department: DEV, name: 'Payments way', why: '', archived: false, version: 3, mayEdit: true, stages: [{ id: 's1', parentId: null, name: 'Build', ownerRole: 'DEV-BE', owner: null, position: 0 }, { id: 's2', parentId: 's1', name: 'Check', ownerRole: 'DEV-HEAD', owner: null, position: 0 }] };
const detail = (task: TaskLine, over: Partial<TaskDetail> = {}): TaskDetail => ({
  ...TASK_DETAIL, ...task, body: '', parent: null, after: [], neededFor: [], executor: BRUNO, createdBy: null, subtasks: [], log: [], requests: [], files: [], mayEdit: true, version: 4, revision: 1, ...over,
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
    'GET /api/task-departments': [200, { whole: true, mayPlanCompany: true, departments: [{ id: 'd2', name: null, templateKey: 'development', mine: true, mayPlan: true, responsible: MARIA }] }],
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
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#23 Refund button', '#24 Fix the login page']));
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

  it("shows a person who may not use View as their own screen, whoever's the address names", async () => {
    shell('/tasks?person=p2', {}, { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } });
    const list = await main();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('My tasks');
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#23 Refund button', '#24 Fix the login page']));
    expect(screen.getByRole('region', { name: 'Your goals' })).toHaveTextContent('500 subscribers');
    expect(screen.queryByRole('region', { name: 'Goals of Maria' })).not.toBeInTheDocument();
    expect(screen.queryByText('Decisions for Maria')).not.toBeInTheDocument();
  });

  it("keeps the map's way to another person's decisions for anyone, among the decisions they see", async () => {
    shell('/tasks?show=waits&person=p2', {}, { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } });
    expect(await screen.findByText('Decisions for Maria')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'View as' })).not.toBeInTheDocument();
  });

  it("titles a named wait list for that person and labels only the waits they can act on", async () => {
    const since = '2026-11-13T08:00:00.000Z';
    const external = { kind: 'external' as const, who: null, reason: 'Deployment', since };
    const forMaria = line({ ...LOGIN, id: 'maria', number: 26, title: 'Ask Maria', time: { inStatusSince: since, workSeconds: 0, waitsOn: [external, { kind: 'person', who: { kind: 'person', ...MARIA }, reason: null, since }] } });
    const ownedByMaria = line({ ...LOGIN, id: 'run', number: 27, title: 'Run the checks', time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind: 'run', who: { kind: 'person', ...MARIA }, reason: '108', since }] } });
    shell('/tasks?show=waits&person=p2', { 'GET /api/tasks?status=all': [200, { tasks: [LOGIN, forMaria, ownedByMaria] }] }, listed('p1', 'Ivan'));
    const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
    expect(await within(waiting).findByRole('heading', { name: 'Tasks that wait for Maria' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Waits for Maria');
    expect(waiting).toHaveTextContent('Ask Maria');
    expect(waiting).toHaveTextContent('Waits for Maria');
    expect(waiting).not.toHaveTextContent(/Fix the login page|Run the checks|Deployment/);
  });

  it("opens another person's screen from the address for the CEO delegate", async () => {
    shell('/tasks?person=p2', {}, { ...ME, person: { ...ME.person, isOwner: false, isCeoDelegate: true } });
    const list = await main();
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#21 Take card payments']));
    expect(screen.getByRole('region', { name: 'Goals of Maria' })).toHaveTextContent('Card payments');
  });

  it('shows people with wait counts and opens department goals, dates and tasks without a pipeline', async () => {
    const user = userEvent.setup();
    shell('/tasks?department=d2', { 'GET /api/tasks?status=all': [200, { tasks: [
      ...TASKS, line({ id: 'dated', number: 42, title: 'Deliver the list', dueAt: '2026-12-01T00:00:00.000Z' }),
    ] }] });
    const side = await screen.findByRole('navigation', { name: 'Task lists' });
    expect(within(side).getByRole('heading', { name: 'Company people' })).toBeInTheDocument();
    await act(async () => {});
    const ivan = within(side).getByRole('button', { name: 'Ivan 1' });
    expect(ivan.querySelector('.tr-avatar')).toBeInTheDocument();
    expect(ivan.querySelector('.tr-count')).toHaveClass('attention');
    expect(within(side).getByRole('button', { name: /^My tasks / }).querySelector('.tr-count')).not.toHaveClass('attention');
    const dept = within(side).getByRole('button', { name: 'Development' });
    expect(dept.querySelector('.tr-dept-mark')).toBeInTheDocument();
    await user.click(within(side).getByRole('button', { name: 'Department goals' }));
    expect(screen.getByRole('region', { name: 'Department goals' })).toHaveTextContent('Card payments');
    await user.click(within(side).getByRole('button', { name: 'Without a pipeline' }));
    const list = screen.getByRole('region', { name: 'List' });
    expect(within(list).getByRole('listitem', { name: '#42 Deliver the list' })).toBeInTheDocument();
    expect(within(list).queryByRole('listitem', { name: '#21 Take card payments' })).toBeNull();
    await user.click(within(side).getByRole('button', { name: 'Due dates' }));
    expect(screen.getByRole('region', { name: 'Due dates' })).toHaveTextContent('Deliver the list');
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
  it('keeps the pipeline breadcrumb and search with the picker, and opens the added view controls', async () => {
    const user = userEvent.setup();
    shell('/tasks?department=d2&pipeline=pl1');
    await act(async () => {});
    const title = screen.getByRole('heading', { level: 1, name: 'Development / Payments way' });
    expect(title.querySelector('.tr-dept-mark')).toHaveAttribute('data-tone', 'accent');
    const picker = screen.getByRole('combobox', { name: 'View as' });
    expect(within(picker).getByRole('option', { name: 'Me, Ivan' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search tasks' }).closest('header')).toContainElement(picker);
    await user.selectOptions(picker, 'p2');
    expect(location.search).toBe('?department=d2&pipeline=pl1&person=p2');
    expect(screen.getByRole('heading', { level: 1, name: 'Development / Payments way' })).toBeInTheDocument();
    const tabs = screen.getByRole('group', { name: 'View' });
    expect(within(tabs).getAllByRole('radio').map(tab => tab.parentElement?.textContent)).toEqual(['List', 'Board', 'Due dates', 'Goals', 'Pipeline diagram']);
    expect(tabs.querySelectorAll('svg')).toHaveLength(6);
    const filters = screen.getByRole('group', { name: 'Filters' });
    expect(filters).toHaveTextContent('Group: status');
    const toggle = within(filters).getByRole('button', { name: 'Subtasks: show' });
    await user.click(toggle);
    expect(toggle).toHaveTextContent('Subtasks: hide');
    await user.selectOptions(within(filters).getByLabelText('Goal'), 'g2');
    expect(filters).toHaveTextContent('Goal: Card payments');
    await user.click(within(tabs).getByRole('radio', { name: 'Due dates' }));
    expect(screen.getByRole('region', { name: 'Due dates' })).toHaveTextContent('No tasks here have a due date.');
    await user.click(within(tabs).getByRole('button', { name: 'Add view' }));
    expect(screen.getByText('There are no saved views yet.')).toBeInTheDocument();
  });

  it('orders list tasks by priority and shows it in the row and the card', async () => {
    const user = userEvent.setup();
    const high = line({ ...PAY, priority: 'high' });
    const normal = line({ id: 't25', number: 25, title: 'Later task' });
    shell('/tasks?department=d2', { 'GET /api/tasks?status=all': [200, { tasks: [normal, high] }], 'GET /api/tasks/t21': [200, { task: detail(high) }] });
    const list = await main();
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#21 Take card payments', '#25 Later task']));
    expect(rowOf(list, '#21 Take card payments')).toHaveTextContent('High');
    expect(rowOf(list, '#25 Later task')).toHaveTextContent('Normal');
    await user.click(within(list).getByRole('button', { name: 'Take card payments' }));
    expect(within(await card('#21 Take card payments')).getByRole('definition', { name: 'Priority' })).toHaveTextContent('High');
  });

  it('shows the run in the list and the person who set the wait and its deadline on the card', async () => {
    const user = userEvent.setup();
    const since = '2026-11-17T21:45:00.000Z';
    const reason = `Rerun 108 on ${'turn-32'.repeat(30)} then release_turn`;
    const run = line({ id: 'run', number: 1289, title: 'Release the turn', executor: BRUNO,
      externalWait: { reason, since, until: new Date(2099, 10, 17, 22, 35).toISOString() },
      time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind: 'run', who: null, reason: '108', since }] } });
    shell('/tasks?department=d2', { 'GET /api/tasks?status=all': [200, { tasks: [run] }], 'GET /api/tasks/run': [200, { task: detail(run) }] });
    const list = await main();
    const row = await waitFor(() => rowOf(list, '#1289 Release the turn'));
    expect(row).toHaveTextContent('Test run 108 is running');
    expect(within(list).getByRole('heading', { name: 'In work: 1' })).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Release the turn' }));
    const panel = await card('#1289 Release the turn');
    expect(panel).toHaveTextContent('Test run 108 is running');
    expect(panel).toHaveTextContent(reason);
    expect(panel).toHaveTextContent('set by Bruno, until 22:35');
  });

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
    /* Every goal of the company, not the person's own tasks. */
    expect(location.search).toBe('?show=company&view=graph');
    expect(await screen.findByRole('heading', { level: 1, name: 'All goals and tasks' })).toBeInTheDocument();
    await waitFor(() => expect(within(graph).getByRole('button', { name: /500 subscribers/ })).toBeInTheDocument());
    expect(within(graph).getByRole('button', { name: /#24 Fix the login page/ })).toBeInTheDocument();
  });

  it('names the one who does a task alike in the list, on the board and in the filter, as its card does', async () => {
    const user = userEvent.setup();
    const RITA = { id: 'b2', name: 'Rita', kind: 'worker' as const, role: null };
    /* Bruno wrote the refund button; Rita, who checks it, holds it now. */
    const checked = { ...REFUND, executor: BRUNO, assignee: RITA };
    shell('/tasks?department=d2', { 'GET /api/tasks?status=all': [200, { tasks: [LOGIN, checked, FORM, { ...PAY, assignee: RITA, executor: null }] }] });
    const list = await main();
    const row = await waitFor(() => rowOf(list, '#23 Refund button'));
    expect(within(row).getByRole('img', { name: 'Bruno' })).toBeInTheDocument();
    expect(within(row).queryByRole('img', { name: 'Rita' })).toBeNull();
    const executor = within(screen.getByRole('group', { name: 'Filters' })).getByLabelText('Executor');
    expect(within(executor).getAllByRole('option').map(o => o.textContent)).toEqual(['Any', 'Bruno', 'Rita']);
    await user.selectOptions(executor, 'Bruno');
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#23 Refund button', '#24 Fix the login page', '#22 Card form']));
    await user.click(screen.getByRole('radio', { name: 'Board' }));
    const board = await main();
    expect(within(board).getByRole('article', { name: '#23 Refund button' })).toHaveTextContent('Does it: Bruno');
  });

  it("counts a task's subtasks over all the work under it, those done and those others answer for too", async () => {
    const mail = line({ id: 't26', number: 26, title: 'Refund mail', status: 'done', parentId: 't23', goal: SERVES });
    const form = line({ id: 't27', number: 27, title: 'Refund form', parentId: 't23', goal: SERVES, responsible: MARIA });
    shell('/tasks?view=board', { 'GET /api/tasks?status=all': [200, { tasks: [...TASKS, mail, form] }] });
    const board = await main();
    await waitFor(() => expect(within(board).getByRole('article', { name: '#23 Refund button' })).toHaveTextContent('subtasks: 1 of 2'));
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
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ version: 4, revision: 1, title: 'Take cards and wallets', responsible: 'p1' }));
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
    const log: TaskLogLine[] = [
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

describe('the list', () => {
  it('shows done work at the bottom and shows cancelled work only under its filter', async () => {
    const user = userEvent.setup();
    const shipped = line({ id: 't19', number: 19, title: 'Price page', status: 'done' });
    const dropped = line({ id: 't18', number: 18, title: 'Old checkout', status: 'cancelled' });
    shell('/tasks?department=d2', { 'GET /api/tasks?status=all': [200, { tasks: [...TASKS, shipped, dropped] }] });
    const list = await main();
    const done = await within(list).findByRole('button', { name: 'Done: 1' });
    expect([...list.querySelectorAll('h2 button')].map(b => b.getAttribute('aria-label'))).toEqual(['In work: 2', 'Waits for a person: 1', 'Done: 1']);
    expect(within(list).getByRole('listitem', { name: '#19 Price page' })).toBeInTheDocument();
    await user.click(done);
    expect(within(list).queryByRole('listitem', { name: '#19 Price page' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('listitem', { name: '#18 Old checkout' })).not.toBeInTheDocument();
    await user.selectOptions(within(screen.getByRole('group', { name: 'Filters' })).getByLabelText('Status'), 'Cancelled');
    await user.click(await within(list).findByRole('button', { name: 'Cancelled: 1' }));
    expect(within(list).getByRole('listitem', { name: '#18 Old checkout' })).toBeInTheDocument();
  });
});

describe('making work in a department', () => {
  const places = (mayPlan: boolean) => ({ 'GET /api/task-departments': [200, { whole: false, mayPlanCompany: false, departments: [{ id: 'd2', name: null, templateKey: 'development', mine: true, mayPlan, responsible: MARIA }] }] });

  it('gives the department a task through its head, and opens its card', async () => {
    const user = userEvent.setup();
    const made = detail(line({ id: 't25', number: 25, title: 'Refund API', status: 'open' }));
    const calls = shell('/tasks?department=d2', { 'POST /api/tasks': [201, { task: made }], 'GET /api/tasks/t25': [200, { task: made }] });
    await main();
    await user.click(screen.getByRole('button', { name: 'New task' }));
    expect(screen.getByText('Dana, the head, gets it and splits it among the department.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Refund API');
    await user.type(screen.getByLabelText('In one line'), 'Give the money back.');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path === '/api/tasks')?.body).toMatchObject({ title: 'Refund API', brief: 'Give the money back.', department: 'd2' }));
    expect(await card('#25 Refund API')).toBeInTheDocument();
  });

  it('gives a group task its pipeline and the priority chosen in the form', async () => {
    const user = userEvent.setup();
    const made = detail(line({ id: 't25', number: 25, title: 'New payment option', pipelineId: 'pl1', priority: 'high' }));
    const calls = shell('/tasks?department=d2&pipeline=pl1', { 'POST /api/tasks': [201, { task: made }], 'GET /api/tasks/t25': [200, { task: made }] });
    const list = await main();
    await user.click(within(list).getByRole('button', { name: 'Add task' }));
    await user.type(screen.getByLabelText('Title'), 'New payment option');
    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await card('#25 New payment option');
    expect(calls.find(c => c.method === 'POST' && c.path === '/api/tasks')?.body).toMatchObject({ title: 'New payment option', department: 'd2', pipeline: 'pl1', priority: 'high' });
  });

  it('says the head gets a new task without naming it twice when it is called after its role', async () => {
    const user = userEvent.setup();
    const [dev] = ORG.departments;
    shell('/tasks?department=d2', { 'GET /api/org': [200, { ...ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => (e.kind === 'head' ? { ...e, name: e.title!.en } : e)) }] }] });
    await main();
    await user.click(screen.getByRole('button', { name: 'New task' }));
    expect(screen.getByText('The head gets it and splits it among the department.')).toBeInTheDocument();
  });

  it('asks for a head before the department takes tasks', async () => {
    const [dev] = ORG.departments;
    shell('/tasks?department=d2', { 'GET /api/org': [200, { ...ORG, departments: [{ ...dev!, employees: [] }] }] });
    expect(await screen.findByText('Tasks go to the department through its head. Hire one first.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
  });

  it('lets a person give the department tasks, goals and pipelines where the server says they plan, and nowhere else', async () => {
    shell('/tasks?department=d2', places(true), listed('p6', 'Lena'));
    expect(await screen.findByRole('button', { name: 'New task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New goal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New pipeline' })).toBeInTheDocument();
    cleanup();
    /* Kira has only a product of the department: she reads its work and gives it none. */
    shell('/tasks?department=d2', places(false), listed('p7', 'Kira'));
    await main();
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New goal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New pipeline' })).not.toBeInTheDocument();
  });

  it("offers a company goal only to a person the server lets set the company's goals", async () => {
    shell('/tasks', { 'GET /api/task-departments': [200, { whole: true, mayPlanCompany: false, departments: [] }] });
    await main();
    expect(screen.queryByRole('button', { name: 'New goal' })).not.toBeInTheDocument();
    cleanup();
    shell('/tasks');
    expect(await screen.findByRole('button', { name: 'New goal' })).toBeInTheDocument();
  });

  it('offers to change a goal or a pipeline only when the server says the person may', async () => {
    shell('/tasks/g1?card=goal', { 'GET /api/goals/g1': [200, { goal: { ...COMPANY_GOAL, mayEdit: false }, log: [] }] });
    const goal = await card('500 subscribers');
    for (const name of ['Edit', 'Mark as reached', 'Drop the goal']) expect(within(goal).queryByRole('button', { name })).not.toBeInTheDocument();
    cleanup();
    /* Kira has the Mascot product only, and sets its goals. */
    const mascot = { ...DEPT_GOAL, id: 'g5', title: 'Mascot shop', department: { id: 'pd1', name: 'Mascot' }, mayEdit: true };
    shell('/tasks/g5?card=goal', { ...places(false), 'GET /api/goals/g5': [200, { goal: mascot, log: [] }] }, listed('p7', 'Kira'));
    const own = await card('Mascot shop');
    for (const name of ['Edit', 'Mark as reached', 'Drop the goal']) expect(within(own).getByRole('button', { name })).toBeInTheDocument();
    cleanup();
    shell('/tasks?department=d2&pipeline=pl1', { 'GET /api/pipelines': [200, { pipelines: [{ ...PIPELINE, mayEdit: false }] }] });
    expect(await screen.findByRole('button', { name: 'New pipeline' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change the pipeline' })).not.toBeInTheDocument();
  });

  it('drafts a pipeline of the department with its stages and the roles that do them', async () => {
    const user = userEvent.setup();
    const calls = shell('/tasks?department=d2', { 'POST /api/pipelines': [201, { pipeline: PIPELINE }] });
    await main();
    await user.click(screen.getByRole('button', { name: 'New pipeline' }));
    const form = screen.getByRole('form', { name: 'New pipeline' });
    await user.type(within(form).getByLabelText('Name'), 'Refunds');
    await user.click(within(form).getByRole('button', { name: 'Add a stage' }));
    await user.click(within(form).getByRole('button', { name: 'Add a stage' }));
    const [first, second] = within(form).getAllByRole('group', { name: /^Stage \d$/ });
    await user.type(within(first!).getByLabelText('Name of the stage'), 'Build');
    await user.selectOptions(within(first!).getByLabelText('Who does it'), 'Backend engineer');
    await user.type(within(second!).getByLabelText('Name of the stage'), 'Check');
    await user.selectOptions(within(second!).getByLabelText('Who does it'), 'Dana');
    expect(within(second!).getByLabelText('Comes after')).toHaveDisplayValue('Build');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path === '/api/pipelines')?.body).toEqual({
      department: 'd2', name: 'Refunds', why: '',
      stages: [{ key: 'n1', parent: null, name: 'Build', ownerRole: 'DEV-BE' }, { key: 'n2', parent: 'n1', name: 'Check', ownerAgentId: 'b0' }],
    }));
  });
});

it('fits the lists directly beside the main header with its breadcrumb, viewer and search', async () => {
  shell('/tasks?department=d2&pipeline=pl1');
  await main();
  const side = screen.getByRole('navigation', { name: 'Task lists' });
  const heading = screen.getByRole('heading', { name: 'Development / Payments way' });
  const header = heading.closest('header');
  const tracker = side.parentElement;
  expect(tracker).toHaveClass('fit');
  expect(tracker?.firstElementChild).toBe(side);
  expect(header).toContainElement(screen.getByRole('combobox', { name: 'View as' }));
  expect(header?.lastElementChild).toContainElement(screen.getByRole('searchbox', { name: 'Search tasks' }));
  expect(screen.getByRole('group', { name: 'View' })).toContainElement(screen.getByRole('radio', { name: 'Board' }));
  expect(screen.getByRole('group', { name: 'Filters' })).toContainElement(screen.getByRole('combobox', { name: 'Status' }));
});

it('counts a task with a question once and counts failed tasks separately', async () => {
  const user = userEvent.setup();
  const fail = line({ id: 'fail', number: 77, title: 'Lost machine', status: 'waiting', externalWait: {
    reason: 'Run on the build machine', on: { kind: 'external', event: 'machine' },
    since: '2026-11-16T08:00:00.000Z', until: '2099-11-16T08:00:00.000Z',
  } });
  shell('/tasks?department=d2', {
    'GET /api/tasks?status=all': [200, { tasks: [...TASKS, fail] }],
    'GET /api/requests': [200, decisions([{
      id: 'r1', text: 'Which route?', kind: 'question', task: { ...LOGIN, department: LOGIN.department }, ownerPersonId: IVAN.id, canAnswer: true,
      agent: BRUNO, commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false, at: LOGIN.createdAt,
    }])],
  });
  const list = await main();
  const side = screen.getByRole('navigation', { name: 'Task lists' });
  expect(within(side).getByRole('button', { name: 'Waits for me 1' })).toBeInTheDocument();
  expect(within(side).getByRole('button', { name: 'Failures 1' })).toBeInTheDocument();
  expect(within(rowOf(list, '#24 Fix the login page')).getByRole('button', { name: 'Open question' })).toBeInTheDocument();
  expect(within(rowOf(list, '#77 Lost machine')).queryByRole('button', { name: 'Open question' })).toBeNull();
  await user.click(within(side).getByRole('button', { name: 'Failures 1' }));
  expect(screen.getByRole('heading', { level: 1, name: 'Failures' })).toBeInTheDocument();
  expect(list).toHaveTextContent('Lost machine');
  expect(list).not.toHaveTextContent('Fix the login page');
});

it('shows a failed run in Turns with the full task title and no question action', async () => {
  const title = 'LongIdentifier'.repeat(30);
  const failed = line({ id: 'failed', number: 78, title, status: 'waiting', turn: TURN.number,
    time: { ...LOGIN.time!, waitsOn: [{ kind: 'run', who: null, since: LOGIN.createdAt, reason: '12', failure: 'run', runError: 'machine' }] } });
  shell('/tasks?show=turns', {
    'GET /api/tasks?status=all': [200, { tasks: [failed] }],
    'GET /api/turns': [200, { turns: [TURN] }],
  });
  const row = await screen.findByRole('listitem', { name: `#78 ${title}` });
  expect(within(row).getByRole('button', { name: title })).toBeInTheDocument();
  expect(within(row).getByText('Test run 12 failed: Machine unavailable')).toHaveClass('failure');
  expect(within(row).queryByRole('button', { name: 'Open question' })).toBeNull();
  expect(row).not.toHaveTextContent('Waits');
});

it('surfaces failed work in its own column on both boards', async () => {
  const user = userEvent.setup();
  const failed = line({ id: 'failed-step', number: 79, title: 'Check the card form', parentId: PAY.id, pipelineId: 'pl1', pipelineStageId: 's1',
    time: { ...LOGIN.time!, waitsOn: [{ kind: 'run', who: null, since: LOGIN.createdAt, reason: '17', failure: 'run' }] } });
  shell('/tasks?department=d2&view=board', { 'GET /api/tasks?status=all': [200, { tasks: [PAY, failed] }] });
  const board = await main();
  const failure = await within(board).findByRole('region', { name: 'Failures' });
  expect(within(failure).getByRole('article', { name: '#79 Check the card form' })).toHaveTextContent('Test run 17 failed');
  const side = screen.getByRole('navigation', { name: 'Task lists' });
  await user.click(await within(side).findByRole('button', { name: 'Payments way' }));
  const build = await within(board).findByRole('region', { name: 'Build' });
  expect(build).toHaveTextContent('Take card payments');
  expect(build).not.toHaveTextContent('Check the card form');
  expect(within(board).getByRole('region', { name: 'Failures' })).toHaveTextContent('Check the card form');
});
