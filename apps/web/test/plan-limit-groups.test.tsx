import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { Limits, RunningAgent, SubView } from '../src/types';
import { LimitCell, LimitMeters } from '../src/ui/PlanLimits';
import { limitState, stateOf, windowUsage } from '../src/ui/subscription';
import { ME, RUNNING_AGENTS, SUBS } from './api-mock';
import { lists, openAll, openCards, rowOf, waitFor } from './subscriptions-helpers';

/* A plan whose provider keeps its limits by model group, as Antigravity's /usage tells them (#1589): its Claude and GPT
   models used their week while its Gemini models have most of theirs. Made-up numbers. */
const GEMINI = {
  name: 'Gemini Models',
  about: 'Models within this group: Gemini Flash, Gemini Pro',
  status: 'allowed' as const,
  windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: '2099-11-19T22:00:00.000Z' }, { name: 'seven_day', utilization: 0.06, resetsAt: '2099-11-24T10:00:00.000Z' }],
  complete: true,
};
const OTHERS = {
  name: 'Claude and GPT models',
  about: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
  status: 'rejected' as const,
  windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2099-11-19T23:00:00.000Z' }, { name: 'seven_day', utilization: 1, resetsAt: '2099-11-22T08:00:00.000Z' }],
  complete: true,
};
const GROUPED: Limits = { status: 'rejected', windows: OTHERS.windows, complete: true, groups: [GEMINI, OTHERS] };
const AGY: SubView = { ...SUBS[0]!, id: 's-agy', provider: 'antigravity', label: 'Antigravity', agents: [], limits: GROUPED };
const serve = (sub: SubView) => lists({ 'GET /api/subscriptions': [200, { subscriptions: [sub] }] });
const agentOn = (id: string, model: string): RunningAgent => ({ ...RUNNING_AGENTS[0]!, id, name: id, model });

