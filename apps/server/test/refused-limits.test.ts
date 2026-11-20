import { describe, expect, it } from 'vitest';
import type { Limits } from '@hornhoof/protocol';
import { LIMIT_PROBE_MS, refusedLimits } from '../src/modules/conversation/limits.js';

/* What a turn that ended on a refusal for the plan's usage limit leaves of the plan's limits (#1589): the window it names
   is full until the time the program gives, the reset the plan said before, or a quarter of an hour; on a plan that keeps
   its limits by model group, the group of the turn's model and the plan's window fill, and the other groups keep theirs.
   Made-up numbers. */
const NOW = Date.parse('2099-11-19T20:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const REFUSAL = 'Error: 429 usage limit reached for this plan';

const gemini = { name: 'Gemini Models', about: 'Models within this group: Gemini Flash, Gemini Pro', status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: at(3) }, { name: 'seven_day', utilization: 0.06, resetsAt: at(100) }], complete: true };
const others = { name: 'Claude and GPT models', about: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.5, resetsAt: at(4) }, { name: 'seven_day', utilization: 0.9, resetsAt: at(60) }], complete: true };
const grouped = (planWeek: Limits['windows'][number]): Limits => ({ status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.5, resetsAt: at(4) }, planWeek], complete: true, groups: [gemini, others] });

describe('refusedLimits', () => {
  it('leaves the limits alone for a turn that ended on anything but its limit', () => {
    expect(refusedLimits('all done', grouped(others.windows[1]!), NOW)).toBeNull();
  });

  it('fills the window the refusal names until the time the program gives, else the reset said before, else a quarter of an hour', () => {
    expect(refusedLimits(`${REFUSAL}. Try again in 2h 30m.`, null, NOW)).toEqual({ status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: at(2.5) }] });
    const plan: Limits = { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.4, resetsAt: at(1) }, { name: 'seven_day', utilization: 0.2, resetsAt: at(50) }] };
    expect(refusedLimits(`${REFUSAL}: weekly`, plan, NOW)).toEqual({ status: 'rejected', windows: [plan.windows[0], { name: 'seven_day', utilization: 1, resetsAt: at(50) }] });
    expect(refusedLimits('no words of a limit', { ...plan, windows: [{ name: 'five_hour', utilization: 0.4, resetsAt: at(-1) }] }, NOW, true)).toEqual({ status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: new Date(NOW + LIMIT_PROBE_MS).toISOString() }] });
  });

  it("fills the group of the turn's model and the plan's window, and leaves the other groups as they are", () => {
    const planWeek = { name: 'seven_day', utilization: 0.9, resetsAt: at(60) };
    const after = refusedLimits(`${REFUSAL}: weekly. Try again in 70h.`, grouped(planWeek), NOW, false, 'claude-sonnet-5-5')!;
    expect(after.groups).toEqual([gemini, { ...others, status: 'rejected', windows: [others.windows[0], { name: 'seven_day', utilization: 1, resetsAt: at(70) }] }]);
    expect(after.status).toBe('rejected');
    expect(after.windows).toEqual([{ name: 'five_hour', utilization: 0.5, resetsAt: at(4) }, { name: 'seven_day', utilization: 1, resetsAt: at(70) }]);
  });

  it("keeps the plan's window that another group holds full until later, and fills it where it is full only until sooner", () => {
    const later = { name: 'seven_day', utilization: 1, resetsAt: at(90) };
    expect(refusedLimits(`${REFUSAL}: weekly. Try again in 70h.`, grouped(later), NOW, false, 'gemini-4-argon')!.windows).toEqual([{ name: 'five_hour', utilization: 0.5, resetsAt: at(4) }, later]);
    const sooner = { name: 'seven_day', utilization: 1, resetsAt: at(30) };
    expect(refusedLimits(`${REFUSAL}: weekly. Try again in 70h.`, grouped(sooner), NOW, false, 'gemini-4-argon')!.windows).toEqual([{ name: 'five_hour', utilization: 0.5, resetsAt: at(4) }, { name: 'seven_day', utilization: 1, resetsAt: at(70) }]);
    const notFull = { name: 'seven_day', utilization: 0.5, resetsAt: at(90) };
    expect(refusedLimits(`${REFUSAL}: weekly. Try again in 70h.`, grouped(notFull), NOW, false, 'gemini-4-argon')!.windows).toEqual([{ name: 'five_hour', utilization: 0.5, resetsAt: at(4) }, { name: 'seven_day', utilization: 1, resetsAt: at(70) }]);
    const unknown = { name: 'seven_day', utilization: null, resetsAt: at(90) };
    expect(refusedLimits(`${REFUSAL}: weekly. Try again in 70h.`, grouped(unknown), NOW, false, 'gemini-4-argon')!.windows).toEqual([{ name: 'five_hour', utilization: 0.5, resetsAt: at(4) }, { name: 'seven_day', utilization: 1, resetsAt: at(70) }]);
    const noTime = { name: 'seven_day', utilization: 1, resetsAt: null };
    expect(refusedLimits(`${REFUSAL}: weekly. Try again in 70h.`, grouped(noTime), NOW, false, 'gemini-4-argon')!.windows).toEqual([{ name: 'five_hour', utilization: 0.5, resetsAt: at(4) }, { name: 'seven_day', utilization: 1, resetsAt: at(70) }]);
  });

  it('fills only the plan for a model of no known group, as before', () => {
    const planWeek = { name: 'seven_day', utilization: 0.9, resetsAt: at(60) };
    const after = refusedLimits(`${REFUSAL}: weekly. Try again in 70h.`, grouped(planWeek), NOW, false, 'kimi-k3')!;
    expect(after.groups).toEqual([gemini, others]);
    expect(after.windows).toEqual([{ name: 'five_hour', utilization: 0.5, resetsAt: at(4) }, { name: 'seven_day', utilization: 1, resetsAt: at(70) }]);
  });
});
