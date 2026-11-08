import { describe, expect, it } from 'vitest';
import { changedLines } from '../src/modules/tasks/review-context.js';

describe('candidate source inventory', () => {
  it('counts an increment statement as an added hunk line together with deleted source', () => {
    expect(changedLines('@@ -1,2 +1,2 @@\n-value--;\n+value++;\n unchanged();')).toBe(2);
  });
});
