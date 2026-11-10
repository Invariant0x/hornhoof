import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { startFront } from '../src/net/front.js';
import { firstForwarded, passThrough, serve, startingAnswer, type Target } from '../src/net/proxy.js';

/* A promise to settle from outside, since Promise.withResolvers is newer than the language level the tests compile to. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

/* Takes the server down with every socket it has, upgraded ones too, when the test ends. */
function downWithTheTest(server: http.Server): void {
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  onTestFinished(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
}

async function listening(server: http.Server): Promise<Target> {
  downWithTheTest(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

const answering = (handler: (req: http.IncomingMessage, res: http.ServerResponse) => unknown) =>
  listening(http.createServer((req, res) => void handler(req, res)));

async function front(keeper: Target): Promise<{ server: http.Server; door: Target }> {
  const server = await startFront({ port: 0, host: '127.0.0.1', keeper });
  downWithTheTest(server);
  return { server, door: { host: '127.0.0.1', port: (server.address() as AddressInfo).port } };
}

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };

function send(to: Target, options: http.RequestOptions = {}, body?: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const out = http.request({ ...to, agent: false, ...options }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      );
    });
    out.on('error', reject);
    out.end(body);
  });
}

const echoHeaders = () =>
  http.createServer((req, res) => {
    req.resume();
    res.end(JSON.stringify(req.headers));
  });

describe('startFront', () => {
  it('names the visitor by the socket and nothing else', async () => {
    const { server, door } = await front(await listening(echoHeaders()));
    const answer = await send(door, {
      headers: {
        'x-forwarded-for': '198.51.100.7',
        'x-forwarded-proto': 'https',
        'x-hornhoof-via': 'x',
        'x-forwarded-host': 'corp.hornhoof.test',
      },
    });
    const seen = JSON.parse(answer.body);
    expect(seen['x-forwarded-for']).toBe('127.0.0.1');
    expect(seen['x-forwarded-proto']).toBeUndefined();
    expect(seen['x-hornhoof-via']).toBeUndefined();
    expect(seen['x-forwarded-host']).toBe('corp.hornhoof.test');
    expect(server.requestTimeout).toBe(0);
    expect(server.headersTimeout).toBe(60_000);
    expect(server.keepAliveTimeout).toBe(72_000);
  });

  it('does not start on a port that is taken', async () => {
    const { port } = await listening(echoHeaders());
    await expect(startFront({ port, host: '127.0.0.1', keeper: { host: '127.0.0.1', port: 1 } })).rejects.toThrow(
      'EADDRINUSE',
    );
  });

  it('goes on serving after an error on its listening socket, such as a failed accept', async () => {
    const { server, door } = await front(await listening(echoHeaders()));
    server.emit('error', new Error('accept EMFILE'));
    server.emit('error', new Error('accept EMFILE'));
    expect((await send(door)).status).toBe(200);
  });

  it('says Hornhoof is starting while the keeper is down', async () => {
    const keeper = http.createServer();
    const target = await listening(keeper);
    await new Promise(resolve => keeper.close(resolve));
    const { door } = await front(target);
    const answer = await send(door, { path: '/api/x' });
    expect(answer.status).toBe(502);
    expect(answer.headers['retry-after']).toBe('5');
    expect(JSON.parse(answer.body).error.reason).toBe('starting');
    const socket = new WebSocket(`ws://127.0.0.1:${door.port}/`);
    await expect(once(socket, 'open')).rejects.toThrow('Unexpected server response: 502');
  });
});

