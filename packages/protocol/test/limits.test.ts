import { describe, expect, it } from 'vitest';
import { currentLimits, limitsForModel, modelGroup, parseNodeMessage, type Limits } from '../src/index.js';

const NOW = Date.parse('2026-11-04T22:00:00.000Z');
const FRESH = '2026-11-04T21:55:00.000Z';
const FULL = { name: 'five_hour', utilization: 1, resetsAt: '2026-11-03T00:53:03.947Z' };
const OPEN = { name: 'seven_day', utilization: 0.4, resetsAt: '2026-11-10T00:41:44.000Z' };

const rejected = (windows: Limits['windows']): Limits => ({ status: 'rejected', windows, complete: true });

describe('currentLimits', () => {
  it('expires a window whose reset passed and clears a rejection caused by it', () => {
    expect(currentLimits(rejected([FULL, OPEN]), FRESH, NOW)).toEqual({
      status: 'allowed',
      windows: [OPEN],
      complete: false,
    });
  });

  it('keeps a rejection while another full window has not reset', () => {
    const unknownReset = { name: 'seven_day', utilization: null, resetsAt: null };
    expect(currentLimits(rejected([FULL, unknownReset]), FRESH, NOW)).toEqual({ ...rejected([unknownReset]), complete: false });
  });

  it('keeps a window whose reset time cannot be parsed', () => {
    const unknownReset = { name: 'month', utilization: 0.06, resetsAt: 'not-a-time' };
    expect(currentLimits(rejected([unknownReset]), FRESH, NOW)).toEqual(rejected([unknownReset]));
  });

  it('keeps a rejection with no blocking window because it gives no reset that could clear it', () => {
    expect(currentLimits(rejected([OPEN]), FRESH, NOW)).toEqual(rejected([OPEN]));
  });

  it('withholds a stale snapshot instead of treating its old rejection as current', () => {
    const stale = '2026-11-04T21:44:59.999Z';
    expect(currentLimits(rejected([OPEN]), stale, NOW)).toEqual({ status: 'allowed', windows: [], complete: false });
    expect(currentLimits(rejected([OPEN]), null, NOW)).toEqual({ status: 'allowed', windows: [], complete: false });
  });

  it('uses a snapshot at the freshness boundary and accepts a Date timestamp', () => {
    const atBoundary = new Date('2026-11-04T21:45:00.000Z');
    expect(currentLimits(rejected([OPEN]), atBoundary, NOW)).toEqual(rejected([OPEN]));
  });

  it('keeps the absence of any snapshot distinct from a stale one', () => {
    expect(currentLimits(null, null, NOW)).toBeNull();
  });
});

/* A plan whose provider keeps separate limits by model group, as Antigravity's /usage tells them: the plan as a whole
   speaks for the fullest group, as an older server reads it. Made-up numbers. */
const WEEK = '2026-11-10T00:41:44.000Z';
const gemini = { name: 'Gemini Models', about: 'Models within this group: Gemini Flash, Gemini Pro', status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0, resetsAt: '2026-11-04T23:41:44.000Z' }, { name: 'seven_day', utilization: 0.06, resetsAt: WEEK }], complete: true };
const others = { name: 'Claude and GPT models', about: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-11-05T02:19:23.000Z' }, { name: 'seven_day', utilization: 1, resetsAt: '2026-11-11T21:19:23.000Z' }], complete: true };
const grouped: Limits = { status: 'rejected', windows: others.windows, complete: true, groups: [gemini, others] };

describe('modelGroup', () => {
  it("finds a model's group by the words its provider reports for each group", () => {
    expect(modelGroup(grouped.groups, 'gemini-4-argon')?.name).toBe('Gemini Models');
    expect(modelGroup(grouped.groups, 'gemini-3.1-pro')?.name).toBe('Gemini Models');
    expect(modelGroup(grouped.groups, 'claude-sonnet-5-5')?.name).toBe('Claude and GPT models');
    expect(modelGroup(grouped.groups, 'gpt-oss-120b')?.name).toBe('Claude and GPT models');
  });

  it('relies on neither the number nor the names of the groups', () => {
    const three = [
      { name: 'Tier Alpha', status: 'rejected' as const, windows: [] },
      { name: 'Tier Beta', about: 'Holds Beta Swift and Beta Deep', status: 'allowed' as const, windows: [] },
      { name: 'Tier Gamma', status: 'allowed' as const, windows: [] },
    ];
    expect(modelGroup(three, 'alpha-9')?.name).toBe('Tier Alpha');
    expect(modelGroup(three, 'swift-2')?.name).toBe('Tier Beta');
    expect(modelGroup(three, 'gamma-1-mini')?.name).toBe('Tier Gamma');
    /* A word every group shares names none of them. */
    expect(modelGroup(three, 'tier-1')).toBeNull();
  });

  it('knows no group for a model its words do not name, name equally, or for no model', () => {
    expect(modelGroup(grouped.groups, 'kimi-k3')).toBeNull();
    expect(modelGroup(grouped.groups, 'claude-gemini-blend')).toBeNull();
    expect(modelGroup(grouped.groups, '')).toBeNull();
    expect(modelGroup(grouped.groups, null)).toBeNull();
    expect(modelGroup(undefined, 'gemini-4-argon')).toBeNull();
  });
});

describe('limitsForModel', () => {
  it("gives the limits of the model's own group", () => {
    expect(limitsForModel(grouped, 'gemini-4-argon')).toEqual({ status: 'allowed', windows: gemini.windows, complete: true });
    expect(limitsForModel(grouped, 'claude-sonnet-5-5')).toEqual({ status: 'rejected', windows: others.windows, complete: true });
  });

  it('gives the whole plan, its fullest window speaking, for a model of no known group and for limits with no groups', () => {
    expect(limitsForModel(grouped, 'kimi-k3')).toBe(grouped);
    expect(limitsForModel(grouped, '')).toBe(grouped);
    const plain = rejected([FULL, OPEN]);
    expect(limitsForModel(plain, 'gemini-4-argon')).toBe(plain);
    expect(limitsForModel(null, 'gemini-4-argon')).toBeNull();
  });
});

describe('currentLimits of a plan with model groups', () => {
  it("expires each group's own windows and clears the rejection a passed reset caused", () => {
    const passed = { ...others, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-11-04T21:00:00.000Z' }, { name: 'seven_day', utilization: 0.5, resetsAt: WEEK }] };
    const current = currentLimits({ status: 'rejected', windows: passed.windows, complete: true, groups: [gemini, passed] }, FRESH, NOW)!;
    expect(current.groups).toEqual([gemini, { ...passed, status: 'allowed', windows: [passed.windows[1]], complete: false }]);
    expect(limitsForModel(current, 'claude-opus-5-5')).toEqual({ status: 'allowed', windows: [passed.windows[1]], complete: false });
  });

  it('says nothing of any group in a stale snapshot', () => {
    expect(currentLimits(grouped, '2026-11-04T21:44:59.999Z', NOW)).toEqual({ status: 'allowed', windows: [], complete: false });
  });

  it('keeps the groups a node reports, and reads limits with no groups from an older node as before', () => {
    expect(currentLimits(grouped, FRESH, NOW)).toEqual(grouped);
    const status = (limits: Limits) => ({ type: 'status', loggedIn: true, limits, workError: null });
    expect(parseNodeMessage(JSON.stringify(status(grouped)))).toEqual(status(grouped));
    expect(parseNodeMessage(JSON.stringify(status(rejected([OPEN]))))).toEqual(status(rejected([OPEN])));
  });
});
