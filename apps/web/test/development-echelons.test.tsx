import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { TaskPanel } from '../src/ui/TaskPanel';
import { openTaskAction } from './open-task';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { mockApi } from './api-mock';
import { ECHELON_ORG, ECHELON_TASK, ECHELON_WORKFLOW } from './echelon-fixture';
import { fakeStream } from './fake-stream';

async function panel(task = ECHELON_TASK, language = 'en') {
  localStorage.setItem('hh-lang', language);
  mockApi({ 'GET /api/org': [200, ECHELON_ORG], 'GET /api/tasks/t12': [200, { task }] });
  render(<LanguageProvider><TaskPanel taskId="t12" onClose={() => {}} onOpen={() => {}}
    requests={[]} onRequestsChanged={() => {}} onOpenAgent={() => {}} /></LanguageProvider>);
  await openTaskAction(userEvent.setup(), await screen.findByRole('complementary'), language === 'ru' ? ru.tasks.details : en.tasks.details);
}

describe('the required echelon presentation', () => {
  it.each(['en', 'ru'])('shows the ordered route with the stage names of %s', async language => {
    await panel(ECHELON_TASK, language);
    const route = await screen.findByRole('list', { name: language === 'ru' ? 'Маршрут задачи' : 'Task workflow' });
    const stages = within(route).getAllByRole('listitem');
    expect(stages.map(li => li.querySelector('b')!.textContent)).toEqual(language === 'ru' ? ['Архитектура', 'Разработка', 'Проверка', 'Безопасность', 'Тесты'] : ['Architecture', 'Development', 'Review', 'Security', 'Tests']);
    expect(stages[0]).toHaveClass('skipped');
    expect(stages[0]).toHaveTextContent('Small task');
    expect(stages[2]).toHaveAttribute('aria-current', 'step');
    expect(await within(stages[2]!).findByText(language === 'ru' ? 'Исполнитель: Rita' : 'Owner: Rita')).toBeInTheDocument();
    expect(stages[3]).toHaveTextContent('Not required');
    expect(route).not.toHaveTextContent('Backend engineer');
    expect(route).not.toHaveTextContent(language === 'ru' ? 'Уборка лишнего' : 'Cleanup');
  });

  it('shows optional Cleanup only where the head inserted it after Review', async () => {
    const stages = [...ECHELON_WORKFLOW.stages];
    stages.splice(3, 0, { stage: 'cleanup', status: 'pending', ownerAgentId: null, inputCandidateId: null, candidateId: null, reason: 'Requested by head' });
    await panel({ ...ECHELON_TASK, echelons: { ...ECHELON_WORKFLOW, stages } });
    const route = await screen.findByRole('list', { name: 'Task workflow' });
    expect(within(route).getAllByRole('listitem').map(li => li.querySelector('b')!.textContent)).toEqual(['Architecture', 'Development', 'Review', 'Cleanup', 'Security', 'Tests']);
    expect(route).toHaveTextContent('Requested by head');
  });

  it.each(['waiting', 'escalated'] as const)('shows %s without naming the previous author as owner', async phase => {
    await panel({ ...ECHELON_TASK, echelons: { ...ECHELON_WORKFLOW, phase, ownerAgentId: null } });
    const route = await screen.findByRole('list', { name: 'Task workflow' });
    expect(route.querySelector('[aria-current="step"]')).not.toHaveTextContent('Bruno');
    expect(screen.getByText(phase === 'waiting' ? 'Waiting for an owner' : 'With the head for a decision')).toBeInTheDocument();
  });

  it('refreshes the current owner and stage after the task stream handoff', async () => {
    const stream = fakeStream();
    await panel();
    const route = await screen.findByRole('list', { name: 'Task workflow' });
    expect(route.querySelector('[aria-current="step"]')).toHaveTextContent('Review');
    mockApi({ 'GET /api/tasks/t12': [200, { task: { ...ECHELON_TASK, echelons: { ...ECHELON_WORKFLOW, stage: 'tests', ownerAgentId: 'tester',
      stages: ECHELON_WORKFLOW.stages.map(s => s.stage === 'review' ? { ...s, status: 'complete' } : s.stage === 'tests' ? { ...s, status: 'active' } : s) } } }] });
    stream.send({ type: 'task', id: 't12', spot: { departmentId: 'd2' } });
    expect(await within(route).findByText('Owner: Tom')).toBeInTheDocument();
    expect(route.querySelector('[aria-current="step"]')).toHaveTextContent('Tests');
  });
});
