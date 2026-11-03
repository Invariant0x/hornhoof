import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { LineTail } from '../src/terminal/transcripts.js';

/* A read of the log that gets fewer bytes than it asked for. Only the next read is held to so many bytes, and only when
   a test asks. */
const short = vi.hoisted(() => ({ bytes: null as number | null }));
vi.mock('node:fs', async original => {
  const real = await original<typeof import('node:fs')>();
  const readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    const most = short.bytes ?? length;
    short.bytes = null;
    return real.readSync(fd, buffer, offset, Math.min(length, most), position);
  }) as typeof real.readSync;
  return { ...real, readSync };
});

const logFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-tail-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'log.jsonl');
};

describe('following a log file the program is still writing', () => {
  it('gives a line whole when a read ends in the middle of a letter', () => {
    const file = logFile();
    const line = '{"text":"Привет, мир"}';
    const bytes = Buffer.from(`${line}\n`);
    /* Between the two bytes of "и", D0 and B8. */
    const cut = bytes.indexOf(Buffer.from('и')) + 1;
    writeFileSync(file, bytes.subarray(0, cut));
    const tail = new LineTail(file);
    expect(tail.read()).toEqual([]);
    appendFileSync(file, bytes.subarray(cut));
    expect(tail.read()).toEqual([line]);
  });

  it('takes only the bytes a short read got, and the rest with the next read', () => {
    const file = logFile();
    writeFileSync(file, '{"a":1}\n{"b":2}\n');
    const tail = new LineTail(file);
    short.bytes = 10;
    expect(tail.read()).toEqual(['{"a":1}']);
    appendFileSync(file, '{"c":3}\n');
    expect(tail.read()).toEqual(['{"b":2}', '{"c":3}']);
  });
});
