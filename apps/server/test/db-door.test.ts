import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { describe, expect, it, onTestFinished } from 'vitest';
import { composeAllowed, DbDoor } from '../src/net/db-door.js';
import { until } from './helpers.js';

const LOOPBACK = '127.0.0.1';

/* What a door's connect reaches: a TCP server that sends back what it gets. */
async function echo(): Promise<{ port: number; connect: () => Promise<Duplex>; calls: () => number }> {
  const server = net.createServer(socket => socket.on('error', () => undefined).pipe(socket));
  await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve));
  onTestFinished(() => void server.close());
  const { port } = server.address() as AddressInfo;
  let calls = 0;
  const connect = () =>
    new Promise<Duplex>((resolve, reject) => {
      calls += 1;
      const socket = net.connect({ host: LOOPBACK, port });
      socket.once('error', reject);
      socket.once('connect', () => resolve(socket));
    });
  return { port, connect, calls: () => calls };
}

async function door(opts: Partial<ConstructorParameters<typeof DbDoor>[0]> & Pick<ConstructorParameters<typeof DbDoor>[0], 'connect'>) {
  const lines: string[] = [];
  const made = new DbDoor({ allowed: async () => [LOOPBACK], log: line => lines.push(line), host: LOOPBACK, ...opts });
  const port = await made.listen(0);
  onTestFinished(() => made.close());
  return { door: made, port, lines };
}

/* A client of the door: what it got back, and whether the door ended it. */
function client(port: number): { socket: net.Socket; got: () => string; closed: () => boolean } {
  const socket = net.connect({ host: LOOPBACK, port });
  let got = '';
  let closed = false;
  socket.on('error', () => undefined);
  socket.on('data', chunk => (got += String(chunk)));
  socket.once('close', () => (closed = true));
  onTestFinished(() => void socket.destroy());
  return { socket, got: () => got, closed: () => closed };
}

describe("the keeper's door to another machine's database", () => {
  it('passes what an allowed address sends', async () => {
    const far = await echo();
    const { port } = await door({ connect: far.connect });
    const a = client(port);
    a.socket.write('one two');
    await until(() => a.got() === 'one two');
    /* Each connection is a stream of its own. */
    const b = client(port);
    b.socket.write('three');
    await until(() => b.got() === 'three');
    expect(far.calls()).toBe(2);
  });

  it('drops anyone else at once', async () => {
    const far = await echo();
    const { port } = await door({ connect: far.connect, allowed: async () => ['192.0.2.1'] });
    const a = client(port);
    a.socket.write('hello');
    await until(() => a.closed());
    expect(a.got()).toBe('');
    expect(far.calls()).toBe(0);
  });

  it('reads who is allowed again in time', async () => {
    const far = await echo();
    let allowed = ['192.0.2.1'];
    const { port } = await door({ connect: far.connect, allowed: async () => allowed, refreshMs: 20 });
    const a = client(port);
    await until(() => a.closed());
    allowed = [LOOPBACK];
    await until(async () => {
      const b = client(port);
      b.socket.write('in');
      await new Promise(resolve => setTimeout(resolve, 30));
      return b.got() === 'in';
    });
  });

  it('closes when the far side is gone', async () => {
    let asked = 0;
    const { port, lines } = await door({ connect: () => { asked += 1; return Promise.reject(new Error('no session')); } });
    const a = client(port);
    await until(() => a.closed());
    expect(lines).toEqual(['A database connection could not be carried to the other machine: no session']);
    /* A second one within the minute is closed the same way, and is not said again. */
    const b = client(port);
    await until(() => b.closed());
    expect(asked).toBe(2);
    expect(lines).toHaveLength(1);
  });

  it('closes everything on close', async () => {
    const far = await echo();
    const { door: made, port } = await door({ connect: far.connect });
    const a = client(port);
    a.socket.write('x');
    await until(() => a.got() === 'x');
    await made.close();
    await until(() => a.closed());
    const b = client(port);
    await until(() => b.closed());
    expect(b.got()).toBe('');
  });

  it('allows the addresses of the names it is given, and none for a name nobody has', async () => {
    expect(await composeAllowed(['localhost'])()).toEqual(expect.arrayContaining([LOOPBACK]));
    expect(await composeAllowed(['no-such-host.invalid'])()).toEqual([]);
  });
});
