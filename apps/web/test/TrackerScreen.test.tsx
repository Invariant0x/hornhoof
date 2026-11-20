import { openTaskAction } from './open-task';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { heardAgain } from '../src/live';
import { Shell } from '../src/screens/Shell';
import type { GoalView, Me, Org, Pipeline, ProposalDecision, TaskDetail, TaskLine, TaskLogLine, WaitingRequest } from '../src/types';
import { decisions, DEV_ORG, ME, mockApi, TASK_DETAIL, TURN } from './api-mock';
import { decl } from './css';
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
/* Words drawn in their room to size it while they may not be true yet (#1638, Design #1633): unseen, read by nobody and out
   of reach of a click, as the browser specs see them. */
function expectUnseen(words: HTMLElement) {
  const layer = words.closest<HTMLElement>('.room-layer');
  expect(layer).toHaveClass('off');
  expect(layer).toHaveAttribute('aria-hidden', 'true');
  expect(layer).toHaveAttribute('inert');
}
const rowOf = (list: HTMLElement, name: string) => within(list).getByRole('listitem', { name });
const card = (name: string) => screen.findByRole('complementary', { name });
/* The one way to make something, as in the mockup: the + beside the panel's title opens what the person may make here. */
async function makeMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(await screen.findByRole('navigation', { name: 'Task lists' })).getByRole('button', { name: 'Create' }));
  return within(screen.getByRole('group', { name: 'Create' }));
}

it('shows a ready pipeline and its stages in the chosen language', async () => {
  localStorage.setItem('hh-lang', 'ru');
  try {
    const stock = {
      ...PIPELINE, catalogKey: 'development-changes', isDefault: true, name: 'Software changes',
      stages: [{ ...PIPELINE.stages[0], name: 'Build the change', ownerRole: 'DEV-ENG' }],
    };
    shell('/tasks?department=d2&pipeline=pl1&view=board', { 'GET /api/pipelines': [200, { pipelines: [stock] }] });
    const board = await screen.findByRole('region', { name: 'Доска' });
    expect(screen.getByRole('button', { name: 'Изменения в программе (по умолчанию)' })).toBeInTheDocument();
    expect(within(board).getByText('Сделать изменение')).toBeInTheDocument();
  } finally {
    localStorage.removeItem('hh-lang');
  }
});

it('marks the whole department row and keeps its pipeline disclosure independent', async () => {
  const user = userEvent.setup();
  const name = 'Development and Product Engineering';
  const pipeline = 'Beta build way';
  shell('/tasks?department=d2', {
    'GET /api/pipelines': [200, { pipelines: [{ ...PIPELINE, name: pipeline }] }],
    'GET /api/task-departments': [200, { whole: true, departments: [{ ...DEV, name, templateKey: null, mine: true, mayPlan: true }] }],
  });
  const side = within(screen.getByRole('navigation', { name: 'Task lists' }));
  const department = await side.findByRole('button', { name });
  const toggle = side.getByRole('button', { name: `Show what is in ${name}` });
  expect(department).toHaveAttribute('aria-current', 'page');
  expect(department.parentElement).toHaveClass('on');
  expect(department.parentElement).toContainElement(toggle);
  /* The caret stands first, then the department's mark and name, as in the mockup. */
  expect(department.parentElement!.firstElementChild).toBe(toggle);
  expect(department.querySelector('.tr-dept-mark')).toBeInTheDocument();
  expect(await side.findByRole('button', { name: pipeline })).toBeInTheDocument();

  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(side.queryByRole('button', { name: pipeline })).toBeNull();
  expect(department).toHaveAttribute('aria-current', 'page');
  await user.click(department);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(side.getByRole('button', { name: pipeline })).toBeInTheDocument();
});

it('keeps a pipeline chevron beside the first line of its full name', async () => {
  const name = 'Beta build way';
  shell('/tasks?department=d2', { 'GET /api/pipelines': [200, { pipelines: [{ ...PIPELINE, name, isDefault: true }] }] });
  const label = `${name} (default)`;
  const pipeline = await screen.findByRole('button', { name: label });
  const text = within(pipeline).getByText(label);
  expect(text.previousElementSibling).toHaveClass('ic');
  expect(text.parentElement).toHaveClass('tr-item-name');
  expect(text.closest('.tr-pipelines')).toBeInTheDocument();
  expect.soft(decl('.tr-pipelines .tr-item-name > .ic', 'align-self')).toBe('start');
  expect(decl('.tr-pipelines .tr-item-name > .ic', 'margin-block-start') ?? '').toContain('1lh');
});

