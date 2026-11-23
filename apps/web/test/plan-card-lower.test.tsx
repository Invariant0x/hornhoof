import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { JobView, PlanFallback, SubView } from '../src/types';
import { ME, mockApi, SUBS } from './api-mock';
import { waitFor, userEvent, lists, rowOf, openAll } from './subscriptions-helpers';

vi.mock('../src/ui/AgentTerminal', () => ({
  AgentTerminal: ({ path }: { path: string }) => <div data-testid="live-terminal" data-path={path} />,
}));

/* The lower part of a working plan's card (#1444, Design's variant B of #1432): its settings and its fallback plans in
   bands across the card, then one foot of the card's actions with one filled button and Remove apart at its end. */

afterEach(() => localStorage.clear());

const SHORT = [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }];
const LONG = [
  { id: 'research', name: 'Long-context model for multilingual research with an extended window for whole reports' },
  { id: 'review', name: 'Model for reviewing technical descriptions before they reach a customer' },
];
const NAMED: PlanFallback[] = [{ subscription: 's-codex', model: null }, { subscription: 's-key', model: null }];
const footButtons = (card: HTMLElement) => [...card.querySelectorAll<HTMLButtonElement>('.plan-card-actions .form-foot button')];
const filled = (card: HTMLElement) => footButtons(card).filter(b => !b.classList.contains('ghost')).map(b => b.textContent);
const active = () => document.activeElement as HTMLElement | null;

