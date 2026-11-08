import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { TaskPanel } from '../src/ui/TaskPanel';
import { TaskRow } from '../src/ui/TaskRow';
import { TASK_DETAIL, mockApi } from './api-mock';
import { ECHELON_ORG, ECHELON_TASK, ECHELON_WORKFLOW } from './echelon-fixture';
import { fakeStream } from './fake-stream';

function panel<T extends typeof TASK_DETAIL>(task: T, language = 'en') {
  localStorage.setItem('hh-lang', language);
  mockApi({
    'GET /api/org': [200, ECHELON_ORG],
    'GET /api/tasks/t12': [200, { task }],
  });
  return render(<LanguageProvider><TaskPanel taskId="t12" onClose={() => {}} onOpen={() => {}}
    requests={[]} onRequestsChanged={() => {}} onOpenAgent={() => {}} /></LanguageProvider>);
}

describe('development echelon presentation', () => {
  it.each(['en', 'ru'])('shows the actual stages with English names in %s and keeps skipped reasons', async language => {
    panel(ECHELON_TASK, language);
    const route = await screen.findByRole('list', { name: language === 'ru' ? 'Маршрут задачи' : 'Task workflow' });
    const stages = within(route).getAllByRole('listitem');
    expect(stages.map(li => li.querySelector('b')!.textContent)).toEqual(['Architecture', 'Development', 'Review', 'Security', 'Tests']);
    expect(stages[0]).toHaveTextContent('Small task');
    expect(stages[0]).toHaveClass('skipped');
    expect(stages[2]).toHaveAttribute('aria-current', 'step');
    expect(stages[2]).toHaveTextContent('Rita');
    expect(stages[3]).toHaveClass('skipped');
    expect(stages[3]).toHaveTextContent('Not required');
    expect(route).not.toHaveTextContent('Backend engineer');
  });

  it('shows Security added by Review without inventing an extra stage or a return to the author', async () => {
    const workflow = { ...ECHELON_WORKFLOW, revision: 4, stage: 'security' as const, ownerAgentId: 'security',
      security: { included: true, reason: 'External input', addedByAgentId: 'reviewer' },
      stages: ECHELON_WORKFLOW.stages.map(stage => stage.stage === 'security'
        ? { ...stage, ownerAgentId: 'security', status: 'active' as const, reason: 'External input' }
        : stage.stage === 'review' ? { ...stage, status: 'complete' as const } : stage) };
    panel({ ...ECHELON_TASK, echelons: workflow });
    const route = await screen.findByRole('list', { name: 'Task workflow' });
    expect(within(route).getAllByRole('listitem')).toHaveLength(5);
    expect(route.querySelector('[aria-current="step"]')).toHaveTextContent('Security');
    expect(route.querySelector('[aria-current="step"]')).toHaveTextContent('Sam');
    expect(route).toHaveTextContent('External input');
  });

  it.each(['waiting', 'escalated', 'ready', 'done'] as const)('shows the engine state %s without naming the old author as current owner', async state => {
    panel({ ...ECHELON_TASK, echelons: { ...ECHELON_WORKFLOW, phase: state, ownerAgentId: null } });
    const route = await screen.findByRole('list', { name: 'Task workflow' });
    const current = route.querySelector('[aria-current="step"]');
    expect(current).not.toHaveTextContent('Bruno');
    expect(screen.getByText({ waiting: 'Waiting for an owner', escalated: 'With the head for a decision', ready: 'Ready to merge', done: 'Completed' }[state])).toBeInTheDocument();
  });

  it.each([undefined, null])('keeps the legacy gate presentation for echelons %s', async echelons => {
    panel({ ...TASK_DETAIL, echelons });
    const route = await screen.findByRole('list', { name: 'Gates' });
    expect(route).toHaveTextContent('Bruno');
    expect(route).toHaveTextContent('Tom');
    expect(screen.queryByRole('list', { name: 'Task workflow' })).not.toBeInTheDocument();
  });

  it('refreshes the route and owner when the task stream announces a handoff', async () => {
    const stream = fakeStream();
    panel(ECHELON_TASK);
    const route = await screen.findByRole('list', { name: 'Task workflow' });
    expect(route.querySelector('[aria-current="step"]')).toHaveTextContent('Review');
    mockApi({ 'GET /api/tasks/t12': [200, { task: { ...ECHELON_TASK, echelons: { ...ECHELON_WORKFLOW, stage: 'tests', ownerAgentId: 'tester',
      stages: ECHELON_WORKFLOW.stages.map(s => s.stage === 'review' ? { ...s, status: 'complete' } : s.stage === 'tests' ? { ...s, status: 'active' } : s) } } }] });
    stream.send({ type: 'task', id: 't12', spot: { departmentId: 'd2' } });
    expect(await within(route).findByText('Tom')).toBeInTheDocument();
    expect(route.querySelector('[aria-current="step"]')).toHaveTextContent('Tests');
  });

  it('lists A in Review and B in Development with their own engine stage', () => {
    const independent = { ...ECHELON_TASK, id: 't13', number: 13, title: 'Independent work', echelons: { ...ECHELON_WORKFLOW, stage: 'development' as const } };
    render(<><TaskRow task={ECHELON_TASK} on={false} place="" onOpen={() => {}} />
      <TaskRow task={independent}
        on={false} place="" onOpen={() => {}} /></>);
    expect(screen.getByRole('button', { name: /#12/ })).toHaveTextContent('Review');
    expect(screen.getByRole('button', { name: /#13/ })).toHaveTextContent('Development');
    expect(screen.queryByText(/Gate 2 of 3/)).not.toBeInTheDocument();
  });
});
