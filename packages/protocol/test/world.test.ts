import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_LEVEL,
  agentLevelFromAcceptedTasks,
  agentLevelThreshold,
  departmentStageFromAcceptedTasks,
  departmentStatuesFromAcceptedTasks,
  deriveWorldMode,
  flophouseStageFromCalls,
  goalMonumentProgress,
  houseStageFromLevel,
  machinePowerTier,
  nextLevelProgress,
  residenceStageFromAcceptedTasks,
  subscriptionFullness,
} from '../src/world.js';

describe('canonical world formulas (single source of truth)', () => {
  it('computes agent level thresholds round(2 * (L - 1)^1.8) across levels 1..30', () => {
    expect(MAX_AGENT_LEVEL).toBe(30);
    expect(agentLevelThreshold(1)).toBe(0);
    expect(agentLevelThreshold(2)).toBe(2);
    expect(agentLevelThreshold(3)).toBe(7);
    expect(agentLevelThreshold(4)).toBe(14);
    expect(agentLevelThreshold(5)).toBe(24);
    expect(agentLevelThreshold(6)).toBe(36);
    expect(agentLevelThreshold(7)).toBe(50);
    expect(agentLevelThreshold(30)).toBe(Math.round(2 * Math.pow(29, 1.8)));

    expect(agentLevelFromAcceptedTasks(0)).toBe(1);
    expect(agentLevelFromAcceptedTasks(1)).toBe(1);
    expect(agentLevelFromAcceptedTasks(2)).toBe(2);
    expect(agentLevelFromAcceptedTasks(6)).toBe(2);
    expect(agentLevelFromAcceptedTasks(7)).toBe(3);
    expect(agentLevelFromAcceptedTasks(11)).toBe(3);
    /* Hornhoof team top performers (44-48 accepted tasks) sit at Lv 6, reaching Lv 7 at 50 tasks. */
    expect(agentLevelFromAcceptedTasks(44)).toBe(6);
    expect(agentLevelFromAcceptedTasks(48)).toBe(6);
    expect(agentLevelFromAcceptedTasks(50)).toBe(7);
    expect(agentLevelFromAcceptedTasks(10_000)).toBe(30);

    const p48 = nextLevelProgress(48);
    expect(p48).toEqual({ level: 6, currentThreshold: 36, nextThreshold: 50, remaining: 2 });
    const pMax = nextLevelProgress(999);
    expect(pMax).toEqual({ level: 30, currentThreshold: 858, nextThreshold: null, remaining: 0 });
  });

  it('maps house stages from agent level and department stages from accepted tasks', () => {
    expect(houseStageFromLevel(1, 10)).toBe(1);
    expect(houseStageFromLevel(6, 10)).toBeGreaterThanOrEqual(2);
    expect(houseStageFromLevel(30, 10)).toBe(10);

    expect(departmentStageFromAcceptedTasks(0, 10)).toBe(1);
    expect(departmentStageFromAcceptedTasks(10, 10)).toBe(2);
    expect(departmentStageFromAcceptedTasks(250, 10)).toBeGreaterThanOrEqual(5);
    expect(departmentStageFromAcceptedTasks(5000, 10)).toBe(10);
  });

  it('advances department statues every 100 accepted tasks, 20 stages per statue, keeping finished ones and starting larger next', () => {
    expect(departmentStatuesFromAcceptedTasks(0, 20, 100)).toEqual([]);
    expect(departmentStatuesFromAcceptedTasks(99, 20, 100)).toEqual([]);
    expect(departmentStatuesFromAcceptedTasks(100, 20, 100)).toEqual([
      { index: 1, stage: 1, maxStage: 20, completed: false, sizeTier: 1, span: 1 },
    ]);
    expect(departmentStatuesFromAcceptedTasks(2000, 20, 100)).toEqual([
      { index: 1, stage: 20, maxStage: 20, completed: true, sizeTier: 1, span: 1 },
    ]);
    expect(departmentStatuesFromAcceptedTasks(2100, 20, 100)).toEqual([
      { index: 1, stage: 20, maxStage: 20, completed: true, sizeTier: 1, span: 1 },
      { index: 2, stage: 1, maxStage: 20, completed: false, sizeTier: 2, span: 2 },
    ]);
    expect(departmentStatuesFromAcceptedTasks(4500, 20, 100)).toEqual([
      { index: 1, stage: 20, maxStage: 20, completed: true, sizeTier: 1, span: 1 },
      { index: 2, stage: 20, maxStage: 20, completed: true, sizeTier: 2, span: 2 },
      { index: 3, stage: 5, maxStage: 20, completed: false, sizeTier: 3, span: 3 },
    ]);
  });

  it('computes ruler residence across 5 canonical stages from company accepted tasks', () => {
    expect(residenceStageFromAcceptedTasks(0)).toEqual({ stage: 1, maxStage: 5, tierKey: 'camp' });
    expect(residenceStageFromAcceptedTasks(60)).toEqual({ stage: 2, maxStage: 5, tierKey: 'mud_house' });
    expect(residenceStageFromAcceptedTasks(944)).toEqual({ stage: 3, maxStage: 5, tierKey: 'stone_house' });
    expect(residenceStageFromAcceptedTasks(1500)).toEqual({ stage: 4, maxStage: 5, tierKey: 'columned_hall' });
    expect(residenceStageFromAcceptedTasks(6000)).toEqual({ stage: 5, maxStage: 5, tierKey: 'grand_residence' });
  });

  it('computes monument height from numeric target, child goals fallback, task ratio fallback, and reached celebration', () => {
    const numeric = goalMonumentProgress({
      status: 'active',
      targetValue: 1_000_000,
      currentValue: 400_000,
      childGoalsTotal: 5,
      childGoalsReached: 1,
      tasksTotal: 10,
      tasksDone: 1,
    });
    expect(numeric.progress).toBeCloseTo(0.4, 6);
    expect(numeric.reached).toBe(false);
    expect(numeric.celebrating).toBe(false);
    expect(numeric.stage).toBe(4);

    const byChildren = goalMonumentProgress({
      status: 'active',
      targetValue: null,
      currentValue: null,
      childGoalsTotal: 4,
      childGoalsReached: 3,
      tasksTotal: 20,
      tasksDone: 2,
    });
    expect(byChildren.progress).toBeCloseTo(0.75, 6);
    expect(byChildren.stage).toBe(8);

    const byTasks = goalMonumentProgress({
      status: 'active',
      targetValue: null,
      currentValue: null,
      childGoalsTotal: 0,
      childGoalsReached: 0,
      tasksTotal: 94,
      tasksDone: 91,
    });
    expect(byTasks.progress).toBeCloseTo(91 / 94, 6);
    expect(byTasks.stage).toBe(10);

    const reached = goalMonumentProgress({
      status: 'reached',
      targetValue: 100,
      currentValue: 80,
      childGoalsTotal: 0,
      childGoalsReached: 0,
      tasksTotal: 0,
      tasksDone: 0,
    });
    expect(reached.progress).toBe(1);
    expect(reached.reached).toBe(true);
    expect(reached.celebrating).toBe(true);
    expect(reached.stage).toBe(10);
  });

  it('computes supply fullness from remaining subscription limits', () => {
    const now = Date.parse('2026-11-21T19:00:00Z');
    const fresh = new Date(now - 60_000).toISOString();
    const future = new Date(now + 3_600_000).toISOString();

    expect(subscriptionFullness({ status: 'needs_login', limits: null, limitsUpdatedAt: null }, now)).toEqual({
      fullness: 0,
      exhausted: true,
      active: false,
    });

    expect(
      subscriptionFullness(
        {
          status: 'ready',
          limits: {
            status: 'allowed',
            windows: [
              { name: '5h', utilization: 0.25, resetsAt: future },
              { name: '7d', utilization: 0.6, resetsAt: future },
            ],
          },
          limitsUpdatedAt: fresh,
        },
        now,
      ),
    ).toEqual({
      fullness: 0.4,
      exhausted: false,
      active: true,
    });

    expect(
      subscriptionFullness(
        {
          status: 'ready',
          limits: {
            status: 'rejected',
            windows: [{ name: '5h', utilization: 1, resetsAt: future }],
          },
          limitsUpdatedAt: fresh,
        },
        now,
      ),
    ).toEqual({
      fullness: 0,
      exhausted: true,
      active: true,
    });

    /* Expired reset window restores fullness. */
    expect(
      subscriptionFullness(
        {
          status: 'ready',
          limits: {
            status: 'rejected',
            windows: [{ name: '5h', utilization: 1, resetsAt: new Date(now - 10_000).toISOString() }],
          },
          limitsUpdatedAt: fresh,
        },
        now,
      ),
    ).toEqual({
      fullness: 1,
      exhausted: false,
      active: true,
    });
  });

  it('sizes machine hubs by cores/RAM, scales flophouses by one-shot calls, and derives worldMode', () => {
    expect(machinePowerTier(4, 8 * 1024 ** 3).span).toBe(2);
    expect(machinePowerTier(8, 24 * 1024 ** 3).span).toBe(3);
    expect(machinePowerTier(16, 64 * 1024 ** 3).span).toBe(4);

    expect(flophouseStageFromCalls(0)).toBe(0);
    expect(flophouseStageFromCalls(1)).toBe(1);
    expect(flophouseStageFromCalls(25)).toBe(3);
    expect(flophouseStageFromCalls(500)).toBe(6);

    expect(
      deriveWorldMode({ template: null, departmentsCount: 0, employeesCount: 0, readySubscriptionsCount: 0 }),
    ).toBe('empty_lot');
    expect(
      deriveWorldMode({ template: 'startup', departmentsCount: 3, employeesCount: 6, readySubscriptionsCount: 0 }),
    ).toBe('no_subscription');
    expect(
      deriveWorldMode({ template: 'startup', departmentsCount: 3, employeesCount: 6, readySubscriptionsCount: 2 }),
    ).toBe('active');
  });
});
