import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProgramInfo } from '@hornhoof/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgramUpdates, readInstalledVersion } from '../src/program-updates.js';

let tools: string;
beforeEach(() => { tools = mkdtempSync(join(tmpdir(), 'hh-updates-')); });
afterEach(() => rmSync(tools, { recursive: true, force: true }));

function writeVersion(packageName: string, version: unknown): void {
  const file = join(tools, 'lib', 'node_modules', packageName, 'package.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version }));
}

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
}

describe('node-owned program updates', () => {
  it('shares one batch and tells when the installed version can be used', async () => {
    writeVersion('@anthropic-ai/claude-code', '1.0.0');
    const started = gate();
    const finish = gate();
    const updates = new ProgramUpdates([{
      id: 'claude', readVersion: () => readInstalledVersion(tools, 'claude'),
      install: async () => { started.release(); await finish.waiting; writeVersion('@anthropic-ai/claude-code', '2.0.0'); },
    }]);
    const states: ProgramInfo[][] = [];
    const batch = updates.update(() => states.push(updates.snapshot()));
    expect(updates.update()).toBe(batch);
    expect(updates.ready()).toBe(batch);
    await started.waiting;
    expect(updates.snapshot()).toEqual([{ id: 'claude', version: '1.0.0', updating: true, failed: false }]);
    finish.release();
    await batch;
    expect(readInstalledVersion(tools, 'claude')).toBe('2.0.0');
    expect(updates.version('claude')).toBe('2.0.0');
    expect(updates.version('antigravity')).toBeNull();
    expect(states).toEqual([
      [{ id: 'claude', version: '1.0.0', updating: true, failed: false }],
      [{ id: 'claude', version: '2.0.0', updating: false, failed: false }],
    ]);
  });

  it('serializes installations sharing the npm prefix', async () => {
    const firstStarted = gate();
    const finishFirst = gate();
    const events: string[] = [];
    const updates = new ProgramUpdates([
      { id: 'claude', readVersion: () => readInstalledVersion(tools, 'claude'), install: async () => {
        events.push('claude started'); firstStarted.release(); await finishFirst.waiting;
        writeVersion('@anthropic-ai/claude-code', '2.0.0'); events.push('claude installed');
      } },
      { id: 'codex', readVersion: () => readInstalledVersion(tools, 'codex'), install: async () => {
        events.push('codex started'); writeVersion('@openai/codex', '4.0.0'); events.push('codex installed');
      } },
    ]);
    const batch = updates.update();
    await firstStarted.waiting;
    expect(events).toEqual(['claude started']);
    finishFirst.release();
    await batch;
    expect(events).toEqual(['claude started', 'claude installed', 'codex started', 'codex installed']);
    expect(updates.snapshot()).toEqual([
      { id: 'claude', version: '2.0.0', updating: false, failed: false },
      { id: 'codex', version: '4.0.0', updating: false, failed: false },
    ]);
  });

  it('retains an installed version on failure, updates other programs and permits retry', async () => {
    writeVersion('@anthropic-ai/claude-code', '1.0.0');
    let attempts = 0;
    const updates = new ProgramUpdates([
      { id: 'claude', readVersion: () => readInstalledVersion(tools, 'claude'), install: async () => {
        if (++attempts === 1) throw new Error('npm failed with a private test credential');
        writeVersion('@anthropic-ai/claude-code', '2.0.0');
      } },
      { id: 'codex', readVersion: () => readInstalledVersion(tools, 'codex'), install: async () => writeVersion('@openai/codex', '4.0.0') },
    ]);
    await updates.update();
    expect(updates.snapshot()).toEqual([
      { id: 'claude', version: '1.0.0', updating: false, failed: true },
      { id: 'codex', version: '4.0.0', updating: false, failed: false },
    ]);
    expect(JSON.stringify(updates.snapshot())).not.toContain('private test credential');
    await updates.update();
    expect(updates.snapshot()).toEqual([
      { id: 'claude', version: '2.0.0', updating: false, failed: false },
      { id: 'codex', version: '4.0.0', updating: false, failed: false },
    ]);
  });

  it('has no pending work or reports for a node without managed programs', async () => {
    const updates = new ProgramUpdates([]);
    const states: ProgramInfo[][] = [];
    await updates.update(() => states.push(updates.snapshot()));
    await updates.ready();
    expect(updates.snapshot()).toEqual([]);
    expect(states).toEqual([]);
    expect(updates.version('claude')).toBeNull();
  });

  it('updates again only when asked, even after six hours', async () => {
    vi.useFakeTimers();
    let version = 1;
    writeVersion('@anthropic-ai/claude-code', '1.0.0');
    const updates = new ProgramUpdates([{ id: 'claude', readVersion: () => readInstalledVersion(tools, 'claude'),
      install: async () => writeVersion('@anthropic-ai/claude-code', `${++version}.0.0`) }]);
    try {
      await updates.update();
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(readInstalledVersion(tools, 'claude')).toBe('2.0.0');
      await updates.update();
      expect(readInstalledVersion(tools, 'claude')).toBe('3.0.0');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('installed npm versions', () => {
  it.each([
    ['claude', '@anthropic-ai/claude-code'], ['codex', '@openai/codex'], ['kimi', '@moonshot-ai/kimi-code'],
  ] as const)('reads the managed %s package metadata', (id, packageName) => {
    writeVersion(packageName, '1.2.3');
    expect(readInstalledVersion(tools, id)).toBe('1.2.3');
  });

  it.each([null, 12, '', 'x'.repeat(65)])('reports an unknown version for invalid metadata: %s', version => {
    writeVersion('@anthropic-ai/claude-code', version);
    expect(readInstalledVersion(tools, 'claude')).toBeNull();
  });

  it('reports an unknown version for missing or broken metadata', () => {
    expect(readInstalledVersion(tools, 'claude')).toBeNull();
    writeVersion('@anthropic-ai/claude-code', '1.0.0');
    const file = join(tools, 'lib/node_modules/@anthropic-ai/claude-code/package.json');
    writeFileSync(file, '{broken');
    expect(readInstalledVersion(tools, 'claude')).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });
});
