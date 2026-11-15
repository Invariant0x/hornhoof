import { describe, expect, it } from 'vitest';
import { keepDraft } from '../src/ui/Requests';

describe('the answers a person typed and did not send', () => {
  it('stay for so many cards at most, the oldest typed in going first, and an emptied one going at once', () => {
    const drafts = new Map<string, string>();
    for (let i = 1; i <= 5; i++) keepDraft(drafts, `r${i}`, `answer ${i}`, 3);
    expect([...drafts.keys()]).toEqual(['r3', 'r4', 'r5']);
    keepDraft(drafts, 'r3', 'answer 3, longer', 3);
    keepDraft(drafts, 'r6', 'answer 6', 3);
    expect([...drafts.entries()]).toEqual([['r5', 'answer 5'], ['r3', 'answer 3, longer'], ['r6', 'answer 6']]);
    keepDraft(drafts, 'r5', '', 3);
    expect([...drafts.keys()]).toEqual(['r3', 'r6']);
  });
});
