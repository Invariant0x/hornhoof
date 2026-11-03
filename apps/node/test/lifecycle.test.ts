import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeLifecycle, prepareNodeStop } from '../src/lifecycle.js';

const FIRST = '2026-11-03T17:00:00.000Z';
const NEXT = '2026-11-03T17:47:00.000Z';
const dir = () => mkdtempSync(join(tmpdir(), 'hh-node-life-'));
const open = (path: string, startedAt: string, readOom = () => null as number | null, write = (_line: string) => {}) =>
  nodeLifecycle({ dir: path, startedAt, secrets: () => ['node-token-123456789'], write, readOom });

describe('a persisted node lifecycle', () => {
  it('does not invent a previous exit on first start or after a corrupt journal', () => {
    const path = dir();
    expect(open(path, FIRST).previous).toMatchObject({ kind: 'unknown', reason: 'unknown', startedAt: null, at: null, log: '' });
    writeFileSync(join(path, 'node-runtime.json'), '{broken');
    expect(open(path, NEXT).previous).toMatchObject({ kind: 'unknown', reason: 'unknown', startedAt: null });
  });

  it('keeps the real previous node log after a process dies without a completed stop', () => {
    const path = dir();
    const first = open(path, FIRST);
    first.log('Node socket closed with code 1006.');
    const next = open(path, NEXT);
    expect(next.previous).toMatchObject({ startedAt: FIRST, at: null, kind: 'unplanned', reason: 'unclean_exit', log: expect.stringContaining('Node socket closed with code 1006.') });
  });

  it('records a completed planned update and sends only sanitized output', () => {
    const path = dir();
    const output: string[] = [];
    const first = open(path, FIRST, () => null, line => output.push(line));
    first.log('Authorization: Bearer bearer-secret-123');
    first.log('Node key node-token-123456789');
    prepareNodeStop(path, 'node_update');
    const stopped = first.stop('stopped');
    expect(stopped).toMatchObject({ startedAt: FIRST, kind: 'planned', reason: 'node_update', at: expect.any(String) });
    expect(first.stop('stopped')).toEqual(stopped);
    const persisted = readFileSync(join(path, 'node-runtime.json'), 'utf8');
    for (const secret of ['bearer-secret-123', 'node-token-123456789']) {
      expect(persisted).not.toContain(secret);
      expect(output.join('\n')).not.toContain(secret);
      expect(stopped.log).not.toContain(secret);
    }
    expect(statSync(join(path, 'node-runtime.json')).mode & 0o777).toBe(0o600);
    expect(open(path, NEXT).previous).toMatchObject({ kind: 'planned', reason: 'node_update', startedAt: FIRST });
  });

  it('never mistakes a prepared update for a completed graceful stop', () => {
    const path = dir();
    open(path, FIRST).log('Node update requested.');
    prepareNodeStop(path, 'hornhoof_update');
    const next = open(path, NEXT);
    expect(next.previous).toMatchObject({ kind: 'unplanned', reason: 'unclean_exit' });
    expect(next.stop('stopped')).toMatchObject({ reason: 'stopped' });
  });

  it('only calls an exit OOM when a known kernel counter actually increased', () => {
    const path = dir();
    open(path, FIRST, () => 3);
    expect(open(path, NEXT, () => 4).previous).toMatchObject({ kind: 'unplanned', reason: 'out_of_memory' });
    const unknown = dir();
    open(unknown, FIRST);
    expect(open(unknown, NEXT, () => 4).previous).toMatchObject({ reason: 'unclean_exit' });
  });

  it('bounds the persisted log as well as the transmitted tail', () => {
    const path = dir();
    const life = open(path, FIRST);
    for (let i = 0; i < 100; i++) life.log(`Node diagnostic ${i}: ${'界'.repeat(200)}`);
    expect(Buffer.byteLength(life.tail())).toBeLessThanOrEqual(16384);
    expect(life.tail().split('\n').length).toBeLessThanOrEqual(80);
    const stored = JSON.parse(readFileSync(join(path, 'node-runtime.json'), 'utf8'));
    expect(stored.log).toBe(life.tail());
    expect(stored.log).toContain('Node diagnostic 99');
  });
});
