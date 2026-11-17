import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { GoalView, Pipeline, TaskDetail } from '../src/types';
import { GoalForm, PipelineForm, TaskEdit } from '../src/ui/TrackerForms';
import { DEV_ORG, mockApi, TASK_DETAIL } from './api-mock';

/* Development: Dana heads it, Bruno builds; its pipeline hands work from Build to Check. */
const DEV = { id: 'd2', name: 'Development' };
const DEPARTMENT = DEV_ORG.departments[0]!;
const IVAN = { id: 'p1', name: 'Ivan' };
const PIPELINE: Pipeline = {
  id: 'pl1', department: DEV, name: 'Flow', why: '', archived: false, version: 1, mayEdit: true,
  stages: [
    { id: 's1', parentId: null, name: 'Build', ownerRole: 'DEV-BE', owner: null, position: 0 },
    { id: 's2', parentId: 's1', name: 'Check', ownerRole: 'DEV-HEAD', owner: null, position: 0 },
  ],
};
const goal = (over: Partial<GoalView> & { id: string; number: number }): GoalView => ({
  title: `Goal ${over.number}`, why: '', department: DEV, parentId: null, responsible: IVAN, target: null, current: null, unit: '', dueAt: null, status: 'active', progress: null, done: 0, total: 0, version: 0, mayEdit: true, ...over,
});
const TASK: TaskDetail & { version: number; revision: number } = { ...TASK_DETAIL, parentId: null, department: DEV, product: null, version: 5, revision: 2, why: '', pipelineId: 'pl1', pipelineStageId: 's1', responsible: IVAN, goal: null, dueAt: null };
const changed = (reason: string) => [409, { error: { code: 'conflict', message: 'changed', reason } }] as [number, unknown];
const patches = (calls: { method: string; body?: unknown }[]) => calls.filter(c => c.method === 'PATCH').map(c => c.body);
const ui = (form: ReactElement) => <LanguageProvider>{form}</LanguageProvider>;

describe('the edit of a task', () => {
  it('sends only what the person changed, with the version the form opened on, and starts again from the task as it is when refused', async () => {
    const user = userEvent.setup();
    let refuse = true;
    const calls = mockApi({
      'GET /api/org': [200, DEV_ORG], 'GET /api/goals': [200, { goals: [] }], 'GET /api/pipelines': [200, { pipelines: [PIPELINE] }],
      'PATCH /api/tasks/t12': () => (refuse ? changed('task_changed') : [200, { task: TASK }]),
    });
    const reload = vi.fn();
    const form = (task: typeof TASK) => ui(<TaskEdit task={task} onDone={() => {}} onCancel={() => {}} onReload={reload} />);
    const { rerender } = render(form(TASK));
    expect(await screen.findByRole('combobox', { name: 'Stage' })).toHaveDisplayValue('Build');
    /* The engine moves the task on while the form is open. */
    rerender(form({ ...TASK, version: 6, pipelineStageId: 's2' }));
    await user.type(screen.getByRole('textbox', { name: 'Why' }), 'Because');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toEqual([{ version: 5, revision: 2, why: 'Because' }]));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone changed this task meanwhile. Look at it again and retry.');
    expect(reload).toHaveBeenCalled();
    /* The person's words stay; what they did not touch is what the task holds now. */
    expect(screen.getByRole('combobox', { name: 'Stage' })).toHaveDisplayValue('· Check');
    expect(screen.getByRole('textbox', { name: 'Why' })).toHaveValue('Because');
    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toEqual([{ version: 5, revision: 2, why: 'Because' }, { version: 6, revision: 2, why: 'Because' }]));
  });

  it('starts again from the task as it is when another edit of the card came first, though its work did not move', async () => {
    const user = userEvent.setup();
    let refuse = true;
    const calls = mockApi({
      'GET /api/org': [200, DEV_ORG], 'GET /api/goals': [200, { goals: [] }], 'GET /api/pipelines': [200, { pipelines: [PIPELINE] }],
      'PATCH /api/tasks/t12': () => (refuse ? changed('task_changed') : [200, { task: TASK }]),
    });
    const reload = vi.fn();
    const form = (task: typeof TASK) => ui(<TaskEdit task={task} onDone={() => {}} onCancel={() => {}} onReload={reload} />);
    const { rerender } = render(form(TASK));
    await user.type(await screen.findByRole('textbox', { name: 'Why' }), 'Because');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toEqual([{ version: 5, revision: 2, why: 'Because' }]));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone changed this task meanwhile. Look at it again and retry.');
    expect(reload).toHaveBeenCalled();
    /* Read again: someone renamed it meanwhile, and the version of its work is the same. */
    rerender(form({ ...TASK, revision: 3, title: 'Renamed by someone else' }));
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Renamed by someone else');
    expect(screen.getByRole('textbox', { name: 'Why' })).toHaveValue('Because');
    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toEqual([{ version: 5, revision: 2, why: 'Because' }, { version: 5, revision: 3, why: 'Because' }]));
  });

  it("offers the goals a task may serve: the company's and those of its department and its product", async () => {
    const goals = [
      goal({ id: 'g1', number: 1, title: '500 subscribers', department: null }),
      goal({ id: 'g2', number: 2, title: 'Card payments' }),
      goal({ id: 'g3', number: 3, title: 'Mascot shop', department: { id: 'pd1', name: 'Mascot' } }),
      goal({ id: 'g4', number: 4, title: 'More posts', department: { id: 'd1', name: 'Marketing' } }),
      goal({ id: 'g5', number: 5, title: 'Old checkout', status: 'dropped' }),
      goal({ id: 'g6', number: 6, title: '100 subscribers', department: null, status: 'reached' }),
    ];
    mockApi({ 'GET /api/org': [200, DEV_ORG], 'GET /api/goals': [200, { goals }], 'GET /api/pipelines': [200, { pipelines: [] }] });
    render(ui(<TaskEdit task={{ ...TASK, product: { id: 'pd1', name: 'Mascot' } }} onDone={() => {}} onCancel={() => {}} />));
    const select = screen.getByRole('combobox', { name: 'Goal' });
    await waitFor(() => expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['No goal', '500 subscribers', 'Card payments', 'Mascot shop']));
  });
});

