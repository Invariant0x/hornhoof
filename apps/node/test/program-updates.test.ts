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
    expect(updates.snapshot()).toEqual([{ id: 'claude', version: '1.0.0', updating: false, failed: false }]);
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

  it.each([false, true])('stops waiting without stopping the installation, already aborted=%s', async alreadyAborted => {
    const install = gate();
    const stop = new AbortController();
    const updates = new ProgramUpdates([{ id: 'claude', readVersion: () => '1.0.0', install: () => install.waiting }]);
    const batch = updates.update();
    if (alreadyAborted) stop.abort();
    let stopped = false;
    const waiting = updates.ready(stop.signal).then(() => { stopped = true; });
    stop.abort();
    try {
      await waiting;
      expect(stopped).toBe(true);
      expect(updates.snapshot()).toEqual([{ id: 'claude', version: '1.0.0', updating: true, failed: false }]);
      expect(updates.ready()).toBe(batch);
    } finally {
      install.release();
      await batch;
      await waiting;
    }
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

  /* npm's own words go to the machine's output; Hornhoof's screen of the machine only says the update failed. */
  it("says in the machine's output why a program could not be updated", async () => {
    const lines: string[] = [];
    const updates = new ProgramUpdates([{ id: 'claude', readVersion: () => '1.0.0', install: async () => { throw new Error('npm error code ENOTEMPTY'); } }]);
    await updates.update(() => {}, line => lines.push(line));
    expect(updates.snapshot()).toEqual([{ id: 'claude', version: '1.0.0', updating: false, failed: true }]);
    expect(lines).toEqual(['Could not update claude: npm error code ENOTEMPTY']);
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

describe('a program that does not start on the machine', () => {
  it('says it is installed again, then why it still does not start, and nothing once it starts', async () => {
    writeVersion('@anthropic-ai/claude-code', '2.0.0');
    const updates = new ProgramUpdates([{ id: 'claude', readVersion: () => readInstalledVersion(tools, 'claude'), install: async () => {} }]);
    const told: ProgramInfo[][] = [];
    updates.watch(() => told.push(updates.snapshot()));
    updates.repaired('claude', { state: 'reinstalling' });
    updates.repaired('claude', { state: 'broken', line: 'Error: claude native binary not installed.' });
    updates.repaired('claude', null);
    expect(told).toEqual([
      [{ id: 'claude', version: '2.0.0', updating: false, failed: false, repair: 'reinstalling' }],
      [{ id: 'claude', version: '2.0.0', updating: false, failed: false, repair: 'broken', reason: 'Error: claude native binary not installed.' }],
      [{ id: 'claude', version: '2.0.0', updating: false, failed: false }],
    ]);
  });

  it('says only that it does not start when it printed nothing, and forgets that when an update begins', async () => {
    const updates = new ProgramUpdates([{ id: 'codex', readVersion: () => null, install: async () => {} }]);
    updates.repaired('codex', { state: 'broken', line: null });
    expect(updates.snapshot()).toEqual([{ id: 'codex', version: null, updating: false, failed: false, repair: 'broken' }]);
    const batch = updates.update();
    expect(updates.snapshot()).toEqual([{ id: 'codex', version: null, updating: true, failed: false }]);
    await batch;
  });

  it('leaves a program it does not manage alone', () => {
    const updates = new ProgramUpdates([{ id: 'claude', readVersion: () => null, install: async () => {} }]);
    updates.repaired('agy', { state: 'reinstalling' });
    expect(updates.snapshot()).toEqual([{ id: 'claude', version: null, updating: false, failed: false }]);
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
