import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { TaskPanel } from '../src/ui/TaskPanel';
import { openTaskAction } from './open-task';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { mockApi } from './api-mock';
import { ECHELON_ORG, ECHELON_TASK } from './echelon-fixture';

describe('visible echelon finding metrics', () => {
  it.each(['en', 'ru'])('shows stage occurrences and unique confirmations separately in %s', async language => {
    localStorage.setItem('hh-lang', language);
    const task = { ...ECHELON_TASK, echelonFindings: { uniqueReported: 2, uniqueConfirmed: 1, review: { reported: 2, confirmed: 1 }, security: { reported: 1, confirmed: 1 }, cleanup: { reported: 0, confirmed: 0 }, issues: [] } };
    mockApi({ 'GET /api/org': [200, ECHELON_ORG], 'GET /api/tasks/t12': [200, { task }] });
    render(<LanguageProvider><TaskPanel taskId="t12" onClose={() => {}} onOpen={() => {}} requests={[]} onRequestsChanged={() => {}} onOpenAgent={() => {}} /></LanguageProvider>);
    await openTaskAction(userEvent.setup(), await screen.findByRole('complementary'), language === 'ru' ? ru.tasks.details : en.tasks.details);
    const metrics = await screen.findByRole('region', { name: language === 'ru' ? 'Находки по этапам' : 'Findings by stage' });
    expect(metrics).toHaveTextContent(language === 'ru' ? 'Уникальных находок: 2' : 'Unique findings: 2');
    expect(metrics).toHaveTextContent(language === 'ru' ? 'Подтверждено: 1' : 'Confirmed: 1');
    const review = within(metrics).getByText('Review').parentElement!;
    const security = within(metrics).getByText('Security').parentElement!;
    expect(review).toHaveTextContent(language === 'ru' ? 'Найдено: 2' : 'Reported: 2');
    expect(security).toHaveTextContent(language === 'ru' ? 'Найдено: 1' : 'Reported: 1');
    expect(metrics).not.toHaveTextContent('Cleanup');
  });
});