describe('the edit of a goal', () => {
  it('sends only what the person changed, with the version the form opened on, and starts again from the goal as it is when refused', async () => {
    const user = userEvent.setup();
    let refuse = true;
    const opened = goal({ id: 'g2', number: 2, title: 'Card payments', target: 500, current: 212, version: 2 });
    const calls = mockApi({
      'GET /api/org': [200, DEV_ORG], 'GET /api/goals': [200, { goals: [opened] }],
      'PATCH /api/goals/g2': () => (refuse ? changed('goal_changed') : [200, { goal: opened }]),
    });
    const reload = vi.fn();
    const form = (g: GoalView) => ui(<GoalForm goal={g} department={DEV} onDone={() => {}} onCancel={() => {}} onReload={reload} />);
    const { rerender } = render(form(opened));
    /* Someone counts the goal on while the form is open. */
    rerender(form({ ...opened, current: 230, version: 3 }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Cards and wallets');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toEqual([{ version: 2, title: 'Cards and wallets' }]));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone changed this goal meanwhile. Look at it again and retry.');
    expect(reload).toHaveBeenCalled();
    expect(screen.getByRole('spinbutton', { name: 'Now' })).toHaveValue(230);
    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toEqual([{ version: 2, title: 'Cards and wallets' }, { version: 3, title: 'Cards and wallets' }]));
  });
});

describe('a pipeline', () => {
  it('keeps the employee who does a stage, names them, and sends them back', async () => {
    const user = userEvent.setup();
    const staffed: Pipeline = { ...PIPELINE, version: 3, stages: [{ id: 's1', parentId: null, name: 'Build', ownerRole: null, owner: { id: 'b1', name: 'Bruno' }, position: 0 }] };
    const calls = mockApi({ 'PATCH /api/pipelines/pl1': [200, { pipeline: staffed }] });
    render(ui(<PipelineForm pipeline={staffed} department={DEPARTMENT} onDone={() => {}} onCancel={() => {}} />));
    expect(within(screen.getByRole('group', { name: 'Stage 1' })).getByLabelText('Who does it')).toHaveDisplayValue('Bruno');
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Flow 2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toEqual([{ version: 3, name: 'Flow 2', why: '', stages: [{ key: 's1', id: 's1', parent: null, name: 'Build', ownerAgentId: 'b1' }] }]));
  });

  it('asks for the name and the one who does each stage before it saves, and drops none of them', async () => {
    const user = userEvent.setup();
    const calls = mockApi({ 'POST /api/pipelines': [201, { pipeline: PIPELINE }] });
    render(ui(<PipelineForm department={DEPARTMENT} onDone={() => {}} onCancel={() => {}} />));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Refunds');
    await user.click(screen.getByRole('button', { name: 'Add a stage' }));
    await user.click(screen.getByRole('button', { name: 'Add a stage' }));
    const [first, second] = screen.getAllByRole('group', { name: /^Stage \d$/ });
    expect(within(within(first!).getByLabelText('Who does it')).queryByRole('option', { name: 'Nobody yet' })).not.toBeInTheDocument();
    await user.type(within(second!).getByLabelText('Name of the stage'), 'Check');
    await user.selectOptions(within(second!).getByLabelText('Who does it'), 'Head of development');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(within(first!).getByLabelText('Name of the stage')).toHaveAccessibleDescription('Give the stage a name.');
    expect(within(first!).getByLabelText('Who does it')).toHaveAccessibleDescription('Choose who does this stage.');
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    await user.type(within(first!).getByLabelText('Name of the stage'), 'Build');
    await user.selectOptions(within(first!).getByLabelText('Who does it'), 'Bruno');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({
      department: 'd2', name: 'Refunds', why: '',
      stages: [{ key: 'n1', parent: null, name: 'Build', ownerAgentId: 'b1' }, { key: 'n2', parent: 'n1', name: 'Check', ownerRole: 'DEV-HEAD' }],
    }));
  });
});
