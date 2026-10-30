import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { StaffLine } from '../src/types';
import { StaffCard } from '../src/ui/StaffCard';
import { mockApi, ROSTER } from './api-mock';

const DEPT = { id: 'd2', name: 'Development' };

function card(proposal?: { id: string; brief: string; people: StaffLine[] }) {
  const calls = mockApi({ 'GET /api/departments/d2/roster': [200, ROSTER], 'POST /api/departments/d2/staff': [201, { hired: ['x1', 'x2'] }] });
  render(
    <LanguageProvider>
      <StaffCard department={DEPT} proposal={proposal} onCorrect={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

const options = (select: HTMLElement) => within(select).getAllByRole('option').map(o => o.textContent);

describe('StaffCard', () => {
  it('hires the ticked people with the picked models', async () => {
    const user = userEvent.setup();
    const calls = card({
      id: 'pr9',
      brief: 'Start with the API.',
      people: [
        { role: 'DEV-HEAD', checked: true },
        { role: 'DEV-BE', name: 'Bruno', checked: true, skills: { on: ['dev-api-design'], off: ['dev-tdd'] } },
        { role: 'DEV-FE', product: 'pd1', checked: false },
      ],
    });
    expect(await screen.findByText('Start with the API.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Frontend engineer \(Mascot\)/ })).not.toBeChecked();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model for Bruno' }), 'claude-sonnet-5-5');
    await user.click(screen.getByRole('button', { name: 'Hire (2)' }));
    await vi.waitFor(() =>
      expect(calls.find(c => c.method === 'POST')?.body).toEqual({
        proposalId: 'pr9',
        people: [
          { role: 'DEV-HEAD', name: 'Head of development', product: null, model: '', subscription: 's-key', skills: ['hh-report-to-head', 'hh-break-down'] },
          { role: 'DEV-BE', name: 'Bruno', product: null, model: 'claude-sonnet-5-5', subscription: 's-key', skills: ['hh-report-to-head', 'dev-api-design'] },
        ],
      }),
    );
    expect(await screen.findByText('Hired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hire (2)' })).toBeDisabled();
  });

  it('changes the model list when another subscription is picked', async () => {
    const user = userEvent.setup();
    card();
    const model = await screen.findByRole('combobox', { name: 'Model for Backend engineer' });
    expect(options(model)).toEqual(['Default', 'Claude Opus 5.5', 'Claude Sonnet 5.5']);
    await user.selectOptions(model, 'claude-opus-5-5');
    const runs = screen.getByRole('combobox', { name: 'Where Backend engineer runs' });
    expect(options(runs)).toEqual(['None yet', 'Codex, Oleg', 'Team key (Anthropic)']);
    expect(within(runs).getAllByRole('group').map(g => g.getAttribute('label'))).toEqual(['Codex', 'Anthropic']);
    await user.selectOptions(runs, 's-codex');
    expect(options(model)).toEqual(['Default', 'GPT-6.1 Sol']);
    expect(model).toHaveValue('');
  });

  it("names the people in the person's language", async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      card();
      expect(await screen.findByRole('checkbox', { name: /Бэкенд-разработчик/ })).toBeChecked();
      expect(screen.getByRole('button', { name: 'Нанять (2)' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });
});
