import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeRecordReader } from '../src/terminal/native-reader.js';
import { nativeFiles } from './helpers/native-files.js';

const fault = vi.hoisted(() => ({ afterRead: null as ((args: readonly unknown[]) => void) | null }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: (...args: unknown[]) => {
    const n: number = Reflect.apply(actual.readSync, actual, args);
    fault.afterRead?.(args);
    return n;
  } };
});

const time = 1793518200000;
const prompt = { type: 'turn.prompt', agentId: 'main', turnId: 6, promptId: 'synthetic-input', time };
const line = (record: unknown) => JSON.stringify(record) + '\n';
const { file, clean } = nativeFiles('hh-native-race-');
function afterReadOnce(run: () => void): void {
  fault.afterRead = () => { fault.afterRead = null; run(); };
}
afterEach(() => {
  fault.afterRead = null;
  clean();
});

describe('native reader storage faults at the read boundary', () => {
  it('discards a descriptor snapshot when the path is replaced during reading', () => {
    const path = file();
    writeFileSync(path, line(prompt));
    const replacement = { ...prompt, turnId: 7 };
    const reader = new NativeRecordReader(path);
    afterReadOnce(() => { renameSync(path, path + '.old'); writeFileSync(path, line(replacement)); });
    expect(reader.read()).toMatchObject({ records: [], cursor: null, caughtUp: false, continuity: 'changed' });
    expect(reader.read().records.map(c => c.record)).toEqual([replacement]);
  });

  it.each(['truncate', 'rewrite'] as const)('discards records after concurrent %s before validation', change => {
    const path = file();
    writeFileSync(path, line(prompt));
    const reader = new NativeRecordReader(path);
    afterReadOnce(() => writeFileSync(path, change === 'truncate' ? '' : line({ ...prompt, time: time + 1000 })));
    expect(reader.read()).toMatchObject({ records: [], cursor: null, continuity: 'changed' });
    expect(reader.read().records).toHaveLength(change === 'truncate' ? 0 : 1);
  });

  it('checks the preceding anchor again when a concurrent writer rewrites earlier bytes', () => {
    const path = file();
    const firstLine = line(prompt);
    const next = { ...prompt, turnId: 7 };
    writeFileSync(path, firstLine);
    const reader = new NativeRecordReader(path);
    expect(reader.read().records).toHaveLength(1);
    appendFileSync(path, line(next));
    fault.afterRead = args => {
      if (args[4] !== Buffer.byteLength(firstLine)) return;
      fault.afterRead = null;
      writeFileSync(path, line({ ...prompt, time: time + 1000 }) + line(next));
    };
    expect(reader.read()).toMatchObject({ records: [], cursor: null, continuity: 'changed' });
    expect(reader.read().records).toHaveLength(2);
  });

  it('does not mistake an ordinary concurrent append for loss of continuity', () => {
    const path = file();
    writeFileSync(path, line(prompt));
    const next = { ...prompt, turnId: 7 };
    const reader = new NativeRecordReader(path);
    afterReadOnce(() => appendFileSync(path, line(next)));
    const first = reader.read();
    expect(first).toMatchObject({ caughtUp: false, continuity: 'opened' });
    expect(first.records.map(c => c.record)).toEqual([prompt]);
    const second = reader.read();
    expect(second.records.map(c => c.record)).toEqual([next]);
    expect(second.cursor?.generation).toBe(first.cursor?.generation);
  });

  it('sanitizes I/O exceptions and retries with a new local generation', () => {
    const path = file();
    writeFileSync(path, line(prompt));
    const reader = new NativeRecordReader(path);
    afterReadOnce(() => { throw new Error('SYNTHETIC-SECRET-PATH-62'); });
    const failed = reader.read();
    expect(failed).toMatchObject({ records: [], cursor: null, continuity: 'unavailable' });
    expect(JSON.stringify(failed)).not.toContain('SYNTHETIC-SECRET-PATH-62');
    expect(reader.read().records.map(c => c.record)).toEqual([prompt]);
  });

  it('bounds processing of discarded lines too and respects the exact newline-inclusive limit', () => {
    const path = file();
    writeFileSync(path, '\n'.repeat(130) + line(prompt));
    const reader = new NativeRecordReader(path);
    expect(reader.read()).toMatchObject({ records: [], discarded: 128, caughtUp: false, cursor: { byteOffset: 128 } });
    expect(reader.read()).toMatchObject({ discarded: 2, caughtUp: true });
    const exact = new NativeRecordReader(path, { maxLineBytes: Buffer.byteLength(line(prompt)) });
    expect(exact.read()).toMatchObject({ records: [], discarded: 128 });
    expect(exact.read().records).toHaveLength(1);
    const tooSmall = new NativeRecordReader(path, { maxLineBytes: Buffer.byteLength(line(prompt)) - 1 });
    tooSmall.read();
    expect(tooSmall.read()).toMatchObject({ records: [], oversized: 1, caughtUp: true });
  });
});
