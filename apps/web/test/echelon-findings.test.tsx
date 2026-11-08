import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { TaskPanel } from '../src/ui/TaskPanel';
import { mockApi } from './api-mock';
import { ECHELON_TASK, ECHELON_ORG } from './echelon-fixture';
import { ECHELON_FINDINGS } from './echelon-findings';

function show(findings: unknown, language = 'en') {
  localStorage.setItem('hh-lang', language);
  mockApi({
    'GET /api/org': [200, ECHELON_ORG],
    'GET /api/tasks/t12': [200, { task: { ...ECHELON_TASK, echelonFindings: findings } }],
  });
  render(<LanguageProvider><TaskPanel taskId="t12" requests={[]} onClose={() => {}} onOpen={() => {}}
    onRequestsChanged={() => {}} onOpenAgent={() => {}} /></LanguageProvider>);
}

describe('echelon finding evidence', () => {
  it('keeps reported and independently confirmed findings separate and exposes their source and fix candidates', async () => {
    const user = userEvent.setup();
    show(ECHELON_FINDINGS);
    const findings = await screen.findByRole('region', { name: 'Findings' });
    expect(findings).toHaveTextContent('2 reported, 1 confirmed');
    expect(findings).toHaveTextContent('0 reported, 0 confirmed');
    await user.click(within(findings).getByText('Review: finding-a'));
    for (const evidence of ['source-event-a', 'input-candidate', 'a'.repeat(40), 'fix-candidate', 'b'.repeat(40), 'confirmation-event-a', 'review-model', 'reviewer', 'b1']) {
      expect(within(findings).getAllByText(evidence).length).toBeGreaterThan(0);
    }
    await user.click(within(findings).getByText('Review: finding-b'));
    expect(within(findings).getByText('No confirmations recorded')).toBeInTheDocument();
  });

  it.each(['en', 'ru'])('keeps English stage names and unknown metrics distinct from zero in %s', async language => {
    show({ status: 'unavailable', reason: 'legacy_task' }, language);
    const findings = await screen.findByRole('region', { name: language === 'ru' ? 'Находки' : 'Findings' });
    expect(findings).toHaveTextContent(language === 'ru' ? 'Данные о находках недоступны для этой задачи.' : 'Finding data is not available for this task.');
    expect(findings).not.toHaveTextContent('0');
  });
});
