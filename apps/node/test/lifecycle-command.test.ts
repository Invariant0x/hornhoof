import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeLifecycle } from '../src/lifecycle.js';
import { lifecycleCommand } from '../src/lifecycle-command.js';

describe('an installer stop intent', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('records a validated reason for the running generation and leaves other commands alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-stop-cli-'));
    vi.stubEnv('HORNHOOF_DATA', dir);
    const life = nodeLifecycle({ dir, startedAt: '2026-11-03T17:00:00.000Z', secrets: () => [], write: () => {} });
    expect(lifecycleCommand(['status'])).toBeNull();
    expect(lifecycleCommand(['prepare-stop', 'node_update'])).toBe(0);
    expect(life.stop('stopped')).toMatchObject({ reason: 'node_update' });
  });

  it('refuses an unknown reason and extra arguments without changing the exit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-stop-cli-'));
    vi.stubEnv('HORNHOOF_DATA', dir);
    const life = nodeLifecycle({ dir, startedAt: '2026-11-03T17:00:00.000Z', secrets: () => [], write: () => {} });
    expect(() => lifecycleCommand(['prepare-stop', 'anything'])).toThrow();
    expect(() => lifecycleCommand(['prepare-stop', 'node_update', 'extra'])).toThrow();
    expect(life.stop('stopped')).toMatchObject({ reason: 'stopped' });
  });
});
