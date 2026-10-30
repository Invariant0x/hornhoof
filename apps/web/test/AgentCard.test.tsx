import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { AgentCardView, Me } from '../src/types';
import { AgentCard } from '../src/ui/AgentCard';
import { CARD, ME, mockApi } from './api-mock';

function open(routes: Record<string, unknown> = {}, me: Me = ME) {
  const calls = mockApi({ 'GET /api/agents/b1': [200, CARD], ...(routes as Record<string, [number, unknown]>) });
  const onTerminal = vi.fn();
  render(
    <LanguageProvider>
      <AgentCard me={me} agentId="b1" onClose={() => {}} onTerminal={onTerminal} />
    </LanguageProvider>,
  );
  return { calls, onTerminal };
}

const patched = (body: unknown): [number, AgentCardView] => [200, { ...CARD, ...(body as Partial<AgentCardView>) }];

describe('AgentCard', () => {
  it('shows the skills as a checklist with locked core skills', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'PATCH /api/agents/b1': [200, CARD] });
    const locked = await screen.findByRole('checkbox', { name: /Report to your head/ });
    expect(locked).toBeChecked();
    expect(locked).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Test first/ })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /API design/ })).not.toBeChecked();
    expect(screen.getAllByText('Template changed').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('checkbox', { name: /API design/ }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ skills: { 'dev-api-design': true } }));
  });

  it('switches between the prompt by skill and raw', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'PATCH /api/agents/b1': [200, CARD] });
    expect(await screen.findByRole('textbox', { name: 'Test first' })).toHaveValue('Write the test first.');
    expect(screen.getByRole('textbox', { name: 'Backend engineer' })).toHaveValue('You build the API.');
    await user.click(screen.getByRole('button', { name: 'Raw' }));
    const raw = screen.getByRole('textbox', { name: 'Raw' });
    expect(raw).toHaveValue(CARD.raw);
    fireEvent.change(raw, { target: { value: CARD.raw.replace('Write the test first.', 'Write it first.') } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ skillText: { 'dev-tdd': 'Write it first.' } }));
  });

  it('refuses a raw edit that breaks the skill markers', async () => {
    const user = userEvent.setup();
    const { calls } = open();
    await user.click(await screen.findByRole('button', { name: 'Raw' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw' }), { target: { value: CARD.raw.replace('<!-- /hh:skill -->', '') } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/Keep the first part and the skill markers as they are/)).toBeInTheDocument();
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('saves a changed model and shows it applies from the next turn', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'PATCH /api/agents/b1': patched });
    const model = await screen.findByRole('combobox', { name: 'Model' });
    expect(model).toHaveValue('claude-sonnet-5-5');
    await user.selectOptions(model, 'claude-opus-5-5');
    expect(await screen.findByText('Applies from the next turn.')).toBeInTheDocument();
    expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ model: 'claude-opus-5-5' });
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('claude-opus-5-5');
  });

  it('moves the employee to another subscription', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'PATCH /api/agents/b1': [200, { ...CARD, model: '', subscription: CARD.runsOn[1]!.subscription }] });
    const runs = await screen.findByRole('combobox', { name: 'Runs on' });
    expect(within(runs).getAllByRole('group').map(g => g.getAttribute('label'))).toEqual(['Codex', 'Anthropic']);
    await user.selectOptions(runs, 's-codex');
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ subscription: 's-codex' }));
    expect(await screen.findByRole('option', { name: 'GPT-6.1 Sol' })).toBeInTheDocument();
  });

  it('resets to the template after asking', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'POST /api/agents/b1/reset': [200, { ...CARD, changes: [{ field: 'reset', personName: 'Ivan', at: '2026-10-30T09:00:00.000Z' }, ...CARD.changes] }] });
    await user.click(await screen.findByRole('button', { name: 'Reset to template' }));
    expect(calls.some(c => c.path === '/api/agents/b1/reset')).toBe(false);
    expect(screen.getByText('Reset Bruno to the template? Its own prompt and skill changes are lost.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, reset' }));
    await vi.waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/api/agents/b1/reset')).toBe(true));
    expect(await screen.findByText(/Reset to the template: Ivan/)).toBeInTheDocument();
  });

  it('names an employee once when it is called after its role', async () => {
    open({ 'GET /api/agents/b1': [200, { ...CARD, name: 'Backend engineer' }] });
    const card = await screen.findByRole('complementary', { name: 'Backend engineer' });
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent('Backend engineer');
    expect(within(card).queryByText('Backend engineer', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('opens the terminal', async () => {
    const user = userEvent.setup();
    const { onTerminal } = open();
    await user.click(await screen.findByRole('button', { name: 'Open terminal' }));
    expect(onTerminal).toHaveBeenCalled();
  });

  it('only shows the card to someone who cannot change it', async () => {
    const listed: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed' } };
    open({}, listed);
    expect(await screen.findByRole('combobox', { name: 'Model' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /API design/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reset to template' })).not.toBeInTheDocument();
    expect(screen.getByText('Only people with access to the whole company can change employees.')).toBeInTheDocument();
  });
});
