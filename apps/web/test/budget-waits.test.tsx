import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { BudgetView, Me, SubView } from '../src/types';
import { ME, mockApi, SUBS } from './api-mock';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const at = (milliseconds: number) => new Date(NOW + milliseconds).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function fixedTime() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
}

function makeBudget({ decision: decisionOverrides = {}, ...view }: Record<string, unknown> & { decision?: Record<string, unknown> } = {}): BudgetView {
  return {
    decision: {
      allowed: false,
      reason: 'usage_unknown',
      quality: 'missing',
      blockingWindows: [],
      resetHintAt: null,
      sampledAt: null,
      receivedAt: new Date(NOW).toISOString(),
      ...decisionOverrides,
    },
    control: 'unavailable',
    checkedAt: new Date(NOW).toISOString(),
    freshUntil: null,
    ...view,
  };
}

function withBudget(sub: SubView, budget: BudgetView, budgetPercent = 90): SubView {
  return { ...sub, budgetPercent, budget };
}

async function renderSubs(subscriptions: SubView[], me: Me = ME) {
  const calls = mockApi({ 'GET /api/subscriptions': [200, { subscriptions }], 'GET /api/machines': [200, { machines: [] }] });
  render(
    <LanguageProvider>
      <Subscriptions me={me} />
    </LanguageProvider>,
  );
  await screen.findByRole('row', { name: /^Claude\b/ });
  return calls;
}

