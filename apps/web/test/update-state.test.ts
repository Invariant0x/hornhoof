import { describe, expect, it } from 'vitest';
import { answeredUpdate } from '../src/update-state';
import type { UpdaterStatus } from '../src/types';

const status: UpdaterStatus = { id: 'u1', version: '0.6.1', state: 'done', step: 'pull', log: '', at: '2026-11-05T00:00:00Z' };

describe('update acknowledgment', () => {
  it.each([
    ['running', false], ['done', true], ['failed', true], ['rolled_back', true],
  ] as const)('treats a matching %s update as answered: %s', (state, answered) => {
    expect(answeredUpdate({ id: 'u1' }, { ...status, state })).toBe(answered);
  });

  it('requires a sent request and its own status record', () => {
    expect(answeredUpdate(null, status)).toBe(false);
    expect(answeredUpdate({ id: 'u2' }, status)).toBe(false);
    expect(answeredUpdate({ id: 'u1' }, null)).toBe(false);
    expect(answeredUpdate({ id: 'u1' }, undefined)).toBe(false);
  });
});
