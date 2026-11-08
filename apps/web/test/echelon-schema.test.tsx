import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { DepartmentView } from '../src/screens/Department';
import type { Department, DeptRole } from '../src/types';
import { ME, mockApi } from './api-mock';
import { ECHELON_ORG, ECHELON_WORKFLOW } from './echelon-fixture';

const base = ECHELON_ORG.departments[0]!;
const role = (id: string, title: string, gate: number | null, schema?: DeptRole['schema']): DeptRole => ({ id, title: { en: title, ru: title }, description: { en: '', ru: '' }, kind: 'member', gate, schema });
const atReview = { id: 'task-a', number: 12, title: 'Task A', stage: 99, gateCount: 99, bounces: 0, echelons: ECHELON_WORKFLOW };
const atDevelopment = { ...atReview, id: 'task-b', number: 13, title: 'Independent B', echelons: { ...ECHELON_WORKFLOW, stage: 'development' as const, ownerAgentId: 'b1',
  stages: ECHELON_WORKFLOW.stages.map(s => s.stage === 'development' ? { ...s, status: 'active' as const } : s.stage === 'review' ? { ...s, status: 'pending' as const } : s),
} };
function department() {
  const idle = base.employees[1]!;
  return { ...base, roles: [...base.roles, role('DEV-REV', 'Reviewer ability', 99), role('DEV-PERF', 'Performance engineer', null, 'observer')],
    employees: [
      ...base.employees.map(e => ({ ...e, task: e.id === 'b1' ? atDevelopment : e.id === 'reviewer' ? atReview : null })),
      { ...idle, id: 'observer', roleId: 'DEV-PERF', name: 'Performance agent', task: null },
    ],
  };
}
function show(d: Department, language = 'en') {
  localStorage.setItem('hh-lang', language);
  mockApi({});
  return render(<LanguageProvider><DepartmentView me={ME} department={d} deputies={[]} selected={null} selectedTask={null}
    panel={null} onBack={() => {}} onHire={() => {}} onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
}

describe('the actual department stage map', () => {
  it.each(['en', 'ru'])('names engine stages in English in %s without interpreting role gates', language => {
    show(department(), language);
    for (const name of ['Architecture', 'Development', 'Review', 'Security', 'Tests']) expect(screen.getByRole('group', { name })).toBeInTheDocument();
    for (const name of ['Architecture', 'Security']) expect(screen.getByRole('group', { name })).toHaveTextContent(language === 'ru' ? 'Пропущено' : 'Skipped');
    expect(screen.queryByRole('group', { name: 'Cleanup' })).not.toBeInTheDocument();
  });

  it('shows independent A in Review and B in Development at the same time', () => {
    show(department());
    const canvas = screen.getByRole('region', { name: 'Department schema' });
    expect(within(canvas).getByRole('button', { name: /Rita/ })).toHaveTextContent('Review #12 Task A');
    expect(within(canvas).getByRole('button', { name: /Bruno/ })).toHaveTextContent('Development #13 Independent B');
    expect(within(canvas).getByRole('button', { name: /Performance agent/ })).toBeInTheDocument();
    expect(canvas.querySelectorAll('.frame[data-echelon]')).toHaveLength(5);
    expect(canvas.querySelectorAll('.gl, .rl')).toHaveLength(0);
  });

  it('has no invented stage activity when visible employees have no task', () => {
    const d = department();
    show({ ...d, employees: d.employees.map(e => ({ ...e, task: null })) });
    expect(document.querySelectorAll('.frame[data-echelon]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Rita/ })).toHaveTextContent('Waiting for a new task');
  });

  it('shows Cleanup only when an actual task includes the head-requested option', () => {
    const d = department();
    const stages = [...ECHELON_WORKFLOW.stages];
    stages.splice(3, 0, { stage: 'cleanup', ownerAgentId: null, inputCandidateId: null, candidateId: null, status: 'pending', reason: 'Requested by head' });
    show({ ...d, employees: d.employees.map(e => e.id === 'reviewer' ? { ...e, task: { ...atReview, echelons: { ...ECHELON_WORKFLOW, stages } } } : e) });
    expect(screen.getByRole('group', { name: 'Cleanup' })).toBeInTheDocument();
    const frames = [...document.querySelectorAll('.frame[data-echelon]')].map(f => f.getAttribute('data-echelon'));
    expect(frames.indexOf('cleanup')).toBe(frames.indexOf('review') + 1);
  });

  it('places only the current owner in Review when another employee still references that task', () => {
    const d = department();
    show({ ...d, employees: d.employees.map(e => e.id === 'b1' ? { ...e, task: atReview } : e) });
    const review = screen.getByRole('group', { name: 'Review' });
    expect(within(review).getByRole('button', { name: /Rita/ })).toBeInTheDocument();
    expect(within(review).queryByRole('button', { name: /Bruno/ })).not.toBeInTheDocument();
    expect(within(review).queryByRole('button', { name: /Performance agent/ })).not.toBeInTheDocument();
  });
});
