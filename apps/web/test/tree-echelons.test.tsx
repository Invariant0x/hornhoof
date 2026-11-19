import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { TreeCardBody } from '../src/screens/TreeCard';
import type { DepartmentTree } from '../src/types';
import { DEV_TREE } from './api-mock';
import { ECHELON_ORG, ECHELON_WORKFLOW } from './echelon-fixture';

const department = ECHELON_ORG.departments[0]!;
const finding = { ...emptyEchelonFindings(), uniqueReported: 1, review: { reported: 1, confirmed: 0 } };

function card(language = 'en', workflow = ECHELON_WORKFLOW, activity: DepartmentTree['activity'] = DEV_TREE.activity) {
  localStorage.setItem('hh-lang', language);
  const line = { ...DEV_TREE.lines[0]!, taskId: 't12', number: 12, title: 'Keep totals', agent: { id: 'reviewer', name: 'Rita' },
    echelons: workflow, echelonFindings: finding, ownerSince: DEV_TREE.now, mergedAt: null, doneAt: null };
  const tree = { ...DEV_TREE, lines: [line], activity };
  const openTask = vi.fn();
  render(<LanguageProvider><TreeCardBody tree={tree} department={department} pick={{ kind: 'line', taskId: 't12', agentId: 'reviewer' }} onOpenTask={openTask} /></LanguageProvider>);
  return { openTask };
}

describe('the current echelon on a tree card', () => {
  it.each(['en', 'ru'])('shows the current route and attributed findings in %s', language => {
    card(language);
    const stages = language === 'ru' ? ['Архитектура', 'Разработка', 'Проверка', 'Безопасность', 'Тесты'] : ['Architecture', 'Development', 'Review', 'Security', 'Tests'];
    const route = screen.getByRole('list', { name: language === 'ru' ? 'Маршрут задачи' : 'Task workflow' });
    expect(within(route).getAllByRole('listitem').map(step => step.querySelector('b')!.textContent)).toEqual(stages);
    expect(route.querySelector('[aria-current="step"]')).toHaveTextContent(stages[2]!);
    expect(route.querySelector('[aria-current="step"]')).toHaveTextContent(language === 'ru' ? 'Исполнитель: Rita' : 'Owner: Rita');
    const findings = screen.getByRole('region', { name: language === 'ru' ? 'Находки по этапам' : 'Findings by stage' });
    expect(findings).toHaveTextContent(stages[2]!);
    expect(findings).toHaveTextContent(stages[3]!);
    expect(findings).not.toHaveTextContent(language === 'ru' ? 'Уборка лишнего' : 'Cleanup');
    expect(screen.queryByText(/Review of the turn|Ревью хода/)).not.toBeInTheDocument();
  });

  it('keeps a required stage waiting without naming the former author as current owner', () => {
    card('en', { ...ECHELON_WORKFLOW, ownerAgentId: null, phase: 'waiting' });
    expect(screen.getByText('Waiting for an owner')).toBeInTheDocument();
    const current = screen.getByRole('list', { name: 'Task workflow' }).querySelector('[aria-current="step"]');
    expect(current).not.toHaveTextContent('Bruno');
    expect(current).not.toHaveTextContent('Owner:');
  });

  it('opens the same task from its current owner card', () => {
    const { openTask } = card();
    fireEvent.click(screen.getByRole('button', { name: '#12 Keep totals' }));
    expect(openTask).toHaveBeenCalledWith('t12');
  });

  it('names a checker absent from the current roster only from observed activity', () => {
    card('en', { ...ECHELON_WORKFLOW, ownerAgentId: 'observed-checker' }, [
      { jobId: 'observed-job', agent: { id: 'observed-checker', name: 'Observed checker' }, task: null, segments: [{ kind: 'work', from: DEV_TREE.now, to: null }] },
    ]);
    const current = screen.getByRole('list', { name: 'Task workflow' }).querySelector('[aria-current="step"]');
    expect(current).toHaveTextContent('Owner: Observed checker');
    expect(current).not.toHaveTextContent('Bruno');
  });

  it.each([undefined, []])('keeps an unknown checker identity without borrowing a former owner name: %j', activity => {
    card('en', { ...ECHELON_WORKFLOW, ownerAgentId: 'unknown-checker' }, activity);
    const current = screen.getByRole('list', { name: 'Task workflow' }).querySelector('[aria-current="step"]');
    expect(current).toHaveTextContent('Owner: unknown-checker');
    expect(current).not.toHaveTextContent('Rita');
    expect(current).not.toHaveTextContent('Bruno');
  });
});
