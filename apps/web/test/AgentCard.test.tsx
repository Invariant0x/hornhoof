import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { AgentCardView, SubView } from '../src/types';
import { AgentCard } from '../src/ui/AgentCard';
import { CARD, mockApi, SUBS, TEAM_KEY } from './api-mock';

function open(routes: Record<string, unknown> = {}) {
  const calls = mockApi({ 'GET /api/agents/b1': [200, CARD], ...(routes as Record<string, [number, unknown]>) });
  render(
    <LanguageProvider>
      <AgentCard agentId="b1" onClose={() => {}} />
    </LanguageProvider>,
  );
  return { calls };
}

const patched = (body: unknown): [number, AgentCardView] => [200, { ...CARD, ...(body as Partial<AgentCardView>) }];

const ROLE_IDENTITY = 'You are the backend engineer of the Development department.';
const assignmentCard = (assignment = '', skill = 'Write the test first.') => {
  const parts = [
    ...CARD.parts.filter(p => p.kind === 'header'),
    ...CARD.parts.filter(p => p.kind === 'base').map(p => ({ ...p, text: ROLE_IDENTITY })),
    { kind: 'assignment' as const, id: null, title: { en: 'Assignment', ru: 'Назначение' }, text: `<!-- hh:assignment -->\n## Assignment\n\n${assignment}\n<!-- /hh:assignment -->`, overridden: true, templateChanged: false },
    ...CARD.parts.filter(p => p.kind === 'skill').map(p => p.id === 'dev-tdd' ? { ...p, text: p.text.replace('Write the test first.', skill) } : p),
  ];
  return { ...CARD, parts, raw: parts.map(p => p.text).join('\n\n') };
};

