import { describe, expect, it } from 'vitest';
import { SetupWait } from '../src/setup-wait.js';

/* A program that answers whether it waits for its first setup, one answer per question; it fails when asked more. */
const program = (...answers: Array<boolean | Error>) => ({
  asked: 0,
  async setupNeeded() {
    this.asked++;
    const answer = answers.shift();
    if (answer === undefined) throw new Error('asked once too often');
    if (answer instanceof Error) throw answer;
    return answer;
  },
});
const signedIn = (...answers: boolean[]) => async () => {
  const answer = answers.shift();
  if (answer === undefined) throw new Error('asked once too often');
  return answer;
};

describe('the first setup a plan waits for, as the node tells Hornhoof of it', () => {
  it('asks a signed-in program only, and says so in its hello and status once it waits', async () => {
    const agy = program(true);
    const wait = new SetupWait(agy);
    expect(await wait.check(false)).toBe(false);
    expect([agy.asked, wait.field()]).toEqual([0, {}]);
    expect(await wait.check(true)).toBe(true);
    expect([wait.needed, wait.field()]).toEqual([true, { setupNeeded: true }]);
  });

  it('does not wait for a program that cannot tell, or that has no such setup', async () => {
    const unreadable = new SetupWait(program(new Error('settings unreadable')));
    expect([await unreadable.check(true), unreadable.needed]).toEqual([false, false]);
    const claude = new SetupWait({});
    expect([await claude.check(true), claude.needed]).toEqual([false, false]);
    const builtin = new SetupWait(null);
    expect([await builtin.check(true), builtin.field()]).toEqual([false, {}]);
  });

  it('is known from a turn that met it, and from no other failure', () => {
    const wait = new SetupWait(program());
    for (const other of [null, undefined, { kind: 'auth' }]) wait.met(other);
    expect(wait.needed).toBe(false);
    wait.met({ kind: 'setup' });
    expect(wait.field()).toEqual({ setupNeeded: true });
  });

  /* Only a sign-in it found by looking again is news: one it was told of may have gone while it looked. */
  it('looks again only while signed out or waiting, and says what it found and when either changed', async () => {
    const agy = program();
    const ready = new SetupWait(agy);
    expect(await ready.recheck(true, signedIn())).toEqual({ signedIn: false, changed: false });
    expect(agy.asked).toBe(0);

    const out = new SetupWait(program(false));
    expect(await out.recheck(false, signedIn(false))).toEqual({ signedIn: false, changed: false });
    expect(await out.recheck(false, signedIn(true))).toEqual({ signedIn: true, changed: true });

    const waiting = new SetupWait(program(true, true, false), 0);
    expect(await waiting.check(true)).toBe(true);
    expect(await waiting.recheck(true, signedIn())).toEqual({ signedIn: false, changed: false });
    expect(await waiting.recheck(true, signedIn())).toEqual({ signedIn: false, changed: true });
    expect(waiting.field()).toEqual({});

    const both = new SetupWait(program(true));
    expect(await both.recheck(false, signedIn(true))).toEqual({ signedIn: true, changed: true });
    expect(both.field()).toEqual({ setupNeeded: true });
  });

  /* Looking at agy's setup means starting agy, so while the plan waits the node looks once a minute at most. A turn that met
     the setup saw it as a look would, and a sign-in found by looking is looked at at once. */
  it('looks again at a setup it waits for once a minute at most, a turn that met it counting as a look', async () => {
    let now = 0;
    const agy = program(true, false);
    const wait = new SetupWait(agy, 60_000, () => now);
    expect(await wait.check(true)).toBe(true);
    now = 59_999;
    expect(await wait.recheck(true, signedIn())).toEqual({ signedIn: false, changed: false });
    expect(agy.asked).toBe(1);
    now = 60_000;
    expect(await wait.recheck(true, signedIn())).toEqual({ signedIn: false, changed: true });
    expect([agy.asked, wait.needed]).toEqual([2, false]);

    now = 110_000;
    wait.met({ kind: 'setup' });
    now = 169_999;
    expect(await wait.recheck(true, signedIn())).toEqual({ signedIn: false, changed: false });
    expect([agy.asked, wait.needed]).toEqual([2, true]);

    const out = new SetupWait(program(true), 60_000, () => now);
    expect(await out.check(false)).toBe(false);
    expect(await out.recheck(false, signedIn(true))).toEqual({ signedIn: true, changed: true });
    expect(out.needed).toBe(true);
  });
});