const row = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name}\\b`) });

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('subscription budget integration and waits', () => {
  it('integrates an independent slider into plan and API key subscriptions', async () => {
    fixedTime();
    const claude = withBudget(SUBS[0]!, makeBudget(), 90);
    const key = withBudget(SUBS[3]!, makeBudget(), 100);
    await renderSubs([claude, key]);
    const patchCalls = mockApi({ 'PATCH /api/subscriptions/s-claude/budget': [200, { subscription: { ...claude, budgetPercent: 0 } }] });
    const user = userEvent.setup();
    const sliders = screen.getAllByRole('slider', { name: 'Subscription budget' });
    expect(sliders).toHaveLength(2);
    expect(sliders[0]).toHaveValue('90');
    expect(sliders[0]).toBeEnabled();
    expect(sliders[1]).toHaveValue('100');
    expect(within(row('Anthropic key ending 9f3a')).getByText('Pay as you go, no plan limits')).toBeInTheDocument();
    fireEvent.input(sliders[0]!, { target: { value: '0' } });
    expect(await screen.findByDisplayValue('0')).toBe(sliders[0]);
    await user.click(screen.getAllByRole('button', { name: 'Save budget' })[0]!);
    expect(await within(row('Claude')).findByText('Server value: 0%')).toBeInTheDocument();
    expect(sliders[1]).toHaveValue('100');
    expect(within(row('Anthropic key ending 9f3a')).getByText('Server value: 100%')).toBeInTheDocument();
    expect(patchCalls.filter(call => call.method === 'PATCH')).toEqual([{ method: 'PATCH', path: '/api/subscriptions/s-claude/budget', body: { budgetPercent: 0 } }]);
  });

  it('shows unknown usage and unavailable control without treating unknown as zero', async () => {
    fixedTime();
    await renderSubs([withBudget(SUBS[0]!, makeBudget())]);
    const claude = row('Claude');
    expect(claude).toHaveTextContent('Usage data is missing or stale. New starts wait.');
    expect(claude).toHaveTextContent('Budget control is unavailable');
    expect(claude).toHaveTextContent('Usage sample time unknown');
    expect(claude).toHaveTextContent('Reset time unknown');
    expect(claude).not.toHaveTextContent('Usage: 0%');
    expect(claude).not.toHaveTextContent('Server policy allows new starts');
  });

  it('distinguishes partial from stale and computes age from sampledAt, not receivedAt', async () => {
    fixedTime();
    const partial = makeBudget({ decision: { quality: 'partial', sampledAt: at(-2 * MINUTE), receivedAt: at(0) }, control: 'server_only' });
    const stale = makeBudget({ decision: { quality: 'stale', sampledAt: at(-11 * MINUTE), receivedAt: at(0) }, control: 'server_only' });
    await renderSubs([withBudget(SUBS[0]!, partial), withBudget(SUBS[1]!, stale)]);
    expect(row('Claude')).toHaveTextContent('Some usage data is missing.');
    expect(row('Claude')).toHaveTextContent('Sampled 2 minutes ago');
    expect(row('Codex')).toHaveTextContent('Usage data is stale.');
    expect(row('Codex')).toHaveTextContent('Sampled 11 minutes ago');
    expect(row('Codex')).not.toHaveTextContent('Sampled less than a minute ago');
  });

  it('shows a provider limit while ready and preserves every blocking window reset', async () => {
    fixedTime();
    const budget = makeBudget({
      decision: {
        reason: 'provider_limit',
        quality: 'complete',
        sampledAt: at(-30_000),
        resetHintAt: at(79 * HOUR),
        blockingWindows: [
          { name: 'five_hour', utilization: 1, resetsAt: at(79 * HOUR), sampledAt: at(-30_000), receivedAt: at(0), source: 'usage_fetch' },
          { name: 'seven_day', utilization: 0.95, resetsAt: at(48 * HOUR), sampledAt: at(-30_000), receivedAt: at(0), source: 'usage_fetch' },
          { name: 'month', utilization: 0.91, resetsAt: at(7 * HOUR + 5 * MINUTE), sampledAt: at(-30_000), receivedAt: at(0), source: 'usage_fetch' },
        ],
      },
      control: 'complete',
    });
    await renderSubs([withBudget(SUBS[0]!, budget, 100)]);
    const claude = row('Claude');
    expect(claude).toHaveTextContent('Ready');
    expect(claude).toHaveTextContent('Provider limit reached. New starts wait.');
    expect(claude).toHaveTextContent('5 hours');
    expect(claude).toHaveTextContent('resets in 3 days 7 hours');
    expect(claude).toHaveTextContent('7 days');
    expect(claude).toHaveTextContent('resets in 2 days');
    expect(claude).toHaveTextContent('Month');
    expect(claude).toHaveTextContent('resets in 7 hours 5 minutes');
    expect(claude).not.toHaveTextContent('Server policy allows new starts');
  });

  it('does not present unavailable control as full protection when server policy allows', async () => {
    fixedTime();
    const budget = makeBudget({ decision: { allowed: true, reason: null, quality: 'missing', sampledAt: null }, control: 'unavailable' });
    await renderSubs([withBudget(SUBS[0]!, budget, 100)]);
    const claude = row('Claude');
    expect(claude).toHaveTextContent('Server policy allows new starts.');
    expect(claude).toHaveTextContent('Budget control is unavailable');
    expect(claude).not.toHaveTextContent('Control coverage complete');
  });

  it('shows an unknown reset after a past reset without claiming recovery', async () => {
    fixedTime();
    const budget = makeBudget({
      decision: {
        reason: 'budget_reached',
        quality: 'complete',
        resetHintAt: at(-1000),
        blockingWindows: [{ name: 'five_hour', utilization: 1, resetsAt: at(-1000), sampledAt: at(-60_000), receivedAt: at(0), source: 'usage_fetch' }],
      },
      control: 'complete',
    });
    await renderSubs([withBudget(SUBS[0]!, budget)]);
    const claude = row('Claude');
    expect(claude).toHaveTextContent('Budget reached. New starts wait.');
    expect(claude).toHaveTextContent('Reset time unknown');
    expect(claude).not.toHaveTextContent(/restored/i);
    expect(claude).not.toHaveTextContent('Server policy allows new starts');
  });

  it('keeps the control read-only for a viewer without subscription management rights', async () => {
    fixedTime();
    const viewer: Me = { ...ME, person: { ...ME.person, id: 'other', scopeKind: 'listed', isOwner: false } };
    const calls = await renderSubs([withBudget(SUBS[0]!, makeBudget())], viewer);
    expect(screen.getByRole('slider', { name: 'Subscription budget' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save budget' })).not.toBeInTheDocument();
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('rolls back an integrated slider after a save failure', async () => {
    fixedTime();
    const claude = withBudget(SUBS[0]!, makeBudget(), 90);
    await renderSubs([claude]);
    const calls = mockApi({ 'PATCH /api/subscriptions/s-claude/budget': [403, { error: { code: 'forbidden', reason: 'not_owner', message: 'Only the owner can do this.' } }] });
    const user = userEvent.setup();
    const slider = screen.getByRole('slider', { name: 'Subscription budget' });
    fireEvent.change(slider, { target: { value: '0' } });
    await user.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(await within(row('Claude')).findByRole('alert')).toHaveTextContent('Only the owner can do this.');
    expect(slider).toHaveValue('90');
    expect(within(row('Claude')).getByText('Server value: 90%')).toBeInTheDocument();
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('shows Russian decision, control and shared reset text', async () => {
    localStorage.setItem('hh-lang', 'ru');
    fixedTime();
    const budget = makeBudget({
      decision: {
        reason: 'provider_limit',
        quality: 'complete',
        resetHintAt: at(79 * HOUR),
        blockingWindows: [{ name: 'five_hour', utilization: 1, resetsAt: at(79 * HOUR), sampledAt: at(-30_000), receivedAt: at(0), source: 'usage_fetch' }],
      },
    });
    await renderSubs([withBudget(SUBS[0]!, budget, 100)]);
    const claude = row('Claude');
    expect(claude).toHaveTextContent('Лимит провайдера. Новые запуски ждут.');
    expect(claude).toHaveTextContent('Контроль бюджета недоступен');
    expect(claude).toHaveTextContent('До сброса 3 дня 7 часов');
  });
});
