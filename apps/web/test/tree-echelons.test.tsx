import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { TreeCardBody } from '../src/screens/TreeCard';
import { DEV_TREE } from './api-mock';
import { ECHELON_ORG, ECHELON_WORKFLOW } from './echelon-fixture';

const department = ECHELON_ORG.departments[0]!;
const finding = { ...emptyEchelonFindings(), uniqueReported: 1, review: { reported: 1, confirmed: 0 } };

function card(language = 'en', workflow = ECHELON_WORKFLOW) {
  localStorage.setItem('hh-lang', language);
  const line = { ...DEV_TREE.lines[0]!, taskId: 't12', number: 12, title: 'Keep totals', agent: { id: 'reviewer', name: 'Rita' },
    echelons: workflow, echelonFindings: finding, ownerSince: DEV_TREE.now, mergedAt: null, doneAt: null };
  const tree = { ...DEV_TREE, lines: [line] };
  const openTask = vi.fn();
  render(<LanguageProvider><TreeCardBody tree={tree} department={department} pick={{ kind: 'line', taskId: 't12', agentId: 'reviewer' }} onOpenTask={openTask} /></LanguageProvider>);
  return { openTask };
}

describe('the current echelon on a tree card', () => {
  it.each(['en', 'ru'])('shows the current route and attributed findings in %s', language => {
    card(language);
    const route = screen.getByRole('list', { name: language === 'ru' ? 'Маршрут задачи' : 'Task workflow' });
    expect(within(route).getAllByRole('listitem').map(step => step.querySelector('b')!.textContent)).toEqual(['Architecture', 'Development', 'Review', 'Security', 'Tests']);
    expect(route.querySelector('[aria-current="step"]')).toHaveTextContent('Review');
    expect(route.querySelector('[aria-current="step"]')).toHaveTextContent(language === 'ru' ? 'Исполнитель: Rita' : 'Owner: Rita');
    const findings = screen.getByRole('region', { name: language === 'ru' ? 'Находки по этапам' : 'Findings by stage' });
    expect(findings).toHaveTextContent('Review');
    expect(findings).toHaveTextContent('Security');
    expect(findings).not.toHaveTextContent('Cleanup');
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
});
