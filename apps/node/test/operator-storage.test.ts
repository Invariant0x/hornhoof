import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readOperatorStore, writeOperatorStore } from '../src/terminal/operator-storage.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync), fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync), closeSync: vi.fn(actual.closeSync) };
});
const folders: string[] = [];
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function fixture(): string {
  const folder = fs.mkdtempSync(join(tmpdir(), 'hh-operator-store-')); folders.push(folder);
  return join(folder, 'nested', 'state.json');
}
const schema = z.object({ ordinal: z.number().int() });

describe('durable operator JSON storage', () => {
  it('roundtrips a validated snapshot with owner-only permissions and fails closed for corrupted state', () => {
    const file = fixture();
    expect(readOperatorStore(file, schema, { ordinal: 0 })).toEqual({ ordinal: 0 });
    writeOperatorStore(file, { ordinal: 4 });
    expect(readOperatorStore(file, schema, { ordinal: 0 })).toEqual({ ordinal: 4 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, '{');
    expect(() => readOperatorStore(file, schema, { ordinal: 0 })).toThrow();
    fs.writeFileSync(file, JSON.stringify({ ordinal: 'invalid' }));
    expect(() => readOperatorStore(file, schema, { ordinal: 0 })).toThrow();
  });

  it('restores owner-only permissions even when an earlier temporary file has broad permissions', () => {
    const file = fixture(); fs.mkdirSync(dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.new`, 'incomplete', { mode: 0o644 });
    writeOperatorStore(file, { ordinal: 12 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readOperatorStore(file, schema, { ordinal: 0 })).toEqual({ ordinal: 12 });
  });

  it('flushes the temporary file before rename and the parent directory after rename', async () => {
    const file = fixture(); const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const events: string[] = []; const opened = new Map<number, string>();
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      const fd = actual.openSync(path, flags, mode); opened.set(fd, String(path)); return fd;
    });
    vi.mocked(fs.fsyncSync).mockImplementation(fd => { events.push(`sync:${opened.get(fd)}`); actual.fsyncSync(fd); });
    vi.mocked(fs.renameSync).mockImplementation((from, to) => { events.push('rename'); actual.renameSync(from, to); });
    writeOperatorStore(file, { ordinal: 5 });
    expect(events).toEqual([`sync:${file}.new`, 'rename', `sync:${dirname(file)}`]);
    expect(readOperatorStore(file, schema, { ordinal: 0 })).toEqual({ ordinal: 5 });
  });

  it('keeps the previous committed snapshot and closes the file when temporary flush fails', () => {
    const file = fixture(); writeOperatorStore(file, { ordinal: 6 });
    const closed = vi.mocked(fs.closeSync).mock.calls.length;
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw Object.assign(new Error('flush failed'), { code: 'EIO' }); });
    expect(() => writeOperatorStore(file, { ordinal: 7 })).toThrow('flush failed');
    expect(readOperatorStore(file, schema, { ordinal: 0 })).toEqual({ ordinal: 6 });
    expect(vi.mocked(fs.closeSync).mock.calls.length).toBeGreaterThan(closed);
    writeOperatorStore(file, { ordinal: 7 });
    expect(readOperatorStore(file, schema, { ordinal: 0 })).toEqual({ ordinal: 7 });
  });

  it('keeps the previous snapshot when writing the temporary file fails', () => {
    const file = fixture(); writeOperatorStore(file, { ordinal: 8 });
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error('write failed'); });
    expect(() => writeOperatorStore(file, { ordinal: 9 })).toThrow('write failed');
    expect(readOperatorStore(file, schema, { ordinal: 0 })).toEqual({ ordinal: 8 });
    writeOperatorStore(file, { ordinal: 9 });
    expect(readOperatorStore(file, schema, { ordinal: 0 })).toEqual({ ordinal: 9 });
  });

  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])('tolerates unsupported directory flush %s after a durable file flush', code => {
    const file = fixture();
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw Object.assign(new Error('directory sync unsupported'), { code }); });
    writeOperatorStore(file, { ordinal: 10 });
    expect(readOperatorStore(file, schema, { ordinal: 0 })).toEqual({ ordinal: 10 });
  });

  it('surfaces real directory flush failures after rename and leaves a readable complete snapshot', () => {
    const file = fixture();
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw Object.assign(new Error('directory flush failed'), { code: 'EIO' }); });
    expect(() => writeOperatorStore(file, { ordinal: 11 })).toThrow('directory flush failed');
    expect(readOperatorStore(file, schema, { ordinal: 0 })).toEqual({ ordinal: 11 });
  });
});
