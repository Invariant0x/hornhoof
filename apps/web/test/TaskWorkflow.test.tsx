import type { EchelonsSnapshot, EchelonStep } from '@hornhoof/protocol/echelons';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { TaskWorkflow, WorkflowStages } from '../src/ui/TaskWorkflow';
import type { TaskDetail } from '../src/types';

const GONE = '9b1f6d2e-3c4a-4e5f-8a6b-7c8d9e0f1a2b';
const step = (stage: EchelonStep['stage'], status: EchelonStep['status'], reason: string | null, ownerAgentId: string | null = null): EchelonStep =>
  ({ stage, status, reason, ownerAgentId, inputCandidateId: null, candidateId: null });
const workflow = (stages: EchelonStep[], phase: EchelonsSnapshot['phase'] = 'escalated'): EchelonsSnapshot => ({
  kind: 'development_echelons', version: 1, resultKind: 'code', revision: 3, stage: 'tests', phase, ownerAgentId: null, stages, abilities: {}, candidateId: null, assignment: null,
  security: { required: false, reason: null, addedBy: null },
});

afterEach(() => {
  cleanup();
  localStorage.removeItem('hh-lang');
});

describe('task workflow', () => {
  it('marks a one-shot stage in the pipeline before it runs', () => {
    const route = workflow([step('development', 'active', null), step('review', 'pending', null)], 'active');
    render(<LanguageProvider><WorkflowStages resolveOwner={id => id} workflow={{ ...route, oneShot: { review: { fanOut: 2, judge: null } } }} /></LanguageProvider>);
    const ghost = 'A one-shot call appears for one task and is gone';
    const [work, review] = screen.getAllByRole('listitem');
    expect(within(work!).queryByRole('img', { name: ghost })).toBeNull();
    expect(within(review!).getByRole('img', { name: ghost }).querySelector('path[d="M8 1 15 8 8 15 1 8Z"]')).toBeInTheDocument();
  });

  it('shows the chosen task’s call places in the department route, with Russian names', () => {
    localStorage.setItem('hh-lang', 'ru');
    const route = { ...workflow([step('review', 'active', null), step('security', 'pending', null)], 'active'), stage: 'review' as const,
      oneShot: { review: { fanOut: 2, judge: 'Judge' }, security: { fanOut: 1, judge: null } } };
    const call = { id: 'c1', task: 12, number: 1, by: 'b1', judge: false, stage: 'review', startedAt: '2026-11-17T10:00:00.000Z' };
    const calls = [call, { ...call, id: 'c2', task: 13, number: 2 }, { ...call, id: 'c3', task: 13, judge: true }];
    render(<LanguageProvider><WorkflowStages workflow={route} resolveOwner={id => id} departmentTask={{ number: 12, calls }} /></LanguageProvider>);
    const [review, security] = screen.getAllByRole('listitem');
    const marks = within(review!).getAllByRole('img', { name: /^Разовый вызов появляется на одну задачу и исчезает/ });
    expect(marks).toHaveLength(3);
    expect(marks[0]).toHaveAccessibleName(new RegExp(ru.workers.running + '$'));
    expect(marks[1]).toHaveAccessibleName(new RegExp(ru.workers.idle + '$'));
    expect(marks[2]).toHaveAccessibleName(/Вызов судьи.*Без работы/i);
    expect(within(security!).getAllByRole('img')).toHaveLength(1);
  });

  it('names every reason a stage can carry in plain words', () => {
    render(<LanguageProvider><WorkflowStages resolveOwner={id => id} workflow={workflow([
      step('review', 'complete', 'wrong_goal'), step('cleanup', 'pending', 'requested_by_head'), step('tests', 'active', 'tests_failed'),
    ])} /></LanguageProvider>);
    for (const raw of ['wrong_goal', 'requested_by_head', 'tests_failed']) expect(screen.queryByText(raw)).toBeNull();
    expect(screen.getByText('The head asked for it')).toBeTruthy();
    expect(screen.getByText('Not what the task asked for')).toBeTruthy();
    expect(screen.getByText('The tests failed')).toBeTruthy();
  });

  it('says plainly that work with no stages is done by its employee alone, naming no turnkey team', () => {
    render(<LanguageProvider><WorkflowStages resolveOwner={id => id} workflow={{ ...workflow([], 'active'), resultKind: 'turnkey', stage: null }} /></LanguageProvider>);
    expect(screen.getByRole('heading').textContent).toBe('No stages: the employee does it alone from start to finish');
  });

  it('names the stages of a document in plain words, and says it waits for the head once they passed', () => {
    render(<LanguageProvider><WorkflowStages resolveOwner={id => id} workflow={{ ...workflow([step('development', 'complete', null), step('review', 'complete', null)], 'ready'), resultKind: 'document', stage: 'review' }} /></LanguageProvider>);
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.getByText('Check')).toBeTruthy();
    expect(screen.queryByText('Development')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Checked, waits for the head to accept it');
  });

  it('shows the phase of a cancelled task as cancelled', () => {
    render(<LanguageProvider><WorkflowStages resolveOwner={id => id} workflow={workflow([step('review', 'pending', null)], 'cancelled')} /></LanguageProvider>);
    expect(screen.getByRole('status').textContent).toBe('Cancelled');
  });

  it('never shows the raw id of an owner it cannot name', () => {
    const task = { assignee: null, executor: null } as unknown as TaskDetail;
    render(<LanguageProvider><TaskWorkflow task={task} org={null} workflow={workflow([step('review', 'pending', null, GONE)])} /></LanguageProvider>);
    expect(screen.queryByText(new RegExp(GONE))).toBeNull();
    expect(screen.getByText('Owner: another employee')).toBeTruthy();
  });
});
