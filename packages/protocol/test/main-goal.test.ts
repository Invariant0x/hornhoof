import { describe, expect, it } from 'vitest';
import { checkpointCounts, cityEpochFor, judgeGoalAnswer, type Checkpoint } from '../src/main-goal.js';

const reached = (extra: Partial<Checkpoint> = {}): Checkpoint => ({ status: 'reached', targetValue: null, currentValue: null, confirmedByPerson: true, ...extra });
const open = (extra: Partial<Checkpoint> = {}): Checkpoint => ({ status: 'active', targetValue: null, currentValue: null, confirmedByPerson: false, ...extra });

describe('the answer to the question about the great goal', () => {
  it.each(['earn a million dollars', 'Build a million-dollar company', 'Get a good result in my studies', 'Заработать миллион долларов', 'Построить компанию на миллион'])(
    'takes %j as a goal',
    text => expect(judgeGoalAnswer(text)).toBe('goal'),
  );

  it.each(['', '   ', 'ok', 'yes', 'hello', 'money', 'test', 'asdf', 'aaaaaa', '...', '123', 'да', 'привет', 'деньги', 'buy milk'])(
    'asks for a bigger goal after the trivial or unclear answer %j',
    text => expect(judgeGoalAnswer(text)).toBe('too_small'),
  );

  it.each(["I don't know", 'i do not know yet', 'No idea', 'not sure', "I'm not sure yet", 'не знаю', 'Пока не знаю', 'без понятия'])(
    'leaves a general goal for %j',
    text => expect(judgeGoalAnswer(text)).toBe('unknown'),
  );
});

describe('which checkpoints count', () => {
  it('counts a reached checkpoint only when a person confirmed it', () => {
    expect(checkpointCounts(reached())).toBe(true);
    expect(checkpointCounts(reached({ confirmedByPerson: false }))).toBe(false);
    expect(checkpointCounts(open())).toBe(false);
  });

  it('counts a checkpoint the numbers prove, and not one dropped or short of its target', () => {
    expect(checkpointCounts(open({ targetValue: 100_000, currentValue: 100_000 }))).toBe(true);
    expect(checkpointCounts(open({ targetValue: 100_000, currentValue: 99_999 }))).toBe(false);
    expect(checkpointCounts(reached({ status: 'dropped' }))).toBe(false);
  });
});

describe('the epoch of the city', () => {
  it('stays in the first epoch with no goal and with no checkpoints yet', () => {
    expect(cityEpochFor({ goal: null, checkpoints: [], earned: 1 })).toBe(1);
    expect(cityEpochFor({ goal: open(), checkpoints: [], earned: 1 })).toBe(1);
  });

  it('moves to the second epoch when a confirmed checkpoint makes one third of the path', () => {
    expect(cityEpochFor({ goal: open(), checkpoints: [reached(), open(), open()], earned: 1 })).toBe(2);
    expect(cityEpochFor({ goal: open(), checkpoints: [open(), open(), open()], earned: 1 })).toBe(1);
  });

  it('moves to the third epoch at two thirds, and at the end of the path', () => {
    expect(cityEpochFor({ goal: open(), checkpoints: [reached(), reached(), open()], earned: 1 })).toBe(3);
    expect(cityEpochFor({ goal: reached(), checkpoints: [open(), open()], earned: 1 })).toBe(3);
  });

  it('does not count what the orchestrator marked reached and nobody confirmed', () => {
    const proposed = reached({ confirmedByPerson: false });
    expect(cityEpochFor({ goal: open(), checkpoints: [proposed, proposed, proposed], earned: 1 })).toBe(1);
  });

  it('never rolls the city back when the goal is raised and its path grows', () => {
    const before = [reached(), reached(), open()];
    expect(cityEpochFor({ goal: open(), checkpoints: before, earned: 1 })).toBe(3);
    const raised = [...before, open(), open(), open(), open(), open(), open()];
    expect(cityEpochFor({ goal: open(), checkpoints: raised, earned: 3 })).toBe(3);
    expect(cityEpochFor({ goal: open(), checkpoints: raised, earned: 2 })).toBe(2);
  });

  it('measures only the next thresholds against the raised path', () => {
    const second = [reached(), open(), open()];
    expect(cityEpochFor({ goal: open(), checkpoints: second, earned: 1 })).toBe(2);
    const raised = [...second, open(), open(), open()];
    expect(cityEpochFor({ goal: open(), checkpoints: raised, earned: 2 })).toBe(2);
    const later = [reached(), reached(), reached(), reached(), open(), open()];
    expect(cityEpochFor({ goal: open(), checkpoints: later, earned: 2 })).toBe(3);
  });

  it('leaves the epoch where it is when the goal is dropped', () => {
    expect(cityEpochFor({ goal: open({ status: 'dropped' }), checkpoints: [], earned: 2 })).toBe(2);
  });
});
