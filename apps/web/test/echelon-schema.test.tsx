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
/* The development roles as the template has them, listed out of their order on purpose. */
const ROLES = [role('DEV-TEST', 'Test engineer', null, 'final_check'), role('DEV-SEC', 'Security engineer', 2), role('DEV-REV', 'Code reviewer', 1),
  role('DEV-ARCH', 'Architect', null, 'before_work'), role('DEV-PERF', 'Performance engineer', null, 'observer')];
const PIPELINE = ['Architect', 'Backend engineer', 'Code reviewer', 'Security engineer', 'Test engineer'];

function department(): Department {
  const idle = base.employees[1]!;
  return { ...base, roles: [...base.roles, ...ROLES],
    employees: [
      ...base.employees.map(e => ({ ...e, task: e.id === 'b1' ? atDevelopment : e.id === 'reviewer' ? atReview : e.id === 'tester' ? atReview : null })),
      { ...idle, id: 'architect', roleId: 'DEV-ARCH', name: 'Ada', task: null },
      { ...idle, id: 'observer', roleId: 'DEV-PERF', name: 'Performance agent', task: null },
    ],
  };
}
const idle = (d: Department): Department => ({ ...d, employees: d.employees.map(e => ({ ...e, task: null })) });
function show(d: Department, language = 'en') {
  localStorage.setItem('hh-lang', language);
  mockApi({});
  return render(<LanguageProvider><DepartmentView me={ME} department={d} deputies={[]} selected={null}
    panel={null} onBack={() => {}} onHire={() => {}} onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
}
const frame = (name: string) => screen.getByRole('group', { name });
const left = (name: string) => parseFloat(frame(name).style.left);
const chip = (frameName: string, name: RegExp) => within(frame(frameName)).getByRole('button', { name });

describe('the department pipeline of roles', () => {
  it.each([
    ['en', 'without tasks', idle(department()), ['Gate 1', 'Gate 2', 'Gate 3']],
    ['ru', 'without tasks', idle(department()), ['Рубеж 1', 'Рубеж 2', 'Рубеж 3']],
    ['en', 'with tasks', department(), ['Gate 1', 'Gate 2', 'Gate 3']],
    ['ru', 'with tasks', department(), ['Рубеж 1', 'Рубеж 2', 'Рубеж 3']],
  ])('stands the roles left to right by the stages, a numbered gate before each check, in %s %s', (language, _, d, gates) => {
    show(d, language);
    const backend = language === 'ru' ? 'Бэкенд-разработчик' : 'Backend engineer';
    const names = PIPELINE.map(name => (name === 'Backend engineer' ? backend : name));
    for (let i = 1; i < names.length; i++) expect(left(names[i - 1]!)).toBeLessThan(left(names[i]!));
    expect(frame('Code reviewer')).toHaveClass('gt');
    expect(frame('Test engineer')).toHaveClass('gt');
    expect(frame(backend)).not.toHaveClass('gt');
    const canvas = screen.getByRole('region', { name: language === 'ru' ? 'Схема отдела' : 'Department schema' });
    expect([...canvas.querySelectorAll('.gl')].map(g => g.textContent)).toEqual(gates);
    expect(canvas.querySelectorAll('.wires .gd')).toHaveLength(3);
    expect(canvas.querySelectorAll('.rl, .rah')).toHaveLength(0);
    /* Each employee stays in its role's frame; only the observer stands apart, left of the pipeline. */
    expect(chip('Architect', /Ada/)).toBeInTheDocument();
    expect(chip(backend, /Bruno/)).toBeInTheDocument();
    expect(chip('Code reviewer', /Rita/)).toBeInTheDocument();
    expect(chip('Security engineer', /Sam/)).toBeInTheDocument();
    expect(chip('Test engineer', /Tom/)).toBeInTheDocument();
    expect(left('Performance engineer')).toBeLessThan(left('Architect'));
    expect(screen.queryByRole('group', { name: 'Review' })).not.toBeInTheDocument();
  });

  it('marks whoever leads a stage now in its own role frame, and nobody who only refers to that task', () => {
    show(department());
    expect(chip('Code reviewer', /Rita/)).toHaveTextContent('Review #12 Task A');
    expect(chip('Code reviewer', /Rita/)).toHaveClass('lead');
    expect(chip('Backend engineer', /Bruno/)).toHaveTextContent('Development #13 Independent B');
    expect(chip('Backend engineer', /Bruno/)).toHaveClass('lead');
    expect(chip('Test engineer', /Tom/)).toHaveTextContent('#12 Task A');
    expect(chip('Test engineer', /Tom/)).not.toHaveClass('lead');
    expect(chip('Architect', /Ada/)).not.toHaveClass('lead');
  });

  it('marks nobody when no one in the department holds a task', () => {
    show(idle(department()));
    expect(document.querySelectorAll('.schip.lead')).toHaveLength(0);
    expect(chip('Code reviewer', /Rita/)).toHaveTextContent('Waiting for a new task');
  });

  it('keeps an employee who leads the optional Cleanup in its role frame, with no frame for the stage', () => {
    const d = department();
    const stages = [...ECHELON_WORKFLOW.stages];
    stages.splice(3, 0, { stage: 'cleanup', ownerAgentId: 'reviewer', inputCandidateId: null, candidateId: null, status: 'active', reason: 'Requested by head' });
    const cleanup = { ...atReview, echelons: { ...ECHELON_WORKFLOW, stage: 'cleanup' as const, stages } };
    show({ ...d, employees: d.employees.map(e => (e.id === 'reviewer' ? { ...e, task: cleanup } : e)) });
    expect(screen.queryByRole('group', { name: 'Cleanup' })).not.toBeInTheDocument();
    expect(chip('Code reviewer', /Rita/)).toHaveClass('lead');
    expect(chip('Code reviewer', /Rita/)).toHaveTextContent('Cleanup #12 Task A');
  });
});
