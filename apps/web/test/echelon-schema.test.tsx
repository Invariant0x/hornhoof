import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { DepartmentView } from '../src/screens/Department';
import type { Department, DeptRole } from '../src/types';
import { ME, mockApi } from './api-mock';
import { ECHELON_ORG, ECHELON_WORKFLOW } from './echelon-fixture';

const base = ECHELON_ORG.departments[0]!;
const role = (id: string, title: string, gate: number | null, schema?: DeptRole['schema']): DeptRole => ({
  id, title: { en: title, ru: title }, description: { en: '', ru: '' }, kind: 'member', gate, schema,
});
const atReview = { id: 'task-a', number: 12, title: 'Task A', stage: 99, gateCount: 99, bounces: 0, echelons: ECHELON_WORKFLOW };
const atDevelopment = { ...atReview, id: 'task-b', number: 13, title: 'Independent B', echelons: {
  ...ECHELON_WORKFLOW, stage: 'development' as const, ownerAgentId: 'b1',
  stages: ECHELON_WORKFLOW.stages.map(s => s.stage === 'development' ? { ...s, status: 'active' as const } : s.stage === 'review' ? { ...s, status: 'pending' as const } : s),
} };

function department(reviewTask = atReview) {
  const idle = base.employees[1]!;
  return {
    ...base,
    echelonsEnabled: true,
    roles: [...base.roles,
      role('DEV-REV', 'Legacy reviewer title', 99),
      role('DEV-PERF', 'Performance engineer', null, 'observer'),
      role('legacy', 'Legacy work', 40),
    ],
    employees: [
      ...base.employees.map(e => ({ ...e, task: e.id === 'b1' ? atDevelopment : e.id === 'reviewer' ? reviewTask : null })),
      { ...idle, id: 'observer', roleId: 'DEV-PERF', name: 'Performance agent', task: null },
      { ...idle, id: 'legacy', roleId: 'legacy', name: 'Legacy agent', task: { id: 'old', number: 9, title: 'Legacy task', stage: 1, gateCount: 2, bounces: 0 } },
    ],
  };
}

function show(d: Department, language = 'en') {
  localStorage.setItem('hh-lang', language);
  mockApi({});
  return render(<LanguageProvider><DepartmentView me={ME} department={d} deputies={[]} selected={null} selectedTask={null}
    panel={null} onBack={() => {}} onHire={() => {}} onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
}

describe('the echelon department map', () => {
  it.each(['en', 'ru'])('names actual engine stages in English in %s without interpreting role gates', language => {
    show(department(), language);
    for (const name of ['Architecture', 'Development', 'Review', 'Security', 'Tests']) {
      expect(screen.getByRole('group', { name, exact: true })).toBeInTheDocument();
    }
    expect(screen.getByRole('group', { name: 'Architecture', exact: true })).toHaveTextContent(language === 'ru' ? 'Пропущен' : 'Skipped');
    expect(screen.getByRole('group', { name: 'Security', exact: true })).toHaveTextContent(language === 'ru' ? 'Пропущен' : 'Skipped');
  });

  it('shows A in Review while B is independently in Development, with the actual owner on each chip', () => {
    show(department());
    const canvas = screen.getByRole('region', { name: 'Department schema' });
    expect(within(canvas).getByRole('button', { name: /Rita/ })).toHaveTextContent('Review #12 Task A');
    expect(within(canvas).getByRole('button', { name: /Bruno/ })).toHaveTextContent('Development #13 Independent B');
    expect(within(canvas).getByRole('button', { name: /Legacy agent/ })).toHaveTextContent('#9 Legacy task');
    expect(within(canvas).getByRole('button', { name: /Performance agent/ })).toBeInTheDocument();
    expect(canvas.querySelectorAll('.frame[data-echelon]')).toHaveLength(5);
    expect(canvas.querySelectorAll('.gl, .rl')).toHaveLength(0);
  });

  it('does not invent stages or owners when the department has no task with a route', () => {
    const d = department();
    show({ ...d, employees: d.employees.map(e => ({ ...e, task: null })) });
    expect(document.querySelectorAll('.frame[data-echelon]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Rita/ })).toHaveTextContent('Waiting for a new task');
  });

  it('preserves the existing department view when echelons are disabled', () => {
    const d = department();
    show({ ...d, echelonsEnabled: false } as Department);
    expect(document.querySelectorAll('.frame[data-echelon]')).toHaveLength(0);
    expect(screen.getByText('Legacy reviewer title')).toBeInTheDocument();
  });
});

