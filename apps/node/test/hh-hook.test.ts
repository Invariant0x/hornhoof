import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));

describe('hh-hook', () => {
  it('tells a program that compacted its conversation to read the company again, without a bridge', () => {
    const out = execFileSync('node', [HOOK, 'compact', '{}'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(out).toContain('compacted');
    expect(out).toContain('instructions');
  });

  it('prints nothing for the events it only passes on', () => {
    expect(execFileSync('node', [HOOK, 'status', '{}'], { env: { PATH: process.env.PATH }, encoding: 'utf8' })).toBe('');
  });
});
