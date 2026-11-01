import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { AgentCardView, Me } from '../src/types';
import { AgentCard } from '../src/ui/AgentCard';
import { CARD, ME, mockApi, TEAM_KEY } from './api-mock';

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
  it('says the orchestrator made a change, and what it was', async () => {
    open({ 'GET /api/agents/b1': [200, { ...CARD, changes: [{ field: 'switch', personName: null, byOrchestrator: true, at: '2026-10-30T09:00:00.000Z' }] }] });
    expect(await screen.findByText(/^Switched on or off: Orchestrator, /)).toBeInTheDocument();
  });

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

  it('keeps what the person typed after Save while the prompt was being saved', async () => {
    const user = userEvent.setup();
    let answer = () => {};
    const saved = { ...CARD, parts: CARD.parts.map(p => (p.id === 'dev-tdd' ? { ...p, text: p.text.replace('Write the test first.', 'Write it first.') } : p)) };
    open({ 'PATCH /api/agents/b1': () => new Promise(resolve => (answer = () => resolve([200, saved]))) });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Test first' }), { target: { value: 'Write it first.' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Backend engineer' }), { target: { value: 'You build the billing API.' } });
    await act(async () => {
      answer();
      await new Promise(r => setTimeout(r, 50));
    });
    expect(screen.getByRole('textbox', { name: 'Test first' })).toHaveValue('Write it first.');
    expect(screen.getByRole('textbox', { name: 'Backend engineer' })).toHaveValue('You build the billing API.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('keeps a raw text changed after Save while the prompt was being saved', async () => {
    const user = userEvent.setup();
    let answer = () => {};
    const first = CARD.raw.replace('Write the test first.', 'Write it first.');
    const saved = { ...CARD, raw: first, parts: CARD.parts.map(p => (p.id === 'dev-tdd' ? { ...p, text: p.text.replace('Write the test first.', 'Write it first.') } : p)) };
    open({ 'PATCH /api/agents/b1': () => new Promise(resolve => (answer = () => resolve([200, saved]))) });
    await user.click(await screen.findByRole('button', { name: 'Raw' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw' }), { target: { value: first } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const second = first.replace('You build the API.', 'You build the billing API.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw' }), { target: { value: second } });
    await act(async () => {
      answer();
      await new Promise(r => setTimeout(r, 50));
    });
    expect(screen.getByRole('textbox', { name: 'Raw' })).toHaveValue(second);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
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

  it('saves how hard the employee thinks, from the levels its model takes', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'PATCH /api/agents/b1': patched });
    const effort = await screen.findByRole('combobox', { name: 'Effort' });
    expect(effort).toHaveValue('');
    expect(within(effort).getAllByRole('option').map(o => o.textContent)).toEqual(['Default', 'Low', 'High', 'Max']);
    await user.selectOptions(effort, 'max');
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ effort: 'max' }));
    expect(screen.getByRole('combobox', { name: 'Effort' })).toHaveValue('max');
  });

  it('sets a timer: how often the employee wakes and what it does each time', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'PATCH /api/agents/b1': patched });
    const on = await screen.findByRole('checkbox', { name: 'Wake on a timer' });
    expect(on).not.toBeChecked();
    expect(screen.queryByRole('combobox', { name: 'How often' })).not.toBeInTheDocument();
    await user.click(on);
    const often = screen.getByRole('combobox', { name: 'How often' });
    expect(within(often).getAllByRole('option').map(o => o.textContent)).toEqual([
      'Every 10 minutes', 'Every 15 minutes', 'Every 30 minutes', 'Every hour', 'Every 2 hours', 'Every 3 hours', 'Every 6 hours', 'Every 12 hours', 'Every 24 hours',
    ]);
    await user.selectOptions(often, '60');
    expect(screen.getByRole('button', { name: 'Save timer' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'What to do each time' }), 'Check that every agent reported its task.');
    const forWork = screen.getByRole('checkbox', { name: 'Only when there is work: a task is open or something failed since the last round' });
    expect(forWork).not.toBeChecked();
    await user.click(forWork);
    await user.click(screen.getByRole('button', { name: 'Save timer' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ timer: { minutes: 60, order: 'Check that every agent reported its task.', forWork: true } }));
  });

  it('shows the timer the employee has and takes it away', async () => {
    const user = userEvent.setup();
    const timer = { minutes: 10, order: 'Look around.', forWork: true, lastAt: new Date(Date.now() - 2 * 60_000).toISOString() };
    const { calls } = open({ 'GET /api/agents/b1': [200, { ...CARD, timer }], 'PATCH /api/agents/b1': patched });
    const on = await screen.findByRole('checkbox', { name: 'Wake on a timer' });
    expect(on).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'How often' })).toHaveValue('10');
    expect(screen.getByRole('textbox', { name: 'What to do each time' })).toHaveValue('Look around.');
    expect(screen.getByRole('checkbox', { name: /^Only when there is work/ })).toBeChecked();
    /* It counts from the last round or from when the timer was set, so the card says when the next one comes. */
    expect(screen.getByText(/^Next round: \D{3}/)).toBeInTheDocument();
    await user.click(on);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ timer: null }));
  });

  it('says a round that is due comes as soon as the employee is free', async () => {
    const timer = { minutes: 10, order: 'Look around.', forWork: false, lastAt: new Date(Date.now() - 30 * 60_000).toISOString() };
    open({ 'GET /api/agents/b1': [200, { ...CARD, timer }] });
    expect(await screen.findByText('Next round: as soon as it is free')).toBeInTheDocument();
  });

  it('names the level the Default runs at: Kimi at its most', async () => {
    const kimi = { ...TEAM_KEY, id: 's-kimi', provider: 'kimi' as const };
    const k3 = { id: 'k3', name: 'K3', efforts: ['low', 'high', 'max'], defaultEffort: 'high' };
    open({ 'GET /api/agents/b1': [200, { ...CARD, model: '', subscription: kimi, runsOn: [{ subscription: kimi, models: [k3] }] }] });
    expect(await screen.findByRole('option', { name: 'Default (Max)' })).toBeInTheDocument();
  });

  it('names the level Claude Code runs its Default model at: medium on Opus 5.5', async () => {
    const plan = { ...TEAM_KEY, id: 's-cl', provider: 'claude' as const };
    const opus = { id: 'opus', name: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' };
    open({ 'GET /api/agents/b1': [200, { ...CARD, model: '', subscription: plan, runsOn: [{ subscription: plan, models: [opus] }] }] });
    expect(await screen.findByRole('option', { name: 'Default (Medium)' })).toBeInTheDocument();
  });

  it("names the Default by its model's own level when the program has one", async () => {
    const codex = { ...TEAM_KEY, id: 's-cx', provider: 'codex' as const };
    const sol = { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'xhigh', 'ultra'], defaultEffort: 'low' };
    open({ 'GET /api/agents/b1': [200, { ...CARD, model: 'gpt-6.1-sol', subscription: codex, runsOn: [{ subscription: codex, models: [sol] }] }] });
    const effort = await screen.findByRole('combobox', { name: 'Effort' });
    expect(within(effort).getAllByRole('option').map(o => o.textContent)).toEqual(['Default (Low)', 'Low', 'Extra high', 'Ultra']);
  });

  it('lets a person go back to Default when the program no longer says which levels its model takes', async () => {
    const user = userEvent.setup();
    const bare = { ...CARD, effort: 'max', runsOn: [{ subscription: TEAM_KEY, models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] }] };
    const { calls } = open({ 'GET /api/agents/b1': [200, bare], 'PATCH /api/agents/b1': [200, { ...bare, effort: null }] });
    const effort = await screen.findByRole('combobox', { name: 'Effort' });
    expect(effort).toBeEnabled();
    expect(within(effort).getAllByRole('option').map(o => o.textContent)).toEqual(['Default', 'Max']);
    await user.selectOptions(effort, '');
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ effort: null }));
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
    const { calls } = open({ 'POST /api/agents/b1/reset': [200, { ...CARD, changes: [{ field: 'reset', personName: 'Ivan', byOrchestrator: false, at: '2026-10-30T09:00:00.000Z' }, ...CARD.changes] }] });
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
    open({ 'GET /api/agents/b1': [200, { ...CARD, canEdit: false }] }, listed);
    expect(await screen.findByRole('combobox', { name: 'Model' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /API design/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reset to template' })).not.toBeInTheDocument();
    expect(screen.getByText("Only people with access to this employee's department or the whole company can change it.")).toBeInTheDocument();
  });

  it("lets a person of the department change the card but not remove the employee", async () => {
    const listed: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed' } };
    open({}, listed);
    expect(await screen.findByRole('combobox', { name: 'Model' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /API design/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reset to template' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove from the company' })).not.toBeInTheDocument();
  });

  it('keeps edits made in both views of the prompt', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'PATCH /api/agents/b1': [200, CARD] });
    await user.click(await screen.findByRole('button', { name: 'Raw' }));
    const billing = CARD.raw.replace('You build the API.', 'You build the billing API.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw' }), { target: { value: billing } });
    await user.click(screen.getByRole('button', { name: 'By skill' }));
    expect(screen.getByRole('textbox', { name: 'Backend engineer' })).toHaveValue('You build the billing API.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Test first' }), { target: { value: 'Write it first.' } });
    await user.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByRole('textbox', { name: 'Raw' })).toHaveValue(billing.replace('Write the test first.', 'Write it first.'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ base: 'You build the billing API.', skillText: { 'dev-tdd': 'Write it first.' } }));
  });
});
