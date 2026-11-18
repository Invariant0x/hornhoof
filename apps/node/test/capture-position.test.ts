import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { PrivateStreamMask } from '../src/terminal/mask.js';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../hh-capture.cjs', import.meta.url), 'utf8');
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/* Exercise the recorder entry point with real private files. Short writes expose each cursor publication step. */
function recorder(changeArgs: (args: string[]) => string[] = args => args) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hh-capture-position-'));
  const files = ['output', 'ready', 'flush', 'position'].map(name => join(dir, name));
  for (const file of files) fs.writeFileSync(file, '');
  const [output, ready, flush, position] = files as [string, string, string, string];
  const descriptors = new Set<number>();
  const writes: { at: number; state: Buffer }[] = [];
  let positionFd = -1;
  cleanups.push(() => {
    for (const fd of descriptors) fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const io = {
    ...fs,
    openSync(file: string, flags: number) {
      const fd = fs.openSync(file, flags);
      descriptors.add(fd);
      if (file === position) positionFd = fd;
      return fd;
    },
    writeSync(fd: number, data: Buffer | string, offset: number, length: number | string, at: number) {
      if (typeof data === 'string') return fs.writeSync(fd, data, offset, length as BufferEncoding);
      const written = fs.writeSync(fd, data, offset, Math.min(length as number, 3), at);
      if (fd === positionFd) writes.push({ at, state: fs.readFileSync(position) });
      return written;
    },
  };
  const stdin = new EventEmitter();
  const module = { exports: {} };
  let connect: ((client: EventEmitter) => void) | undefined;
  const net = { createServer: (_options: unknown, accept: typeof connect) => {
    connect = accept;
    return { listen: (_path: string, ready: () => void) => ready(), close: () => {} };
  } };
  const load = Object.assign((name: string) => {
    if (name === 'node:fs') return io;
    if (name === 'node:net') return net;
    if (name === './dist/terminal/mask.js') return { PrivateStreamMask };
    return require(name);
  }, { main: module });
  runInNewContext(source, {
    require: load, module, Buffer,
    process: { argv: ['node', 'hh-capture.cjs', ...changeArgs([output, ready, flush, '4', 'socket', 'session', position])], stdin, once: () => {} },
    setInterval: () => ({ unref: () => {} }),
  }, { filename: fileURLToPath(new URL('../hh-capture.cjs', import.meta.url)) });
  return { stdin, writes, output, position, ready, mask: (...values: string[]) => {
    const client = Object.assign(new EventEmitter(), { setEncoding: () => {}, end: () => {} });
    connect?.(client);
    client.emit('data', JSON.stringify(values));
    client.emit('end');
  } };
}

describe('recorder cursor publication', () => {
  it('writes readable output with short vault values masked before they reach the recording file', () => {
    const c = recorder(args => [...args.map((value, at) => at === 3 ? '4096' : value), 'mask.sock']);
    c.stdin.emit('data', Buffer.from('Booting.\r\n'));
    c.mask('zqx', '081804');
    c.stdin.emit('data', Buffer.from('Partner at https://example.test as nora: z\x1b[3'));
    expect(fs.readFileSync(c.output, 'utf8')).toBe('Booting.\r\nPartner at https://example.test as nora: ');
    c.stdin.emit('data', Buffer.from('1mqx 081'));
    c.stdin.emit('data', Buffer.from('804\r\nDone.'));
    expect(fs.readFileSync(c.output, 'utf8')).toBe('Booting.\r\nPartner at https://example.test as nora: [hidden]\x1b[31m [hidden]\r\nDone.');
  });

  it.each([0, 1, 2, 4, 5, 6])('rejects an empty required argument at %i before opening files', missing => {
    expect(() => recorder(args => args.map((value, at) => at === missing ? '' : value))).toThrow('Invalid output capture arguments.');
  });

  it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])('rejects an invalid byte limit %s', limit => {
    expect(() => recorder(args => args.map((value, at) => at === 3 ? limit : value))).toThrow('Invalid output capture arguments.');
  });

  it('initializes the cursor before acknowledging readiness', () => {
    const c = recorder();
    expect(fs.readFileSync(c.ready, 'utf8')).toBe('ready');
    expect(fs.readFileSync(c.position)).toEqual(Buffer.alloc(24));
    expect(c.writes.map(write => write.at)).toEqual([8, 11, 14, 17, 20, 23, 0, 3, 6]);
  });

  it('accepts the smallest positive byte limit and retains its final byte', () => {
    const c = recorder(args => args.map((value, at) => at === 3 ? '1' : value));
    c.stdin.emit('data', Buffer.from('abc'));
    expect(fs.readFileSync(c.output, 'utf8')).toBe('c');
    const position = fs.readFileSync(c.position);
    expect([position.readDoubleBE(0), position.readDoubleBE(8), position.readDoubleBE(16)]).toEqual([2, 3, 1]);
  });

  it('marks append and rotation busy before publishing both bounds, including short writes', () => {
    const c = recorder();
    c.writes.length = 0;
    c.stdin.emit('data', Buffer.from('old'));
    c.stdin.emit('data', Buffer.from('abcdefghij'));
    const odd = [0, 3, 6, 8, 11, 14, 17, 20, 23];
    const even = [8, 11, 14, 17, 20, 23, 0, 3, 6];
    expect(c.writes.map(write => write.at)).toEqual([...odd, ...even, ...odd, ...even]);
    const state = (at: number) => {
      const bytes = c.writes[at]!.state;
      return [bytes.readDoubleBE(0), bytes.readDoubleBE(8), bytes.readDoubleBE(16)];
    };
    expect(state(2)).toEqual([1, 0, 0]);
    expect(state(14)).toEqual([1, 3, 3]);
    expect(state(17)).toEqual([2, 3, 3]);
    expect(state(20)).toEqual([3, 3, 3]);
    expect(state(32)).toEqual([3, 13, 4]);
    expect(state(35)).toEqual([4, 13, 4]);
    expect(fs.readFileSync(c.output, 'utf8')).toBe('ghij');
  });
});
