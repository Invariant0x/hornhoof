import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { Limits, SubView } from '../src/types';
import { LimitMeters } from '../src/ui/PlanLimits';
import { limitState, stateOf } from '../src/ui/subscription';
import { ME, SUBS } from './api-mock';
import { lists, openAll, openCards, rowOf, waitFor } from './subscriptions-helpers';

/* A plan whose provider keeps its limits by model group, as Antigravity's /usage tells them (#1589): its Claude and GPT
   models used their week while its Gemini models have most of theirs. Made-up numbers. */
const GEMINI = {
  name: 'Gemini Models',
  about: 'Models within this group: Gemini Flash, Gemini Pro',
  status: 'allowed' as const,
  windows: [{ name: 'five_hour', utilization: 0, resetsAt: '2099-11-19T22:00:00.000Z' }, { name: 'seven_day', utilization: 0.06, resetsAt: '2099-11-24T10:00:00.000Z' }],
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

describe('a plan that keeps its limits by model group', () => {
  it('shows each group on its card under its own name, with what it used and when it resets', async () => {
    serve(AGY);
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = rowOf('Antigravity');
    expect(within(card).queryByRole('heading', { name: 'Limits' })).toBeNull();
    for (const [group, shares] of [['Gemini Models', ['0%', '6%']], ['Claude and GPT models', ['100%', '100%']]] as const) {
      const part = within(card).getByRole('heading', { name: `Limits: ${group}` }).closest('section')!;
      const gauges = [...part.querySelectorAll('.gauge')];
      expect(gauges.map(g => g.querySelector('.g-l')!.textContent)).toEqual(['5 hours', '7 days']);
      expect(gauges.map(g => g.querySelector('.g-f b')!.textContent)).toEqual(shares);
      for (const g of gauges) expect(g.querySelector('.g-s')!.textContent).toMatch(/^resets in /);
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

  it("shows each group in the list's limit cells and calls the plan ready", async () => {
    serve(AGY);
    render(<Subscriptions me={ME} />);
    const row = await waitFor(() => rowOf('Antigravity'));
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    const week = [...row.querySelectorAll('td')].find(td => td.textContent?.includes('Gemini Models: 6%'));
    expect(week?.textContent).toMatch(/Gemini Models: 6%, resets in .*Claude and GPT models: 100%, resets in /);
  });

  it('says on the card and in the list which window a group does not have, and which one is not known yet', async () => {
    /* Gemini names every window it has and has no five hours; Claude and GPT told only their week. */
    const weekOnly = { ...GEMINI, windows: [GEMINI.windows[1]!] };
    const untold = { ...OTHERS, complete: false, windows: [OTHERS.windows[1]!] };
    serve({ ...AGY, limits: { ...GROUPED, groups: [weekOnly, untold] } });
    render(<Subscriptions me={ME} />);
    const row = await waitFor(() => rowOf('Antigravity'));
    const five = [...row.querySelectorAll('td')].find(td => td.textContent?.includes('Gemini Models: Not on this plan'));
    expect(five?.textContent).toMatch(/Claude and GPT models: (?!Not on this plan)\S/);
    expect(five?.querySelectorAll('.bar')).toHaveLength(0);
    openCards();
    const card = rowOf('Antigravity');
    const fiveHours = (group: string) => within(card).getByRole('heading', { name: `Limits: ${group}` }).closest('section')!.querySelector('.gauge .g-f b')!.textContent;
    expect(fiveHours('Gemini Models')).toBe('Not on this plan');
    expect(fiveHours('Claude and GPT models')).not.toBe('Not on this plan');
  });

  it("shows an employee the group of its own model, and every group for a model of none known", () => {
    const { unmount } = render(<LimitMeters sub={AGY} now={Date.now()} model="gemini-4-argon" />);
    expect(screen.getByText('Limits: Gemini Models')).toBeInTheDocument();
    expect(screen.queryByText('Limits: Claude and GPT models')).toBeNull();
    unmount();
    render(<LimitMeters sub={AGY} now={Date.now()} model="kimi-k3" />);
    expect(screen.getAllByText(/^Limits: /).map(p => p.textContent)).toEqual(['Limits: Gemini Models', 'Limits: Claude and GPT models']);
  });

  it('shows a plan with one limit for all as before', () => {
    render(<LimitMeters sub={SUBS[0]!} now={Date.now()} model="claude-sonnet-5-5" />);
    expect(screen.queryByText(/^Limits: /)).toBeNull();
    expect(document.querySelectorAll('.gauges')).toHaveLength(1);
  });
});
