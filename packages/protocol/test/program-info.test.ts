import { describe, expect, it } from 'vitest';
import { ProgramInfo } from '../src/index.js';

describe('managed program snapshots', () => {
  it('accepts an installed version and removes unrelated fields', () => {
    expect(ProgramInfo.parse({ id: 'claude', version: '2.0.0', updating: false, failed: false, output: 'private npm output' }))
      .toEqual({ id: 'claude', version: '2.0.0', updating: false, failed: false });
  });

  it('accepts an unknown version while installation is in progress', () => {
    expect(ProgramInfo.parse({ id: 'kimi', version: null, updating: true, failed: false }))
      .toEqual({ id: 'kimi', version: null, updating: true, failed: false });
  });

  it.each([
    { id: 'other' }, { version: '' }, { version: 'x'.repeat(65) }, { version: 2 }, { updating: 'yes' }, { failed: null },
  ])('rejects invalid program state %j', wrong => {
    expect(ProgramInfo.safeParse({ id: 'codex', version: '1.0.0', updating: false, failed: false, ...wrong }).success).toBe(false);
  });
});