describe('through front and the next hop', () => {
  /* The next hop as the keeper is: it takes the visitor from what front wrote. */
  async function throughTwoHops(app: http.Server): Promise<Target> {
    const nextHop = serve(
      passThrough({
        target: await listening(app),
        headers: req => ({ 'x-forwarded-for': firstForwarded(req) }),
        unreachable: startingAnswer,
      }),
    );
    return (await front(await listening(nextHop))).door;
  }

  async function opened(door: Target, path: string): Promise<http.IncomingMessage> {
    const out = http.request({ ...door, agent: false, path });
    out.on('error', () => {});
    out.end();
    const [res] = (await once(out, 'response')) as [http.IncomingMessage];
    res.on('error', () => {});
    onTestFinished(() => void out.destroy());
    return res;
  }

  it('gives an event stream as it comes, and keeps it open while it is quiet', async () => {
    let secondWritten = false;
    const app = http.createServer((_, res) => {
      res.write('data: 1\n\n');
      void sleep(3000).then(() => {
        secondWritten = true;
        res.end('data: 2\n\n');
      });
    });
    const res = await opened(await throughTwoHops(app), '/events');
    const [first] = (await once(res, 'data')) as [Buffer];
    expect(first.toString()).toBe('data: 1\n\n');
    expect(secondWritten).toBe(false);
    const [second] = (await once(res, 'data')) as [Buffer];
    expect(second.toString()).toBe('data: 2\n\n');
  });

  it('closes an event stream at the app when the client closes it', async () => {
    const atApp = deferred<http.ServerResponse>();
    const app = http.createServer((_, res) => {
      res.write('data: 1\n\n');
      atApp.resolve(res);
    });
    const res = await opened(await throughTwoHops(app), '/events');
    const atAppRes = await atApp.promise;
    const closed = once(atAppRes, 'close', { signal: AbortSignal.timeout(1000) });
    res.destroy();
    await closed;
  });

  it('closes a request at the app when the client closes before any answer', async () => {
    const atApp = deferred<http.ServerResponse>();
    const door = await throughTwoHops(http.createServer((_, res) => atApp.resolve(res)));
    const out = http.request({ ...door, agent: false, path: '/waiting' });
    out.on('error', () => {});
    out.end();
    const atAppRes = await atApp.promise;
    const closed = once(atAppRes, 'close', { signal: AbortSignal.timeout(1000) });
    out.destroy();
    await closed;
  });

  it('cuts an event stream at the client when the app dies, and never ends it cleanly', async () => {
    const atApp = deferred<net.Socket>();
    const app = http.createServer((req, res) => {
      res.write('data: 1\n\n');
      atApp.resolve(req.socket);
    });
    const res = await opened(await throughTwoHops(app), '/events');
    res.resume();
    const socket = await atApp.promise;
    const cut = once(res, 'close', { signal: AbortSignal.timeout(1000) });
    socket.destroy();
    await expect(cut).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  it('keeps a quiet WebSocket open, and closes it whichever end closes', async () => {
    const app = http.createServer();
    const sockets = new WebSocketServer({ server: app });
    const door = await throughTwoHops(app);
    const open = async () => {
      const client = new WebSocket(`ws://127.0.0.1:${door.port}/socket`);
      client.on('error', () => {});
      onTestFinished(() => client.terminate());
      const arrived = once(sockets, 'connection') as Promise<[WebSocket]>;
      await once(client, 'open');
      const [atApp] = await arrived;
      return { client, atApp };
    };

    const first = await open();
    await sleep(3000);
    const up = once(first.atApp, 'message');
    first.client.send('still here');
    expect(String((await up)[0])).toBe('still here');
    const down = once(first.client, 'message');
    first.atApp.send('so am I');
    expect(String((await down)[0])).toBe('so am I');
    const appClosed = once(first.atApp, 'close', { signal: AbortSignal.timeout(1000) });
    first.client.close();
    await appClosed;

    const second = await open();
    const clientClosed = once(second.client, 'close', { signal: AbortSignal.timeout(1000) });
    second.atApp.close();
    await clientClosed;
  });

  it('carries a large upload whole, and names the visitor at the app', async () => {
    const answer = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let size = 0;
      for await (const chunk of req) size += chunk.length;
      res.end(`${size} bytes from ${req.headers['x-forwarded-for']}`);
    };
    const door = await throughTwoHops(http.createServer((req, res) => void answer(req, res)));
    const upload = await send(door, { method: 'POST', path: '/upload' }, Buffer.alloc(8 * 1024 * 1024));
    expect(upload.body).toBe(`${8 * 1024 * 1024} bytes from 127.0.0.1`);
  });
});

describe('the front container', () => {
  const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

  /* The entry point has its port and its keeper written in. This keeps them from reaching anything real on this
     machine: it runs the entry point as it is, says what it asked for, and goes to the test's own target instead. */
  const PRELOAD = `
    import http from 'node:http';
    const { listen } = http.Server.prototype;
    http.Server.prototype.listen = function (port, host, done) {
      return listen.call(this, 0, '127.0.0.1', () => {
        console.log(JSON.stringify({ asked: { port, host }, port: this.address().port }));
        done();
      });
    };
    const { request } = http;
    http.request = options => {
      console.log(JSON.stringify({ target: { host: options.host, port: options.port } }));
      return request({ ...options, host: '127.0.0.1', port: Number(process.env.FRONT_TEST_TARGET) });
    };
  `;

  type Container = { child: ChildProcess; door: Target; said: Record<string, unknown>[]; exit: Promise<unknown[]> };

  async function container(target: Target): Promise<Container> {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--import', `data:text/javascript,${encodeURIComponent(PRELOAD)}`, 'src/front.ts'],
      { cwd: SERVER_DIR, env: { ...process.env, FRONT_TEST_TARGET: String(target.port) }, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    onTestFinished(() => void child.kill('SIGKILL'));
    const exit = once(child, 'exit');
    const said: Record<string, unknown>[] = [];
    const listeningOn = deferred<number>();
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', line => {
      const word = JSON.parse(line) as Record<string, unknown>;
      said.push(word);
      if (word.port) listeningOn.resolve(word.port as number);
    });
    const port = await listeningOn.promise;
    return { child, door: { host: '127.0.0.1', port }, said, exit };
  }

  it.each(['SIGINT', 'SIGTERM'] as const)('serves 8080, passes to the keeper on 7080 and exits 0 on %s', async signal => {
    const { child, door, said, exit } = await container(await listening(echoHeaders()));
    const answer = await send(door, { headers: { 'x-forwarded-for': '198.51.100.7' } });
    expect(JSON.parse(answer.body)['x-forwarded-for']).toBe('127.0.0.1');
    expect(said[0].asked).toEqual({ port: 8080, host: '0.0.0.0' });
    expect(said[1].target).toEqual({ host: 'keeper', port: 7080 });
    const started = Date.now();
    child.kill(signal);
    expect(await exit).toEqual([0, null]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('finishes a request in flight before it exits', async () => {
    const arrived = deferred<void>();
    const keeper = await answering(async (_, res) => {
      arrived.resolve();
      await sleep(500);
      res.end('whole');
    });
    const { child, door, exit } = await container(keeper);
    const answer = send(door);
    await arrived.promise;
    child.kill('SIGTERM');
    expect(await answer).toMatchObject({ status: 200, body: 'whole' });
    expect(await exit).toEqual([0, null]);
  });

  it('takes no new request once it was told to stop', async () => {
    const arrived = deferred<void>();
    const keeper = await answering(async (_, res) => {
      arrived.resolve();
      await sleep(500);
      res.end('whole');
    });
    const { child, door, exit } = await container(keeper);
    const answer = send(door);
    await arrived.promise;
    child.kill('SIGTERM');
    await sleep(200);
    await expect(send(door)).rejects.toThrow('ECONNREFUSED');
    await answer;
    await exit;
  });

  it('exits 0 in about 5 seconds with a socket that stays open', async () => {
    const app = http.createServer();
    new WebSocketServer({ server: app });
    const { child, door, exit } = await container(await listening(app));
    const client = new WebSocket(`ws://127.0.0.1:${door.port}/socket`);
    client.on('error', () => {});
    onTestFinished(() => client.terminate());
    await once(client, 'open');
    const started = Date.now();
    child.kill('SIGTERM');
    expect(await exit).toEqual([0, null]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    expect(Date.now() - started).toBeLessThan(7000);
  });
});