describe('a plan that keeps its limits by model group', () => {
  it("shows each group on its card with its usage and reset, and bars for the plan's main group", async () => {
    serve(AGY);
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Antigravity');
    expect(within(card).queryByRole('heading', { name: 'Limits' })).toBeNull();
    for (const [group, shares] of [['Gemini Models', ['10%', '6%']], ['Claude and GPT models', ['100%', '100%']]] as const) {
      const part = within(card).getByRole('heading', { name: `Limits: ${group}` }).closest('section')!;
      const gauges = [...part.querySelectorAll('.gauge')];
      expect(gauges.map(g => g.querySelector('.g-l')!.textContent)).toEqual(['5\u00a0hours', '7\u00a0days']);
      expect(gauges.map(g => g.querySelector('.g-f b')!.textContent)).toEqual(shares);
      for (const g of gauges) expect(g.querySelector('.g-s')!.textContent).toMatch(/^resets in /);
      expect(part.querySelectorAll('.bar')).toHaveLength(group === 'Gemini Models' ? 2 : 0);
    }
  });

  it('is ready while one group has room, and at its limit only while every group is, until the first starts over', () => {
    const now = Date.parse('2099-11-19T20:00:00.000Z');
    expect(stateOf(AGY, now)).toBe('ready');
    const geminiOut = { ...GEMINI, status: 'rejected' as const, windows: [{ name: 'seven_day', utilization: 1, resetsAt: '2099-11-23T00:00:00.000Z' }] };
    const allOut: Limits = { ...GROUPED, groups: [geminiOut, OTHERS] };
    expect(stateOf({ ...AGY, limits: allOut }, now)).toBe('limit');
    expect(limitState(allOut, now)).toEqual({ reached: true, resetsAt: '2099-11-22T08:00:00.000Z' });
    /* A plan with one limit for all reads as before. */
    expect(limitState({ status: 'rejected', windows: OTHERS.windows }, now)).toEqual({ reached: true, resetsAt: '2099-11-22T08:00:00.000Z' });
  });

  it("shows one row and one bar for the provider's own model group in the list cell, even when another group is fuller", async () => {
    serve(AGY);
    render(<Subscriptions me={ME} />);
    const row = await waitFor(() => rowOf('Antigravity'));
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    const five = [...row.querySelectorAll('td')].find(td => td.textContent?.includes('Gemini Models: 10%'));
    expect(five?.textContent).toMatch(/^Gemini Models: 10%, resets in /);
    expect(five?.textContent).not.toContain('Claude and GPT models');
    expect(five?.querySelectorAll('li')).toHaveLength(0);
    expect(five?.querySelectorAll('.bar')).toHaveLength(1);
    expect(five?.querySelector<HTMLElement>('.bar i')?.style.width).toBe('10%');
    expect(five?.querySelector('.bar.max')).toBeNull();
    const week = [...row.querySelectorAll('td')].find(td => td.textContent?.includes('Gemini Models: 6%'));
    expect(week?.textContent).toMatch(/^Gemini Models: 6%, resets in /);
    expect(week?.textContent).not.toContain('Claude and GPT models');
    expect(week?.querySelectorAll('.bar')).toHaveLength(1);
    expect(week?.querySelector<HTMLElement>('.bar i')?.style.width).toBe('6%');
  });

  it("prefers the provider's own model group regardless of group order or employee models", () => {
    const plan: SubView = {
      ...AGY,
      agents: [agentOn('a1', 'claude-sonnet-5-5'), agentOn('a2', 'gpt-oss-120b')],
      limits: { ...GROUPED, groups: [OTHERS, GEMINI] },
      limitsUpdatedAt: '2099-11-19T20:00:00.000Z',
    };
    const { container } = render(<LimitCell sub={plan} name="five_hour" now={Date.parse('2099-11-19T20:01:00.000Z')} />);
    expect(container.textContent).toMatch(/^Gemini Models: 10%, resets in /);
    expect(container.textContent).not.toContain('Claude and GPT models');
    expect(container.querySelectorAll('.bar')).toHaveLength(1);
    expect(container.querySelector<HTMLElement>('.bar i')?.style.width).toBe('10%');
  });

  it('falls back to the group most employees on the plan use when no group matches the provider, else the first group', () => {
    const alpha = { name: 'Tier Alpha', about: 'Models: alpha-1', status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2099-11-19T23:00:00.000Z' }], complete: true };
    const beta = { name: 'Tier Beta', about: 'Models: beta-fast, beta-pro', status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.2, resetsAt: '2099-11-19T22:00:00.000Z' }], complete: true };
    const now = Date.parse('2099-11-19T20:01:00.000Z');
    const base: SubView = { ...AGY, limits: { status: 'rejected', windows: alpha.windows, complete: true, groups: [alpha, beta] }, limitsUpdatedAt: '2099-11-19T20:00:00.000Z' };

    const { container, rerender } = render(<LimitCell sub={{ ...base, agents: [agentOn('a1', 'alpha-1'), agentOn('a2', 'beta-pro'), agentOn('a3', 'beta-fast'), agentOn('a4', '')] }} name="five_hour" now={now} />);
    expect(container.textContent).toMatch(/^Tier Beta: 20%, resets in /);
    expect(container.textContent).not.toContain('Tier Alpha');
    expect(container.querySelector<HTMLElement>('.bar i')?.style.width).toBe('20%');

    /* Equal employee counts or no employees on the plan keep the first group reported by the provider. */
    rerender(<LimitCell sub={{ ...base, agents: [agentOn('a1', 'alpha-1'), agentOn('a2', 'beta-pro')] }} name="five_hour" now={now} />);
    expect(container.textContent).toMatch(/^Tier Alpha: 100%, resets in /);

    rerender(<LimitCell sub={{ ...base, agents: undefined }} name="five_hour" now={now} />);
    expect(container.textContent).toMatch(/^Tier Alpha: 100%, resets in /);
  });

  it('stays on the main group when its window reset passes, without switching to another group', () => {
    const gemini = { ...GEMINI, windows: [{ name: 'seven_day', utilization: 0.1, resetsAt: '2099-11-22T08:00:00.000Z' }] };
    const others = { ...OTHERS, windows: [{ name: 'seven_day', utilization: 1, resetsAt: '2099-11-22T09:00:00.000Z' }] };
    const plan: SubView = { ...AGY, limits: { ...GROUPED, groups: [gemini, others] }, limitsUpdatedAt: '2099-11-22T07:55:00.000Z' };
    const { container, rerender } = render(<LimitCell sub={plan} name="seven_day" now={Date.parse('2099-11-22T07:59:00.000Z')} />);
    expect(container.textContent).toMatch(/^Gemini Models: 10%, /);
    expect(container.querySelectorAll('.bar')).toHaveLength(1);
    rerender(<LimitCell sub={plan} name="seven_day" now={Date.parse('2099-11-22T08:01:00.000Z')} />);
    expect(container.textContent).toMatch(/^Gemini Models: Unknown/);
    expect(container.textContent).not.toContain('Claude and GPT models');
    expect(container.querySelector('.cell-na')).toBeInTheDocument();
    expect(container.querySelectorAll('.bar')).toHaveLength(0);
  });

  it('says on the card and in the list which window a group does not have, and which one is not known yet', async () => {
    /* Gemini names every window it has and has no five hours; Claude and GPT told only their week. */
    const weekOnly = { ...GEMINI, windows: [GEMINI.windows[1]!] };
    const untold = { ...OTHERS, complete: false, windows: [OTHERS.windows[1]!] };
    serve({ ...AGY, limits: { ...GROUPED, groups: [weekOnly, untold] } });
    render(<Subscriptions me={ME} />);
    const row = await waitFor(() => rowOf('Antigravity'));
    const five = [...row.querySelectorAll('td')].find(td => td.textContent?.includes('Gemini Models: Not on this plan'));
    expect(five?.textContent).toBe('Gemini Models: Not on this plan');
    expect(five?.querySelector('.cell-na')).toBeInTheDocument();
    expect(five?.querySelectorAll('.bar')).toHaveLength(0);
    openCards();
    const card = rowOf('Antigravity');
    const fiveHours = (group: string) => within(card).getByRole('heading', { name: `Limits: ${group}` }).closest('section')!.querySelector('.gauge .g-f b')!.textContent;
    expect(fiveHours('Gemini Models')).toBe('Not on this plan');
    expect(fiveHours('Claude and GPT models')).not.toBe('Not on this plan');
  });

  it('sorts grouped plans by their main model group usage to match the list cell', () => {
    const now = Date.parse('2099-11-19T20:00:00.000Z');
    expect(windowUsage({ ...AGY, limitsUpdatedAt: '2099-11-19T19:59:00.000Z' }, 'five_hour', now)).toBe(0.1);
    expect(windowUsage({ ...AGY, limitsUpdatedAt: '2099-11-19T19:59:00.000Z' }, 'seven_day', now)).toBe(0.06);
    expect(windowUsage({ ...SUBS[0]!, kind: 'api_key' }, 'five_hour', now)).toBeNull();
    expect(windowUsage({ ...SUBS[0]!, limits: { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.42, resetsAt: '2099-11-19T22:00:00.000Z' }] }, limitsUpdatedAt: '2099-11-19T19:59:00.000Z' }, 'five_hour', now)).toBe(0.42);
  });

  it("shows an employee the group of its own model with bars, and every group for a model of none known", () => {
    const { unmount } = render(<LimitMeters sub={AGY} now={Date.now()} model="gemini-4-argon" />);
    expect(screen.getByText('Limits: Gemini Models')).toBeInTheDocument();
    expect(screen.queryByText('Limits: Claude and GPT models')).toBeNull();
    expect(document.querySelectorAll('.bar')).toHaveLength(2);
    unmount();
    const second = render(<LimitMeters sub={AGY} now={Date.now()} model="claude-sonnet-5-5" />);
    expect(screen.getByText('Limits: Claude and GPT models')).toBeInTheDocument();
    expect(screen.queryByText('Limits: Gemini Models')).toBeNull();
    expect(document.querySelectorAll('.bar')).toHaveLength(2);
    second.unmount();
    render(<LimitMeters sub={AGY} now={Date.now()} model="kimi-k3" />);
    expect(screen.getAllByText(/^Limits: /).map(p => p.textContent)).toEqual(['Limits: Gemini Models', 'Limits: Claude and GPT models']);
  });

  it('shows a plan with one limit for all as before', () => {
    render(<LimitMeters sub={SUBS[0]!} now={Date.now()} model="claude-sonnet-5-5" />);
    expect(screen.queryByText(/^Limits: /)).toBeNull();
    expect(document.querySelectorAll('.gauges')).toHaveLength(1);
  });
});