describe('My tasks and View as', () => {
  it("lands on the person's own open tasks and goals, and shows another person's with View as", async () => {
    const user = userEvent.setup();
    shell();
    const list = await main();
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#23 Refund button', '#24 Fix the login page']));
    /* Goals have their own page: none of them is piled into the tasks. */
    expect(screen.queryByRole('region', { name: 'Your goals' })).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Waiting for you' })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'View as' }), 'p2');
    expect(location.search).toBe('?person=p2');
    /* Her subtasks stand open under their task, as "Subtasks: show" says. */
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#21 Take card payments', '#22 Card form']));
    expect(screen.queryByRole('region', { name: 'Goals of Maria' })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('heading', { level: 1, name: 'Waits for Maria' })).not.toBeInTheDocument();
  });

  it("keeps the map's way to another person's decisions for anyone, among the decisions they see", async () => {
    shell('/tasks?show=waits&person=p2', {}, { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Waits for Maria' })).toBeInTheDocument();
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
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#21 Take card payments', '#22 Card form']));
  });

  it('shows people with wait counts and opens department goals, dates and tasks without a pipeline', async () => {
    const user = userEvent.setup();
    shell('/tasks?department=d2', { 'GET /api/tasks?status=all': [200, { tasks: [
      ...TASKS, line({ id: 'dated', number: 42, title: 'Deliver the list', dueAt: '2026-12-01T00:00:00.000Z' }),
    ] }] });
    const side = await screen.findByRole('navigation', { name: 'Task lists' });
    expect(within(side).getByRole('heading', { name: 'Responsible' })).toBeInTheDocument();
    await act(async () => {});
    const ivan = within(side).getByRole('button', { name: 'Ivan 1' });
    expect(ivan.querySelector('.tr-avatar')).toBeInTheDocument();
    expect(ivan.querySelector('.tr-count')).toHaveClass('attention');
    /* Under each name, what the person answers for: the CEO the whole company, Maria her department. */
    expect(ivan).toHaveAccessibleDescription('CEO, whole company');
    expect(within(side).getByRole('button', { name: 'Maria' })).toHaveAccessibleDescription('Development');
    expect(within(side).getByRole('button', { name: /^My tasks / }).querySelector('.tr-count')).not.toHaveClass('attention');
    const dept = within(side).getByRole('button', { name: 'Development' });
    expect(dept.querySelector('.tr-dept-mark')).toBeInTheDocument();
    /* A department says who answers for it and how many of its employees work now. */
    expect(dept).toHaveAccessibleDescription('Maria answers 2 working');
    await user.click(within(side).getByRole('button', { name: 'Department goals 1' }));
    const goals = screen.getByRole('region', { name: 'Department goals' });
    expect(goals).toHaveTextContent('Card payments');
    expect(goals).not.toHaveTextContent('500 subscribers');
    expect(within(goals).getByRole('progressbar', { name: '1 of 2 tasks done' })).toBeInTheDocument();
    /* The goals page is not a view of tasks: it has no view tabs. */
    expect(screen.queryByRole('group', { name: 'View' })).not.toBeInTheDocument();
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
  it('keeps the pipeline breadcrumb and search with the picker, and only the three views of the mockup', async () => {
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
    /* List, Board and Graph, as the mockup's tabs, nothing more on the row. */
    expect(within(tabs).getAllByRole('radio').map(tab => tab.parentElement?.textContent)).toEqual(['List', 'Board', 'Graph']);
    expect(tabs.querySelectorAll('svg')).toHaveLength(3);
    expect(within(tabs).queryByRole('button')).toBeNull();
    const filters = screen.getByRole('group', { name: 'Filters' });
    expect(filters).toHaveTextContent('Group: status');
    const toggle = within(filters).getByRole('button', { name: 'Subtasks: show' });
    await user.click(toggle);
    expect(toggle).toHaveTextContent('Subtasks: hide');
  });

  it('orders list tasks by priority and shows it on the card, the row keeping the mockup columns', async () => {
    const user = userEvent.setup();
    const high = line({ ...PAY, priority: 'high' });
    const normal = line({ id: 't25', number: 25, title: 'Later task' });
    shell('/tasks?department=d2', { 'GET /api/tasks?status=all': [200, { tasks: [normal, high] }], 'GET /api/tasks/t21': [200, { task: detail(high) }] });
    const list = await main();
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#21 Take card payments', '#25 Later task']));
    /* The mockup's list has no priority column: the order tells it, and the card names it. */
    expect(rowOf(list, '#21 Take card payments')).not.toHaveTextContent('High');
    expect(rowOf(list, '#25 Later task')).not.toHaveTextContent('Normal');
    await user.click(within(list).getByRole('button', { name: 'Take card payments' }));
    const panel = await card('#21 Take card payments');
    await openTaskAction(user, panel, 'Details');
    expect(within(panel).getByRole('definition', { name: 'Priority' })).toHaveTextContent('High');
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
    const build = within(board).getByRole('region', { name: 'Build' });
    expect(within(build).getByRole('article', { name: '#21 Take card payments' })).toBeInTheDocument();
    /* A stage's pill, its count and the role that holds it, as in the mockup's column heads. */
    expect(within(build).getByRole('heading', { level: 2 })).toHaveTextContent('Build 1 Backend engineer');
    expect(within(build).getByText('Build')).toHaveClass('tr-status-pill');
    expect(within(within(board).getByRole('region', { name: 'Check' })).getByRole('heading', { level: 2 })).toHaveTextContent('Head of development');
  });

  it('opens a subtask in its own card, and says what the task is for, who answers for it and what waits for it', async () => {
    const user = userEvent.setup();
    shell('/tasks/t21');
    const panel = await card('#21 Take card payments');
    const path = await within(panel).findByRole('navigation', { name: 'Where it belongs' });
    await waitFor(() => expect(path).toHaveTextContent('500 subscribers'));
    expect(path).toHaveTextContent('Card payments');
    expect(panel).toHaveTextContent('Shops sell online.');
    const facts = within(within(panel).getByRole('group', { name: 'Facts' }));
    expect(facts.getByRole('definition', { name: 'Responsible' })).toHaveTextContent('Maria');
    await waitFor(() => expect(facts.getByRole('definition', { name: 'Pipeline' })).toHaveTextContent('Payments way · stage Build'));
    expect(within(within(panel).getByRole('region', { name: 'Links' })).getByRole('link', { name: '#23 Refund button' })).toHaveAttribute('title', 'Needed for');
    await user.click(within(within(panel).getByRole('region', { name: 'Subtasks' })).getByRole('link', { name: '#22 Card form' }));
    const sub = await card('#22 Card form');
    expect(within(within(sub).getByRole('navigation', { name: 'Where it belongs' })).getByRole('button', { name: '#21 Take card payments' })).toBeInTheDocument();
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
    expect(within(within(board).getByRole('article', { name: '#23 Refund button' })).getByRole('img', { name: 'Bruno' })).toHaveClass('tr-executor');
  });

  it("counts a task's subtasks over all the work under it, those done and those others answer for too", async () => {
    const mail = line({ id: 't26', number: 26, title: 'Refund mail', status: 'done', parentId: 't23', goal: SERVES });
    const form = line({ id: 't27', number: 27, title: 'Refund form', parentId: 't23', goal: SERVES, responsible: MARIA });
    shell('/tasks?view=board', { 'GET /api/tasks?status=all': [200, { tasks: [...TASKS, mail, form] }] });
    const board = await main();
    await waitFor(() => expect(within(board).getByRole('article', { name: '#23 Refund button' })).toHaveTextContent('1 of 2'));
    expect(within(within(board).getByRole('article', { name: '#23 Refund button' })).getByTitle('Subtasks: 1 of 2 done')).toBeInTheDocument();
  });

  it('sends an edit with the version it read, and says in words why it was refused', async () => {
    const user = userEvent.setup();
    let refuse = false;
    const calls = shell('/tasks/t21', {
      'PATCH /api/tasks/t21': () => (refuse ? [409, { error: { code: 'conflict', message: 'changed', reason: 'task_changed' } }] : [200, { task: detail(PAY, { title: 'Take cards and wallets' }) }]),
    });
    const panel = await card('#21 Take card payments');
    await openTaskAction(user, panel, 'Edit');
    const form = within(panel).getByRole('form', { name: 'Edit the task' });
    await user.clear(within(form).getByLabelText('Title'));
    await user.type(within(form).getByLabelText('Title'), 'Take cards and wallets');
    await user.selectOptions(within(form).getByLabelText('Responsible'), 'p1');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ version: 4, revision: 1, title: 'Take cards and wallets', responsible: 'p1' }));
    refuse = true;
    await waitFor(() => expect(form).not.toBeInTheDocument());
    await openTaskAction(user, panel, 'Edit');
    const again = within(panel).getByRole('form', { name: 'Edit the task' });
    await user.type(within(again).getByLabelText('Why'), ' Fast.');
    await user.click(within(again).getByRole('button', { name: 'Save' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Someone changed this task meanwhile. Look at it again and retry.');
  });

  it('offers no edit to a person who does not act on the task', async () => {
    shell('/tasks/t21', { 'GET /api/tasks/t21': [200, { task: detail(PAY, { mayEdit: false }) }] });
    const panel = await card('#21 Take card payments');
    await openTaskAction(userEvent.setup(), panel);
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
    await user.click(within(await screen.findByRole('navigation', { name: 'Task lists' })).getByRole('button', { name: 'Goals 2' }));
    expect(location.search).toBe('?show=goals');
    const goals = await screen.findByRole('region', { name: 'Goals' });
    await user.click(within(goals).getByRole('link', { name: '500 subscribers' }));
    expect(location.pathname + location.search).toBe('/tasks/g1?card=goal');
    const panel = await card('500 subscribers');
    expect(within(panel).getByText('Company goal', { selector: '.tp-kind' })).toBeInTheDocument();
    expect(within(panel).getByText('Active', { selector: '.tr-status-pill' })).toHaveClass('working');
    expect(within(panel).getByRole('progressbar', { name: '212 of 500 subscribers' })).toBeInTheDocument();
    expect(within(within(panel).getByRole('group', { name: 'Facts' })).getByRole('definition', { name: 'Progress' })).toHaveTextContent('212 of 500 subscribers');
    const under = within(panel).getByRole('region', { name: 'Tasks and goals under it' });
    expect(within(under).getByRole('heading')).toHaveTextContent('Tasks and goals under it · 0 of 1');
    await user.click(within(under).getByRole('button', { name: 'Card payments' }));
    const smaller = await card('Card payments');
    await waitFor(() => expect(within(within(smaller).getByRole('region', { name: 'Tasks and goals under it' })).getAllByRole('button').map(b => b.textContent)).toEqual(['#21 Take card payments', '#23 Refund button']));
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
    await user.click((await makeMenu(user)).getByRole('button', { name: 'New task' }));
    /* The menu closes on a choice. */
    expect(screen.queryByRole('group', { name: 'Create' })).not.toBeInTheDocument();
    expect(screen.getByText('Dana, the head, gets it and splits it among the department.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Refund API');
    await user.type(screen.getByLabelText('In one line'), 'Give the money back.');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path === '/api/tasks')?.body).toMatchObject({ title: 'Refund API', brief: 'Give the money back.', department: 'd2' }));
    expect(await card('#25 Refund API')).toBeInTheDocument();
  });

  it('makes a task from the + on any page, asking which department gets it', async () => {
    const user = userEvent.setup();
    const made = detail(line({ id: 't25', number: 25, title: 'Refund API', status: 'open' }));
    const calls = shell('/tasks?show=waits', { 'POST /api/tasks': [201, { task: made }], 'GET /api/tasks/t25': [200, { task: made }] });
    await screen.findByRole('region', { name: 'Waiting for you' });
    await user.click((await makeMenu(user)).getByRole('button', { name: 'New task' }));
    expect(screen.getByLabelText('Department')).toHaveDisplayValue('Development');
    expect(screen.getByText('Dana, the head, gets it and splits it among the department.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Refund API');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path === '/api/tasks')?.body).toMatchObject({ title: 'Refund API', department: 'd2' }));
    expect(await card('#25 Refund API')).toBeInTheDocument();
  });

  it('gives a group task its pipeline and the priority chosen in the form', async () => {
    const user = userEvent.setup();
    const made = detail(line({ id: 't25', number: 25, title: 'New payment option', pipelineId: 'pl1', priority: 'high' }));
    const calls = shell('/tasks?department=d2&pipeline=pl1', { 'POST /api/tasks': [201, { task: made }], 'GET /api/tasks/t25': [200, { task: made }] });
    await main();
    await user.click((await makeMenu(user)).getByRole('button', { name: 'New task' }));
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
    await user.click((await makeMenu(user)).getByRole('button', { name: 'New task' }));
    expect(screen.getByText('The head gets it and splits it among the department.')).toBeInTheDocument();
  });

  it('asks for a head before the department takes tasks', async () => {
    const user = userEvent.setup();
    const [dev] = ORG.departments;
    shell('/tasks?department=d2', { 'GET /api/org': [200, { ...ORG, departments: [{ ...dev!, employees: [] }] }] });
    await main();
    const menu = await makeMenu(user);
    expect(menu.getByText('Tasks go to the department through its head. Hire one first.')).toBeInTheDocument();
    expect(menu.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
  });

  it('lets a person give the department tasks, goals and pipelines where the server says they plan, and nowhere else', async () => {
    const user = userEvent.setup();
    shell('/tasks?department=d2', places(true), listed('p6', 'Lena'));
    await main();
    const lena = await makeMenu(user);
    await waitFor(() => expect(lena.getAllByRole('button').map(b => b.textContent)).toEqual(['New task', 'New goal', 'New pipeline']));
    cleanup();
    /* Kira has only a product of the department: she reads its work and gives it none, and the + is not there. */
    shell('/tasks?department=d2', places(false), listed('p7', 'Kira'));
    await main();
    expect(within(screen.getByRole('navigation', { name: 'Task lists' })).queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });

  it("offers a company goal only to a person the server lets set the company's goals", async () => {
    const user = userEvent.setup();
    shell('/tasks', { 'GET /api/task-departments': [200, { whole: true, mayPlanCompany: false, departments: [] }] });
    await main();
    expect((await makeMenu(user)).queryByRole('button', { name: 'New goal' })).not.toBeInTheDocument();
    cleanup();
    shell('/tasks');
    await main();
    await waitFor(async () => expect((await makeMenu(user)).getByRole('button', { name: 'New goal' })).toBeInTheDocument());
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
    const user = userEvent.setup();
    shell('/tasks?department=d2&pipeline=pl1', { 'GET /api/pipelines': [200, { pipelines: [{ ...PIPELINE, mayEdit: false }] }] });
    await main();
    const menu = await makeMenu(user);
    expect(menu.getByRole('button', { name: 'New pipeline' })).toBeInTheDocument();
    expect(menu.queryByRole('button', { name: 'Change the pipeline' })).not.toBeInTheDocument();
  });

  it('drafts a pipeline of the department with its stages and the roles that do them', async () => {
    const user = userEvent.setup();
    const calls = shell('/tasks?department=d2', { 'POST /api/pipelines': [201, { pipeline: PIPELINE }] });
    await main();
    await user.click((await makeMenu(user)).getByRole('button', { name: 'New pipeline' }));
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

/* The CEO sees on Waits for me what agents ask the people the CEO decides for too, as the assistant CEO's question, and the
   cards Hornhoof kept: the count beside it is what the page shows. */
it('counts on Waits for me everything the page shows under it', async () => {
  shell('/tasks?show=waits', {
    'GET /api/requests': [200, decisions([{
      id: 'r2', text: 'Which header?', kind: 'question', task: { ...LOGIN, department: LOGIN.department }, ownerPersonId: 'p-assistant', canAnswer: true,
      agent: BRUNO, commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false, at: LOGIN.createdAt,
    }])],
    'GET /api/wait-cards': [200, { cards: [{ id: 'c1', about: 'late', taskId: null, number: null, kind: null, level: null, at: LOGIN.createdAt, turn: null, tag: null }], next: null }],
  });
  const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
  await within(waiting).findByText('Which header?');
  const side = screen.getByRole('navigation', { name: 'Task lists' });
  expect(within(side).getByRole('button', { name: 'Waits for me 2' })).toBeInTheDocument();
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

/* Max, a person of the company, is asked by name on the card payments, and only he answers; Ivan, the CEO looking, is asked
   by name on the refund button; the login page's question is for anyone, Maria's as her department's, and Ivan may take it
   too. The login page also waits for Ivan himself. */
describe('what waits for people', () => {
  const MAX = { id: 'p-max', name: 'Max' };
  const WITH_MAX: Org = { ...ORG, people: [...ORG.people, { ...ORG.people[1]!, id: MAX.id, name: MAX.name, email: 'max@acme.test', title: 'Designer' }] };
  const asked = (id: string, task: TaskLine, text: string, over: Partial<WaitingRequest>): WaitingRequest => ({
    id, kind: 'question', text, task: { id: task.id, number: task.number, title: task.title, department: DEV }, ownerPersonId: IVAN.id, canAnswer: true,
    agent: { id: BRUNO.id, name: BRUNO.name }, commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false, at: LOGIN.createdAt, ...over,
  });
  const BY_NAME = { kind: 'named_person' as const, department: null };
  const FOR_MAX = asked('r-max', PAY, 'Which bank for the cards?', { ownerPersonId: MAX.id, canAnswer: false, decidedBy: BY_NAME });
  const FOR_IVAN = asked('r-ivan', REFUND, 'How much may a refund be?', { decidedBy: BY_NAME });
  const FOR_ANYONE = asked('r-any', LOGIN, 'Which header?', { ownerPersonId: MARIA.id, decidedBy: { kind: 'department_and_ceo', department: DEV } });
  const routes = { 'GET /api/org': [200, WITH_MAX], 'GET /api/requests': [200, decisions([FOR_MAX, FOR_IVAN, FOR_ANYONE])] };
  const articles = (region: HTMLElement) => within(region).getAllByRole('article').map(a => a.getAttribute('aria-label'));

  it("leaves a question asked of another person by name out of the viewer's own list and count, and keeps the rest", async () => {
    shell('/tasks?show=waits', routes);
    const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
    await within(waiting).findByText('Which header?');
    expect(articles(waiting)).toEqual(['#23 Refund button', '#24 Fix the login page']);
    expect(waiting).not.toHaveTextContent('Which bank for the cards?');
    /* The refund button's question and the login page, which waits for Ivan and asks a question too, once. */
    const side = screen.getByRole('navigation', { name: 'Task lists' });
    expect(within(side).getByRole('button', { name: 'Waits for me 2' })).toBeInTheDocument();
  });

  it("keeps a question asked of a person by name in that person's filter", async () => {
    shell('/tasks?show=waits&person=p-max', routes);
    const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Waits for Max' })).toBeInTheDocument();
    await within(waiting).findByText('Which bank for the cards?');
    expect(articles(waiting)).toEqual(['#21 Take card payments']);
  });

  it("names the person of a filter in the page's title alone, and Me takes the filter off", async () => {
    const user = userEvent.setup();
    shell('/tasks?show=waits&person=p-max', routes);
    const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
    await within(waiting).findByText('Which bank for the cards?');
    expect(screen.getByRole('heading', { level: 1, name: 'Waits for Max' })).toBeInTheDocument();
    /* Everything that waits for other people is in Waiting for people, so the list has neither a second line naming the
       person nor a way to everyone's decisions. */
    expect(waiting).not.toHaveTextContent('Decisions for Max');
    expect(screen.queryByRole('button', { name: "Show everyone's decisions" })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'View as' }), 'Me, Ivan');
    expect(screen.getByRole('heading', { level: 1, name: 'Waits for me' })).toBeInTheDocument();
    expect(articles(screen.getByRole('region', { name: 'Waiting for you' }))).toEqual(['#23 Refund button', '#24 Fix the login page']);
  });

  it('names Waiting for people once, in the title of the page', async () => {
    shell('/tasks?show=people', routes);
    /* Either list of what waits, so a tracker without this section fails here instead of waiting for it for ever. */
    const people = await screen.findByRole('region', { name: /^Waiting for (you|people)$/ });
    expect(people).toHaveAccessibleName('Waiting for people');
    await within(people).findByText('Which bank for the cards?');
    expect(screen.getAllByRole('heading', { name: 'Waiting for people' }).map(h => h.tagName)).toEqual(['H1']);
  });

  it('keeps the heading of Waiting for people below the results of a search, which come between it and the title', async () => {
    const user = userEvent.setup();
    shell('/tasks?show=people', routes);
    const people = await screen.findByRole('region', { name: /^Waiting for (you|people)$/ });
    await within(people).findByText('Which bank for the cards?');
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'Refund');
    expect(screen.getByRole('region', { name: 'Found tasks' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Waiting for people' })).getByRole('heading', { level: 2, name: 'Waiting for people' })).toBeInTheDocument();
  });

  it('lists everything that waits for people in the company, each card with whom it waits for, and counts it', async () => {
    const user = userEvent.setup();
    shell('/tasks?show=waits', routes);
    const side = await screen.findByRole('navigation', { name: 'Task lists' });
    await screen.findByText('Which header?');
    await user.click(within(side).getByRole('button', { name: 'Waiting for people 3' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Waiting for people' })).toBeInTheDocument();
    const people = screen.getByRole('region', { name: 'Waiting for people' });
    expect(articles(people)).toEqual(['#21 Take card payments', '#23 Refund button', '#24 Fix the login page']);
    expect(within(people).getByRole('article', { name: '#21 Take card payments' })).toHaveTextContent('Waiting for: Max');
    expect(within(people).getByRole('article', { name: '#23 Refund button' })).toHaveTextContent('Waiting for: Ivan');
    expect(within(people).getByRole('article', { name: '#24 Fix the login page' })).toHaveTextContent('Waiting for: Maria');
    /* Max's question shows who answers it instead of a way to answer. */
    expect(within(people).getByRole('article', { name: '#21 Take card payments' })).toHaveTextContent('Only the person asked can answer.');
    /* The tasks that wait for a person, here the login page for Ivan. */
    const tasks = within(people).getByRole('heading', { name: 'Tasks that wait for people' }).parentElement!;
    expect(tasks).toHaveTextContent('#24 Fix the login page');
    expect(tasks).toHaveTextContent('Waits for Ivan');
    expect(screen.queryByRole('region', { name: 'Waiting for you' })).not.toBeInTheDocument();
  });

  it("says on the orchestrator's card and on a merge whom they wait for, and counts each once", async () => {
    const structure: ProposalDecision = { id: 'pr1', kind: 'structure', agent: { id: 'a1', name: 'Orchestrator' }, department: null, brief: 'Add Support.', items: [{ template: 'support', checked: true, note: 'Answers customers.' }], at: LOGIN.createdAt, ownerPersonId: IVAN.id, canAnswer: true };
    const merge = { id: 'm1', label: 'the database from before the restore', after: null, open: 1, ownerPersonId: IVAN.id };
    shell('/tasks?show=people', {
      'GET /api/requests': [200, decisions([], { proposals: [structure], merges: [merge] })],
      'GET /api/merges/m1/conflicts': [200, { conflicts: [] }],
    });
    const people = await screen.findByRole('region', { name: /^Waiting for (you|people)$/ });
    expect(people).toHaveAccessibleName('Waiting for people');
    expect((await within(people).findByRole('heading', { name: 'Company structure' })).parentElement).toHaveTextContent('Waiting for: Ivan');
    expect(within(people).getByRole('region', { name: 'the database from before the restore' })).toHaveTextContent('Waiting for: Ivan');
    /* The card, the merge and the login page, which waits for Ivan. */
    const side = screen.getByRole('navigation', { name: 'Task lists' });
    expect(within(side).getByRole('button', { name: 'Waiting for people 3' })).toBeInTheDocument();
  });

  it('says so when nothing waits for people', async () => {
    shell('/tasks?show=people', { 'GET /api/tasks?status=all': [200, { tasks: [PAY, REFUND] }] });
    /* Either list of what waits, so a tracker without this section fails here instead of waiting for it for ever. */
    const people = await screen.findByRole('region', { name: /^Waiting for (you|people)$/ });
    expect(people).toHaveAccessibleName('Waiting for people');
    expect(await within(people).findByText('Nothing waits for people.')).toBeInTheDocument();
    const side = screen.getByRole('navigation', { name: 'Task lists' });
    expect(within(side).getByRole('button', { name: 'Waiting for people 0' })).toBeInTheDocument();
  });

  it('shows the section only to people who see the whole company', async () => {
    shell('/tasks?show=people', routes, listed('p1', 'Ivan'));
    const side = await screen.findByRole('navigation', { name: 'Task lists' });
    expect(await screen.findByRole('region', { name: 'Waiting for you' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Waits for me' })).toBeInTheDocument();
    expect(within(side).queryByRole('button', { name: /^Waiting for people/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Waiting for people' })).not.toBeInTheDocument();
  });
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
  expect(within(row).getByText('Test run #12 failed: Machine unavailable')).toHaveClass('failure');
  expect(within(row).queryByRole('button', { name: 'Open question' })).toBeNull();
  expect(row).not.toHaveTextContent('Waits');
});

const loginDecisions = decisions([{
  id: 'login-question', text: 'Which route?', kind: 'question', task: LOGIN, ownerPersonId: IVAN.id, canAnswer: true,
  agent: BRUNO, commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false, at: LOGIN.createdAt,
}]);

it('keeps a question action with its title and wait in Turns', async () => {
  const user = userEvent.setup();
  shell('/tasks?show=turns', {
    'GET /api/tasks?status=all': [200, { tasks: [{ ...LOGIN, turn: TURN.number }, { ...PAY, turn: TURN.number }] }],
    'GET /api/turns': [200, { turns: [TURN] }],
    'GET /api/tasks/t24': [200, { task: detail(LOGIN) }],
    'GET /api/requests': [200, loginDecisions],
  });
  const record = await screen.findByRole('listitem', { name: '#24 Fix the login page' });
  const title = within(record).getByRole('button', { name: LOGIN.title });
  const question = await within(record).findByRole('button', { name: 'Open question' });
  const text = title.parentElement;
  expect(text).not.toBe(record);
  expect(text).toContainElement(record.querySelector('.tr-wait'));
  expect(text).toContainElement(question);
  expect(within(rowOf(screen.getByRole('region', { name: 'Turns and releases' }), '#21 Take card payments')).queryByRole('button', { name: 'Open question' })).toBeNull();
  await user.click(question);
  expect(await card('#24 Fix the login page')).toBeInTheDocument();
});

const waitLanguages = [
  ['en', 'Waits for you', '49 minutes'],
  ['ru', 'Ждет вас', '49 минут'],
] as const;

it.each(waitLanguages.flatMap(words => [
  ['Turns', '/tasks?show=turns', 'listitem', ...words] as const,
  ['Board', '/tasks?department=d2&view=board', 'article', ...words] as const,
]))('%s shows only elapsed time under the personal wait chip (%s)', async (_view, path, role, language, chip, duration) => {
  localStorage.setItem('hh-lang', language);
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-13T08:49:00.000Z'));
  try {
    shell(path, {
      'GET /api/tasks?status=all': [200, { tasks: [{ ...LOGIN, turn: TURN.number }] }],
      'GET /api/turns': [200, { turns: [TURN] }],
      'GET /api/requests': [200, loginDecisions],
    });
    const record = within(await screen.findByRole(role, { name: '#24 Fix the login page' }));
    expect(await record.findByText(chip, { exact: true })).toHaveClass('tstate');
    expect(record.getByText(duration, { exact: true })).toHaveClass('tr-wait');
  } finally {
    now.mockRestore();
  }
});

it('shows the people of a board card as the mockup avatars, named in full', async () => {
  const responsible = { ...MARIA, name: 'Sam Rivera' };
  const executor = { ...BRUNO, name: 'Lee Chen' };
  shell('/tasks?department=d2&view=board', { 'GET /api/tasks?status=all': [200, { tasks: [{ ...PAY, responsible, executor }] }] });
  const record = within(await screen.findByRole('article', { name: '#21 Take card payments' }));
  expect(screen.getByRole('button', { name: 'Failures 0' })).toBeInTheDocument();
  /* The mockup's pair of avatars: the employee's letters in a square, the person's in a circle, each named in full. */
  expect(record.getByRole('img', { name: 'Sam Rivera' })).toHaveClass('tr-avatar');
  expect(record.getByRole('img', { name: 'Lee Chen' })).toHaveClass('tr-executor');
  expect(record.getByRole('img', { name: 'Lee Chen' }).parentElement).toHaveClass('tr-avatars');
  /* Two letters in the employee's square, from the first two words of its name or the first two letters of one word, as
     the mockup's LR for Lead Researcher; one letter in the person's circle. */
  expect(record.getByRole('img', { name: 'Lee Chen' })).toHaveTextContent(/^LC$/);
  expect(record.getByRole('img', { name: 'Sam Rivera' })).toHaveTextContent(/^S$/);
  cleanup();
  shell('/tasks?department=d2&view=board', { 'GET /api/tasks?status=all': [200, { tasks: [{ ...PAY, responsible, executor: BRUNO }] }] });
  const bruno = within(await screen.findByRole('article', { name: '#21 Take card payments' }));
  expect(bruno.getByRole('img', { name: 'Bruno' })).toHaveTextContent(/^BR$/);
});

it("offers the mockup's chips over the list: group, subtasks, executor and responsible", async () => {
  shell('/tasks?department=d2');
  await main();
  const chips = within(screen.getByRole('group', { name: 'Filters' }));
  expect(chips.getAllByRole('combobox').map(c => c.getAttribute('aria-label'))).toEqual(['Status', 'Executor', 'Responsible']);
  expect(chips.getByRole('button', { name: 'Subtasks: show' })).toBeInTheDocument();
  expect(chips.queryByRole('combobox', { name: 'Goal' })).not.toBeInTheDocument();
});

it.each([
  ['en', 'Board', 'Failures', 'Task lists', 'Test run #17 failed'],
  ['ru', 'Доска', 'Сбои', 'Списки задач', 'Упал прогон тестов №17'],
])('surfaces failed work with its run number in both board views (%s)', async (language, boardName, failures, lists, phrase) => {
  localStorage.setItem('hh-lang', language);
  const user = userEvent.setup();
  const failed = line({ id: 'failed-step', number: 79, title: 'Check the card form', parentId: PAY.id, pipelineId: 'pl1', pipelineStageId: 's1',
    time: { ...LOGIN.time!, waitsOn: [{ kind: 'run', who: null, since: LOGIN.createdAt, reason: '17', failure: 'run' }] } });
  shell('/tasks?department=d2&view=board', { 'GET /api/tasks?status=all': [200, { tasks: [PAY, failed] }] });
  const board = await screen.findByRole('region', { name: boardName });
  const failure = await within(board).findByRole('region', { name: failures });
  expect(within(failure).getByRole('article', { name: '#79 Check the card form' })).toHaveTextContent(phrase);
  const side = screen.getByRole('navigation', { name: lists });
  await user.click(await within(side).findByRole('button', { name: 'Payments way' }));
  const build = await within(board).findByRole('region', { name: 'Build' });
  expect(build).toHaveTextContent('Take card payments');
  expect(build).not.toHaveTextContent('Check the card form');
  expect(within(board).getByRole('region', { name: failures })).toHaveTextContent(phrase);
});

describe('the left panel and the goals page', () => {
  it("keeps the mockup's order and puts what the product adds after it", async () => {
    shell('/tasks?department=d2');
    const side = within(await screen.findByRole('navigation', { name: 'Task lists' }));
    await act(async () => {});
    const order = ['Waits for me', 'My tasks', 'Working now', 'Ivan', 'Maria', 'Development', 'Department goals', 'Pipelines', 'Payments way', 'Without a pipeline', 'Employees', 'Dana', 'Bruno',
      'Goals', 'Due dates', 'Failures', "The orchestrator's own work", 'Turns and releases'];
    const items = order.map(name => side.getByRole('button', { name: new RegExp(`^${name.replace(/'/g, '.')}( |$)`) }));
    for (const [i, item] of items.entries()) if (i) expect.soft(items[i - 1]!.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING, order[i]).toBeTruthy();
    expect(side.getAllByRole('heading').map(h => h.textContent)).toEqual(['Tasks', 'Responsible', 'Departments']);
    /* An employee at work shows the task it is on; the panel opens it. */
    expect(side.getByRole('button', { name: 'Bruno' })).toHaveAccessibleDescription('#21 Take card payments');
    expect(side.getByRole('button', { name: /^Working now/ }).querySelector('.tr-count')).toHaveClass('working');
  });

  it('makes everything from the + beside Tasks, and no button floats over the views or the goals page', async () => {
    const user = userEvent.setup();
    shell('/tasks?department=d2&pipeline=pl1');
    const list = await main();
    const nav = within(screen.getByRole('navigation', { name: 'Task lists' }));
    for (const name of ['New task', 'New goal', 'New pipeline', 'Change the pipeline', 'Write to the orchestrator']) expect.soft(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    const plus = nav.getByRole('button', { name: 'Create' });
    expect(plus).toHaveAttribute('aria-expanded', 'false');
    const menu = await makeMenu(user);
    expect(plus).toHaveAttribute('aria-expanded', 'true');
    expect(menu.getAllByRole('button').map(b => b.textContent)).toEqual(['New task', 'New goal', 'New pipeline', 'Change the pipeline', 'Write to the orchestrator']);
    /* Escape closes it and gives the focus back to the +. */
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Create' })).not.toBeInTheDocument();
    expect(plus).toHaveFocus();
    /* A press outside closes it too. */
    await makeMenu(user);
    await user.click(list);
    expect(screen.queryByRole('group', { name: 'Create' })).not.toBeInTheDocument();
    /* A goal from the menu: its form opens in the work, over the views. */
    await user.click((await makeMenu(user)).getByRole('button', { name: 'New goal' }));
    expect(screen.getByRole('form', { name: 'New goal' })).toBeInTheDocument();
    cleanup();
    shell('/tasks?show=goals');
    await screen.findByRole('region', { name: 'Goals' });
    for (const name of ['New goal', 'Write to the orchestrator']) expect.soft(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('draws the panel at the mockup sizes', () => {
    expect.soft(decl('.tracker', 'grid-template-columns')).toBe('clamp(270px, 18.75vw, 360px) minmax(0, 1fr)');
    expect.soft(decl('.tr-side', 'padding')).toBe('12px 8px 20px');
    expect.soft(decl('.tr-side-title', 'font')).toBe('600 18px var(--f-display)');
    expect.soft(decl('.tr-side-title', 'margin')).toBe('2px 8px 10px');
    expect.soft(decl('.tr-new', 'inline-size')).toBe('30px');
    /* The + menu in the look of the card's menu: a raised box in a line under the +, rows of the menu list. */
    expect.soft(decl('.tr-new-menu', 'position')).toBe('absolute');
    expect.soft(decl('.tr-new-menu', 'border')).toBe('1px solid var(--line2)');
    expect.soft(decl('.tr-item', 'min-block-size')).toBe('32px');
    expect.soft(decl('.tr-item', 'min-block-size', '(max-width: 760px), (pointer: coarse)')).toBe('44px');
    expect.soft(decl('.tr-item', 'padding')).toBe('4px 8px');
    expect.soft(decl('.tr-item', 'font-size')).toBe('13.5px');
    /* 8px between the icon, the name and the end, 2px between lines when the end goes under the name. */
    expect.soft(decl('.tr-item', 'gap')).toBe('2px 8px');
    expect.soft(decl('.tr-side-heading', 'font')).toBe('600 12px var(--f-body)');
    expect.soft(decl('.tr-side-heading', 'margin')).toBe('14px 8px 4px');
    expect.soft(decl('.tr-item > .tr-badge', 'font')).toBe('600 11px var(--f-body)');
    expect.soft(decl('.tr-item > .tr-badge', 'border-radius')).toBe('10px');
    expect.soft(decl('.tr-item small', 'font-size')).toBe('11.5px');
    expect.soft(decl('.tr-l1', 'padding-inline-start')).toBe('30px');
    expect.soft(decl('.tr-l2', 'padding-inline-start')).toBe('52px');
    expect.soft(decl(':is(.tr-live, .tr-waitd, .tr-idle)', 'inline-size')).toBe('8px');
    /* The top: where-you-are in 600 16px of the display face, the views in 600 13.5px with 10px by 12px, the chips in 12.5px with 3px by 10px. */
    expect.soft(decl('.tr-where', 'font')).toBe('600 16px var(--f-display)');
    expect.soft(decl('.tr-views label', 'font')).toBe('600 13.5px var(--f-display)');
    expect.soft(decl('.tr-views label', 'padding')).toBe('10px 12px');
    expect.soft(decl('.tr-chip', 'font-size')).toBe('12.5px');
    expect.soft(decl('.tr-chip', 'padding')).toBe('3px 10px');
  });

  it("lists the company's goals with their progress and opens a goal's card", async () => {
    const user = userEvent.setup();
    shell('/tasks?show=goals');
    const goals = await screen.findByRole('region', { name: 'Goals' });
    expect(screen.getByRole('heading', { level: 1, name: 'Goals' })).toBeInTheDocument();
    const company = await within(goals).findByRole('listitem', { name: '500 subscribers' });
    expect(within(company).getByRole('progressbar', { name: '212 of 500 subscribers' })).toBeInTheDocument();
    expect(within(company).getByRole('img', { name: 'Ivan' })).toHaveClass('tr-avatar');
    /* A smaller goal stands under the goal it is part of. */
    expect(within(company).getByRole('listitem', { name: 'Card payments' })).toBeInTheDocument();
    await user.click(within(company).getByRole('link', { name: '500 subscribers' }));
    expect(location.pathname + location.search).toBe('/tasks/g1?card=goal');
  });
});

/* Ivan's rule (20.11, #1613): a section of what waits says that nothing waits only once every source of it came: until then
   it holds its room with the shared indicator, as the style book has it (1.5, section 4). Each source is held back in turn,
   and the empty words must not show before it is let go. */
describe('what waits says that nothing waits only once all of it came', () => {
  const NO_WAITS = [PAY, REFUND];
  const ANSWERS: Record<string, unknown> = {
    'GET /api/turns': { turns: [] },
    'GET /api/requests': decisions([]),
    'GET /api/wait-cards': { cards: [], next: null },
    'GET /api/tasks?status=all': { tasks: NO_WAITS },
  };
  /* The page's sources answer at once, but the held one waits until the test lets it go. */
  function held(source: string) {
    let open: () => void = () => {};
    const opened = new Promise<void>(go => { open = go; });
    const routes = Object.fromEntries(Object.entries(ANSWERS).map(([key, body]) => [key, key === source ? async () => { await opened; return [200, body]; } : [200, body]]));
    return { routes, open: () => act(async () => { open(); await opened; }) };
  }

  it.each(['GET /api/requests', 'GET /api/wait-cards', 'GET /api/tasks?status=all'])('Waiting for you holds its room with the indicator while %s is held back', async source => {
    const hold = held(source);
    shell('/tasks?show=waits', hold.routes);
    const section = await screen.findByRole('region', { name: 'Waiting for you' });
    expect(within(section).getByRole('heading', { name: 'Waiting for you' })).toBeInTheDocument();
    expect(within(section).getByRole('status')).toHaveTextContent('Loading…');
    expect(section.querySelector('.load-hold')).toHaveAttribute('aria-busy', 'true');
    await act(async () => { await new Promise(go => setTimeout(go, 50)); });
    expectUnseen(within(section).getByText(en.tracker.empty.waits));
    await hold.open();
    await waitFor(() => expect(within(section).getByText(en.tracker.empty.waits).closest('.room-layer')).not.toHaveClass('off'));
    expect(within(section).queryByRole('status')).toBeNull();
  });

  it.each(['GET /api/requests', 'GET /api/tasks?status=all'])('Waiting for people holds its room with the indicator while %s is held back', async source => {
    const hold = held(source);
    shell('/tasks?show=people', hold.routes);
    const section = await screen.findByRole('region', { name: 'Waiting for people' });
    expect(within(section).getByRole('status')).toHaveTextContent('Loading…');
    await act(async () => { await new Promise(go => setTimeout(go, 50)); });
    expectUnseen(within(section).getByText(en.tracker.empty.people));
    await hold.open();
    await waitFor(() => expect(within(section).getByText(en.tracker.empty.people).closest('.room-layer')).not.toHaveClass('off'));
  });

  it('says that no task here has a due date only once the tasks came', async () => {
    const hold = held('GET /api/tasks?status=all');
    shell('/tasks?show=due', hold.routes);
    const page = await screen.findByRole('region', { name: en.tracker.side.dates });
    await act(async () => { await new Promise(go => setTimeout(go, 50)); });
    expect(within(page).getByRole('status')).toHaveTextContent('Loading tasks…');
    expectUnseen(within(page).getByText(en.tracker.empty.due));
    await hold.open();
    await waitFor(() => expect(within(page).getByText(en.tracker.empty.due).closest('.room-layer')).not.toHaveClass('off'));
  });

  it('says that a search found nothing only once the tasks came', async () => {
    const user = userEvent.setup();
    const hold = held('GET /api/tasks?status=all');
    shell('/tasks?department=d2', hold.routes);
    await user.type(await screen.findByRole('searchbox', { name: 'Search tasks' }), 'zebra');
    const results = await screen.findByRole('region', { name: en.tracker.search.results });
    expectUnseen(within(results).getByText('No tasks found. Try other words or clear the search.'));
    expect(within(results).getByRole('status')).toHaveTextContent('Loading tasks…');
    await hold.open();
    await waitFor(() => expect(within(results).getByText('No tasks found. Try other words or clear the search.').closest('.room-layer')).not.toHaveClass('off'));
  });

  it.each(['GET /api/turns', 'GET /api/tasks?status=all'])('says that no turn has been released yet only once the turns and the tasks came, while %s is held back', async source => {
    const hold = held(source);
    shell('/tasks?show=turns', { ...hold.routes, ...(source === 'GET /api/turns' ? {} : { 'GET /api/turns': [200, { turns: [] }] }) });
    const page = await screen.findByRole('region', { name: en.tracker.side.turns });
    await act(async () => { await new Promise(go => setTimeout(go, 50)); });
    expect(within(page).getByRole('status')).toHaveTextContent('Loading…');
    expect(within(page).queryByText(en.tracker.empty.turns)).toBeNull();
    await hold.open();
    expect(await within(page).findByText(en.tracker.empty.turns)).toBeInTheDocument();
  });

  it('stands what waits apart from the list above it, by a gap of the style book', () => {
    /* The tracker's spacing between sections (Design #1633): 24px. */
    expect(decl('.tr-main > :is(.tr-hold, .tr-found) + .waiting', 'margin-block-start')).toBe('var(--sec-gap)');
    expect(decl('.tr-main', '--sec-gap')).toBe('24px');
  });
});

/* Ivan's word (20.11, #1638): on Mine, "No open tasks to answer for." stood right under the filters, and the rest of the
   page was a bare line. Every section of the tracker that holds nothing says so in one empty block of its own (Design #1633,
   style book 1.7 section 4): its icon, the fact, a hint where it helps and, where a new task belongs to it, "Create task".
   The block shares one room with what holds the section's place while it comes, and shows only once every source of the
   section came; until then it stays unseen, read by nobody. */
describe('a section of the tracker that holds nothing', () => {
  /* A done task of another department: the company has work, and none of it is in the sections looked at. */
  const ELSEWHERE = line({ id: 't30', number: 30, title: 'Plan the launch', status: 'done', department: { id: 'd9', name: 'Marketing' }, responsible: MARIA, assignee: null });
  const NONE: Record<string, [number, unknown]> = {
    'GET /api/tasks?status=all': [200, { tasks: [ELSEWHERE] }],
    'GET /api/goals': [200, { goals: [] }],
    'GET /api/turns': [200, { turns: [] }],
    'GET /api/wait-cards': [200, { cards: [], next: null }],
  };
  const NO_TASKS = { ...NONE, 'GET /api/tasks?status=all': [200, { tasks: [] }] };
  /* The empty block that is shown: one outside any layer of its room that is not. */
  const shownBlock = () => document.querySelector<HTMLElement>('.room-empty:not(.off) .empty-state, .tr-releases .empty-state, .empty-state:not(.room-empty .empty-state)');
  const blockOf = async (text: string) => {
    await waitFor(() => expect(shownBlock()).toHaveTextContent(text));
    return shownBlock()!;
  };
  const words = en.tracker;

  it.each([
    ['Mine', '/tasks', words.empty.mine, words.emptyHint.mine, true],
    ['Working now', '/tasks?show=working', words.empty.working, undefined, false],
    ['a department', '/tasks?department=d2', words.empty.department, undefined, true],
    ['Failures', '/tasks?show=failures', words.empty.failures, words.emptyHint.failures, false],
    ['a responsible', '/tasks?responsible=p1', words.empty.responsible, undefined, false],
    ['a goal', '/tasks?goal=g2', words.empty.goal, undefined, true],
    ['a graph', '/tasks?department=d2&view=graph', words.graph.empty, undefined, false],
    ['the goals', '/tasks?show=goals', words.empty.goals, words.emptyHint.goals, false],
    ['Waiting for you', '/tasks?show=waits', words.empty.waits, words.emptyHint.waits, false],
    ['Waiting for people', '/tasks?show=people', words.empty.people, words.emptyHint.people, false],
    ['Due dates', '/tasks?show=due', words.empty.due, undefined, false],
    ['Turns', '/tasks?show=turns', words.empty.turns, undefined, false],
  ])('%s says so in its empty block: its icon, the fact, its hint and what to do', async (_section, path, fact, hint, makes) => {
    shell(path, NONE);
    const block = await blockOf(fact);
    expect(block.querySelector('svg.empty-state-icon')).not.toBeNull();
    expect(block.querySelector('.empty-state-t > b')).toHaveTextContent(fact);
    if (hint) expect(block.querySelector('.empty-state-t > span')).toHaveTextContent(hint);
    else expect(block.querySelector('.empty-state-t > span')).toBeNull();
    expect(within(block).queryAllByRole('button').map(b => b.textContent)).toEqual(makes ? [words.empty.create] : []);
  });

  it('says a search found nothing in its empty block', async () => {
    const user = userEvent.setup();
    shell('/tasks?department=d2', NONE);
    await user.type(await screen.findByRole('searchbox', { name: 'Search tasks' }), 'zebra');
    const block = await blockOf(en.tasks.noSearchResults);
    expect(block.querySelector('svg.empty-state-icon')).not.toBeNull();
  });

  it.each([['Mine', '/tasks'], ['the whole company', '/tasks?show=company'], ['its board', '/tasks?show=company&view=board']])(
    'opens a company with no task at all on its first view under the Hornhoof mark, on %s', async (_place, path) => {
      shell(path, NO_TASKS);
      const block = await blockOf(words.empty.company);
      expect(block).toHaveClass('first');
      expect(block.querySelector('svg.load-mark')).not.toBeNull();
      expect(block).toHaveTextContent(words.emptyHint.company!);
      expect(within(block).getByRole('button', { name: words.empty.create })).toBeInTheDocument();
    },
  );

  it("says of another person's Mine that the person answers for no open task, with nothing to do", async () => {
    shell('/tasks?person=p2', NONE);
    const block = await blockOf(words.empty.responsible);
    expect(within(block).queryByRole('button')).toBeNull();
  });

  it('says the board has no tasks on the company board of one who does not see the whole company', async () => {
    shell('/tasks?show=company&view=board', NO_TASKS, listed('p1', 'Ivan'));
    const block = await blockOf(words.empty.board);
    expect(block).not.toHaveClass('first');
  });

  it('says a board column with no card in one line with no icon', async () => {
    shell('/tasks?department=d2&view=board');
    const column = await screen.findByRole('region', { name: en.tracker.statuses.done });
    const line = within(column).getByText(en.tracker.board.empty);
    expect(line).toHaveClass('empty-line');
    expect(column.querySelector('.empty-state, svg.empty-state-icon')).toBeNull();
  });

  it('offers to make a task from an empty list where the person may plan, and opens its form', async () => {
    const user = userEvent.setup();
    shell('/tasks?department=d2', NONE);
    const block = await blockOf(words.empty.department);
    await user.click(within(block).getByRole('button', { name: words.empty.create }));
    expect(await screen.findByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByText('Dana, the head, gets it and splits it among the department.')).toBeInTheDocument();
  });

  it('offers nothing to do where the person may not plan', async () => {
    shell('/tasks?department=d2', { ...NONE, 'GET /api/task-departments': [200, { whole: true, mayPlanCompany: false, departments: [{ id: 'd2', name: null, templateKey: 'development', mine: true, mayPlan: false, responsible: MARIA }] }] });
    const block = await blockOf(words.empty.department);
    expect(within(block).queryByRole('button')).toBeNull();
  });

  it('keeps its words 16 px under the top of its block, by the tracker\'s own spacing', () => {
    expect(decl('.tr-main', '--empty-top')).toBe('16px');
    expect(decl('.empty-state', 'padding')).toMatch(/^var\(--empty-top\) /);
    expect(decl('.tr-main > :is(.tr-hold, .tr-found) + .waiting', 'margin-block-start')).toBe('var(--sec-gap)');
    expect(decl('.tr-main', '--sec-gap')).toBe('24px');
  });

  it('keeps a layer of its room that is not shown unseen, at its size', () => {
    expect(decl('.room > .room-layer', 'grid-area')).toBe('1 / 1');
    expect(decl('.room > .room-layer.off', 'visibility')).toBe('hidden');
  });

  /* The page's sources answer at once, but the held one waits until the test lets it go. */
  function holding(source: string, routes: Record<string, [number, unknown]>) {
    let open: () => void = () => {};
    const opened = new Promise<void>(go => { open = go; });
    const held = { ...routes, [source]: async () => { await opened; return routes[source]!; } };
    return { routes: held, open: () => act(async () => { open(); await opened; }) };
  }
  const settle = () => act(async () => { await new Promise(go => setTimeout(go, 50)); });

  /* While a source is held, the block is drawn unseen in its room, which it sizes, and read by nobody. */
  function unseen(text: string) {
    expect(shownBlock()).toBeNull();
    expectUnseen(screen.getByText(text));
  }

  it.each([
    ['the tasks', 'Mine', '/tasks', 'GET /api/tasks?status=all', words.empty.mine],
    ['the company, which says who works now', 'Working now', '/tasks?show=working', 'GET /api/org', words.empty.working],
    ['the goals', 'a graph', '/tasks?department=d2&view=graph', 'GET /api/goals', words.graph.empty],
    ['the kept cards', 'Waiting for you', '/tasks?show=waits', 'GET /api/wait-cards', words.empty.waits],
    ['the decisions', 'Waiting for people', '/tasks?show=people', 'GET /api/requests', words.empty.people],
  ])('says nothing while %s, a source of %s, are held back', async (_source, _section, path, source, fact) => {
    const routes: Record<string, [number, unknown]> = { 'GET /api/org': [200, ORG], 'GET /api/requests': [200, decisions([])], ...NONE };
    const hold = holding(source, routes);
    shell(path, hold.routes);
    await settle();
    unseen(fact);
    await hold.open();
    expect(await blockOf(fact)).toBeInTheDocument();
  });

  it('of a goal says it has no tasks only once the goals came, since they say which tasks serve it', async () => {
    const hold = holding('GET /api/goals', { ...NONE, 'GET /api/tasks?status=all': [200, { tasks: TASKS }], 'GET /api/goals': [200, { goals: [COMPANY_GOAL, DEPT_GOAL] }] });
    shell('/tasks?goal=g2', hold.routes);
    await settle();
    unseen(words.empty.goal);
    await hold.open();
    expect(rowOf(await main(), '#21 Take card payments')).toBeInTheDocument();
    expect(screen.queryByText(words.empty.goal)).toBeNull();
  });
});

/* #1629, Ivan's word: the tracker tells the tasks an employee works on at this moment from those only in work. Their status
   dot carries the class Design draws the pulse on, and a screen reader hears it, in every shipped language. It follows
   the company live, with no reload. */
describe('the dot of work going on now', () => {
  const dotOf = (list: HTMLElement, name: string) => rowOf(list, name).querySelector('.tr-status-dot')!;

  /* Design #1628: a pulsing dot's label is one whole phrase of its own, and no dot has a title, which some screen readers
     would read a second time. */
  it.each([
    ['en', en.tracker.groups.working, 'In work, working now'],
    ['ru', ru.tracker.groups.working, 'В работе, сейчас работают'],
  ])('marks only the task an employee works on now, and says so to a screen reader in one phrase, in %s', async (language, inWork, now) => {
    localStorage.setItem('hh-lang', language);
    try {
      shell('/tasks?show=company');
      const list = await screen.findByRole('region', { name: (language === 'en' ? en : ru).tracker.views.list });
      await waitFor(() => expect(dotOf(list, '#21 Take card payments')).toHaveClass('now'));
      expect((language === 'en' ? en : ru).tracker.dot.workingNow).toBe(now);
      expect(dotOf(list, '#21 Take card payments')).toHaveAccessibleName(now);
      expect(dotOf(list, '#23 Refund button')).not.toHaveClass('now');
      expect(dotOf(list, '#23 Refund button')).toHaveAccessibleName(inWork);
      expect([...list.querySelectorAll('.tr-status-dot[title]')]).toEqual([]);
    } finally {
      localStorage.clear();
    }
  });

  /* Design #1628: only a task in work gets the core. One that waits for a person keeps its own ring, though an employee
     works on it now. */
  it('marks no task outside work, even one an employee works on now', async () => {
    const on = (task: { id: string; number: number; title: string }) => ({ status: 'working' as const, task: { ...task, echelons: taskRoute() } });
    const both: Org = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: d.employees.map(e => (e.id === 'b1' ? { ...e, ...on({ id: 't21', number: 21, title: 'Take card payments' }) } : e.id === 'b0' ? { ...e, ...on({ id: 't24', number: 24, title: 'Fix the login page' }) } : e)) })) };
    shell('/tasks?show=company', { 'GET /api/org': () => [200, both] });
    const list = await main();
    await waitFor(() => expect(dotOf(list, '#21 Take card payments')).toHaveClass('now'));
    expect(dotOf(list, '#24 Fix the login page')).not.toHaveClass('now');
    expect(dotOf(list, '#24 Fix the login page')).toHaveAccessibleName(en.tracker.groups.waiting);
  });

  it('starts and stops as the company says who works on what, with no reload', async () => {
    let org: Org = DEV_ORG;
    shell('/tasks?show=company', { 'GET /api/org': () => [200, org] });
    const list = await main();
    await waitFor(() => expect(rowOf(list, '#21 Take card payments')).toBeInTheDocument());
    expect(dotOf(list, '#21 Take card payments')).not.toHaveClass('now');
    org = ORG;
    await act(async () => { heardAgain(); });
    await waitFor(() => expect(dotOf(list, '#21 Take card payments')).toHaveClass('now'));
    org = DEV_ORG;
    await act(async () => { heardAgain(); });
    await waitFor(() => expect(dotOf(list, '#21 Take card payments')).not.toHaveClass('now'));
  });
});
