import type { EchelonsSnapshot, EchelonStep } from '@hornhoof/protocol/echelons';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { TaskWorkflow, WorkflowStages } from '../src/ui/TaskWorkflow';
import type { TaskDetail } from '../src/types';

const GONE = '9b1f6d2e-3c4a-4e5f-8a6b-7c8d9e0f1a2b';
const step = (stage: EchelonStep['stage'], status: EchelonStep['status'], reason: string | null, ownerAgentId: string | null = null): EchelonStep =>
  ({ stage, status, reason, ownerAgentId, inputCandidateId: null, candidateId: null });
const workflow = (stages: EchelonStep[], phase: EchelonsSnapshot['phase'] = 'escalated'): EchelonsSnapshot => ({
  kind: 'development_echelons', version: 1, resultKind: 'code', revision: 3, stage: 'tests', phase, ownerAgentId: null, stages, candidateId: null, assignment: null,
  security: { required: false, reason: null, addedBy: null },
});

afterEach(cleanup);

describe('task workflow', () => {
  it('names every reason a stage can carry in plain words', () => {
    render(<LanguageProvider><WorkflowStages resolveOwner={id => id} workflow={workflow([
      step('review', 'complete', 'wrong_goal'), step('cleanup', 'pending', 'requested_by_head'), step('tests', 'active', 'tests_failed'),
    ])} /></LanguageProvider>);
    for (const raw of ['wrong_goal', 'requested_by_head', 'tests_failed']) expect(screen.queryByText(raw)).toBeNull();
    expect(screen.getByText('The head asked for it')).toBeTruthy();
    expect(screen.getByText('Not what the task asked for')).toBeTruthy();
    expect(screen.getByText('The tests failed')).toBeTruthy();
  });

  it('says plainly that turnkey work goes through no stages', () => {
    render(<LanguageProvider><WorkflowStages resolveOwner={id => id} workflow={{ ...workflow([], 'active'), resultKind: 'turnkey', stage: null }} /></LanguageProvider>);
    expect(screen.getByRole('heading').textContent).toBe('Turnkey: the employee does it alone from start to finish, with no stages');
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