describe('AgentCard', () => {
  it('identifies a turnkey member on the employee card', async () => {
    open({ 'GET /api/agents/b1': [200, { ...CARD, team: { id: 'u1', name: 'Whole tasks' }, turnkey: true }] });
    await screen.findByRole('heading', { name: 'Bruno', level: 3 });
    expect(screen.getByRole('img', { name: 'Generalist: does a task whole' }).querySelector('svg rect')).toBeInTheDocument();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 3, 16, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says the orchestrator made a change, and what it was', async () => {
    open({ 'GET /api/agents/b1': [200, { ...CARD, changes: [{ field: 'switch', personName: null, byOrchestrator: true, at: '2026-10-30T09:00:00.000Z' }] }] });
    expect(await screen.findByText(/^Switched on or off: Orchestrator, /)).toBeInTheDocument();
  });

  it('names the acting head and whose rights it used, keeping human, old and automatic changes in both languages', async () => {
    for (const [lang, head, human, orchestrator, automatic] of [
      ['en', 'Name: Head Hana (authority: Dana),', 'Skills: Ivan,', 'Switched on or off: Orchestrator,', 'Reset to the template,'],
      ['ru', 'Имя: глава Hana (права Dana),', 'Навыки: Ivan,', 'Включен или выключен: Оркестратор,', 'Возврат к шаблону,'],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      const at = '2026-10-30T09:00:00.000Z';
      open({ 'GET /api/agents/b1': [200, { ...CARD, changes: [
        { field: 'name', personName: 'Dana', actingAgent: { id: 'head-id', name: 'Hana' }, byOrchestrator: false, at },
        { field: 'skills', personName: 'Ivan', actingAgent: null, byOrchestrator: false, at },
        { field: 'switch', personName: null, actingAgent: null, byOrchestrator: true, at },
        { field: 'reset', personName: null, actingAgent: null, byOrchestrator: false, at },
      ] }] });
      await screen.findByRole('heading', { name: 'Bruno' });
      const history = within(screen.getByRole('heading', { name: lang === 'en' ? 'Changes' : 'Изменения' }).parentElement!);
      const lines = history.getAllByRole('listitem').map(item => item.textContent);
      for (const expected of [head, human, orchestrator, automatic]) expect(lines.some(line => line?.startsWith(expected)), `${lang}: ${expected}`).toBe(true);
      cleanup();
      localStorage.removeItem('hh-lang');
    }
  });

  it('lists its turns a node restart cut off, why, where and on which task, in each language', async () => {
    const interrupted = [
      { job: 'bbbbbbbb-0000-4000-8000-000000000002', at: '2026-11-03T00:20:00.000Z', cause: 'container' as const, node: 'dev-laptop', task: { id: 't12', number: 12 }, retry: true },
      { job: 'aaaaaaaa-0000-4000-8000-000000000001', at: '2026-11-03T00:11:00.000Z', cause: 'unknown' as const, node: null, task: null, retry: false },
    ];
    for (const [lang, words] of [
      ['en', { heading: 'Turns cut off by a node restart', latest: ['#12', 'dev-laptop, ', 'Its container was created again', 'Turn bbbbbbbb.', 'It was a retry.'], earlier: ['The built-in node, ', 'Why it restarted is not known.', 'Turn aaaaaaaa.'] }],
      ['ru', { heading: 'Ходы, прерванные перезапуском ноды', latest: ['#12', 'dev-laptop, ', 'Ее контейнер создан заново', 'Ход bbbbbbbb.', 'Это был повтор.'], earlier: ['Встроенная нода, ', 'Причина перезапуска неизвестна.', 'Ход aaaaaaaa.'] }],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      open({ 'GET /api/agents/b1': [200, { ...CARD, interrupted }] });
      const list = within(await screen.findByRole('region', { name: words.heading })).getAllByRole('listitem').map(li => li.textContent!);
      expect(list).toHaveLength(2);
      for (const said of words.latest) expect(list[0]).toContain(said);
      for (const said of words.earlier) expect(list[1]).toContain(said);
      expect(list[1]).not.toContain('#');
      cleanup();
      localStorage.removeItem('hh-lang');
    }
  });

  it('shows no restarts when none cut its turns off', async () => {
    open();
    await screen.findByRole('heading', { name: 'Bruno' });
    expect(screen.queryByRole('region', { name: 'Turns cut off by a node restart' })).not.toBeInTheDocument();
  });

  it('shows the latest failed turn under the state in English and Russian, with tooltip and collapsed details clipped to 300 characters', async () => {
    /* The card's clock stands on one day, so 14:02 is today whenever the test runs. */
    const at = new Date(2026, 10, 3, 14, 2).getTime();
    const rawText = `529 Overloaded: ${'x'.repeat(340)}`;
    const clipped = `${rawText.slice(0, 299)}…`;
    expect(clipped).toHaveLength(300);

    for (const [lang, expected] of [
      ['en', 'Last turn failed at 14:02: provider overloaded'],
      ['ru', 'Последний ход не удался в 14:02: провайдер перегружен'],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      open({ 'GET /api/agents/b1': [200, { ...CARD, failure: { kind: 'overloaded', text: rawText, at } }] });
      const summary = await screen.findByText(expected);
      expect(summary).toHaveAttribute('title', clipped);
      const details = summary.closest('details');
      expect(details).not.toBeNull();
      expect(details).not.toHaveAttribute('open');
      expect(details?.previousElementSibling).toHaveClass('ac-state');
      const pre = details?.querySelector('pre');
      expect(pre?.textContent).toBe(clipped);
      expect(pre?.textContent).toHaveLength(300);
      cleanup();
      localStorage.removeItem('hh-lang');
    }

    open({ 'GET /api/agents/b1': [200, { ...CARD, failure: { kind: 'rate_limited', text: '429 Too Many Requests', at } }] });
    const shortLine = await screen.findByText('Last turn failed at 14:02: too many requests');
    expect(shortLine).toHaveAttribute('title', '429 Too Many Requests');
    expect(shortLine.closest('details')?.querySelector('pre')?.textContent).toBe('429 Too Many Requests');
    cleanup();

    open({ 'GET /api/agents/b1': [200, { ...CARD, failure: { kind: 'rate_limited', text: '', at } }] });
    const bareLine = await screen.findByText('Last turn failed at 14:02: too many requests');
    expect(bareLine.tagName).toBe('P');
    expect(bareLine).toHaveClass('ac-failure');
  });

  it('shows the stale reason and says when the program gave no output in English and Russian', async () => {
    const at = new Date(2026, 10, 3, 14, 2).getTime();
    const text = 'Stale queued wake. Program state: not started. Last sign of life: no data.';
    for (const [lang, noOutput] of [['en', 'No output.'], ['ru', 'Вывода не было.']] as const) {
      localStorage.setItem('hh-lang', lang);
      open({ 'GET /api/agents/b1': [200, { ...CARD, failure: { kind: 'unknown', text, at, tail: 'No output.' } }] });
      const summary = await screen.findByText(/Last turn failed at 14:02|Последний ход не удался в 14:02/);
      const details = summary.closest('details');
      expect(details?.querySelector('pre')).toHaveTextContent(text);
      expect(details).toHaveTextContent(noOutput);
      cleanup();
      localStorage.removeItem('hh-lang');
    }
  });

  it('shows an obsolete wake calmly in English and Russian without a failure', async () => {
    const at = new Date(2026, 10, 3, 14, 2).getTime();
    for (const [lang, expected] of [
      ['en', 'Wake-up became obsolete: the task moved on'],
      ['ru', 'Побудка устарела: задача ушла дальше'],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      open({ 'GET /api/agents/b1': [200, { ...CARD, obsolete: { at } }] });
      const line = await screen.findByText(expected);
      expect(line).toHaveClass('ac-obsolete');
      expect(screen.queryByText(/Last turn failed|Последний ход не удался/)).not.toBeInTheDocument();
      cleanup();
      localStorage.removeItem('hh-lang');
    }
  });

  it('shows only the clock time when the last turn failed today, and the date with the time when it failed earlier, in English and Russian', async () => {
    const todayAt = new Date(2026, 10, 3, 14, 2).getTime();
    const twoDaysAgoAt = new Date(2026, 10, 1, 14, 2).getTime();

    for (const [lang, todayLine, earlierLine] of [
      ['en', 'Last turn failed at 14:02: provider overloaded', 'Last turn failed on 01/11/2026, 14:02: provider overloaded'],
      ['ru', 'Последний ход не удался в 14:02: провайдер перегружен', 'Последний ход не удался 01.11.2026, 14:02: провайдер перегружен'],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      open({ 'GET /api/agents/b1': [200, { ...CARD, failure: { kind: 'overloaded', text: '529 Overloaded', at: todayAt } }] });
      expect(await screen.findByText(todayLine)).toBeInTheDocument();
      cleanup();

      open({ 'GET /api/agents/b1': [200, { ...CARD, failure: { kind: 'overloaded', text: '529 Overloaded', at: twoDaysAgoAt } }] });
      expect(await screen.findByText(earlierLine)).toBeInTheDocument();
      cleanup();
      localStorage.removeItem('hh-lang');
    }
  });

  it('shows nothing under the state when failure is null or omitted, and shows a waiting retry on the state line', async () => {
    for (const failure of [null, undefined]) {
      open({ 'GET /api/agents/b1': [200, { ...CARD, failure }] });
      await screen.findByRole('heading', { name: 'Bruno' });
      expect(screen.queryByText(/Last turn failed/)).not.toBeInTheDocument();
      expect(document.querySelector('.ac-failure')).toBeNull();
      cleanup();
    }

    const retryAt = new Date(2026, 10, 3, 14, 5).getTime();
    for (const [lang, expected] of [
      ['en', 'retry 2 of 4 at 14:05 (provider overloaded)'],
      ['ru', 'повтор 2 из 4 в 14:05 (провайдер перегружен)'],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      open({ 'GET /api/agents/b1': [200, { ...CARD, retry: { attempt: 2, max: 4, at: retryAt, kind: 'overloaded' } }] });
      const line = await screen.findByText(expected);
      expect(line.closest('.ac-state')).not.toBeNull();
      expect(line).toHaveClass('ast', 'calm');
      cleanup();
      localStorage.removeItem('hh-lang');
    }
  });

  it("clears a fetched retry when live state has retry: null, while keeping the card's retry when live has no retry field", async () => {
    const retryAt = new Date(2026, 10, 3, 14, 5).getTime();
    const retry = { attempt: 2, max: 4, at: retryAt, kind: 'overloaded' as const };
    mockApi({ 'GET /api/agents/b1': [200, { ...CARD, retry }] });
    const card = (live?: Parameters<typeof AgentCard>[0]['live']) => (
      <LanguageProvider>
        <AgentCard agentId="b1" live={live} onClose={() => {}} />
      </LanguageProvider>
    );
    const { rerender } = render(card());
    const expected = 'retry 2 of 4 at 14:05 (provider overloaded)';
    expect(await screen.findByText(expected)).toBeInTheDocument();

    rerender(card({ id: 'b1', program: null, alarm: null, retry: null }));
    expect(screen.queryByText(expected)).not.toBeInTheDocument();

    rerender(card({ id: 'b1', program: null, alarm: null }));
    expect(screen.getByText(expected)).toBeInTheDocument();
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
    expect(screen.getByRole('textbox', { name: 'Assignment' })).toHaveValue('You build the API.');
    expect(screen.getByRole('textbox', { name: 'Backend engineer' })).toHaveAttribute('readonly');
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Assignment' }), { target: { value: 'You build the billing API.' } });
    answer();
    /* The note comes in the same render as the saved card, so what the typing left is the answer's whole effect. */
    expect(await screen.findByText('Applies from the next turn.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Test first' })).toHaveValue('Write it first.');
    expect(screen.getByRole('textbox', { name: 'Assignment' })).toHaveValue('You build the billing API.');
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
    answer();
    /* The note comes in the same render as the saved card, so what the typing left is the answer's whole effect. */
    expect(await screen.findByText('Applies from the next turn.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Raw' })).toHaveValue(second);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('refuses a raw edit that breaks the skill markers', async () => {
    const user = userEvent.setup();
    const { calls } = open();
    await user.click(await screen.findByRole('button', { name: 'Raw' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw' }), { target: { value: CARD.raw.replace('<!-- /hh:skill -->', '') } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/Keep the identity, headings and assignment and skill markers as they are/)).toBeInTheDocument();
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('opens the prompt without an instruction budget', async () => {
    const olderCard = { ...CARD, instructions: { length: 12_345, max: 200_000 } };
    open({ 'GET /api/agents/b1': [200, olderCard] });
    expect(await screen.findByRole('region', { name: 'Prompt' })).toBeInTheDocument();
    expect(screen.queryByText(/Instructions:.*characters of/)).not.toBeInTheDocument();
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
    expect(within(effort).getAllByRole('option').map(o => o.textContent)).toEqual(['Default (High)', 'Low', 'High', 'Max']);
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
    const forWork = screen.getByRole('checkbox', { name: 'Only when there is work: an open task waits for nobody, or something failed since the last round' });
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

  it('names the role effort fitted to Kimi in Default even with a picked level', async () => {
    const kimi = { ...TEAM_KEY, id: 's-kimi', provider: 'kimi' as const };
    const k3 = { id: 'k3', name: 'K3', efforts: ['low', 'high', 'max'], defaultEffort: 'high' };
    open({ 'GET /api/agents/b1': [200, { ...CARD, model: '', effort: 'max', subscription: kimi, runsOn: [{ subscription: kimi, models: [k3] }] }] });
    expect(await screen.findByRole('option', { name: 'Default (High)' })).toBeInTheDocument();
  });

  it('names the role effort on the Default model of Claude Code', async () => {
    const plan = { ...TEAM_KEY, id: 's-cl', provider: 'claude' as const };
    const opus = { id: 'opus', name: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' };
    open({ 'GET /api/agents/b1': [200, { ...CARD, model: '', subscription: plan, runsOn: [{ subscription: plan, models: [opus] }] }] });
    expect(await screen.findByRole('option', { name: 'Default (Extra high)' })).toBeInTheDocument();
  });

  it('names the role effort in Default for Codex even when it takes more', async () => {
    const codex = { ...TEAM_KEY, id: 's-cx', provider: 'codex' as const };
    const sol = { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'xhigh', 'ultra'], defaultEffort: 'low' };
    open({ 'GET /api/agents/b1': [200, { ...CARD, model: 'gpt-6.1-sol', subscription: codex, runsOn: [{ subscription: codex, models: [sol] }] }] });
    const effort = await screen.findByRole('combobox', { name: 'Effort' });
    expect(within(effort).getAllByRole('option').map(o => o.textContent)).toEqual(['Default (Extra high)', 'Low', 'Extra high', 'Ultra']);
  });

  it("names the Default by its model's own level when the program has one", async () => {
    const plan = { ...TEAM_KEY, id: 's-cl', provider: 'claude' as const };
    const fable = { id: 'fable', name: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' };
    open({ 'GET /api/agents/b1': [200, { ...CARD, role: { ...CARD.role!, effort: undefined }, model: 'fable', subscription: plan, runsOn: [{ subscription: plan, models: [fable] }] }] });
    expect(await screen.findByRole('option', { name: 'Default (High)' })).toBeInTheDocument();
  });

  it('fits a medium role down to low on Kimi', async () => {
    const kimi = { ...TEAM_KEY, id: 's-kimi', provider: 'kimi' as const };
    const model = { id: 'k3', name: 'K3', efforts: ['low', 'high', 'max'] };
    open({ 'GET /api/agents/b1': [200, { ...CARD, role: { ...CARD.role!, effort: 'medium' }, model: 'k3', subscription: kimi, runsOn: [{ subscription: kimi, models: [model] }] }] });
    expect(await screen.findByRole('option', { name: 'Default (Low)' })).toBeInTheDocument();
  });

  it('names the orchestrator default as xhigh without a role file', async () => {
    const codex = { ...TEAM_KEY, id: 's-cx', provider: 'codex' as const };
    const model = { id: 'sol', name: 'Sol', efforts: ['low', 'xhigh', 'ultra'] };
    open({ 'GET /api/agents/b1': [200, { ...CARD, kind: 'orchestrator', role: null, model: 'sol', subscription: codex, runsOn: [{ subscription: codex, models: [model] }] }] });
    expect(await screen.findByRole('option', { name: 'Default (Extra high)' })).toBeInTheDocument();
  });

  it('keeps the Russian Default wording for the fitted role effort', async () => {
    const saved = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('ru');
    onTestFinished(() => saved.mockRestore());
    open();
    expect(await screen.findByRole('option', { name: 'По умолчанию (высокое)' })).toBeInTheDocument();
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

  it.each([
    ['en', 'Limits', 'Unknown, last data from 09:44 PM'],
    ['ru', 'Лимиты', 'Неизвестно, последние данные от 21:44'],
  ])('shows stale Antigravity limits as unknown in the agent card in %s', async (language, heading, words) => {
    localStorage.setItem('hh-lang', language);
    vi.setSystemTime(new Date('2026-11-04T22:00:00.000Z'));
    onTestFinished(() => { localStorage.removeItem('hh-lang'); });
    const antigravity = {
      ...TEAM_KEY,
      kind: 'personal' as const,
      provider: 'antigravity' as const,
      label: 'Antigravity',
      status: 'ready' as const,
      limits: { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-11-05T02:19:23.000Z' }] },
      limitsUpdatedAt: '2026-11-04T21:44:00.000Z',
    };
    open({ 'GET /api/agents/b1': [200, { ...CARD, subscription: antigravity, runsOn: [{ subscription: antigravity, models: [] }] }] });

    expect(await screen.findByRole('group', { name: heading })).toHaveTextContent(words);
    expect(screen.queryByText(language === 'en' ? 'Limit reached' : 'Лимит исчерпан')).not.toBeInTheDocument();
  });

  it("sets apart only the percent sign of a plan's used share in the agent card", async () => {
    vi.setSystemTime(new Date('2026-11-04T22:00:00.000Z'));
    const plan = {
      ...TEAM_KEY,
      kind: 'personal' as const,
      provider: 'claude' as const,
      label: 'Claude',
      status: 'ready' as const,
      limits: { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.4, resetsAt: '2026-11-05T02:00:00.000Z' }] },
      limitsUpdatedAt: '2026-11-04T21:58:00.000Z',
    };
    open({ 'GET /api/agents/b1': [200, { ...CARD, subscription: plan, runsOn: [{ subscription: plan, models: [] }] }] });
    const figure = (await screen.findByRole('group', { name: 'Limits' })).querySelector('.g-f > b');
    expect(figure?.textContent).toBe('40%');
    expect([...figure!.querySelectorAll('.pct')].map(n => n.textContent)).toEqual(['%']);
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

  it('says which machine the employee runs on', async () => {
    open({ 'GET /api/agents/b1': [200, { ...CARD, subscription: CARD.runsOn[1]!.subscription, machine: { id: 'm2', hostname: 'build-tower' } }] });
    expect(await screen.findByText('Works on the machine build-tower')).toBeInTheDocument();
  });

  it('resets to the template after asking', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'POST /api/agents/b1/reset': [200, { ...CARD, changes: [{ field: 'reset', personName: 'Ivan', byOrchestrator: false, at: '2026-10-30T09:00:00.000Z' }, ...CARD.changes] }] });
    await user.click(await screen.findByRole('button', { name: 'Reset to template' }));
    expect(calls.some(c => c.path === '/api/agents/b1/reset')).toBe(false);
    expect(screen.getByText('Reset Bruno to the template? Skill changes and effort choice are lost. Its assignment is kept.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, reset' }));
    await vi.waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/api/agents/b1/reset')).toBe(true));
    expect(await screen.findByText(/Reset to the template: Ivan/)).toBeInTheDocument();
  });

  it('names an employee once when it is called after its role', async () => {
    open({ 'GET /api/agents/b1': [200, { ...CARD, name: 'Backend engineer' }] });
    const card = await screen.findByRole('complementary', { name: 'Card: Backend engineer' });
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent('Backend engineer');
    expect(within(card).queryByText('Backend engineer', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('only shows the card to someone who cannot change it', async () => {
    open({ 'GET /api/agents/b1': [200, { ...CARD, canEdit: false }] });
    expect(await screen.findByRole('combobox', { name: 'Model' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /API design/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reset to template' })).not.toBeInTheDocument();
    expect(screen.getByText("Only people with access to this employee's department or the whole company can change it.")).toBeInTheDocument();
  });

  it("lets a person of the department change the card but not remove the employee", async () => {
    open({ 'GET /api/agents/b1': [200, { ...CARD, canRemove: false }] });
    expect(await screen.findByRole('combobox', { name: 'Model' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /API design/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reset to template' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove from the company' })).not.toBeInTheDocument();
  });

  it("lets the owner of the employee's department remove it", async () => {
    open();
    expect(await screen.findByRole('button', { name: 'Remove from the company' })).toBeInTheDocument();
  });

  it('keeps edits made in both views of the prompt', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'PATCH /api/agents/b1': [200, CARD] });
    await user.click(await screen.findByRole('button', { name: 'Raw' }));
    const billing = CARD.raw.replace('You build the API.', 'You build the billing API.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw' }), { target: { value: billing } });
    await user.click(screen.getByRole('button', { name: 'By skill' }));
    expect(screen.getByRole('textbox', { name: 'Assignment' })).toHaveValue('You build the billing API.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Test first' }), { target: { value: 'Write it first.' } });
    await user.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByRole('textbox', { name: 'Raw' })).toHaveValue(billing.replace('Write the test first.', 'Write it first.'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ base: 'You build the billing API.', skillText: { 'dev-tdd': 'Write it first.' } }));
  });

  it('moves an employee into a sub-unit and back to the pipeline from its card', async () => {
    const user = userEvent.setup();
    const teams = [{ id: 'u1', name: 'Urgent fixes' }];
    const { calls } = open({
      'GET /api/agents/b1': [200, { ...CARD, team: null, teams }],
      'PATCH /api/agents/b1': (body: unknown) => {
        const t = (body as { team?: string | null }).team;
        return [200, { ...CARD, teams, team: t ? teams[0]! : null }];
      },
    });
    const pick = await screen.findByRole('combobox', { name: 'Sub-unit' });
    expect(pick).toHaveValue('');
    await user.selectOptions(pick, 'u1');
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ team: 'u1' }));
    expect(screen.getByRole('combobox', { name: 'Sub-unit' })).toHaveValue('u1');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sub-unit' }), '');
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'PATCH')[1]?.body).toEqual({ team: null }));
    expect(screen.getByRole('combobox', { name: 'Sub-unit' })).toHaveValue('');
  });
});

describe('the Telegram bot on a head\'s card', () => {
  const HEAD: AgentCardView = { ...CARD, kind: 'head', name: 'Sasha', telegram: null };
  const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';

  it('connects a bot by its token from @BotFather, and shows only the bot\'s name after', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'GET /api/agents/b1': [200, HEAD], 'PUT /api/agents/b1/telegram': [200, { telegram: { username: 'acme_sales_bot' } }] });
    const bot = await screen.findByRole('region', { name: 'Telegram bot' });
    expect(within(bot).getByText(/@BotFather/, { selector: 'p' })).toBeInTheDocument();
    const field = within(bot).getByLabelText('Token from @BotFather');
    expect(within(bot).getByRole('button', { name: 'Connect bot' })).toBeDisabled();
    await user.type(field, ` ${TOKEN} `);
    await user.click(within(bot).getByRole('button', { name: 'Connect bot' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/agents/b1/telegram', body: { token: TOKEN } }));
    const link = await within(bot).findByRole('link', { name: '@acme_sales_bot' });
    expect(link).toHaveAttribute('href', 'https://t.me/acme_sales_bot');
    expect(within(bot).queryByLabelText('Token from @BotFather')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('says why Telegram did not take the token, in Russian too', async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    const user = userEvent.setup();
    open({ 'GET /api/agents/b1': [200, HEAD], 'PUT /api/agents/b1/telegram': [400, { error: { code: 'validation', message: 'Telegram does not take this token.', reason: 'telegram_token' } }] });
    const bot = await screen.findByRole('region', { name: 'Бот в Telegram' });
    await user.type(within(bot).getByLabelText('Токен от @BotFather'), TOKEN);
    await user.click(within(bot).getByRole('button', { name: 'Подключить бота' }));
    expect(await within(bot).findByRole('alert')).toHaveTextContent('Telegram не принимает этот токен');
  });

  it('takes the bot off after asking', async () => {
    const user = userEvent.setup();
    const { calls } = open({ 'GET /api/agents/b1': [200, { ...HEAD, telegram: { username: 'acme_sales_bot' } }], 'DELETE /api/agents/b1/telegram': [204, undefined] });
    const bot = await screen.findByRole('region', { name: 'Telegram bot' });
    await user.click(within(bot).getByRole('button', { name: 'Remove bot' }));
    await user.click(within(bot).getByRole('button', { name: 'Yes, remove' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'DELETE')?.path).toBe('/api/agents/b1/telegram'));
    expect(await within(bot).findByLabelText('Token from @BotFather')).toBeInTheDocument();
  });

  it('shows the orchestrator\'s bot to someone who cannot change it, with nothing to change', async () => {
    open({ 'GET /api/agents/b1': [200, { ...HEAD, kind: 'orchestrator', canRemove: false, telegram: { username: 'acme_ceo_bot' } }] });
    const bot = await screen.findByRole('region', { name: 'Telegram bot' });
    expect(within(bot).getByRole('link', { name: '@acme_ceo_bot' })).toBeInTheDocument();
    expect(within(bot).queryByRole('button')).not.toBeInTheDocument();
    expect(within(bot).queryByLabelText('Token from @BotFather')).not.toBeInTheDocument();
  });

  it('has no bot on a worker\'s card', async () => {
    open();
    await screen.findByRole('heading', { name: 'Bruno' });
    expect(screen.queryByRole('region', { name: 'Telegram bot' })).not.toBeInTheDocument();
  });
});

describe('AgentCard assignment', () => {
  it.each([
    ['en', 'Assignment', 'Skills', 'Prompt', 'Backend engineer'],
    ['ru', 'Назначение', 'Навыки', 'Промпт', 'Бэкенд-разработчик'],
  ])('separates the exact saved assignment from skills and immutable role identity in %s', async (language, title, skillsTitle, promptTitle, roleTitle) => {
    localStorage.setItem('hh-lang', language);
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    const assignment = '\nMaintain the billing API.  \n\nKeep customer data safe.\n';
    open({ 'GET /api/agents/b1': [200, assignmentCard(assignment)] });

    const section = await screen.findByRole('region', { name: title });
    expect(within(section).getByRole('textbox', { name: title })).toHaveValue(assignment);
    expect(within(section).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: title })).toHaveLength(1);
    const skills = screen.getByRole('region', { name: skillsTitle });
    const instructions = screen.getByRole('region', { name: promptTitle });
    expect(skills.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(section.compareDocumentPosition(instructions) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(within(instructions).queryByRole('textbox', { name: title })).not.toBeInTheDocument();
    expect(within(instructions).getByRole('textbox', { name: roleTitle })).toHaveValue(ROLE_IDENTITY);
    expect(within(instructions).getByRole('textbox', { name: roleTitle })).toHaveAttribute('readonly');
  });

  it('saves assignment text through the existing base field without editing role identity or skills', async () => {
    const user = userEvent.setup();
    const before = 'Maintain the API.';
    const after = '\nMaintain billing and refunds.  \n\nKeep the audit history.\n';
    const { calls } = open({
      'GET /api/agents/b1': [200, assignmentCard(before)],
      'PATCH /api/agents/b1': [200, assignmentCard(after)],
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Assignment' }), { target: { value: after } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ base: after }));
    expect(screen.getByRole('textbox', { name: 'Assignment' })).toHaveValue(after);
    expect(screen.getByRole('textbox', { name: 'Backend engineer' })).toHaveValue(ROLE_IDENTITY);
    expect(screen.getByRole('textbox', { name: 'Test first' })).toHaveValue('Write the test first.');
  });

  it('round-trips assignment and skill edits through raw text without merging the role into the assignment', async () => {
    const user = userEvent.setup();
    const assignment = 'Maintain the API.';
    const changed = '\nMaintain billing.  \n\nKeep payment retries safe.\n';
    const card = assignmentCard(assignment);
    const { calls } = open({
      'GET /api/agents/b1': [200, card],
      'PATCH /api/agents/b1': [200, assignmentCard(changed, 'Write a failing check first.')],
    });
    await user.click(await screen.findByRole('button', { name: 'Raw' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw' }), { target: { value: card.raw.replace(assignment, changed) } });
    await user.click(screen.getByRole('button', { name: 'By skill' }));

    expect(screen.getByRole('textbox', { name: 'Assignment' })).toHaveValue(changed);
    expect(screen.getByRole('textbox', { name: 'Backend engineer' })).toHaveValue(ROLE_IDENTITY);
    expect(screen.getByRole('textbox', { name: 'Backend engineer' })).toHaveAttribute('readonly');
    fireEvent.change(screen.getByRole('textbox', { name: 'Test first' }), { target: { value: 'Write a failing check first.' } });
    await user.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByRole('textbox', { name: 'Raw' })).toHaveValue(card.raw.replace(assignment, changed).replace('Write the test first.', 'Write a failing check first.'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ base: changed, skillText: { 'dev-tdd': 'Write a failing check first.' } }));
  });

  it.each([
    ['role identity', (raw: string) => raw.replace(ROLE_IDENTITY, 'You are the head of another department.')],
    ['assignment marker', (raw: string) => raw.replace('<!-- /hh:assignment -->', '')],
    ['assignment heading', (raw: string) => raw.replace('## Assignment', '## Different role')],
  ])('refuses a raw edit of the %s and keeps it available to correct', async (_part, edit) => {
    const user = userEvent.setup();
    const card = assignmentCard('Maintain the billing API.');
    const { calls } = open({ 'GET /api/agents/b1': [200, card] });
    await user.click(await screen.findByRole('button', { name: 'Raw' }));
    const changed = edit(card.raw);
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw' }), { target: { value: changed } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Raw' })).toHaveValue(changed);
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('updates the raw assignment body from its separate editor without changing an edited skill', async () => {
    const user = userEvent.setup();
    const card = assignmentCard('Maintain the API.');
    const { calls } = open({
      'GET /api/agents/b1': [200, card],
      'PATCH /api/agents/b1': [200, assignmentCard('Maintain billing.', 'Keep the failing case.')],
    });
    await user.click(await screen.findByRole('button', { name: 'Raw' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw' }), { target: { value: card.raw.replace('Write the test first.', 'Keep the failing case.') } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Assignment' }), { target: { value: 'Maintain billing.' } });

    expect(screen.getByRole('textbox', { name: 'Raw' })).toHaveValue(card.raw.replace('Maintain the API.', 'Maintain billing.').replace('Write the test first.', 'Keep the failing case.'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ base: 'Maintain billing.', skillText: { 'dev-tdd': 'Keep the failing case.' } }));
  });

  it.each(['worker', 'orchestrator'] as const)('can save an empty %s assignment without a role identity part', async kind => {
    const user = userEvent.setup();
    const source = assignmentCard();
    const parts = source.parts.filter(p => p.kind !== 'base');
    const card = { ...source, kind, role: null, parts, raw: parts.map(p => p.text).join('\n\n') };
    const { calls } = open({ 'GET /api/agents/b1': [200, card], 'PATCH /api/agents/b1': [200, card] });
    const assignment = await screen.findByRole('textbox', { name: 'Assignment' });
    expect(assignment).toHaveValue('');
    fireEvent.change(assignment, { target: { value: 'Maintain service readiness.' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ base: 'Maintain service readiness.' }));
  });

  it('keeps the saved assignment on reset and says that it is kept', async () => {
    const user = userEvent.setup();
    const assignment = 'Maintain billing without changing prices.';
    const card = assignmentCard(assignment);
    const { calls } = open({ 'GET /api/agents/b1': [200, card], 'POST /api/agents/b1/reset': [200, card] });
    await user.click(await screen.findByRole('button', { name: 'Reset to template' }));
    expect(screen.getByText(/assignment is kept/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, reset' }));

    await vi.waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/api/agents/b1/reset')).toBe(true));
    expect(screen.getByRole('textbox', { name: 'Assignment' })).toHaveValue(assignment);
    expect(screen.getByRole('textbox', { name: 'Backend engineer' })).toHaveValue(ROLE_IDENTITY);
  });

  it('shows the assignment read-only to a person who cannot change the card', async () => {
    open({ 'GET /api/agents/b1': [200, { ...assignmentCard('Maintain billing.'), canEdit: false }] });
    expect(await screen.findByRole('textbox', { name: 'Assignment' })).toHaveValue('Maintain billing.');
    expect(screen.getByRole('textbox', { name: 'Assignment' })).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

describe('an employee whose machine is offline', () => {
  const DEV_PLACE = { kind: 'department' as const, id: 'd2', name: 'Development' };
  const HOME: SubView = { ...SUBS[0]!, id: 's-home', owner: { id: 'p5', name: 'Clara' }, online: false, place: DEV_PLACE, machines: [{ id: 'm5', hostname: 'workstation-eu', status: 'ready', online: false }] };
  const SPARE: SubView = { ...SUBS[0]!, id: 's-spare', owner: { id: 'p6', name: 'Max' }, online: true, place: DEV_PLACE };
  const ASLEEP: SubView = { ...SPARE, id: 's-asleep', owner: { id: 'p7', name: 'Nora' }, online: false };
  const NOT_SIGNED_IN: SubView = { ...SPARE, id: 's-login', owner: { id: 'p8', name: 'Pavel' }, status: 'needs_login' };
  const WHOLE_COMPANY: SubView = { ...SPARE, id: 's-ceo', owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Acme' } };
  const SINCE = '2026-11-13T18:07:00.000Z';
  const offlineCard = (runsOn: SubView[] = [HOME, SPARE, ASLEEP, NOT_SIGNED_IN, WHOLE_COMPANY], over: Partial<AgentCardView> = {}): AgentCardView => ({
    ...CARD, subscription: HOME, offline: { hostname: 'workstation-eu', since: SINCE }, runsOn: runsOn.map(subscription => ({ subscription, models: [] })), ...over,
  });
  const at = (locale: string) => new Date(SINCE).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });

  it('says which machine is offline and since when, in English and Russian', async () => {
    for (const [lang, line] of [['en', `Machine workstation-eu is offline since ${at('en-GB')}.`], ['ru', `Машина workstation-eu не в сети с ${at('ru-RU')}.`]] as const) {
      localStorage.setItem('hh-lang', lang);
      open({ 'GET /api/agents/b1': [200, offlineCard()] });
      expect(await screen.findByText(line)).toBeInTheDocument();
      cleanup();
      localStorage.removeItem('hh-lang');
    }
    open({ 'GET /api/agents/b1': [200, { ...offlineCard(), offline: { hostname: 'workstation-eu', since: null } }] });
    expect(await screen.findByText('Machine workstation-eu is offline.')).toBeInTheDocument();
  });

  it('moves it in one click to a plan of its own department that is online and signed in, and offers no other plan', async () => {
    const { calls } = open({ 'GET /api/agents/b1': [200, offlineCard()], 'PATCH /api/agents/b1': [200, { ...CARD, subscription: SPARE, offline: null }] });
    const moves = await screen.findAllByRole('button', { name: /^Move to / });
    expect(moves.map(b => b.textContent)).toEqual(['Move to Claude, Max']);
    await userEvent.click(moves[0]!);
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'PATCH').map(c => c.body)).toEqual([{ subscription: 's-spare' }]));
    await vi.waitFor(() => expect(screen.queryByText(/^Machine workstation-eu is offline/)).not.toBeInTheDocument());
  });

  it('says so when no other plan of its department is online, and offers no move to someone who only sees the card', async () => {
    open({ 'GET /api/agents/b1': [200, offlineCard([HOME, ASLEEP, WHOLE_COMPANY])] });
    expect(await screen.findByText('No other plan of this department is online now.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move to / })).not.toBeInTheDocument();
    cleanup();
    open({ 'GET /api/agents/b1': [200, offlineCard(undefined, { canEdit: false })] });
    expect(await screen.findByText(/^Machine workstation-eu is offline since/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move to / })).not.toBeInTheDocument();
    expect(screen.queryByText('No other plan of this department is online now.')).not.toBeInTheDocument();
  });

  it('says nothing of a machine while it is online', async () => {
    open({ 'GET /api/agents/b1': [200, { ...offlineCard(), offline: null }] });
    await screen.findByRole('heading', { name: 'Bruno' });
    expect(screen.queryByText(/is offline/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move to / })).not.toBeInTheDocument();
  });
});

describe('an employee on a fallback plan', () => {
  const HOME: SubView = { ...SUBS[0]!, id: 's-home', provider: 'antigravity', label: 'Antigravity', owner: { id: 'p5', name: 'Clara' } };
  const SPARE: SubView = { ...SUBS[0]!, id: 's-spare', provider: 'codex', label: 'Codex', owner: { id: 'p6', name: 'Max' } };
  const RESET = '2026-11-20T22:51:00.000Z';
  const at = (locale: string) => new Date(RESET).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  const onFallback = (until: string | null): AgentCardView => ({ ...CARD, subscription: SPARE, fallback: { home: HOME, until } });

  it('says which fallback plan it is on, until when its own plan is at its limit, and where it goes back, in English and Russian', async () => {
    for (const [lang, line] of [
      ['en', `On the fallback plan Codex, Max until ${at('en-GB')}, while Antigravity, Clara is at its limit. Then back to Antigravity, Clara.`],
      ['ru', `На запасном тарифе Codex, Max до ${at('ru-RU')}: Antigravity, Clara на лимите. Потом вернется на Antigravity, Clara.`],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      open({ 'GET /api/agents/b1': [200, onFallback(RESET)] });
      expect(await screen.findByText(line)).toBeInTheDocument();
      cleanup();
      localStorage.removeItem('hh-lang');
    }
  });

  it('says it goes back after its turn once its own plan takes turns again', async () => {
    open({ 'GET /api/agents/b1': [200, onFallback(null)] });
    expect(await screen.findByText('On the fallback plan Codex, Max for now. Back to Antigravity, Clara after its turn.')).toBeInTheDocument();
  });

  it('says nothing of a fallback on its own plan', async () => {
    open({ 'GET /api/agents/b1': [200, { ...CARD, fallback: null }] });
    await screen.findByRole('heading', { name: 'Bruno' });
    expect(screen.queryByText(/fallback plan/)).not.toBeInTheDocument();
  });
});