describe("a working plan's card, lower part", () => {
  it('puts the settings, the fallback plans and the actions in their own bands, below the blocks of the card', async () => {
    lists();
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    const side = card.querySelector('.blk-side')!;
    expect(side.querySelector('.plan-settings, .plan-fallbacks, .plan-card-actions, button')).toBeNull();
    const bands = [...card.querySelectorAll('.blocks > :is(.plan-settings, .plan-fallbacks, .plan-card-actions)')].map(b => b.className);
    expect(bands).toEqual(['plan-settings', 'plan-fallbacks', 'plan-card-actions']);
    expect(within(card.querySelector<HTMLElement>('.plan-settings')!).getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(within(card.querySelector<HTMLElement>('.plan-fallbacks')!).getByRole('heading', { name: 'Fallback plans' })).toBeInTheDocument();
    /* Tasks may use stands over its field, as a label of it. */
    expect(within(card).getByLabelText('Share of Claude for tasks')).toHaveRole('combobox');
    expect(card.querySelector('.plan-settings label')).toHaveTextContent('Tasks may use');
  });

  it('fills Run a test alone; the other actions are secondary and Remove, apart, ends the foot', async () => {
    lists();
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    const buttons = footButtons(card);
    expect(buttons.map(b => b.textContent)).toEqual(['Run a test', 'Use for the orchestrator', 'Sign in', 'Remove']);
    expect(filled(card)).toEqual(['Run a test']);
    const remove = buttons.at(-1)!;
    expect(remove).toHaveClass('btn', 'ghost', 'danger', 'plan-remove');
    expect(remove).toHaveAccessibleName('Remove Claude');
  });

  it('fills the first action before Remove when Run a test is not shown, and never two', async () => {
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, online: false }, ...SUBS.slice(1)] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    expect(footButtons(card).map(b => b.textContent)).toEqual(['Use for the orchestrator', 'Sign in', 'Remove']);
    expect(filled(card)).toEqual(['Use for the orchestrator']);
  });

  it('keeps Remove secondary when it is the only action', async () => {
    const theirs = { ...SUBS[0]!, online: false, owner: { id: 'p9', name: 'Olga' }, place: { kind: 'department' as const, id: 'd1', name: 'Sales' } };
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [theirs, ...SUBS.slice(1)] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    expect(footButtons(card).map(b => b.textContent)).toEqual(['Remove']);
    expect(filled(card)).toEqual([]);
  });

  it('asks before removing in a dialog without moving the foot, and gives the focus back to Remove on cancel', async () => {
    const calls = lists();
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    const foot = card.querySelector<HTMLElement>('.plan-card-actions')!;
    const remove = within(foot).getByRole('button', { name: 'Remove Claude' });
    remove.focus();
    await user.click(remove);
    expect(foot.querySelector('.form-foot')).not.toBeNull();
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to remove this subscription?' });
    expect(dialog).toHaveAccessibleDescription('Claude will be removed. Its login will be deleted from the machine.');
    expect(dialog).toHaveTextContent('This cannot be undone.');
    /* The question takes the focus Remove had, on its safe answer. */
    expect(active()).toHaveTextContent('Cancel');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(active()).toHaveAccessibleName('Remove Claude'));
    expect(foot.querySelector('.form-foot')).not.toBeNull();
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('keeps the focus on Run a test while the test runs, and does not start a second one', async () => {
    const job: JobView = { id: 'j1', status: 'running', result: null, tail: '', error: null, machine: 'dev-laptop', createdAt: '2026-10-29T10:00:00.000Z', startedAt: '2026-10-29T10:00:00.500Z', finishedAt: null };
    const calls = lists({ 'POST /api/subscriptions/s-claude/test': [201, { job }], 'GET /api/jobs/j1': [200, { job }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const run = within(rowOf('Claude')).getByRole('button', { name: 'Run a test on Claude' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    run.focus();
    await act(async () => { fireEvent.click(run); });
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).not.toBeDisabled();
    expect(active()).toBe(run);
    await act(async () => { fireEvent.click(run); });
    expect(calls.filter(c => c.path === '/api/subscriptions/s-claude/test')).toHaveLength(1);
    /* What it says while it runs stands above the foot. */
    const foot = rowOf('Claude').querySelector('.plan-card-actions')!;
    expect(foot.firstElementChild).toHaveTextContent('Checking. This can take up to two minutes.');
  });
});

describe("a working plan's fallback plans", () => {
  const withNamed = (fallbacks: PlanFallback[], models = SHORT): SubView[] => [{ ...SUBS[0]!, fallbacks }, ...SUBS.slice(1, 3), { ...SUBS[3]!, models }];

  it('numbers each fallback plan and gives its model a visible label', async () => {
    lists({ 'GET /api/subscriptions': [200, { subscriptions: withNamed(NAMED) }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    const entries = [...card.querySelectorAll<HTMLElement>('ol.fallback-list > li.entry')];
    expect(entries.map(e => e.querySelector('.fallback-position')?.textContent)).toEqual(['1', '2']);
    expect(entries.map(e => e.querySelector('.fallback-name')?.textContent)).toEqual(['Codex, Ivan', 'Orchestrator (Anthropic)']);
    expect(entries.map(e => e.querySelector('.fallback-model label')?.textContent)).toEqual(['Model', 'Model']);
    expect(within(entries[1]!).getByRole('combobox', { name: 'Model on Orchestrator (Anthropic)' })).toHaveValue('');
    /* The value the field shows is the chosen model's whole name, which wraps. */
    expect(entries[1]!.querySelector('.model-value')).toHaveTextContent("The role's model");
    expect(card.querySelector('.plan-fallbacks .part-note')).toHaveTextContent('When this plan reaches its limit');
  });

  it('says once that any plan of the company with room serves, when none is named', async () => {
    lists();
    render(<Subscriptions me={ME} />);
    await openAll();
    const band = rowOf('Claude').querySelector<HTMLElement>('.plan-fallbacks')!;
    expect([...band.querySelectorAll('.part-note')].map(p => p.textContent)).toEqual(['Any plan of the company with room for the employee']);
    expect(band.querySelector('ol')).toBeNull();
  });

  it('adds a fallback plan from a list of whole names that opens under Add', async () => {
    const calls = lists({ 'PATCH /api/subscriptions/s-claude': [200, { subscription: { ...SUBS[0]!, fallbacks: [{ subscription: 's-codex', model: null }] } }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    const add = within(card).getByRole('button', { name: 'Add a fallback plan for Claude, Ivan' });
    expect(add).toHaveTextContent('Add a fallback plan');
    expect(add).toHaveAttribute('aria-expanded', 'false');
    await user.click(add);
    expect(add).toHaveAttribute('aria-expanded', 'true');
    const choices = within(card).getByRole('list', { name: 'Add a fallback plan for Claude, Ivan' });
    expect(within(choices).getAllByRole('button').map(b => b.textContent)).toEqual(['Codex, Ivan', 'Kimi, Ivan', 'Orchestrator (Anthropic)']);
    await user.keyboard('{Escape}');
    expect(add).toHaveAttribute('aria-expanded', 'false');
    expect(active()).toBe(add);
    await user.click(add);
    await user.click(within(card).getByRole('button', { name: 'Codex, Ivan' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ path: '/api/subscriptions/s-claude', body: { fallbacks: [{ subscription: 's-codex', model: null }] } }));
    expect(within(card).queryByRole('list', { name: 'Add a fallback plan for Claude, Ivan' })).toBeNull();
  });

  it('chooses a long model from whole names on radio buttons, and returns the focus to the field', async () => {
    const calls = lists({ 'GET /api/subscriptions': [200, { subscriptions: withNamed(NAMED, LONG) }], 'PATCH /api/subscriptions/s-claude': [200, { subscription: { ...SUBS[0]!, fallbacks: NAMED } }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    expect(within(card).queryByRole('combobox', { name: 'Model on Orchestrator (Anthropic)' })).toBeNull();
    const field = within(card).getByRole('button', { name: 'Model on Orchestrator (Anthropic)' });
    expect(field).toHaveAttribute('aria-expanded', 'false');
    expect(field).toHaveTextContent("The role's model");
    await user.click(field);
    const group = within(card).getByRole('group', { name: 'Model on Orchestrator (Anthropic)' });
    expect(within(group).getAllByRole('radio').map(r => r.closest('label')!.textContent)).toEqual(["The role's model", LONG[0]!.name, LONG[1]!.name]);
    expect(within(group).getByRole('radio', { name: "The role's model" })).toBeChecked();
    await user.keyboard('{Escape}');
    expect(field).toHaveAttribute('aria-expanded', 'false');
    expect(active()).toBe(field);
    await user.click(field);
    await user.click(within(card).getByRole('radio', { name: LONG[1]!.name }));
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ fallbacks: [NAMED[0], { subscription: 's-key', model: 'review' }] }));
    expect(field).toHaveAttribute('aria-expanded', 'false');
    expect(active()).toBe(field);
  });

  it('keeps the focus in a moved fallback plan once the move is saved, on the move that is still possible', async () => {
    const calls = lists({ 'GET /api/subscriptions': [200, { subscriptions: withNamed(NAMED) }], 'PATCH /api/subscriptions/s-claude': [200, { subscription: { ...SUBS[0]!, fallbacks: [NAMED[1]!, NAMED[0]!] } }] });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    await user.click(within(card).getByRole('button', { name: 'Move Codex, Ivan lower' }));
    await waitFor(() => expect([...card.querySelectorAll('.fallback-name')].map(n => n.textContent)).toEqual(['Orchestrator (Anthropic)', 'Codex, Ivan']));
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
    /* Last now, it cannot go lower: the focus stays in it, on Higher. */
    await waitFor(() => expect(active()).toHaveAccessibleName('Move Codex, Ivan higher'));
    expect(card.querySelector('.plan-fallbacks [role="status"]')).toHaveTextContent('Codex, Ivan is now number 2 of the fallback plans.');
  });

  it('moves the focus to the next fallback plan once one is removed, and to Add when none is left', async () => {
    const one = [NAMED[0]!];
    let saved: PlanFallback[] = NAMED;
    mockApi({
      'GET /api/nodes/commands': [200, { commands: [] }],
      'GET /api/subscriptions': [200, { subscriptions: withNamed(NAMED) }],
      'PATCH /api/subscriptions/s-claude': (body: unknown) => {
        saved = (body as { fallbacks: PlanFallback[] }).fallbacks;
        return [200, { subscription: { ...SUBS[0]!, fallbacks: saved } }];
      },
    });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Claude');
    await user.click(within(card).getByRole('button', { name: 'Remove Orchestrator (Anthropic) from the fallback plans' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(saved).toEqual(one));
    await waitFor(() => expect(active()).toHaveAccessibleName('Model on Codex, Ivan'));
    await user.click(within(card).getByRole('button', { name: 'Remove Codex, Ivan from the fallback plans' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(saved).toEqual([]));
    await waitFor(() => expect(active()).toHaveAccessibleName('Add a fallback plan for Claude, Ivan'));
  });

  it('names the model field and the move in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    lists({ 'GET /api/subscriptions': [200, { subscriptions: withNamed(NAMED) }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    const card = rowOf('Claude');
    expect([...card.querySelectorAll('.fallback-model label')].map(l => l.textContent)).toEqual(['Модель', 'Модель']);
    expect(within(card).getByRole('button', { name: 'Добавить запасной тариф для Claude, Ivan' })).toHaveAttribute('aria-expanded', 'false');
  });
});
