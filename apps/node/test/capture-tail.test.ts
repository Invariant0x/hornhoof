import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { tail } = createRequire(import.meta.url)('../hh-capture.cjs') as {
  tail(fd: number, limit: number, io: { write(fd: number, data: Buffer, offset: number, length: number, at: number): number; truncate(fd: number, size: number): void }): ((chunk: Buffer) => void) & { end(): void };
};

/* A file the recorder writes through, kept in memory. */
function file() {
  let data = Buffer.alloc(0);
  let written = 0;
  const io = {
    write(_fd: number, chunk: Buffer, offset: number, length: number, at: number) {
      const next = Buffer.alloc(Math.max(data.length, at + length));
      data.copy(next);
      chunk.copy(next, at, offset, offset + length);
      data = next;
      written += length;
      return length;
    },
    truncate(_fd: number, size: number) {
      data = data.subarray(0, size);
    },
  };
  return { io, text: () => data.toString(), written: () => written, size: () => data.length };
}

describe('the terminal output recorder', () => {
  it('writes each chunk about once, not the whole kept output again for every chunk', () => {
    const f = file();
    const keep = tail(3, 16 * 1024, f.io);
    const chunks = Array.from({ length: 400 }, (_, i) => Buffer.from(`${String(i).padStart(4, '0')}${'x'.repeat(1020)}`));
    for (const chunk of chunks) keep(chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(f.written()).toBeLessThan(3 * total);
    expect(f.size()).toBeLessThanOrEqual(2 * 16 * 1024);
  });

  it('keeps at least the last limit of bytes at the end of its file', () => {
    const f = file();
    const keep = tail(3, 4096, f.io);
    const all = Array.from({ length: 50 }, (_, i) => `line ${i} ${'y'.repeat(200)}\n`).join('');
    for (let at = 0; at < all.length; at += 300) keep(Buffer.from(all.slice(at, at + 300)));
    expect(f.text().slice(-4096)).toBe(all.slice(-4096));
  });

  it('cuts its file back to the limit once the program is over', () => {
    const f = file();
    const keep = tail(3, 4096, f.io);
    const all = 'z'.repeat(7000) + 'end';
    for (let at = 0; at < all.length; at += 500) keep(Buffer.from(all.slice(at, at + 500)));
    keep.end();
    expect(f.text()).toBe(all.slice(-4096));
  });
});
