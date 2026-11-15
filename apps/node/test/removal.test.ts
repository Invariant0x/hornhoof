import { describe, expect, it } from 'vitest';
import { removalWatch } from '../src/removal.js';

function watched(owed: boolean) {
  const state = { owed, over: 0 };
  return { state, watch: removalWatch(() => state.owed, () => void state.over++) };
}

describe('removalWatch', () => {
  it('waits while removed is owed, and is over once it is not', () => {
    const { state, watch } = watched(true);
    watch.start();
    watch.settle();
    expect(state.over).toBe(0);
    state.owed = false;
    watch.settle();
    expect(state.over).toBe(1);
  });

  it('is over at once when nothing was owed by the time it starts', () => {
    const { state, watch } = watched(false);
    watch.start();
    expect(state.over).toBe(1);
  });

  it('is over when Hornhoof refuses the key, owed or not', () => {
    const { state, watch } = watched(true);
    watch.start();
    watch.refused();
    expect(state.over).toBe(1);
  });

  it('means nothing before a removal starts', () => {
    const { state, watch } = watched(false);
    watch.settle();
    watch.refused();
    expect(state.over).toBe(0);
  });

  it('is over only once', () => {
    const { state, watch } = watched(false);
    watch.start();
    watch.settle();
    watch.refused();
    expect(state.over).toBe(1);
  });
});
