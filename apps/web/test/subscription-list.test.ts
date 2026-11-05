import { describe, expect, it } from 'vitest';
import { replaceSubscription } from '../src/screens/subscription-list';
import { SUBS } from './api-mock';

describe('subscription list replacement', () => {
  it('updates the selected plan without replacing or changing the other plans', () => {
    const list = [SUBS[0]!, SUBS[3]!];
    const subscription = { ...SUBS[0]!, budget: 80 };
    const next = replaceSubscription(list, subscription, 'update')!;
    expect(next[0]).toEqual(subscription);
    expect(next[1]).toBe(list[1]);
    expect(list[0]!.budget).toBeNull();
    expect(list[1]!.isOrchestrator).toBe(true);
  });

  it('moves the orchestrator badge and leaves the input plan records unchanged', () => {
    const list = [SUBS[0]!, SUBS[3]!];
    const subscription = { ...SUBS[0]!, isOrchestrator: true };
    const next = replaceSubscription(list, subscription, 'orchestrator')!;
    expect(next[0]).toEqual(subscription);
    expect(next[1]).toEqual({ ...SUBS[3]!, isOrchestrator: false });
    expect(list.map(sub => sub.isOrchestrator)).toEqual([false, true]);
  });

  it('keeps an unloaded list unloaded and never inserts an unlisted plan', () => {
    const other = { ...SUBS[0]!, id: 'unlisted' };
    expect(replaceSubscription(null, other, 'update')).toBeNull();
    expect(replaceSubscription([], other, 'update')).toEqual([]);
    expect(replaceSubscription([SUBS[3]!], other, 'update')).toEqual([SUBS[3]!]);
  });
});
