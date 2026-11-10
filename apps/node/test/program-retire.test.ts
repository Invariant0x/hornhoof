import { describe, expect, it } from 'vitest';
import { enterPending, idleRefusal, type IdleEvidence } from '../src/terminal/program-retire.js';

const IDLE: IdleEvidence = { turn: false, queuedTurns: 0, unopened: 0, busy: false, starting: false, restarting: false, typing: false, promptWaits: false, personWords: false, calls: 0, waitingWords: 0, stillTyping: false, enterPending: false, unanswered: false, writers: false };

describe('whether a program is idle', () => {
  it('is, with nothing going on', () => {
    expect(idleRefusal(IDLE)).toBeNull();
  });

  it.each(Object.entries({ turn: true, queuedTurns: 1, unopened: 1, busy: true, starting: true, restarting: true, typing: true, promptWaits: true, personWords: true, calls: 1, waitingWords: 1, stillTyping: true, enterPending: true, unanswered: true, writers: true }))('is not, with %s', (field, value) => {
    expect(idleRefusal({ ...IDLE, [field]: value })).toEqual(expect.any(String));
  });
});

describe('an Enter a person pressed', () => {
  it('holds the program from the press on, while it has no end yet', () => {
    expect(enterPending({ until: null }, 1000)).toBe(true);
  });

  it('holds it until the time it may be heard in has passed', () => {
    expect(enterPending({ until: 1001 }, 1000)).toBe(true);
    expect(enterPending({ until: 1000 }, 1000)).toBe(false);
  });

  it('holds nothing when none was pressed', () => {
    expect(enterPending(null, 1000)).toBe(false);
    expect(enterPending(undefined, 1000)).toBe(false);
  });
});
