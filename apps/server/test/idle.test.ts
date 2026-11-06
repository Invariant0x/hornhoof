import { describe, expect, it } from 'vitest';
import { evaluateIdle, IDLE_SETTINGS, isFree, type IdleEmployee, type IdleSnapshot, type IdleTask } from '../src/modules/tasks/idle.js';

const MINUTE = 60_000;
const START = Date.parse('2026-11-06T02:00:00Z');

const employee = (id: string, more: Partial<IdleEmployee> = {}): IdleEmployee => ({
  id,
  name: `Employee ${id}`,
  enabled: true,
  hasTurn: false,
  actionable: false,
  ...more,
});

const task = (id: string): IdleTask => ({ id, number: Number(id), title: `Task ${id}`, after: ['prerequisite'] });
const employees = (count: number, more: Partial<IdleEmployee> = {}) => Array.from({ length: count }, (_, index) => employee(String(index + 1), more));
const snapshot = (at: number, staff: IdleEmployee[], tasks: IdleTask[] = []): IdleSnapshot => ({ departmentId: 'development', at, employees: staff, tasks });

describe('an employee who is free for independent work', () => {
  it('is enabled and has neither a current turn nor work that can proceed now', () => {
    expect(isFree({ enabled: true, hasTurn: false, actionable: false })).toBe(true);
    expect(isFree({ enabled: true, hasTurn: false, actionable: true })).toBe(false);
    expect(isFree({ enabled: true, hasTurn: true, actionable: false })).toBe(false);
    expect(isFree({ enabled: false, hasTurn: false, actionable: false })).toBe(false);
  });
});

describe('an idle episode', () => {
  it('signals five free employees and three waiting tasks after ten minutes, then raises the watchdog at fifteen', () => {
    const tasks = ['1', '2', '3'].map(task);
    const first = evaluateIdle(null, snapshot(START, employees(5), tasks));
    expect(first.free.map(e => e.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(first.busy).toEqual([]);
    expect(first.notifications).toEqual([]);

    const before = evaluateIdle(first.episode, snapshot(START + 10 * MINUTE - 1, employees(5), tasks));
    expect(before.notifications).toEqual([]);
    expect(before.episode).toEqual(first.episode);

    const signal = evaluateIdle(first.episode, snapshot(START + 10 * MINUTE, employees(5), tasks));
    expect(signal.notifications).toEqual(['signal']);
    expect(signal.episode).toEqual(first.episode);

    const watchdog = evaluateIdle(first.episode, snapshot(START + 15 * MINUTE, employees(5), tasks));
    expect(watchdog.notifications).toEqual(['signal', 'watchdog']);
  });

  it('does not count a waiting employee who has other actionable work', () => {
    const staff = [...employees(4), employee('waiting', { actionable: true })];
    const evaluation = evaluateIdle(null, snapshot(START + 20 * MINUTE, staff, [task('1')]));
    expect(evaluation.free).toHaveLength(4);
    expect(evaluation.busy.map(e => e.id)).toEqual(['waiting']);
  });

  it('resets when the department has no work', () => {
    const previous = evaluateIdle(null, snapshot(START, employees(5), [task('1')])).episode;
    const evaluation = evaluateIdle(previous, snapshot(START + 20 * MINUTE, employees(5)));
    expect(evaluation.episode).toBeNull();
    expect(evaluation.notifications).toEqual([]);
  });

  it('raises neither a signal nor an alarm when every employee is disabled', () => {
    const evaluation = evaluateIdle(null, snapshot(START + 20 * MINUTE, employees(5, { enabled: false }), [task('1')]));
    expect(evaluation.episode).toBeNull();
    expect(evaluation.free).toEqual([]);
    expect(evaluation.notifications).toEqual([]);
  });

  it('raises the watchdog without an idle signal when only one employee is free', () => {
    const evaluation = evaluateIdle(null, snapshot(START, [employee('free')], [task('1')]));
    const later = evaluateIdle(evaluation.episode, snapshot(START + 15 * MINUTE, [employee('free')], [task('1')]));
    expect(later.notifications).toEqual(['watchdog']);
  });

  it('does not alarm at exactly the starting busy ratio, which is not a measured optimum', () => {
    expect(IDLE_SETTINGS).toEqual({ signalAfterMs: 600_000, watchdogAfterMs: 900_000, minFree: 3, busyRatio: 0.25 });
    const staff = [employee('busy', { hasTurn: true }), ...employees(3)];
    const first = evaluateIdle(null, snapshot(START, staff, [task('1')]));
    const later = evaluateIdle(first.episode, snapshot(START + 15 * MINUTE, staff, [task('1')]));
    expect(later.busyRatio).toBe(0.25);
    expect(later.notifications).toEqual(['signal']);
  });

  it('starts a new episode when the free set or waiting task set changes', () => {
    const first = evaluateIdle(null, snapshot(START, employees(5), [task('1'), task('2'), task('3')]));
    const changed = evaluateIdle(first.episode, snapshot(START + 9 * MINUTE, employees(5), [task('1'), task('2')]));
    expect(changed.episode?.since).toBe(START + 9 * MINUTE);
    expect(changed.episode?.key).not.toBe(first.episode?.key);
    expect(changed.notifications).toEqual([]);
    const later = evaluateIdle(changed.episode, snapshot(START + 18 * MINUTE, employees(5), [task('1'), task('2')]));
    expect(later.notifications).toEqual([]);
  });
});
