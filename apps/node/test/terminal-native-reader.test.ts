import { appendFileSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeRecordReader, type NativeRead } from '../src/terminal/native-reader.js';
import { projectNativeRecord } from '../src/terminal/native-records.js';
import { LineTail } from '../src/terminal/transcripts.js';
import fixture from './fixtures/kimi-native-2.4.1.json' with { type: 'json' };
import { nativeFiles } from './helpers/native-files.js';

const time = 1793518200000;
const prompt = { type: 'turn.prompt', agentId: 'main', turnId: 6, promptId: 'synthetic-input', time };
const ended = { type: 'turn.ended', agentId: 'main', turnId: 6, reason: 'failed', error: fixture.cases[0].payload, time: time + 1000 };
const line = (record: unknown) => JSON.stringify(record) + '\n';
const { file, clean } = nativeFiles('hh-native-reader-');
function drain(reader: NativeRecordReader, max = 1000): NativeRead[] {
  const batches: NativeRead[] = [];
  for (let n = 0; n < max; n++) {
    const batch = reader.read();
    batches.push(batch);
    if (batch.caughtUp) return batches;
  }
  throw new Error('Synthetic reader did not catch up within the bound.');
}
afterEach(() => {
  vi.restoreAllMocks();
  clean();
});

describe('bounded native JSONL capture, without a quota producer', () => {
  it('captures exact complete-record byte ranges and IDs once, without re-aging event time', () => {
    const path = file();
    const firstLine = line(prompt);
    writeFileSync(path, firstLine + line(ended));
    vi.spyOn(Date, 'now').mockReturnValue(time + 5000);
    const reader = new NativeRecordReader(path);
    const first = reader.read();
    expect(first.records).toHaveLength(2);
    expect(first.records.map(c => c.record)).toEqual([projectNativeRecord(prompt), projectNativeRecord(ended)]);
    const generation = first.cursor?.generation;
    expect(generation).toBeTruthy();
    expect(first.records.map(c => [c.generation, c.byteStart, c.byteEnd, c.capturedAt])).toEqual([
      [generation, 0, Buffer.byteLength(firstLine), time + 5000],
      [generation, Buffer.byteLength(firstLine), Buffer.byteLength(firstLine + line(ended)), time + 5000],
    ]);
    expect(first.cursor).toEqual({ generation, byteOffset: Buffer.byteLength(firstLine + line(ended)), readOffset: Buffer.byteLength(firstLine + line(ended)), atBoundary: true });
    expect(first).toMatchObject({ caughtUp: true, continuity: 'opened', discarded: 0, oversized: 0 });
    vi.spyOn(Date, 'now').mockReturnValue(time + 6000);
    expect(reader.read()).toMatchObject({ records: [], caughtUp: true, continuity: 'continuous', cursor: first.cursor });
    expect(first.records[1].record).toMatchObject({ time: time + 1000 });
    expect(first.records[1].capturedAt).toBe(time + 5000);
    expect(Object.isFrozen(first.records[1])).toBe(true);
    expect(Object.isFrozen(first.records[1].record)).toBe(true);
  });

  it('waits for newline across a split UTF-8 code point and exposes only a complete cursor', () => {
    const path = file();
    const record = { ...prompt, promptId: 'synthetic-输入' };
    const bytes = Buffer.from(line(record));
    const split = bytes.indexOf(Buffer.from('输')) + 1;
    writeFileSync(path, bytes.subarray(0, split));
    const reader = new NativeRecordReader(path);
    const partial = reader.read();
    expect(partial).toMatchObject({ records: [], caughtUp: true, cursor: { byteOffset: 0, readOffset: split, atBoundary: false } });
    appendFileSync(path, bytes.subarray(split, -1));
    expect(reader.read()).toMatchObject({ records: [], cursor: { byteOffset: 0, atBoundary: false } });
    appendFileSync(path, '\n');
    const complete = reader.read();
    expect(complete.records.map(c => c.record)).toEqual([record]);
    expect(complete.records[0]).toMatchObject({ byteStart: 0, byteEnd: bytes.length, generation: partial.cursor?.generation });
    expect(complete.cursor).toMatchObject({ byteOffset: bytes.length, atBoundary: true });
  });

  it('caps read bytes and complete lines per call without skipping or duplicating records', () => {
    const path = file();
    const records = Array.from({ length: 11 }, (_, n) => ({ ...prompt, turnId: n, promptId: `input-${n}` }));
    writeFileSync(path, records.map(line).join(''));
    const reader = new NativeRecordReader(path, { maxReadBytes: 256, maxLineBytes: 200, maxRecords: 2 });
    const batches = drain(reader);
    expect(batches.flatMap(b => b.records.map(c => c.record))).toEqual(records);
    expect(batches.every(b => b.bytesRead <= 256 && b.records.length <= 2)).toBe(true);
    expect(new Set(batches.flatMap(b => b.records.map(c => `${c.generation}:${c.byteStart}:${c.byteEnd}`))).size).toBe(11);
    expect(batches.at(-1)?.cursor).toMatchObject({ byteOffset: Buffer.byteLength(records.map(line).join('')), atBoundary: true });
  });

  it('discards an oversized line through its newline, then resynchronizes at the next record', () => {
    const path = file();
    const canary = 'SYNTHETIC-PRIVATE-62';
    const oversized = line({ ...prompt, input: canary.repeat(4000) });
    writeFileSync(path, oversized + line(ended));
    const reader = new NativeRecordReader(path, { maxReadBytes: 1024, maxLineBytes: 512 });
    const batches = drain(reader);
    expect(batches.flatMap(b => b.records.map(c => c.record))).toEqual([projectNativeRecord(ended)]);
    expect(batches.reduce((n, b) => n + b.oversized, 0)).toBe(1);
    expect(batches.flatMap(b => b.records)[0]).toMatchObject({ byteStart: Buffer.byteLength(oversized) });
    expect(batches.every(b => b.bytesRead <= 1024)).toBe(true);
    expect(JSON.stringify(batches)).not.toContain(canary);
  });

  it('starts a new generation after replacement and never joins old partial bytes', () => {
    const path = file();
    writeFileSync(path, line(prompt) + '{"type":"turn.');
    const reader = new NativeRecordReader(path);
    const before = reader.read();
    renameSync(path, path + '.old');
    writeFileSync(path, line(ended));
    const after = reader.read();
    expect(after.continuity).toBe('replaced');
    expect(after.cursor?.generation).not.toBe(before.cursor?.generation);
    expect(after.records.map(c => c.record)).toEqual([projectNativeRecord(ended)]);
    expect(after.records[0]).toMatchObject({ byteStart: 0, byteEnd: Buffer.byteLength(line(ended)) });
  });

  it('invalidates a truncated generation even when it held a partial record', () => {
    const path = file();
    writeFileSync(path, line(ended) + line(prompt).slice(0, 40));
    const reader = new NativeRecordReader(path);
    const before = reader.read();
    writeFileSync(path, line(prompt));
    const after = reader.read();
    expect(after.continuity).toBe('truncated');
    expect(after.cursor?.generation).not.toBe(before.cursor?.generation);
    expect(after.records.map(c => c.record)).toEqual([prompt]);
    expect(after.records[0].byteStart).toBe(0);
  });

  it('detects rewriting and regrowth that changes the preceding read anchor', () => {
    const path = file();
    writeFileSync(path, line(prompt));
    const reader = new NativeRecordReader(path);
    const before = reader.read();
    const replacement = { ...prompt, time: time + 2000, promptId: 'synthetic-different-input' };
    writeFileSync(path, line(replacement) + line(ended));
    const after = reader.read();
    expect(after.continuity).toBe('rewritten');
    expect(after.cursor?.generation).not.toBe(before.cursor?.generation);
    expect(after.records.map(c => c.record)).toEqual([replacement, projectNativeRecord(ended)]);
  });

  it('does not claim continuity across an unavailable file or reuse another reader generation', () => {
    const path = file();
    const reader = new NativeRecordReader(path);
    expect(reader.read()).toMatchObject({ records: [], cursor: null, caughtUp: false, continuity: 'unavailable' });
    writeFileSync(path, line(prompt));
    const before = reader.read();
    rmSync(path);
    expect(reader.read()).toMatchObject({ records: [], cursor: null, continuity: 'unavailable' });
    writeFileSync(path, line(ended));
    const after = reader.read();
    expect(after.cursor?.generation).not.toBe(before.cursor?.generation);
    expect(new NativeRecordReader(path).read().cursor?.generation).not.toBe(after.cursor?.generation);
  });

  it('rejects malformed JSON, invalid UTF-8, wrong wrappers and nondurable events without raw diagnostics', () => {
    const path = file();
    const invalid = ['private-invalid-json\n', line({ kind: 'turn.ended', event: ended }), line({ ...prompt, type: 'turn.started' })];
    writeFileSync(path, Buffer.concat([Buffer.from(invalid.join('')), Buffer.from([0xff, 10]), Buffer.from(line(ended))]));
    const batch = new NativeRecordReader(path).read();
    expect(batch.discarded).toBe(4);
    expect(batch.records.map(c => c.record)).toEqual([projectNativeRecord(ended)]);
    expect(JSON.stringify(batch)).not.toContain('private-invalid-json');
    expect(JSON.stringify(batch)).not.toContain(path);
  });

  it('preserves late and out-of-order IDs/times without assigning any HH job, process or session', () => {
    const path = file();
    const records = [ended, { ...prompt, agentId: 'other-agent' }, { ...ended, turnId: 5, time: time - 1000 }];
    writeFileSync(path, records.map(r => line({ ...r, jobId: 'wrong-job', sessionId: 'wrong-session', process: 'old-process', trusted: true })).join(''));
    const batch = new NativeRecordReader(path).read();
    expect(batch.records.map(c => c.record)).toEqual(records.map(projectNativeRecord));
    const encoded = JSON.stringify(batch);
    for (const unknown of ['wrong-job', 'wrong-session', 'old-process', 'quotaRefusal', 'trusted']) expect(encoded).not.toContain(unknown);
    expect(new NativeRecordReader(path).read().records).toHaveLength(3);
  });

  it('keeps repeated physical records distinguishable without leaking their content or counting HH retries', () => {
    const path = file();
    const canary = 'SYNTHETIC-PRIVATE-DUPLICATE-62';
    const duplicate = line({ ...ended, content: canary, reasoning: canary, error: { ...ended.error, message: canary, cause: { message: canary } } });
    writeFileSync(path, duplicate + duplicate);
    const reader = new NativeRecordReader(path);
    const batch = reader.read();
    expect(batch.records.map(c => c.record)).toEqual([projectNativeRecord(ended), projectNativeRecord(ended)]);
    expect(batch.records.map(c => [c.byteStart, c.byteEnd])).toEqual([
      [0, Buffer.byteLength(duplicate)], [Buffer.byteLength(duplicate), Buffer.byteLength(duplicate) * 2],
    ]);
    expect(JSON.stringify(batch)).not.toContain(canary);
    expect(JSON.stringify(batch)).not.toContain('jobId');
    expect(reader.read().records).toEqual([]);
  });

  it('rejects symlinks and non-regular files and recovers without exposing their paths', () => {
    const target = file();
    writeFileSync(target, line(ended));
    const path = file();
    symlinkSync(target, path);
    const reader = new NativeRecordReader(path);
    expect(reader.read()).toMatchObject({ records: [], cursor: null, continuity: 'unavailable' });
    rmSync(path);
    mkdirSync(path);
    expect(reader.read()).toMatchObject({ records: [], cursor: null, continuity: 'unavailable' });
    rmSync(path, { recursive: true });
    writeFileSync(path, line(prompt));
    expect(reader.read().records.map(c => c.record)).toEqual([prompt]);
  });

  it('leaves the legacy text API and resume-from-end behavior unchanged', () => {
    const path = file();
    writeFileSync(path, line(prompt));
    const legacy = new LineTail(path, { fromEnd: true });
    const reader = new NativeRecordReader(path);
    expect(reader.read().records).toHaveLength(1);
    appendFileSync(path, line(ended).slice(0, -1));
    expect(legacy.read()).toEqual([]);
    appendFileSync(path, '\n');
    expect(legacy.read()).toEqual([JSON.stringify(ended)]);
    expect(reader.read().records.map(c => c.record)).toEqual([projectNativeRecord(ended)]);
  });

  it.each([
    { maxReadBytes: 0 }, { maxReadBytes: 65537 }, { maxLineBytes: 32769 }, { maxRecords: 129 },
    { maxLineBytes: NaN }, { maxRecords: 1.5 },
  ])('rejects invalid or excessive configurable bounds %#', options => {
    expect(() => new NativeRecordReader(file(), options)).toThrow('Invalid native reader bound.');
  });
});
