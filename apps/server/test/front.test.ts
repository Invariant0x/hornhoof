import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
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

async function front(keeper: Target, holdMs?: number): Promise<{ server: http.Server; door: Target }> {
  const server = await startFront({ port: 0, host: '127.0.0.1', keeper, holdMs });
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

  it('stamps tool calls, and holds the rest while the keeper is down', async () => {
    const keeper = echoHeaders();
    const target = await listening(keeper);
    const { door } = await front(target);
    const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'company', arguments: {} } });
    const stamped = await send(door, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' } }, Buffer.from(call));
    expect(JSON.parse(stamped.body)['x-hornhoof-invocation']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse((await send(door, { path: '/api/x' })).body)['x-hornhoof-invocation']).toBeUndefined();

    await new Promise(resolve => {
      keeper.closeAllConnections();
      keeper.close(resolve);
    });
    const held = send(door, { path: '/api/x' });
    /* The keeper comes back on its port while the request waits for it. */
    await new Promise<void>(resolve => keeper.listen(target.port, target.host, resolve));
    expect((await held).status).toBe(200);
  });

  it('says Hornhoof is starting while the keeper is down, when it holds nothing', async () => {
    const keeper = http.createServer();
    const target = await listening(keeper);
    await new Promise(resolve => keeper.close(resolve));
    const { door } = await front(target, 0);
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

describe('the front entry, in this process', () => {
  /* Front's grace for what is still open when it is told to stop: half of the 10 s Docker waits after its signal. */
  const GRACE_MS = 5000;

  type Entry = { door: Target; stop: (signal: 'SIGINT' | 'SIGTERM') => void; exits: unknown[]; exited: Promise<unknown> };

  /* The entry point as it is, run in this process, so its grace can run on the test's clock. Its front is real, on a
     port of the test's own and with the test's keeper; the stop signals it waits for come from the test, and its exit
     is noted instead of taken. */
  async function entry(keeper: Target): Promise<Entry> {
    const heard = new Map<string | symbol, (...args: unknown[]) => void>();
    const waits = vi.spyOn(process, 'once').mockImplementation((event, listener) => {
      heard.set(event, listener);
      return process;
    });
    const exits: unknown[] = [];
    const exited = deferred<unknown>();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      exits.push(code);
      exited.resolve(code);
    }) as typeof process.exit);
    let server: http.Server | null = null;
    vi.doMock('../src/net/front.js', async importOriginal => {
      const real = await importOriginal<typeof import('../src/net/front.js')>();
      return { startFront: async (opts: Parameters<typeof real.startFront>[0]) => (server = await real.startFront({ ...opts, port: 0, host: '127.0.0.1', keeper })) };
    });
    vi.resetModules();
    try {
      await import('../src/front.js');
    } finally {
      waits.mockRestore();
      vi.doUnmock('../src/net/front.js');
    }
    const started = server as http.Server | null;
    if (!started) throw new Error('The entry started no front.');
    const sockets = new Set<net.Socket>();
    started.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    let closed = false;
    started.once('close', () => (closed = true));
    /* The entry exits once its front has closed, so the noted exit stays in place until it has. */
    onTestFinished(async () => {
      vi.useRealTimers();
      for (const socket of sockets) socket.destroy();
      started.close();
      if (!closed) await once(started, 'close');
      exit.mockRestore();
    });
    const stop = (signal: 'SIGINT' | 'SIGTERM') => {
      const listener = heard.get(signal);
      if (!listener) throw new Error(`The entry does not stop on ${signal}.`);
      listener(signal);
    };
    return { door: { host: '127.0.0.1', port: (started.address() as AddressInfo).port }, stop, exits, exited: exited.promise };
  }

  it.each(['SIGINT', 'SIGTERM'] as const)('exits 0 on %s at once when nothing is open, with no wait for the grace', async signal => {
    const { door, stop, exits, exited } = await entry(await listening(echoHeaders()));
    expect((await send(door)).status).toBe(200);
    /* The clock never moves: only the close of the front can end it. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stop(signal);
    expect(await exited).toBe(0);
    expect(exits).toEqual([0]);
  });

  it('keeps a socket that stays open through the grace, then exits 0', async () => {
    const app = http.createServer();
    const sockets = new WebSocketServer({ server: app });
    const { door, stop, exits } = await entry(await listening(app));
    const client = new WebSocket(`ws://127.0.0.1:${door.port}/socket`);
    client.on('error', () => {});
    onTestFinished(() => client.terminate());
    const arrived = once(sockets, 'connection') as Promise<[WebSocket]>;
    await once(client, 'open');
    const [atApp] = await arrived;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stop('SIGTERM');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(exits).toEqual([]);
    const up = once(atApp, 'message');
    client.send('still here');
    expect(String((await up)[0])).toBe('still here');
    const down = once(client, 'message');
    atApp.send('so am I');
    expect(String((await down)[0])).toBe('so am I');
    expect(exits).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([0]);
  });
});

describe('the front container', () => {
  const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

  /* The entry point has its port and its keeper written in. This keeps them from reaching anything real on this
     machine: it runs the entry point as it is, says what it asked for, and goes to the test's own target instead. It
     also says when the process has acted on a stop signal, and when its server began to close. */
  const PRELOAD = `
    import http from 'node:http';
    import net from 'node:net';
    const { connect } = net;
    net.connect = () => connect(Number(process.env.FRONT_TEST_TARGET), '127.0.0.1');
    const { listen, close } = http.Server.prototype;
    http.Server.prototype.listen = function (port, host, done) {
      return listen.call(this, 0, '127.0.0.1', () => {
        console.log(JSON.stringify({ asked: { port, host }, port: this.address().port }));
        done();
      });
    };
    http.Server.prototype.close = function (...args) {
      const server = close.apply(this, args);
      console.log(JSON.stringify({ closing: true }));
      return server;
    };
    const { emit } = process;
    process.emit = function (event, ...args) {
      const heard = emit.call(this, event, ...args);
      if (event === 'SIGINT' || event === 'SIGTERM') console.log(JSON.stringify({ told: event }));
      return heard;
    };
    const { request } = http;
    http.request = options => {
      console.log(JSON.stringify({ target: { host: options.host, port: options.port } }));
      return request({ ...options, host: '127.0.0.1', port: Number(process.env.FRONT_TEST_TARGET) });
    };
  `;

  type Container = {
    child: ChildProcess;
    door: Target;
    said: Record<string, unknown>[];
    /* The process ran what it does on a stop signal. */
    told: Promise<void>;
    /* Its server began to close. */
    closing: Promise<void>;
    exit: Promise<unknown[]>;
  };

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
    const told = deferred();
    const closing = deferred();
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', line => {
      const word = JSON.parse(line) as Record<string, unknown>;
      said.push(word);
      if (word.port) listeningOn.resolve(word.port as number);
      if (word.told) told.resolve();
      if (word.closing) closing.resolve();
    });
    const port = await listeningOn.promise;
    return { child, door: { host: '127.0.0.1', port }, said, told: told.promise, closing: closing.promise, exit };
  }

  it.each(['SIGINT', 'SIGTERM'] as const)('serves 8080, passes to the keeper on 7080 and exits 0 on %s', async signal => {
    const { child, door, said, exit } = await container(await listening(echoHeaders()));
    const answer = await send(door, { headers: { 'x-forwarded-for': '198.51.100.7' } });
    expect(JSON.parse(answer.body)['x-forwarded-for']).toBe('127.0.0.1');
    expect(said[0].asked).toEqual({ port: 8080, host: '0.0.0.0' });
    expect(said[1].target).toEqual({ host: 'keeper', port: 7080 });
    child.kill(signal);
    expect(await exit).toEqual([0, null]);
  });

  it('finishes a request in flight before it exits', async () => {
    const arrived = deferred();
    const answerNow = deferred();
    const keeper = await answering(async (_, res) => {
      arrived.resolve();
      await answerNow.promise;
      res.end('whole');
    });
    const { child, door, closing, exit } = await container(keeper);
    const answer = send(door);
    await arrived.promise;
    child.kill('SIGTERM');
    /* The keeper answers only once front began to close, or once it is gone without that. */
    await Promise.race([closing, exit]);
    answerNow.resolve();
    expect(await answer).toMatchObject({ status: 200, body: 'whole' });
    expect(await exit).toEqual([0, null]);
  });

  it('takes no new request once it was told to stop', async () => {
    const arrived = deferred();
    const answerNow = deferred();
    const keeper = await answering(async (_, res) => {
      arrived.resolve();
      await answerNow.promise;
      res.end('whole');
    });
    const { child, door, told, exit } = await container(keeper);
    const answer = send(door);
    await arrived.promise;
    child.kill('SIGTERM');
    await Promise.race([told, exit]);
    await expect(send(door)).rejects.toThrow('ECONNREFUSED');
    answerNow.resolve();
    await answer;
    await exit;
  });
});
