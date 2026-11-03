import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordedAfter, recordingCursor, Recordings } from '../src/terminal/recordings.js';

const folders: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hh-cursor-'));
  folders.push(dir);
  const recording = new Recordings(join(dir, 'private'), 'socket', null).create('agent', dir);
  const publish = (generation: number, end: number, text: string, size = Buffer.byteLength(text)) => {
    writeFileSync(recording.file, text);
    const data = Buffer.alloc(24);
    data.writeDoubleBE(generation, 0);
    data.writeDoubleBE(end, 8);
    data.writeDoubleBE(size, 16);
    writeFileSync(recording.position, data);
  };
  return { recording, publish };
}

afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('recorded byte cursors', () => {
  it('does not replay old bytes, including when a later trim removes them', () => {
    const { recording, publish } = fixture();
    publish(2, 3, 'old');
    const cursor = recordingCursor(recording)!;
    expect(recordedAfter(recording, cursor)).toBe('');
    publish(4, 6, 'oldnew');
    expect(recordedAfter(recording, cursor)).toBe('new');
    publish(6, 1003, 'fresh');
    expect(recordedAfter(recording, cursor)).toBe('fresh');
  });

  it('uses byte positions before decoding non-ASCII output', () => {
    const { recording, publish } = fixture();
    publish(2, 4, '🙂');
    const cursor = recordingCursor(recording)!;
    publish(4, 10, '🙂fresh!');
    expect(recordedAfter(recording, cursor)).toBe('fresh!');
  });

  it.each([[1, 3, 3], [2, NaN, 3], [2, 2, 3], [2, 3, -1]])('rejects unpublished or invalid cursor state %j', (generation, end, size) => {
    const { recording, publish } = fixture();
    publish(generation, end, 'old', size);
    expect(recordingCursor(recording)).toBeNull();
    expect(recordedAfter(recording, { file: recording.file, offset: 0 })).toBeNull();
  });

  it('does not accept a raw file that differs from its published size', () => {
    const { recording, publish } = fixture();
    publish(2, 5, 'old', 5);
    expect(recordedAfter(recording, { file: recording.file, offset: 0 })).toBeNull();
  });

  it('keeps a cursor tied to its recording and a published byte position', () => {
    const { recording, publish } = fixture();
    publish(2, 3, 'old');
    expect(recordedAfter(recording, { file: recording.file + '.other', offset: 0 })).toBeNull();
    expect(recordedAfter(recording, { file: recording.file, offset: 4 })).toBeNull();
  });

  it('does not follow a replaced cursor metadata link', () => {
    const { recording, publish } = fixture();
    publish(2, 3, 'old');
    const cursor = recordingCursor(recording)!;
    rmSync(recording.position);
    symlinkSync(recording.file, recording.position);
    expect(recordingCursor(recording)).toBeNull();
    expect(recordedAfter(recording, cursor)).toBeNull();
  });
});
